// Formal real-Host retained-revision scenario for mcp-management-deepening 1.5.
// Live-only: its evidence includes retained mount identity, real RPC and process
// cleanup, none of which a recorded mock-LLM trace can establish.
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { lastOfRole, textChunks, toolCallChunks } from '../mock-kit.js'

const ID = 'capability-lifecycle-retained-revision'
const PRESET = 'weir-it-lifecycle-retained-primary'
const RUN_ID = 'capability-lifecycle-retained-primary'
const IDENTITIES = { old: 'retained-old', new: 'retained-new' }
const PNPM = process.env.WEIR_IT_PNPM ?? (process.platform === 'win32'
  ? join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
  : '/Users/young/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs')
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
const detail = value => JSON.stringify(value)

function decide(options) {
  return lastOfRole(options, 'tool') ? textChunks('lifecycle retained-revision probe done') : toolCallChunks('capability_lifecycle_retained_revision_probe', {})
}

function observe(obs) {
  return { probeServed: obs.toolNames.includes('capability_lifecycle_retained_revision_probe') }
}

async function runCase(ctx) {
  const profileName = 'weir-it-lifecycle-retained'
  const profile = join(ctx.IT_ROOT, 'home', 'profiles', profileName)
  mkdirSync(profile, { recursive: true })
  writeFileSync(join(profile, 'package.json'), JSON.stringify({
    name: 'dsh-profile-lifecycle-retained',
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
      { id: 'weir-it-agent-presets', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: PRESET } },
      { id: 'weir-it-mock-llm', name: 'weir-test-harness/mock-llm' },
      { id: 'capability-lifecycle-retained-revision-probe', name: fileURLToPath(new URL('../capability-lifecycle-retained-revision-probe.js', import.meta.url)) },
    ] },
  ], null, 2) + '\n')
  execFileSync(process.execPath, [PNPM, 'install', '--reporter', 'silent'], { cwd: profile, stdio: 'inherit' })
  const prompt = 'Run retained lifecycle and same-identity mount ownership regressions in both cleanup orders.'
  const trace = join(ctx.IT_ROOT, `trace-${ID}.jsonl`)
  const main = await ctx.spawnHeadless([profileName, prompt], ctx.scenarioEnv(ID, trace, { WEIR_IT_CAPABILITY_LIFECYCLE_RETAINED: '1' }))
  writeFileSync(join(ctx.IT_ROOT, 'retained-headless-stderr.log'), main.stderr)
  writeFileSync(join(ctx.IT_ROOT, 'retained-headless-stdout.log'), main.stdout)
  return { scenario: ID, trace, code: main.code, stdout: main.stdout, stderr: main.stderr }
}

function isRealCall(call, identity, tag) {
  return call?.resultObserved === true
    && call.identity === identity
    && call.rpcDelta === 1
    && call.matchingRpc?.length === 1
    && JSON.stringify(call.lifecycleTags) === JSON.stringify([tag])
}

function checkCall(run, label, call, identity, tag) {
  run.check(`${label} completes exactly one real RPC through the owning lifecycle`, isRealCall(call, identity, tag), detail(call))
}

function assertFacadeOrder(run, facade) {
  const order = facade?.order ?? 'missing-order'
  const first = facade?.first
  const survivor = facade?.survivor
  const tag = slot => `${facade?.runId}:${slot}`
  const publicName = 'mcp__retained-shared__echo'
  const same = facade?.sameIdentity
  run.check(`${order} same-identity fixture retains independent old/new owners with identical generation, incarnation and serverName`, facade?.fixtureBlocker == null
    && facade.retained?.managersDistinct === true && facade.retained.lifecyclesDistinct === true
    && facade.oldAdoption?.outcome?.status === 'mounted' && facade.newSameIdentityMount?.status === 'mounted'
    && facade.oldApply?.outcome?.status === 'applied' && facade.newApply?.outcome?.status === 'applied'
    && same?.serverName === 'retained-shared' && same.generation === same.oldGeneration && same.generation === same.newGeneration
    && same.generation === same.oldMountGeneration && same.generation === same.newMountGeneration
    && same.incarnation != null && same.incarnation === same.oldMountIncarnation && same.incarnation === same.newMountIncarnation
    && facade.groupsAfterBoth?.count === 2
    && facade.bridgesAfterBoth?.old?.present === true && facade.bridgesAfterBoth?.new?.present === true
    && facade.bridgesAfterBoth.old.groupId !== facade.bridgesAfterBoth.new.groupId
    && JSON.stringify(facade.bridgesAfterBoth.old.ownerLifecycleTags) === JSON.stringify([tag('old')])
    && JSON.stringify(facade.bridgesAfterBoth.new.ownerLifecycleTags) === JSON.stringify([tag('new')]), detail({ blocker: facade?.fixtureBlocker, retained: facade?.retained, same, groups: facade?.groupsAfterBoth, bridges: facade?.bridgesAfterBoth }))
  run.check(`${order} new same-identity mount has real nonzero discovery (regression: mounted with discovery=0)`, facade?.oldAdoption?.outcome?.discovery?.toolCount === 1
    && JSON.stringify(facade.oldAdoption.outcome.discovery.toolNamesPreview) === JSON.stringify([publicName])
    && facade.newSameIdentityMount?.discovery?.toolCount === 1
    && JSON.stringify(facade.newSameIdentityMount.discovery.toolNamesPreview) === JSON.stringify([publicName]), detail({ old: facade?.oldAdoption?.outcome?.discovery, new: facade?.newSameIdentityMount?.discovery }))
  run.check(`${order} old/new public tool names are identical and both direct gates use only their own lifecycle`, ['old', 'new'].every(slot => {
    const visibility = facade?.visibilityAfterBoth?.[slot]
    const gate = facade?.directGatesAfterBoth?.[slot]
    return visibility?.visible === true && visibility.managedSchema?.name === publicName && visibility.managedSchema.parameters?.type === 'object'
      && gate?.enabledFor === true && gate.admitted === true && gate.assertPermit === true
      && JSON.stringify(gate.lifecycle?.enabledFor) === JSON.stringify([tag(slot)])
      && JSON.stringify(gate.lifecycle?.permit) === JSON.stringify([tag(slot)])
  }), detail({ visibility: facade?.visibilityAfterBoth, gates: facade?.directGatesAfterBoth }))
  checkCall(run, `${order} old owner after concurrent same-identity mount`, facade?.oldAfterNewMount, 'retained-shared', tag('old'))
  run.check(`${order} new owner completes exactly one real RPC through a distinct client and its own lifecycle`, isRealCall(facade?.newAfterNewMount, 'retained-shared', tag('new'))
    && facade.realRpc?.distinctServerProcesses === true, detail({ call: facade?.newAfterNewMount, realRpc: facade?.realRpc }))
  run.check(`${order} ${first} disposal closes only its own feed/gate and preserves survivor facts`, facade?.firstDisposal?.disposed === true
    && facade.firstDisposal.unregistered === true && facade.firstDisposal.runtimeRemoval?.status === 'removed'
    && facade.firstDisposal.gate?.enabledFor === false && facade.firstDisposal.gate.admitted === false
    && JSON.stringify(facade.firstDisposal.gate.lifecycle?.permit) === JSON.stringify([])
    && JSON.stringify(facade.beforeFirstCleanup) === JSON.stringify(facade.survivorAfterFirstCleanup?.facts), detail({ before: facade?.beforeFirstCleanup, disposal: facade?.firstDisposal, after: facade?.survivorAfterFirstCleanup?.facts }))
  run.check(`${order} ${first} cleanup cannot delete the current ${survivor} bridge (explicit old-cleanup/new-bridge regression)`, facade?.bridgeAfterFirstCleanup?.present === true
    && facade.bridgeAfterFirstCleanup.groupId === facade.bridgesAfterBoth?.[survivor]?.groupId
    && facade.bridgeAfterFirstCleanup.enabledForObservedSession === true
    && JSON.stringify(facade.bridgeAfterFirstCleanup.ownerLifecycleTags) === JSON.stringify([tag(survivor)]), detail({ before: facade?.bridgesAfterBoth?.[survivor], after: facade?.bridgeAfterFirstCleanup }))
  run.check(`${order} survivor discovery and real RPC survive ${first} cleanup`, facade?.survivorAfterFirstCleanup?.visibility?.visible === true
    && facade.survivorAfterFirstCleanup.visibility.managedSchema?.name === publicName
    && isRealCall(facade.survivorAfterFirstCleanup.call, 'retained-shared', tag(survivor)), detail(facade?.survivorAfterFirstCleanup))
  run.check(`${order} stale/repeated ${first} release cannot delete the current ${survivor} owner or disrupt RPC`, facade?.repeatedFirstRelease != null
    && facade.bridgeAfterRepeatedRelease?.present === true
    && facade.bridgeAfterRepeatedRelease.groupId === facade.bridgesAfterBoth?.[survivor]?.groupId
    && JSON.stringify(facade.bridgeAfterRepeatedRelease.ownerLifecycleTags) === JSON.stringify([tag(survivor)])
    && facade.survivorAfterRepeatedRelease?.visibility?.visible === true
    && isRealCall(facade.survivorAfterRepeatedRelease.call, 'retained-shared', tag(survivor)), detail({ release: facade?.repeatedFirstRelease, bridge: facade?.bridgeAfterRepeatedRelease, survivor: facade?.survivorAfterRepeatedRelease }))
  run.check(`${order} final groups, bridges, claims, registry, feeds, retained mounts and processes are fully cleaned`, facade?.survivorDisposal?.disposed === true
    && facade.survivorDisposal.runtimeRemoval?.status === 'removed' && facade.survivorDisposal.registryRemoval?.status === 'committed'
    && facade.final?.groups?.count === 0 && facade.cleanup?.finalGroups?.count === 0
    && ['old', 'new'].every(slot => facade.final?.bridges?.[slot]?.present === false && facade.cleanup?.finalBridges?.[slot]?.present === false)
    && facade.final?.claims?.claimCount === 0 && facade.cleanup?.finalClaims?.claimCount === 0
    && Object.keys(facade.final?.registry?.servers ?? {}).length === 0
    && Object.keys(facade.cleanup?.finalRegistry?.servers ?? {}).length === 0
    && facade.cleanup?.errors?.length === 0 && facade.cleanup?.serverProcesses?.started?.length >= 2
    && facade.cleanup.serverProcesses.allExited === true
    && facade.cleanup.finalFeed?.old?.present === false && facade.cleanup.finalFeed?.new?.present === false
    && facade.cleanup.finalRetainedCompositions?.length === 0, detail({ final: facade?.final, cleanup: facade?.cleanup }))
}

function checkInitial(run, label, measurement, slot) {
  const tag = `${RUN_ID}:${slot}`
  run.check(`${label} resolves its own ready memory-only revision-0 lifecycle before Apply`, measurement?.memory?.state === 'ready'
    && measurement.memory.revision === 0
    && JSON.stringify(measurement.memory.mcpServers) === JSON.stringify([])
    && measurement.memory.skillNames?.includes(`only-${RUN_ID}-${slot}`)
    && measurement.durable?.selection?.kind === 'absent'
    && measurement.durable?.inherited?.kind === 'absent'
    && measurement.feed?.present === true
    && measurement.feed?.matchesOwn === true
    && measurement.feed?.resolved?.revision === 0
    && JSON.stringify(measurement.feed?.lifecycleTags) === JSON.stringify([tag]), detail(measurement))
}

function checkApply(run, report, slot) {
  const transition = report?.apply?.[slot]
  const identity = IDENTITIES[slot]
  const tag = `${RUN_ID}:${slot}`
  const registry = report?.registry?.servers?.[identity]
  run.check(`${slot} retained revision accepts its divergent Apply as revision 1 with no warnings`, transition?.outcome?.status === 'applied'
    && transition.outcome.revision === 1
    && (transition.outcome.warnings ?? []).length === 0
    && transition.memory?.state === 'ready'
    && transition.memory.revision === 1
    && JSON.stringify(transition.memory.mcpServers) === JSON.stringify([identity])
    && transition.memory.mcpIncarnations?.[identity] === registry?.incarnation
    && transition.durable?.selection?.kind === 'ok'
    && transition.durable.selection.revision === 1
    && JSON.stringify(transition.durable.selection.mcpServers) === JSON.stringify([identity])
    && transition.durable.inherited?.kind === 'absent', detail({ outcome: transition?.outcome, memory: transition?.memory, durable: transition?.durable, registry }))
  run.check(`${slot} Apply publishes its owning lifecycle before exactly one owning manager sync`, transition?.publication?.publishCount === 1
    && transition.publication.syncCount === 1
    && transition.publication.publishSeq < transition.publication.syncSeq
    && transition.publication.syncSnapshot?.revision === 1
    && JSON.stringify(transition.publication.syncSnapshot?.mcpServers) === JSON.stringify([identity]), detail(transition?.publication))
  run.check(`${slot} Apply leaves sibling memory, durable records and gate facts byte-identical`, transition?.sibling?.before != null
    && JSON.stringify(transition.sibling.before) === JSON.stringify(transition.sibling.after), detail(transition?.sibling))
  run.check(`${slot} owning manager admits the accepted identity through only its own lifecycle`, transition?.gate?.enabledFor === true
    && transition.gate.admitted === true
    && transition.gate.assertPermit === true
    && JSON.stringify(transition.gate.lifecycle?.enabledFor) === JSON.stringify([tag])
    && JSON.stringify(transition.gate.lifecycle?.permit) === JSON.stringify([tag]), detail(transition?.gate))
  run.check(`${slot} accepted Apply exposes the real object-rooted managed stdio schema`, transition?.visibility?.visible === true
    && transition.visibility.managedSchema?.name === `mcp__${identity}__echo`
    && transition.visibility.managedSchema?.parameters?.type === 'object', detail(transition?.visibility))
  checkCall(run, `${slot} Apply`, transition?.call, identity, tag)
}

function assertRetained(run) {
  const report = readJson(join(run.ws, 'capability-lifecycle-retained-revision.json'))
  const primary = report?.primary
  if (!primary) {
    run.check('retained real-Host report exists', false, detail(report))
    run.check('headless installed CLI exits cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
    return
  }
  run.check('real same-preset fixture completes two eager registrations and retains two distinct old/new revisions', primary?.fixtureBlocker == null
    && primary?.registrations?.length === 2
    && primary.registrations.every((entry, index) => entry.slot === (index === 0 ? 'old' : 'new') && entry.presetId === PRESET && !entry.broken && entry.managerObserved && entry.selectionObserved)
    && primary.registrations[0].retainedCompositions?.length === 1
    && primary.registrations[1].retainedCompositions?.length === 2
    && primary.retained?.inspectAll?.length === 2
    && primary.retained.inspectAll.every(id => id === PRESET)
    && primary.retained.managersDistinct === true
    && primary.retained.lifecyclesDistinct === true
    && primary.sessions?.old?.composedPreset === PRESET
    && primary.sessions?.new?.composedPreset === PRESET
    && primary.sessions.old.serviceForMatchesObserver === true
    && primary.sessions.new.serviceForMatchesObserver === true, detail({ blocker: primary?.fixtureBlocker, registrations: primary?.registrations, retained: primary?.retained, sessions: primary?.sessions }))
  run.check('releasing the old declaration before replacement preserves its agent-retained mount and feed', primary?.oldDeclarationRelease?.unregistered === true
    && JSON.stringify(primary.oldDeclarationRelease.retainedCompositions) === JSON.stringify([PRESET])
    && primary.oldDeclarationRelease.feed?.old?.matchesOwn === true, detail(primary?.oldDeclarationRelease))

  checkInitial(run, 'old session before replacement', primary?.oldBeforeReplacement, 'old')
  checkInitial(run, 'retained old session after replacement', primary?.oldAfterReplacement, 'old')
  checkInitial(run, 'new session after replacement', primary?.newAfterReplacement, 'new')
  run.check('replacement leaves the old session memory and durable facts unchanged', JSON.stringify(primary?.oldBeforeReplacement?.memory) === JSON.stringify(primary?.oldAfterReplacement?.memory)
    && JSON.stringify(primary?.oldBeforeReplacement?.durable) === JSON.stringify(primary?.oldAfterReplacement?.durable), detail({ before: primary?.oldBeforeReplacement, after: primary?.oldAfterReplacement }))

  run.check('different old/new stdio identities mount with revision-local registry generations and distinct facade groupIds', primary?.adoptions?.old?.outcome?.status === 'mounted'
    && primary.adoptions?.new?.outcome?.status === 'mounted'
    && primary.adoptions.old.outcome.identity === IDENTITIES.old
    && primary.adoptions.new.outcome.identity === IDENTITIES.new
    && primary.bridgesAfterMount?.old?.groupId === `weir-mcp-${IDENTITIES.old}`
    && primary.bridgesAfterMount?.new?.groupId === `weir-mcp-${IDENTITIES.new}`
    && primary.bridgesAfterMount.old.identity === IDENTITIES.old
    && primary.bridgesAfterMount.new.identity === IDENTITIES.new
    && JSON.stringify(primary.bridgesAfterMount.old.ownerLifecycleTags) === JSON.stringify([`${RUN_ID}:old`])
    && JSON.stringify(primary.bridgesAfterMount.new.ownerLifecycleTags) === JSON.stringify([`${RUN_ID}:new`]), detail({ adoptions: primary?.adoptions, bridges: primary?.bridgesAfterMount, registry: primary?.registry }))
  checkInitial(run, 'old session after both real mounts', primary?.afterAdopt?.old, 'old')
  checkInitial(run, 'new session after both real mounts', primary?.afterAdopt?.new, 'new')
  checkApply(run, primary, 'old')
  checkApply(run, primary, 'new')

  run.check('new revision Apply leaves the old accepted memory and durable selection unchanged', JSON.stringify(primary?.oldAfterNewApply?.measurement?.memory) === JSON.stringify(primary?.apply?.old?.memory)
    && JSON.stringify(primary?.oldAfterNewApply?.measurement?.durable) === JSON.stringify(primary?.apply?.old?.durable), detail(primary?.oldAfterNewApply?.measurement))
  run.check('old admission still resolves only the old lifecycle after new Apply', primary?.oldAfterNewApply?.gate?.enabledFor === true
    && primary.oldAfterNewApply.gate.admitted === true
    && JSON.stringify(primary.oldAfterNewApply.gate.lifecycle?.enabledFor) === JSON.stringify([`${RUN_ID}:old`])
    && JSON.stringify(primary.oldAfterNewApply.gate.lifecycle?.permit) === JSON.stringify([`${RUN_ID}:old`]), detail(primary?.oldAfterNewApply?.gate))
  checkCall(run, 'old session after new Apply', primary?.oldAfterNewApply?.call, IDENTITIES.old, `${RUN_ID}:old`)

  run.check('disposing/unregistering old first removes only old feed authorization and retains the new revision', primary?.oldDisposal?.disposed === true
    && primary.oldDisposal.unregistered === true
    && JSON.stringify(primary.oldDisposal.retainedCompositions) === JSON.stringify([PRESET])
    && primary.oldDisposal.feed?.old?.present === false
    && primary.oldDisposal.feed?.new?.matchesOwn === true
    && primary.oldDisposal.gate?.enabledFor === false
    && primary.oldDisposal.gate?.admitted === false
    && JSON.stringify(primary.oldDisposal.gate?.lifecycle?.enabledFor) === JSON.stringify([])
    && JSON.stringify(primary.oldDisposal.gate?.lifecycle?.permit) === JSON.stringify([]), detail(primary?.oldDisposal))
  run.check('old managed runtime and registry fixture are removed before new cleanup', primary?.oldDisposal?.runtimeRemoval?.status === 'removed'
    && primary.oldDisposal?.registryRemoval?.status === 'committed', detail(primary?.oldDisposal))
  run.check('new memory, durable and gate facts survive old agent/revision/runtime cleanup unchanged', JSON.stringify(primary?.beforeOldDispose?.new) === JSON.stringify(primary?.afterOldDispose?.new)
    && primary.afterOldDispose?.bridges?.old?.present === false
    && primary.afterOldDispose?.bridges?.new?.present === true
    && JSON.stringify(primary.afterOldDispose.bridges.new.ownerLifecycleTags) === JSON.stringify([`${RUN_ID}:new`]), detail({ before: primary?.beforeOldDispose?.new, after: primary?.afterOldDispose }))
  checkCall(run, 'new session after old disposal', primary?.afterOldDispose?.newCall, IDENTITIES.new, `${RUN_ID}:new`)

  run.check('disposing/unregistering new second removes the final manager/feed authorization', primary?.newDisposal?.disposed === true
    && primary.newDisposal.unregistered === true
    && primary.newDisposal.retainedCompositions?.length === 0
    && primary.newDisposal.feed?.old?.present === false
    && primary.newDisposal.feed?.new?.present === false
    && primary.newDisposal.gate?.enabledFor === false
    && primary.newDisposal.gate?.admitted === false
    && JSON.stringify(primary.newDisposal.gate?.lifecycle?.permit) === JSON.stringify([])
    && primary.newDisposal.runtimeRemoval?.status === 'removed'
    && primary.newDisposal.registryRemoval?.status === 'committed', detail(primary?.newDisposal))
  run.check('primary final registry, facade bridges, feeds and retained mounts are empty', primary?.final?.registry?.kind === 'ok'
    && Object.keys(primary.final.registry.servers ?? {}).length === 0
    && primary.final.bridges?.old?.present === false
    && primary.final.bridges?.new?.present === false
    && primary.final.feed?.old?.present === false
    && primary.final.feed?.new?.present === false
    && primary.cleanup?.finalRetainedCompositions?.length === 0, detail(primary?.final))
  run.check('primary cleanup exits every real mock MCP process without errors', primary?.cleanup?.errors?.length === 0
    && primary.cleanup?.serverProcesses?.started?.length >= 2
    && JSON.stringify(primary.cleanup.serverProcesses.servers?.sort()) === JSON.stringify([IDENTITIES.new, IDENTITIES.old].sort())
    && Object.values(primary.cleanup.serverProcesses.byServer ?? {}).every(pids => pids.length >= 1)
    && primary.cleanup.serverProcesses.allExited === true, detail(primary?.cleanup))

  const facade = report?.facade
  run.check('same-identity correct-behavior regression runs every requested cleanup order', facade?.expectedOrders?.length >= 1
    && facade.expectedOrders.every(order => facade.orders?.[order]?.order === order), detail({ expected: facade?.expectedOrders, actual: Object.keys(facade?.orders ?? {}) }))
  for (const order of facade?.expectedOrders ?? []) assertFacadeOrder(run, facade.orders?.[order])
  run.check('headless installed CLI exits cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default {
  id: ID,
  prompt: 'Run retained lifecycle and same-identity mount ownership regressions in both cleanup orders.',
  env: { WEIR_IT_CAPABILITY_LIFECYCLE_RETAINED: '1' },
  decide,
  observe,
  run: runCase,
  assert: assertRetained,
}
