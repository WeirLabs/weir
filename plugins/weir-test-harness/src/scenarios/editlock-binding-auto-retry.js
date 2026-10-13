// Scenario: editlock-binding-auto-retry — message-driven bounded self-heal of a
// duplicate-binding failure (openspec edit-lock-revoked-session-repair D5,
// task 6.3). A seed boot establishes the authority and the session. A
// long-lived child then publishes the authority and holds a LOCAL binding for
// that session: every later boot of the same session becomes a remote client
// whose binding is refused (binding-duplicate). Phase A boots the session and
// sends ONE genuine user message while the holder still serves: exactly ONE
// attestation-guarded retry runs before the turn's first step, is safely
// refused, the recorded cause survives, and the scripted write stays denied.
// The driver then arms phase B; the child forgets the holder in-band with the
// last refusal of the next creation burst, so when the phase-B boot's genuine
// message arrives, the pre-step retry binds the session as interrupted, the
// re-armed auto-resume continues in the SAME turn, the scripted write succeeds,
// and the audit carries kind 'binding-auto-retry' result 'recovered'.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, textChunks, toolCallChunks, transcript } from '../mock-kit.js'
import { parseJsonlLines, readJsonl } from '../jsonl.js'
import { textOf } from '../message-text.js'

const id = 'editlock-binding-auto-retry'
const WS = join(IT_ROOT, 'ws')
const AUTHORITY = join(WS, '.weir', 'edit-lock-binding-auto-retry')
const RESERVATION = join(WS, '.weir', '.edit-lock-binding-auto-retry.publisher-reservation')
const SEED = join(WS, 'binding-auto-retry-seed.txt')
const TARGET = join(WS, 'binding-auto-retry-target.txt')
const NODE = process.env.WEIR_IT_NODE ?? '/Users/young/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node'
const HARNESS_SRC = new URL('../../../weir-harness/src/', import.meta.url).pathname

/** The holder publisher: reserves the authority, serves the endpoint and holds
 * a LOCAL binding for the adopted session, so every remote open of that
 * session is refused as a duplicate binding. While the control file reads 'B',
 * the 21st refusal of a creation burst (the client's full answered-refusal
 * budget) forgets the holder in-band BEFORE the refusal is answered, so the
 * boot's setup still fails with binding-duplicate while the immediately
 * following message-driven retry finds the binding free. Facts go to FACTS. */
function holderScript(sessionId, factsPath, controlPath) {
  return `
    import { appendFileSync, existsSync, readFileSync } from 'node:fs'
    import { writeFile } from 'node:fs/promises'
    import { resolve as resolvePath } from 'node:path'
    import { openReservedEditLockRuntime } from ${JSON.stringify(`${HARNESS_SRC}/edit-lock/reserved-runtime.js`)}
    import { createEditLockLifecycle } from ${JSON.stringify(`${HARNESS_SRC}/edit-lock/lifecycle.js`)}
    import { serveEditLockEndpoint, endpointFor } from ${JSON.stringify(`${HARNESS_SRC}/edit-lock/remote.js`)}
    const fact = (record) => appendFileSync(${JSON.stringify(factsPath)}, JSON.stringify(record) + '\\n')
    const versions = new Map()
    // A real filesystem with the cordis-fs writeText surface: the publisher's
    // business pipeline performs the managed write here when a client's
    // publish arrives over the channel.
    const stubFs = {
      async resolve(path, { cwd }) { const resolved = resolvePath(cwd, path); return { targetKey: resolved, path: resolved } },
      async writeText(target, content, expected) {
        if (expected?.kind === 'createIfAbsent' && existsSync(target.path)) throw new Error('create target exists')
        await writeFile(target.path, content)
        const version = 'stub-' + ((versions.get(target.path) ?? 0) + 1)
        versions.set(target.path, version)
        return { version }
      },
    }
    let phase = 'A'
    let refusedA = 0, refusedB = 0, retryAttemptsA = 0, retryAttemptsB = 0, startedOk = 0
    let holderForgot = false
    const runtime = await openReservedEditLockRuntime({ root: ${JSON.stringify(WS)}, directory: ${JSON.stringify(AUTHORITY)}, domainId: ${JSON.stringify(WS)}, mode: 'recover', fs: stubFs })
    const base = createEditLockLifecycle(runtime, (agent) => agent.id, { warn: (message) => fact({ kind: 'lifecycle-warn', message: String(message) }) })
    const holder = Object.freeze({ id: ${JSON.stringify(sessionId)} })
    const lifecycle = {
      // A retry open validates assertStartable TWICE (before and after the
      // arbitration reclaim check), so each genuine retry lands two facts.
      ...base,
      assertStartable(agent) {
        if (agent?.remote === true) {
          if (phase === 'B') retryAttemptsB++; else retryAttemptsA++
          fact({ kind: 'retry-open-attempt', phase })
        }
        return base.assertStartable(agent)
      },
      async start(agent) {
        try {
          const state = await base.start(agent)
          if (agent?.remote === true) { startedOk++; fact({ kind: 'remote-start-ok', phase, state }) }
          return state
        } catch (error) {
          if (agent?.remote === true) {
            if (phase === 'B') refusedB++; else refusedA++
            fact({ kind: 'remote-start-refused', phase, refusedA, refusedB })
            if (phase === 'B' && !holderForgot && refusedB === 21) {
              holderForgot = true
              await base.forget(holder)
              fact({ kind: 'holder-forgotten', refusedInPhaseB: refusedB })
            }
          }
          throw error
        }
      },
    }
    const server = await serveEditLockEndpoint(lifecycle, endpointFor(${JSON.stringify(AUTHORITY)}), new WeakMap())
    const state = await base.start(holder)
    fact({ kind: 'ready', state })
    let closing = false
    const shutdown = async () => {
      if (closing) return
      closing = true
      clearInterval(timer)
      try { await server.close() } catch (error) { fact({ kind: 'close-error', where: 'endpoint', message: String(error?.message ?? error) }) }
      try { await base.close() } catch (error) { fact({ kind: 'close-error', where: 'lifecycle', message: String(error?.message ?? error) }) }
      try { await runtime.close() } catch (error) { fact({ kind: 'close-error', where: 'runtime', message: String(error?.message ?? error) }) }
      fact({ kind: 'closed', refusedA, refusedB, retryAttemptsA, retryAttemptsB, startedOk })
      process.exit(0)
    }
    const timer = setInterval(() => {
      try {
        const want = readFileSync(${JSON.stringify(controlPath)}, 'utf8').trim()
        if (want === 'C') { void shutdown(); return }
        if ((want === 'A' || want === 'B') && want !== phase) { phase = want; fact({ kind: 'armed', phase }) }
      } catch { /* control file not written yet */ }
    }, 100)
    setTimeout(() => { fact({ kind: 'safety-timeout' }); void shutdown() }, 300000).unref()
  `
}

function snapshotState() {
  const path = join(AUTHORITY, 'snapshot.json')
  if (!existsSync(path)) return null
  const state = JSON.parse(readFileSync(path, 'utf8'))?.payload?.state ?? null
  return state && {
    sessions: state.sessions?.map((session) => ({ sessionId: session.sessionId, interrupted: session.interrupted, epoch: session.executionEpoch })),
    locks: state.locks?.map((lock) => ({ resourceId: lock.resourceId, owner: lock.owner, status: lock.status })),
  }
}

/** Poll the holder's facts file until a predicate matches (bounded). */
async function waitForFact(factsPath, predicate, timeoutMs = 60000) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const found = readJsonl(factsPath).find(predicate)
    if (found) return found
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return null
}

/** Tool results of the CURRENT boot only (an adopted session carries the
 * earlier boots' messages too): slice after the boot's prompt marker. */
function phaseToolResults(options, marker) {
  const messages = options.messages ?? []
  const markerAt = messages.findLastIndex((message) => message.role === 'user' && textOf(message).includes(marker))
  return (markerAt === -1 ? [] : messages.slice(markerAt + 1)).filter((message) => message.role === 'tool').length
}

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  // Phase B (holder disconnected): the message-driven retry + same-turn resume
  // admit the scripted write; release ends the batch.
  if (history.includes(`${id}-heal`)) {
    const toolResults = phaseToolResults(options, `${id}-heal`)
    if (toolResults === 0) return toolCallChunks('write', { file_path: TARGET, content: 'healed\n' })
    if (toolResults === 1) return toolCallChunks('edit_lock_release', { file_path: TARGET })
    return textChunks('binding-auto-retry phase-B done')
  }
  // Phase A (holder serving): the write is denied; a status read reports the
  // unavailable binding; the turn then ends.
  if (history.includes(`${id}-refuse`)) {
    const toolResults = phaseToolResults(options, `${id}-refuse`)
    if (toolResults === 0) return toolCallChunks('write', { file_path: TARGET, content: 'denied\n' })
    if (toolResults === 1) return toolCallChunks('edit_lock_status', {})
    return textChunks('binding-auto-retry phase-A done')
  }
  // Seed boot: an ordinary write + release establishes the authority.
  if (history.includes(`${id}-seed`)) {
    const toolResults = phaseToolResults(options, `${id}-seed`)
    if (toolResults === 0) return toolCallChunks('write', { file_path: SEED, content: 'seed\n' })
    if (toolResults === 1) return toolCallChunks('edit_lock_release', { file_path: SEED })
    return textChunks('binding-auto-retry seed done')
  }
  return textChunks('unhandled binding-auto-retry turn')
}

function observe(obs) {
  return {
    editLockToolsSeen: obs.toolNames.includes('edit_lock_status'),
    // The denial guidance sentence trails the reason past the trace's 300-char
    // lastTool cut, so it is observed from the full transcript instead.
    selfHealGuidanceSeen: obs.transcript.includes('retried automatically when the user next sends a message'),
  }
}

async function run({ IT_ROOT: root, spawnHeadless, scenarioEnv }) {
  const trace = join(root, `trace-${id}.jsonl`)
  const fact = (record) => appendFileSync(trace, JSON.stringify(record) + '\n')
  const seedTrace = join(root, `trace-${id}-seed.jsonl`)
  const seed = await spawnHeadless(['weir-it', '--json', `${id}-seed`], scenarioEnv(id, seedTrace, this.env))
  const sessionId = parseJsonlLines(seed.stdout).find((entry) => entry?.type === 'session')?.sessionId ?? null
  fact({ kind: 'seed-exit', code: seed.code, sessionId, seedContent: existsSync(SEED) ? readFileSync(SEED, 'utf8') : null })
  if (!sessionId) return { scenario: id, trace, sessionId, code: seed.code, stdout: seed.stdout, stderr: seed.stderr }
  const factsPath = join(root, `holder-${id}.jsonl`)
  const controlPath = join(root, `holder-${id}.control`)
  const child = spawn(NODE, ['--input-type=module', '-e', holderScript(sessionId, factsPath, controlPath)], { stdio: ['ignore', 'pipe', 'pipe'] })
  let childStderr = ''
  child.stderr.on('data', (data) => { childStderr += data })
  const childExit = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  const ready = await waitForFact(factsPath, (row) => row.kind === 'ready')
  fact({ kind: 'holder-ready', value: ready ?? null, childStderr: childStderr.slice(-400) })
  // Phase A: the holder still serves — one genuine message, one safe refusal.
  const phaseA = await spawnHeadless(['weir-it', '--session-id', sessionId, `${id}-refuse`], scenarioEnv(id, trace, this.env))
  fact({ kind: 'phaseA-exit', code: phaseA.code, targetExists: existsSync(TARGET), targetContent: existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : null })
  // Holder disconnects: the child forgets the holder in-band with the last
  // refusal of the phase-B creation burst.
  writeFileSync(controlPath, 'B')
  const armed = await waitForFact(factsPath, (row) => row.kind === 'armed' && row.phase === 'B', 30000)
  fact({ kind: 'holder-armed-B', value: armed ?? null })
  const trace2 = join(root, `trace-${id}-heal.jsonl`)
  const phaseB = await spawnHeadless(['weir-it', '--session-id', sessionId, `${id}-heal`], scenarioEnv(id, trace2, this.env))
  fact({ kind: 'phaseB-exit', code: phaseB.code, targetContent: existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : null })
  writeFileSync(controlPath, 'C')
  const exit = await Promise.race([childExit, new Promise((resolve) => setTimeout(() => resolve(null), 15000))])
  if (exit === null) child.kill('SIGKILL')
  fact({ kind: 'holder-exit', value: exit, childStderr: childStderr.slice(-400) })
  // Replay self-containment: the assert consumes holder facts from the trace.
  for (const row of readJsonl(factsPath)) fact({ kind: 'holder-fact', row })
  fact({ kind: 'final', reservationReleased: !existsSync(RESERVATION), snapshot: snapshotState() })
  return { scenario: id, trace, trace2, sessionId, code: phaseB.code, stdout: phaseB.stdout, stderr: `${seed.stderr}\n${phaseA.stderr}\n${phaseB.stderr}\n${childStderr}` }
}

function assertRun(run) {
  const holderFacts = run.records.filter((r) => r.kind === 'holder-fact').map((r) => r.row)
  const seed = run.records.find((r) => r.kind === 'seed-exit')
  const ready = run.records.find((r) => r.kind === 'holder-ready')
  const phaseA = run.records.find((r) => r.kind === 'phaseA-exit')
  const phaseB = run.records.find((r) => r.kind === 'phaseB-exit')
  const final = run.records.find((r) => r.kind === 'final')
  run.check('the seed boot established the authority and the session', seed?.code === 0 && typeof run.sessionId === 'string' && seed.sessionId === run.sessionId && seed.seedContent === 'seed\n', JSON.stringify(seed))
  run.check('the holder publisher bound the session as interrupted and served the endpoint', ready?.value?.state === 'interrupted', JSON.stringify(ready))
  // Phase A: one genuine message, exactly one bounded retry, safely refused.
  run.check('phase A delivered a genuine user message', run.records.some((r) => r.kind === 'session-event' && r.type === 'user/message' && r.source === 'user' && r.session === run.sessionId), JSON.stringify(run.records.filter((r) => r.type === 'user/message')))
  const textA = run.requests.map((r) => `${r.lastTool ?? ''}\n${r.lastUser ?? ''}`).join('\n')
  run.check('phase A kept the write denied with the self-heal guidance, and the file never landed', phaseA?.code === 0 && phaseA.targetExists === false && textA.includes('Edit Lock unavailable: edit lock duplicate session binding') && run.requests.some((r) => r.selfHealGuidanceSeen === true), `code=${phaseA?.code} :: ${textA.slice(-600)}`)
  const retriesA = holderFacts.filter((row) => row.kind === 'retry-open-attempt' && row.phase === 'A')
  const refusedA = holderFacts.filter((row) => row.kind === 'remote-start-refused' && row.phase === 'A')
  // The endpoint arbitration validates a retry open TWICE (before and after
  // the reclaim check), so one retry open shows as two retry-open-attempt facts.
  run.check('phase A ran exactly ONE attestation-guarded retry open (bounded per turn), safely refused while the holder served', retriesA.length === 2 && refusedA.length === 22 && holderFacts.some((row) => row.kind === 'remote-start-ok' && row.phase === 'A') === false, JSON.stringify({ retriesA: retriesA.length, refusedA: refusedA.length }))
  run.check('the holder stayed bound through phase A (forgotten exactly once, only for the phase-B heal)', holderFacts.filter((row) => row.kind === 'holder-forgotten').length === 1, JSON.stringify(holderFacts.filter((row) => row.kind === 'holder-forgotten')))
  // Phase B: holder disconnected; one message retries, binds interrupted and
  // resumes in the same turn — the write landing at all is the proof.
  run.check('the driver armed phase B before the heal boot', run.records.find((r) => r.kind === 'holder-armed-B')?.value?.phase === 'B', JSON.stringify(run.records.find((r) => r.kind === 'holder-armed-B')))
  const forgotten = holderFacts.find((row) => row.kind === 'holder-forgotten')
  run.check('the holder was forgotten in-band with the last refusal of the phase-B creation burst (setup still failed duplicate)', forgotten?.refusedInPhaseB === 21, JSON.stringify(forgotten))
  const retriesB = holderFacts.filter((row) => row.kind === 'retry-open-attempt' && row.phase === 'B')
  const startsOkB = holderFacts.filter((row) => row.kind === 'remote-start-ok' && row.phase === 'B')
  run.check('the message-driven retry ran once and bound the session as interrupted', retriesB.length === 2 && startsOkB.length === 1 && startsOkB[0].state === 'interrupted', JSON.stringify({ retriesB: retriesB.length, startsOkB }))
  run.check('phase B delivered a genuine user message', run.records2.some((r) => r.kind === 'session-event' && r.type === 'user/message' && r.source === 'user' && r.session === run.sessionId), JSON.stringify(run.records2.filter((r) => r.type === 'user/message')))
  const textB = run.requests2.map((r) => `${r.lastTool ?? ''}\n${r.lastUser ?? ''}`).join('\n')
  run.check('the write succeeded in the SAME turn (retry + same-turn resume) and released cleanly', phaseB?.code === 0 && phaseB.targetContent === 'healed\n' && textB.includes('Created file') && textB.includes('Released'), `code=${phaseB?.code} target=${JSON.stringify(phaseB?.targetContent)} :: ${textB.slice(-600)}`)
  const audits = run.records2.filter((r) => r.kind === 'session-event' && r.type === 'weir/edit-lock-maintenance' && r.data?.kind === 'binding-auto-retry')
  run.check('exactly one binding-auto-retry audit names the session, the duplicate code and the recovered result', audits.length === 1 && audits[0].data?.sessionId === run.sessionId && audits[0].data?.code === 'binding-duplicate' && audits[0].data?.result === 'recovered', JSON.stringify(audits))
  // The audit mirror anchors at the session's resolved management root
  // (registry.rootOf): production resolves it to the session's own domain
  // root; in this IT sandbox the workspace sits inside the lane's git
  // repository, so ancestor-authority discovery resolves OUTSIDE the sandbox
  // and the mirror row lands there instead. The cordis channel above is the
  // asserted evidence; the mirror anchor behavior is unchanged production
  // semantics, not scenario scope.
  run.check('the session epoch advanced by the same-turn resume and no lock survived', final?.snapshot?.sessions?.some((s) => s.sessionId === run.sessionId && s.epoch >= 3) === true && final?.snapshot?.locks?.some((lock) => lock.owner === run.sessionId) === false, JSON.stringify(final?.snapshot))
  run.check('the holder publisher closed cleanly and released the reservation', run.records.find((r) => r.kind === 'holder-exit')?.value?.code === 0 && holderFacts.some((row) => row.kind === 'closed') && holderFacts.some((row) => row.kind === 'close-error') === false && final?.reservationReleased === true, JSON.stringify({ exit: run.records.find((r) => r.kind === 'holder-exit')?.value, reservation: final?.reservationReleased }))
  run.check('phase B exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-500)}`)
}

export default { id, prompt: `${id}-seed`, env: { WEIR_IT_EDIT_LOCK: '1', WEIR_IT_BINDING_AUTO_RETRY: '1', WEIR_IT_STALE_SWEEP: 'off' }, decide, observe, run, assert: assertRun }
