// Disposable Web-only fixture. This is never linked into a formal profile.
import { randomUUID } from 'node:crypto'
import { realpathSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve, sep } from 'node:path'
import * as selectionPlugin from '../../weir-harness/src/capabilities/skill-selection-plugin.js'

const faces = new Map()
const names = ['weir', 'weir-creative']
const verbs = { receipt: 'receipt', list: 'list', conditions: 'conditions', presets: 'presets', defaultGet: 'default-get' }
export const name = 'weir-dual-web-qa-bootstrap'
export const inject = ['agentPresets', 'agents', 'commands', 'sessionQuery', 'connection', 'skills']

function isolatedRoot() {
  const root = process.env.WEIR_DUAL_WEB_ROOT
  const home = process.env.DSH_HOME
  if (!root || !home || !isAbsolute(root) || !isAbsolute(home) ||
      realpathSync.native(root) !== root ||
      !resolve(home).startsWith(`${root}${sep}`) ||
      resolve(import.meta.dirname) !== resolve(process.env.WEIR_DUAL_WEB_SOURCE ?? '')) {
    throw new Error('QA bootstrap refuses a non-isolated root/profile/source')
  }
  return root
}

export function apply(ctx, config = {}) {
  if (config.selection) {
    const root = isolatedRoot()
    if (!names.includes(config.selection)) throw new Error('unexpected QA owner')
    selectionPlugin.apply(ctx, {
      machineId: 'weir-dual-web-qa', readPresetId: config.selection,
      includeDefaultRoots: false,
      customSkillDirs: [join(root, `skills-${config.selection}`)],
    })
    faces.set(config.selection, selectionPlugin.skillSelectionFor(ctx))
    ctx.on('dispose', () => faces.delete(config.selection))
    return
  }
  const root = isolatedRoot()
  const order = process.env.WEIR_DUAL_WEB_ORDER?.split(',')
  if (order?.length !== 2 || new Set(order).size !== 2 || !order.every(id => names.includes(id))) throw new Error('invalid QA mount order')
  const registry = ctx.agentPresets
  const handles = []
  const disposers = []
  const owners = {}
  const counts = agent => agent.session.snapshotEvents().filter(e => e.type === 'command/run' || e.type === 'command/done').map(e => e.type)
  const command = async (agent, verb) => {
    const execution = await ctx.commands.execute(agent, `/capabilities ${verb}`, [], new AbortController().signal)
    const result = execution?.result ?? execution
    if (result?.kind !== 'success') throw new Error(`QA command ${verb} failed: ${result?.kind ?? 'no result'} ${String(result?.text ?? '').slice(0, 180)}`)
    return JSON.parse(result.text)
  }
  let state = { phase: 'preparing', order }
  async function setup() {
    const cwd = join(root, 'workspace')
    await mkdir(cwd, { recursive: true })
    for (const id of names) {
      const skill = `only-${id}`
      await mkdir(join(root, `skills-${id}`, skill), { recursive: true })
      await writeFile(join(root, `skills-${id}`, skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: Disposable owner ${id}\n---\n${skill}\n`)
    }
    for (const id of order) {
      disposers.push(await registry.register({ id, plugins: [
        { id: `qa-selection-${id}`, name: new URL('./dual-preset-web-bootstrap.js', import.meta.url).pathname, config: { selection: id } },
        { id: `qa-tool-skill-${id}`, name: '@deepseek-ai/dsh-tool-skill' },
      ] }))
      const resolved = await registry.resolve(id)
      if (resolved.broken) throw new Error(`QA preset ${id} broken: ${resolved.broken}`)
    }
    for (const id of names) {
      const handle = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd, agentPreset: id },
        setup: agentCtx => registry.mount(agentCtx, id).then(() => undefined) })
      handles.push(handle)
      const agent = handle.agent
      const lookup = { cwd, scope: agent }
      // The selection provider initializes its inventory on the first skills
      // enumeration, not during preset registration.
      await ctx.skills.list(lookup)
      const identity = (await faces.get(id)?.inventory(lookup))?.candidates.find(candidate => candidate.name === `only-${id}`)?.identity
      if (!identity) throw new Error(`QA skill ${id} missing from mounted preset`)
      const request = JSON.stringify({ requestId: randomUUID(), expectedRevision: 0, skills: [identity], mcpServers: [] })
      const applied = await ctx.commands.execute(agent, `/capabilities apply ${request}`, [], new AbortController().signal)
      if ((applied?.result ?? applied)?.kind !== 'success') throw new Error(`QA apply ${id} rejected`)
      const commands = {}
      for (const [method, verb] of Object.entries(verbs)) commands[method] = await command(agent, verb)
      owners[id] = { sessionId: agent.id, headerPreset: agent.session.header.agentPreset,
        projectedPreset: null, commands, eventsBefore: counts(agent) }
      const observed = await ctx.sessionQuery.observeSession(agent.id)
      try { owners[id].projectedPreset = observed.projections?.values?.agentPreset ?? null }
      finally { observed[Symbol.dispose]() }
    }
    // A real unsupported preset's live session, distinct from a missing ID.
    disposers.push(await registry.register({ id: 'qa-foreign', plugins: [
      { id: 'qa-foreign-skill-tool', name: '@deepseek-ai/dsh-tool-skill' },
    ] }))
    const foreignHandle = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd, agentPreset: 'qa-foreign' },
      setup: agentCtx => registry.mount(agentCtx, 'qa-foreign').then(() => undefined) })
    handles.push(foreignHandle)
    state = { phase: 'ready', order, owners, foreignSessionId: foreignHandle.agent.id }
  }
  // A second exact, authenticated Connection route is an observation surface,
  // not the product read: the driver reads ALL FIVE product methods via Typert.
  ctx.connection.fetch.register({ path: '/api/weir-dual-qa/state', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      if (state.phase !== 'ready') return Response.json(state)
      const input = await request.json().catch(() => ({}))
      if (input.action === 'cold') {
        const id = input.owner
        if (!names.includes(id) || state.cold) return Response.json({ error: 'cold observation already taken or invalid owner' }, { status: 400 })
        const index = handles.findIndex(handle => handle.agent.id === owners[id].sessionId)
        if (index < 0) return Response.json({ error: 'owner not live' }, { status: 400 })
        await handles.splice(index, 1)[0].dispose()
        const lease = await ctx.sessionQuery.observeSession(owners[id].sessionId)
        try {
          state.cold = { sessionId: owners[id].sessionId, source: lease.source,
            headerPreset: lease.header.agentPreset ?? null, projectedPreset: lease.projections?.values?.agentPreset ?? null,
            commandEvents: lease.events.filter(event => event.type === 'command/run' || event.type === 'command/done').map(event => event.type) }
        } finally { lease[Symbol.dispose]() }
      }
      if (state.cold) {
        const lease = await ctx.sessionQuery.observeSession(state.cold.sessionId)
        try { state.cold.commandEvents = lease.events.filter(event => event.type === 'command/run' || event.type === 'command/done').map(event => event.type) }
        finally { lease[Symbol.dispose]() }
      }
      return Response.json({ ...state, owners: Object.fromEntries(names.map(id => {
        const owner = owners[id]
        const agent = handles.find(handle => handle.agent.id === owner.sessionId)?.agent
        return [id, { ...owner, eventsAfter: agent ? counts(agent) : (state.cold?.sessionId === owner.sessionId ? state.cold.commandEvents : []) }]
      })) })
    }
  })
  void setup().catch(error => { state = { phase: 'failed', order, error: String(error?.stack ?? error) } })
  ctx.on('dispose', async () => {
    for (const handle of handles.reverse()) await handle.dispose()
    for (const dispose of disposers.reverse()) await dispose()
  })
}
