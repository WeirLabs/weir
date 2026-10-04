// Scenario: capstore — the capability store resolves its root from the host
// `profileContext` both at host level and inside an isolated cordis:group
// (the realm shape Orrery's preset rows run in), and round-trips one
// selection record through the real store under the run's DSH_HOME. The probe
// writes its full report to <ws>/capstore-<label>.json because the traced
// tool result is truncated; assert reads those files (replay-safe: the
// fixture records them).
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, lastOfRole, textChunks, toolCallChunks } from '../mock-kit.js'

const id = 'capstore'
const prompt = 'capstore-probe'
const HOME = join(IT_ROOT, 'home')

function decide(options) {
  // Runtime-context injections can follow a tool result. Advance from the
  // last tool result rather than repeating a commit based on the final role.
  const toolText = lastOfRole(options, 'tool')
  if (!toolText) return toolCallChunks('capstore_probe_host', {})
  if (toolText.includes('CAPSTORE_PROBE host')) return toolCallChunks('capstore_probe_realm', {})
  return textChunks('capstore done')
}

function observe(obs) {
  return { capstoreToolsSeen: ['capstore_probe_host', 'capstore_probe_realm'].every((name) => obs.toolNames.includes(name)) }
}

/** @param {string} ws @param {string} label */
function reportOf(ws, label) {
  const file = join(ws, `capstore-${label}.json`)
  if (!existsSync(file)) return null
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function assert(run) {
  run.check('both probe tools advertised', run.requests.some((r) => r.capstoreToolsSeen))
  const host = reportOf(run.ws, 'host')
  const realm = reportOf(run.ws, 'realm')
  for (const [label, report] of [['host', host], ['realm', realm]]) {
    run.check(`${label}: profileContext visible`, report?.present === true && report.name === 'orrery-it' && report.home === HOME, JSON.stringify(report))
    run.check(
      `${label}: store root resolved under DSH_HOME`,
      report?.located?.supported === true && report.located.root === join(HOME, 'orrery', 'profiles', 'orrery-it', 'capabilities'),
      JSON.stringify(report?.located),
    )
    run.check(`${label}: selection record committed and read back`, report?.commit === 'committed' && report.read?.kind === 'ok', JSON.stringify(report && { commit: report.commit, read: report.read }))
    run.check(
      `${label}: record file observed on disk`,
      typeof report?.sessionId === 'string' &&
        report.recordPath === join(report.located?.root ?? '', 'sessions', report.sessionId, 'selection.json') &&
        (report.dirFiles ?? []).includes('selection.json'),
      JSON.stringify(report && { recordPath: report.recordPath, dirFiles: report.dirFiles }),
    )
  }
  run.check('realm commit saw the host record (one shared store)', JSON.stringify(realm?.read?.payload?.probes) === JSON.stringify(['host', 'realm']), JSON.stringify(realm?.read))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code}`)
}

export default { id, prompt, env: { ORRERY_IT_CAPSTORE: '1' }, decide, observe, assert }
