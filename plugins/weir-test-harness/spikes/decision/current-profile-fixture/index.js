// Disposable current-profile P0 Host fixture. All state/evidence stays in-lane.
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'
import { P0SpikeStore } from './store.js'
import { runRealSamples } from './real-samples.js'
import { userTextMessage } from '../../../../../plugins/weir-harness/src/shared/user-message.js'

const HERE = import.meta.dirname
const LANE = resolve(HERE, '../../../../..')
const SPIKES = join(LANE, '.weir', 'decision-spikes')
const OUT = join(SPIKES, 'current-desktop')
const SERVICE = 'weirDecisionP0R2'
const NAMESPACE = 'weirDecisionP0R2'
const PACKAGE = 'weir-decision-p0-spike-r2'
const METHODS = ['state', 'setSelector', 'feedback', 'decide', 'seedActions', 'seedRecovery', 'runRealSamples', 'modelRoutes', 'inspectSlots', 'createTestSession', 'createSubagent', 'sessionScan', 'exportSubagent']

function writeEvidence(spike, file, value) {
  const target = join(SPIKES, spike, file)
  mkdirSync(dirname(target), { recursive: true })
  writeFileSync(target, JSON.stringify(value, null, 2) + '\n')
}

function contribution() {
  return {
    package: PACKAGE, face: 'host', schemas: [], model: { services: [], events: [], objects: [] },
    invocations: METHODS.map(method => ({
      id: `${PACKAGE}.${NAMESPACE}.${method}`, service: SERVICE, namespace: NAMESPACE, method,
      invocation: { kind: 'direct' },
      parameters: [{ name: 'args', wire: 'args', source: 'json', codec: { mode: 'src-json' } }],
      result: { mode: 'src-json' },
    })),
  }
}

export const name = 'weir-decision-p0-current-profile'
export const inject = ['llm', 'typert', 'cordisInspect']

export async function apply(ctx) {
  mkdirSync(OUT, { recursive: true })
  const previousEnv = Object.fromEntries(['WEIR_IT_SCENARIO', 'WEIR_IT_ROOT', 'WEIR_IT_TRACE', 'WEIR_IT_DECISION_SPIKES'].map(key => [key, process.env[key]]))
  process.env.WEIR_IT_SCENARIO = 'decision-spike-current'
  process.env.WEIR_IT_DECISION_SPIKES = '1'
  process.env.WEIR_IT_ROOT = join(OUT, 'it')
  process.env.WEIR_IT_TRACE = join(OUT, 'mock-trace.jsonl')
  const mock = await import('../../../src/mock-llm.js')
  mock.apply(ctx)
  const store = new P0SpikeStore(ctx, join(OUT, 'decision.db'), join(OUT, 'runtime.jsonl'))
  const handles = []
  writeEvidence('current-desktop', `host-${process.pid}.json`, {
    pid: process.pid, execPath: process.execPath, electron: process.versions.electron, node: process.versions.node,
    profile: ctx.get('profileContext'), dbPath: join(OUT, 'decision.db'), recovery: store.recovery,
  })

  const service = {
    async hook(input) { return store.hook(input) },
    async consult(agent, args) { return store.consult(agent, args) },
    async state(args) { return store.state(args.sessionId) },
    async setSelector(args) { return store.setSelector(await store.rootOf(args.sessionId), args.mode) },
    async feedback(args) { return store.feedback(args.caseId, args.kind) },
    async decide(args) { return store.decide(args.caseId, args.answers) },
    async seedActions(args) { return store.seedActions(await store.rootOf(args.sessionId)) },
    async seedRecovery(args) { return store.seedRecovery(await store.rootOf(args.sessionId)) },
    async runRealSamples(args) {
      return runRealSamples(ctx, {
        provider: args.provider ?? 'deepseek-account', model: args.model ?? 'deepseek-flash',
        outPath: join(SPIKES, 'S5', 'real-samples.json'),
      })
    },
    async modelRoutes() {
      const llm = ctx.get('llm')
      const providers = llm.listProviders()
      const models = {}
      for (const provider of providers) models[provider.id] = await llm.listModels(provider.id)
      return { providers, models }
    },
    async inspectSlots(args) {
      const agent = ctx.get('agents').get(args.sessionId)
      if (!agent) throw new Error(`inspectSlots requires live root agent ${args.sessionId}`)
      const roots = {}
      for (const root of ['sidebar.panellist', 'main', 'conversation.input.right']) {
        roots[root] = await ctx.cordisInspect.query('client', 'Slots', 'listSubTree', { root }, agent, new AbortController().signal)
      }
      const snapshot = { phase: args.phase, sessionId: args.sessionId, roots }
      writeEvidence('S4a', `slot-tree-${args.phase}.json`, snapshot)
      if (args.phase === 'after') {
        const before = (await import('node:fs')).existsSync(join(SPIKES, 'S4a', 'slot-tree-before.json'))
          ? JSON.parse((await import('node:fs')).readFileSync(join(SPIKES, 'S4a', 'slot-tree-before.json'), 'utf8')) : null
        writeEvidence('S4a', 'slot-tree.json', { before, after: snapshot, pass: before !== null })
      }
      return { completed: true, roots }
    },
    async createTestSession(args) {
      const registry = ctx.get('agentPresets')
      const sessionId = randomUUID()
      const handle = await ctx.get('agents').create({
        sessionId,
        meta: { cwd: LANE, agentPreset: 'decision-p0' },
        agentOptions: { provider: 'mock', model: 'mock-1' },
        setup: agentCtx => registry.mount(agentCtx, 'decision-p0').then(() => undefined),
      })
      handles.push(handle)
      await store.setSelector(sessionId, args.mode === 'off' ? 'off' : 'agent')
      await handle.agent.followup(userTextMessage(args.prompt, 'weir-decision-p0'))
      const result = { sessionId, mode: args.mode, prompt: args.prompt }
      writeEvidence('current-desktop', `test-session-${args.mode}.json`, result)
      return result
    },
    async createSubagent(args) {
      const parent = ctx.get('agents').get(args.sessionId)
      if (!parent) throw new Error(`createSubagent requires live parent ${args.sessionId}`)
      const activation = await ctx.get('subagents').startActivation({
        provider: 'spawn', label: 'P0 subagent remote proof',
        request: {
          cwd: LANE, parent, agentPreset: 'decision-p0', agentOptions: { provider: 'mock', model: 'mock-1' },
          prompt: [{ type: 'text', text: 'P0_SUBAGENT\nCall decision_consult once, then report the result.' }],
        },
        signal: AbortSignal.timeout(60_000), delivery: 'caller',
      })
      const result = await activation.result
      const proof = { childId: activation.childId, parentSessionId: args.sessionId, stopReason: result.stopReason }
      writeEvidence('current-desktop', 'subagent.json', proof)
      await activation.dispose()
      return proof
    },
    async sessionScan(args) {
      const result = await store.scanSession(args.sessionId)
      if (args.phase) writeEvidence('S9', `session-scan-${args.phase}.json`, result)
      return result
    },
    async exportSubagent(args) {
      const state = await store.state(args.sessionId)
      const scan = await store.scanSession(args.sessionId)
      const result = {
        requestedSubagentSessionId: args.sessionId, resolvedRootSessionId: state.rootSessionId,
        caseId: args.caseId, caseVisible: state.cases.some(item => item.caseId === args.caseId),
        remoteState: state, sessionEventCount: scan.eventCount,
        pass: state.cases.some(item => item.caseId === args.caseId) && state.rootSessionId !== args.sessionId,
      }
      writeEvidence('S9', 'subagent-session.json', result)
      return result
    },
  }
  service.typertRemote = Object.freeze({ service, serviceKey: SERVICE, namespace: NAMESPACE })
  Object.freeze(service)
  const unregisterService = ctx.root.reflect.provide(SERVICE, service)
  const endpointLive = () => Boolean(ctx.typert.local?.get?.(`${NAMESPACE}/state`))
  if (!endpointLive()) ctx.typert.register(contribution())

  ctx.on('dispose', async () => {
    unregisterService?.()
    for (const [key, value] of Object.entries(previousEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    store.close()
    for (const handle of handles.reverse()) await handle.dispose()
  })
}
