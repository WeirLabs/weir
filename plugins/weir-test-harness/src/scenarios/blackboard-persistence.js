import { existsSync, readFileSync, writeFileSync, appendFileSync, lstatSync, readlinkSync, unlinkSync, symlinkSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { textChunks, toolCallChunks, lastOfRole } from '../mock-kit.js'
import { parseJsonlLines, readJsonl } from '../jsonl.js'
const id = 'blackboard-persistence'
const prompt = 'blackboard-persistence-probe'
async function run(ctx) {
  const trace = join(ctx.IT_ROOT, `trace-${id}.jsonl`)
  const trace2 = join(ctx.IT_ROOT, `trace-${id}-phase2.jsonl`)
  const phase1 = await ctx.spawnHeadless(['weir-it', '--json', prompt], ctx.scenarioEnv(id, trace, { WEIR_IT_BLACKBOARD: '1', WEIR_IT_BB_PHASE: 'seed' }))
  const sessionId = parseJsonlLines(phase1.stdout).find(row => row.type === 'session')?.sessionId
  const first = readJsonl(trace).find(row => row.kind === 'blackboard-flush')
  const side = first?.matches?.[0] ? join(first.matches[0].dir, first.matches[0].file + '_bb') : null
  const before = side && existsSync(side) ? readFileSync(side) : null
  const profile = join(ctx.IT_ROOT, 'home', 'profiles', 'weir-it')
  const manifest = join(profile, 'package.json')
  const original = readFileSync(manifest, 'utf8')
  const stripped = JSON.parse(original)
  stripped.dependencies = {}
  stripped.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless']
  const links = []
  let absent
  try {
    for (const name of ['weir-harness', 'weir-test-harness']) {
      const path = join(profile, 'node_modules', name)
      if (resolve(path) !== path || !lstatSync(path).isSymbolicLink()) throw new Error('Unsafe isolated uninstall link')
      links.push([path, readlinkSync(path)])
      unlinkSync(path)
    }
    writeFileSync(manifest, JSON.stringify(stripped))
    absent = await ctx.spawnHeadless(['weir-it', '--dump-config'], ctx.scenarioEnv(id, join(ctx.IT_ROOT, 'trace-blackboard-uninstalled.jsonl')))
  } finally {
    writeFileSync(manifest, original)
    for (const [path, target] of links) symlinkSync(target, path, 'junction')
  }
  const preserved = before !== null && readFileSync(side).equals(before)
  const phase2 = sessionId ? await ctx.spawnHeadless(['weir-it', '--session-id', sessionId, 'blackboard-persistence-cold'], ctx.scenarioEnv(id, trace2, { WEIR_IT_BLACKBOARD: '1', WEIR_IT_BB_PHASE: 'cold' })) : null
  appendFileSync(trace2, JSON.stringify({ kind: 'blackboard-install-cycle', preserved, code: absent?.code }) + '\n')
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
  const seed = run.records.find(row => row.kind === 'blackboard-cold-check')
  const cold = run.records2.find(row => row.kind === 'blackboard-cold-check')
  const knowledge = cold?.restored?.entries?.find(row => row.key === 'knowledge')
  const editable = cold?.restored?.entries?.find(row => row.key === 'editable')
  run.check('product creates empty board before first tool access', run.records.some(row => row.kind === 'blackboard-before-access' && row.entries?.length === 0), '')
  run.check('unmaterialized host Sessions have no sidecar', seed?.unmaterializedNoSidecar === true && cold?.unmaterializedNoSidecar === true, JSON.stringify({ seed, cold }))
  run.check('cold tool and remote recover body, counts and promotion', knowledge?.content === 'durable body' && knowledge?.readCount === 2 && knowledge?.promoted?.destination === 'runtime-map' && editable?.subscribeCount === 1 && cold?.oldTokenRefused === true && cold?.promotedRefused === true, JSON.stringify(cold))
  run.check('archive and unarchive preserve durable bytes', cold?.archivePreserved === true, JSON.stringify(cold))
  run.check('cold authority and subscriptions are empty', cold?.tokensEmpty === true && cold?.subscriptionsEmpty === true, JSON.stringify(cold))
  run.check('cold panel audit reads and remove retain protocol', cold?.auditDoesNotCount === true && cold?.panelRemove === true, JSON.stringify(cold))
  run.check('two-level cold Session ancestry shares only root sidecar', cold?.nestedRoot === true && cold?.noChildSidecars === true, JSON.stringify(cold))
  run.check('isolated uninstall/reinstall preserves sidecar bytes', run.records2.some(row => row.kind === 'blackboard-install-cycle' && row.preserved === true && row.code === 0), JSON.stringify(run.records2.filter(row => row.kind === 'blackboard-install-cycle')))
  const reportFile = join(run.ws, 'blackboard-orphan-observed.json')
  const report = existsSync(reportFile) ? JSON.parse(readFileSync(reportFile, 'utf8')) : null
  const ownerFile = join(run.ws, 'blackboard-orphan-owner.json')
  const owner = existsSync(ownerFile) ? JSON.parse(readFileSync(ownerFile, 'utf8')) : null
  run.check('orphan observer is concurrent with a live root owner', report?.ownerProcessAlive === true && report?.owner?.live === true && owner?.liveAfterObservation === true, JSON.stringify({ report, owner }))
  run.check('two public stat reads and listing cannot see logless live root', report?.firstAbsent === true && report?.secondAbsent === true && report?.listed === false && report?.localSessionAbsent === true, JSON.stringify(report))
  run.check('public write-open cannot distinguish live orphan from missing session', report?.writeOpen === 'SessionPersistenceNotFoundError', JSON.stringify(report))
  run.check('product rejects logless access and preserves live-orphan bytes', report?.productRefused === true && report?.sidecarPreserved === true, JSON.stringify(report))
  run.check('probe never changes session.lock', owner?.lockUnchanged === true, JSON.stringify(owner))
}
function decide(_options, obs) {
  const phase = process.env.WEIR_IT_BB_PHASE
  if (!phase || !obs.toolNames.includes('blackboard_write')) return textChunks('blackboard persistence contract probe ready')
  if (/^Error[: ]/.test(lastOfRole(_options, 'tool'))) return textChunks('blackboard persistence acceptance failed')
  const history = obs.transcript
  if (phase === 'cold') {
    const tail = history.slice(history.lastIndexOf('blackboard-persistence-cold'))
    if (tail.includes('BLACKBOARD_COLD_CHECK')) return textChunks('blackboard cold recovery verified')
    if (tail.includes('Content:\ndurable body')) return toolCallChunks('blackboard_persistence_check', {})
    return toolCallChunks('blackboard_read', { keys: ['knowledge'] })
  }
  if (history.includes('BLACKBOARD_COLD_CHECK')) return textChunks('blackboard seed persisted')
  if (history.includes('Marked entry "knowledge"')) return toolCallChunks('blackboard_persistence_check', {})
  if (history.includes('Content:\ndurable body')) return toolCallChunks('blackboard_mark_promoted', { key: 'knowledge', destination: 'runtime-map' })
  if (history.includes('Created entry "editable"')) return toolCallChunks('blackboard_read', { keys: ['knowledge', 'editable'] })
  const key = history.includes('Created entry "knowledge"') ? 'editable' : 'knowledge'
  return toolCallChunks('blackboard_write', { key, entryType: 'map', summary: 'round-trip summary', content: 'durable body' })
}
export default { id, prompt, observe: obs => ({ probeOk: obs.transcript.includes(prompt) }), decide, run, assert }
