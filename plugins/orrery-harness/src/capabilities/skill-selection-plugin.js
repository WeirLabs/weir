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
import { resolveInitialSelection, baselineSkillIdentities } from './initial-selection.js'
import { createPresetLibrary, workspaceKeyOf } from './preset-library.js'
import { createDefaultsTransaction } from './defaults-transaction.js'
import { bindImportedSelection, validatePortableDocument } from './portable-refs.js'
import { enumeratePresetUnits } from './store/enumerate.js'
import { bindPackageSelection, packPresetPackage, planPackageInstall, validatePresetPackage } from './preset-package.js'
import { installBundledSkills } from './preset-package-install.js'
import { isSegment } from './store/paths.js'
import { createApplyEngine } from './apply-engine.js'
import { createSelectionNotifier, NOTIFY_SOURCE } from './selection-notify.js'
import { createMcpRegistry } from './mcp-registry.js'
import { buildReceiptPayload, buildListPayload, buildConditionsPayload } from './read-payloads.js'
import { feedCapabilityReadBridge } from './capability-remote.js'
import { userTextMessage } from '../shared/user-message.js'
import { createAudit, AUDIT_TYPES } from '../shared/audit.js'

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
    /** Capability read remote (2.2): sessionId → header.cwd cache for the host-layer read service. */
    const sessionCwds = new Map()
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
            // Baseline scopes are row-configurable (default builtin-only);
            // the orrery-creative preset adds 'custom' for its fused skills.
            builtinIdentities = baselineSkillIdentities(snapshot?.candidates, config.baselineScopes)
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
      // Capability read remote (silent-capability-reads 2.2): the per-session
      // cwd cache the host-layer read service resolves options from — the
      // same observation point the /capabilities handler uses
      // (agent.session?.header?.cwd). Returns undefined on every path so the
      // serial agent/created dispatch is never bailed.
      ctx.on('agent/created', payload => {
        const id = payload?.agent?.id
        if (typeof id === 'string' && id.length) sessionCwds.set(id, payload?.agent?.session?.header?.cwd)
      })
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
    // D6 two-phase package import (tasks 6.2/6.3): the install target roots
    // resolve through the SAME skill-inventory root resolution the inventory
    // uses — project scope installs into the current workspace's project
    // Skill root, user scope into the user Skill root. Never guessed.
    const skillRootsFor = async options => {
      const profile = ctx.get?.('profileContext')
      return resolveSkillRoots({
        cwd: options.cwd,
        dshHome: config.dshHome ?? profile?.home,
        agentsHome: config.agentsHome ?? process.env.DSH_AGENTS_HOME ?? join(homedir(), '.agents'),
        customSkillDirs: config.customSkillDirs ?? [],
        bundledSkillDir: config.bundledSkillDir ?? process.env.DSH_BUNDLED_SKILL_DIR,
        orreryBuiltinDir: config.orreryBuiltinDir ?? fileURLToPath(new URL('../../skills/', import.meta.url)),
      })
    }
    // The shared cold-safe audit channel (cordis emit + .orrery/audit.jsonl
    // mirror; never session.append). The package-import install outcome and
    // its collision decisions are audited through it (task 6.3).
    const audit = createAudit(ctx)
    // Group 12 client surface: a /capabilities command serving the Badge and
    // manager (receipt / listing / conditions). Values travel as command
    // results — no projection state and no custom session-log event types.
    try {
      const commands = ctx.get?.('commands')
      if (commands) {
        ctx.effect(() => commands.register({
          name: 'capabilities',
          description: 'Session capability surface for the Orrery Badge and manager (receipt | list | conditions | presets | preset-save | preset-load | preset-delete | preset-export | preset-import | default-get | default-save | default-clear).',
          handler: async (invocation) => {
            const agent = invocation?.agent
            if (!agent) return { kind: 'error', text: 'capabilities: requires an owning agent session' }
            // Verb matching is case-insensitive; the apply payload is JSON and
            // must keep its original casing (requestId/expectedRevision/...).
            const rawInput = String(invocation.rawInput ?? '').trim()
            const verb = rawInput.toLowerCase()
            const options = { cwd: agent.session?.header?.cwd, scope: { session: { id: agent.id } } }
            // Preset/workspace-default verbs (capability-manager-ux D2): the
            // command surface is the UI's only data source. Shared wiring —
            // every verb opens the same store and resolves the same workspace
            // binding as the existing verbs; every failure is an explicit
            // status in the JSON payload, never a throw escaping the handler.
            const capabilityStore = () => openCapabilityStore({ profileContext: ctx.get?.('profileContext') })
            const sessionWorkspaceKey = () => workspaceKeyOf(options)
            const noWorkspace = { kind: 'error', text: JSON.stringify({ status: 'no-workspace' }) }
            /**
             * The sets a save records. from:'applied' is server-authoritative:
             * the sets come from the same provider/lifecycle state the receipt
             * verb reports — client-sent set fields are never trusted then.
             */
            const selectionSetsOf = async spec => {
              if (spec.from === 'applied') {
                const result = await provider.list(options)
                const candidates = Array.isArray(result?.candidates) ? result.candidates : []
                const skills = []
                for (const candidate of candidates) {
                  if (candidate?.selected && candidate.identity) skills.push(candidate.identity)
                }
                const snapshot = lifecycle?.snapshotFor?.(agent.id)
                return { skills, mcpServers: Array.isArray(snapshot?.mcpServers) ? [...snapshot.mcpServers] : [], unresolvedRefs: [] }
              }
              return {
                skills: Array.isArray(spec.skills) ? spec.skills : [],
                mcpServers: Array.isArray(spec.mcpServers) ? spec.mcpServers : [],
                unresolvedRefs: Array.isArray(spec.unresolvedRefs) ? spec.unresolvedRefs : [],
              }
            }
            /**
             * Display names of one preset namespace for the collision check.
             * The check is part of the write contract, so an unavailable
             * listing propagates its explicit kind instead of degrading the
             * save to a blind write.
             */
            const presetNamesOf = async (store, scope, workspaceKey) => {
              const listed = await enumeratePresetUnits(store, { workspaceKey: isSegment(workspaceKey) ? workspaceKey : undefined })
              if (listed.kind !== 'ok') return listed
              const names = new Map()
              for (const preset of listed.presets) {
                if (preset.scope !== scope) continue
                const document = preset.document
                if (document !== null && typeof document === 'object' && !Array.isArray(document)
                  && typeof /** @type {Record<string, unknown>} */ (document).name === 'string') {
                  names.set(preset.presetId, /** @type {Record<string, unknown>} */ (document).name)
                }
              }
              return { kind: 'ok', names }
            }
            /** Derive a stable, segment-safe preset id from a display name. */
            const presetSlugOf = name => {
              const slug = String(name).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96)
              return isSegment(slug) ? slug : 'preset'
            }
            /** Shared scope validation for the preset verbs. */
            const presetScopeError = spec => (spec?.scope !== 'global' && spec?.scope !== 'workspace')
              ? { kind: 'error', text: `capabilities: scope must be "global" | "workspace", got ${JSON.stringify(spec?.scope ?? null)}` }
              : null
            /**
             * D6 version-2 package import (tasks 6.2/6.3). Phase one
             * (dryRun:true) is a read-only summary — the exact install
             * targets, file counts, unresolved refs and collisions, ZERO
             * writes. Phase two (confirmed, onCollision default 'cancel')
             * installs the bundled Skills into the resolved roots and then
             * commits the preset record by CAS. A poison package is rejected
             * atomically: nothing is written, no preset is created, the
             * reason is named. Installed Skills stay UNSELECTED in every
             * established set — selection remains a later draft + Apply.
             */
            const importPresetPackage = async spec => {
              const verdict = validatePresetPackage(spec.document)
              if (!verdict.ok) return { kind: 'error', text: JSON.stringify({ status: 'rejected', reason: verdict.reason }) }
              if (spec.dryRun !== undefined && typeof spec.dryRun !== 'boolean') {
                return { kind: 'error', text: 'capabilities preset-import: dryRun must be a boolean' }
              }
              const onCollision = spec.onCollision ?? 'cancel'
              if (onCollision !== 'cancel' && onCollision !== 'replace' && onCollision !== 'coexist') {
                return { kind: 'error', text: 'capabilities preset-import: onCollision must be "cancel" | "replace" | "coexist"' }
              }
              const workspaceKey = sessionWorkspaceKey()
              if (spec.scope === 'workspace' && !isSegment(workspaceKey)) return noWorkspace
              const pkg = /** @type {any} */ (spec.document)
              const store = capabilityStore()
              // Local binding context: the managed MCP identities this
              // machine configured, the builtin names it actually has, and
              // the D6 install roots (project = this workspace, user = user
              // root) via the existing skill-inventory root resolution.
              const registry = createMcpRegistry({ store })
              const record = await registry.read()
              const localMcpIdentities = record.kind === 'ok' ? Object.keys(record.servers) : []
              const bound = bindPackageSelection(pkg, { localMcpIdentities })
              const inventoryResult = await inventory(options)
              const candidates = Array.isArray(inventoryResult?.candidates) ? inventoryResult.candidates : []
              const builtinNames = new Set()
              for (const candidate of candidates) {
                const identity = /** @type {Record<string, any>} */ (candidate)?.identity
                if (identity?.scope === 'orrery-builtin' && typeof identity.name === 'string') builtinNames.add(identity.name)
              }
              const missingBuiltin = pkg.builtin.filter(name => !builtinNames.has(name))
              const roots = await skillRootsFor(options)
              const targetRoots = {
                project: roots.find(root => root.source === 'project-dsh')?.path ?? null,
                user: roots.find(root => root.source === 'user-dsh')?.path ?? null,
              }
              const plan = await planPackageInstall(pkg, { roots: targetRoots })
              const carried = [
                ...bound.unresolvedRefs,
                ...missingBuiltin.map(name => ({ kind: 'skill', ref: { name, source: 'builtin' } })),
              ]
              if (spec.dryRun === true) {
                return { kind: 'success', text: JSON.stringify({ status: 'dry-run', install: plan.install, unresolved: carried, collisions: plan.collisions }) }
              }
              // Confirmed: the install is this import's explicit main effect.
              const neededScopes = [...new Set(pkg.bundled.map(entry => entry.targetScope))]
              const missingRoot = neededScopes.find(scope => targetRoots[scope] === null)
              if (missingRoot !== undefined) {
                return { kind: 'error', text: JSON.stringify({ status: 'no-target-root', targetScope: missingRoot }) }
              }
              const install = await installBundledSkills(pkg.bundled, { roots: targetRoots, onCollision }, {
                audit: data => audit(agent.session, AUDIT_TYPES.capabilityPresetImport, data),
              })
              if (!install.ok) {
                // installBundledSkills already rolled back what it wrote.
                return { kind: 'error', text: JSON.stringify({ status: 'install-failed', reason: install.reason, rolledBack: install.rolledBack }) }
              }
              // Resolve what is now local (installed bundled Skills, present
              // builtin names) against a FRESH inventory: the preset record
              // names real identities; everything else stays unresolved.
              const afterResult = await inventory(options)
              const afterCandidates = Array.isArray(afterResult?.candidates) ? afterResult.candidates : []
              const resolveLocal = (scope, name) => {
                const matches = []
                for (const candidate of afterCandidates) {
                  const identity = /** @type {Record<string, any>} */ (candidate)?.identity
                  if (identity?.scope === scope && identity.name === name) matches.push(identity)
                }
                // An ambiguous name stays unresolved rather than guessing.
                return matches.length === 1 ? matches[0] : null
              }
              const resolvedSkills = []
              const unresolvedRefs = [...carried]
              for (const entry of install.installed) {
                const identity = resolveLocal(entry.targetScope === 'project' ? 'project' : 'user', entry.target)
                if (identity) resolvedSkills.push(identity)
                else unresolvedRefs.push({ kind: 'skill', ref: { name: entry.target, targetScope: entry.targetScope, source: 'bundled' } })
              }
              for (const entry of install.collisions) {
                unresolvedRefs.push({ kind: 'skill', ref: { name: entry.name, targetScope: entry.targetScope, source: 'bundled', collision: entry.decision } })
              }
              for (const name of pkg.builtin) {
                if (missingBuiltin.includes(name)) continue
                const identity = resolveLocal('orrery-builtin', name)
                if (identity) resolvedSkills.push(identity)
                else unresolvedRefs.push({ kind: 'skill', ref: { name, source: 'builtin' } })
              }
              const name = typeof spec.name === 'string' && spec.name.length ? spec.name : pkg.name
              const presetId = spec.presetId ?? presetSlugOf(name)
              if (!isSegment(presetId)) return { kind: 'error', text: `capabilities preset-import: invalid presetId ${JSON.stringify(presetId)}` }
              const names = await presetNamesOf(store, spec.scope, workspaceKey)
              if (names.kind !== 'ok') return { kind: 'error', text: JSON.stringify({ status: names.kind, reason: names.reason }) }
              const library = createPresetLibrary({ store })
              const document = { name, selection: { skills: resolvedSkills, mcpServers: bound.mcpServers, unresolvedRefs } }
              const result = await library.create({
                scope: spec.scope, presetId, workspaceKey, document,
                onNameConflict: spec.onNameConflict ?? 'cancel',
                allDisplayNames: async () => names.names,
              })
              return { kind: 'success', text: JSON.stringify({
                ...result,
                presetId,
                bound: { mcpServers: bound.mcpServers.length, unresolvedRefs: unresolvedRefs.length },
                installed: install.installed,
                collisions: install.collisions,
                unresolved: unresolvedRefs,
              }) }
            }
            if (verb === 'receipt') {
              try {
                // Shared builder (silent-capability-reads 2.1): the read
                // remote serializes the same payload from the same code.
                const payload = await buildReceiptPayload({
                  provider,
                  lifecycle,
                  store: openCapabilityStore({ profileContext: ctx.get?.('profileContext') }),
                }, options)
                // The commands registry normalizes results to {kind, text}
                // (CITED dsh-commands normalizeResult): structured payloads
                // travel as JSON text.
                return { kind: 'success', text: JSON.stringify(payload) }
              } catch (cause) {
                return { kind: 'error', text: `capabilities receipt failed: ${cause instanceof Error ? cause.message : String(cause)}` }
              }
            }
            if (verb === 'list') {
              try {
                // Shared builder (silent-capability-reads 2.1): the FULL
                // inventory joined with the session's EFFECTIVE selection,
                // plus the MCP manager listing (read at call time).
                const payload = await buildListPayload({
                  inventory: (inventoryOptions, previous) => inventory(inventoryOptions, previous),
                  provider,
                  mcpManager: ctx.get?.('orreryMcpManager'),
                }, options)
                return { kind: 'success', text: JSON.stringify(payload) }
              } catch (cause) {
                return { kind: 'error', text: `capabilities list failed: ${cause instanceof Error ? cause.message : String(cause)}` }
              }
            }
            if (verb.startsWith('apply ')) {
              // The manager editor's commit (12.3): the client sends
              // {requestId, expectedRevision, skills: [names], mcpServers: [names]}
              // as JSON text after the verb; names map to identities from the
              // CURRENT candidates — an unknown name is a visible error, never
              // silently dropped.
              let draft
              try {
                draft = JSON.parse(rawInput.slice('apply '.length))
              } catch {
                return { kind: 'error', text: 'Usage: /capabilities apply <json selection>' }
              }
              try {
                // The full inventory (not the effective selection): an Apply
                // may name any discovered candidate, selected or not.
                const inventoryResult = await inventory(options)
                const candidates = Array.isArray(inventoryResult?.candidates) ? inventoryResult.candidates : []
                const byName = new Map(candidates.map(candidate => [candidate.name, candidate]))
                const missing = []
                const identities = []
                for (const name of draft.skills ?? []) {
                  const candidate = byName.get(name)
                  if (candidate?.identity) identities.push(candidate.identity)
                  else missing.push(String(name))
                }
                if (missing.length > 0) return { kind: 'error', text: JSON.stringify({ status: 'missing', missing }) }
                const response = await face.applySelection(
                  { sessionId: agent.id, cwd: agent.session?.header?.cwd, presetId: 'orrery' },
                  { requestId: draft.requestId, expectedRevision: draft.expectedRevision, selection: { skills: identities, mcpServers: draft.mcpServers ?? [] }, unresolved: [] },
                  options,
                )
                return { kind: 'success', text: JSON.stringify(response) }
              } catch (cause) {
                return { kind: 'error', text: `capabilities apply failed: ${cause instanceof Error ? cause.message : String(cause)}` }
              }
            }
            if (verb.startsWith('mcp-add ')) {
              // Register a new managed MCP server and mount it immediately
              // (8.1 registry + manager start). Payload:
              // {identity, label, command, args?: [], env?: {}, serverName?}
              let spec
              try {
                spec = JSON.parse(rawInput.slice('mcp-add '.length))
              } catch {
                return { kind: 'error', text: 'Usage: /capabilities mcp-add <json {identity,label,command,args?,env?,serverName?}>' }
              }
              try {
                if (typeof spec.identity !== 'string' || typeof spec.label !== 'string' || typeof spec.command !== 'string' || spec.command.length === 0) {
                  return { kind: 'error', text: 'mcp-add needs identity, label and command strings' }
                }
                const store = openCapabilityStore({ profileContext: ctx.get?.('profileContext') })
                const registry = createMcpRegistry({ store })
                const current = await registry.read()
                const expectedRevision = current.kind === 'ok' ? current.revision : 0
                const entry = {
                  identity: spec.identity,
                  label: spec.label,
                  owner: { kind: 'global', key: 'installation' },
                  transport: { kind: 'stdio', ref: `cmd:${spec.command}` },
                  client: {
                    transport: 'stdio',
                    serverName: typeof spec.serverName === 'string' && spec.serverName.length ? spec.serverName : spec.identity,
                    command: spec.command,
                    args: Array.isArray(spec.args) ? spec.args.map(String) : [],
                    env: spec.env && typeof spec.env === 'object' && !Array.isArray(spec.env) ? spec.env : {},
                    reconnect: { enabled: true },
                  },
                }
                const committed = await registry.register(entry, expectedRevision)
                if (committed.status !== 'committed') return { kind: 'error', text: JSON.stringify({ status: committed.status }) }
                const manager = ctx.get?.('orreryMcpManager')
                if (manager?.start) await manager.start()
                return { kind: 'success', text: JSON.stringify({ status: 'registered', identity: entry.identity, generation: 1, mounted: Boolean(manager?.start) }) }
              } catch (cause) {
                return { kind: 'error', text: `capabilities mcp-add failed: ${cause instanceof Error ? cause.message : String(cause)}` }
              }
            }
            if (verb === 'presets') {
              // List the presets of the global namespace plus this session's
              // workspace namespace (read-only store scan; fail closed when
              // the store root is unsupported).
              try {
                const store = capabilityStore()
                const workspaceKey = sessionWorkspaceKey()
                const listed = await enumeratePresetUnits(store, { workspaceKey: isSegment(workspaceKey) ? workspaceKey : undefined })
                if (listed.kind !== 'ok') return { kind: 'error', text: JSON.stringify({ status: listed.kind, reason: listed.reason }) }
                const countOf = value => (Array.isArray(value) ? value.length : 0)
                const presets = listed.presets.map(preset => {
                  const document = /** @type {Record<string, unknown>} */ (preset.document ?? {})
                  const selection = /** @type {Record<string, unknown>} */ (document.selection ?? {})
                  return {
                    scope: preset.scope,
                    presetId: preset.presetId,
                    name: typeof document.name === 'string' ? document.name : '',
                    revision: preset.revision,
                    counts: {
                      skills: countOf(selection.skills),
                      mcpServers: countOf(selection.mcpServers),
                      unresolvedRefs: countOf(selection.unresolvedRefs),
                    },
                  }
                })
                return { kind: 'success', text: JSON.stringify({ presets, workspaceKey }) }
              } catch (cause) {
                return { kind: 'error', text: `capabilities presets failed: ${cause instanceof Error ? cause.message : String(cause)}` }
              }
            }
            if (verb.startsWith('preset-save ')) {
              // Save the draft or the applied selection as a named preset.
              // Create vs edit is decided by the presence of expectedRevision;
              // a display-name collision inside the namespace writes nothing
              // unless the caller confirmed onNameConflict:'replace'.
              let spec
              try {
                spec = JSON.parse(rawInput.slice('preset-save '.length))
              } catch {
                return { kind: 'error', text: 'Usage: /capabilities preset-save <json {scope,name,presetId?,from:"draft"|"applied",skills?,mcpServers?,unresolvedRefs?,expectedRevision?,onNameConflict?}>' }
              }
              try {
                const scopeError = presetScopeError(spec)
                if (scopeError) return scopeError
                if (spec.from !== 'draft' && spec.from !== 'applied') return { kind: 'error', text: 'capabilities preset-save: from must be "draft" | "applied"' }
                if (typeof spec.name !== 'string' || spec.name.length === 0) return { kind: 'error', text: 'capabilities preset-save: name must be a non-empty string' }
                const onNameConflict = spec.onNameConflict ?? 'cancel'
                if (onNameConflict !== 'rename' && onNameConflict !== 'replace' && onNameConflict !== 'cancel') {
                  return { kind: 'error', text: 'capabilities preset-save: onNameConflict must be "rename" | "replace" | "cancel"' }
                }
                const workspaceKey = sessionWorkspaceKey()
                if (spec.scope === 'workspace' && !isSegment(workspaceKey)) return noWorkspace
                const store = capabilityStore()
                const names = await presetNamesOf(store, spec.scope, workspaceKey)
                if (names.kind !== 'ok') return { kind: 'error', text: JSON.stringify({ status: names.kind, reason: names.reason }) }
                const sets = await selectionSetsOf(spec)
                const selection = { skills: sets.skills, mcpServers: sets.mcpServers, unresolvedRefs: sets.unresolvedRefs }
                const library = createPresetLibrary({ store })
                if (spec.expectedRevision !== undefined) {
                  // Edit path: whole-document replacement under CAS.
                  if (!isSegment(spec.presetId)) return { kind: 'error', text: 'capabilities preset-save: edit needs a valid presetId' }
                  if (!Number.isSafeInteger(spec.expectedRevision) || spec.expectedRevision < 0) {
                    return { kind: 'error', text: 'capabilities preset-save: expectedRevision must be a non-negative integer' }
                  }
                  for (const [otherId, otherName] of names.names) {
                    if (otherId !== spec.presetId && otherName === spec.name && onNameConflict !== 'replace') {
                      return { kind: 'success', text: JSON.stringify({ status: onNameConflict === 'rename' ? 'rename-required' : 'name-conflict', with: otherId }) }
                    }
                  }
                  const result = await library.edit({
                    scope: spec.scope, presetId: spec.presetId, workspaceKey, expectedRevision: spec.expectedRevision,
                    mutate: () => ({ name: spec.name, selection }),
                  })
                  return { kind: 'success', text: JSON.stringify({ ...result, presetId: spec.presetId }) }
                }
                // Create path: an absent presetId is derived from the display
                // name and made unique inside the namespace.
                let presetId = spec.presetId
                if (presetId === undefined || presetId === null || presetId === '') {
                  const base = presetSlugOf(spec.name)
                  presetId = base
                  for (let suffix = 2; names.names.has(presetId); suffix += 1) presetId = `${base}-${suffix}`
                }
                if (!isSegment(presetId)) return { kind: 'error', text: `capabilities preset-save: invalid presetId ${JSON.stringify(presetId)}` }
                const result = await library.create({
                  scope: spec.scope, presetId, workspaceKey,
                  document: { name: spec.name, selection },
                  onNameConflict,
                  allDisplayNames: async () => names.names,
                })
                return { kind: 'success', text: JSON.stringify({ ...result, presetId }) }
              } catch (cause) {
                return { kind: 'error', text: `capabilities preset-save failed: ${cause instanceof Error ? cause.message : String(cause)}` }
              }
            }
            if (verb.startsWith('preset-load ')) {
              // Load one preset document; the client stages its selection into
              // the local draft (stagePreset semantics) — Apply stays the only
              // path that changes the session's applied set.
              let spec
              try {
                spec = JSON.parse(rawInput.slice('preset-load '.length))
              } catch {
                return { kind: 'error', text: 'Usage: /capabilities preset-load <json {scope,presetId}>' }
              }
              try {
                const scopeError = presetScopeError(spec)
                if (scopeError) return scopeError
                if (!isSegment(spec.presetId)) return { kind: 'error', text: 'capabilities preset-load: presetId must be a valid store segment' }
                const workspaceKey = sessionWorkspaceKey()
                if (spec.scope === 'workspace' && !isSegment(workspaceKey)) return noWorkspace
                const library = createPresetLibrary({ store: capabilityStore() })
                const loaded = await library.load(spec.scope, spec.presetId, workspaceKey)
                if (loaded.kind !== 'ok') return { kind: 'success', text: JSON.stringify({ status: loaded.kind }) }
                return { kind: 'success', text: JSON.stringify({ status: 'ok', revision: loaded.revision, document: loaded.document }) }
              } catch (cause) {
                return { kind: 'error', text: `capabilities preset-load failed: ${cause instanceof Error ? cause.message : String(cause)}` }
              }
            }
            if (verb.startsWith('preset-delete ')) {
              let spec
              try {
                spec = JSON.parse(rawInput.slice('preset-delete '.length))
              } catch {
                return { kind: 'error', text: 'Usage: /capabilities preset-delete <json {scope,presetId,expectedRevision}>' }
              }
              try {
                const scopeError = presetScopeError(spec)
                if (scopeError) return scopeError
                if (!isSegment(spec.presetId)) return { kind: 'error', text: 'capabilities preset-delete: presetId must be a valid store segment' }
                if (!Number.isSafeInteger(spec.expectedRevision) || spec.expectedRevision < 0) {
                  return { kind: 'error', text: 'capabilities preset-delete: expectedRevision must be a non-negative integer' }
                }
                const workspaceKey = sessionWorkspaceKey()
                if (spec.scope === 'workspace' && !isSegment(workspaceKey)) return noWorkspace
                const library = createPresetLibrary({ store: capabilityStore() })
                const result = await library.remove({ scope: spec.scope, presetId: spec.presetId, workspaceKey, expectedRevision: spec.expectedRevision })
                return { kind: 'success', text: JSON.stringify(result) }
              } catch (cause) {
                return { kind: 'error', text: `capabilities preset-delete failed: ${cause instanceof Error ? cause.message : String(cause)}` }
              }
            }
            if (verb.startsWith('preset-export ')) {
              // format:'document' is the v1 portable document (verbatim via
              // library.exportPreset — inspect/backup); the default 'package'
              // is the D6 version-2 package: remote Skills as portable refs,
              // workspace/local Skills as bundled content, builtin Skills by
              // name, managed MCP as {identity,label}.
              let spec
              try {
                spec = JSON.parse(rawInput.slice('preset-export '.length))
              } catch {
                return { kind: 'error', text: 'Usage: /capabilities preset-export <json {scope,presetId,format?:"package"|"document"}>' }
              }
              try {
                const scopeError = presetScopeError(spec)
                if (scopeError) return scopeError
                if (!isSegment(spec.presetId)) return { kind: 'error', text: 'capabilities preset-export: presetId must be a valid store segment' }
                const format = spec.format ?? 'package'
                if (format !== 'package' && format !== 'document') {
                  return { kind: 'error', text: 'capabilities preset-export: format must be "package" | "document"' }
                }
                const workspaceKey = sessionWorkspaceKey()
                if (spec.scope === 'workspace' && !isSegment(workspaceKey)) return noWorkspace
                const library = createPresetLibrary({ store: capabilityStore() })
                if (format === 'document') {
                  const exported = await library.exportPreset(spec.scope, spec.presetId, workspaceKey)
                  return { kind: 'success', text: JSON.stringify(exported) }
                }
                const loaded = await library.load(spec.scope, spec.presetId, workspaceKey)
                if (loaded.kind !== 'ok') return { kind: 'success', text: JSON.stringify({ status: loaded.kind }) }
                // Pack against the live inventory (Skill file content comes
                // from the matched candidates' locators) and the managed
                // registry (MCP labels).
                const inventoryResult = await inventory(options)
                const candidates = Array.isArray(inventoryResult?.candidates) ? inventoryResult.candidates : []
                const registry = createMcpRegistry({ store: capabilityStore() })
                const record = await registry.read()
                /** @type {Record<string, string>} */
                const labels = {}
                if (record.kind === 'ok') for (const entry of Object.values(record.servers)) labels[entry.identity] = entry.label
                const source = /** @type {Record<string, unknown>} */ (loaded.document ?? {})
                const packed = await packPresetPackage({ name: source.name, selection: source.selection }, {
                  candidates,
                  mcpLabels: identity => labels[identity],
                })
                if (!packed.ok) return { kind: 'error', text: JSON.stringify({ status: 'rejected', reason: packed.reason }) }
                return { kind: 'success', text: JSON.stringify({ status: 'ok', format: 'package', document: packed.package }) }
              } catch (cause) {
                return { kind: 'error', text: `capabilities preset-export failed: ${cause instanceof Error ? cause.message : String(cause)}` }
              }
            }
            if (verb.startsWith('preset-import ')) {
              // Import a portable document: validate atomically first (a
              // poison document is rejected with zero writes), then bind only
              // the identities the local MCP registry already configured —
              // everything else stays an unresolved ref. Nothing is installed,
              // started or connected here.
              let spec
              try {
                spec = JSON.parse(rawInput.slice('preset-import '.length))
              } catch {
                return { kind: 'error', text: 'Usage: /capabilities preset-import <json {document,scope,presetId?,name?,onNameConflict?,dryRun?,onCollision?}>' }
              }
              try {
                const scopeError = presetScopeError(spec)
                if (scopeError) return scopeError
                // Version dispatch (D6): a version-2 package takes the
                // two-phase path (dryRun summary → confirmed install + CAS
                // preset create). Everything else keeps the v1 portable
                // path, whose own gate rejects unknown versions atomically.
                if (spec.document !== null && typeof spec.document === 'object' && !Array.isArray(spec.document)
                  && /** @type {Record<string, unknown>} */ (spec.document).version === 2) {
                  return await importPresetPackage(spec)
                }
                const verdict = validatePortableDocument(spec.document)
                if (!verdict.ok) return { kind: 'error', text: JSON.stringify({ status: 'rejected', reason: verdict.reason }) }
                const workspaceKey = sessionWorkspaceKey()
                if (spec.scope === 'workspace' && !isSegment(workspaceKey)) return noWorkspace
                const presetId = spec.presetId ?? spec.document.presetId
                if (!isSegment(presetId)) return { kind: 'error', text: 'capabilities preset-import: presetId must be a valid store segment' }
                const name = typeof spec.name === 'string' && spec.name.length ? spec.name : spec.document.name
                const store = capabilityStore()
                const names = await presetNamesOf(store, spec.scope, workspaceKey)
                if (names.kind !== 'ok') return { kind: 'error', text: JSON.stringify({ status: names.kind, reason: names.reason }) }
                const registry = createMcpRegistry({ store })
                const record = await registry.read()
                const localMcpIdentities = record.kind === 'ok' ? Object.keys(record.servers) : []
                const selection = /** @type {Record<string, unknown>} */ (spec.document.selection ?? {})
                const bound = bindImportedSelection(selection, { localMcpIdentities })
                const document = {
                  name,
                  selection: {
                    skills: [],
                    mcpServers: bound.mcpServers,
                    unresolvedRefs: [
                      ...(Array.isArray(selection.unresolvedRefs) ? selection.unresolvedRefs : []),
                      ...bound.unresolvedRefs,
                    ],
                  },
                }
                const library = createPresetLibrary({ store })
                const result = await library.create({
                  scope: spec.scope, presetId, workspaceKey, document,
                  onNameConflict: spec.onNameConflict ?? 'cancel',
                  allDisplayNames: async () => names.names,
                })
                return { kind: 'success', text: JSON.stringify({ ...result, presetId, bound: { mcpServers: bound.mcpServers.length, unresolvedRefs: bound.unresolvedRefs.length } }) }
              } catch (cause) {
                return { kind: 'error', text: `capabilities preset-import failed: ${cause instanceof Error ? cause.message : String(cause)}` }
              }
            }
            if (verb === 'default-get') {
              // Inspect this workspace's new-session default. A cleared marker
              // is reported distinctly — clearing is never an explicit empty
              // set, which stays a savable choice.
              try {
                const workspaceKey = sessionWorkspaceKey()
                if (!isSegment(workspaceKey)) return noWorkspace
                const transaction = createDefaultsTransaction({ store: capabilityStore() })
                const record = await transaction.read(workspaceKey)
                if (record.kind !== 'ok') return { kind: 'success', text: JSON.stringify({ status: record.kind, workspaceKey }) }
                const snapshot = record.snapshot
                const cleared = snapshot !== null && typeof snapshot === 'object' && !Array.isArray(snapshot)
                  && /** @type {Record<string, unknown>} */ (snapshot).cleared === true
                return { kind: 'success', text: JSON.stringify({ status: 'ok', revision: record.revision, cleared, snapshot, workspaceKey }) }
              } catch (cause) {
                return { kind: 'error', text: `capabilities default-get failed: ${cause instanceof Error ? cause.message : String(cause)}` }
              }
            }
            if (verb.startsWith('default-save ')) {
              // Save this workspace's new-session default as a COPY snapshot
              // of the draft or the applied sets. Saving never changes the
              // current session; an explicit empty set is a real choice.
              let spec
              try {
                spec = JSON.parse(rawInput.slice('default-save '.length))
              } catch {
                return { kind: 'error', text: 'Usage: /capabilities default-save <json {from:"draft"|"applied",skills?,mcpServers?,unresolvedRefs?,expectedRevision?}>' }
              }
              try {
                if (spec?.from !== 'draft' && spec?.from !== 'applied') return { kind: 'error', text: 'capabilities default-save: from must be "draft" | "applied"' }
                const workspaceKey = sessionWorkspaceKey()
                if (!isSegment(workspaceKey)) return noWorkspace
                const transaction = createDefaultsTransaction({ store: capabilityStore() })
                let expectedRevision = spec.expectedRevision
                if (expectedRevision === undefined) {
                  const current = await transaction.read(workspaceKey)
                  if (current.kind !== 'ok' && current.kind !== 'absent') return { kind: 'error', text: JSON.stringify({ status: current.kind }) }
                  expectedRevision = current.kind === 'ok' ? current.revision : 0
                }
                if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
                  return { kind: 'error', text: 'capabilities default-save: expectedRevision must be a non-negative integer' }
                }
                const sets = await selectionSetsOf(spec)
                const result = await transaction.save({ workspaceKey, expectedRevision, snapshot: { skills: sets.skills, mcpServers: sets.mcpServers, unresolvedRefs: sets.unresolvedRefs } })
                return { kind: 'success', text: JSON.stringify({ ...result, workspaceKey }) }
              } catch (cause) {
                return { kind: 'error', text: `capabilities default-save failed: ${cause instanceof Error ? cause.message : String(cause)}` }
              }
            }
            if (verb === 'default-clear' || verb.startsWith('default-clear ')) {
              // Clear this workspace's default (absent afterwards — NOT an
              // explicit empty set). The JSON payload is optional.
              let spec = {}
              const rest = rawInput.slice('default-clear'.length).trim()
              if (rest.length > 0) {
                try {
                  spec = JSON.parse(rest)
                } catch {
                  return { kind: 'error', text: 'Usage: /capabilities default-clear [json {expectedRevision?}]' }
                }
              }
              try {
                const workspaceKey = sessionWorkspaceKey()
                if (!isSegment(workspaceKey)) return noWorkspace
                const transaction = createDefaultsTransaction({ store: capabilityStore() })
                let expectedRevision = spec.expectedRevision
                if (expectedRevision === undefined) {
                  const current = await transaction.read(workspaceKey)
                  if (current.kind !== 'ok' && current.kind !== 'absent') return { kind: 'error', text: JSON.stringify({ status: current.kind }) }
                  expectedRevision = current.kind === 'ok' ? current.revision : 0
                }
                if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
                  return { kind: 'error', text: 'capabilities default-clear: expectedRevision must be a non-negative integer' }
                }
                const result = await transaction.clear({ workspaceKey, expectedRevision })
                return { kind: 'success', text: JSON.stringify({ ...result, workspaceKey }) }
              } catch (cause) {
                return { kind: 'error', text: `capabilities default-clear failed: ${cause instanceof Error ? cause.message : String(cause)}` }
              }
            }
            if (verb === 'conditions') {
              // The 1.12 consistency conditions; empty = supported.
              return { kind: 'success', text: JSON.stringify(buildConditionsPayload()) }
            }
            return { kind: 'error', text: 'Usage: /capabilities receipt|list|conditions|presets|preset-save|preset-load|preset-delete|preset-export|preset-import|default-get|default-save|default-clear' }
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
      applySelection: (session, request, options) => engineFor().apply(session, request, options),
      /** 12.4 diagnostics: whether a removal notice is queued for a session. */
      hasPendingNotification: sessionId => notifier.has(sessionId),
    }
    mounted.set(ctx, face)
    processFace = face
    // Capability read remote (silent-capability-reads 2.2): feed the
    // module-level bridge the host-layer read service resolves its faces
    // from AT CALL TIME (preset-realm services are invisible to the host-root
    // typert gateway, S27 — same module-instance pattern as the MCP facade
    // realm bridge). ctx.effect unregisters the feed with this plugin's own
    // lifecycle; a feed failure leaves the bridge absent, which the service
    // surfaces as an explicit typed error, never a guessed payload.
    try {
      ctx.effect(() => feedCapabilityReadBridge({
        provider,
        inventory: (options, previous) => inventory(options, previous),
        lifecycle,
        mcpManager: () => ctx.get?.('orreryMcpManager'),
        profileContext: () => ctx.get?.('profileContext'),
        sessionCwd: sessionId => (sessionCwds.has(sessionId) ? { found: true, cwd: sessionCwds.get(sessionId) } : { found: false, cwd: undefined }),
      }), 'orrery-capability-read-bridge')
    } catch (cause) {
      ctx.logger?.warn?.(`capability read bridge feed failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
}

export const name = 'orrery-skill-selection'
export const inject = ['skills']
export const apply = createSkillSelectionPlugin()
