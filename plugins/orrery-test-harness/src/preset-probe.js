// Preset/defaults integration probe for the `preset-defaults` scenario
// (task 9.5): mounts the real skill-selection plugin against fixture-only
// roots and drives the group-9 surfaces in-process — preset library CRUD,
// portable import validation, the defaults transaction, and the enabled-set
// stability proof. Enabled only when ORRERY_IT_PRESET=1. Dev-only.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openCapabilityStore } from '../../orrery-harness/src/capabilities/store/store.js'
import * as selectionPlugin from '../../orrery-harness/src/capabilities/skill-selection-plugin.js'
import { createPresetLibrary, workspaceKeyOf } from '../../orrery-harness/src/capabilities/preset-library.js'
import { createDefaultsTransaction } from '../../orrery-harness/src/capabilities/defaults-transaction.js'
import { validatePortableDocument, bindImportedSelection } from '../../orrery-harness/src/capabilities/portable-refs.js'
import { IT_ROOT } from './mock-kit.js'

const FIXTURES = ['fixture-a']

const namesOf = skills => (Array.isArray(skills) ? skills : []).map(identity => identity?.name ?? null)

function apply(ctx, config = {}) {
  if (config.enabled !== true) return
  selectionPlugin.apply(ctx, {
    machineId: 'orrery-it-machine',
    includeDefaultRoots: false,
    customSkillDirs: [join(IT_ROOT, 'ws', 'skill-roots')],
  })
  ctx.tools.register({
    name: 'preset_probe',
    description: 'Integration probe: drive the group-9 preset library, portable import and workspace defaults surfaces.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['presetCreate', 'presetLoad', 'importDoc', 'saveDefault', 'readDefault', 'enabledView', 'report'] },
        document: { type: 'object' },
        snapshot: { type: 'object' },
        presetId: { type: 'string' },
        scope: { type: 'string' },
        _marker: { type: 'string' },
      },
      required: ['op'],
    },
    output: {
      schema: { type: 'object' },
      render: (args, value) => [{ type: 'text', text: `PRESET_PROBE ${value.completed ? `done ${args?._marker ?? value.op}${value.import?.status ? `:${value.import.status}` : ''}${value.load?.kind ? `:${value.load.kind}` : ''}` : `error:${String(value.error ?? 'unknown').slice(0, 200)}`}` }],
    },
    async execute(args, exec) {
      const report = { completed: false, op: args?.op ?? null }
      try {
        const root = join(IT_ROOT, 'ws', 'skill-roots')
        for (const skill of FIXTURES) {
          mkdirSync(join(root, skill), { recursive: true })
          writeFileSync(join(root, skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: Preset fixture ${skill}\n---\nCONTENT_${skill}\n`)
        }
        const sessionId = exec.agent?.session?.id
        const cwd = exec.agent?.session?.header?.cwd ?? join(IT_ROOT, 'ws')
        if (typeof sessionId !== 'string') throw new Error('probe session unavailable')
        const store = openCapabilityStore({ profileContext: ctx.get('profileContext') })
        const selection = selectionPlugin.skillSelectionFor(ctx)
        if (!selection) throw new Error('skill selection plugin not mounted')
        const library = createPresetLibrary({ store })
        const defaults = createDefaultsTransaction({ store })
        const workspaceKey = workspaceKeyOf({ cwd })
        const inventory = await selection.inventory({ cwd, scope: { session: { id: sessionId } } })
        const identityA = inventory.candidates.find(candidate => FIXTURES.includes(candidate.name) && candidate.status === 'parsed')?.identity

        if (args.op === 'enabledView') {
          report.enabled = (await ctx.skills.list({ cwd, scope: { session: { id: sessionId } } })).map(skill => skill.name).filter(name => FIXTURES.includes(name))
          report.completed = true
          return report
        }
        if (args.op === 'presetCreate') {
          report.create = await library.create({ scope: args.scope ?? 'global', presetId: args.presetId ?? 'team', document: args.document })
          report.completed = report.create.status === 'created' || report.create.status === 'exists'
          return report
        }
        if (args.op === 'presetLoad') {
          const loaded = await library.load(args.scope ?? 'global', args.presetId ?? 'team', workspaceKey)
          report.load = loaded.kind === 'ok'
            ? { kind: 'ok', document: loaded.document }
            : { kind: loaded.kind }
          report.completed = true
          return report
        }
        if (args.op === 'importDoc') {
          // Import = validate → bind → create; a rejection writes NOTHING.
          const verdict = validatePortableDocument(args.document)
          if (!verdict.ok) {
            report.import = { status: 'rejected', reason: verdict.reason }
            report.completed = true
            return report
          }
          const bound = bindImportedSelection(args.document.selection, { localMcpIdentities: [] })
          report.import = await library.create({
            scope: args.document.scope,
            presetId: args.document.presetId ?? 'imported',
            document: { name: args.document.name, selection: { skills: [], mcpServers: bound.mcpServers, unresolvedRefs: bound.unresolvedRefs } },
          })
          report.bound = bound
          report.completed = true
          return report
        }
        if (args.op === 'saveDefault') {
          const snapshot = args.snapshot ?? {}
          // Convenience: skill names map to the discovered fixture identities.
          const skills = (snapshot.skills ?? []).map(entry => typeof entry === 'string' ? (FIXTURES.includes(entry) ? identityA : entry) : entry).filter(Boolean)
          report.save = await defaults.save({ workspaceKey, expectedRevision: 0, snapshot: { ...snapshot, skills } })
          report.completed = report.save.status === 'saved'
          return report
        }
        if (args.op === 'readDefault') {
          report.default = await defaults.read(workspaceKey)
          report.completed = true
          return report
        }
        if (args.op === 'report') {
          mkdirSync(join(IT_ROOT, 'ws'), { recursive: true })
          writeFileSync(join(IT_ROOT, 'ws', 'preset-defaults-report.json'), JSON.stringify(report, null, 2) + '\n')
          report.completed = true
          return report
        }
        throw new Error(`unknown op: ${String(args.op)}`)
      } catch (cause) {
        report.error = cause instanceof Error ? cause.message : String(cause)
        return report
      }
    },
  })
}

export const name = 'orrery-it-preset-probe'
export const inject = ['tools', 'skills']
export { apply }
