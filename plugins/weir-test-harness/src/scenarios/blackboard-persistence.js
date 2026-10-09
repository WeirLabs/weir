import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { textChunks } from '../mock-kit.js'
import { parseJsonlLines } from '../jsonl.js'
const id = 'blackboard-persistence'
const prompt = 'blackboard-persistence-probe'
async function run(ctx) {
  const trace = join(ctx.IT_ROOT, `trace-${id}.jsonl`)
  const trace2 = join(ctx.IT_ROOT, `trace-${id}-phase2.jsonl`)
  const phase1 = await ctx.spawnHeadless(['weir-it', '--json', prompt], ctx.scenarioEnv(id, trace))
  const sessionId = parseJsonlLines(phase1.stdout).find(row => row.type === 'session')?.sessionId
  const phase2 = sessionId ? await ctx.spawnHeadless(['weir-it', '--session-id', sessionId, prompt], ctx.scenarioEnv(id, trace2)) : null
  const ownerTrace = join(ctx.IT_ROOT, 'trace-blackboard-orphan-owner.jsonl')
  const observerTrace = join(ctx.IT_ROOT, 'trace-blackboard-orphan-observer.jsonl')
  const owner = ctx.spawnHeadless(['weir-it', prompt], ctx.scenarioEnv(id, ownerTrace, { WEIR_IT_BB_MODE: 'owner' }))
  const ready = join(ctx.IT_ROOT, 'ws', 'blackboard-orphan-ready.json')
  const deadline = Date.now() + 60_000
  while (!existsSync(ready) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 50))
  let observer
  if (existsSync(ready)) observer = await ctx.spawnHeadless(['weir-it', prompt], ctx.scenarioEnv(id, observerTrace, { WEIR_IT_BB_MODE: 'observer' }))
  const ownerResult = await owner
  return { scenario: id, trace, trace2, sessionId, phase1, phase2, ownerResult, observer, ...(phase2 ?? phase1) }
}
function assert(run) {
  const first = run.records.find(row => row.kind === 'blackboard-flush')
  const second = run.records2.find(row => row.kind === 'blackboard-flush')
  run.check('fresh flush participates and materializes canonical log', first?.participated === true && first?.matches?.length === 1, JSON.stringify(first ?? run.records))
  run.check('durable header matches live id and cwd', first?.matches?.[0]?.header?.id === first?.id && first?.matches?.[0]?.header?.cwd === first?.header?.cwd && Boolean(first), JSON.stringify(first))
  run.check('same-ID cold read accepts sidecar neighbor', run.code === 0 && second?.id === first?.id && Boolean(second), JSON.stringify(second ?? run.stderr))
  run.check('cold listing accepts sidecar neighbor', run.records2.some(row => row.kind === 'blackboard-listing' && row.present === true), '')
  const reportFile = join(run.ws, 'blackboard-orphan-observed.json')
  const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : null
  const ownerFile = join(run.ws, 'blackboard-orphan-owner.json')
  const owner = existsSync(ownerFile) ? JSON.parse(readFileSync(ownerFile, 'utf8')) : null
  run.check('orphan observer is concurrent with a live root owner', report?.ownerProcessAlive === true && report?.owner?.live === true && owner?.liveAfterObservation === true, JSON.stringify({ report, owner }))
  run.check('two public stat reads and listing cannot see logless live root', report?.firstAbsent === true && report?.secondAbsent === true && report?.listed === false && report?.localSessionAbsent === true, JSON.stringify(report))
  run.check('public write-open cannot distinguish live orphan from missing session', report?.writeOpen === 'SessionPersistenceNotFoundError', JSON.stringify(report))
  run.check('probe never changes session.lock', owner?.lockUnchanged === true, JSON.stringify(owner))
}
export default { id, prompt, observe: obs => ({ probeOk: obs.transcript.includes(prompt) }), decide: () => textChunks('blackboard persistence contract probe done'), run, assert }
