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

const mounted = new WeakMap()
/** Manager/Badge access without providing a new preset service or realm. */
export const skillSelectionFor = ctx => mounted.get(ctx)

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
    let lifecycle = null
    try {
      ctx.skills.registerProvider(control => {
        const readSelection = dependencies.readSelection ?? (async options => {
          const sessionId = options.scope?.session?.id
          // Fail closed empty for the standing key — an expected cold
          // condition, not a policy failure (no error state is raised).
          if (!sessionId) return []
          const store = openCapabilityStore({ profileContext: ctx.get('profileContext') })
          const record = await store.read({ kind: 'selection', sessionId })
          if (record.kind === 'absent') return []
          if (record.kind !== 'ok') throw new Error(`Skill selection policy is ${record.kind}`)
          return record.payload?.skills
        })
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
          const snapshot = await discoverSkillInventory({ roots, machineId: config.machineId, previous })
          // First-run migration check (D-H 6): a non-equivalent builtin
          // discovery fails the enumeration closed with a visible reason.
          return assertBuiltinSkillMigration(snapshot)
        })
        const office = dependencies.office ?? createOfficeAdapter(ctx.skills, config.machineId)
        inventory = async (options, previous) => {
          const local = await filesystem(options, previous)
          const bundled = await office(options)
          return { ...local, complete: local.complete && bundled.complete, candidates: [...local.candidates, ...bundled.candidates] }
        }
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
    mounted.set(ctx, {
      provider,
      inventory,
      lifecycle,
      status: options => error
        ? { error, ...classifySelectionFailure(error), conflicts: [] }
        : provider.status(options),
      noteFailure: (options, failure) => provider?.noteFailure(options, failure),
      clearFailure: options => provider?.clearFailure(options),
    })
  }
}

export const name = 'orrery-skill-selection'
export const inject = ['skills']
export const apply = createSkillSelectionPlugin()
