import { createHash } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { createSkillIdentity, skillIdentityKey } from './skill-identity.js'
import { openCapabilityStore } from './store/store.js'
import { discoverSkillInventory, resolveSkillRoots } from './skill-inventory.js'
import { createSkillSelectionProvider } from './skill-selection-provider.js'
import { assertBuiltinSkillMigration } from './skill-builtin-migration.js'
import { createOfficeAdapter, officeDenials } from './skill-office-adapter.js'
import { createPresetInvalidation, emitPresetSelected } from './preset-invalidation.js'
import { createLifecycleSnapshots } from './lifecycle-snapshot.js'
import { preloadLifecycleSnapshots } from './lifecycle-preload.js'
import { classifySelectionFailure } from './selection-status.js'
import { resolveInitialSelection, baselineSkillIdentities, bindDefaultSkillNames } from './initial-selection.js'
import { partitionUnresolvedSkills } from './skill-applicability.js'
import { workspaceKeyOf, createPresetVerbs } from './preset-library.js'
import { createDefaultsVerbs } from './defaults-transaction.js'
import { buildPresetsPayload, buildDefaultGetPayload } from './read-payloads.js'
import { packPresetPackage, createPackageVerbs } from './preset-package.js'
import { createApplyEngine } from './apply-engine.js'
import { createSessionDrainAdapter } from './mcp-drain.js'
import { createSelectionNotifier } from './selection-notify.js'
import { createMcpRegistry } from './mcp-registry.js'
import { createMcpOperations } from './mcp-operations.js'
import { mcpDiagnostic } from './mcp-diagnostics.js'
import { buildReceiptPayload, buildListPayload, buildConditionsPayload } from './read-payloads.js'
import { feedCapabilityReadBridge, capabilityReadFeed, capabilityOwnership, createCapabilityMutationService, sameMutationOwner } from './capability-remote.js'
import { createMcpInstallTool } from './mcp-install-tool.js'
import { parseFrontmatter } from './frontmatter.js'
import { createAudit } from '../shared/audit.js'

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
            //
            // Only a TRUE delegated child (depth > 0) is refused: a depth-0
            // fork also carries a parentSession header, and when its source
            // never established any effective snapshot the creation-time
            // capture is skipped on purpose so that this read performs the
            // ordinary root initialization for the fork itself.
            const header = options.scope?.session?.header ?? {}
            const isDelegatedChild = (header.delegationDepth ?? 0) > 0
            let inherited
            try {
              inherited = await store.read({ kind: 'inherited', sessionId })
            } catch (cause) {
              throw new Error('Skill selection policy is unreadable', { cause })
            }
            if (inherited.kind === 'ok') return inherited.payload?.skills
            if (inherited.kind !== 'absent') throw new Error(`Inherited skill snapshot is ${inherited.kind}`)
            if (isDelegatedChild) throw new Error('Inherited skill snapshot is absent')
            // Root initialization is only for a PROVEN absent source. A depth-0
            // fork whose capture or existing policy already became BLOCKED must
            // keep the inherited-snapshot failure, never bypass it with a fresh
            // baseline; an explicit accepted Apply remains the recovery path.
            if (lifecycle?.snapshotFor?.(sessionId)?.state === 'blocked') throw new Error('Inherited skill snapshot is absent')
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
            weirBuiltinDir: config.weirBuiltinDir ?? fileURLToPath(new URL('../../skills/', import.meta.url)),
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
          const registry = await createMcpRegistry({ store }).read()
          if (registry.kind !== 'ok' && registry.kind !== 'absent') throw new Error(`MCP registry is ${registry.kind}`)
          const registryServers = registry.kind === 'ok' ? registry.servers : {}
          // Only a FULLY formed initial result may become a lifecycle snapshot:
          // a baseline or a name binding derived from an incomplete inventory is
          // a best-effort view, never an inheritable set (D2).
          let complete = true
          if (defaultsRecord.kind === 'absent') {
            const snapshot = await inventory(options)
            complete = snapshot?.complete !== false
            // Baseline scopes are row-configurable (default builtin-only);
            // the weir-creative preset adds 'custom' for its fused skills.
            builtinIdentities = baselineSkillIdentities(snapshot?.candidates, config.baselineScopes)
            enabledMcpIdentities = registry.kind === 'ok' ? registry.enabled : []
          }
          const resolved = resolveInitialSelection({ defaultsRecord, builtinIdentities, enabledMcpIdentities })
          for (const identity of resolved.selection.mcpServers) {
            if (!registryServers[identity]) resolved.missing.push({ kind: 'mcp', ref: identity, reason: 'configured default is not registered' })
          }
          resolved.selection.mcpIncarnations = Object.fromEntries(resolved.selection.mcpServers.filter(identity => registryServers[identity]).map(identity => [identity, registryServers[identity].incarnation ?? null]))
          // Name-string skill entries in a workspace default (the client
          // draft's wire shape, written by default-save from:'draft') bind
          // against the live inventory by unique name; unbindable entries
          // degrade to reported missing, never failing the whole default.
          // Identity-shaped records (from:'applied') skip the inventory
          // entirely — it still only runs on the builtin-baseline path.
          if (resolved.source === 'workspace-default' && resolved.selection.skills.some(entry => typeof entry === 'string')) {
            const snapshot = await inventory(options)
            complete = complete && snapshot?.complete !== false
            const bound = bindDefaultSkillNames(resolved.selection.skills, snapshot?.candidates)
            resolved.selection.skills = bound.skills
            resolved.missing = [...resolved.missing, ...bound.missing]
          }
          const sessionId = options.scope?.session?.id
          if (typeof sessionId === 'string' && sessionId.length) {
            initialReports.set(sessionId, { source: resolved.source, missing: resolved.missing, mcpServers: resolved.selection.mcpServers })
            // Effective-set publication for Fork inheritance: a depth-0 fork of a
            // session whose initial set was already resolved must inherit THAT
            // set, not an empty one. The result is published as the session's
            // revision-0 lifecycle snapshot — never persisted, never an accepted
            // record. A snapshot that appeared while this async resolution was
            // in flight (an accepted Apply, a captured inheritance) wins, and a
            // partially resolved/incomplete result is not published at all.
            if (complete && lifecycle && typeof lifecycle.peek === 'function' && typeof lifecycle.publish === 'function'
              && lifecycle.peek(sessionId) === null) {
              lifecycle.publish(sessionId, {
                revision: 0,
                skills: resolved.selection.skills,
                mcpServers: resolved.selection.mcpServers,
                mcpIncarnations: resolved.selection.mcpIncarnations,
                captured: null,
              })
            }
          }
          return resolved.selection.skills
        })
        provider = createSkillSelectionProvider({ control, readSelection, inventory, denials: officeDenials })
        return provider
      })
      ctx.on('skills/change', () => provider.sourceChanged())
      // Task 5.2: re-emit the invalidation broadcast for root weir-preset
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
    //
    // durable-pending-notice D6: the queue is durable, so the notifier needs the
    // SAME capability store the engine writes — memoized here (the engine was
    // already lazy per process) so the queue write and the acceptance share one
    // unit layout, one support gate and one set of lock files. The audit channel
    // is created before the notifier so its outcomes reach the cold-safe
    // `weir/capability-notice` event (D7) — created once, shared with the hooks.
    const audit = createAudit(ctx)
    let sharedStore = null
    const storeFor = () => {
      if (!sharedStore) sharedStore = openCapabilityStore({ profileContext: ctx.get?.('profileContext') })
      return sharedStore
    }
    const notifier = createSelectionNotifier({ store: storeFor(), audit })
    let sharedEngine = null
    const engineFor = () => {
      if (sharedEngine) return sharedEngine
      // The production hook set (drain / publishSnapshot / onAccepted /
      // invalidate / audit / trace / warn) lives in the exported
      // applyEngineHooks assembly so the wiring pin drives the exact
      // production hooks (design D5).
      sharedEngine = createApplyEngine({
        store: storeFor(),
        locateSession: session => session,
        inventory: (options) => inventory(options),
        provider,
        mcpRegistry: createMcpRegistry({ store: storeFor() }),
        ...applyEngineHooks({ ctx, lifecycle, notifier, audit }),
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
        weirBuiltinDir: config.weirBuiltinDir ?? fileURLToPath(new URL('../../skills/', import.meta.url)),
      })
    }
    // The shared cold-safe audit channel (cordis emit + .weir/audit.jsonl
    // mirror; never session.append) is the one created above, so the notice
    // queue, the Apply hooks and the package-import outcomes share it.
    // (The package-import install outcome and its collision decisions are
    // audited through it — task 6.3.)
    // Group 12 client surface: a /capabilities command serving the Badge and
    // manager (receipt / listing / conditions). Values travel as command
    // results — no projection state and no custom session-log event types.
    //
    // capabilities-deepening D2: the handler is now only the dispatch surface
    // — registration, the verb table (each entry's payload shape and usage
    // line) and the case-insensitive dispatch with its usage fall-through.
    // The preset/default/package verb bodies live in the domain modules that
    // own their contracts (preset-library.js / defaults-transaction.js /
    // preset-package.js), instantiated here with their former handler
    // closures injected explicitly. receipt/list/apply/mcp-add/conditions
    // stay local: their contracts are the read-payload builders and the
    // manager/engine wiring themselves.
    try {
      const commands = ctx.get?.('commands')
      if (commands) {
        // Shared wiring — every verb opens the same store and resolves the
        // same workspace binding as before; every failure is an explicit
        // status in the JSON payload, never a throw escaping the handler.
        const openStore = () => openCapabilityStore({ profileContext: ctx.get?.('profileContext') })
        const presetVerbs = createPresetVerbs({
          openStore, provider, inventory, lifecycle,
          builders: { buildPresetsPayload, buildReceiptPayload },
          packPresetPackage,
        })
        const defaultsVerbs = createDefaultsVerbs({
          openStore, provider, inventory, lifecycle,
          builders: { buildDefaultGetPayload },
        })
        const packageVerbs = createPackageVerbs({ openStore, inventory, skillRootsFor, audit })

        /** receipt: thin shell over the shared builder (silent-capability-reads 2.1). */
        const receiptVerb = async (_spec, { options }) => {
          try {
            // Shared builder (silent-capability-reads 2.1): the read remote
            // serializes the same payload from the same code.
            const payload = await buildReceiptPayload({
              provider,
              lifecycle,
              store: openStore(),
            }, options)
            // The commands registry normalizes results to {kind, text}
            // (CITED dsh-commands normalizeResult): structured payloads
            // travel as JSON text.
            return { kind: 'success', text: JSON.stringify(payload) }
          } catch (cause) {
            return { kind: 'error', text: `capabilities receipt failed: ${cause instanceof Error ? cause.message : String(cause)}` }
          }
        }

        /** list: full inventory joined with the session's effective selection. */
        const listVerb = async (_spec, { options }) => {
          try {
            // Shared builder (silent-capability-reads 2.1): the FULL
            // inventory joined with the session's EFFECTIVE selection, plus
            // the MCP manager listing (read at call time).
            const payload = await buildListPayload({
              inventory: (inventoryOptions, previous) => inventory(inventoryOptions, previous),
              provider,
              mcpManager: ctx.get?.('weirMcpManager'),
            }, options)
            // Degraded-listing fidelity (resume-incarnation-recovery D3):
            // when the selection view is in an error state, provider.list
            // fail-closed empty made buildListPayload list the inventory
            // with every mark false — but the error state itself was
            // invisible, indistinguishable from a successful empty
            // inventory. Rebuild the rows from the RAW inventory with the
            // real scope/provenance labels (candidate identity/root scope —
            // never the 'unknown'/'other' degradation), every selection mark
            // false, and carry the classified failure alongside, so the
            // panel can still drive the Apply self-heal. The healthy path
            // above stays byte-identical.
            const status = provider.status(options)
            if (status?.error) {
              const rawInventory = await inventory(options)
              const rawCandidates = Array.isArray(rawInventory?.candidates) ? rawInventory.candidates : []
              return { kind: 'success', text: JSON.stringify({
                skills: rawCandidates.map(candidate => ({
                  name: candidate?.name,
                  description: candidate?.description ?? '',
                  scope: candidate?.identity?.scope ?? candidate?.root?.scope ?? 'unknown',
                  status: candidate?.status ?? 'unknown',
                  selected: false,
                  conflict: Boolean(candidate?.conflict),
                  identity: candidate?.identity ?? null,
                })),
                mcpServers: payload.mcpServers,
                selectionError: { error: status.error, reason: status.reason ?? null, hint: status.hint ?? null },
              }) }
            }
            return { kind: 'success', text: JSON.stringify(payload) }
          } catch (cause) {
            return { kind: 'error', text: `capabilities list failed: ${cause instanceof Error ? cause.message : String(cause)}` }
          }
        }

        /** apply: the manager editor's commit (12.3). */
        const applyVerb = async (draft, { agent, options }) => {
          // The client sends {requestId, expectedRevision, skills:
          // [identities or names], mcpServers: [names]} as JSON text after
          // the verb; identities match exactly and names must match one
          // parsed CURRENT candidate, never a silent winner.
          try {
            // The full inventory (not the effective selection): an Apply may
            // name any discovered candidate, selected or not.
            const inventoryResult = await inventory(options)
            const candidates = Array.isArray(inventoryResult?.candidates) ? inventoryResult.candidates : []
            const byKey = new Map()
            const parsedByName = new Map()
            for (const candidate of candidates) {
              if (!candidate.identity) continue
              byKey.set(skillIdentityKey(candidate.identity), candidate)
              if (candidate.status !== 'parsed') continue
              const matches = parsedByName.get(candidate.name) ?? []
              matches.push(candidate)
              parsedByName.set(candidate.name, matches)
            }
            // The unresolved draft entries keep their ORIGINAL shape: a legacy
            // name string is not an identity and cannot be classified by
            // workspace, while an identity object carries the scope/root the
            // cross-workspace partition needs. Collapsing both to a name here
            // is what made a foreign project reference unactionable.
            const missing = []
            const identities = []
            const admitted = new Set()
            for (const entry of draft.skills ?? []) {
              let candidate
              if (typeof entry === 'string') {
                const matches = parsedByName.get(entry) ?? []
                if (matches.length === 1) candidate = matches[0]
                else missing.push(entry)
              } else {
                const identity = createSkillIdentity(entry)
                candidate = byKey.get(skillIdentityKey(identity))
                if (!candidate) missing.push(identity)
              }
              if (!candidate) continue
              const key = skillIdentityKey(candidate.identity)
              if (admitted.has(key)) continue
              admitted.add(key)
              identities.push(candidate.identity)
            }
            // preset applicability partition (D2 + cross-workspace D4):
            // - KNOWN-BUT-INAPPLICABLE names (resolvable in a profile-supplemental
            //   directory, e.g. creative-preset skills carried by a workspace
            //   default) are SKIPPED with a per-name reason;
            // - a project identity PROVEN to belong to another workspace (its
            //   canonical root is outside every current project Skill root of a
            //   COMPLETE inventory) is SKIPPED as not applicable in this
            //   workspace — the preset contract, not a same-name conflict, and
            //   never a local same-name substitute;
            // - everything else keeps the hard-failure contract with the draft
            //   preserved (a local identity the inventory no longer resolves, a
            //   project identity of THIS workspace, an incomplete inventory, or
            //   an unresolvable current-workspace root set authorizes no skip).
            // Records are never rewritten for applicability, so a preset
            // round-trip stays lossless.
            const { skipped, unknown } = partitionUnresolvedSkills(missing, {
              roots: inventoryResult?.roots,
              complete: inventoryResult?.complete,
              knownSupplemental: name => supplementalSkillKnown(config.supplementalSkillDirs, name),
            })
            if (unknown.length > 0) return { kind: 'error', text: JSON.stringify({ status: 'missing', missing: unknown, ...(skipped.length > 0 ? { skipped } : {}) }) }
            const response = await face.applySelection(
              { sessionId: agent.id, cwd: agent.session?.header?.cwd, presetId: 'weir' },
              { requestId: draft.requestId, expectedRevision: draft.expectedRevision, selection: { skills: identities, mcpServers: draft.mcpServers ?? [] }, unresolved: [] },
              options,
            )
            return { kind: 'success', text: JSON.stringify(skipped.length > 0 ? { ...response, skipped } : response) }
          } catch (cause) {
            return { kind: 'error', text: `capabilities apply failed: ${cause instanceof Error ? cause.message : String(cause)}` }
          }
        }

        const mcpVerb = (action) => async (spec, { agent }) => {
          try {
            if (action === 'mcp-add' && (typeof spec.identity !== 'string' || typeof spec.label !== 'string' || typeof spec.command !== 'string' || spec.command.length === 0)) {
              return { kind: 'error', text: 'mcp-add needs identity, label and command strings' }
            }
            const { expectedRevision, confirmNamespaceChange, targetFingerprint, attemptId, batch, mode, refsOnly, surface, ...fields } = spec
            const operation = action === 'mcp-default' ? 'setDefault' : action === 'mcp-preview' ? 'preview' : action === 'mcp-batch' ? 'batch' : action.slice(4)
            const request = {
              ...spec,
              action: operation === 'batch' ? 'add' : operation,
              refsOnly: action === 'mcp-add' ? false : true,
              surface: action === 'mcp-add' ? 'legacy' : surface ?? 'refs',
            }
            if (!spec.config && !spec.document && !['remove', 'restart', 'setDefault'].includes(operation)) {
              if (operation === 'batch' || fields.mcpServers) request.document = fields
              else request.config = fields
            }
            const operations = face.mcpOperations(agent.session)
            const result = operation === 'preview'
              ? await operations.preview(request)
              : operation === 'batch'
                ? await operations.executeBatch(request)
                : await operations.execute(request)
            const successful = new Set(['preview', 'mounted', 'saved', 'removed'])
            return { kind: successful.has(result.status) ? 'success' : 'error', text: JSON.stringify(result) }
          } catch (cause) {
            return { kind: 'error', text: JSON.stringify({ status: 'validation-failed', saved: false, error: mcpDiagnostic(cause, { code: cause?.code ?? 'validation-failed' }) }) }
          }
        }

        /** conditions: the 1.12 consistency conditions; empty = supported. */
        const conditionsVerb = async () => ({ kind: 'success', text: JSON.stringify(buildConditionsPayload()) })

        // The dispatch table. `payload` declares the argument shape: 'none'
        // (bare verb only), 'required' (verb + JSON), 'optional'
        // (default-clear). A payload-less call of a required-payload verb
        // and extra words after a bare verb both land on the usage
        // fall-through — the historical behavior.
        const verbTable = {
          receipt: { payload: 'none', run: receiptVerb },
          list: { payload: 'none', run: listVerb },
          apply: { payload: 'required', usage: 'Usage: /capabilities apply <json selection>', run: applyVerb },
          'mcp-add': { payload: 'required', usage: 'Usage: /capabilities mcp-add <json {identity,label,command,args?,env?,serverName?}>', run: mcpVerb('mcp-add') },
          'mcp-preview': { payload: 'required', usage: 'Usage: /capabilities mcp-preview <json server|{mcpServers:{...}}>', run: mcpVerb('mcp-preview') },
          'mcp-batch': { payload: 'required', usage: 'Usage: /capabilities mcp-batch <json {mcpServers:{...},mode?:"add"|"edit"}>', run: mcpVerb('mcp-batch') },
          'mcp-edit': { payload: 'required', usage: 'Usage: /capabilities mcp-edit <json {identity,expectedRevision,...config}>', run: mcpVerb('mcp-edit') },
          'mcp-remove': { payload: 'required', usage: 'Usage: /capabilities mcp-remove <json {identity,expectedRevision}>', run: mcpVerb('mcp-remove') },
          'mcp-restart': { payload: 'required', usage: 'Usage: /capabilities mcp-restart <json {identity,expectedRevision}>', run: mcpVerb('mcp-restart') },
          'mcp-test': { payload: 'required', usage: 'Usage: /capabilities mcp-test <json config>', run: mcpVerb('mcp-test') },
          'mcp-default': { payload: 'required', usage: 'Usage: /capabilities mcp-default <json {identity,enabled,expectedRevision?}>', run: mcpVerb('mcp-default') },
          presets: { payload: 'none', run: presetVerbs.presets },
          'preset-save': { payload: 'required', usage: 'Usage: /capabilities preset-save <json>', run: presetVerbs['preset-save'] },
          'preset-rename': { payload: 'required', usage: 'Usage: /capabilities preset-rename <json>', run: presetVerbs['preset-rename'] },
          'preset-resave': { payload: 'required', usage: 'Usage: /capabilities preset-resave <json>', run: presetVerbs['preset-resave'] },
          'preset-load': { payload: 'required', usage: 'Usage: /capabilities preset-load <json {scope,presetId}>', run: presetVerbs['preset-load'] },
          'preset-delete': { payload: 'required', usage: 'Usage: /capabilities preset-delete <json {scope,presetId,expectedRevision}>', run: presetVerbs['preset-delete'] },
          'preset-export': { payload: 'required', usage: 'Usage: /capabilities preset-export <json {scope,presetId,format?:"package"|"document"}>', run: presetVerbs['preset-export'] },
          'preset-import': { payload: 'required', usage: 'Usage: /capabilities preset-import <json {document,scope,presetId?,name?,onNameConflict?,dryRun?,onCollision?}>', run: packageVerbs['preset-import'] },
          'default-get': { payload: 'none', run: defaultsVerbs['default-get'] },
          'default-save': { payload: 'required', usage: 'Usage: /capabilities default-save <json {from:"draft"|"applied",skills?,mcpServers?,unresolvedRefs?,expectedRevision?}>', run: defaultsVerbs['default-save'] },
          'default-clear': { payload: 'optional', usage: 'Usage: /capabilities default-clear [json {expectedRevision?}]', run: defaultsVerbs['default-clear'] },
          conditions: { payload: 'none', run: conditionsVerb },
        }

        ctx.effect(() => commands.register({
          name: 'capabilities',
          description: 'Session capability surface (receipt | list | apply | mcp-preview | mcp-add | mcp-batch | mcp-edit | mcp-remove | mcp-restart | mcp-test | mcp-default | presets and workspace defaults).',
          handler: async (invocation) => {
            const agent = invocation?.agent
            if (!agent) return { kind: 'error', text: 'capabilities: requires an owning agent session' }
            // Verb matching is case-insensitive; the apply payload is JSON
            // and must keep its original casing
            // (requestId/expectedRevision/...).
            const rawInput = String(invocation.rawInput ?? '').trim()
            const verb = rawInput.toLowerCase()
            const options = { cwd: agent.session?.header?.cwd, scope: { session: { id: agent.id } } }
            const head = verb.split(' ', 1)[0]
            const entry = verbTable[head]
            const hasArgs = verb.length > head.length
            if (!entry || (entry.payload === 'none' && hasArgs)) {
              return { kind: 'error', text: 'Usage: /capabilities receipt|list|apply|mcp-preview|mcp-add|mcp-batch|mcp-edit|mcp-remove|mcp-restart|mcp-test|mcp-default|presets|default-get|default-save|default-clear' }
            }
            if (entry.payload === 'required' && !hasArgs) {
              return { kind: 'error', text: entry.usage ?? 'Usage: /capabilities <verb> <json>' }
            }
            let spec
            if (entry.payload !== 'none' && hasArgs) {
              try { spec = JSON.parse(rawInput.slice(head.length + 1)) }
              catch { return { kind: 'error', text: entry.usage } }
            }
            return entry.run(spec, { agent, options })
          },
        }), 'weir-capabilities-command')
      }
    } catch (cause) {
      ctx.logger?.warn?.(`capabilities command registration failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    try {
      ctx.on('agent/pre-step', async ({ agent, messages }, next) => {
        // durable-pending-notice D4: read → build → inject → clear. The
        // obligation is cleared only AFTER the message landed in this request,
        // so a failed injection (a non-array `messages`, a throwing push)
        // leaves it pending for the next safe boundary instead of dropping it.
        // Delivery is advisory: it never throws into the request and never
        // affects an accepted commit.
        const outcome = await notifier.deliver(agent?.id, messages)
        if (outcome === 'injection-failed' || outcome === 'clear-failed') {
          ctx.logger?.warn?.(`selection notification delivery: ${outcome}`)
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
      mcpOperations: (session, options = {}) => createMcpOperations({
        registry: createMcpRegistry({ store: storeFor() }),
        manager: ctx.get?.('weirMcpManager'),
        credentials: ctx.get?.('credentials'),
        audit,
        session,
        assertOwner: options.assertOwner,
      }),
      /** 12.4 diagnostics: whether a removal notice is queued for a session. */
      hasPendingNotification: sessionId => notifier.has(sessionId),
    }
    mounted.set(ctx, face)
    processFace = face
    // The Host remote can see only this explicitly labeled preset's faces.
    // Its sessionQuery observation, not any creation-time cwd cache, owns routing.
    try {
      if (!['weir', 'weir-creative'].includes(config.readPresetId)) throw new Error('readPresetId must identify a supported Weir preset')
      ctx.effect(() => feedCapabilityReadBridge({
        readPresetId: config.readPresetId,
        provider,
        inventory: (options, previous) => inventory(options, previous),
        lifecycle,
        mcpManager: () => ctx.get?.('weirMcpManager'),
        mcpOperations: face.mcpOperations,
        profileContext: () => ctx.get?.('profileContext'),
      }), 'weir-capability-read-bridge')
    } catch (cause) {
      ctx.logger?.warn?.(`capability read bridge feed failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
    // Primary-Orchestrator AI installation rides the same selection row. All
    // Host services are resolved lazily; missing confirmation/ownership support
    // disables install without affecting inert preview or manual management.
    try {
      const tools = ctx.get?.('tools')
      if (tools?.register) {
        const sessionQuery = () => ctx.get?.('sessionQuery')
        // Two retained revisions of this preset may feed the bridge at once;
        // the owner is resolved per session through the agent's own revision.
        const runtime = { agents: () => ctx.get?.('agents'), agentPresets: () => ctx.get?.('agentPresets') }
        const mutations = createCapabilityMutationService({ sessionQuery, ...runtime })
        const captureOwnership = async sessionId => {
          const lease = await sessionQuery()?.observeSession?.(sessionId)
          if (!lease || typeof lease[Symbol.dispose] !== 'function') throw Object.assign(new Error('MCP install session observation is unavailable'), { code: 'owner-unavailable' })
          try {
            const owner = capabilityOwnership(lease, sessionId)
            const feed = capabilityReadFeed(owner.presetId, sessionId, runtime)
            const faces = feed.faces ?? feed
            return { owner, feed, profile: faces.profileContext?.() }
          } finally { lease[Symbol.dispose]() }
        }
        const tool = createMcpInstallTool({
          operationsFor: session => face.mcpOperations(session),
          mutate: (sessionId, request) => mutations.mutate(sessionId, request),
          captureOwnership,
          sameOwnership: sameMutationOwner,
          describeExecution: entry => ctx.get?.('weirMcpManager')?.describeExecution?.(entry),
          userQuestions: () => ctx.get?.('userQuestions'),
          isLiveRoot: agent => Boolean(agent && ctx.get?.('agents')?.get?.(agent.id) === agent),
        })
        if (typeof ctx.effect === 'function') ctx.effect(() => tools.register(tool), 'weir-mcp-install-tool')
        else tools.register(tool)
      }
    } catch (cause) {
      ctx.logger?.warn?.(`MCP install tool registration failed: ${cause instanceof Error ? cause.message : String(cause)}`)
    }
  }
}

/**
 * The production Apply-engine hook set (apply-delta-durable-basis D5), one
 * exported assembly so `engineFor()` and the wiring pin
 * (test/apply-wiring.test.js) share the exact production hooks — the store
 * and the session-facing deps (locateSession/inventory/provider) stay with
 * the caller. `audit` rides the shared cold-safe channel (createAudit:
 * cordis emit + .weir/audit.jsonl mirror, never session.append); `trace` is
 * logger-backed debug diagnostics and never throws into a transaction. The
 * `notify` response-bus seam stays unwired: no production consumer exists
 * (the manager reads the Apply response from its own call), and the wiring
 * pin says so explicitly. The notice hook queues the DURABLE obligation
 * (durable-pending-notice D2): `onAccepted` receives the accepted revision and
 * `queueSync` throws on a failed write, which the engine degrades — never an
 * exception into the Apply result.
 * @param {{ ctx: any, lifecycle: any, audit?: (session: { id?: string } | null, type: string, data?: unknown) => void, notifier: { queueSync(sessionId: string, delta: { added: string[], removed: string[] }, info?: { revision?: number }): unknown } }} deps
 */
export function applyEngineHooks({ ctx, lifecycle, notifier, audit = createAudit(ctx) }) {
  return {
    // The manager's (agent, server)-keyed drain is the only real in-flight
    // ledger (mcp-admission enter/exit at handoff). The engine is shared
    // across sessions, so the adapter keys begin/abort by the Apply's
    // session id (capabilities-deepening D3); a composition without the
    // manager row has no managed servers to drain and the adapter reports
    // the empty truth.
    drain: createSessionDrainAdapter(() => ctx.get?.('weirMcpManager')?.drain),
    publishSnapshot: (sessionId, snapshot) => lifecycle?.publish?.(sessionId, snapshot),
    onAccepted: (sessionId, delta, info) => notifier.queueSync(sessionId, delta, info),
    // The Apply-path convergence emission (5.2 parity with agent/created):
    // an accepted Apply re-emits the preset invalidation event so every
    // connected client drops cached capability state and refetches —
    // without this hook the engine never re-emits and every Badge/panel
    // goes stale until a remount.
    invalidate: (sessionId, presetId) => emitPresetSelected((...args) => ctx.emit(...args), sessionId, presetId, text => ctx.logger?.warn?.(text)),
    audit,
    trace: (event, data) => {
      try { ctx.logger?.debug?.(`capability-apply ${event}`, data) } catch { /* diagnostics never break a transaction */ }
    },
    warn: text => ctx.logger?.warn?.(text),
  }
}

/**
 * Session cwd resolution for the capability read bridge (silent-capability-reads):
 * the agent/created warm cache MISSES sessions whose agent was announced before
 * this plugin's listener registered — the boot-restore race, where the host
 * re-enters restored sessions while the preset composition is still mounting.
 * On a miss, resolve the LIVE agent through the host-plane agents registry
 * (agent.id === session.id, dsh-agent) exactly like the /capabilities command
 * handler's invocation.agent path, and backfill the cache. A session with no
 * live agent stays unknown (the typed unknown-session error), matching the
 * command path's requirement of a live agent.
 * @param {Map<string, string | undefined>} cache
 * @param {unknown} agentsService host `agents` service (ctx.get('agents'))
 * @param {string} sessionId
 * @returns {{ found: boolean, cwd: string | undefined }}
 */
export function resolveSessionCwd(cache, agentsService, sessionId, deps = {}) {
  if (cache.has(sessionId)) return { found: true, cwd: cache.get(sessionId) }
  const agent = /** @type {any} */ (agentsService)?.get?.(sessionId)
  if (agent) {
    const cwd = agent?.session?.header?.cwd
    cache.set(sessionId, cwd)
    return { found: true, cwd }
  }
  // Follow-mode / cold / history sessions have no live agent YET (the restore
  // promotes lazily and the badge reads before the agent enters). The session
  // header is durable from creation: read cwd straight from the persisted log
  // instead of depending on the agent lifecycle at all.
  const persisted = persistedSessionCwd(deps.home, sessionId)
  if (persisted.found) {
    cache.set(sessionId, persisted.cwd)
    return { found: true, cwd: persisted.cwd }
  }
  return { found: false, cwd: undefined }
}

/**
 * preset-skill-applicability D2: classify an inventory-missing skill name as
 * KNOWN-BUT-INAPPLICABLE vs genuinely unknown using the profile-supplemental
 * skill directories (row config `supplementalSkillDirs` — every preset row's
 * extra roots, declared in the composition, never enumerated into the
 * effective selection). A name counts as known only when `<dir>/<name>/SKILL.md`
 * exists AND its frontmatter name matches; any unreadable directory or
 * parse failure counts as NOT known (conservative hard-failure, never a
 * guessed skip).
 * @param {unknown} dirs row config value (expected string[])
 * @param {string} name
 * @returns {boolean}
 */
export function supplementalSkillKnown(dirs, name) {
  if (!Array.isArray(dirs) || typeof name !== 'string' || name.length === 0) return false
  for (const dir of dirs) {
    if (typeof dir !== 'string' || dir.length === 0) continue
    try {
      const file = join(dir, name, 'SKILL.md')
      if (!existsSync(file)) continue
      const parsed = parseFrontmatter(readFileSync(file, 'utf8'))
      if (parsed?.data?.name === name) return true
    } catch { /* unreadable dir/entry — not evidence of knowledge */ }
  }
  return false
}

/**
 * Read a session's cwd from its persisted log header
 * (<home>/sessions/<slug>/<sessionId>/session.v4.jsonl.zstd — first frame,
 * first JSONL record, the `{type:'session', cwd}` header). The session-id
 * directory name is matched exactly; a plain .jsonl log is accepted for
 * pre-compression artifacts. Everything unreadable/corrupt reports not-found
 * — never a guessed cwd.
 * @param {string | undefined} home DSH home (profileContext.home)
 * @param {string} sessionId
 * @returns {{ found: boolean, cwd: string | undefined }}
 */
export function persistedSessionCwd(home, sessionId) {
  if (typeof home !== 'string' || home.length === 0 || typeof sessionId !== 'string' || sessionId.length === 0) return { found: false, cwd: undefined }
  let slugs
  try { slugs = readdirSync(join(home, 'sessions')) } catch { return { found: false, cwd: undefined } }
  for (const slug of slugs) {
    const dir = join(home, 'sessions', slug, sessionId)
    const zstdPath = join(dir, 'session.v4.jsonl.zstd')
    const plainPath = join(dir, 'session.v4.jsonl')
    try {
      let firstLine = null
      if (existsSync(zstdPath)) {
        // Node's zstdDecompressSync decodes exactly the first frame of the
        // append-only multi-frame log — enough for the header record.
        const frame = zlib.zstdDecompressSync(readFileSync(zstdPath)).toString('utf8')
        firstLine = frame.split('\n', 1)[0]
      } else if (existsSync(plainPath)) {
        firstLine = readFileSync(plainPath, 'utf8').split('\n', 1)[0]
      } else {
        continue
      }
      const header = JSON.parse(firstLine)
      if (header?.type !== 'session') return { found: false, cwd: undefined }
      const cwd = typeof header.cwd === 'string' && header.cwd.length ? header.cwd : undefined
      return { found: true, cwd }
    } catch { return { found: false, cwd: undefined } }
  }
  return { found: false, cwd: undefined }
}

export const name = 'weir-skill-selection'
export const inject = ['skills']
export const apply = createSkillSelectionPlugin()
