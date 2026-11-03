// Live-only scoped PresetTree seam canary. No production code is involved.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lastOfRole, textChunks, toolCallChunks } from '../mock-kit.js'

const ID = 'scoped-preset-tree-canary'
const PRESET = 'weir-it-scoped-preset-tree-canary'
const PNPM = process.env.WEIR_IT_PNPM ?? (process.platform === 'win32'
  ? join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
  : '/Users/young/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs')
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
const detail = value => JSON.stringify(value)

function decide(options) {
  return lastOfRole(options, 'tool') ? textChunks('scoped PresetTree canary done') : toolCallChunks('scoped_preset_tree_canary_probe', {})
}

function observe(obs) {
  return { probeServed: obs.toolNames.includes('scoped_preset_tree_canary_probe') }
}

async function runCase(ctx) {
  const profileName = 'weir-it-scoped-canary'
  const profile = join(ctx.IT_ROOT, 'home', 'profiles', profileName)
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-scoped-preset-tree-canary',
    private: true,
    dependencies: {
      'weir-harness': `link:${join(ctx.WS_ROOT, 'plugins/weir-harness')}`,
      'weir-test-harness': `link:${join(ctx.WS_ROOT, 'plugins/weir-test-harness')}`,
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
  }, null, 2) + '\n')
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'mock', model: 'mock-1' } },
    { insert: [
      { id: 'weir-it-agent-presets', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: PRESET } },
      { id: 'weir-it-mock-llm', name: 'weir-test-harness/mock-llm' },
      { id: 'scoped-preset-tree-canary-probe', name: fileURLToPath(new URL('../scoped-preset-tree-canary-probe.js', import.meta.url)) },
    ] },
  ], null, 2) + '\n')
  execFileSync(process.execPath, [PNPM, 'install', '--reporter', 'silent'], { cwd: profile, stdio: 'inherit' })
  const prompt = 'Run the real two-revision scoped PresetTree stock MCP canary.'
  const trace = join(ctx.IT_ROOT, `trace-${ID}.jsonl`)
  const main = await ctx.spawnHeadless([profileName, prompt], ctx.scenarioEnv(ID, trace, { WEIR_IT_MCP_SCOPED_CANARY: '1' }))
  writeFileSync(join(ctx.IT_ROOT, 'scoped-canary-headless-stderr.log'), main.stderr)
  writeFileSync(join(ctx.IT_ROOT, 'scoped-canary-headless-stdout.log'), main.stdout)
  return { scenario: ID, trace, code: main.code, stdout: main.stdout, stderr: main.stderr }
}

function assertCanary(run) {
  const report = readJson(join(run.ws, 'scoped-preset-tree-canary.json'))
  run.check('real scoped canary report completes without fixture or cleanup errors', report != null && report.blocker == null && report.cleanup?.errors?.length === 0, detail({ blocker: report?.blocker, cleanup: report?.cleanup }))
  run.check('two eager registrations retain distinct old/new preset revisions and owning entries', report?.presetId === PRESET
    && report.registrations?.length === 2
    && report.registrations[0].retained?.length === 1
    && report.registrations[1].retained?.length === 2
    && JSON.stringify(report.retained?.compositions) === JSON.stringify([PRESET, PRESET])
    && report.retained.treesDistinct === true
    && report.retained.entriesDistinct === true
    && report.sessions?.old?.composedPreset === PRESET
    && report.sessions?.new?.composedPreset === PRESET, detail({ registrations: report?.registrations, retained: report?.retained, sessions: report?.sessions }))
  run.check('each revision exposes its supported scoped PresetTree through ctx.fiber.entry.parent.tree', ['old', 'new'].every(slot => {
    const tree = report?.trees?.[slot]
    return tree?.captured === true && tree.apiPath === 'ctx.fiber.entry.parent.tree' && tree.constructorName === 'PresetTree'
      && tree.rootBelongsToTree === true && tree.create === 'function' && tree.remove === 'function'
      && tree.entries === 'function' && tree.resolve === 'function' && tree.await === 'function'
      && tree.write === 'function' && tree.store === 'object' && tree.writeCalled === true
  }), detail(report?.trees))
  run.check('PresetTree write, root create/remove and revision mounts leave every profile configuration file byte- and metadata-identical', report?.profileWriteEvidence != null
    && Object.entries(report.profileWriteEvidence).filter(([key]) => key !== 'files').every(([, value]) => value === true), detail(report?.profileWriteEvidence))
  run.check('stock clients with identical public serverName start and resolve in both scoped trees', ['old', 'new'].every(slot => {
    const client = report?.clients?.[slot]
    return client?.id === 'scoped-canary-client' && client.serverName === report.serverName
      && client.entryPresent === true && client.resolvedEntryIsSame === true
      && client.entries?.some(entry => entry.id === client.entryId && entry.name === '@deepseek-ai/dsh-mcp-client' && entry.state === 2)
      && client.managedSchema?.name === report.publicToolName && client.managedSchema.parameters?.type === 'object'
  }), detail(report?.clients))
  run.check('each scoped stock client completes real initialize and tools/list', ['old', 'new'].every(slot => report?.discovery?.[slot]?.initialize >= 1 && report.discovery[slot].toolsList >= 1), detail(report?.discovery))
  run.check('both revision scopes expose identical public MCP tool names and old removal preserves new discovery', report?.clients?.old?.publicNames?.length === 1
    && JSON.stringify(report.clients.old.publicNames) === JSON.stringify([report.publicToolName])
    && JSON.stringify(report.clients.new.publicNames) === JSON.stringify(report.clients.old.publicNames)
    && JSON.stringify(report.clients.new.publicNamesAfterOldRemove) === JSON.stringify(report.clients.old.publicNames), detail({ old: report?.clients?.old?.publicNames, new: report?.clients?.new?.publicNames, afterOldRemove: report?.clients?.new?.publicNamesAfterOldRemove }))
  run.check('root removal deletes both scoped client entries and exits every real MCP process', ['old', 'new'].every(slot => report?.clients?.[slot]?.afterRemove?.storeEntryAbsent === true && !report.clients[slot].afterRemove.entries?.includes(report.clients[slot].entryId))
    && report?.cleanup?.serverProcesses?.allExited === true
    && ['old', 'new'].every(slot => report.cleanup.serverProcesses.byScope?.[slot]?.allExited === true)
    && report.cleanup.finalRetainedCompositions?.length === 0, detail(report?.cleanup))
  run.check('headless installed CLI exits cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default {
  id: ID,
  prompt: 'Run the real two-revision scoped PresetTree stock MCP canary.',
  env: { WEIR_IT_MCP_SCOPED_CANARY: '1' },
  decide,
  observe,
  run: runCase,
  assert: assertCanary,
}
