// Scenario: capability-remote — silent-capability-reads task 2.4. Drives the
// capability read remote (direct-call mirror of the host-layer typert
// service) for a live session and proves the read channel is session-log
// silent: (a) receipt / list / conditions over the remote, (b) ZERO new
// command/run + command/done events from those reads — asserted both in-band
// (probe counters) and against the durable decoded session log afterwards,
// (c) payload parity with the deliberate `/capabilities receipt` command.
// (d) the `registration` op proves the production lifecycle instead of a
// direct mirror: the SHIPPED host row against the real Typert registry and the
// real typertGateway service, before/after a real Cordis fiber restart and
// after a withdrawal with no survivor (S27.5 gateway/definition-unavailable).
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import zlib from 'node:zlib'
import { textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'capability-remote'
const prompt = 'capability-remote-probe'

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  if (!history.includes('done reads')) return toolCallChunks('capability_remote_probe', { op: 'reads', _marker: 'reads' })
  if (!history.includes('done presetReads')) return toolCallChunks('capability_remote_probe', { op: 'presetReads', _marker: 'presetReads' })
  if (!history.includes('done unknown')) return toolCallChunks('capability_remote_probe', { op: 'unknownSession', _marker: 'unknown' })
  if (!history.includes('done counts-pre')) return toolCallChunks('capability_remote_probe', { op: 'logCounts', _marker: 'counts-pre' })
  if (!history.includes('done parity')) return toolCallChunks('capability_remote_probe', { op: 'parity', _marker: 'parity' })
  if (!history.includes('done counts-post')) return toolCallChunks('capability_remote_probe', { op: 'logCounts', _marker: 'counts-post' })
  if (!history.includes('done registration')) return toolCallChunks('capability_remote_probe', { op: 'registration', _marker: 'registration' })
  return textChunks('capability remote done')
}

function observe(obs) {
  const history = obs?.transcript ?? ''
  return {
    readsOk: /done reads:.*"receipt":\{"status":"applied"/.test(history)
      && /done reads:.*"listing":\{"skills":\d+,"selected":\d+,"mcpServers":\d+\}/.test(history)
      && /done reads:.*"conditions":\{"conditions":\[\]\}/.test(history)
      && /done reads:.*"owner":\{"headerPreset":"weir","projectedPreset":"weir"\}/.test(history),
    presetReadsOk: /done presetReads:.*"presetsIsList":true/.test(history)
      && /done presetReads:.*"defaultStatus":"[a-z-]+"/.test(history),
    presetParityOk: /done parity:.*"presetsEqual":true/.test(history)
      && /done parity:.*"defaultEqual":true/.test(history),
    unknownOk: /done unknown:.*"code":"unknown-session"/.test(history),
    preZero: /done counts-pre:.*"counts":\{"run":0,"done":0\}/.test(history),
    parityOk: /done parity:.*"commandKind":"success","equal":true/.test(history),
    postThree: /done counts-post:.*"counts":\{"run":3,"done":3\}/.test(history),
  }
}

/** Every session.v4.jsonl.zstd under root, recursively (multi-frame append-only logs). */
function sessionLogs(root) {
  const found = []
  const walk = dir => {
    let entries
    try { entries = readdirSync(dir) } catch { return }
    for (const entry of entries) {
      const path = join(dir, entry)
      let stat
      try { stat = statSync(path) } catch { continue }
      if (stat.isDirectory()) walk(path)
      else if (entry === 'session.v4.jsonl.zstd') found.push(path)
    }
  }
  walk(root)
  return found
}

/** Multi-frame zstd decode — the same frame-scan approach as scripts/dump-session.mjs. */
function decodeLog(file) {
  const buf = readFileSync(file)
  const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  for (let i = 0; i + 4 <= buf.length; i++) {
    if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offsets.push(i)
  }
  const parts = []
  for (const off of offsets) {
    try { parts.push(zlib.zstdDecompressSync(buf.subarray(off)).toString('utf8')) } catch { /* trailing partial frame */ }
  }
  return { frames: offsets.length, decoded: parts.length, text: parts.join('') }
}

/** The durable command lifecycle events of the given session logs. */
function commandEventReport(home, exclude = new Set()) {
  // Only logs created by THIS scenario's boot count: the suite shares one IT
  // home across scenarios, and other sessions legitimately hold their own
  // command lifecycle events.
  const logs = sessionLogs(join(home, 'sessions')).filter(file => !exclude.has(file))
  const events = []
  let frames = 0
  let decoded = 0
  for (const file of logs) {
    const log = decodeLog(file)
    frames += log.frames
    decoded += log.decoded
    for (const line of log.text.split('\n')) {
      if (!line.trim()) continue
      let event
      try { event = JSON.parse(line) } catch { continue }
      if (event?.type !== 'command/run' && event?.type !== 'command/done') continue
      events.push({
        type: event.type,
        name: event.data?.name ?? null,
        args: event.data?.args ?? null,
        kind: event.data?.kind ?? null,
      })
    }
  }
  return { logs: logs.length, frames, decoded, events }
}

async function run(ctx) {
  const before = new Set(sessionLogs(join(ctx.IT_ROOT, 'home', 'sessions')))
  const trace = join(ctx.IT_ROOT, `trace-${id}.jsonl`)
  const boot = await ctx.spawnHeadless(['weir-it', prompt], ctx.scenarioEnv(id, trace, {
    WEIR_IT_CAPABILITY_REMOTE: '1',
    DSH_AGENTS_HOME: join(ctx.IT_ROOT, 'agents-home'),
  }))
  // The authoritative silence evidence: decode the durable session log AFTER
  // the boot and count command lifecycle events.
  const report = commandEventReport(join(ctx.IT_ROOT, 'home'), before)
  writeFileSync(join(ctx.IT_ROOT, 'ws', 'capability-remote-log.json'), JSON.stringify(report, null, 2) + '\n')
  return { scenario: id, trace, code: boot.code, stdout: boot.stdout, stderr: boot.stderr }
}

function assert(run) {
  const any = flag => run.requests.some(request => request[flag])
  run.check('the flow completed', run.stdout.includes('capability remote done'), run.stdout.slice(-300))
  run.check('remote receipt/list/conditions returned the expected shapes', any('readsOk'), '')
  run.check('remote presets/default-get reads returned the expected shapes', any('presetReadsOk'), '')
  run.check('remote presets/default-get are byte-identical to the deliberate commands', any('presetParityOk'), '')
  run.check('an unknown session is the explicit typed error', any('unknownOk'), '')
  run.check('zero command lifecycle events before the deliberate parity command', any('preZero'), '')
  run.check('remote receipt is byte-identical to /capabilities receipt', any('parityOk'), '')
  run.check('exactly the deliberate parity commands recorded in-band', any('postThree'), '')

  // (d) The real lifecycle proof: shipped row + real registry + real gateway.
  // The gate reads the recorded trace: a run whose transcript shows the op
  // result MUST have written the report (a live failure surfaces here, and a
  // flow that never requested the op already fails the completion check above).
  // The committed replay fixture predates the op, so replay adds no checks and
  // can never fake a pass.
  const registrationServed = run.requests.some(request => String(request.lastTool ?? '').includes('CAPABILITY_PROBE done registration'))
  let registration = null
  if (registrationServed) {
    try { registration = JSON.parse(readFileSync(join(run.ws, 'capability-remote-registration.json'), 'utf8')) } catch { /* reported below */ }
    run.check('the registration lifecycle report was written', registration !== null, 'capability-remote-registration.json')
  }
  if (registration !== null) {
    run.check('the shipped row fiber was found and its real gateway service is callable', registration?.rowFiber?.found === true && registration?.gateway?.dispatch === true, JSON.stringify({ rowFiber: registration?.rowFiber, gateway: registration?.gateway }).slice(0, 300))
    run.check('all five read AND both mutation endpoints are registered before any remount', registration?.endpoints?.before === '1111111' && registration?.package?.before === true, JSON.stringify({ endpoints: registration?.endpoints, package: registration?.package }).slice(0, 300))
    run.check('a real gateway read and mutation reach the bridge spy faces', registration?.dispatch?.readBefore?.ok === true && registration?.dispatch?.mutationBefore?.ok === true && registration?.dispatch?.mutationBefore?.value?.status === 'preview' && registration?.spies?.before?.reads === 1 && registration?.spies?.before?.mutations === 1, JSON.stringify({ read: registration?.dispatch?.readBefore, mutation: registration?.dispatch?.mutationBefore, spies: registration?.spies?.before }).slice(0, 400))
    run.check('a real Cordis fiber restart leaves every endpoint and the package face live', registration?.endpoints?.afterRestart === '1111111' && registration?.package?.afterRestart === true, JSON.stringify({ endpoints: registration?.endpoints, package: registration?.package, seen: registration?.hasSeen }).slice(0, 300))
    run.check('dispatch still reaches the row after the restart instead of definition-unavailable', registration?.dispatch?.readAfterRestart?.ok === true && registration?.dispatch?.mutationAfterRestart?.ok === true && registration?.spies?.afterRestart?.reads === 2 && registration?.spies?.afterRestart?.mutations === 2, JSON.stringify({ read: registration?.dispatch?.readAfterRestart, mutation: registration?.dispatch?.mutationAfterRestart, spies: registration?.spies }).slice(0, 400))
    run.check('a withdrawal with no survivor leaves no endpoint or package face behind', registration?.endpoints?.afterDisposal === '0000000' && registration?.package?.afterDisposal === false && registration?.hasSeen?.afterDisposal === '1111111', JSON.stringify({ endpoints: registration?.endpoints?.afterDisposal, package: registration?.package?.afterDisposal, seen: registration?.hasSeen?.afterDisposal }).slice(0, 300))
    run.check('a withdrawn strict definition rejects with gateway/definition-unavailable before either spy', registration?.dispatch?.readAfterDisposal?.ok === false && registration?.dispatch?.readAfterDisposal?.code === 'gateway/definition-unavailable' && registration?.dispatch?.mutationAfterDisposal?.code === 'gateway/definition-unavailable' && JSON.stringify(registration?.spies?.afterDisposal) === JSON.stringify(registration?.spies?.afterRestart), JSON.stringify({ read: registration?.dispatch?.readAfterDisposal, mutation: registration?.dispatch?.mutationAfterDisposal, spies: registration?.spies }).slice(0, 400))
  }

  // Durable session log: the reads left no trace; exactly the one deliberate
  // parity command did (design D4).
  let report = null
  try { report = JSON.parse(readFileSync(join(run.ws, 'capability-remote-log.json'), 'utf8')) } catch { /* reported below */ }
  run.check('the session log decoded (format guard: decoded frames > 0)', report !== null && report.logs >= 1 && report.decoded > 0, JSON.stringify(report ?? 'missing').slice(0, 200))
  const events = Array.isArray(report?.events) ? report.events : []
  const runs = events.filter(event => event.type === 'command/run')
  const dones = events.filter(event => event.type === 'command/done')
  run.check('the durable log holds exactly the three deliberate command/runs', runs.length === 3 && runs.every(event => event.name === 'capabilities') && ['receipt', 'presets', 'default-get'].every(verb => runs.some(event => String(event.args ?? '').trim() === verb)), JSON.stringify(events).slice(0, 300))
  run.check('the durable log holds exactly three command/done events, all settled success', dones.length === 3 && dones.every(event => event.kind === 'success'), JSON.stringify(events).slice(0, 300))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, run, assert, env: { WEIR_IT_CAPABILITY_REMOTE: '1' } }
