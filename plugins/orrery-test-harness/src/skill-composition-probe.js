// Dev-only live registry probe. Reports are recorded independently of truncated tool output.
import { cp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import * as selectionPlugin from '../../orrery-harness/src/capabilities/skill-selection-plugin.js'
import { createSkillIdentity } from '../../orrery-harness/src/capabilities/skill-identity.js'
import { checkBuiltinSkillMigration } from '../../orrery-harness/src/capabilities/skill-builtin-migration.js'
import { IT_ROOT } from './mock-kit.js'

const mounted = new Map()
export const inject = ['tools', 'skills', 'agents']
export const name = 'orrery-it-skill-composition'
export function apply(ctx, config = {}) {
  if (config.selection) {
    selectionPlugin.apply(ctx, { machineId: 'orrery-it-machine', includeDefaultRoots: false, customSkillDirs: [join(IT_ROOT, 'ws', 'skill-roots')], orreryBuiltinDir: config.orreryBuiltinDir })
    mounted.set(config.selection, selectionPlugin.skillSelectionFor(ctx))
    return
  }
  if (!process.env.ORRERY_IT_SKILL_COMPOSITION) return
  ctx.tools.register({
    name: 'skill_composition_probe', description: 'Exercise real preset skill selection and negative controls.',
    parameters: { type: 'object', properties: {} },
    output: { schema: { type: 'object' }, render: () => [{ type: 'text', text: 'SKILL_COMPOSITION_DONE' }] },
    async execute(_args, exec) {
      const mode = process.env.ORRERY_IT_SKILL_COMPOSITION
      const office = mode === 'OFFICE'
      const preset = 'orrery-it-selection'
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
          await cp(fileURLToPath(new URL('../../orrery-harness/skills/', import.meta.url)), corrupted, { recursive: true })
          await rm(join(corrupted, 'debugging'), { recursive: true })
          selectionConfig = { selection: preset, orreryBuiltinDir: corrupted }
        }
        const plugins = [
          { id: 'orrery-skill-selection', name: fileURLToPath(import.meta.url), config: selectionConfig },
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
          const fixtureIdentity = createSkillIdentity({ scope: 'custom', root: await realpath(root), name: 'selected-fixture', opaqueId: 'orrery-it-probe' })
          selection.provider.acceptSelection([fixtureIdentity], lookup)
          const skills = await ctx.skills.list(lookup)
          report.migration.live = { all: skills.map(s => s.name), model: skills.filter(s => s.invocation.modelInvocable).map(s => s.name) }
          report.migration.status = selection.provider.status(lookup)
        } else {
        const inventory = await selection.inventory(lookup)
        report.inventory = inventory.candidates.map(c => ({ name: c.name, provider: c.provider, source: c.source, rank: c.rank, scope: c.identity?.scope ?? null }))
        report.builtinMigration = checkBuiltinSkillMigration(inventory)
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
