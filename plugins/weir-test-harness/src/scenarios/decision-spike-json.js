// P0-S5 mock half: five actual llm.stream responses and strict classifications.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lastOfRole, textChunks, toolCallChunks, usage } from '../mock-kit.js'
import { writeDecisionEvidence } from '../decision-spike-evidence.js'

const id = 'decision-spike-json'
const prompt = 'decision-spike-json-probe'
const CONTRACT = 'Decision evaluator contract v1'

function answer(evidenceId) {
  return JSON.stringify({ outcome: 'answer', claims: [{ text: 'Use the evidenced option', evidenceIds: [evidenceId] }], answers: [{ id: 'q1', selected: ['A'] }] })
}

function* truncated() {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text: '{"outcome":"answer","claims":[' }
  yield usage()
  yield { type: 'finish', reason: { kind: 'max-tokens' } }
}

function decide(options, obs) {
  if (obs.system.includes(CONTRACT)) {
    const fixture = /FIXTURE:([a-z-]+)/.exec(obs.transcript)?.[1]
    if (fixture === 'valid') return textChunks(answer('ev_known'))
    if (fixture === 'fenced') return textChunks(`\`\`\`json\n${answer('ev_known')}\n\`\`\``)
    if (fixture === 'truncated') return truncated()
    if (fixture === 'non-json') return textChunks('this is not JSON')
    if (fixture === 'unknown-evidence') return textChunks(answer('ev_unknown'))
    return textChunks('unknown JSON fixture')
  }
  const lastTool = lastOfRole(options, 'tool')
  if (lastTool.includes('DECISION_SPIKE')) return textChunks(lastTool.includes('"pass":true') ? 'S5_MOCK_DONE' : 'S5_MOCK_FAILED')
  if (obs.transcript.includes(prompt)) return toolCallChunks('decision_json_spike', {})
  return textChunks('unhandled decision JSON turn')
}

function observe(obs) {
  return { s5Contract: obs.system.includes(CONTRACT), s5Fixture: /FIXTURE:([a-z-]+)/.exec(obs.transcript)?.[1] ?? null }
}

function assert(run) {
  const path = join(run.ws, 'decision-spike-json-report.json')
  const report = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
  const pass = report?.pass === true && report.results.length === 5 && run.stdout.includes('S5_MOCK_DONE') && (run.code === 0 || run.code === null)
  writeDecisionEvidence(run, 'S5', 'mock-classification.json', {
    criterion: 'S5 mock half only; 20 Desktop real-model samples remain separately required',
    classifications: report?.results?.map(result => ({ fixture: result.fixture, classification: result.classification, durationMs: result.durationMs })) ?? [],
    expected: report?.expected ?? null,
    allFiveClassified: report?.pass === true,
    realModelCriteriaSatisfied: false,
    rawReport: report,
    pass,
  })
  run.check('five mock responses receive their exact classifications', report?.pass === true && report.results.length === 5, JSON.stringify(report))
  run.check('headless JSON run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-500)}`)
}

export default { id, prompt, decide, observe, assert, env: { WEIR_IT_DECISION_SPIKE: 'json' } }
