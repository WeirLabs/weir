// Scenario: editlock-lsp-uncertain — lose the acknowledgement for the second
// real fs write of a two-file lsp_rename (WEIR_IT_LSP_UNCERTAIN=1 arms the
// row-mounted lost-ack fault). The session's own disposable workspace keeps the
// fixture bytes independent from every other scenario.
//
// The contract under test is the honest failure report (edit-lock-rebuild D12):
// the first target is provably written, the second cannot be proven either way
// so it is reported as uncertain (never as not-written), ownership of the batch
// is retained, and nothing is rolled back.
//
// What is deliberately NOT asserted any more: the durable authority image, the
// unknown-phase operation record with its resource fence, and the two retained
// per-resource locks. The rebuild dropped crash-outcome fencing; the tool result
// is the whole record of what happened.
import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, textChunks, toolCallChunks, transcript } from '../mock-kit.js'
import { parseJsonlLines } from '../jsonl.js'

const id = 'editlock-lsp-uncertain'
const prompt = id
const env = { WEIR_IT_EDIT_LOCK: '1', WEIR_IT_LSP_UNCERTAIN: '1' }
const DOMAIN = join(IT_ROOT, 'ws', id)
const FIRST = join(DOMAIN, 'probe.ts')
const SECOND = join(DOMAIN, 'probe-other.ts')
const beforeFirst = 'export const fixtureSymbol = 1\n'
const beforeSecond = 'import { fixtureSymbol } from "./probe"\r\nexport const useIt = fixtureSymbol + 1\r\n'
const afterFirst = 'export const uncertainProbe = 1\n'
const afterSecond = 'import { uncertainProbe } from "./probe"\r\nexport const useIt = uncertainProbe + 1\r\n'

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  if (!history.includes('LSP semantic tools enabled')) return toolCallChunks('lsp', { enabled: true })
  if (!history.includes('Document symbols:')) return toolCallChunks('lsp_symbols', { file_path: FIRST })
  if (!history.includes('write failed for')) {
    // The rename is dispatched once; an aborted turn can drop the in-flight
    // result, so settle instead of re-dispatching forever.
    if ((options.messages ?? []).filter(message => message.role === 'tool').length >= 3) return textChunks('rename outcome missing')
    return toolCallChunks('lsp_rename', { file_path: FIRST, line: 1, character: 14, new_name: 'uncertainProbe' })
  }
  return textChunks('uncertain rename observed')
}
function observe(obs) {
  return { editLockToolsSeen: obs.toolNames.includes('edit_lock_acquire'), lspRenameSeen: obs.toolNames.includes('lsp_rename') }
}
async function run({ IT_ROOT: root, spawnHeadless, scenarioEnv }) {
  const trace = join(root, `trace-${id}.jsonl`)
  const outcome = await spawnHeadless(['weir-it', '--json', prompt], scenarioEnv(id, trace, env))
  const records = parseJsonlLines(outcome.stdout)
  const calls = records.filter(record => record?.type === 'tool_call')
  const results = records.filter(record => record?.type === 'tool_result')
  const report = {
    kind: 'editlock-lsp-uncertain-result', code: outcome.code,
    sessionId: records.find(record => record?.type === 'session')?.sessionId ?? null,
    tools: calls.map((call, index) => ({ tool: call.tool, status: results[index]?.status, result: results[index]?.result })),
    bytes: [FIRST, SECOND].map(path => existsSync(path) ? readFileSync(path).toString('base64') : null),
  }
  appendFileSync(trace, JSON.stringify(report) + '\n')
  return { scenario: id, trace, ...outcome }
}
function assert(run) {
  const record = run.records.find(row => row.kind === 'editlock-lsp-uncertain-result')
  const fault = run.records.filter(row => row.kind === 'editlock-lsp-uncertain-fault')
  const result = record?.tools?.find(row => row.tool === 'lsp_rename')
  const text = result?.result ?? ''
  run.check('real lsp_rename tool returned its complete failure report', typeof text === 'string' && text.includes('write failed for') && result?.status === 'error', JSON.stringify(result))
  run.check('second publication completed before its acknowledgement was lost exactly once', fault.length === 1 && fault[0].target === SECOND && fault[0].backendCompleted === true && fault[0].expected === 'replaceIfVersion', JSON.stringify(fault))
  run.check('full three-list report classifies first written and second uncertain, never not-written', text.includes(`filesAlreadyWritten: ["${FIRST}"]`) && text.includes('filesNotWritten: []') && text.includes(`filesUncertain: ["${SECOND}"]`) && text.includes('ownership retained (no rollback)'), text)
  run.check('first target really written and never rolled back', record?.bytes?.[0] === Buffer.from(afterFirst).toString('base64') && record.bytes[0] !== Buffer.from(beforeFirst).toString('base64'), JSON.stringify(record?.bytes))
  run.check('second target really written although its result is uncertain to the caller', record?.bytes?.[1] === Buffer.from(afterSecond).toString('base64') && record.bytes[1] !== Buffer.from(beforeSecond).toString('base64'), JSON.stringify(record?.bytes))
  run.check('tool failure handled by agent with clean CLI exit', record?.code === 0 && run.code === 0, JSON.stringify({recordCode: record?.code, runCode: run.code, stderr: run.stderr.slice(-500)}))
}
export default { id, prompt, env, decide, observe, run, assert }
