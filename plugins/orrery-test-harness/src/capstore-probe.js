// Capability-store realm probe for the `capstore` scenario (session-capability-
// manager task 2.1): registers `capstore_probe_<label>`, which reads the host
// `profileContext` from the realm this row is mounted in, resolves the store
// root from it and round-trips one selection record through the real store.
// The full report lands in <ws>/capstore-<label>.json (the traced tool result
// is truncated at 300 chars, so the file is the assertion surface); the tool
// result text is only the short marker the mock LLM advances on.
// Mounted once at host level and once inside the isolated editing realm; both
// rows stay disabled unless ORRERY_IT_CAPSTORE=1. Dev-only.
import { mkdirSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { openCapabilityStore } from '../../orrery-harness/src/capabilities/store/store.js'
import { resolveStoreRoot, unitLayout } from '../../orrery-harness/src/capabilities/store/paths.js'
import { IT_ROOT } from './mock-kit.js'

const name = 'orrery-it-capstore-probe'
const inject = ['tools']

/** @param {any} ctx @param {{ label?: string, enabled?: boolean }} config */
function apply(ctx, config = {}) {
  if (config.enabled !== true) return
  const label = config.label ?? 'host'
  ctx.tools.register({
    name: `capstore_probe_${label}`,
    description: 'Integration probe: report the profile context visible to this realm and round-trip one capability store record.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: `CAPSTORE_PROBE ${value.label} ${value.commit ?? 'unavailable'}` }],
    },
    async execute(_args, exec) {
      const profileContext = ctx.get('profileContext')
      const located = resolveStoreRoot(profileContext)
      const sessionId = exec.agent?.session?.id ?? null
      const report = {
        label,
        present: profileContext !== undefined,
        name: profileContext?.name ?? null,
        home: profileContext?.home ?? null,
        located,
        sessionId,
      }
      if (located.supported && typeof sessionId === 'string') {
        const store = openCapabilityStore({ profileContext })
        const unit = { kind: 'selection', sessionId }
        const before = await store.read(unit)
        const committed = await store.commit(unit, before.kind === 'ok' ? before.revision : 0, previous => ({ probes: [...(previous?.probes ?? []), label] }))
        const after = await store.read(unit)
        const layout = unitLayout(unit)
        const recordPath = join(/** @type {string} */ (located.root), ...layout.segments, `${layout.name}.json`)
        let dirFiles = null
        try {
          dirFiles = readdirSync(dirname(recordPath))
        } catch {
          // reported as null; the scenario asserts on it
        }
        Object.assign(report, {
          commit: committed.status,
          read: after.kind === 'ok' ? { kind: after.kind, revision: after.revision, payload: after.payload } : { kind: after.kind },
          recordPath,
          dirFiles,
        })
      }
      try {
        const ws = join(IT_ROOT, 'ws')
        mkdirSync(ws, { recursive: true })
        writeFileSync(join(ws, `capstore-${label}.json`), JSON.stringify(report, null, 2) + '\n')
      } catch {
        // the tool result still carries the marker; the scenario reports the missing file
      }
      return report
    },
  })
}

export { name, inject, apply }
