// Real-Host canary: two retained preset revisions own distinct non-writing
// PresetTrees, and stock MCP clients with one public serverName work in both.
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { scopedPresetTreeCaptures } from './scoped-preset-tree-capture.js'

export const name = 'scoped-preset-tree-canary-probe'
export const inject = ['tools', 'agents', 'agentPresets']

const ROOT = process.env.WEIR_IT_ROOT
const PRESET = 'weir-it-scoped-preset-tree-canary'
const PROFILE = join(ROOT, 'home', 'profiles', 'weir-it-scoped-canary')
const SERVER_NAME = 'scoped-shared'
const CLIENT_ID = 'scoped-canary-client'
const TOOL_NAME = `mcp__${SERVER_NAME}__echo`
const CAPTURE = fileURLToPath(new URL('./scoped-preset-tree-capture.js', import.meta.url))
const MOCK_SERVER = fileURLToPath(new URL('./mock-mcp-server.mjs', import.meta.url))
const SLOTS = ['old', 'new']
const clone = value => value == null ? value : JSON.parse(JSON.stringify(value))
const errorText = error => String(error?.stack ?? error?.message ?? error)

async function serverEntries(path) {
  try {
    return (await readFile(path, 'utf8')).split('\n').filter(Boolean).flatMap(line => {
      try { return [JSON.parse(line)] } catch { return [] }
    })
  } catch { return [] }
}

async function profileSnapshot() {
  const result = {}
  for (const name of ['package.json', 'cordis.patch.yml', 'pnpm-workspace.yaml', 'pnpm-lock.yaml']) {
    const path = join(PROFILE, name)
    try {
      const [content, metadata] = await Promise.all([readFile(path), stat(path)])
      result[name] = {
        sha256: createHash('sha256').update(content).digest('hex'),
        bytes: metadata.size,
        mtimeMs: metadata.mtimeMs,
        ctimeMs: metadata.ctimeMs,
      }
    } catch (error) {
      result[name] = { error: error?.code ?? errorText(error) }
    }
  }
  return result
}

function treeFacts(record) {
  const tree = record?.tree
  return {
    captured: Boolean(record && tree),
    apiPath: 'ctx.fiber.entry.parent.tree',
    directSubtreePathPresent: Boolean(record?.directSubtree),
    directSubtreeIsOwningTree: record?.directSubtree != null && record.directSubtree === tree,
    constructorName: tree?.constructor?.name ?? null,
    rootBelongsToTree: tree?.root?.tree === tree,
    create: typeof tree?.root?.create,
    remove: typeof tree?.root?.remove,
    entries: typeof tree?.entries,
    resolve: typeof tree?.resolve,
    await: typeof tree?.await,
    write: typeof tree?.write,
    store: typeof tree?.store,
  }
}

async function runCanary(ctx) {
  const cwd = join(ROOT, 'ws')
  const serverLog = join(cwd, 'scoped-preset-tree-canary.jsonl')
  const report = {
    schemaVersion: 1,
    presetId: PRESET,
    serverName: SERVER_NAME,
    publicToolName: TOOL_NAME,
    blocker: null,
    registrations: [],
    sessions: {},
    trees: {},
    clients: {},
    cleanup: { errors: [] },
  }
  const presets = ctx.get('agentPresets')
  const handles = new Map()
  const agents = new Map()
  const unregister = new Map()
  const removed = new Set()
  if (!presets) throw new Error('real agent preset registry is unavailable')

  function definition(slot) {
    return {
      id: PRESET,
      name: `Scoped PresetTree canary ${slot}`,
      plugins: [{ id: `capture-${slot}`, name: CAPTURE, config: { slot } }],
    }
  }

  async function createAgent(slot) {
    const handle = await ctx.agents.create({
      sessionId: randomUUID(),
      meta: { cwd, agentPreset: PRESET },
      setup: agentCtx => presets.mount(agentCtx, PRESET).then(() => undefined),
    })
    handles.set(slot, handle)
    agents.set(slot, handle.agent)
    report.sessions[slot] = {
      sessionId: handle.agent.id,
      composedPreset: presets.composedPreset(handle.agent.ctx),
      exactCompositions: presets.inspectCompositions(handle.agent.ctx).map(entry => entry.id),
    }
  }

  async function startClient(slot) {
    const tree = scopedPresetTreeCaptures.get(slot)?.tree
    if (!tree) throw new Error(`no scoped PresetTree captured for ${slot}`)
    const returnedId = await tree.root.create({
      id: CLIENT_ID,
      name: '@deepseek-ai/dsh-mcp-client',
      config: {
        transport: 'stdio',
        serverName: SERVER_NAME,
        command: process.execPath,
        args: [MOCK_SERVER, SERVER_NAME],
        env: { WEIR_IT_MCP_LOG: serverLog, WEIR_IT_MCP_ORIGIN: `scoped-${slot}` },
        failOnStartupError: true,
        reconnect: { enabled: false },
      },
    })
    await tree.await()
    const entry = tree.resolve(CLIENT_ID)
    await entry.fiber?.await()
    const entries = [...tree.entries()].map(item => ({ id: item.id, name: item.options?.name, state: item.fiber?.state ?? null }))
    const schemas = ctx.tools.schemas(agents.get(slot)).filter(schema => schema.name.startsWith(`mcp__${SERVER_NAME}__`))
    report.clients[slot] = {
      id: CLIENT_ID,
      returnedId,
      entryId: entry.id,
      serverName: entry.options?.config?.serverName ?? null,
      entryPresent: tree.store[CLIENT_ID] === entry,
      resolvedEntryIsSame: tree.resolve(CLIENT_ID) === entry,
      entries,
      publicNames: schemas.map(schema => schema.name),
      managedSchema: clone(schemas.find(schema => schema.name === TOOL_NAME)),
    }
  }

  async function removeClient(slot) {
    if (removed.has(slot)) return
    removed.add(slot)
    const tree = scopedPresetTreeCaptures.get(slot)?.tree
    if (!tree || !tree.store[CLIENT_ID]) return
    tree.root.remove(CLIENT_ID)
    await tree.await()
    const client = report.clients[slot] ??= { id: CLIENT_ID }
    client.afterRemove = {
      storeEntryAbsent: tree.store[CLIENT_ID] == null,
      entries: [...tree.entries()].map(item => item.id),
    }
  }

  async function waitForProcesses() {
    const deadline = Date.now() + 15_000
    let entries = []
    while (true) {
      entries = await serverEntries(serverLog)
      const started = [...new Set(entries.filter(entry => entry.kind === 'mcp-server-start').map(entry => entry.pid))]
      const exited = [...new Set(entries.filter(entry => entry.kind === 'mcp-server-exit').map(entry => entry.pid))]
      if ((started.length > 0 && started.every(pid => exited.includes(pid))) || Date.now() >= deadline) break
      await new Promise(resolve => setTimeout(resolve, 25))
    }
    const byScope = Object.fromEntries(SLOTS.map(slot => {
      const origin = `scoped-${slot}`
      const scoped = entries.filter(entry => entry.origin === origin)
      const started = [...new Set(scoped.filter(entry => entry.kind === 'mcp-server-start').map(entry => entry.pid))]
      const exited = [...new Set(scoped.filter(entry => entry.kind === 'mcp-server-exit').map(entry => entry.pid))]
      return [slot, {
        origin,
        started,
        exited,
        initialize: scoped.filter(entry => entry.kind === 'mcp-server-rpc' && entry.method === 'initialize').length,
        toolsList: scoped.filter(entry => entry.kind === 'mcp-server-rpc' && entry.method === 'tools/list').length,
        allExited: started.length > 0 && started.every(pid => exited.includes(pid)),
      }]
    }))
    report.cleanup.serverProcesses = { byScope, allExited: SLOTS.every(slot => byScope[slot].allExited) }
  }

  try {
    await mkdir(cwd, { recursive: true })
    report.profileBefore = await profileSnapshot()
    unregister.set('old', await presets.register(definition('old')))
    report.registrations.push({ slot: 'old', resolved: clone(await presets.resolve(PRESET)), retained: presets.inspectCompositions().map(entry => entry.id) })
    await createAgent('old')
    report.trees.old = treeFacts(scopedPresetTreeCaptures.get('old'))
    await unregister.get('old')()
    unregister.delete('old')
    unregister.set('new', await presets.register(definition('new')))
    report.registrations.push({ slot: 'new', resolved: clone(await presets.resolve(PRESET)), retained: presets.inspectCompositions().map(entry => entry.id) })
    await createAgent('new')
    report.trees.new = treeFacts(scopedPresetTreeCaptures.get('new'))
    report.retained = {
      compositions: presets.inspectCompositions().map(entry => entry.id),
      treesDistinct: scopedPresetTreeCaptures.get('old')?.tree !== scopedPresetTreeCaptures.get('new')?.tree,
      entriesDistinct: scopedPresetTreeCaptures.get('old')?.entry !== scopedPresetTreeCaptures.get('new')?.entry,
    }
    report.profileAfterMounts = await profileSnapshot()
    for (const slot of SLOTS) {
      const tree = scopedPresetTreeCaptures.get(slot).tree
      tree.write()
      report.trees[slot].writeCalled = true
    }
    report.profileAfterWrite = await profileSnapshot()
    await startClient('old')
    await startClient('new')
    report.profileAfterCreate = await profileSnapshot()
    const rpcEntries = await serverEntries(serverLog)
    report.discovery = Object.fromEntries(SLOTS.map(slot => {
      const scoped = rpcEntries.filter(entry => entry.kind === 'mcp-server-rpc' && entry.origin === `scoped-${slot}`)
      return [slot, {
        initialize: scoped.filter(entry => entry.method === 'initialize').length,
        toolsList: scoped.filter(entry => entry.method === 'tools/list').length,
      }]
    }))
    await removeClient('old')
    report.clients.new.publicNamesAfterOldRemove = ctx.tools.schemas(agents.get('new')).filter(schema => schema.name.startsWith(`mcp__${SERVER_NAME}__`)).map(schema => schema.name)
    await removeClient('new')
    report.profileAfterRemove = await profileSnapshot()
  } catch (error) {
    report.blocker = errorText(error)
  } finally {
    for (const slot of SLOTS) {
      try { await removeClient(slot) } catch (error) { report.cleanup.errors.push(`${slot} client: ${errorText(error)}`) }
    }
    for (const slot of SLOTS) {
      try { await handles.get(slot)?.dispose() } catch (error) { report.cleanup.errors.push(`${slot} agent: ${errorText(error)}`) }
      try { await unregister.get(slot)?.() } catch (error) { report.cleanup.errors.push(`${slot} preset: ${errorText(error)}`) }
    }
    await waitForProcesses()
    report.profileFinal = await profileSnapshot()
    report.cleanup.finalRetainedCompositions = presets.inspectCompositions().map(entry => entry.id)
  }
  report.profileWriteEvidence = {
    files: Object.keys(report.profileBefore ?? {}),
    stableAfterMounts: JSON.stringify(report.profileAfterMounts) === JSON.stringify(report.profileBefore),
    stableAfterWrite: JSON.stringify(report.profileAfterWrite) === JSON.stringify(report.profileBefore),
    stableAfterCreate: JSON.stringify(report.profileAfterCreate) === JSON.stringify(report.profileBefore),
    stableAfterRemove: JSON.stringify(report.profileAfterRemove) === JSON.stringify(report.profileBefore),
    stableFinal: JSON.stringify(report.profileFinal) === JSON.stringify(report.profileBefore),
  }
  await writeFile(join(cwd, 'scoped-preset-tree-canary.json'), JSON.stringify(report, null, 2) + '\n')
  return report
}

export function apply(ctx) {
  ctx.tools.register({
    name: 'scoped_preset_tree_canary_probe',
    description: 'Prove two retained revision-scoped non-writing PresetTrees support identical stock MCP clients.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: `SCOPED_PRESET_TREE_CANARY ${value.completed ? 'COMPLETE' : 'BLOCKED'} ${value.blocker ?? ''}` }],
    },
    async execute() {
      const report = await runCanary(ctx)
      return { completed: !report.blocker && report.cleanup.errors.length === 0, blocker: report.blocker, report }
    },
  })
}
