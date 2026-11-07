// Disposable decision-agent P0 runtime probes. Never mounted by the product bundle.
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { randomUUID } from 'node:crypto'

export const name = 'weir-it-decision-spike-probe'
export const inject = ['tools']

const MODE = process.env.WEIR_IT_DECISION_SPIKE
const ROOT = process.env.WEIR_IT_ROOT
const EVENTS = process.env.WEIR_DECISION_SPIKE_EVENTS ?? join(ROOT ?? '.', 'decision-spike-events.jsonl')

function appendEvent(record) {
  mkdirSync(dirname(EVENTS), { recursive: true })
  appendFileSync(EVENTS, JSON.stringify({ time: Date.now(), ...record }) + '\n')
}

function writeReport(file, value) {
  if (!ROOT) throw new Error('WEIR_IT_ROOT is required')
  const path = join(ROOT, 'ws', file)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

function render(args, value) {
  return [{ type: 'text', text: `DECISION_SPIKE ${value?.completed ? `done ${args?._marker ?? ''}` : 'error'}:${JSON.stringify(value)}` }]
}

function registerOrderProbe(ctx) {
  ctx.on('user-questions/request', async (request, next) => {
    if (!request?.questions?.some(question => question.id === 's1-order')) return next()
    const answers = request.questions.map(question => ({ id: question.id, selected: [question.options.at(-1).label] }))
    appendEvent({ spike: 'S1', listener: 'prepend', questionIds: request.questions.map(question => question.id), answer: { answers } })
    return { answers }
  }, { prepend: true })
}

function registerDelegatedProbe(ctx) {
  let waterfallHits = 0
  ctx.on('user-questions/request', (request, next) => {
    waterfallHits++
    appendEvent({ spike: 'S2', listener: 'observer', waterfallHits, questionIds: request?.questions?.map(question => question.id) ?? [] })
    return next()
  })
  const registerConsult = scope => scope.tools.register({
    name: 'decision_consult',
    description: 'Disposable delegated-consult root-resolution probe.',
    parameters: { type: 'object', properties: { question: { type: 'string' }, request_id: { type: 'string' } }, required: ['question'] },
    output: { schema: { type: 'object' }, render },
    async execute(args, exec) {
      const agent = exec.agent
      const header = agent?.session?.header
      if ((header?.delegationDepth ?? 0) < 1) throw new Error('S2 consult probe requires a delegated child')
      const query = scope.get('sessionQuery')
      if (!query) throw new Error('sessionQuery unavailable')
      const lineage = await query.traceSession(agent.id)
      if (lineage.complete !== true) throw new Error('delegated lineage is incomplete')
      const rootSessionId = lineage.root.header.id
      const report = {
        completed: true,
        outcome: 'awaiting_user',
        case: {
          caseId: `dc_spike_${args.request_id ?? 's2'}`,
          rootSessionId,
          originSessionId: agent.id,
          originKind: 'delegated',
          parentSession: header.parentSession ?? null,
          state: 'awaiting_user',
        },
        waterfallHits,
      }
      writeReport('decision-spike-consult.json', report)
      appendEvent({ spike: 'S2', listener: 'consult', ...report })
      return report
    },
  })
  registerConsult(ctx)
  ctx.on('agent/created', ({ agent }) => {
    if ((agent?.session?.header?.delegationDepth ?? 0) < 1) return
    // Weir intentionally denies the inherited ask tool in children. Register a
    // disposable own-scope adapter so this spike reaches the REAL service guard
    // instead of being stopped earlier by that unrelated product policy.
    agent.ctx.tools.register({
      name: 'ask_user_question',
      description: 'Disposable child-scoped adapter over the real userQuestions.ask guard.',
      parameters: { type: 'object', properties: { questions: { type: 'array', items: { type: 'object' } } }, required: ['questions'] },
      output: { schema: { type: 'object' }, render: (args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
      async execute(args, exec) {
        try {
          const questions = agent.ctx.get('userQuestions')
          if (!questions) throw new Error('userQuestions unavailable')
          return { answer: await questions.ask({ questions: args.questions, agent: exec.agent, signal: exec.signal }) }
        } catch (error) {
          return { error: { code: error?.code ?? null, message: error?.message ?? String(error) } }
        }
      },
    })
    registerConsult(agent.ctx)
  })
}

function cleanJson(text) {
  let cleaned = text.trim()
  const fenced = cleaned.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i)
  if (fenced) cleaned = fenced[1].trim()
  const start = cleaned.indexOf('{')
  const end = cleaned.lastIndexOf('}')
  if (start >= 0 && end >= start) cleaned = cleaned.slice(start, end + 1)
  return cleaned
}

function classifyPayload(text, finish, knownEvidenceIds) {
  if (finish?.kind === 'max-tokens') return { classification: 'truncated' }
  if (finish?.kind === 'error') return { classification: 'model_error', code: finish.failure?.code ?? null }
  if (finish?.kind === 'aborted') return { classification: 'aborted' }
  try {
    const value = JSON.parse(cleanJson(text))
    const claims = value?.claims
    const evidenceIds = Array.isArray(claims) ? claims.flatMap(claim => Array.isArray(claim?.evidenceIds) ? claim.evidenceIds : []) : []
    const valid = value?.outcome === 'answer' && Array.isArray(claims) && claims.length > 0 && Array.isArray(value?.answers) && evidenceIds.every(id => knownEvidenceIds.includes(id))
    if (!valid) return { classification: 'invalid_output' }
    return { classification: 'answer', value }
  } catch (error) {
    return { classification: 'invalid_output', error: error?.message ?? String(error) }
  }
}

function registerJsonProbe(ctx) {
  ctx.tools.register({
    name: 'decision_json_spike',
    description: 'Disposable five-case strict-JSON sidecar classification probe.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: { type: 'object' }, render },
    async execute() {
      const llm = ctx.get('llm')
      if (!llm) throw new Error('llm unavailable')
      const results = []
      for (const fixture of ['valid', 'fenced', 'truncated', 'non-json', 'unknown-evidence']) {
        const started = performance.now()
        let text = ''
        let finish = null
        let thrown = null
        try {
          for await (const chunk of llm.stream({
            provider: 'mock', model: 'mock-1', temperature: 0, maxTokens: 1600,
            system: 'Decision evaluator contract v1\nReturn only the specified JSON envelope.',
            messages: [{ role: 'user', content: [{ type: 'text', text: `FIXTURE:${fixture}` }] }],
          })) {
            if (chunk.type === 'text-delta') text += chunk.text
            if (chunk.type === 'finish') finish = chunk.reason
          }
        } catch (error) {
          thrown = { message: error?.message ?? String(error), code: error?.code ?? null }
        }
        results.push({ fixture, durationMs: performance.now() - started, rawText: text, finish, thrown, ...classifyPayload(text, finish, ['ev_known']) })
      }
      const expected = { valid: 'answer', fenced: 'answer', truncated: 'truncated', 'non-json': 'invalid_output', 'unknown-evidence': 'invalid_output' }
      const report = { completed: true, results, expected, pass: results.every(result => result.classification === expected[result.fixture]) }
      writeReport('decision-spike-json-report.json', report)
      return report
    },
  })
}

function registerMultiMountProbe(ctx) {
  ctx.tools.register({
    name: 'decision_multi_mount_spike',
    description: 'Disposable simultaneous weir/weir-creative preset and per-session waterfall probe.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: { type: 'object' }, render },
    async execute() {
      const registry = ctx.get('agentPresets')
      const agents = ctx.get('agents')
      const questions = ctx.get('userQuestions')
      if (!registry || !agents || !questions) throw new Error('agentPresets/agents/userQuestions required')
      const cwd = join(ROOT, 'ws')
      const handles = []
      const claims = []
      const sessions = []
      try {
        for (const preset of ['weir', 'weir-creative']) {
          const resolved = await registry.resolve(preset)
          if (resolved.broken) throw new Error(`${preset}: ${resolved.broken}`)
          const sessionId = randomUUID()
          const handle = await agents.create({
            sessionId,
            meta: { cwd, agentPreset: preset },
            setup: agentCtx => registry.mount(agentCtx, preset).then(() => undefined),
          })
          handles.push(handle)
          const agent = handle.agent
          agent.ctx.on('user-questions/request', (request, next) => {
            if (request?.questions?.[0]?.id !== `s8-${preset}`) return next()
            claims.push({ requestSessionId: agent.id, listenerSessionId: agent.id, preset, questionId: request.questions[0].id })
            return { answers: [{ id: request.questions[0].id, selected: [`answered-by-${preset}`] }] }
          }, { prepend: true })
          const compositions = registry.inspectCompositions(agent.ctx)
          sessions.push({ preset, sessionId, headerPreset: agent.session.header.agentPreset ?? null, recordedPreset: registry.presetForSession(agent.session) ?? null, composedPreset: registry.composedPreset(agent.ctx), compositionCount: compositions.length, compositionIds: compositions.map(entry => entry.id ?? null), compositionKeys: compositions.map(entry => Object.keys(entry).sort()), broken: resolved.broken ?? null })
        }
        for (const session of sessions) {
          const handle = handles.find(item => item.agent.id === session.sessionId)
          const questionId = `s8-${session.preset}`
          const answer = await questions.ask({ agent: handle.agent, questions: [{ id: questionId, question: `Owner for ${session.preset}?`, options: [{ label: `answered-by-${session.preset}` }, { label: 'wrong-owner' }] }] })
          session.answer = answer
          session.claimCount = claims.filter(claim => claim.requestSessionId === session.sessionId).length
          session.crossSessionClaims = claims.filter(claim => claim.requestSessionId === session.sessionId && claim.listenerSessionId !== session.sessionId).length
        }
        const report = { completed: true, sessions, claims, realmErrors: [], pass: sessions.every(session => session.headerPreset === session.preset && session.compositionIds.includes(session.preset) && session.claimCount === 1 && session.crossSessionClaims === 0 && session.answer?.answers?.[0]?.selected?.[0] === `answered-by-${session.preset}`) }
        writeReport('decision-spike-multi-mount.json', report)
        return report
      } catch (error) {
        const report = { completed: false, sessions, claims, realmErrors: [String(error?.message ?? error)], pass: false }
        writeReport('decision-spike-multi-mount.json', report)
        return report
      } finally {
        for (const handle of handles.reverse()) await handle.dispose()
      }
    },
  })
}

function registerCancelProbe(ctx) {
  let askController = null
  ctx.on('user-questions/request', (request, next) => {
    if (request?.questions?.[0]?.id !== 's6-abort') return next()
    appendEvent({ spike: 'S6', listener: 'abort-request' })
    askController?.abort()
    return next()
  }, { prepend: true })
  ctx.tools.register({
    name: 'decision_cancel_spike',
    description: 'Disposable two-process abort, cancellation, persistence and idempotency probe.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: { type: 'object' }, render },
    async execute(args, exec) {
      const storePath = join(ROOT, 'ws', 'decision-spike-cancel-store.json')
      const readStore = () => JSON.parse(readFileSync(storePath, 'utf8'))
      const writeStore = store => {
        const temp = `${storePath}.tmp`
        writeFileSync(temp, JSON.stringify(store, null, 2) + '\n')
        renameSync(temp, storePath)
      }
      const replay = store => {
        const existing = store.cases.find(item => item.idempotencyKey === 's6-idempotency')
        if (existing) return { case: existing, created: false, attemptCount: store.attempts.length }
        const created = { caseId: 'dc_s6', idempotencyKey: 's6-idempotency', state: 'evaluating', answer: null }
        store.cases.push(created)
        store.attempts.push({ attemptId: 'da_s6', caseId: created.caseId, outcome: null, failure: null, endedAt: null })
        writeStore(store)
        return { case: created, created: true, attemptCount: store.attempts.length }
      }
      if (process.env.WEIR_IT_DECISION_PHASE === 'after') {
        const store = readStore()
        const beforeAttempts = store.attempts.length
        const replayed = replay(store)
        const report = {
          completed: true, phase: 'after', store,
          replay: { created: replayed.created, beforeAttempts, afterAttempts: store.attempts.length, terminal: replayed.case.state },
          pass: store.askAbort?.code === 'ASK_ABORTED' && store.cases[0]?.state === 'closed(cancelled)' && store.cases[0]?.answer === null && store.attempts[0]?.failure === 'interrupted' && !replayed.created && store.attempts.length === beforeAttempts,
        }
        writeReport('decision-spike-cancel-after.json', report)
        return report
      }
      const questions = ctx.get('userQuestions')
      const llm = ctx.get('llm')
      if (!questions || !llm) throw new Error('userQuestions and llm required')
      askController = new AbortController()
      let askAbort = null
      try {
        await questions.ask({ agent: exec.agent, questions: [{ id: 's6-abort', question: 'Abort this pending request', options: [{ label: 'A' }] }], signal: askController.signal })
      } catch (error) {
        askAbort = { code: error?.code ?? null, message: error?.message ?? String(error) }
      } finally {
        askController = null
      }
      writeStore({ askAbort, cases: [], attempts: [] })
      const initial = replay(readStore())
      const attemptController = new AbortController()
      const stream = (async () => {
        let finish = null
        for await (const chunk of llm.stream({
          provider: 'mock', model: 'mock-1', signal: attemptController.signal,
          system: 'Decision evaluator contract v1',
          messages: [{ role: 'user', content: [{ type: 'text', text: 'FIXTURE:hang' }] }],
        })) {
          if (chunk.type === 'finish') finish = chunk.reason
        }
        return finish
      })()
      const deadline = Date.now() + 5000
      while ((!existsSync(EVENTS) || !readFileSync(EVENTS, 'utf8').includes('"listener":"llm-hang"')) && Date.now() < deadline) await new Promise(resolvePromise => setTimeout(resolvePromise, 10))
      if (Date.now() >= deadline) throw new Error('mock llm.stream did not reach its in-flight state')
      const store = readStore()
      const cancel = ({ caseId }) => {
        const target = store.cases.find(item => item.caseId === caseId)
        if (!target || target.state !== 'evaluating') throw new Error('cancel guard rejected the Case')
        target.state = 'closed(cancelled)'
        target.answer = null
        const attempt = store.attempts.find(item => item.caseId === caseId && item.endedAt === null)
        if (attempt) {
          attempt.outcome = 'failed'
          attempt.failure = 'interrupted'
          attempt.endedAt = Date.now()
        }
        attemptController.abort()
        writeStore(store)
        return target
      }
      const cancelled = cancel({ caseId: 'dc_s6' })
      const finish = await stream
      const beforeAttempts = store.attempts.length
      const replayed = replay(store)
      const before = {
        completed: true, phase: 'before', askAbort, initialAttemptCount: initial.attemptCount,
        cancel: { caseId: cancelled.caseId, state: cancelled.state }, llmFinish: finish,
        replay: { created: replayed.created, beforeAttempts, afterAttempts: store.attempts.length }, store,
        pass: askAbort?.code === 'ASK_ABORTED' && cancelled.state === 'closed(cancelled)' && finish?.kind === 'aborted' && store.attempts[0]?.failure === 'interrupted' && !replayed.created && store.attempts.length === 1,
      }
      writeReport('decision-spike-cancel-before.json', before)
      return before
    },
  })
}
export function apply(ctx) {
  if (MODE === 'order') registerOrderProbe(ctx)
  if (MODE === 'delegated') registerDelegatedProbe(ctx)
  if (MODE === 'json') registerJsonProbe(ctx)
  if (MODE === 'multi-mount') registerMultiMountProbe(ctx)
  if (MODE === 'cancel') registerCancelProbe(ctx)
}
