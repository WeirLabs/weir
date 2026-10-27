import { test, expect } from './helpers.js'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  MCP_INSTALL_APPROVE_LABEL,
  MCP_INSTALL_CONFIRMATION_TIMEOUT_MS,
  MCP_INSTALL_PARAMETERS,
  createMcpInstallTool,
  mcpInstallApproved,
} from '../src/capabilities/mcp-install-tool.js'
import { createMcpOperations } from '../src/capabilities/mcp-operations.js'
import { createMcpRegistry } from '../src/capabilities/mcp-registry.js'
import { createMcpRuntime } from '../src/capabilities/mcp-runtime.js'
import { createMcpDrain } from '../src/capabilities/mcp-drain.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { normalizeMcpServer } from '../src/capabilities/mcp-config.js'
import { sameMutationOwner } from '../src/capabilities/capability-remote.js'
import { CHILD_DENY_TOOLS } from '../src/shared/child-scope.js'
import { createSkillSelectionPlugin } from '../src/capabilities/skill-selection-plugin.js'

const plan = (identity = 'docs') => ({
  identity, label: `Docs ${identity}`, transport: 'stdio', command: process.execPath,
  args: ['--stdio', { ref: 'MCP_CLI_TOKEN' }], env: { TOKEN: { ref: 'USER_TOKEN' } },
})

function harness(options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'weir-mcp-install-tool-'))
  const store = openCapabilityStore({ root, platform: 'darwin' })
  const registry = createMcpRegistry({ store })
  const runtime = createMcpRuntime()
  const drain = createMcpDrain()
  const calls = { preview: 0, ask: 0, mutate: 0, probe: 0, mount: 0, credentialSet: 0 }
  const questions = []
  const timers = []
  const cleared = []
  const audit = []
  let currentOwner = {
    owner: { presetId: 'weir', cwd: root }, feed: {}, profile: { home: root, name: 'it' },
  }
  let retained
  let namespaceConflict = null
  const manager = {
    support: () => ({ credentials: true, ephemeral: true }),
    serverNameConflict: () => namespaceConflict,
    beginOperation(identity, phase) {
      const token = runtime.begin(identity, { phase })
      drain.closeAll(identity)
      return token
    },
    abortOperation(token) {
      const restored = runtime.restore(token)
      if (restored && token.previous?.phase === 'mounted') drain.reopenAll(token.identity)
      return restored
    },
    async probe() {
      calls.probe += 1
      const status = options.probeStatus ?? 'mounted'
      return status === 'mounted'
        ? { status, discovery: { toolCount: 0, toolNamesPreview: [], truncated: false }, cleanup: { status: 'cleaned' } }
        : { status, saved: false, error: { code: 'timeout', message: 'injected probe failure' } }
    },
    async reconcileOne(identity, entry, token) {
      calls.mount += 1
      const status = options.mountStatus ?? 'mounted'
      if (status === 'mounted') {
        runtime.finish(token, 'mounted', { generation: entry.generation, incarnation: entry.incarnation })
        drain.reopenAll(identity)
        return { status, mount: { state: 'mounted', observedGeneration: entry.generation }, discovery: { toolCount: 1, toolNamesPreview: ['mcp__docs__echo'], truncated: false } }
      }
      runtime.finish(token, status, { generation: entry.generation, incarnation: entry.incarnation })
      return { status, saved: true, error: { code: 'connection-refused', message: 'injected mount failure' } }
    },
  }
  const credentials = {
    async set() { calls.credentialSet += 1 },
    async unset() {},
    async resolve(ref) { return { value: `resolved-${ref}` } },
  }
  const baseOperations = createMcpOperations({
    registry, manager, credentials,
    audit: (_session, type, data) => audit.push({ type, data }),
  })
  const operations = {
    ...baseOperations,
    async preview(request) { calls.preview += 1; return baseOperations.preview(request) },
  }
  const agent = {
    id: 's1',
    session: { id: 's1', header: { cwd: root, delegationDepth: options.depth ?? 0 } },
  }
  const controller = new AbortController()
  const exec = { agent, signal: controller.signal }
  let liveRoot = true
  let liveChecks = 0
  const questionService = {
    async ask(request) {
      calls.ask += 1
      questions.push(request)
      if (options.ask) return options.ask(request)
      return { answers: [{ id: request.questions[0].id, selected: [MCP_INSTALL_APPROVE_LABEL] }] }
    },
  }
  const tool = createMcpInstallTool({
    operationsFor: () => operations,
    mutate: async (_sessionId, request) => {
      calls.mutate += 1
      return options.mutate ? options.mutate(request) : baseOperations.installFromAgent(request)
    },
    captureOwnership: async () => currentOwner,
    sameOwnership: sameMutationOwner,
    describeExecution: async entry => ({ requestedCommand: entry.client.command, resolvedCommand: '/resolved/node', argumentCount: entry.client.args.length }),
    userQuestions: () => options.noProvider ? undefined : questionService,
    isLiveRoot: () => {
      liveChecks += 1
      if (options.loseLivenessAfterAnswer) return liveChecks === 1
      return options.liveRoot ?? liveRoot
    },
    storePlan: stored => { retained = stored; return retained },
    setTimeout: (fn, ms) => { const handle = { fn, ms }; timers.push(handle); return handle },
    clearTimeout: handle => { cleared.push(handle); handle.cleared = true },
  })
  return {
    root, store, registry, runtime, manager, operations, tool, exec, agent, calls, questions, timers, cleared, audit,
    setOwner: value => { currentOwner = value },
    owner: () => currentOwner,
    retained: () => retained,
    setNamespaceConflict: value => { namespaceConflict = value },
    setLiveRoot: value => { liveRoot = value },
  }
}

async function externalRegister(h, identity) {
  const current = await h.registry.read()
  const entry = normalizeMcpServer({ identity, label: identity, transport: 'stdio', command: process.execPath }, { surface: 'refs' }).entry
  return h.registry.register(entry, current.revision ?? 0)
}

function expectNoExecution(h) {
  expect(h.calls.mutate).toBe(0)
  expect(h.calls.probe).toBe(0)
  expect(h.calls.mount).toBe(0)
  expect(h.calls.credentialSet).toBe(0)
}

test('schema is object-rooted, refs-only, bounded and denied to every delegated child', async () => {
  expect(MCP_INSTALL_PARAMETERS.type).toBe('object')
  expect(MCP_INSTALL_PARAMETERS.additionalProperties).toBe(false)
  expect(MCP_INSTALL_PARAMETERS.properties.plan.additionalProperties).toBe(false)
  expect(MCP_INSTALL_PARAMETERS.properties.plan.properties.args.maxItems).toBe(128)
  expect(Object.hasOwn(MCP_INSTALL_PARAMETERS.properties, 'confirmed')).toBe(false)
  expect(Object.hasOwn(MCP_INSTALL_PARAMETERS.properties.plan.properties, 'secretValues')).toBe(false)
  expect(CHILD_DENY_TOOLS).toContain('mcp_install')

  for (const action of ['preview', 'install']) {
    const h = harness({ depth: 1 })
    const result = await h.tool.execute({ action, plan: plan() }, h.exec)
    expect(result.status).toBe('unsupported')
    expect(result.error.code).toBe('DELEGATED_CALLER')
    expect(result.next.action).toBe('delegate-to-parent-orchestrator')
    expect(h.calls.ask).toBe(0)
    expectNoExecution(h)
  }
})

test('preview is redacted and inert; literal secrets and existing identities never reach confirmation', async () => {
  const h = harness()
  const preview = await h.tool.execute({ action: 'preview', plan: plan() }, h.exec)
  expect(preview.status).toBe('preview')
  expect(preview.plan).toHaveLength(1)
  expect(preview.digest).toMatch(/^[a-f0-9]{64}$/)
  expect(preview.targets[0].conflict).toBeNull()
  expect(h.calls.ask).toBe(0)
  expectNoExecution(h)
  expect((await h.registry.read()).kind).toBe('absent')

  const literal = await h.tool.execute({ action: 'preview', plan: { ...plan(), env: { TOKEN: 'raw-secret' } } }, h.exec)
  expect(literal.status).toBe('validation-failed')
  expect(JSON.stringify(literal)).not.toContain('raw-secret')
  expectNoExecution(h)

  await externalRegister(h, 'docs')
  const conflict = await h.tool.execute({ action: 'install', plan: plan() }, h.exec)
  expect(conflict.status).toBe('conflict')
  expect(h.calls.ask).toBe(0)
  expect(h.calls.mutate).toBe(0)
})

test('exact Host approval probes then mounts the stored plan and leaves selection/default untouched', async () => {
  const h = harness()
  await h.store.commit({ kind: 'selection', sessionId: 's1' }, 0, () => ({ skills: [], mcpServers: ['other'], origin: 'apply' }))
  const result = await h.tool.execute({ action: 'install', plan: plan() }, h.exec)
  expect(result.status).toBe('mounted')
  expect(result.generation).toBe(1)
  expect(result.incarnation).toBeTruthy()
  expect(result.discovery.toolCount).toBe(1)
  expect(result.next).toEqual({ action: 'select-and-apply' })
  expect(h.calls.ask).toBe(1)
  expect(h.calls.mutate).toBe(1)
  expect(h.calls.probe).toBe(1)
  expect(h.calls.mount).toBe(1)
  expect(h.questions[0].agent).toBe(h.agent)
  expect(h.questions[0].questions).toHaveLength(1)
  const detail = h.questions[0].questions[0].detail
  expect(detail).toContain(h.retained().digest)
  expect(detail).toContain('Resolved executable: /resolved/node')
  expect(detail).toContain('Default for new sessions: off')
  expect(detail).toContain('Exact redacted plan:')
  expect(h.timers[0].ms).toBe(MCP_INSTALL_CONFIRMATION_TIMEOUT_MS)
  expect(h.cleared).toContain(h.timers[0])
  const current = await h.registry.read()
  expect(current.enabled).toEqual([])
  expect((await h.store.read({ kind: 'selection', sessionId: 's1' })).payload.mcpServers).toEqual(['other'])
})

test('failed probe does not register; saved-degraded and post-write owner changes stay honest', async () => {
  const failed = harness({ probeStatus: 'probe-failed' })
  const probe = await failed.tool.execute({ action: 'install', plan: plan() }, failed.exec)
  expect(probe.status).toBe('probe-failed')
  expect(probe.saved).toBe(false)
  expect((await failed.registry.read()).kind).toBe('absent')
  expect(failed.calls.mount).toBe(0)

  const degraded = harness({ mountStatus: 'saved-degraded' })
  const saved = await degraded.tool.execute({ action: 'install', plan: plan() }, degraded.exec)
  expect(saved.status).toBe('saved-degraded')
  expect(saved.saved).toBe(true)
  expect(saved.succeeded).toBe(false)

  const changed = harness({ mutate: async () => ({ status: 'owner-changed', saved: true, generation: 1, registryRevision: 1 }) })
  const owner = await changed.tool.execute({ action: 'install', plan: plan() }, changed.exec)
  expect(owner).toEqual({ status: 'owner-changed', saved: true, generation: 1, registryRevision: 1 })
})

test('custom text, extra selections, extra answers and rejection never probe or write', async () => {
  const answers = [
    { answers: [{ id: 'mcp-install-confirmation', selected: [MCP_INSTALL_APPROVE_LABEL], custom: 'yes but change it' }] },
    { answers: [{ id: 'mcp-install-confirmation', selected: [MCP_INSTALL_APPROVE_LABEL, 'Cancel'] }] },
    { answers: [
      { id: 'mcp-install-confirmation', selected: [MCP_INSTALL_APPROVE_LABEL] },
      { id: 'extra', selected: ['Cancel'] },
    ] },
    { answers: [{ id: 'mcp-install-confirmation', selected: ['Cancel'] }] },
  ]
  for (const answer of answers) {
    const h = harness({ ask: async () => answer })
    const result = await h.tool.execute({ action: 'install', plan: plan() }, h.exec)
    expect(result.status).toBe('cancelled')
    expectNoExecution(h)
  }
  expect(mcpInstallApproved(answers[0], 'mcp-install-confirmation')).toBe(false)
})

test('close, no provider, and caller liveness failures stop before execution', async () => {
  const closed = harness({ ask: async () => { throw Object.assign(new Error('closed'), { code: 'ASK_CANCELLED' }) } })
  expect((await closed.tool.execute({ action: 'install', plan: plan() }, closed.exec)).status).toBe('cancelled')
  expectNoExecution(closed)

  const noProvider = harness({ noProvider: true })
  const unsupported = await noProvider.tool.execute({ action: 'install', plan: plan() }, noProvider.exec)
  expect(unsupported.status).toBe('unsupported')
  expect(unsupported.error.code).toBe('NO_PROVIDER')
  expectNoExecution(noProvider)

  const notLive = harness({ liveRoot: false })
  const stale = await notLive.tool.execute({ action: 'install', plan: plan() }, notLive.exec)
  expect(stale.status).toBe('owner-changed')
  expect(stale.error.code).toBe('CALLER_NOT_LIVE')
  expect(notLive.calls.ask).toBe(0)
  expectNoExecution(notLive)

  const lost = harness({ loseLivenessAfterAnswer: true })
  const lostResult = await lost.tool.execute({ action: 'install', plan: plan() }, lost.exec)
  expect(lostResult.status).toBe('owner-changed')
  expect(lost.calls.ask).toBe(1)
  expectNoExecution(lost)
})

test('five-minute combined timeout is the first settlement and cannot be overridden by a later answer', async () => {
  let answer
  const h = harness({ ask: () => new Promise(resolve => { answer = resolve }) })
  const pending = h.tool.execute({ action: 'install', plan: plan() }, h.exec)
  while (h.calls.ask === 0) await new Promise(resolve => setImmediate(resolve))
  expect(h.timers[0].ms).toBe(300000)
  h.timers[0].fn()
  const result = await pending
  expect(result.status).toBe('cancelled')
  expect(result.error.code).toBe('confirmation-timeout')
  expectNoExecution(h)
  answer({ answers: [{ id: 'mcp-install-confirmation', selected: [MCP_INSTALL_APPROVE_LABEL] }] })
  await new Promise(resolve => setImmediate(resolve))
  expect(h.calls.mutate).toBe(0)
})

test('tool-signal cancellation and confirmation close produce no execution', async () => {
  const controller = new AbortController()
  const h = harness({ ask: () => new Promise(() => {}) })
  h.exec.signal = controller.signal
  const pending = h.tool.execute({ action: 'install', plan: plan() }, h.exec)
  while (h.calls.ask === 0) await new Promise(resolve => setImmediate(resolve))
  controller.abort(Object.assign(new Error('tool cancelled'), { code: 'ASK_ABORTED' }))
  const result = await pending
  expect(result.status).toBe('cancelled')
  expectNoExecution(h)
})

test('stored plan mutation, ownership changes, registry/identity changes and namespace reservations block execution', async () => {
  for (const kind of ['entry-plan', 'display-plan', 'ownership', 'revision', 'identity', 'namespace']) {
    let answer
    const h = harness({ ask: () => new Promise(resolve => { answer = resolve }) })
    const pending = h.tool.execute({ action: 'install', plan: plan() }, h.exec)
    while (!h.retained()) await new Promise(resolve => setImmediate(resolve))
    if (kind === 'entry-plan') h.retained().entry.label = 'mutated'
    if (kind === 'display-plan') h.retained().plan[0].entry.label = 'mutated'
    if (kind === 'ownership') h.setOwner({ ...h.owner(), feed: {} })
    if (kind === 'revision') await externalRegister(h, 'other')
    if (kind === 'identity') await externalRegister(h, 'docs')
    if (kind === 'namespace') h.setNamespaceConflict('host row now reserves docs')
    answer({ answers: [{ id: 'mcp-install-confirmation', selected: [MCP_INSTALL_APPROVE_LABEL] }] })
    const result = await pending
    if (kind === 'entry-plan' || kind === 'display-plan') expect(result.error.code).toBe('plan-changed')
    else if (kind === 'ownership') expect(result.status).toBe('owner-changed')
    else if (kind === 'namespace') expect(result.status).toBe('conflict')
    else expect(result.status).toBe('revision-conflict')
    expect(h.calls.mutate).toBe(0)
    if (kind !== 'revision' && kind !== 'identity') expectNoExecution(h)
  }
})

test('the existing selection row registers mcp_install without a new package export', () => {
  const registered = []
  const ctx = {
    skills: { registerProvider() {} },
    on() {},
    get(name) {
      if (name === 'tools') return { register: tool => { registered.push(tool); return () => {} } }
      return undefined
    },
    effect(fn) { return fn() },
    logger: { warn() {} },
    emit() {},
  }
  createSkillSelectionPlugin({ office: async () => ({ complete: true, candidates: [] }) })(ctx, { machineId: 'install-tool-test' })
  expect(registered.some(tool => tool.name === 'mcp_install')).toBe(true)
})

test('the confirmation card shows the exact non-secret argv and the plan digest stays stable', async () => {
  const h = harness()
  const argvPlan = { ...plan(), args: ['--port=8080', 'FOO=bar', { ref: 'MCP_CLI_TOKEN' }] }
  const preview = await h.tool.execute({ action: 'preview', plan: argvPlan }, h.exec)
  expect(preview.plan[0].entry.client.args).toEqual(['--port=8080', 'FOO=bar', '[redacted]'])
  const result = await h.tool.execute({ action: 'install', plan: argvPlan }, h.exec)
  expect(result.status, JSON.stringify(result)).toBe('mounted')
  const detail = h.questions[0].questions[0].detail
  expect(detail).toContain('Arguments (exact argv; credential-referenced positions show [redacted]): ["--port=8080","FOO=bar","[redacted]"]')
  expect(detail).not.toContain('--port=[redacted]')
  const stored = (await h.registry.read()).servers.docs
  expect(stored.client.args).toEqual(['--port=8080', 'FOO=bar', ''])
  expect(stored.secretRefs.args[2].ref).toBe('MCP_CLI_TOKEN')
})
