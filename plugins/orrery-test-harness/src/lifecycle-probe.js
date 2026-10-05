// Lifecycle-inheritance integration probe for the `lifecycle-inheritance`
// scenario (session-capability-manager task 6.6): mounts the real
// skill-selection plugin against fixture-only roots — its 6.1/6.2 lifecycle
// listener is the capture under test — and drives the group-6 surfaces
// in-process: seed an accepted selection through the real apply engine,
// read back per-session inherited captures, corrupt the caller's own record
// for the root fail-closed case, and (sabotage variant) register a YIELDING
// agent/created listener whose promise return bails the serial dispatch
// (G4b sleep100 counter-example: the capture row after it never runs, so the
// child is created snapshot-less and fails closed).
// The full report lands in <ws>/lifecycle-report.json (the traced tool
// result is truncated at 300 chars, so the file is the assertion surface).
// Enabled only when ORRERY_IT_LIFECYCLE=1. Dev-only.
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openCapabilityStore } from '../../orrery-harness/src/capabilities/store/store.js'
import * as selectionPlugin from '../../orrery-harness/src/capabilities/skill-selection-plugin.js'
import { createApplyEngine } from '../../orrery-harness/src/capabilities/apply-engine.js'
import { createSelectionDraft } from '../../orrery-harness/src/capabilities/selection-draft.js'
import { decodeRecord } from '../../orrery-harness/src/capabilities/store/record.js'
import { IT_ROOT } from './mock-kit.js'

const FIXTURES = ['fixture-a', 'fixture-b', 'unselected-skill']

const namesOf = skills => (Array.isArray(skills) ? skills : []).map(identity => identity?.name ?? null)

function apply(ctx, config = {}) {
  if (config.enabled !== true) return
  if (process.env.ORRERY_IT_LIFECYCLE_SABOTAGE === '1') {
    // Counter-example (G4b sleep100 shape): an async listener YIELDS the
    // event loop and its promise return value bails the serial agent/created
    // dispatch (cordis bail-on-value) — every row after it, including the
    // lifecycle capture, never runs for that agent.
    ctx.on('agent/created', () => new Promise(resolve => setTimeout(resolve, 100)))
  }
  // The static orrery-skill-selection row is disabled for this scenario; the
  // probe mounts the real plugin against the fixture roots so inventory,
  // the provider and the lifecycle listener are the production code paths.
  selectionPlugin.apply(ctx, {
    machineId: 'orrery-it-machine',
    includeDefaultRoots: false,
    customSkillDirs: [join(IT_ROOT, 'ws', 'skill-roots')],
  })
  /** The latest recapture outcome, merged into the next report op. */
  let lastRecapture = null
  ctx.tools.register({
    name: 'lifecycle_probe',
    description: 'Integration probe: drive the group-6 lifecycle surfaces (accepted-selection seeding, inherited capture readback, root fail-closed, report).',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['apply', 'catalog', 'report', 'corruptSelf', 'repairSelf', 'recapture'] },
        skills: { type: 'array', items: { type: 'string' } },
      },
      required: ['op'],
    },
    output: {
      schema: { type: 'object' },
      render: (args, value) => [{ type: 'text', text: `LIFECYCLE_PROBE ${value.completed ? `done ${value.op}${value.op === 'apply' ? `:[${(args?.skills ?? []).join('+')}]` : ''}` : `error:${String(value.error ?? 'unknown').slice(0, 240)}`}` }],
    },
    async execute(args, exec) {
      const report = { completed: false, op: args?.op ?? null }
      try {
        const root = join(IT_ROOT, 'ws', 'skill-roots')
        for (const skill of FIXTURES) {
          mkdirSync(join(root, skill), { recursive: true })
          writeFileSync(join(root, skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: Lifecycle fixture ${skill}\n---\nCONTENT_${skill}\n`)
        }
        const sessionId = exec.agent?.session?.id
        const cwd = exec.agent?.session?.header?.cwd ?? join(IT_ROOT, 'ws')
        if (typeof sessionId !== 'string') throw new Error('probe session unavailable')
        const lookup = { cwd, scope: { session: { id: sessionId } } }
        const store = openCapabilityStore({ profileContext: ctx.get('profileContext') })
        const selection = selectionPlugin.skillSelectionFor(ctx)
        if (!selection) throw new Error('skill selection plugin not mounted')
        const inventory = await selection.inventory(lookup)
        const identities = new Map(inventory.candidates
          .filter(candidate => FIXTURES.includes(candidate.name) && candidate.status === 'parsed')
          .map(candidate => [candidate.name, candidate.identity]))

        if (args.op === 'apply') {
          const engine = createApplyEngine({
            store,
            locateSession: async session => session,
            inventory: options => selection.inventory(options),
            provider: selection.provider,
          })
          const current = await store.read({ kind: 'selection', sessionId })
          const applied = current.kind === 'ok' ? (current.payload?.skills ?? []) : []
          const draft = createSelectionDraft({ baseRevision: current.kind === 'ok' ? current.revision : 0, applied: { skills: applied, mcpServers: [] } })
          const wanted = new Set(Array.isArray(args.skills) ? args.skills : [])
          for (const [name, identity] of identities) {
            if (name !== 'unselected-skill') draft.toggle(identity, wanted.has(name))
          }
          const outcome = await engine.apply({ sessionId, cwd }, { requestId: `lifecycle-${sessionId}-${Date.now()}`, ...draft.toApplyPayload() })
          if (outcome.status === 'applied') {
            // Mirror the production publishSnapshot hook (6.1): the mounted
            // lifecycle memory must see the acceptance, or a later recapture
            // intersects against a stale parent revision.
            selection.lifecycle.publish(sessionId, { revision: outcome.revision, skills: structuredClone(draft.toApplyPayload().selection.skills), mcpServers: [] })
          }
          report.apply = { status: outcome.status, revision: outcome.revision ?? null }
          if (outcome.status !== 'applied') throw new Error(`engine apply rejected: ${outcome.status} ${outcome.reason ?? ''} ${JSON.stringify(outcome.conflicts ?? outcome.missing ?? '')}`) 
          report.completed = true
          return report
        }
        if (args.op === 'catalog') {
          // Force a fresh collect (registry + provider caches drop a record
          // corrupted after their first read only when invalidated).
          selection.provider.sourceChanged()
          await Promise.resolve()
          selection.provider.sourceChanged()
          report.catalog = (await ctx.skills.list(lookup)).map(skill => skill.name).filter(name => FIXTURES.includes(name))
          report.statusReason = selection.provider.status(lookup).reason ?? selection.provider.status(lookup).note?.reason ?? null
          mkdirSync(join(IT_ROOT, 'ws'), { recursive: true })
          writeFileSync(join(IT_ROOT, 'ws', 'lifecycle-catalog.json'), JSON.stringify({ catalog: report.catalog, statusReason: report.statusReason }) + '\n')
          report.completed = true
          return report
        }
        if (args.op === 'repairSelf') {
          // Manual repair of a corrupt record (the 6.4 documented recovery
          // path: the store fails closed and never overwrites, so the record
          // is removed by hand before the next Apply).
          try {
            rmSync(join(/** @type {string} */ (store.support.root), 'sessions', sessionId, 'selection.json'), { force: true })
            report.completed = true
          } catch (cause) {
            report.error = cause instanceof Error ? cause.message : String(cause)
          }
          return report
        }
        if (args.op === 'corruptSelf') {
          const located = store.support
          mkdirSync(join(/** @type {string} */ (located.root), 'sessions', sessionId), { recursive: true })
          writeFileSync(join(/** @type {string} */ (located.root), 'sessions', sessionId, 'selection.json'), '{')
          report.completed = true
          return report
        }
        if (args.op === 'recapture') {
          // In-process explicit recapture through the production code path
          // (the same captureInherited the agent/created listener invokes at
          // an explicit resume): the newest inherited child is recaptured
          // after the parent narrowed — child-previous ∩ current-parent.
          const rootDir = join(/** @type {string} */ (store.support.root), 'sessions')
          let newest = null
          for (const id of readdirSync(rootDir)) {
            try {
              const decoded = decodeRecord(readFileSync(join(rootDir, id, 'inherited.json'), 'utf8'))
              if (decoded.kind === 'ok' && (decoded.payload?.capturedAt ?? 0) >= (newest?.at ?? -1)) {
                newest = { id, at: decoded.payload?.capturedAt ?? 0 }
              }
            } catch { /* not a captured child */ }
          }
          if (!newest) throw new Error('no captured child to recapture')
          const snapshot = selection.lifecycle.captureInherited(newest.id, sessionId)
          lastRecapture = { child: newest.id, revision: snapshot.revision, skillNames: snapshot.skills.map(identity => identity?.name ?? null) }
          report.recapture = lastRecapture
          report.completed = true
          return report
        }
        if (args.op === 'report') {
          const rootDir = join(/** @type {string} */ (store.support.root), 'sessions')
          const sessions = {}
          for (const id of readdirSync(rootDir).sort()) {
            const entry = {}
            for (const unit of ['selection', 'inherited']) {
              try {
                const decoded = decodeRecord(readFileSync(join(rootDir, id, `${unit}.json`), 'utf8'))
                if (decoded.kind === 'ok') {
                  entry[unit] = {
                    revision: decoded.revision,
                    skillNames: namesOf(decoded.payload?.skills),
                    origin: decoded.payload?.origin ?? null,
                    parent: decoded.payload?.parent ?? null,
                    capturedAt: decoded.payload?.capturedAt ?? null,
                  }
                } else {
                  entry[unit] = { kind: decoded.kind }
                }
              } catch { /* unit absent for this session */ }
            }
            if (Object.keys(entry).length) sessions[id] = entry
          }
          report.caller = sessionId
          report.sessions = sessions
          // A corruption written by corruptSelf only surfaces after a fresh
          // collect — force one so the caller status/catalog reflect it.
          const status = selection.provider.status(lookup)
          report.recapture = lastRecapture
          report.callerStatus = { reason: status.reason ?? status.note?.reason ?? null, error: status.error ?? null }
          report.callerCatalog = (await ctx.skills.list(lookup)).map(skill => skill.name).filter(name => FIXTURES.includes(name))
          mkdirSync(join(IT_ROOT, 'ws'), { recursive: true })
          const file = process.env.ORRERY_IT_LIFECYCLE_SABOTAGE === '1' ? 'lifecycle-report-sabotage.json' : 'lifecycle-report.json'
          writeFileSync(join(IT_ROOT, 'ws', file), JSON.stringify(report, null, 2) + '\n')
          report.completed = true
          return report
        }
        throw new Error(`unknown op: ${String(args.op)}`)
      } catch (cause) {
        report.error = cause instanceof Error ? cause.message : String(cause)
        return report
      }
    },
  })
}

export const name = 'orrery-it-lifecycle-probe'
export const inject = ['tools', 'skills']
export { apply }
