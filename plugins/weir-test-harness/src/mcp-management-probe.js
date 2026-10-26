// Dev-only MCP management integration driver. Canary values are read from the
// scenario environment INSIDE the Host, never supplied as tool arguments.
import { randomUUID } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { skillSelectionFor } from '../../weir-harness/src/capabilities/skill-selection-plugin.js'
import * as selectionPlugin from '../../weir-harness/src/capabilities/skill-selection-plugin.js'
import { createMcpRegistry } from '../../weir-harness/src/capabilities/mcp-registry.js'
import { openCapabilityStore } from '../../weir-harness/src/capabilities/store/store.js'
import { mcpGroupOptions } from '../../weir-harness/src/capabilities/mcp-mount.js'
import { createCapabilityMutationService } from '../../weir-harness/src/capabilities/capability-remote.js'
import { redactMcpEntry, hasMcpSecrets } from '../../weir-harness/src/capabilities/mcp-config.js'
import { sanitizeMcpPayload } from '../../weir-harness/src/capabilities/mcp-diagnostics.js'
import { startMockMcpHttpServer } from './mock-mcp-http-server.mjs'
import { IT_ROOT } from './mock-kit.js'

const MOCK_STDIO = fileURLToPath(new URL('./mock-mcp-server.mjs', import.meta.url))
const canary = () => process.env.WEIR_IT_MCP_CANARY ?? 'weir-mcp-canary-primary'
const canaryEdit = () => process.env.WEIR_IT_MCP_CANARY_EDIT ?? 'weir-mcp-canary-edit'
const logPath = () => join(IT_ROOT, 'ws', 'mcp-server-log.jsonl')
const read = path => { try { return readFileSync(path, 'utf8') } catch { return '' } }
const store = ctx => openCapabilityStore({ profileContext: ctx.get('profileContext') })
const registry = ctx => createMcpRegistry({ store: store(ctx) })

function stdioConfig(identity = 'docs') {
  return {
    identity, label: `Managed ${identity}`, command: process.execPath,
    args: [MOCK_STDIO, identity],
    env: { WEIR_IT_MCP_LOG: logPath(), WEIR_IT_MCP_ORIGIN: 'managed', WEIR_IT_CANARY: canary() },
    reconnect: { enabled: true },
  }
}
function httpConfig(identity, url) {
  return { identity, label: `HTTP ${identity}`, transport: 'streamable-http', url, headers: { Authorization: canary() }, toolCallTimeoutMs: 2000 }
}
function aiConfig(identity) {
  return {
    identity, label: `AI ${identity}`, transport: 'stdio', command: process.execPath,
    args: [MOCK_STDIO, identity],
    env: {
      WEIR_IT_MCP_LOG: { ref: 'WEIR_IT_MCP_LOG' },
      WEIR_IT_MCP_ORIGIN: { ref: 'WEIR_IT_MCP_ORIGIN' },
      WEIR_IT_CANARY: { ref: 'WEIR_IT_CANARY' },
    },
    reconnect: { enabled: true },
  }
}

function apply(ctx) {
  selectionPlugin.apply(ctx, { machineId: 'weir-it-machine', readPresetId: 'weir', includeDefaultRoots: false, customSkillDirs: [join(IT_ROOT, 'ws', 'skill-roots')] })
  const responses = []
  const sessionEvents = []
  ctx.on('session/event', (_session, event) => {
    if (String(event?.type).startsWith('command/') || String(event?.type).startsWith('tool/')) sessionEvents.push(JSON.stringify(event))
  })
  const operationsFor = exec => skillSelectionFor(ctx).mcpOperations(exec.agent.session)
  const managerFor = () => ctx.get('weirMcpManager')
  const record = (op, value) => { responses.push({ op: value?._marker ?? op, value }); return value }
  let aiOwned = null
  const lastEntries = new Map()
  const capture = async (ctx, identity) => {
    const current = await registry(ctx).read()
    if (current.servers?.[identity]) lastEntries.set(identity, current.servers[identity])
  }
  const currentRevision = async ctx => (await registry(ctx).read()).revision ?? 0
  const withHttp = async (options, run) => {
    const fixture = await startMockMcpHttpServer(options)
    try { return await run(fixture) } finally { await fixture.close() }
  }
  const withAiAgent = async (exec, run) => {
    if (!aiOwned) {
      const presets = ctx.get('agentPresets')
      if (!presets) throw new Error('real agent preset registry unavailable')
      const unregister = await presets.register({ id: 'weir', plugins: [{ id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' }] })
      try {
        const handle = await ctx.agents.create({
          sessionId: randomUUID(),
          meta: { cwd: exec.agent.session.header.cwd, agentPreset: 'weir' },
          setup: agentCtx => presets.mount(agentCtx, 'weir').then(() => undefined),
        })
        aiOwned = { handle, unregister }
      } catch (cause) { await unregister(); throw cause }
    }
    return run({ ...exec, agent: aiOwned.handle.agent })
  }
  ctx.on('dispose', async () => {
    if (!aiOwned) return
    await aiOwned.handle.dispose()
    await aiOwned.unregister()
    aiOwned = null
  })
  const scan = (ctx, secrets) => {
    const surfaces = {
      registry: read(join(IT_ROOT, 'home', 'weir', 'profiles', 'weir-it', 'capabilities', 'mcp', 'registry.json')),
      profile: ['cordis.yml', 'cordis.patch.yml'].map(name => read(join(IT_ROOT, 'home', 'profiles', 'weir-it', name))).join('\n'),
      residue: [...(ctx.get('loader')?.entries?.() ?? [])].map(entry => JSON.stringify(entry.options ?? {})).join('\n'),
      audit: read(join(IT_ROOT, 'ws', '.weir', 'audit.jsonl')),
      remote: JSON.stringify(responses),
      session: sessionEvents.join('\n'),
    }
    return Object.fromEntries(Object.entries(surfaces).map(([name, text]) => [name, secrets.some(secret => secret && text.includes(secret))]))
  }

  ctx.tools.register({
    name: 'mcp_management_probe',
    description: 'Integration probe for managed MCP lifecycle, HTTP/stdio, ownership and secret containment.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['add', 'edit', 'probe', 'restart', 'remove', 'default', 'list', 'http', 'httpProbe', 'httpFailure', 'httpTimeout', 'remote', 'residue', 'apply', 'call', 'canary', 'report', 'aiSeed', 'aiPreview', 'aiCancel', 'aiApprove', 'replacementFence', 'oldAccess', 'newAccess'] },
        identity: { type: 'string' },
        mode: { type: 'string', enum: ['keep', 'replace', 'add', 'edit'] },
        transport: { type: 'string', enum: ['stdio', 'http'] },
        _marker: { type: 'string' },
        answer: { type: 'string', enum: ['approve', 'custom', 'cancel', 'close', 'extra'] },
      },
      required: ['op'], additionalProperties: false,
    },
    output: {
      schema: { type: 'object' },
      render: (args, value) => [{ type: 'text', text: `MCP_MANAGEMENT ${value.completed ? `done ${args?._marker ?? value.op}` : `error:${String(value.error ?? 'unknown').slice(0, 160)}`}` }],
    },
    async execute(args, exec) {
      const result = { completed: false, op: args.op, _marker: args._marker }
      const identity = args.identity ?? 'docs'
      const manager = managerFor()
      const operations = operationsFor(exec)
      try {
        if (args.op === 'aiSeed') {
          const credentials = ctx.get('credentials')
          if (!credentials?.set) throw new Error('credentials service unavailable')
          await credentials.set('WEIR_IT_MCP_LOG', logPath())
          await credentials.set('WEIR_IT_MCP_ORIGIN', 'managed')
          await credentials.set('WEIR_IT_CANARY', canary())
          return record(args.op, { ...result, completed: true, seeded: true })
        }
        if (args.op === 'aiPreview' || args.op === 'aiCancel' || args.op === 'aiApprove') {
          return withAiAgent(exec, async aiExec => {
            const tool = ctx.tools.get('mcp_install', aiExec.agent)
            if (!tool) throw new Error('mcp_install is unavailable')
            const beforeRevision = await currentRevision(ctx)
            const beforeLog = read(logPath()).length
            const beforeEntries = [...(ctx.get('loader')?.entries?.() ?? [])].length
            process.env.WEIR_IT_MCP_AI_ANSWER = args.op === 'aiApprove' ? 'approve' : args.answer ?? 'custom'
            const outcome = await tool.execute({ action: args.op === 'aiPreview' ? 'preview' : 'install', plan: aiConfig(identity) }, aiExec)
            if (args.op === 'aiApprove') await capture(ctx, identity)
            const current = await registry(ctx).read()
            const selection = skillSelectionFor(ctx)?.lifecycle?.snapshotFor(aiExec.agent.session.id)
            return record(args.op, {
              ...result, completed: true, outcome,
              unchanged: beforeRevision === (current.revision ?? 0) && beforeLog === read(logPath()).length && beforeEntries === [...(ctx.get('loader')?.entries?.() ?? [])].length,
              selection: selection?.mcpServers ?? [], defaults: current.enabled ?? [], registryHasIdentity: Object.hasOwn(current.servers ?? {}, identity),
            })
          })
        }
        if (args.op === 'replacementFence') {
          const original = manager.reconcileOne
          let release
          const before = await manager.gate.admit(exec.agent, identity, (await registry(ctx).read()).servers[identity].generation)
          manager.reconcileOne = async (...args) => {
            await new Promise(resolve => { release = resolve })
            return original(...args)
          }
          try {
            const pending = operations.edit({ identity, expectedRevision: await currentRevision(ctx), config: { label: 'Replacement fence' } })
            while (!release) await new Promise(resolve => setImmediate(resolve))
            const during = await manager.gate.admit(exec.agent, identity, (await registry(ctx).read()).servers[identity].generation)
            release()
            const outcome = await pending
            const after = await manager.gate.admit(exec.agent, identity, outcome.generation)
            return record(args.op, { ...result, completed: true, before, during, after, outcome })
          } finally {
            manager.reconcileOne = original
            release?.()
          }
        }
        if (args.op === 'oldAccess' || args.op === 'newAccess') {
          const current = await registry(ctx).read()
          const entry = current.servers?.[identity]
          const admitted = entry ? await manager.gate.admit(exec.agent, identity, entry.generation) : false
          return record(args.op, { ...result, completed: true, admitted, incarnation: entry?.incarnation ?? null, generation: entry?.generation ?? null })
        }
        if (args.op === 'add') {
          const config = args.transport === 'http' ? null : stdioConfig(identity)
          if (!config) throw new Error('use the http operation for Streamable HTTP')
          const outcome = await operations.add({ identity, config })
          await capture(ctx, identity)
          return record(args.op, { ...result, completed: true, outcome })
        }
        if (args.op === 'http') {
          return withHttp({}, async fixture => {
            const outcome = await operations.add({ identity, config: httpConfig(identity, fixture.url) })
            await capture(ctx, identity)
            return record(args.op, { ...result, completed: true, outcome, httpRequests: fixture.requests.length })
          })
        }
        if (args.op === 'edit') {
          const replace = args.mode === 'replace'
          const config = { label: replace ? 'Edited secret' : 'Edited label', secretValues: { env: { WEIR_IT_CANARY: replace ? { action: 'replace', value: canaryEdit() } : '' } } }
          const outcome = await operations.edit({ identity, expectedRevision: await currentRevision(ctx), config })
          await capture(ctx, identity)
          return record(args.op, { ...result, completed: true, outcome })
        }
        if (args.op === 'probe') {
          const config = stdioConfig(identity)
          const outcome = await operations.test({ identity, config })
          const current = await registry(ctx).read()
          return record(args.op, { ...result, completed: true, outcome, registryKind: current.kind, registryHasIdentity: Object.hasOwn(current.servers ?? {}, identity) })
        }
        if (args.op === 'httpProbe' || args.op === 'httpFailure' || args.op === 'httpTimeout') {
          const options = args.op === 'httpFailure' ? { status: 401 } : args.op === 'httpTimeout' ? { delayMs: 2000 } : { tools: [] }
          return withHttp(options, async fixture => {
            const outcome = await operations.test({ identity, config: httpConfig(identity, fixture.url) })
            const current = await registry(ctx).read()
            return record(args.op, { ...result, completed: true, outcome, registryKind: current.kind, registryHasIdentity: Object.hasOwn(current.servers ?? {}, identity) })
          })
        }
        if (args.op === 'restart') {
          const outcome = await operations.restart({ identity, expectedRevision: await currentRevision(ctx) })
          await capture(ctx, identity)
          return record(args.op, { ...result, completed: true, outcome })
        }
        if (args.op === 'remove') return record(args.op, { ...result, completed: true, outcome: await operations.remove({ identity, expectedRevision: await currentRevision(ctx) }) })
        if (args.op === 'default') return record(args.op, { ...result, completed: true, outcome: await operations.setDefault({ identity, enabled: true, expectedRevision: await currentRevision(ctx) }) })
        if (args.op === 'list') return record(args.op, { ...result, completed: true, listing: await manager.list() })
        if (args.op === 'remote') {
          const service = createCapabilityMutationService({
            observeSession: async id => ({
              source: 'live',
              header: { id, cwd: exec.agent.session.header.cwd, agentPreset: 'weir' },
              projections: { values: { agentPreset: 'weir' } },
              events: typeof exec.agent.session.snapshotEvents === 'function' ? await exec.agent.session.snapshotEvents() : [],
              [Symbol.dispose]() {},
            }),
          })
          const remote = await service.mutate(exec.agent.session.id, { action: 'add', config: stdioConfig(identity) })
          // An unrelated Apply changes selectionSeq but must not change mutation ownership.
          const selection = skillSelectionFor(ctx)
          const current = await store(ctx).read({ kind: 'selection', sessionId: exec.agent.session.id })
          const applied = await selection.applySelection(
            { sessionId: exec.agent.session.id, cwd: exec.agent.session.header.cwd, presetId: 'weir' },
            { requestId: `remote-apply-${Date.now()}`, expectedRevision: current.kind === 'ok' ? current.revision : 0, selection: { skills: [], mcpServers: [identity] }, unresolved: [] },
          )
          return record(args.op, { ...result, completed: true, remote, unrelatedApply: applied.status })
        }
        if (args.op === 'residue') {
          const current = await registry(ctx).read()
          const entry = lastEntries.get(identity) ?? current.servers?.[identity] ?? { ...stdioConfig(identity), generation: 1, configuredAt: 0, owner: { kind: 'global', key: 'installation' }, transport: { kind: 'stdio', ref: 'cmd:node' } }
          const prepared = await manager.prepare(entry)
          const options = mcpGroupOptions({ identity: `crash-${identity}`, generation: entry.generation ?? 1, client: prepared.client })
          for (const child of options.config) child.disabled = true // residue evidence only; no process/network
          await ctx.get('loader').root.create(options)
          const recovery = await manager.recoverResidue()
          return record(args.op, { ...result, completed: true, recovery, canary: scan(ctx, [canary(), canaryEdit()]) })
        }
        if (args.op === 'apply') {
          const selection = skillSelectionFor(ctx)
          const current = await store(ctx).read({ kind: 'selection', sessionId: exec.agent.session.id })
          const outcome = await selection.applySelection(
            { sessionId: exec.agent.session.id, cwd: exec.agent.session.header.cwd, presetId: 'weir' },
            { requestId: `mcp-apply-${Date.now()}`, expectedRevision: current.kind === 'ok' ? current.revision : 0, selection: { skills: [], mcpServers: [identity] }, unresolved: [] },
          )
          return record(args.op, { ...result, completed: true, outcome })
        }
        if (args.op === 'call') {
          const tool = ctx.tools.get('mcp__docs__echo', exec.agent)
          if (!tool) throw new Error('managed tool is unavailable')
          const outcome = await tool.execute({ text: 'MANAGED_CALL' }, exec)
          return record(args.op, { ...result, completed: true, outcome, callObserved: JSON.stringify(outcome).includes('RESULT server=docs') })
        }
        if (args.op === 'canary') return record(args.op, { ...result, completed: true, canary: scan(ctx, [canary(), canaryEdit()]) })
        if (args.op === 'report') {
          const current = await registry(ctx).read()
          const report = {
            responses: sanitizeMcpPayload(responses, [canary(), canaryEdit()]),
            registry: Object.fromEntries(Object.entries(current.servers ?? {}).map(([key, entry]) => [key, redactMcpEntry(entry)])),
            lastEntries: Object.fromEntries([...lastEntries].map(([key, entry]) => [key, redactMcpEntry(entry)])),
            hasSecrets: Object.values(current.servers ?? {}).map(entry => hasMcpSecrets(entry)),
            canary: scan(ctx, [canary(), canaryEdit()]),
            events: sessionEvents.length,
          }
          writeFileSync(join(IT_ROOT, 'ws', 'mcp-management-report.json'), JSON.stringify(report, null, 2) + '\n')
          return { ...result, completed: true, report }
        }
        throw new Error(`unknown op ${args.op}`)
      } catch (cause) {
        return record(args.op, { ...result, error: cause instanceof Error ? cause.message : String(cause) })
      }
    },
  })
}

export const name = 'weir-it-mcp-management-probe'
export const inject = ['tools', 'skills', 'loader', 'agents', 'agentPresets']
export { apply }
