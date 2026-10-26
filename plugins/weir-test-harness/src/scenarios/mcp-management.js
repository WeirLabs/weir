// Scenario: mcp-management — real stdio + loopback HTTP lifecycle, strict
// probes, incarnation/default behavior, remote ownership and secret canary.
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { lastOfRole, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'mcp-management'
const prompt = 'mcp-management-probe'
const steps = [
  ['add', { op: 'add', identity: 'docs' }, 'add'],
  ['list', { op: 'list' }, 'list-mounted'],
  ['apply', { op: 'apply', identity: 'docs' }, 'apply-docs'],
  ['call', { op: 'call' }, 'call-docs'],
  ['edit-keep', { op: 'edit', identity: 'docs', mode: 'keep' }, 'edit-keep'],
  ['edit-replace', { op: 'edit', identity: 'docs', mode: 'replace' }, 'edit-replace'],
  ['restart', { op: 'restart', identity: 'docs' }, 'restart'],
  ['default', { op: 'default', identity: 'docs' }, 'default'],
  ['probe', { op: 'probe', identity: 'probe-only' }, 'probe'],
  ['remote', { op: 'remote', identity: 'docs-remote' }, 'remote'],
  ['http', { op: 'http', identity: 'docs-http' }, 'http'],
  ['http-probe', { op: 'httpProbe', identity: 'http-probe' }, 'http-probe'],
  ['http-failure', { op: 'httpFailure', identity: 'http-failure' }, 'http-failure'],
  ['http-timeout', { op: 'httpTimeout', identity: 'http-timeout' }, 'http-timeout'],
  ['remove-docs', { op: 'remove', identity: 'docs' }, 'remove-docs'],
  ['remove-remote', { op: 'remove', identity: 'docs-remote' }, 'remove-remote'],
  ['remove-http', { op: 'remove', identity: 'docs-http' }, 'remove-http'],
  ['canary', { op: 'canary' }, 'canary'],
  ['residue', { op: 'residue', identity: 'docs' }, 'residue'],
  ['report', { op: 'report' }, 'report'],
]
function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const lastTool = lastOfRole(options, 'tool')
  if (lastTool.includes('unknown tool')) return textChunks('management probe unavailable')
  if (lastTool.includes('MCP_MANAGEMENT error:')) return textChunks('management operation failed')
  for (const [marker, args] of steps) {
    if (!history.includes(`done ${marker}`)) return toolCallChunks('mcp_management_probe', { ...args, _marker: marker })
  }
  return textChunks('mcp management complete')
}
async function run(ctx) {
  const ws = join(ctx.IT_ROOT, 'ws')
  rmSync(join(ctx.IT_ROOT, 'home', 'weir', 'profiles', 'weir-it', 'capabilities', 'mcp'), { recursive: true, force: true })
  rmSync(join(ws, 'mcp-management-report.json'), { force: true })
  rmSync(join(ws, 'mcp-server-log.jsonl'), { force: true })
  const trace = join(ctx.IT_ROOT, `trace-${id}.jsonl`)
  const main = await ctx.spawnHeadless(['weir-it', prompt], ctx.scenarioEnv(id, trace, {
    WEIR_IT_MCP_MANAGEMENT: '1',
    WEIR_IT_MCP_STARTUP_TIMEOUT_MS: '250',
    WEIR_IT_MCP_CANARY: 'weir-mcp-canary-primary-value',
    WEIR_IT_MCP_CANARY_EDIT: 'weir-mcp-canary-edit-value',
  }))
  return { scenario: id, trace, code: main.code, stdout: main.stdout, stderr: main.stderr }
}
function assert(run) {
  if (!existsSync(join(run.ws, 'mcp-management-report.json'))) {
    run.check('management report exists', false, `${run.stderr.slice(-3000)}\n${run.stdout.slice(-1000)}`)
    return
  }
  const report = JSON.parse(readFileSync(join(run.ws, 'mcp-management-report.json'), 'utf8'))
  const responses = report.responses
  const at = op => responses.find(entry => entry.op === op)?.value ?? {}
  const outcome = op => at(op).outcome ?? {}
  run.check('parent completed management', run.stdout.includes('mcp management complete'), run.stdout.slice(-500))
  run.check('stdio mounted with real discovery', outcome('add').status === 'mounted' && outcome('add').discovery.toolCount === 1, JSON.stringify(outcome('add')))
  run.check('selection and managed call work', outcome('apply').status === 'applied' && at('call').callObserved === true, JSON.stringify(at('call')))
  run.check('blank keep and replace preserve incarnation and advance generation', outcome('edit-keep').incarnation === outcome('add').incarnation && outcome('edit-replace').incarnation === outcome('add').incarnation && outcome('edit-keep').generation === 2 && outcome('edit-replace').generation === 3, '')
  run.check('restart preserves incarnation and default', outcome('restart').generation === 4 && outcome('restart').incarnation === outcome('add').incarnation && outcome('default').status === 'saved', '')
  run.check('uncommitted stdio probe does not register', outcome('probe').status === 'mounted' && at('probe').registryHasIdentity === false, JSON.stringify(at('probe')))
  run.check('remote mutation tolerates unrelated Apply', at('remote').remote?.status === 'mounted' && at('remote').unrelatedApply === 'applied', JSON.stringify(at('remote')))
  run.check('Streamable HTTP mounts', outcome('http').status === 'mounted' && at('http').httpRequests > 0, JSON.stringify(at('http')))
  run.check('zero-tool HTTP probe succeeds without registry write', outcome('http-probe').status === 'mounted' && outcome('http-probe').discovery.toolCount === 0 && at('http-probe').registryHasIdentity === false, JSON.stringify(at('http-probe')))
  run.check('HTTP authorization failure is a probe failure without registration', outcome('http-failure').status === 'probe-failed' && at('http-failure').registryHasIdentity === false, JSON.stringify(at('http-failure')))
  run.check('HTTP timeout is bounded and cleaned without registration', outcome('http-timeout').status === 'probe-failed' && at('http-timeout').registryHasIdentity === false, JSON.stringify(at('http-timeout')))
  run.check('remove reports defaultRemoved', outcome('remove-docs').status === 'removed' && outcome('remove-docs').defaultRemoved === true, JSON.stringify(outcome('remove-docs')))
  for (const surface of ['registry', 'profile', 'residue', 'audit', 'remote', 'session']) {
    run.check(`secret canary absent from ${surface} after remove/recovery`, report.canary[surface] === false, JSON.stringify(report.canary))
  }
  run.check('registry history contains credential refs, not canary values', Object.values(report.lastEntries).some(entry => entry.secretRefs) && !JSON.stringify(report.lastEntries).includes('weir-mcp-canary-primary-value') && !JSON.stringify(report.lastEntries).includes('weir-mcp-canary-edit-value'), JSON.stringify(report.lastEntries).slice(0, 500))
  run.check('crash residue recovery ran', at('residue').recovery && !Object.values(at('residue').canary).some(Boolean), JSON.stringify(at('residue')))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-500)}`)
}
export default { id, prompt, decide, run, assert, env: { WEIR_IT_MCP_MANAGEMENT: '1' } }
