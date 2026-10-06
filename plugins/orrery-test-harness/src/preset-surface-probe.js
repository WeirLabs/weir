// Preset-surface integration probe for the `capability-presets-surface`
// scenario (capability-manager-ux tasks 5.1/6.5): mounts the real
// skill-selection plugin exactly like preset-probe and drives the SHIPPED
// /capabilities command surface in-process — preset verbs, defaults verbs,
// v1 import rejection, and the v2 package dry-run/confirmed install flow with
// real file-landing evidence. Enabled only when ORRERY_IT_PRESET_SURFACE=1.
// Dev-only.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import * as selectionPlugin from '../../orrery-harness/src/capabilities/skill-selection-plugin.js'
import { IT_ROOT } from './mock-kit.js'

const WS = join(IT_ROOT, 'ws')
const HOME = join(IT_ROOT, 'home')
const PROJECT_SKILLS = join(WS, '.dsh', 'skills')
const USER_SKILLS = join(HOME, 'skills')
const CUSTOM_DIR = join(WS, 'skill-roots')

const writeSkill = (root, name, marker) => {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Surface fixture ${name}\n---\nCONTENT_${marker}\n`)
}
const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }
/** File reads stay inside the IT root — a probe bug must never touch the host. */
const insideIt = path => {
  const resolved = join(path)
  if (!resolved.startsWith(IT_ROOT)) throw new Error(`probe path escapes IT root: ${path}`)
  return resolved
}
const compact = report => JSON.stringify(report, (key, value) => (key === 'document' || key === 'content' || key === 'files' && typeof value === 'string' ? '[omitted]' : value)).slice(0, 640)

function apply(ctx, config = {}) {
  if (config.enabled !== true) return
  selectionPlugin.apply(ctx, {
    machineId: 'orrery-it-machine',
    includeDefaultRoots: true,
    customSkillDirs: [CUSTOM_DIR],
  })
  ctx.tools.register({
    name: 'surface_probe',
    description: 'Integration probe: drive the shipped /capabilities preset/defaults/package surface with file-landing evidence.',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['seedParent', 'corruptRecord', 'agentCreated', 'incarnationView', 'saveTravel', 'cap', 'presetsSummary', 'receiptSummary', 'exportPack', 'craftRename', 'importPack', 'fileState', 'mutateAppend'] },
        line: { type: 'string' },
        scope: { type: 'string' },
        presetId: { type: 'string' },
        name: { type: 'string' },
        path: { type: 'string' },
        out: { type: 'string' },
        renames: { type: 'object' },
        dryRun: { type: 'boolean' },
        onCollision: { type: 'string' },
        checks: { type: 'array' },
        text: { type: 'string' },
        _marker: { type: 'string' },
      },
      required: ['op'],
    },
    output: {
      schema: { type: 'object' },
      render: (args, value) => [{ type: 'text', text: `SURFACE_PROBE ${value.completed ? `done ${args?._marker ?? value.op}:${compact(value)}` : `error:${String(value.error ?? 'unknown').slice(0, 200)}`}` }],
    },
    async execute(args, exec) {
      const report = { completed: false, op: args?.op ?? null }
      try {
        const sessionId = exec.agent?.session?.id
        if (typeof sessionId !== 'string') throw new Error('probe session unavailable')
        const commands = ctx.get('commands')
        if (!commands) throw new Error('commands service unavailable from the probe ctx')
        const cap = async line => {
          const settled = await commands.execute(exec.agent, `/capabilities ${line}`, [], new AbortController().signal)
          const value = settled?.result !== undefined ? settled.result : settled
          let payload = null
          if (typeof value?.text === 'string') { try { payload = JSON.parse(value.text) } catch { payload = value.text.slice(0, 200) } }
          return { kind: value?.kind ?? null, payload }
        }

        if (args.op === 'seedParent') {
          // Commit the accepted record DIRECTLY through the real store: the
          // six-step Apply engine rejects synthetic sessions at step 1
          // (unauthenticated) by design — a hand-built incarnation id is not
          // a real host session. The record layout is exactly what the
          // engine's durable write produces.
          const face = selectionPlugin.skillSelectionFor(ctx)
          if (!face) throw new Error('skill selection plugin not mounted')
          const inventoryResult = await face.inventory({ cwd: WS, scope: { session: { id: sessionId } } })
          const identities = (Array.isArray(args.names) ? args.names : []).map(name => inventoryResult.candidates.find(c => c.name === name && c.status === 'parsed')?.identity).filter(Boolean)
          if (identities.length !== (Array.isArray(args.names) ? args.names.length : 0)) throw new Error('parent fixture identities missing from inventory')
          const store = (await import('../../orrery-harness/src/capabilities/store/store.js')).openCapabilityStore({ profileContext: ctx.get('profileContext') })
          const committed = await store.commit({ kind: 'selection', scope: 'session', sessionId: String(args.sessionId) }, 0, () => ({ skills: identities, mcpServers: [] }))
          report.apply = { status: committed?.status ?? null, revision: committed?.revision ?? null }
          report.completed = report.apply.status === 'committed'
          if (!report.completed) report.error = `seedParent commit failed: ${JSON.stringify(report.apply).slice(0, 240)}`
          return report
        }
        if (args.op === 'corruptRecord') {
          // Write a torn selection unit for the named session: snapshotFor
          // classifies the parent as blocked-unreadable, exercising the D1
          // capture-failure path (root rule: markBlocked, never throw).
          const dir = join(HOME, 'orrery', 'profiles', 'orrery-it', 'capabilities', 'sessions', String(args.sessionId))
          mkdirSync(dir, { recursive: true })
          writeFileSync(join(dir, 'selection.json'), '{"schemaVersion":1,"revision":1,"payload":CORRUPT')
          report.completed = true
          return report
        }
        if (args.op === 'agentCreated') {
          const face = selectionPlugin.skillSelectionFor(ctx)
          if (!face) throw new Error('skill selection plugin not mounted')
          const incId = String(args.sessionId)
          let thrown = null
          try {
            face.lifecycle.agentCreated({ agent: { session: { id: incId, header: { cwd: WS, delegationDepth: 0, ...(typeof args.parentSession === 'string' ? { parentSession: args.parentSession } : {}) } } } })
          } catch (cause) {
            thrown = cause instanceof Error ? cause.message : String(cause)
          }
          const inherited = await face.lifecycle ? (async () => {
            const store = (await import('../../orrery-harness/src/capabilities/store/store.js')).openCapabilityStore({ profileContext: ctx.get('profileContext') })
            return store.read({ kind: 'inherited', sessionId: incId })
          })() : { kind: 'unavailable' }
          const inheritedRecord = await inherited
          report.agentCreated = {
            thrown,
            inherited: inheritedRecord.kind === 'ok'
              ? { kind: 'ok', skills: (inheritedRecord.payload?.skills ?? []).map(identity => identity?.name ?? null), origin: inheritedRecord.payload?.origin ?? null }
              : { kind: inheritedRecord.kind },
            blocked: face.lifecycle.snapshotFor(incId)?.state === 'blocked',
          }
          report.completed = true
          return report
        }
        if (args.op === 'incarnationView') {
          const face = selectionPlugin.skillSelectionFor(ctx)
          if (!face) throw new Error('skill selection plugin not mounted')
          const view = { cwd: WS, scope: { session: { id: String(args.sessionId), header: { cwd: WS, delegationDepth: 0, ...(typeof args.parentSession === 'string' ? { parentSession: args.parentSession } : {}) } } } }
          // Force the lazy collect FIRST (the list drives readSelection), then
          // read the status — the provider only carries the classified error
          // after a collect has run.
          const skills = await ctx.skills.list(view).catch(cause => ({ error: cause instanceof Error ? cause.message : String(cause) }))
          const providerView = face.status(view)
          report.view = {
            status: providerView?.error ? { error: true, reason: providerView.reason ?? null } : { error: false },
            selected: Array.isArray(skills) ? skills.map(skill => skill.name).sort() : skills,
          }
          report.completed = true
          return report
        }
        if (args.op === 'saveTravel') {
          const selection = selectionPlugin.skillSelectionFor(ctx)
          if (!selection) throw new Error('skill selection plugin not mounted')
          const headerCwd = exec.agent?.session?.header?.cwd ?? null
          report.headerCwd = headerCwd
          const inventory = await selection.inventory({ cwd: WS, scope: { session: { id: sessionId } } })
          const probe2 = await selection.inventory({ cwd: headerCwd ?? WS, scope: { session: { id: sessionId } } })
          report.fixtureA = {
            ws: inventory.candidates.some(c => c.name === 'fixture-a' && c.status === 'parsed'),
            header: probe2.candidates.some(c => c.name === 'fixture-a' && c.status === 'parsed'),
            headerCandidates: probe2.candidates.length,
          }
          const pick = (name, scope) => inventory.candidates.find(c => c.name === name && c.status === 'parsed' && c.identity?.scope === scope)?.identity ?? null
          const identities = [pick('pack-proj', 'project'), pick('pack-local', 'custom')]
          report.identities = identities.map(identity => identity === null ? null : { scope: identity.scope, name: identity.name })
          if (identities.some(identity => identity === null)) return report
          report.save = await cap(`preset-save ${JSON.stringify({ scope: 'global', presetId: 'travel', name: 'Travel', from: 'draft', skills: identities, mcpServers: [] })}`)
          report.completed = true
          return report
        }
        if (args.op === 'cap') {
          report.cap = await cap(String(args.line ?? ''))
          report.completed = true
          return report
        }
        if (args.op === 'presetsSummary') {
          const result = await cap('presets')
          const presets = Array.isArray(result.payload?.presets) ? result.payload.presets : []
          report.summary = {
            kind: result.kind,
            global: presets.filter(p => p.scope === 'global').length,
            workspace: presets.filter(p => p.scope === 'workspace').length,
            ids: presets.map(p => `${p.scope}/${p.presetId}`).sort(),
          }
          report.completed = true
          return report
        }
        if (args.op === 'receiptSummary') {
          const result = await cap('receipt')
          const receipt = result.payload && typeof result.payload === 'object' ? result.payload : {}
          report.receipt = {
            kind: result.kind,
            status: receipt.status ?? null,
            revision: Number.isSafeInteger(receipt.revision) ? receipt.revision : null,
            skills: Array.isArray(receipt.effective?.skills) ? [...receipt.effective.skills].sort() : [],
            mcpServers: Array.isArray(receipt.effective?.mcpServers) ? [...receipt.effective.mcpServers] : [],
          }
          report.completed = true
          return report
        }
        if (args.op === 'exportPack') {
          const result = await cap(`preset-export ${JSON.stringify({ scope: args.scope ?? 'global', presetId: args.presetId })}`)
          const document = result.payload?.document ?? null
          if (document) writeFileSync(insideIt(join(WS, args.out ?? 'travel-pack.json')), JSON.stringify(document, null, 2) + '\n')
          report.pack = document ? {
            version: document.version ?? null,
            bundled: (document.bundled ?? []).map(entry => `${entry.targetScope}/${entry.name}:${(entry.files ?? []).length}`),
            builtin: document.builtin ?? [],
            refs: (document.selection?.skills ?? []).length,
            warnings: (document.warnings ?? []).length,
          } : { error: result.payload }
          report.completed = true
          return report
        }
        if (args.op === 'craftRename') {
          const source = readJson(insideIt(join(WS, args.path ?? 'travel-pack.json')))
          if (!source) throw new Error(`craft source unreadable: ${args.path}`)
          const renames = args.renames ?? {}
          const renamed = {
            ...source,
            name: args.name ?? source.name,
            bundled: (source.bundled ?? []).map(entry => renames[entry.name] ? { ...entry, name: renames[entry.name], files: (entry.files ?? []).map(file => ({ ...file, content: typeof file.content === 'string' ? file.content.replace(`name: ${entry.name}`, `name: ${renames[entry.name]}`) : file.content })) } : entry),
          }
          writeFileSync(insideIt(join(WS, args.out ?? 'travel-pack-2.json')), JSON.stringify(renamed, null, 2) + '\n')
          report.crafted = { out: args.out ?? 'travel-pack-2.json', names: renamed.bundled.map(entry => entry.name) }
          report.completed = true
          return report
        }
        if (args.op === 'importPack') {
          const document = readJson(insideIt(join(WS, args.path ?? 'travel-pack.json')))
          if (!document) throw new Error(`import document unreadable: ${args.path}`)
          const spec = { document, scope: args.scope ?? 'global', presetId: args.presetId }
          if (typeof args.name === 'string') spec.name = args.name
          if (args.dryRun === true) spec.dryRun = true
          if (typeof args.onCollision === 'string') spec.onCollision = args.onCollision
          report.import = await cap(`preset-import ${JSON.stringify(spec)}`)
          report.completed = true
          return report
        }
        if (args.op === 'fileState') {
          const files = {}
          for (const check of Array.isArray(args.checks) ? args.checks : []) {
            const target = insideIt(String(check?.path ?? ''))
            const exists = existsSync(target)
            const content = exists ? readFileSync(target, 'utf8') : ''
            const state = { exists }
            if (typeof check?.text === 'string') state.hasMarker = content.includes(check.text)
            files[String(check?.key ?? target)] = state
          }
          report.files = files
          report.completed = true
          return report
        }
        if (args.op === 'mutateAppend') {
          appendFileSync(insideIt(String(args.path ?? '')), String(args.text ?? ''))
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

export const name = 'orrery-it-preset-surface-probe'
export const inject = ['tools', 'skills']
export { apply }
