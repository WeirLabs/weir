// Scenario: mcp-gateway — task 8.2+ integration for the Weir-managed MCP
// gateway. A registry-seeded managed server mounts at startup through the
// real loader (isolated group + facade + stock client); the scenario then
// proves: admitted calls reach the server (publicName → identity mapping),
// a removed server refuses with ZERO RPC reaching the process (G3b shape),
// a re-enabled server admits again, a newly created agent sees the tool
// schema and the instruction section only while the server is accepted
// (8.4 creation-time + per-assembly), and adopt of a host-held name is a
// visible conflict with unmanaged labeling (8.8/8.9).
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lastOfRole, shellCall, textChunks, toolCallChunks, transcript } from '../mock-kit.js'
import { createMcpRegistry } from '../../../weir-harness/src/capabilities/mcp-registry.js'
import { openCapabilityStore } from '../../../weir-harness/src/capabilities/store/store.js'

const id = 'mcp-gateway'
const prompt = 'mcp-gateway-probe'

const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
const readJsonl = path => { try { return readFileSync(path, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) } catch { return [] } }

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const lastTool = lastOfRole(options, 'tool')
  const lastUser = obs?.lastUser ?? ''
  // Task-token detection (obs.lastUser is not populated for subagent
  // requests; the parent is excluded by the prompt guard, and the child
  // prompts no longer carry the completion markers).
  const child = marker => history.includes(marker)

  if (!history.includes(prompt)) {
    if (history.includes('RESULT_TWO')) return textChunks('RESULT_TWO')
    if (history.includes('RESULT_ONE')) return textChunks('RESULT_ONE')
    if (history.includes('CHILD_TWO')) {
      if (lastTool.includes('unknown tool') || lastTool.includes('refused')) return textChunks('RESULT_TWO')
      return toolCallChunks('mcp__docs__echo', { text: 'CALL_DENIED' })
    }
    if (history.includes('CHILD_ONE')) {
      if (lastTool.includes('RESULT server=docs')) return textChunks('RESULT_ONE')
      return toolCallChunks('mcp__docs__echo', { text: 'CALL_ONE' })
    }
    return textChunks('child idle turn')
  }

  if (lastTool.includes('MCP_PROBE error') && !lastTool.includes('admission refused')) return textChunks(`probe halted: ${lastTool.slice(0, 200)}`)
  // 1. accept docs
  if (!history.includes('done apply:first')) {
    return toolCallChunks('mcp_probe', { op: 'apply', skills: ['fixture-a'], mcpServers: ['docs'], _marker: 'done apply:first' })
  }
  // 2. admitted call from the root (wrapper admit = true)
  if (!history.includes('RESULT server=docs')) {
    return toolCallChunks('mcp_probe', { op: 'call', name: 'mcp__docs__echo', text: 'CALL_ONE' })
  }
  // 3. a child created WHILE accepted: its creation-time view includes the
  // schema and its call is admitted too.
  if (!history.includes('RESULT_ONE')) {
    return toolCallChunks('subagent', { description: 'accepted-call child', prompt: 'CHILD_ONE\nTASK: call the managed tool mcp__docs__echo with text CALL_ONE and report the outcome\nDELIVERABLE: the outcome\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done', run_in_background: false })
  }
  // 4. remove docs — children are already settled, no invalidation reaches them.
  if (!history.includes('done apply:narrow')) {
    return toolCallChunks('mcp_probe', { op: 'apply', skills: [], mcpServers: [], _marker: 'done apply:narrow' })
  }
  // 5. the wrapper's last-moment refusal: zero RPC, explicit wording.
  if (!history.includes('admission refused')) {
    return toolCallChunks('mcp_probe', { op: 'call', name: 'mcp__docs__echo', text: 'CALL_DENIED' })
  }
  // 6. a child created AFTER the removal: the schema is hidden at creation
  // (8.4③) — the call surfaces as `unknown tool`.
  if (!history.includes('RESULT_TWO')) {
    return toolCallChunks('subagent', { description: 'removed-call child', prompt: 'CHILD_TWO\nTASK: try the managed tool mcp__docs__echo with text CALL_DENIED and report what happens\nDELIVERABLE: the outcome\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done', run_in_background: false })
  }
  if (!history.includes('done apply:reopen')) {
    return toolCallChunks('mcp_probe', { op: 'apply', skills: [], mcpServers: ['docs'], _marker: 'done apply:reopen' })
  }
  if (!history.includes('done adopt')) {
    return toolCallChunks('mcp_probe', { op: 'adopt', identity: 'gamma' })
  }
  if (!history.includes('done list')) {
    return toolCallChunks('mcp_probe', { op: 'list' })
  }
  if (!lastTool.includes('done report')) {
    return toolCallChunks('mcp_probe', { op: 'report' })
  }
  return textChunks('parent observed mcp gateway')
}

function observe(obs) {
  const system = `${obs.system ?? ''}\n${obs.transcript ?? ''}`
  return {
    admissionRefused: (obs.transcript ?? '').includes('admission refused'),
    managedResult: (obs.transcript ?? '').includes('RESULT server=docs'),
    childOne: (obs.transcript ?? '').includes('RESULT_ONE'),
    childTwo: (obs.transcript ?? '').includes('RESULT_TWO'),
    managedToolInRequest: system.includes('mcp__docs__echo'),
    managedInstructions: system.includes('DOCS_MANAGED_INSTRUCTIONS'),
    childSession: (obs.transcript ?? '').includes('CHILD_ONE') || (obs.transcript ?? '').includes('CHILD_TWO'),
  }
}

/** Runner: clean lifecycle/MCP state, seed the registry, single boot. */
async function run(ctx) {
  const ws = join(ctx.IT_ROOT, 'ws')
  const capabilities = join(ctx.IT_ROOT, 'home', 'weir', 'profiles', 'weir-it', 'capabilities')
  rmSync(join(capabilities, 'sessions'), { recursive: true, force: true })
  rmSync(join(capabilities, 'mcp'), { recursive: true, force: true })
  rmSync(join(ws, 'mcp-server-log.jsonl'), { force: true })
  mkdirSync(ws, { recursive: true })
  // Registry seed: the manager mounts this server at startup.
  const registry = createMcpRegistry({ store: openCapabilityStore({ profileContext: { home: join(ctx.IT_ROOT, 'home'), name: 'weir-it' } }) })
  await registry.register({
    identity: 'docs',
    label: 'IT docs server',
    owner: { kind: 'workspace', key: 'ws' },
    generation: 0,
    configuredAt: 0,
    transport: { kind: 'stdio', ref: 'mock://docs' },
    client: {
      transport: 'stdio', serverName: 'docs', command: process.execPath,
      args: [fileURLToPath(new URL('../mock-mcp-server.mjs', import.meta.url)), 'docs'],
      env: { WEIR_IT_MCP_LOG: join(ws, 'mcp-server-log.jsonl'), WEIR_IT_MCP_ORIGIN: 'managed' },
      reconnect: { enabled: true },
    },
  }, 0)
  const trace = join(ctx.IT_ROOT, `trace-${id}.jsonl`)
  const main = await ctx.spawnHeadless(['weir-it', prompt], ctx.scenarioEnv(id, trace, { WEIR_IT_MCP: '1' }))
  return { scenario: id, trace, code: main.code, stdout: main.stdout, stderr: main.stderr }
}

function assert(run) {
  const report = readJson(join(run.ws, 'mcp-gateway-report.json'))
  const calls = readJsonl(join(run.ws, 'mcp-calls.jsonl'))
  const serverLog = readJsonl(join(run.ws, 'mcp-server-log.jsonl'))
  run.check('parent observed the gateway', run.stdout.includes('parent observed mcp gateway'), run.stdout.slice(-400))

  run.check('the admitted managed call reached the server with a RESULT', run.requests.some(r => r.managedResult), JSON.stringify(report ?? null).slice(0, 200))
  const docsRpc = serverLog.filter(entry => entry.server === 'docs' && entry.method === 'tools/call')
  run.check('successful calls registered RPC at the server', docsRpc.length >= 2, JSON.stringify(serverLog.map(entry => [entry.server, entry.method]).slice(-8)))
  const refused = calls.filter(entry => entry.outcome === 'refused')
  run.check('the removed server refused the call with the admission wording', refused.some(entry => String(entry.error ?? '').includes('admission refused')), JSON.stringify(refused).slice(0, 300))
  run.check('a refused call sent ZERO RPC to the server (G3b shape)', refused.every(entry => entry.after === entry.before), JSON.stringify(refused).slice(0, 300))

  const childOne = run.requests.filter(r => r.childOne)
  const childTwo = run.requests.filter(r => r.childTwo)
  // Creation-time visibility proven by OUTCOME: a child created after the
  // acceptance calls successfully (its view includes the schema); a child
  // created after the removal meets `unknown tool` (the schema is hidden at
  // creation, 8.4③) — the instruction section stays with the accepted child.
  run.check('a new agent while accepted sees the tool schema and calls it (8.4③)', childOne.some(r => r.managedResult), '')
  run.check('a new agent while accepted sees the instruction section (8.4②)', childOne.some(r => r.managedInstructions), '')
  run.check('a new agent after removal has the schema hidden (8.4③)', childTwo.some(r => r.admissionRefused || (r.transcript ?? '').includes('unknown tool')), JSON.stringify(childTwo.map(r => [r.managedToolInRequest])).slice(0, 200))

  const listing = report?.listing ?? {}
  run.check('adopt of the host-held name is a visible conflict, never a success', report?.adopt?.status === 'conflict', JSON.stringify(report?.adopt ?? null).slice(0, 300))
  run.check('the host row stays labeled unmanaged (8.8)', (listing.unmanaged ?? []).some(entry => entry.serverName === 'gamma'), JSON.stringify(listing.unmanaged ?? []))
  run.check('the managed server lists as mounted with its generation (8.8)', (listing.managed ?? []).some(entry => entry.identity === 'docs' && entry.state === 'mounted'), JSON.stringify(listing.managed ?? []))
  run.check('the facade bound the public name to the configured identity at registration', (report?.publicNames ?? []).some(([name, identity]) => name === 'mcp__docs__echo' && identity === 'docs'), JSON.stringify(report?.publicNames ?? []))
  run.check('the mock server process actually served RPC', serverLog.some(entry => entry.kind === 'mcp-server-rpc' && entry.method === 'tools/call'), JSON.stringify(serverLog).slice(0, 200))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, run, assert, env: { WEIR_IT_MCP: '1' } }
