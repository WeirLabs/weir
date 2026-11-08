// P0-S1(a): real userQuestions waterfall, prepend probe + the actual stub row.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lastOfRole, textChunks, toolCallChunks } from '../mock-kit.js'
import { writeDecisionEvidence } from '../decision-spike-evidence.js'

const id = 'decision-spike-order'
const prompt = 'decision-spike-order-probe'

function decide(options, obs) {
  const lastTool = lastOfRole(options, 'tool')
  if (lastTool.includes('"id":"s1-order"')) return textChunks('S1_ORDER_DONE')
  if (obs.transcript.includes(prompt)) return toolCallChunks('ask_user_question', {
    questions: [{ id: 's1-order', question: 'Which listener owns this answer?', options: [{ label: 'Stub' }, { label: 'Prepend' }] }],
  })
  return textChunks('unhandled decision order turn')
}

function observe(obs) {
  return { s1Answer: obs.lastTool.includes('"id":"s1-order"'), s1Prepend: obs.lastTool.includes('"selected":["Prepend"]') }
}

function assert(run) {
  const file = join(run.ws, '..', 'decision-spike-events.jsonl')
  const events = existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const answerRequest = run.requests.find(request => request.s1Answer)
  let finalAnswer = null
  try { finalAnswer = JSON.parse(answerRequest?.lastTool ?? '') } catch {}
  const prepend = events.filter(event => event.listener === 'prepend')
  const stub = events.filter(event => event.listener === 'user-questions-stub')
  const pass = prepend.length === 1 && stub.length === 0 && finalAnswer?.answers?.[0]?.selected?.[0] === 'Prepend' && run.stdout.includes('S1_ORDER_DONE') && (run.code === 0 || run.code === null)
  writeDecisionEvidence(run, 'S1', 'order.json', {
    criterion: 'S1(a) only; Desktop S1(b/c) remain separately required',
    events, listenerOrder: events.map(event => event.listener), prependCalls: prepend.length, stubCalls: stub.length,
    finalAnswer, answerOwner: finalAnswer?.answers?.[0]?.selected?.[0] === 'Prepend' ? 'prepend' : 'unknown',
    desktopCriteriaSatisfied: false, pass,
  })
  run.check('prepend listener ran exactly once before the stub', prepend.length === 1 && stub.length === 0, JSON.stringify(events))
  run.check('final complete answer batch belongs to prepend', finalAnswer?.answers?.[0]?.id === 's1-order' && finalAnswer?.answers?.[0]?.selected?.[0] === 'Prepend', answerRequest?.lastTool ?? 'missing answer')
  run.check('headless order run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-500)}`)
}

export default { id, prompt, decide, observe, assert, env: { WEIR_IT_DECISION_SPIKE: 'order' } }
