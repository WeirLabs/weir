// P0-S2: real delegate child, stock ask rejection, then disposable consult probe.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lastOfRole, textChunks, toolCallChunks } from '../mock-kit.js'
import { writeDecisionEvidence } from '../decision-spike-evidence.js'

const id = 'decision-spike-delegated'
const prompt = 'decision-spike-delegated-probe'
const CHILD = 'DECISION_SPIKE_CHILD'

function decide(options, obs) {
  const history = obs.transcript
  const lastTool = lastOfRole(options, 'tool')
  const child = history.includes(CHILD) && !history.includes(prompt)
  if (child) {
    if (lastTool.includes('"outcome":"awaiting_user"')) return textChunks('STATUS: completed\nREPORT: S2_CHILD_DONE')
    if (lastTool.includes('DELEGATED_CALLER')) return toolCallChunks('decision_consult', { question: 'Delegated decision requiring root escalation', request_id: 's2' })
    if (lastTool.startsWith('Error:')) return textChunks('STATUS: blocked\nREPORT: S2_CHILD_FAILED')
    if (lastTool.includes('unknown tool')) return textChunks('STATUS: blocked\nREPORT: S2_CHILD_FAILED')
    return toolCallChunks('ask_user_question', { questions: [{ id: 's2-child', question: 'Child must not ask directly', options: [{ label: 'Yes' }, { label: 'No' }] }] })
  }
  if (history.includes('S2_CHILD_DONE')) return textChunks('S2_PARENT_DONE')
  if (history.includes('S2_CHILD_FAILED')) return textChunks('S2_PARENT_FAILED')
  if (history.includes(prompt)) return toolCallChunks('delegate', {
    category: 'quick',
    prompt: `${CHILD}\nTASK: exercise child ask rejection and delegated consult\nDELIVERABLE: S2_CHILD_DONE\nSCOPE: no files\nVERIFY: both tool outcomes observed\nSTOP WHEN: complete`,
    task_summary: 'decision delegated probe',
  })
  return textChunks('unhandled decision delegated turn')
}

function observe(obs) {
  return {
    s2Child: obs.transcript.includes(CHILD) && !obs.transcript.includes(prompt),
    s2DelegatedError: obs.lastTool.includes('DELEGATED_CALLER'),
    s2Consult: obs.lastTool.includes('"outcome":"awaiting_user"'),
  }
}

function assert(run) {
  const consultPath = join(run.ws, 'decision-spike-consult.json')
  const consult = existsSync(consultPath) ? JSON.parse(readFileSync(consultPath, 'utf8')) : null
  const eventPath = join(run.ws, '..', 'decision-spike-events.jsonl')
  const events = existsSync(eventPath) ? readFileSync(eventPath, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : []
  const waterfallHitCount = events.filter(event => event.listener === 'observer').length
  const root = run.created.find(record => (record.depth ?? 0) === 0)?.session ?? null
  const child = run.created.find(record => record.origin === 'subagent' && record.depth === 1)?.session ?? null
  const childAskErrorCode = run.requests.some(request => request.s2Child && request.s2DelegatedError) ? 'DELEGATED_CALLER' : null
  const pass = childAskErrorCode === 'DELEGATED_CALLER' && waterfallHitCount === 0 && consult?.case?.rootSessionId === root && consult?.case?.originSessionId === child && consult?.case?.originKind === 'delegated' && run.stdout.includes('S2_PARENT_DONE') && (run.code === 0 || run.code === null)
  writeDecisionEvidence(run, 'S2', 'delegated.json', {
    childAskErrorCode, waterfallHitCount, events, rootSessionIdObserved: root, childSessionIdObserved: child,
    consultCase: consult?.case ?? null, consultOutcome: consult?.outcome ?? null,
    assertions: {
      rejectedBeforeWaterfall: childAskErrorCode === 'DELEGATED_CALLER' && waterfallHitCount === 0,
      consultResolvedRoot: consult?.case?.rootSessionId === root && root !== null,
      delegatedOrigin: consult?.case?.originKind === 'delegated' && consult?.case?.originSessionId === child && child !== null,
    },
    pass,
  })
  run.check('child ask rejected with DELEGATED_CALLER', childAskErrorCode === 'DELEGATED_CALLER', JSON.stringify(run.requests.filter(request => request.s2Child).map(request => request.lastTool)))
  run.check('child ask never reached the waterfall', waterfallHitCount === 0, JSON.stringify(events))
  run.check('consult Case belongs to the real root and delegated child', consult?.case?.rootSessionId === root && consult?.case?.originSessionId === child && consult?.case?.originKind === 'delegated', JSON.stringify({ root, child, consult }))
  run.check('headless delegated run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-500)}`)
}

export default { id, prompt, decide, observe, assert, env: { WEIR_IT_DECISION_SPIKE: 'delegated' } }
