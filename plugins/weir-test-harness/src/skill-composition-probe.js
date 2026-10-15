// Dev-only live registry probe. Reports are recorded independently of truncated tool output.
import { cp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import * as selectionPlugin from '../../weir-harness/src/capabilities/skill-selection-plugin.js'
import { createSkillIdentity } from '../../weir-harness/src/capabilities/skill-identity.js'
import { checkBuiltinSkillMigration } from '../../weir-harness/src/capabilities/skill-builtin-migration.js'
import { IT_ROOT } from './mock-kit.js'
import { officeUnavailable } from './office-availability.js'

const mounted = new Map()
export const inject = ['tools', 'skills', 'agents']
export const name = 'weir-it-skill-composition'
export function apply(ctx, config = {}) {
  if (config.selection) {
    selectionPlugin.apply(ctx, { machineId: 'weir-it-machine', readPresetId: config.selection, includeDefaultRoots: false, customSkillDirs: [config.root ?? join(IT_ROOT, 'ws', 'skill-roots')], weirBuiltinDir: config.weirBuiltinDir })
    mounted.set(config.selection, selectionPlugin.skillSelectionFor(ctx))
    return
  }
  if (process.env.WEIR_IT_CAPABILITY_DUAL === '1') {
    ctx.tools.register({
      name: 'capability_dual_preset_probe',
      description: 'Observe two real preset mounts, their owner commands, remote reads and session projections.',
      parameters: { type: 'object', properties: {} },
      output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'DUAL_PRESET_PROBE_DONE' }] },
      async execute() {
        const report = await runDualPresetProbe(ctx).catch(error => ({ error: error.stack ?? String(error) }))
        await writeFile(join(IT_ROOT, 'ws', 'capability-dual-preset.json'), JSON.stringify(report, null, 2))
        return { completed: !report.error }
      },
    })
    return
  }
  if (!process.env.WEIR_IT_SKILL_COMPOSITION) return
  ctx.tools.register({
    name: 'skill_composition_probe', description: 'Exercise real preset skill selection and negative controls.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'SKILL_COMPOSITION_DONE' }] },
    async execute(_args, exec) {
      const mode = process.env.WEIR_IT_SKILL_COMPOSITION
      const office = mode === 'OFFICE'
      const preset = 'weir-it-selection'
      const root = join(IT_ROOT, 'ws', 'skill-roots')
      for (const name of ['selected-fixture', 'unselected-fixture']) {
        await mkdir(join(root, name), { recursive: true })
        await writeFile(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Integration fixture ${name}\n---\nCONTENT_${name}\n`)
      }
      const registry = ctx.get('agentPresets')
      const report = { mode }
      let handle, unregister, lease
      try {
        // MIGRATION: the builtin root is a corrupted copy (one skill dropped),
        // so the first-run migration check must fail closed with a visible
        // reason while the preset itself stays mountable.
        let selectionConfig = { selection: preset }
        if (mode === 'MIGRATION') {
          const corrupted = join(IT_ROOT, 'ws', 'builtin-corrupted')
          await rm(corrupted, { recursive: true, force: true })
          await cp(fileURLToPath(new URL('../../weir-harness/skills/', import.meta.url)), corrupted, { recursive: true })
          await rm(join(corrupted, 'debugging'), { recursive: true })
          selectionConfig = { selection: preset, weirBuiltinDir: corrupted }
        }
        const plugins = [
          { id: 'weir-skill-selection', name: fileURLToPath(import.meta.url), config: selectionConfig },
          { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
        ]
        if (mode === 'LEAK') plugins.push({ id: 'skill-filesystem', name: '@deepseek-ai/dsh-skill-filesystem', config: { customSkillDirs: [root] } })
        unregister = await registry.register({ id: preset, plugins })
        report.roster = await registry.resolve(preset)
        handle = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: join(IT_ROOT, 'ws'), agentPreset: preset },
          setup: agentCtx => registry.mount(agentCtx, preset).then(() => undefined) })
        const agent = handle.agent
        report.created = registry.composedPreset(agent.ctx)
        const lookup = { cwd: agent.session.header.cwd, scope: agent }
        const selection = mounted.get(preset)
        if (mode === 'MIGRATION') {
          report.migration = {}
          try { await selection.inventory(lookup) }
          catch (error) { report.migration.inventoryError = error.message }
          // Force provider enumeration with a valid fixture selection: the
          // corrupted builtin root must fail the whole provider closed.
          const fixtureIdentity = createSkillIdentity({ scope: 'custom', root: await realpath(root), name: 'selected-fixture', opaqueId: 'weir-it-probe' })
          selection.provider.acceptSelection([fixtureIdentity], lookup)
          const skills = await ctx.skills.list(lookup)
          report.migration.live = { all: skills.map(s => s.name), model: skills.filter(s => s.invocation.modelInvocable).map(s => s.name) }
          report.migration.status = selection.provider.status(lookup)
        } else {
        const inventory = await selection.inventory(lookup)
        report.inventory = inventory.candidates.map(c => ({ name: c.name, provider: c.provider, source: c.source, rank: c.rank, scope: c.identity?.scope ?? null }))
        report.builtinMigration = checkBuiltinSkillMigration(inventory)
        // Office capability gate (design D2): the OFFICE mode probes an
        // OPTIONAL environment capability. When the bundled Office candidates
        // are not all present in the observed inventory, record the absence
        // marker with evidence and finish normally (no throw) — the scenario
        // reports SKIP, never FAIL. Every other mode is byte-identical.
        const unavailable = office ? officeUnavailable(inventory) : null
        if (unavailable) report.officeUnavailable = unavailable
        const exercise = async () => {
        const chosen = office ? 'office-docx' : 'selected-fixture'
        const rejected = office ? 'office-pptx' : 'unselected-fixture'
        const identity = inventory.candidates.find(c => c.name === chosen)?.identity
        if (!identity) throw new Error(`Missing raw candidate ${chosen}`)
        const observe = async options => {
          const skills = await ctx.skills.list(options)
          return { all: skills.map(s => ({ name: s.name, invocation: s.invocation })),
            model: skills.filter(s => s.invocation.modelInvocable).map(s => s.name),
            slash: skills.filter(s => s.invocation.userInvocable).map(s => s.name) }
        }
        report.empty = await observe(lookup)
        selection.provider.acceptSelection([identity], lookup)
        report.live = await observe(lookup)
        const messages = [{ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: `/${chosen} /${rejected}` }] }]
        const decision = await agent.ctx.waterfall('agent/pre-step', { agent, messages, signal: exec.signal }, async () => ({ kind: 'continue', messages }))
        report.catalog = decision.messages.filter(m => m.source?.kind === 'skill-catalog').flatMap(m => m.source.entries.map(e => e.name))
        report.consumer = decision.messages.filter(m => m.source?.kind === 'skill-invocation').map(m => m.source.name)
        report.global = await observe({ cwd: lookup.cwd })
        const tool = ctx.tools.get('skill', agent)
        report.toolDescription = typeof tool.description === 'function' ? await tool.description({ agent }) : tool.description
        report.loads = {}
        for (const name of [chosen, rejected]) {
          try { report.loads[name] = await tool.execute({ name }, { ...exec, agent }) }
          catch (error) { report.loads[name] = { error: error.message } }
        }
        lease = await registry.acquireScope(preset)
        report.cold = await observe({ cwd: lookup.cwd, scope: lease.key })
        selection.provider.acceptSelection([], lookup)
        report.revoked = await observe(lookup)
        }
        if (!unavailable) await exercise()
        }
      } catch (error) { report.error = error.stack ?? String(error) }
      finally {
        await lease?.[Symbol.asyncDispose]()
        await handle?.dispose()
        await unregister?.()
      }
      await writeFile(join(IT_ROOT, 'ws', `skill-composition-${mode.toLowerCase()}.json`), JSON.stringify(report, null, 2))
      return { mode, completed: !report.error }
    },
  })
}

// This runs inside the installed Host, not a fake provider or an in-memory feed
// fixture. Registry.register eagerly mounts two independent preset revisions.
async function runDualPresetProbe(ctx) {
  const { createCapabilityReadService } = await import('../../weir-harness/src/capabilities/capability-remote.js')
  const registry = ctx.get('agentPresets')
  const query = ctx.get('sessionQuery')
  const commands = ctx.get('commands')
  if (!registry || !query || !commands) throw new Error('installed preset/sessionQuery/commands services required')
  const service = createCapabilityReadService({ sessionQuery: () => query })
  const report = { orders: [], projection: null, leasesReleased: 0 }
  const cwd = join(IT_ROOT, 'ws')
  const names = ['weir', 'weir-creative']
  const roots = Object.fromEntries(names.map(id => [id, join(cwd, `dual-${id}`)]))
  for (const id of names) {
    await mkdir(join(roots[id], `only-${id}`), { recursive: true })
    await writeFile(join(roots[id], `only-${id}`, 'SKILL.md'), `---\nname: only-${id}\ndescription: ${id} owner fixture\n---\nOWNER_${id}\n`)
  }
  async function observe(id) {
    const start = performance.now()
    const lease = await query.observeSession(id)
    try {
      return { source: lease.source, headerPreset: lease.header.agentPreset ?? null,
        projectedPreset: lease.projections?.values?.agentPreset ?? null,
        cursor: lease.cursor, eventCount: lease.events.length,
        elapsedMs: +(performance.now() - start).toFixed(2) }
    } finally { lease[Symbol.dispose](); report.leasesReleased++ }
  }
  const commandReceipt = async agent => {
    const settled = await commands.execute(agent, '/capabilities receipt', [], new AbortController().signal)
    const result = settled?.result ?? settled
    if (result?.kind !== 'success') throw new Error(`owner command failed: ${JSON.stringify(result)}`)
    return JSON.parse(result.text)
  }
  for (const order of [names, [...names].reverse()]) {
    const unregister = []
    const handles = []
    const outcome = { order, owners: [] }
    report.orders.push(outcome)
    try {
      for (const id of order) {
        unregister.push(await registry.register({ id, plugins: [
          { id: `selection-${id}`, name: fileURLToPath(import.meta.url), config: { selection: id, root: roots[id] } },
          { id: `skill-tool-${id}`, name: '@deepseek-ai/dsh-tool-skill' },
        ] }))
        const resolved = await registry.resolve(id)
        if (resolved.broken) throw new Error(`preset ${id} failed: ${resolved.broken}`)
      }
      for (const id of names) {
        const handle = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd, agentPreset: id },
          setup: agentCtx => registry.mount(agentCtx, id).then(() => undefined) })
        handles.push(handle)
        const agent = handle.agent
        const selected = mounted.get(id)
        if (!selected) throw new Error(`selection face ${id} did not mount`)
        const lookup = { cwd, scope: agent }
        const identity = (await selected.inventory(lookup)).candidates.find(c => c.name === `only-${id}`)?.identity
        if (!identity) throw new Error(`fixture identity only-${id} missing`)
        // The real command pipeline commits a durable selection revision; no
        // synthetic store or provider override is involved.
        const request = JSON.stringify({ requestId: randomUUID(), expectedRevision: 0, skills: [identity], mcpServers: [] })
        const committed = await commands.execute(agent, `/capabilities apply ${request}`, [], new AbortController().signal)
        const commitResult = committed?.result ?? committed
        if (commitResult?.kind !== 'success') throw new Error(`apply ${id}: ${JSON.stringify(commitResult)}`)
        const owner = { id, sessionId: agent.id, composed: registry.composedPreset(agent.ctx), commit: JSON.parse(commitResult.text) }
        owner.command = await commandReceipt(agent)
        owner.remote = await service.receipt(agent.id)
        owner.projectionLive = await observe(agent.id)
        owner.commandEventsAfter = agent.session.snapshotEvents().filter(e => e.type === 'command/run' || e.type === 'command/done').map(e => e.type)
        outcome.owners.push(owner)
      }
      // Re-read AFTER both presets are live and both commands have committed;
      // this is the discriminator for the old single-slot bridge.
      for (const owner of outcome.owners) {
        owner.remoteAfterBoth = await service.receipt(owner.sessionId)
        owner.listAfterBoth = await service.list(owner.sessionId)
        owner.conditionsAfterBoth = await service.conditions(owner.sessionId)
        owner.presetsAfterBoth = await service.presets(owner.sessionId)
        owner.defaultAfterBoth = await service.defaultGet(owner.sessionId)
        const agent = handles.find(h => h.agent.id === owner.sessionId).agent
        owner.commandAfterBoth = await commandReceipt(agent)
        owner.commandEventsFinal = agent.session.snapshotEvents().filter(e => e.type === 'command/run' || e.type === 'command/done').map(e => e.type)
      }
      if (order[0] === 'weir' && outcome.owners.length === 2) {
        const agent = handles[0].agent
        // A real blank-session selection commits agent-preset/selected while
        // preserving the creation header (the exact stale-header regression).
        report.projection = { beforeSelect: await observe(agent.id) }
        report.projection.selected = await registry.select(agent, 'weir-creative')
        report.projection.afterSelect = await observe(agent.id)
        report.projection.remoteAfterSelect = await service.receipt(agent.id)
        // Replay-valid native selection events; request/context outside an open
        // turn corrupts cold logs and is deliberately NOT used for this probe.
        const selectedEvent = agent.session.snapshotEvents().findLast(event => event.type === 'agent-preset/selected')
        if (!selectedEvent) throw new Error('preset selection event missing')
        for (let i = 0; i < 2000; i++) await agent.session.append('agent-preset/selected', selectedEvent.data)
        report.projection.liveLong = await observe(agent.id)
        await handles[0].dispose()
        handles.shift()
        report.projection.coldLong = await observe(agent.id)
        report.projection.coldRepeat = await observe(agent.id)
        report.projection.coldRemote = await service.receipt(agent.id)
      }
    } catch (error) { outcome.error = error.stack ?? String(error) }
    finally {
      for (const handle of handles.reverse()) await handle.dispose()
      for (const dispose of unregister.reverse()) await dispose()
      for (const id of names) mounted.delete(id)
    }
  }
  return report
}
