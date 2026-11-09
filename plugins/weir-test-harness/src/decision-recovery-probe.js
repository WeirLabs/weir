// Live two-process Decision recovery fixtures. Dev-only; never mount in a real profile.
import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readDecisionStore } from './decision-test-kit.js'

export const name = 'weir-it-decision-recovery-probe'
export const inject = ['tools']

const PINS = {
  agentProfileRevision: 1, userDescriptionRevision: 1, generatedDescriptionRevision: 0,
  memorySnapshotId: null, promptVersion: 'evaluator-contract/1', evaluatorVersion: 'sidecar/1',
  modelRoute: { kind: 'inherited', provider: 'mock', model: 'mock-1' }, budgetTokens: 24000,
}
const MANIFEST = { layerSizes: { L0: 0, L1: 0, L2: 0, L3: 0, L4: 0, L5: 0 }, evidenceIds: [], correctionIds: [], omissions: [] }

async function seedCase(broker, agent, agentId, suffix, targetState) {
  const workspaceKey = realpathSync(agent.session.header.cwd)
  const opened = await broker.cases.createCase({
    workspaceKey, rootSessionId: agent.id, originSessionId: 'decision-recovery-origin', originKind: 'root', entry: 'consult', agentId,
    request: { entry: 'consult', questions: [{ id: `decision-recovery-${suffix}`, question: `Recovery fixture ${suffix}` }], excluded: [] },
    scope: { workspaces: [workspaceKey] }, idempotencyKey: `decision-recovery:${suffix}`, maxAttempts: 3,
  })
  let current = await broker.cases.transition({ caseId: opened.case.caseId, expectedState: 'received', expectedRevision: opened.case.revision, state: 'evaluating' })
  const attempt = await broker.attempts.start({ caseId: current.caseId, agentId, pins: PINS, contextPackHash: `recovery-${suffix}`, packManifest: MANIFEST })
  current = broker.cases.getCase(current.caseId)
  if (targetState === 'evaluating') return { caseId: current.caseId, attemptId: attempt.attemptId }
  if (targetState === 'awaiting_user') {
    await broker.attempts.finish(attempt.attemptId, { outcome: 'escalate' })
    current = await broker.cases.transition({ caseId: current.caseId, expectedState: 'evaluating', expectedRevision: current.revision, state: 'awaiting_user', awaitingReason: 'consult_escalate', escalation: { attemptId: attempt.attemptId, missing: ['Recovery waiting fixture'], gaps: [] } })
  } else {
    await broker.attempts.finish(attempt.attemptId, { outcome: 'return', reasonCode: 'MISSING_CONTEXT', hint: 'Recovery revision fixture remains actionable.' })
    current = await broker.cases.transition({ caseId: current.caseId, expectedState: 'evaluating', expectedRevision: current.revision, state: 'awaiting_revision' })
  }
  return { caseId: current.caseId, attemptId: attempt.attemptId }
}

async function snapshot(broker, agent, phase) {
  const store = readDecisionStore(join(process.env.WEIR_IT_ROOT, 'ws'))
  const inbox = await broker.inbox({ sessionId: agent.id })
  const report = JSON.parse(JSON.stringify({ phase, ...store, selector: broker.selector(agent.id), inbox }))
  writeFileSync(join(process.env.WEIR_IT_ROOT, 'ws', `decision-recovery-${phase}.json`), JSON.stringify(report, null, 2) + '\n')
  return report
}

export function apply(ctx, config = {}) {
  if (config.enabled !== true) return
  ctx.tools.register({
    name: 'decision_recovery_probe',
    description: 'Seed or verify isolated recovery fixtures through real Decision domain objects. Dev-only.',
      parameters: { type: 'object', properties: { op: { type: 'string', enum: ['seed', 'verify', 'auto-verify'] } }, required: ['op'] },
    output: {
      schema: { type: 'object' },
      render: (args, value) => [{ type: 'text', text: `DECISION_RECOVERY ${value?.completed ? `done ${args?.op}` : 'error'}:${JSON.stringify(value)}` }],
    },
    async execute(args, exec) {
      try {
        const broker = ctx.get('weirDecisionBroker')
        const agent = exec.agent
        if (!broker?.store || !agent?.id) throw new Error('Open Decision Broker and execution Agent are required')
        if (args.op === 'seed') {
          const agentId = broker.selector(agent.id).agentId
          if (!agentId) throw new Error('Recovery seed requires a pinned Agent')
          const seeded = []
          for (const [suffix, state] of [['waiting', 'awaiting_user'], ['revision', 'awaiting_revision'], ['evaluating', 'evaluating']]) {
            seeded.push({ state, ...await seedCase(broker, agent, agentId, suffix, state) })
          }
          const report = await snapshot(broker, agent, 'before')
          return { completed: true, op: args.op, seeded, report }
        }
        if (args.op === 'verify') {
          const report = await snapshot(broker, agent, 'after')
          return { completed: true, op: args.op, report }
        }
        if (args.op === 'auto-verify') {
          const report = await snapshot(broker, agent, 'auto-after')
          await new Promise(resolve => setTimeout(resolve, 40))
          const later = readDecisionStore(join(process.env.WEIR_IT_ROOT, 'ws'))
          const authority = value => JSON.stringify({
            selectors: value.selectors, cases: value.cases, attempts: value.attempts,
            evidence: value.evidence, feedback: value.feedback, routes: value.routes,
          })
          report.lateStable = authority(report) === authority(later)
          writeFileSync(join(process.env.WEIR_IT_ROOT, 'ws', 'decision-recovery-auto-after.json'), JSON.stringify(report, null, 2) + '\n')
          return { completed: true, op: args.op, report }
        }
        throw new Error(`Unsupported recovery operation: ${args.op}`)
      } catch (error) {
        return { completed: false, op: args.op, error: error?.message ?? String(error) }
      }
    },
  })
}
