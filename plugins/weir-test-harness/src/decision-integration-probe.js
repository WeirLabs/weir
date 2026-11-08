// Live Decision Agent integration fixtures. Dev-only; never mount in a real profile.
import { existsSync, mkdirSync, realpathSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'weir-it-decision-integration-probe'
export const inject = ['tools']

function render(args, value) {
  const status = value?.completed ? `done ${args?.op ?? ''}` : 'error'
  return [{ type: 'text', text: `DECISION_TEST ${status}:${JSON.stringify(value)}` }]
}

export function apply(ctx, config = {}) {
  if (config.enabled !== true) return
  ctx.tools.register({
    name: 'decision_integration_probe',
    description: 'Create isolated Decision Agent fixtures through the real Broker. Dev-only integration probe.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['setup', 'record', 'route-setup', 'disable-a', 'case-for-call', 'feedback', 'correction', 'isolation-setup', 'select', 'cross-consult'] },
        caseId: { type: 'string' }, agentId: { type: 'string' }, verb: { type: 'string' }, text: { type: 'string' },
        direction: { type: 'string' }, scope: { type: 'object' }, supersedes: { type: 'array', items: { type: 'string' } },
        questions: { type: 'array', items: { type: 'object' } },
        question: { type: 'string' }, otherWorkspace: { type: 'string' },
      },
      required: ['op'],
    },
    output: { schema: { type: 'object' }, render },
    async execute(args, exec) {
      try {
        const broker = ctx.get('weirDecisionBroker')
        const agent = exec.agent
        if (!broker || !agent?.id) throw new Error('Decision Broker and execution Agent are required')
        if (args.op === 'record') {
          const record = await broker.record({ sessionId: agent.id, caseId: args.caseId })
          const inbox = await broker.inbox({ sessionId: agent.id })
          return JSON.parse(JSON.stringify({ completed: true, op: args.op, caseId: args.caseId, record, inbox }))
        }
        if (args.op === 'case-for-call') {
          const record = await broker.caseForCall({ sessionId: agent.id, questions: args.questions })
          return JSON.parse(JSON.stringify({ completed: true, op: args.op, record }))
        }
        if (args.op === 'feedback') {
          const result = await broker.feedback({ caseId: args.caseId, verb: args.verb, ...(args.text === undefined ? {} : { payload: { text: args.text } }) })
          return JSON.parse(JSON.stringify({ completed: true, op: args.op, result, case: broker.cases.getCase(args.caseId) }))
        }
        if (args.op === 'correction') {
          const result = await broker.correction({ caseId: args.caseId, direction: args.direction, scope: args.scope, supersedes: args.supersedes })
          return JSON.parse(JSON.stringify({ completed: true, op: args.op, result, case: broker.cases.getCase(args.caseId) }))
        }
        if (args.op === 'isolation-setup') {
          const workspaceKey = realpathSync(agent.session.header.cwd)
          const otherWorkspace = join(workspaceKey, 'decision-isolation-other')
          mkdirSync(otherWorkspace, { recursive: true })
          const otherWorkspaceKey = realpathSync(otherWorkspace)
          const scope = { workspaces: [workspaceKey], authorizationClasses: ['A', 'B', 'C'] }
          const agentA = await broker.profileUpsert({ workspaceKey, name: 'Decision Isolation A', scope, userDescription: 'A private profile marker must never reach Agent B.', modelRoute: { chain: [] } })
          const agentB = await broker.profileUpsert({ workspaceKey, name: 'Decision Isolation B', scope, userDescription: 'B has an independent namespace and no prior decision.', modelRoute: { chain: [] } })
          const agentC = await broker.profileUpsert({ workspaceKey: otherWorkspaceKey, name: 'Decision Isolation W2', scope: { workspaces: [otherWorkspaceKey], authorizationClasses: ['A', 'B', 'C'] }, userDescription: 'W2 has no W1 evidence.', modelRoute: { chain: [] } })
          await broker.setSelector(agent.id, 'agent', agentA.agentId)
          return { completed: true, op: args.op, agentA: agentA.agentId, agentB: agentB.agentId, agentC: agentC.agentId, workspaceKey, otherWorkspace: otherWorkspaceKey }
        }
        if (args.op === 'select') {
          const selector = await broker.setSelector(agent.id, 'agent', args.agentId)
          return { completed: true, op: args.op, selector }
        }
        if (args.op === 'cross-consult') {
          const header = agent.session.header
          const crossAgent = {
            id: agent.id,
            session: {
              header: { ...header, cwd: args.otherWorkspace },
              requestContext: () => agent.session.requestContext(),
            },
          }
          const result = await broker.consult({ agent: crossAgent, args: { question: args.question, options: [{ label: 'W2 native' }, { label: 'W1 answer' }], agent_id: args.agentId, request_id: 'isolation-cross' }, signal: exec.signal })
          return JSON.parse(JSON.stringify({ completed: true, op: args.op, result }))
        }
        if (args.op === 'route-setup') {
          const workspaceKey = realpathSync(agent.session.header.cwd)
          const scope = { workspaces: [workspaceKey], authorizationClasses: ['A', 'B', 'C'] }
          const agentA = await broker.profileUpsert({ workspaceKey, name: 'Decision Route A', scope, userDescription: 'For a pinned Decision Route request, select Pinned A.', modelRoute: { chain: [] } })
          const agentB = await broker.profileUpsert({ workspaceKey, name: 'Decision Route B', scope, userDescription: 'For an explicit Decision Route consultation, select Explicit B.', modelRoute: { chain: [] } })
          await broker.setSelector(agent.id, 'agent', agentA.agentId)
          return { completed: true, op: args.op, agentA: agentA.agentId, agentB: agentB.agentId, selector: broker.selector(agent.id) }
        }
        if (args.op === 'disable-a') {
          const profile = await broker.profileSetState(args.agentId, 'disabled')
          return { completed: true, op: args.op, agentId: profile.agentId, state: profile.state, selector: broker.selector(agent.id) }
        }
        if (args.op !== 'setup') throw new Error(`Unsupported Decision probe operation: ${args.op}`)
        const cwd = agent.session?.header?.cwd
        if (typeof cwd !== 'string') throw new Error('Session cwd is required')
        const databasePath = broker.databasePath()
        const before = {
          storeExistedBeforeSetup: existsSync(databasePath),
          storeOpenBeforeSetup: Boolean(broker.store),
        }
        const workspaceKey = realpathSync(cwd)
        const profile = await broker.profileUpsert({
          workspaceKey,
          name: `Decision ${process.env.WEIR_IT_SCENARIO ?? 'integration'} QA`,
          scope: { workspaces: [workspaceKey], authorizationClasses: ['A', 'B', 'C'] },
          userDescription: 'For Decision Hook QA, prefer the Concise title when that option is available.',
          modelRoute: { chain: [] },
        })
        await broker.setSelector(agent.id, 'agent', profile.agentId)
        return {
          completed: true,
          op: args.op,
          ...before,
          databasePath,
          workspaceKey,
          rootSessionId: agent.id,
          agentId: profile.agentId,
          selector: broker.selector(agent.id),
        }
      } catch (error) {
        return { completed: false, op: args.op, error: error?.message ?? String(error) }
      }
    },
  })
}
