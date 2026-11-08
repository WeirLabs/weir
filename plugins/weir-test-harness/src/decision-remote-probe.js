// Direct live-service mirror of the Decision typert remote (headless has no gateway). Dev-only.
import { realpathSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createDecisionRemoteService, decisionRemoteContribution } from '../../weir-harness/src/decision/remote.js'

export const name = 'weir-it-decision-remote-probe'
export const inject = ['tools']

const CHILD_QUESTION = 'REMOTE_CHILD: escalate a delegated consultation'

function writeReport(name, value) {
  const path = join(process.env.WEIR_IT_ROOT, 'ws', name)
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
  return path
}

async function rootFlow(remote, broker, agent) {
  const calls = {}
  const call = async (method, args) => {
    const result = await remote[method](args)
    calls[method] = result
    return result
  }
  const workspaceKey = realpathSync(agent.session.header.cwd)
  const a = await call('profileUpsert', { sessionId: agent.id, name: 'Decision Remote A', userDescription: 'For REMOTE_ANSWER select Remote A.' })
  const b = await call('profileUpsert', { sessionId: agent.id, name: 'Decision Remote B', userDescription: 'B is an explicit reassignment target.' })
  if (!a.ok || !b.ok) throw new Error(`Remote profile setup failed: ${JSON.stringify({ a, b })}`)
  await call('setSelector', { sessionId: agent.id, mode: 'agent', agentId: a.value.agentId })
  await call('overview', { sessionId: agent.id })
  await call('agents', { sessionId: agent.id })
  await call('agent', { sessionId: agent.id, agentId: a.value.agentId })

  const answered = await broker.consult({ agent, args: { question: 'REMOTE_ANSWER: choose the evidenced answer', options: [{ label: 'Remote A' }, { label: 'Other' }], request_id: 'remote-answered' }, toolCallId: 'remote-answer-call' })
  const waiting = {}
  for (const action of ['decide', 'reassign', 'cancel', 'retry']) {
    waiting[action] = await broker.consult({ agent, args: { question: `REMOTE_${action.toUpperCase()}: needs a new judgment`, options: [{ label: 'User choice' }, { label: 'Other' }], request_id: `remote-${action}` } })
  }
  await call('records', { sessionId: agent.id, filter: {}, cursor: { limit: 100 } })
  await call('record', { sessionId: agent.id, caseId: answered.caseId })
  await call('inbox', { sessionId: agent.id })
  await call('metrics', { sessionId: agent.id, window: 'all' })
  await call('caseForCall', { sessionId: agent.id, questions: [{ id: 'question', question: 'REMOTE_ANSWER: choose the evidenced answer' }] })
  await call('caseForToolCall', { sessionId: agent.id, toolCallId: 'remote-answer-call' })
  await call('feedback', { sessionId: agent.id, caseId: answered.caseId, verb: 'rating_up' })
  await call('correction', { sessionId: agent.id, caseId: answered.caseId, direction: 'Use the corrected remote direction', scope: { workspaces: [workspaceKey] }, supersedes: [answered.caseId] })
  await call('decide', { sessionId: agent.id, caseId: waiting.decide.caseId, answers: [{ id: 'question', selected: ['User choice'] }] })
  await call('reassign', { sessionId: agent.id, caseId: waiting.reassign.caseId, agentId: b.value.agentId })
  await call('cancel', { sessionId: agent.id, caseId: waiting.cancel.caseId })
  await call('retry', { sessionId: agent.id, caseId: waiting.retry.caseId })
  await call('profileSetState', { sessionId: agent.id, agentId: b.value.agentId, state: 'disabled' })
  calls.errorPath = await remote.agent({ sessionId: agent.id, agentId: 'ag_missing' })
  return { calls, fixtures: { agentA: a.value.agentId, agentB: b.value.agentId, answered, waiting } }
}

async function childFlow(remote, agent, caseId) {
  const calls = {
    caseForCall: await remote.caseForCall({ sessionId: agent.id, questions: [{ id: 'question', question: CHILD_QUESTION }] }),
    caseForToolCall: await remote.caseForToolCall({ sessionId: agent.id, toolCallId: 'mock-call-1' }),
    record: await remote.record({ sessionId: agent.id, caseId }),
    inbox: await remote.inbox({ sessionId: agent.id }),
    errorPath: await remote.agent({ sessionId: agent.id, agentId: 'ag_missing_child' }),
  }
  return { calls, childSessionId: agent.id, caseId }
}

export function apply(ctx, config = {}) {
  if (config.enabled !== true) return
  ctx.tools.register({
    name: 'decision_remote_probe',
    description: 'Drive the real Decision remote service with bare root/child session ids. Dev-only.',
    parameters: { type: 'object', properties: { op: { type: 'string', enum: ['root', 'child-read'] }, caseId: { type: 'string' } }, required: ['op'] },
    output: {
      schema: { type: 'object' },
      render: (args, value) => [{ type: 'text', text: `DECISION_REMOTE ${value?.completed ? `done ${args?.op}` : 'error'}:${JSON.stringify(value)}` }],
    },
    async execute(args, exec) {
      try {
        const broker = ctx.get('weirDecisionBroker')
        const agent = exec.agent
        if (!broker || !agent?.id) throw new Error('Decision Broker and execution Agent are required')
        const remote = createDecisionRemoteService({ broker: () => broker })
        const report = args.op === 'root' ? await rootFlow(remote, broker, agent) : await childFlow(remote, agent, args.caseId)
        const contribution = decisionRemoteContribution()
        const noAgentLookup = contribution.invocations.every(invocation => !JSON.stringify(invocation).includes('lookup'))
        const path = writeReport(args.op === 'root' ? 'decision-ui-remote-report.json' : 'decision-ui-remote-child.json', { ...report, noAgentLookup })
        return { completed: true, op: args.op, path, noAgentLookup }
      } catch (error) {
        return { completed: false, op: args.op, error: error?.message ?? String(error) }
      }
    },
  })
}
