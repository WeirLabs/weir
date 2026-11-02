// Formal real-Host regression for mcp-management-deepening task 1.2. Each case
// boots a fresh headless Host through run.mjs; run the two ids separately for a
// fresh DSH_HOME/profile per mount order. Correct behavior is ownership-based:
// BOTH managers admit their own revision-0 session and complete one real RPC.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lastOfRole, textChunks, toolCallChunks } from './mock-kit.js'

const NAMES = ['weir', 'weir-creative']
const identityFor = id => id === 'weir' ? 'docs-weir' : 'docs-creative'
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
const PNPM = process.env.WEIR_IT_PNPM ?? (process.platform === 'win32'
  ? join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
  : '/Users/young/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs')

function decide(options) {
  return lastOfRole(options, 'tool') ? textChunks('lifecycle revision-zero probe done') : toolCallChunks('capability_lifecycle_revision_zero_probe', {})
}

function observe(obs) {
  return { probeServed: obs.toolNames.includes('capability_lifecycle_revision_zero_probe') }
}

// Mirror the preserved iteration-3 spike: a minimal real Host avoids unrelated
// shared-harness Loader ids (notably weir-mcp-manager, which is residue-shaped).
async function runCase(ctx, { id, prompt, orderId, env }) {
  const profileName = `weir-it-lifecycle-${orderId}`
  const profile = join(ctx.IT_ROOT, 'home', 'profiles', profileName)
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: `dsh-profile-lifecycle-${orderId}`,
    private: true,
    dependencies: {
      'weir-harness': `link:${join(ctx.WS_ROOT, 'plugins/weir-harness')}`,
      'weir-test-harness': `link:${join(ctx.WS_ROOT, 'plugins/weir-test-harness')}`,
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'] } },
  }, null, 2) + '\n')
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([
    { id: 'skill-filesystem', disabled: true },
    { id: 'tool-skill', disabled: true },
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'mock', model: 'mock-1' } },
    { insert: [
      { id: 'weir-it-agent-presets', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: 'weir' } },
      { id: 'weir-it-mock-llm', name: 'weir-test-harness/mock-llm' },
      { id: 'capability-lifecycle-dual-manager-probe', name: fileURLToPath(new URL('./capability-lifecycle-dual-manager-probe.js', import.meta.url)) },
    ] },
  ], null, 2) + '\n')
  execFileSync(process.execPath, [PNPM, 'install', '--reporter', 'silent'], { cwd: profile, stdio: 'inherit' })
  const trace = join(ctx.IT_ROOT, `trace-${id}.jsonl`)
  const main = await ctx.spawnHeadless([profileName, prompt], ctx.scenarioEnv(id, trace, env))
  return { scenario: id, trace, code: main.code, stdout: main.stdout, stderr: main.stderr }
}

function assertFor(orderId, order, run) {
  const report = readJson(join(run.ws, `capability-lifecycle-revision-zero-${orderId}.json`))
  const detail = value => JSON.stringify(value)
  run.check(`${orderId} real dual-manager fixture completed in ${order.join('>')} order`, report?.fixtureBlocker == null && JSON.stringify(report?.order) === JSON.stringify(order), detail({ blocker: report?.fixtureBlocker, order: report?.order }))
  run.check(`${orderId} two distinct real managers and lifecycles mounted in isolated per-preset groups`, report?.mounts?.length === 2
    && report.mounts.every(mount => !mount.broken && mount.managerObserved && mount.selectionObserved)
    && report.managerIdentity?.distinct === true
    && report.managerIdentity?.lifecyclesDistinct === true
    && NAMES.every(id => report.managerIdentity?.serviceForMatchesObserver?.[id] === true), detail({ mounts: report?.mounts, identity: report?.managerIdentity }))
  run.check(`${orderId} real stdio fixtures are mounted/default-enabled with valid discovery and no unexpected startup failure`, report?.baseline?.valid === true
    && NAMES.every(id => report.registry?.enabled?.includes(identityFor(id))
      && report.baseline?.managers?.[id]?.unexpectedStartErrors?.length === 0
      && report.baseline?.server?.initializeByServer?.[identityFor(id)] >= 1
      && report.baseline?.server?.toolsListByServer?.[identityFor(id)] >= 1), detail({ baseline: report?.baseline, registry: report?.registry }))
  run.check(`${orderId} used no Apply and no durable selection or inherited records`, report?.apply?.applySelectionCalls === 0
    && report.apply?.allDurableSelectionsAbsent === true
    && report.apply?.allDurableInheritedAbsent === true
    && report.apply?.allMemorySnapshotsRevision0 === true
    && NAMES.every(id => report.apply?.applyCommandEvents?.[id] === 0), detail(report?.apply))

  for (const presetId of NAMES) {
    const label = `${order.join('>')}/${presetId}`
    const session = report?.sessions?.find(entry => entry.presetId === presetId)
    const identity = identityFor(presetId)
    const ownTag = `${orderId}:${presetId}`
    const memory = session?.steadyState?.memory?.own
    const durable = session?.steadyState?.durable
    const gate = session?.steadyState?.gate
    run.check(`${label} owns a ready memory-only revision-0 snapshot for its default-enabled identity and incarnation`, memory?.state === 'ready'
      && memory.revision === 0
      && memory.mcpServers?.includes(identity)
      && memory.mcpIncarnations?.[identity] === report?.registry?.servers?.[identity]?.incarnation
      && durable?.selection?.kind === 'absent'
      && durable?.inherited?.kind === 'absent', detail({ memory: session?.steadyState?.memory, durable, registry: report?.registry?.servers?.[identity] }))
    run.check(`${label} owning manager resolves its own lifecycle and admits revision 0`, gate?.enabledFor === true
      && gate?.permit != null
      && gate?.assertPermit === true
      && JSON.stringify(gate?.lifecycle?.enabledFor) === JSON.stringify([ownTag])
      && JSON.stringify(gate?.lifecycle?.permit) === JSON.stringify([ownTag]), detail(gate))
    const schema = session?.steadyState?.visibility?.managedSchema
    const call = session?.toolCall
    run.check(`${label} owning session exposes the real managed schema and completes exactly one real RPC`, session?.steadyState?.visibility?.visible === true
      && schema?.name === `mcp__${identity}__echo`
      && schema?.parameters?.type === 'object'
      && call?.resultObserved === true
      && call?.rpcDelta === 1
      && call?.matchingRpc?.length === 1, detail({ visibility: session?.steadyState?.visibility, call }))
  }
  run.check(`${orderId} fixture removed managed runtimes, disposed agents/presets, and exited every mock MCP process`, report?.cleanup?.errors?.length === 0
    && NAMES.every(id => report.cleanup?.removals?.[id]?.status === 'removed')
    && report.cleanup?.serverProcesses?.started?.length >= 2
    && report.cleanup?.serverProcesses?.allExited === true, detail(report?.cleanup))
  run.check(`${orderId} headless installed CLI exits cleanly`, run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export function lifecycleRevisionZeroCase(orderId, order) {
  const id = `capability-lifecycle-revision-zero-${orderId}`
  const prompt = `Run lifecycle revision-zero dual-manager probe: ${orderId}.`
  const env = {
    WEIR_IT_CAPABILITY_LIFECYCLE_DUAL: '1',
    WEIR_LIFECYCLE_ORDER: order.join(','),
    WEIR_LIFECYCLE_ORDER_ID: orderId,
  }
  return {
    id,
    prompt,
    env,
    decide,
    observe,
    run: ctx => runCase(ctx, { id, prompt, orderId, env }),
    assert: run => assertFor(orderId, order, run),
  }
}
