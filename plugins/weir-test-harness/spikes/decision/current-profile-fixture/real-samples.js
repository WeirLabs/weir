// P0-S5: twenty actual provider calls through the current authenticated Desktop Host.
import { writeFileSync } from 'node:fs'

const QUESTIONS = [
  'Use concise or detailed commit subjects?', 'Use English or Chinese for template text?',
  'Use a sidebar page or a modal for management?', 'Use one transaction or separate writes?',
  'Use an explicit error or silent fallback?', 'Use a local or remote authority store?',
  'Use a full answer batch or partial replacement?', 'Use user evidence or an inferred preference?',
  'Use a pinned Agent or automatic reassignment?', 'Use a persistent inbox or a transient notice?',
  'Use a strict schema or permissive JSON?', 'Use a cancellation record or an invented answer?',
  'Use a scoped correction or a global rule?', 'Use a read-only detail or editable history?',
  'Use a root-session selector or a child override?', 'Use current observation or stale evidence?',
  'Use a typed failure or an uncategorized exception?', 'Use a bounded context pack or the full database?',
  'Use a user-only feedback action or agent-written feedback?', 'Use a native question card or a synthetic user message?',
]

function clean(text) {
  let value = text.trim()
  const fenced = value.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i)
  if (fenced) value = fenced[1].trim()
  const start = value.indexOf('{')
  const end = value.lastIndexOf('}')
  if (start >= 0 && end >= start) value = value.slice(start, end + 1)
  return value
}

function classify(text, finish, thrown, timedOut) {
  if (timedOut) return { classification: 'timeout' }
  if (finish?.kind === 'max-tokens') return { classification: 'truncated' }
  if (finish?.kind === 'error' || thrown) return { classification: 'model_error', failure: finish?.failure ?? thrown }
  try {
    const value = JSON.parse(clean(text))
    const claims = value?.claims
    const ids = Array.isArray(claims) ? claims.flatMap(claim => claim?.evidenceIds ?? []) : []
    if (!['answer', 'return', 'escalate'].includes(value?.outcome) || !Array.isArray(claims) || claims.length === 0 || !ids.every(id => id === 'ev_real')) return { classification: 'invalid_output' }
    return { classification: value.outcome, value }
  } catch (error) {
    return { classification: 'invalid_output', failure: { message: error?.message ?? String(error) } }
  }
}

export async function runRealSamples(ctx, { provider, model, outPath }) {
  const samples = []
  for (let index = 0; index < QUESTIONS.length; index++) {
    const question = QUESTIONS[index]
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('P0 real-sample timeout')), 60_000)
    const started = performance.now()
    let text = ''
    let finish = null
    let thrown = null
    let usage = null
    try {
      for await (const chunk of ctx.llm.stream({
        provider, model, temperature: 0, maxTokens: 1600, signal: controller.signal,
        system: `Decision evaluator contract v1\nReturn only JSON: {"outcome":"answer|return|escalate","claims":[{"text":"...","evidenceIds":["ev_real"]}],"answers":[{"id":"q","selected":["..."]}],"reasonCode":"MISSING_CONTEXT","hint":"..."} when returning. Use only ev_real as evidence. Do not use tools.`,
        messages: [{ role: 'user', content: [{ type: 'text', text: `Real question ${index + 1}: ${question}\nEvidence ev_real: the user previously selected the first listed option for this exact scope. Answer the question or return/escalate if that evidence is insufficient.` }] }],
      })) {
        if (chunk.type === 'text-delta') text += chunk.text
        if (chunk.type === 'finish') finish = chunk.reason
        if (chunk.type === 'usage') usage = chunk.usage
      }
    } catch (error) {
      thrown = { name: error?.name ?? null, code: error?.code ?? null, message: error?.message ?? String(error) }
    } finally {
      clearTimeout(timer)
    }
    const timedOut = controller.signal.aborted
    samples.push({
      index: index + 1, question, provider, model, durationMs: performance.now() - started,
      rawText: text, finish, thrown, usage,
      ...classify(text, finish, thrown, timedOut),
    })
  }
  const failures = samples.filter(sample => ['model_error', 'invalid_output', 'truncated', 'timeout'].includes(sample.classification))
  const allowed = new Set(['answer', 'return', 'escalate', 'model_error', 'invalid_output', 'truncated', 'timeout'])
  const report = {
    spike: 'S5', scope: 'real Desktop Host provider calls', provider, model,
    sampleCount: samples.length, samples, failureCount: failures.length,
    failureRate: failures.length / samples.length,
    unclassified: samples.filter(sample => !allowed.has(sample.classification)),
    pass: samples.length === 20 && samples.every(sample => allowed.has(sample.classification)),
  }
  writeFileSync(outPath, JSON.stringify(report, null, 2) + '\n')
  return { sampleCount: samples.length, failureCount: failures.length, failureRate: report.failureRate, pass: report.pass, outPath }
}
