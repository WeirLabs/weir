import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { openCapabilityStore } from './store/store.js'
import { discoverSkillInventory, resolveSkillRoots } from './skill-inventory.js'
import { createSkillSelectionProvider } from './skill-selection-provider.js'
import { assertBuiltinSkillMigration } from './skill-builtin-migration.js'
import { createOfficeAdapter, officeDenials } from './skill-office-adapter.js'
import { createPresetInvalidation } from './preset-invalidation.js'
import { createLifecycleSnapshots } from './lifecycle-snapshot.js'
import { preloadLifecycleSnapshots } from './lifecycle-preload.js'
import { classifySelectionFailure } from './selection-status.js'
import { resolveInitialSelection } from './initial-selection.js'
import { workspaceKeyOf } from './preset-library.js'
import { createApplyEngine } from './apply-engine.js'
import { createSelectionNotifier, NOTIFY_SOURCE } from './selection-notify.js'
import { userTextMessage } from '../shared/user-message.js'

const mounted = new WeakMap()
/**
 * Process-local face slot: exactly one selection plugin mounts per
 * composition (per process), and every consumer row is the same bundle
 * module instance — the same pattern as the MCP facade realm bridge. This
 * deliberately avoids a realm-visible service: an agent-scoped ctx.get of a
 * preset-provided service crosses realms and breaks agents.create (S11).
 */
let processFace = null
/** Manager/Badge access without providing a new preset service or realm. */
export const skillSelectionFor = ctx => mounted.get(ctx) ?? processFace

/**
 * Read-only selection adapter. Selection payload: { skills: SkillIdentity[] }.
 * machineId is an explicit persisted installation namespace supplied by config;
 * no guessed namespace, default grant or name-only fallback is permitted.
 * All environment and policy reads occur in list(), never during mounting.
 *
 * Cold-session rule (task 5.1, G2c EXECUTED): a call WITHOUT a live session
 * (the standing preset key: { cwd, scope } with no session id) gets an EMPTY
 * selection — never a guess from the cwd or from preset/workspace defaults,
 * because a cwd or preset key is only exact when every cold session of that
 * cwd happens to share one selection, which cannot be known here. Only a
 * live session scope reads its own accepted record, so two sessions of one
 * directory with different selections never affect each other.
 */
export function createSkillSelectionPlugin(dependencies = {}) {
  return (ctx, config = {}) => {
    let provider
    let inventory
    let error = null
    /** Task 6.5 initialization reports per session (manager surface). */
    let initialReports = new Map()
    let lifecycle = null
    try {
      ctx.skills.registerProvider(control => {
        const readSelection = dependencies.readSelection ?? (async options => {
          const sessionId = options.scope?.session?.id
          // Fail closed empty for the standing key — an expected cold
          // condition, not a policy failure (no error state is raised).
          if (!sessionId) return []
          const store = openCapabilityStore({ profileContext: ctx.get('profileContext') })
          let record
          try {
            record = await store.read({ kind: 'selection', sessionId })
          } catch (cause) {
            // 6.4 root rule: an unreadable record (permissions/fs error) is a
            // distinct classified failure, never silently treated as absent.
            throw new Error('Skill selection policy is unreadable', { cause })
          }
          if (record.kind === 'absent') {
            // Subagent inheritance (6.2/6.3): a captured inherited snapshot is
            // the child's accepted selection. A snapshot-LESS subagent (crash
            // between the host's session publication and our capture, or a
            // hand-built session) is REFUSED — never granted the root
            // baseline (6.4 subagent rule; explicit resume recaptures).
            const header = options.scope?.session?.header ?? {}
            const isSubagent = (header.delegationDepth ?? 0) > 0 || typeof header.parentSession === 'string'
            let inherited
            try {
              inherited = await store.read({ kind: 'inherited', sessionId })
            } catch (cause) {
              throw new Error('Skill selection policy is unreadable', { cause })
            }
            if (inherited.kind === 'ok') return inherited.payload?.skills
            if (inherited.kind !== 'absent') throw new Error(`Inherited skill snapshot is ${inherited.kind}`)
            if (isSubagent) throw new Error('Inherited skill snapshot is absent')
            return initialSelection(options)
          }
          if (record.kind !== 'ok') throw new Error(`Skill selection policy is ${record.kind}`)
          return record.payload?.skills
        })
        // The persisted installation-local opaque namespace the inventory
        // requires: explicit config wins; otherwise derived from the host-
        // supplied profile identity (the same sanctioned source as the store
        // root), never from skill content or a guessed default.
        const machineId = config.machineId ?? (() => {
          const profile = ctx.get?.('profileContext')
          if (typeof profile?.home !== 'string' || typeof profile?.name !== 'string') return undefined
          return createHash('sha256').update(`${profile.home}\0${profile.name}`).digest('hex').slice(0, 24)
        })()
        const filesystem = dependencies.inventory ?? (async (options, previous) => {
          const profile = ctx.get('profileContext')
          const roots = await resolveSkillRoots({
            cwd: options.cwd,
            dshHome: config.dshHome ?? profile?.home,
            agentsHome: config.agentsHome ?? process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'),
            customSkillDirs: config.customSkillDirs ?? [],
            bundledSkillDir: config.bundledSkillDir ?? process.env.DSH_BUNDLED_SKILL_DIR,
            orreryBuiltinDir: config.orreryBuiltinDir ?? fileURLToPath(new URL('../../skills/', import.meta.url)),
          })
          const snapshot = await discoverSkillInventory({ roots, machineId, previous })
          // First-run migration check (D-H 6): a non-equivalent builtin
          // discovery fails the enumeration closed with a visible reason.
          return assertBuiltinSkillMigration(snapshot)
        })
        const office = dependencies.office ?? createOfficeAdapter(ctx.skills, machineId)
        inventory = async (options, previous) => {
          const local = await filesystem(options, previous)
          const bundled = await office(options)
          return { ...local, complete: local.complete && bundled.complete, candidates: [...local.candidates, ...bundled.candidates] }
        }
        initialReports = new Map()
        /**
         * Task 6.5 initialization priority for a root session without an
         * accepted record: a saved workspace default wins (explicit empty
         * included, unresolved refs reported); otherwise the builtin-Skills
         * baseline plus the managed MCP identities the composition enables.
         * Nothing is inferred from historical content, nothing is persisted.
         */
        const initialSelection = dependencies.initialSelection ?? (async options => {
          const store = openCapabilityStore({ profileContext: ctx.get('profileContext') })
          const workspaceKey = workspaceKeyOf(options)
          let defaultsRecord = /** @type {any} */ ({ kind: 'absent', revision: 0 })
          if (typeof workspaceKey === 'string' && workspaceKey.length) {
            try {
              defaultsRecord = await store.read({ kind: 'defaults', workspaceKey })
            } catch (cause) {
              throw new Error('Workspace default selection is unreadable', { cause })
            }
          }
          let builtinIdentities = []
          let enabledMcpIdentities = []
          if (defaultsRecord.kind === 'absent') {
            const snapshot = await inventory(options)
            builtinIdentities = (snapshot?.candidates ?? [])
              .filter(candidate => candidate?.status === 'parsed' && candidate.identity?.scope === 'orrery-builtin')
              .map(candidate => candidate.identity)
            try {
              const registry = await store.read({ kind: 'mcp-registry' })
              const payload = registry.kind === 'ok' ? registry.payload ?? {} : {}
              enabledMcpIdentities = Array.isArray(/** @type {Record<string, unknown>} */ (payload).enabled) ? /** @type {string[]} */ (/** @type {Record<string, unknown>} */ (payload).enabled) : []
            } catch { /* an unreadable registry enables no managed identity by default */ }
          }
          const resolved = resolveInitialSelection({ defaultsRecord, builtinIdentities, enabledMcpIdentities })
          const sessionId = options.scope?.session?.id
          if (typeof sessionId === 'string' && sessionId.length) {
            initialReports.set(sessionId, { source: resolved.source, missing: resolved.missing, mcpServers: resolved.selection.mcpServers })
          }
          return resolved.selection.skills
        })
        provider = createSkillSelectionProvider({ control, readSelection, inventory, denials: officeDenials })
        return provider
      })
      ctx.on('skills/change', () => provider.sourceChanged())
      // Task 5.2: re-emit the invalidation broadcast for root orrery-preset
      // sessions when their agent is created (never for subagents), so every
      // client re-pulls the command/skill lists. Fully guarded: a listener
      // failure must never reject the serial agent/created dispatch.
      const invalidation = createPresetInvalidation({
        emit: (...args) => ctx.emit(...args),
        projections: () => ctx.get?.('sessionProjections'),
        warn: text => ctx.logger?.warn?.(text),
      })
      // The host dispatches agent/created SERIALLY with bail-on-value
      // semantics (cordis isBailed: any non-null/false/undefined result stops
      // the dispatch). agentCreated returns a boolean for its own callers, so
      // the listener must swallow it — a truthy return would silently cut off
      // every agent/created listener registered after this row, exactly for
      // the root preset sessions this change re-emits for (found by the
      // cold-session integration scenario, task 5.5).
      ctx.on('agent/created', payload => { invalidation.agentCreated(payload) })
      // Tasks 6.1/6.2 (design D6): lifecycle readiness listener — a SEPARATE
      // agent/created row with a single responsibility (the 5.2 re-emission
      // row above stays untouched). It synchronously readies the session's
      // in-memory snapshot and, for subagents, durably captures the inherited
      // snapshot with blocking synchronous I/O. It NEVER yields the event
      // loop (G4b EXECUTED: yielding, not slowness, is the failure shape) and
      // returns undefined on every success path; on the subagent fail-closed
      // paths it THROWS — an intentional bail that rejects that subagent's
      // creation while the parent session continues (6.4 rule), never a
      // silent unrestricted pass.
      lifecycle = dependencies.lifecycle ?? createLifecycleSnapshots({
        profileContext: ctx.get?.('profileContext'),
        warn: text => ctx.logger?.warn?.(text),
      })
      const readiness = lifecycle
      ctx.on('agent/created', payload => { readiness.agentCreated(payload) })
      // Task 6.1: preload known sessions' accepted selections into memory at
      // plugin apply. Fire-and-forget: a memory miss is served by the
      // listener's blocking synchronous disk read, so a slow or failed
      // preload only costs one disk read per agent creation.
      void Promise.resolve(preloadLifecycleSnapshots({
        lifecycle,
        profileContext: ctx.get?.('profileContext'),
        warn: text => ctx.logger?.warn?.(text),
      })).catch(cause => ctx.logger?.warn?.(`lifecycle snapshot preload failed: ${cause instanceof Error ? cause.message : String(cause)}`))
    } catch (cause) {
      // Registration errors must not break the preset either (e.g. duplicate row).
      error = cause instanceof Error ? cause.message : String(cause)
    }
    // Task 12.4: the shared apply engine and the model-facing removal
    // notifier. The engine's accepted deltas queue into the notifier; the
    // next safe request consumes them as a full UserMessage riding WITH that
    // request (never an autonomous turn; source marked non-'user' so the
    // intent gate and continuation classifiers exclude it by construction).
    const notifier = createSelectionNotifier()
    let sharedEngine = null
    const engineFor = () => {
      if (sharedEngine) return sharedEngine
      sharedEngine = createApplyEngine({
        store: openCapabilityStore({ profileContext: ctx.get?.('profileContext') }),
        locateSession: session => session,
        inventory: (options) => inventory(options),
        provider,
        publishSnapshot: (sessionId, snapshot) => lifecycle?.publish?.(sessionId, snapshot),
        onAccepted: (sessionId, delta) => notifier.queue(sessionId, delta),
        warn: text => ctx.logger?.warn?.(text),
      })
      return sharedEngine
    }
    // Group 12 client surface: a /capabilities command serving the Badge and
    // manager (receipt / listing / conditions). Values travel as command
    // results — no projection state and no custom session-log event types.
    try {
      const commands = ctx.get?.('commands')
      if (commands) {
        ctx.effect(() => commands.register({
          name: 'capabilities',
          description: 'Session capability surface for the Orrery Badge and manager (receipt | list | conditions).',
          handler: async (invocation) => {
            const agent = invocation?.agent
            if (!agent) return { kind: 'error', text: 'capabilities: requires an owning agent session' }
            const verb = String(invocation.rawInput ?? '').trim().toLowerCase()
            const options = { cwd: agent.session?.header?.cwd, scope: { session: { id: agent.id } } }
            if (verb === 'receipt') {
              try {
                const status = provider.status(options)
                const candidates = await provider.list(options)
                const selected = candidates.filter(candidate => candidate.selected)
                return { kind: 'success', text: 'capability receipt', value: {
                  status: 'applied',
                  effective: {
                    skills: selected.map(candidate => candidate.name),
                    mcpServers: status?.effective?.mcpServers ?? [],
                  },
                  warnings: (status?.error ?? null) ? [String(status.reason ?? 'selection-unavailable')] : [],
                } }
              } catch (cause) {
                return { kind: 'error', text: `capabilities receipt failed: ${cause instanceof Error ? cause.message : String(cause)}` }
              }
            }
            if (verb === 'list') {
              try {
                const candidates = await provider.list(options)
                const manager = ctx.get?.('orreryMcpManager')
                const listing = manager?.list?.() ?? { managed: [], unmanaged: [] }
                return { kind: 'success', text: 'capability listing', value: {
                  skills: candidates.map(candidate => ({
                    name: candidate.name,
                    description: candidate.description ?? '',
                    scope: candidate.source?.scope ?? candidate.scope ?? 'unknown',
                    status: candidate.status ?? 'unknown',
                    selected: Boolean(candidate.selected),
                    conflict: Boolean(candidate.conflict),
                  })),
                  mcpServers: [
                    ...(listing.managed ?? []).map(server => ({ identity: server.identity, state: server.state })),
                    ...(listing.unmanaged ?? []).map(server => ({ serverName: server.serverName, state: 'unmanaged' })),
                  ],
                } }
              } catch (cause) {
                return { kind: 'error', text: `capabilities list failed: ${cause instanceof Error ? cause.message : String(cause)}` }
              }
            }
            if (verb === 'conditions') {
              // The 1.12 consistency conditions; empty = supported.
              return { kind: 'success', text: 'capability conditions', value: { conditions: [] } }
            }
            return { kind: 'error', text: 'Usage: /capabilities receipt|list|conditions' }
          },
        }), 'orrery-capabilities-command')
      }
    } catch (cause) {
      ctx.logger?.warn?.(`capabilities command registration failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    try {
      ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
        const pending = notifier.consume(agent?.id)
        if (pending === null) return next()
        // Injection failure must never affect the accepted commit: a failed
        // append warns and the request proceeds without the notice.
        try {
          if (Array.isArray(messages)) messages.push(userTextMessage(pending.text, NOTIFY_SOURCE))
        } catch (cause) {
          ctx.logger?.warn?.(`selection notification injection failed: ${cause instanceof Error ? cause.message : String(cause)}`)
        }
        return next()
      })
    } catch (cause) {
      ctx.logger?.warn?.(`selection notification pre-step registration failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    const face = {
      provider,
      inventory,
      lifecycle,
      status: options => error
        ? { error, ...classifySelectionFailure(error), conflicts: [] }
        : provider.status(options),
      initialReport: sessionId => initialReports.get(sessionId) ?? null,
      noteFailure: (options, failure) => provider?.noteFailure(options, failure),
      clearFailure: options => provider?.clearFailure(options),
      /** Shared Apply entry (group 12 manager UI commits here). */
      applySelection: (session, request, options) => engineFor().commit(session, request, options),
      /** 12.4 diagnostics: whether a removal notice is queued for a session. */
      hasPendingNotification: sessionId => notifier.has(sessionId),
    }
    mounted.set(ctx, face)
    processFace = face
  }
}

export const name = 'orrery-skill-selection'
export const inject = ['skills']
export const apply = createSkillSelectionPlugin()
