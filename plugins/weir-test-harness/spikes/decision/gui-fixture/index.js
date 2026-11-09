// Isolated Desktop QA Host fixture: real Weir sessions, mock route and log scans only.
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { userTextMessage } from '../../../../../plugins/weir-harness/src/shared/user-message.js'
import { applyGuiAdapter } from './adapter.js'

export const name = 'weir-decision-gui-fixture'
export const inject = ['llm', 'typert', 'agents', 'agentPresets', 'sessionQuery', 'userQuestions']

const SERVICE = 'weirDecisionGuiFixture'
const NAMESPACE = 'weirDecisionGuiFixture'
const METHODS = ['createSession', 'scanSession', 'hostState', 'askNative']

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
  })
  writeFileSync(join(out, 'host.json'), JSON.stringify(host(), null, 2) + '\n')

  const service = {
    async hostState() { return host() },
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
      const events = snapshot.events.map(event => ({ seq: event.seq, type: event.type, ignorable: event.ignorable === true, callId: event.data?.callId ?? event.data?.message?.source?.callId ?? null, toolName: event.data?.name ?? null }))
      return {
        sessionId: args.sessionId, eventCount: events.length, events,
        commandEvents: events.filter(event => event.type === 'command/run' || event.type === 'command/done'),
        customDecisionEvents: events.filter(event => event.type.startsWith('weir/') || event.type.startsWith('decision/')),
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
