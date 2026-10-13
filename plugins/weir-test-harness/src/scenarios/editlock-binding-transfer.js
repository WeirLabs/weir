// Scenario: editlock-binding-transfer — the dual-agent self-heal end to end at
// the harness's fidelity ceiling (openspec edit-lock-binding-transfer, task
// 4.3, design D1/D2/D3). A seed boot establishes the private authority and the
// session. A long-lived holder child then publishes the authority and holds a
// LOCAL, registry-named, provably idle binding for that session (the ghost —
// its lifecycle's servingRuntime is pinned to it, exactly the publisher-side
// state of the single-process incident, where the agents registry kept naming
// the ghost). Every later boot of the same session becomes a remote client
// whose creation burst is refused with the TRANSFERABLE class.
//
// One adopt boot then proves both arms in deterministic turn order (the
// adoption's serial agent/created dispatch awaits the refused setup, and the
// probe's followup latches inside the factory maintenance scope, so the
// injected message drives turn 1 alone and the runner's whenIdle gates the
// genuine task to turn 2):
//
//   turn 1 (negative arm): a runtime-injected message arrives while the
//   transferable failure stands. It never arms the retry: no retry open, no
//   transfer, the scripted write stays denied, and edit_lock_status still
//   reports the unchanged failure (unavailable + transferable).
//
//   turn 2 (positive arm): ONE genuine user message arms exactly one bounded
//   retry; at the turn's first pre-step the retry open reaches the publisher,
//   whose transfer admission (lifecycle.transferStart: local, registry-named,
//   idle holder) forgets the ghost and binds the claimant as interrupted; the
//   re-armed auto-resume proceeds in the SAME turn; the scripted write lands
//   and releases; the claimant-side audit carries 'binding-auto-retry'
//   'recovered'.
//
// Harness boundary, stated honestly: the stock agents registry admits one live
// agent per session id, so two same-id agents cannot coexist in one headless
// process (the claimant-side transfer branch of retryBinding's trichotomy —
// registry names a DIFFERENT local agent — is unreachable here and stays pinned
// by the unit-level transfer suites). In this scenario the claimant process's
// registry legitimately names the claimant itself, so the claimant takes the
// superseded branch; the transfer admission that distinguishes this feature
// runs publisher-side and is asserted from the holder's facts.
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, textChunks, toolCallChunks, transcript } from '../mock-kit.js'
import { parseJsonlLines, readJsonl } from '../jsonl.js'
import { textOf } from '../message-text.js'

const id = 'editlock-binding-transfer'
const WS = join(IT_ROOT, 'ws')
const AUTHORITY = join(WS, '.weir', 'edit-lock-binding-transfer')
const RESERVATION = join(WS, '.weir', '.edit-lock-binding-transfer.publisher-reservation')
const SEED = join(WS, 'binding-transfer-seed.txt')
const TARGET = join(WS, 'binding-transfer-target.txt')
const NODE = process.env.WEIR_IT_NODE ?? '/Users/young/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node'
const HARNESS_SRC = new URL('../../../weir-harness/src/', import.meta.url).pathname

/** The holder publisher: reserves the authority, serves the endpoint and holds
 * a LOCAL binding for the adopted session through a ghost object that never
 * drives a turn (status 'idle' forever). The lifecycle's servingRuntime is
 * pinned to the ghost — the publisher-side image of the incident's registry.
 * Every remote open is counted: creation-burst refusals, the retry open's two
 * assertStartable validations, the refused start that precedes the transfer
 * admission, and the transfer itself. Facts go to FACTS. */
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
    let refused = 0, retryChecks = 0, startedOk = 0, transfers = 0
    const runtime = await openReservedEditLockRuntime({ root: ${JSON.stringify(WS)}, directory: ${JSON.stringify(AUTHORITY)}, domainId: ${JSON.stringify(WS)}, mode: 'recover', fs: stubFs })
    // The ghost: local (never a channel proxy), registry-named (the pinned
    // servingRuntime), and provably not mid-turn — the transferable holder.
    const ghost = Object.freeze({ id: ${JSON.stringify(sessionId)}, status: 'idle' })
    const base = createEditLockLifecycle(runtime, (agent) => agent.id, {
      servingRuntime: () => ghost,
      warn: (message) => fact({ kind: 'lifecycle-warn', message: String(message) }),
    })
    const lifecycle = {
      ...base,
      assertStartable(agent) {
        // The arbitration validates a retry open TWICE (before and after the
        // reclaim check), so one retry open lands two facts.
        if (agent?.remote === true) { retryChecks++; fact({ kind: 'retry-open-check' }) }
        return base.assertStartable(agent)
      },
      async start(agent) {
        try {
          const state = await base.start(agent)
          if (agent?.remote === true) { startedOk++; fact({ kind: 'remote-start-ok', state }) }
          return state
        } catch (error) {
          if (agent?.remote === true) {
            refused++
            fact({ kind: 'remote-start-refused', refused, holderKind: error?.bindingFailure?.holderKind ?? null })
          }
          throw error
        }
      },
      async transferStart(agent) {
        transfers++
        try {
          const state = await base.transferStart(agent)
          // The reclaim semantics: the ghost's local entry is gone, no lock
          // was released, and the claimant binds interrupted.
          fact({ kind: 'transfer', result: 'transferred', state, localBindingsAfter: base.bindings() })
          return state
        } catch (error) {
          fact({ kind: 'transfer', result: 'refused', holderKind: error?.bindingFailure?.holderKind ?? null })
          throw error
        }
      },
    }
    const server = await serveEditLockEndpoint(lifecycle, endpointFor(${JSON.stringify(AUTHORITY)}), new WeakMap())
    const state = await base.start(ghost)
    fact({ kind: 'ready', state, bindings: base.bindings() })
    let closing = false
    const shutdown = async () => {
      if (closing) return
      closing = true
      clearInterval(timer)
      try { await server.close() } catch (error) { fact({ kind: 'close-error', where: 'endpoint', message: String(error?.message ?? error) }) }
      try { await base.close() } catch (error) { fact({ kind: 'close-error', where: 'lifecycle', message: String(error?.message ?? error) }) }
      try { await runtime.close() } catch (error) { fact({ kind: 'close-error', where: 'runtime', message: String(error?.message ?? error) }) }
      fact({ kind: 'closed', refused, retryChecks, startedOk, transfers })
      process.exit(0)
    }
    const timer = setInterval(() => {
      try {
        if (readFileSync(${JSON.stringify(controlPath)}, 'utf8').trim() === 'C') void shutdown()
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
    issuedRequests: state.issuedRequests,
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

/** Tool results of the CURRENT boot/turn only (an adopted session carries the
 * earlier boots' messages too): slice after the turn's prompt marker. */
function phaseToolResults(options, marker) {
  const messages = options.messages ?? []
  const markerAt = messages.findLastIndex((message) => message.role === 'user' && textOf(message).includes(marker))
  return (markerAt === -1 ? [] : messages.slice(markerAt + 1)).filter((message) => message.role === 'tool').length
}

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  // Turn 2 of the adopt boot (the genuine task): the message-armed retry and
  // the same-turn auto-resume ran at this turn's first pre-step, so the write
  // lands; release ends the batch.
  if (history.includes(`${id}-heal`)) {
    const toolResults = phaseToolResults(options, `${id}-heal`)
    if (toolResults === 0) return toolCallChunks('write', { file_path: TARGET, content: 'healed\n' })
    if (toolResults === 1) return toolCallChunks('edit_lock_release', { file_path: TARGET })
    return textChunks('binding-transfer heal done')
  }
  // Turn 1 of the adopt boot (the runtime-injected message): nothing is armed,
  // so the write stays denied and the status read reports the unchanged
  // failure; the turn then ends.
  if (history.includes(`${id}-injected`)) {
    const toolResults = phaseToolResults(options, `${id}-injected`)
    if (toolResults === 0) return toolCallChunks('write', { file_path: TARGET, content: 'denied\n' })
    if (toolResults === 1) return toolCallChunks('edit_lock_status', {})
    return textChunks('binding-transfer injected done')
  }
  // Seed boot: an ordinary write + release establishes the authority.
  if (history.includes(`${id}-seed`)) {
    const toolResults = phaseToolResults(options, `${id}-seed`)
    if (toolResults === 0) return toolCallChunks('write', { file_path: SEED, content: 'seed\n' })
    if (toolResults === 1) return toolCallChunks('edit_lock_release', { file_path: SEED })
    return textChunks('binding-transfer seed done')
  }
  return textChunks('unhandled binding-transfer turn')
}

function observe(obs) {
  return {
    editLockToolsSeen: obs.toolNames.includes('edit_lock_status'),
    // The transferable calm copy (notice, denial tail and status hint all name
    // the inactive same-session attachment) outlives the trace's lastTool cut,
    // so it is observed from the full transcript.
    transferGuidanceSeen: obs.transcript.includes('inactive attachment of this same session'),
  }
}

async function run({ IT_ROOT: root, spawnHeadless, scenarioEnv }) {
  const trace = join(root, `trace-${id}.jsonl`)
  const fact = (record) => appendFileSync(trace, JSON.stringify(record) + '\n')
  const seedTrace = join(root, `trace-${id}-seed.jsonl`)
  const seed = await spawnHeadless(['weir-it', '--json', `${id}-seed`], scenarioEnv(id, seedTrace, this.env))
  const sessionId = parseJsonlLines(seed.stdout).find((entry) => entry?.type === 'session')?.sessionId ?? null
  fact({ kind: 'seed-exit', code: seed.code, sessionId, seedContent: existsSync(SEED) ? readFileSync(SEED, 'utf8') : null, snapshot: snapshotState() })
  if (!sessionId) return { scenario: id, trace, sessionId, code: seed.code, stdout: seed.stdout, stderr: seed.stderr }
  const factsPath = join(root, `holder-${id}.jsonl`)
  const controlPath = join(root, `holder-${id}.control`)
  const child = spawn(NODE, ['--input-type=module', '-e', holderScript(sessionId, factsPath, controlPath)], { stdio: ['ignore', 'pipe', 'pipe'] })
  let childStderr = ''
  child.stderr.on('data', (data) => { childStderr += data })
  const childExit = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })))
  const ready = await waitForFact(factsPath, (row) => row.kind === 'ready')
  fact({ kind: 'holder-ready', value: ready ?? null, childStderr: childStderr.slice(-400) })
  // One adopt boot, two deterministic turns: the probe queues the injected
  // message off the calm notice (turn 1, never arms); the runner's genuine
  // task follows after whenIdle (turn 2, arms the transfer + same-turn resume).
  const trace2 = join(root, `trace-${id}-heal.jsonl`)
  const heal = await spawnHeadless(['weir-it', '--session-id', sessionId, `${id}-heal`], scenarioEnv(id, trace2, { ...this.env, WEIR_IT_BINDING_TRANSFER_PROBE: 'inject' }))
  fact({ kind: 'heal-exit', code: heal.code, targetContent: existsSync(TARGET) ? readFileSync(TARGET, 'utf8') : null })
  writeFileSync(controlPath, 'C')
  const exit = await Promise.race([childExit, new Promise((resolve) => setTimeout(() => resolve(null), 15000))])
  if (exit === null) child.kill('SIGKILL')
  fact({ kind: 'holder-exit', value: exit, childStderr: childStderr.slice(-400) })
  // Replay self-containment: the assert consumes holder facts from the trace.
  for (const row of readJsonl(factsPath)) fact({ kind: 'holder-fact', row })
  fact({ kind: 'final', reservationReleased: !existsSync(RESERVATION), snapshot: snapshotState() })
  return { scenario: id, trace, trace2, sessionId, code: heal.code, stdout: heal.stdout, stderr: `${seed.stderr}\n${heal.stderr}\n${childStderr}` }
}

function assertRun(run) {
  const holderFacts = run.records.filter((r) => r.kind === 'holder-fact').map((r) => r.row)
  const seed = run.records.find((r) => r.kind === 'seed-exit')
  const ready = run.records.find((r) => r.kind === 'holder-ready')
  const heal = run.records.find((r) => r.kind === 'heal-exit')
  const final = run.records.find((r) => r.kind === 'final')
  run.check('the seed boot established the authority and the session', seed?.code === 0 && typeof run.sessionId === 'string' && seed.sessionId === run.sessionId && seed.seedContent === 'seed\n', JSON.stringify(seed))
  run.check('the holder publisher bound the session as interrupted with the ghost registry-named (attestation serving)', ready?.value?.state === 'interrupted' && ready?.value?.bindings?.some((binding) => binding.sessionId === run.sessionId && binding.attestation === 'serving') === true, JSON.stringify(ready))
  const refusals = holderFacts.filter((row) => row.kind === 'remote-start-refused')
  // The exact publisher-side fact sequence is asserted below (burst, retry
  // open, transfer, close); here the refusal CLASS: every answered refusal of
  // the burst carries the transferable holder kind over the wire.
  run.check('every answered refusal carried the transferable class over the wire (21 burst refusals plus the retry open\'s refused start)', refusals.length === 22 && refusals.every((row) => row.holderKind === 'transferable'), JSON.stringify({ refused: refusals.length, kinds: [...new Set(refusals.map((row) => row.holderKind))] }))

  // Turn 1 (negative arm): the runtime-injected message arrived while the
  // failure stood, and provably did not arm or run a transfer.
  const injected = run.records2.filter((r) => r.kind === 'session-event' && r.type === 'user/message' && r.source === 'weir-it-binding-transfer-injected' && r.session === run.sessionId)
  const genuine = run.records2.filter((r) => r.kind === 'session-event' && r.type === 'user/message' && r.source === 'user' && r.session === run.sessionId)
  run.check('the runtime-injected message drove a turn before the genuine task arrived', injected.length === 1 && genuine.length === 1 && (injected[0].eventSeq ?? 0) < (genuine[0].eventSeq ?? 0), JSON.stringify({ injected: injected.map((r) => r.eventSeq), genuine: genuine.map((r) => r.eventSeq) }))
  const turns = run.records2.filter((r) => r.kind === 'session-event' && r.type === 'turn/end' && r.session === run.sessionId)
  run.check('the adopt boot ran exactly two completed turns (injected, then genuine)', turns.length === 2 && turns.every((r) => r.reason === 'completed'), JSON.stringify(turns))
  const mains = run.requests2.filter((r) => r.purpose === 'main')
  const denyRow = mains.findIndex((r) => (r.lastTool ?? '').includes('Edit Lock binding is unavailable'))
  const statusRow = mains.findIndex((r) => (r.lastTool ?? '').includes('Edit Lock unavailable') && (r.lastTool ?? '').includes('inactive attachment of this same session'))
  const createdRow = mains.findIndex((r) => (r.lastTool ?? '').includes('Created file') && (r.lastTool ?? '').includes('binding-transfer-target'))
  const releasedRow = mains.findIndex((r) => (r.lastTool ?? '').includes('Released') && (r.lastTool ?? '').includes('binding-transfer-target'))
  run.check('turn 1 kept the write denied and the failure record unchanged (status still unavailable + transferable)', denyRow !== -1 && statusRow !== -1 && denyRow < statusRow, JSON.stringify(mains.map((r) => r.lastTool ?? '').slice(0, 6)))
  // The exact publisher-side fact sequence: the 21-attempt answered-refusal
  // creation burst (setup), then — only once the genuine message's retry open
  // arrives — its two validations, the refused start that precedes the
  // transfer admission, the transfer itself, and a clean close. Turn 1 (the
  // injected message) produces NO publisher traffic at all: jointly with the
  // turn-1 status read above (failure still standing) and the denial-before-
  // heal ordering below, the single transfer cannot have run before the
  // genuine message.
  const expectedShape = ['ready', ...Array(21).fill('remote-start-refused'), 'retry-open-check', 'retry-open-check', 'remote-start-refused', 'transfer', 'closed']
  run.check('publisher fact sequence: burst, one retry open (two validations + refused start), one transfer, clean close', JSON.stringify(holderFacts.map((row) => row.kind)) === JSON.stringify(expectedShape), JSON.stringify(holderFacts.map((row) => row.kind)))

  // Turn 2 (positive arm): ONE genuine message armed exactly one bounded retry;
  // the publisher's transfer admission handed the binding over and the same
  // turn resumed and edited.
  const transfer = holderFacts.find((row) => row.kind === 'transfer')
  run.check('exactly one transfer ran at the genuine message\'s retry: claimant bound interrupted, ghost entry gone, no lock released', transfer?.result === 'transferred' && transfer?.state === 'interrupted' && Array.isArray(transfer?.localBindingsAfter) && transfer.localBindingsAfter.length === 0, JSON.stringify(transfer))
  run.check('turn 2 order: the denial and the standing failure precede the healed write and its release', createdRow !== -1 && releasedRow !== -1 && statusRow < createdRow && createdRow < releasedRow, JSON.stringify({ denyRow, statusRow, createdRow, releasedRow }))
  run.check('the write succeeded in the SAME turn (transfer + same-turn resume) and the target holds exactly the healed content', heal?.code === 0 && heal.targetContent === 'healed\n', `code=${heal?.code} target=${JSON.stringify(heal?.targetContent)}`)
  const audits = run.records2.filter((r) => r.kind === 'session-event' && r.type === 'weir/edit-lock-maintenance' && r.data?.kind === 'binding-auto-retry')
  run.check('exactly one binding-auto-retry audit names the session, the duplicate code and the recovered result', audits.length === 1 && audits[0].data?.sessionId === run.sessionId && audits[0].data?.code === 'binding-duplicate' && audits[0].data?.result === 'recovered', JSON.stringify(audits))
  // Harness boundary (module header): the claimant's own registry names the
  // claimant, so the claimant-side audit shape stays the superseded one; the
  // 'binding-transfer' claimant audit belongs to the single-process dual-agent
  // state the stock registry cannot hold, and remains unit-pinned.
  const transferAudits = run.records2.filter((r) => r.kind === 'session-event' && r.type === 'weir/edit-lock-maintenance' && r.data?.kind === 'binding-transfer')
  run.check('no claimant-side binding-transfer audit exists in this topology (superseded branch; transfer admission is publisher-side)', transferAudits.length === 0, JSON.stringify(transferAudits))
  // The calm transferable notice is the clean-copy surface (the tool-facing
  // denial and status legitimately embed the publisher-answered reason in a
  // parenthetical); it must never carry the raw classification, a pid, the
  // alarm copy, or the reservation warning.
  const notice = run.records2.find((r) => r.kind === 'inbox-inserted' && (r.text ?? '').includes('inactive attachment of this same session'))
  run.check('the calm transferable notice surfaced in-session, clean of pid/holder classification and alarm copy', notice !== undefined && notice.session === run.sessionId && notice.text.includes('transfers automatically when you send a message') && !/temporarily unavailable|pid=|holder=|Do NOT remove/.test(notice.text), JSON.stringify(notice))
  run.check('the transferable guidance also surfaced on the tool surface (denial tail / status hint)', run.requests2.some((r) => r.transferGuidanceSeen === true), '')
  // A resume relayed over the channel is recorded publisher-side with the
  // 'remote:' prefix on the claimant-minted auto request id.
  run.check('the auto-resume minted a fresh server request id in the same turn', final?.snapshot?.issuedRequests?.some((r) => r.sessionId === run.sessionId && typeof r.requestId === 'string' && r.requestId.includes('auto:user-message:')) === true, JSON.stringify(final?.snapshot?.issuedRequests))
  run.check('the session epoch advanced past the seed boot and no lock survived', (final?.snapshot?.sessions?.find((s) => s.sessionId === run.sessionId)?.epoch ?? 0) > (seed?.snapshot?.sessions?.find((s) => s.sessionId === run.sessionId)?.epoch ?? 0) && final?.snapshot?.locks?.some((lock) => lock.owner === run.sessionId) === false, JSON.stringify({ seed: seed?.snapshot?.sessions, final: final?.snapshot }))
  run.check('the holder publisher closed cleanly and released the reservation', run.records.find((r) => r.kind === 'holder-exit')?.value?.code === 0 && holderFacts.some((row) => row.kind === 'closed') && holderFacts.some((row) => row.kind === 'close-error') === false && final?.reservationReleased === true, JSON.stringify({ exit: run.records.find((r) => r.kind === 'holder-exit')?.value, reservation: final?.reservationReleased }))
  run.check('the heal boot exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-500)}`)
}

export default { id, prompt: `${id}-seed`, env: { WEIR_IT_EDIT_LOCK: '1', WEIR_IT_BINDING_TRANSFER: '1', WEIR_IT_STALE_SWEEP: 'off' }, decide, observe, run, assert: assertRun }
