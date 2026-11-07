// Development-only protocol matrix for managed MCP deferLoading. Each route
// starts with two strictly mounted but unselected servers. A real Apply then
// changes the active schema set, producing the retained addition that supported
// DSH routes require. The mock calls are scripted protocol drivers, never proof
// that a real model discovered a deferred tool.
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { textChunks, toolCallChunks, transcript } from '../mock-kit.js'
import { createMcpRegistry } from '../../../weir-harness/src/capabilities/mcp-registry.js'
import { openCapabilityStore } from '../../../weir-harness/src/capabilities/store/store.js'

const id = 'mcp-defer-loading'
const prompt = 'mcp-defer-loading-probe'
const MODES = ['unsupported', 'addition-only', 'in-history']
const DEFERRED = 'mcp__deferred__echo'
const PLAIN = 'mcp__plain__echo'
const TARGETS = new Set([DEFERRED, PLAIN])

const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
const readJsonl = path => { try { return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch { return [] } }
const modeOf = () => process.env.WEIR_IT_TOOL_UPDATE ?? 'unsupported'
const payloadOf = (mode, kind) => `${kind}_${mode.toUpperCase()}_PAYLOAD`
const resultOf = (mode, identity) => `RESULT server=${identity} origin=managed-${mode}`

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const mode = modeOf()
  const lastTool = obs?.lastTool ?? ''
  if (lastTool.includes('MCP_PROBE error')) return textChunks(`probe halted: ${lastTool.slice(0, 200)}`)
  if (!history.includes(`done apply:${mode}`)) {
    return toolCallChunks('mcp_probe', { op: 'apply', skills: [], mcpServers: ['deferred', 'plain'], _marker: `apply:${mode}` })
  }
  if (!history.includes(resultOf(mode, 'deferred'))) {
    return toolCallChunks(DEFERRED, { text: payloadOf(mode, 'DEFERRED') })
  }
  if (!history.includes(resultOf(mode, 'plain'))) {
    return toolCallChunks(PLAIN, { text: payloadOf(mode, 'PLAIN') })
  }
  if (!history.includes(`done defer-report:${mode}`)) {
    return toolCallChunks('mcp_probe', { op: 'deferReport', _marker: `defer-report:${mode}` })
  }
  return textChunks(`mcp defer protocol ${mode} complete`)
}

function definition(tool) {
  if (!tool) return null
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    hasDeferLoading: Object.hasOwn(tool, 'deferLoading'),
    deferLoading: tool.deferLoading === true,
  }
}

function observe(obs) {
  const history = obs.toolHistory ?? { tools: [], updates: [] }
  return {
    sessionId: obs.sessionId ?? null,
    routeMode: modeOf(),
    deferredTool: definition((obs.toolDefs ?? []).find(tool => tool.name === DEFERRED)),
    plainTool: definition((obs.toolDefs ?? []).find(tool => tool.name === PLAIN)),
    historyTools: (history.tools ?? []).filter(tool => TARGETS.has(tool.name)).map(definition),
    historyAdditions: (history.updates ?? []).flatMap(update => (update.additions ?? [])
      .filter(tool => TARGETS.has(tool.name))
      .map(tool => ({ messageId: update.messageId, definition: definition(tool) }))),
    developerAdditions: (obs.messages ?? []).flatMap(message => message.role === 'developer'
      ? (message.content ?? []).filter(block => block.type === 'tool-addition').map(block => ({ messageId: message.id, toolName: block.toolName }))
      : []),
  }
}

async function seedRegistry(ctx, mode) {
  const ws = join(ctx.IT_ROOT, 'ws')
  const capabilities = join(ctx.IT_ROOT, 'home', 'weir', 'profiles', 'weir-it', 'capabilities')
  rmSync(join(capabilities, 'sessions'), { recursive: true, force: true })
  rmSync(join(capabilities, 'mcp'), { recursive: true, force: true })
  rmSync(join(ws, 'mcp-gateway-report.json'), { force: true })
  mkdirSync(ws, { recursive: true })
  const registry = createMcpRegistry({ store: openCapabilityStore({ profileContext: { home: join(ctx.IT_ROOT, 'home'), name: 'weir-it' } }) })
  for (const identity of ['deferred', 'plain']) {
    const current = await registry.read()
    const outcome = await registry.register({
      identity,
      label: `IT ${identity} server`,
      owner: { kind: 'workspace', key: 'ws' },
      generation: 0,
      configuredAt: 0,
      ...(identity === 'deferred' ? { deferLoading: true } : {}),
      transport: { kind: 'stdio', ref: `mock://${identity}` },
      client: {
        transport: 'stdio', serverName: identity, command: process.execPath,
        args: [fileURLToPath(new URL('../mock-mcp-server.mjs', import.meta.url)), identity],
        env: { WEIR_IT_MCP_LOG: join(ws, 'mcp-server-log.jsonl'), WEIR_IT_MCP_ORIGIN: `managed-${mode}` },
        reconnect: { enabled: true },
      },
    }, current.kind === 'ok' ? current.revision : 0)
    if (outcome.status !== 'committed') throw new Error(`failed to seed ${identity}: ${outcome.status}`)
  }
}

/** Run the default route and both supported DSH toolUpdate modes. */
async function run(ctx) {
  const ws = join(ctx.IT_ROOT, 'ws')
  mkdirSync(ws, { recursive: true })
  rmSync(join(ws, 'mcp-server-log.jsonl'), { force: true })
  rmSync(join(ws, 'mcp-calls.jsonl'), { force: true })
  rmSync(join(ws, '.weir', 'audit.jsonl'), { force: true })
  const traces = {}
  const reports = {}
  const outcomes = []
  for (const mode of MODES) {
    await seedRegistry(ctx, mode)
    const trace = join(ctx.IT_ROOT, `trace-${id}-${mode}.jsonl`)
    rmSync(trace, { force: true })
    const env = ctx.scenarioEnv(id, trace, { WEIR_IT_MCP: '1' })
    delete env.WEIR_IT_TOOL_UPDATE
    if (mode !== 'unsupported') env.WEIR_IT_TOOL_UPDATE = mode
    const outcome = await ctx.spawnHeadless(['weir-it', prompt], env)
    outcomes.push({ mode, ...outcome })
    traces[mode] = trace
    reports[mode] = readJson(join(ws, 'mcp-gateway-report.json'))
  }
  const unsupportedTrace = join(ctx.IT_ROOT, `trace-${id}.jsonl`)
  const supportedTrace = join(ctx.IT_ROOT, `trace-${id}-supported.jsonl`)
  copyFileSync(traces.unsupported, unsupportedTrace)
  writeFileSync(supportedTrace, MODES.slice(1).map(mode => readFileSync(traces[mode], 'utf8')).join(''))
  writeFileSync(join(ws, 'mcp-gateway-report.json'), JSON.stringify({ scenario: id, modes: reports }, null, 2) + '\n')
  return {
    scenario: id,
    trace: unsupportedTrace,
    trace2: supportedTrace,
    code: outcomes.find(outcome => outcome.code !== 0 && outcome.code !== null)?.code ?? 0,
    stdout: outcomes.map(outcome => `[${outcome.mode}]\n${outcome.stdout}`).join('\n'),
    stderr: outcomes.map(outcome => `[${outcome.mode}]\n${outcome.stderr}`).join('\n'),
  }
}

function assert(run) {
  const report = readJson(join(run.ws, 'mcp-gateway-report.json'))
  const serverLog = readJsonl(join(run.ws, 'mcp-server-log.jsonl'))
  const audit = readJsonl(join(run.ws, '.weir', 'audit.jsonl'))
  const requests = [...run.requests, ...run.requests2].filter(request => request.purpose === 'main')

  for (const mode of MODES) {
    const supported = mode !== 'unsupported'
    const modeRequests = requests.filter(request => request.routeMode === mode)
    const afterApply = modeRequests.filter(request => String(request.lastTool ?? '').includes(`done apply:${mode}`))
    const modeReport = report?.modes?.[mode]
    run.check(`${mode}: scripted protocol driver completed`, run.stdout.includes(`mcp defer protocol ${mode} complete`) && modeReport?.completed === true, run.stdout.slice(-600))
    run.check(`${mode}: Apply produces exactly one following provider request`, afterApply.length === 1, JSON.stringify(modeRequests.map(request => ({ seq: request.seq, lastTool: request.lastTool }))).slice(0, 1000))
    const projected = afterApply[0]
    if (!projected) continue

    run.check(`${mode}: deferred and default tools both reach the provider with full object schemas`, projected.deferredTool?.parameters?.type === 'object' && projected.plainTool?.parameters?.type === 'object', JSON.stringify({ deferred: projected.deferredTool, plain: projected.plainTool }).slice(0, 1000))
    run.check(`${mode}: deferred marker projection matches route support`, projected.deferredTool?.deferLoading === supported && projected.deferredTool?.hasDeferLoading === supported, JSON.stringify(projected.deferredTool))
    run.check(`${mode}: default false server never acquires a marker`, projected.plainTool?.deferLoading === false && projected.plainTool?.hasDeferLoading === false, JSON.stringify(projected.plainTool))

    const developerAddition = (projected.developerAdditions ?? []).find(addition => addition.toolName === DEFERRED)
    const historyAddition = (projected.historyAdditions ?? []).find(addition => addition.definition?.name === DEFERRED)
    if (supported) {
      run.check(`${mode}: retained tool-addition and full definition history share one message`, developerAddition && historyAddition && developerAddition.messageId === historyAddition.messageId, JSON.stringify({ developerAddition, historyAddition }))
      run.check(`${mode}: retained addition carries the deferred marker and full schema`, historyAddition?.definition?.deferLoading === true && historyAddition.definition.parameters?.type === 'object', JSON.stringify(historyAddition))
    } else {
      run.check(`${mode}: unsupported projection fabricates no developer tool-change update`, (projected.developerAdditions ?? []).length === 0, JSON.stringify(projected.developerAdditions))
    }

    const updates = modeReport?.protocol?.developerUpdates ?? []
    const update = updates.find(entry => entry.additions.includes(DEFERRED))
    const linkedHeader = (modeReport?.protocol?.requestHeaders ?? []).find(header => header.seq === update?.headerSeq)
    const linkedDefinition = linkedHeader?.tools?.find(tool => tool.name === DEFERRED)
    run.check(`${mode}: native addition headerSeq links to a header containing the full deferred definition`, Number.isSafeInteger(update?.headerSeq) && linkedDefinition?.parameters?.type === 'object' && linkedDefinition.deferLoading === true, JSON.stringify({ update, linkedHeader }).slice(0, 1200))

    const registry = modeReport?.registry ?? {}
    run.check(`${mode}: registry preserves opt-in true and default absence without stock-client leakage`, registry.deferred?.deferLoading === true && registry.deferred?.hasDeferLoading === true && registry.plain?.hasDeferLoading === false && Object.values(registry).every(entry => entry.clientHasDeferLoading === false), JSON.stringify(registry))
    run.check(`${mode}: both real managed servers completed strict mount`, ['deferred', 'plain'].every(identity => (modeReport?.listing?.managed ?? []).some(entry => entry.identity === identity && entry.state === 'mounted')), JSON.stringify(modeReport?.listing?.managed ?? []).slice(0, 1000))

    for (const [identity, toolName, kind] of [['deferred', DEFERRED, 'DEFERRED'], ['plain', PLAIN, 'PLAIN']]) {
      const payload = payloadOf(mode, kind)
      const rpc = serverLog.filter(entry => entry.kind === 'mcp-server-rpc' && entry.method === 'tools/call' && entry.origin === `managed-${mode}` && entry.server === identity && entry.params?.arguments?.text === payload)
      run.check(`${mode}: ${identity} executed its real stdio tools/call with the scripted payload`, rpc.length === 1, JSON.stringify(rpc).slice(0, 600))
      run.check(`${mode}: ${identity} returned its real RPC result to the next model request`, modeRequests.some(request => String(request.lastTool ?? '').includes(resultOf(mode, identity))), '')
    }

    const sessionId = projected.sessionId
    const facts = audit.filter(entry => entry.session === sessionId && (entry.type === 'weir/tool-usage/request' || entry.type === 'weir/tool-usage/result'))
    const requestFact = facts.find(entry => entry.type === 'weir/tool-usage/request' && entry.data?.seq === linkedHeader?.seq)
    run.check(`${mode}: local request audit measures the linked header and one deferred schema`, requestFact?.data?.provider === 'mock' && requestFact.data.model === 'mock-1' && requestFact.data.schemaCount > 1 && requestFact.data.deferredCount === 1 && requestFact.data.schemaBytes > requestFact.data.deferredSchemaBytes && requestFact.data.deferredSchemaBytes > 0, JSON.stringify(requestFact))
    run.check(`${mode}: local request audit uses only its whitelisted count/byte fields`, requestFact && JSON.stringify(Object.keys(requestFact.data).sort()) === JSON.stringify(['seq', 'provider', 'model', 'schemaCount', 'deferredCount', 'schemaBytes', 'deferredSchemaBytes'].sort()), JSON.stringify(requestFact))
    for (const toolName of [DEFERRED, PLAIN]) {
      const resultFact = facts.find(entry => entry.type === 'weir/tool-usage/result' && entry.data?.name === toolName)
      run.check(`${mode}: ${toolName} has a successful correlated local result audit`, resultFact?.data?.isError === false && typeof resultFact.data.callId === 'string' && resultFact.data.callId.length > 0 && JSON.stringify(Object.keys(resultFact.data).sort()) === JSON.stringify(['name', 'isError', 'callId'].sort()), JSON.stringify(resultFact))
    }
    const wire = JSON.stringify(facts)
    run.check(`${mode}: local tool-usage facts leak no prompt, schema description, arguments or result payload`, !wire.includes(prompt) && !wire.includes('echo from') && !wire.includes(payloadOf(mode, 'DEFERRED')) && !wire.includes(payloadOf(mode, 'PLAIN')) && !wire.includes('RESULT server='), wire.slice(0, 1000))
  }
  run.check('all three headless matrix routes exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-800)}`)
}

export default { id, prompt, decide, observe, run, assert, env: { WEIR_IT_MCP: '1' } }
