// Isolated Desktop QA Host fixture: real Weir sessions, mock route and log scans only.
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { userTextMessage } from '../../../../../plugins/weir-harness/src/shared/user-message.js'
import { applyGuiAdapter } from './adapter.js'

export const name = 'weir-decision-gui-fixture'
export const inject = ['llm', 'typert', 'agents', 'agentPresets', 'sessionQuery', 'userQuestions']

const SERVICE = 'weirDecisionGuiFixture'
const NAMESPACE = 'weirDecisionGuiFixture'
const METHODS = ['createSession', 'scanSession', 'hostState', 'decisionConfig', 'askNative']

function contribution() {
  return {
    package: 'weir-decision-gui-fixture', face: 'host', schemas: [], model: { services: [], events: [], objects: [] },
    invocations: METHODS.map(method => ({
      id: `weir-decision-gui-fixture.${method}`, service: SERVICE, namespace: NAMESPACE, method,
      invocation: { kind: 'direct' },
      parameters: [{ name: 'args', wire: 'args', source: 'json', codec: { mode: 'src-json' } }],
      result: { mode: 'src-json' },
    })),
  }
}

export async function apply(ctx) {
  const out = process.env.WEIR_DECISION_GUI_OUT
  if (!out) throw new Error('WEIR_DECISION_GUI_OUT is required for the isolated QA fixture')
  mkdirSync(out, { recursive: true })
  if (process.env.WEIR_DECISION_PRODUCT_UX === '1') {
    applyGuiAdapter(ctx, out)
  } else {
    const mock = await import('../../../src/mock-llm.js')
    mock.apply(ctx)
  }
  ctx.on('tools/execute', async (exec, next) => {
    if (exec.name === 'ask_user_question') {
      appendFileSync(join(out, 'stock-tool-calls.jsonl'), `${JSON.stringify({ phase: 'before-decision-hook', at: Date.now(), pid: process.pid, sessionId: exec.agent?.id ?? exec.agent?.session?.id ?? null, callId: exec.callId, name: exec.name, arguments: exec.arguments })}\n`)
    }
    const result = await next()
    if (process.env.WEIR_DECISION_PRODUCT_UX !== '1' || exec.name !== 'decision_consult' || exec.arguments?.request_id !== 'gui_b_decide' || result.isError) return result
    writeFileSync(join(out, 'consult-result-held.json'), `${JSON.stringify({ callId: exec.callId, pid: process.pid, at: Date.now() })}\n`)
    const release = join(out, 'consult-result.release')
    const deadline = Date.now() + 60_000
    while (!existsSync(release)) {
      if (exec.signal.aborted) return result
      if (Date.now() >= deadline) throw new Error('consult result hold timed out')
      await new Promise(resolve => setTimeout(resolve, 50))
    }
    return result
  })
  const handles = []
  const host = () => ({
    pid: process.pid, parentPid: process.ppid, execPath: process.execPath, electron: process.versions.electron,
    node: process.versions.node, profile: ctx.get('profileContext'), out,
    env: { HOME: process.env.HOME, DSH_HOME: process.env.DSH_HOME, DSH_AGENTS_HOME: process.env.DSH_AGENTS_HOME },
  })
  writeFileSync(join(out, 'host.json'), JSON.stringify(host(), null, 2) + '\n')

  const service = {
    async hostState() { return host() },
    async decisionConfig() {
      const broker = ctx.root.get('weirDecisionBroker')
      if (typeof broker?.config !== 'function') throw new Error('decisionConfig requires the live root Decision Broker')
      const settings = ctx.root.get('weirSettings')
      const brokerSettings = broker.ctx?.get?.('weirSettings')
      return {
        effective: broker.config(),
        section: settings?.get('decisionAgent') ?? null,
        brokerSection: brokerSettings?.get('decisionAgent') ?? null,
        decisionEnv: { enabled: process.env.WEIR_DECISION_GUI_ENABLED, selectorDefault: process.env.WEIR_DECISION_GUI_SELECTOR_DEFAULT, shadow: process.env.WEIR_DECISION_GUI_SHADOW, autoAnswer: process.env.WEIR_DECISION_GUI_AUTO_ANSWER, timeoutMs: process.env.WEIR_DECISION_GUI_TIMEOUT_MS },
      }
    },
    async createSession(args) {
      const cwd = args.cwd
      if (typeof cwd !== 'string' || !cwd) throw new Error('createSession cwd is required')
      const sessionId = randomUUID()
      const registry = ctx.get('agentPresets')
      const handle = await ctx.get('agents').create({
        sessionId,
        meta: { cwd, agentPreset: 'weir' },
        agentOptions: { provider: 'mock', model: 'mock-1' },
        setup: agentCtx => registry.mount(agentCtx, 'weir').then(() => undefined),
      })
      handles.push(handle)
      if (args.prompt) await handle.agent.followup(userTextMessage(args.prompt, 'weir-decision-gui'))
      return { sessionId, cwd, preset: 'weir' }
    },
    async askNative(args) {
      const handle = handles.find(item => item.agent.id === args.sessionId)
      if (!handle) throw new Error('askNative requires a live root session created by this fixture')
      if (!Array.isArray(args.questions) || args.questions.length === 0) throw new Error('askNative questions are required')
      return ctx.get('userQuestions').ask({ agent: handle.agent, questions: args.questions })
    },
    async scanSession(args) {
      const snapshot = await ctx.get('sessionQuery').readSession(args.sessionId)
      const events = snapshot.events.map(event => ({ seq: event.seq, type: event.type, ignorable: event.ignorable === true, callId: event.data?.callId ?? event.data?.message?.source?.callId ?? null, toolName: event.data?.name ?? null, ...(event.type === 'tool/call' ? { data: event.data } : {}) }))
      // Bounded user-message text: a delivered ruling is a user/message whose
      // source names the deciding surface, and its text is the only proof the
      // conclusion reached the source conversation.
      const messageText = (data) => {
        const content = data?.content
        if (typeof content === 'string') return content.slice(0, 400)
        if (Array.isArray(content)) return content.map(part => typeof part === 'string' ? part : typeof part?.text === 'string' ? part.text : '').filter(Boolean).join(' ').slice(0, 400)
        return ''
      }
      const userMessages = snapshot.events.filter(event => event.type === 'user/message').map(event => ({ seq: event.seq, source: event.data?.source?.kind ?? null, text: messageText(event.data) }))
      return {
        sessionId: args.sessionId, eventCount: events.length, events, userMessages,
        commandEvents: events.filter(event => event.type === 'command/run' || event.type === 'command/done'),
        customDecisionEvents: events.filter(event => event.type.startsWith('weir/') || event.type.startsWith('decision/')),
        stockAskCalls: events.filter(event => event.type === 'tool/call' && event.toolName === 'ask_user_question'),
      }
    },
  }
  service.typertRemote = Object.freeze({ service, serviceKey: SERVICE, namespace: NAMESPACE })
  Object.freeze(service)
  const unregister = ctx.root.reflect.provide(SERVICE, service)
  if (!ctx.typert.local?.get?.(`${NAMESPACE}/hostState`)) ctx.typert.register(contribution())
  ctx.on('dispose', async () => {
    unregister?.()
    for (const handle of handles.reverse()) await handle.dispose()
  })
}
