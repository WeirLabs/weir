import { describe, expect, it } from './helpers.js'
import { PassThrough } from 'node:stream'
import { apply, foldLspState, LSP_PROJECTION_KEY } from '../src/lsp/index.js'

/** Scripted fake LSP server over PassThrough pipes (auto-handshakes). */
function fakeSubprocess(options = {}) {
  const spawns = []
  let spawnCount = 0
  const subprocess = {
    spawns,
    resolveExecutable: async (command) => (command === 'missing-server' ? undefined : `/resolved/${command}`),
    spawn(spec) {
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      let terminated = 0
      const handle = {
        stdin,
        stdout,
        done: new Promise(() => {}),
        terminate: () => {
          terminated++
        },
        get terminated() {
          return terminated
        },
        spec,
      }
      // auto-answer initialize and shutdown; failFirstInitialize makes the
      // FIRST spawned server fail the handshake (zombie-record regression)
      const spawnIndex = spawnCount++
      const spawnOptions = options.failFirstInitialize && spawnIndex === 0
        ? { ...options, failInitialize: true }
        : options
      let buffer = Buffer.alloc(0)
      stdin.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        for (;;) {
          const headerEnd = buffer.indexOf('\r\n\r\n')
          if (headerEnd === -1) return
          const match = /Content-Length:[ \t]*(\d+)/i.exec(buffer.slice(0, headerEnd).toString('utf8'))
          const length = Number.parseInt(match?.[1] ?? '0', 10)
          if (buffer.length < headerEnd + 4 + length) return
          const body = buffer.slice(headerEnd + 4, headerEnd + 4 + length)
          buffer = buffer.slice(headerEnd + 4 + length)
          const message = JSON.parse(body.toString('utf8'))
          answer(message, stdout, spawnOptions)
        }
      })
      spawns.push(handle)
      return handle
    },
  }
  return subprocess
}

function answer(message, stdout, serverOptions = {}) {
  const reply = (response) => {
    const body = JSON.stringify(response)
    stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
  }
  if (message.method === 'initialize') {
    if (serverOptions.failInitialize) {
      reply({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'boom: no tsserver' } })
      return
    }
    reply({ jsonrpc: '2.0', id: message.id, result: { capabilities: serverOptions.capabilities ?? {} } })
    return
  }
  if (message.method === 'shutdown') {
    reply({ jsonrpc: '2.0', id: message.id, result: null })
    return
  }
  if (message.method === 'textDocument/didOpen') {
    setTimeout(() => {
      reply({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri: message.params.textDocument.uri,
          diagnostics: [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, message: 'fake error here', source: 'fake-lsp' },
          ],
        },
      })
    }, 5)
    return
  }
  if (message.method === 'textDocument/definition') {
    reply({
      jsonrpc: '2.0',
      id: message.id,
      result: [{ uri: message.params.textDocument.uri, range: { start: { line: 4, character: 1 }, end: { line: 4, character: 9 } } }],
    })
    return
  }
  if (message.method === 'textDocument/references') {
    reply({
      jsonrpc: '2.0',
      id: message.id,
      result: [
        { uri: message.params.textDocument.uri, range: { start: { line: 4, character: 1 }, end: { line: 4, character: 9 } } },
        { uri: message.params.textDocument.uri, range: { start: { line: 9, character: 2 }, end: { line: 9, character: 10 } } },
      ],
    })
    return
  }
  if (message.method === 'textDocument/documentSymbol') {
    reply({
      jsonrpc: '2.0',
      id: message.id,
      result: [
        { name: 'alphaFn', kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } }, children: [{ name: 'helperVar', kind: 14, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 10 } } }] },
      ],
    })
    return
  }
  if (message.method === 'textDocument/rename') {
    const result = serverOptions.renameResponder ? serverOptions.renameResponder(message) : null
    reply({ jsonrpc: '2.0', id: message.id, result })
    return
  }
  if (message.id !== undefined) reply({ jsonrpc: '2.0', id: message.id, result: null })
}

/** Fake settings service with a live lsp section and onChange broadcast. */
function fakeSettings() {
  const listeners = new Set()
  const holder = { lsp: undefined }
  return {
    holder,
    service: {
      get: (key) => (key === 'lsp' ? holder.lsp : undefined),
      onChange: (callback) => {
        listeners.add(callback)
        return () => listeners.delete(callback)
      },
    },
    setLsp(value) {
      if (value === undefined || value === null) holder.lsp = undefined
      else if (value === true || value === false) holder.lsp = { enabled: value }
      else holder.lsp = value
      for (const callback of listeners) callback()
    },
  }
}

const FAKE_FS_DEFAULT_TEXT = 'const alphaFn = () => 1\n'

/**
 * In-memory fs for tool flows: unknown paths read as the default text (the
 * read-only tools only need syncDocument to succeed); rename tests plant
 * per-path `{ text, version }` entries in `files`. `onWrite` is an optional
 * hook invoked at the top of each writeText — the deterministic mid-write
 * stale injection point (bump another file's version there).
 */
function fakeFs() {
  const files = {}
  const writes = []
  const fs = {
    files,
    writes,
    onWrite: null,
    resolve: async (path) => ({ displayPath: path, processPath: path }),
    stat: async (target) => {
      const entry = files[target.displayPath]
      if (!entry) return undefined
      return { version: entry.version ?? 'v1', type: 'file', size: Buffer.byteLength(entry.text, 'utf8') }
    },
    readText: async (target) => files[target.displayPath]?.text ?? FAKE_FS_DEFAULT_TEXT,
    readByteRange: async (target, range) => {
      const text = files[target.displayPath]?.text ?? FAKE_FS_DEFAULT_TEXT
      return Buffer.from(text, 'utf8').subarray(range.offset, range.offset + range.length)
    },
    writeText: async (target, content, expected) => {
      fs.onWrite?.(target.displayPath)
      const entry = files[target.displayPath]
      writes.push(target.displayPath)
      if (!entry) throw new Error(`cannot write "${target.displayPath}": not found`)
      if (expected?.kind === 'replaceIfVersion' && (entry.version ?? 'v1') !== expected.version) {
        throw new Error(`cannot write "${target.displayPath}": file changed since it was read (FS_STALE_VERSION)`)
      }
      entry.text = content
      entry.version = `${expected?.version ?? 'v1'}+w${writes.length}`
      return { version: entry.version }
    },
  }
  return fs
}

function fakeCtx(subprocess, config, services = {}) {
  const registered = []
  const handlers = {}
  const commandDefs = []
  const projectionDefs = []
  const settings = services.settings ?? fakeSettings()
  return {
    registered,
    handlers,
    commandDefs,
    projectionDefs,
    settings,
    tools: {
      register: (definition) => {
        registered.push(definition)
        return () => registered.splice(registered.indexOf(definition), 1)
      },
    },
    subprocess,
    fs: services.fs ?? fakeFs(),
    get: (name) => {
      if (name === 'weirSettings') return settings.service
      if (name === 'commands') {
        return {
          register: (definition) => {
            commandDefs.push(definition)
            return () => commandDefs.splice(commandDefs.indexOf(definition), 1)
          },
        }
      }
      if (name === 'sessionProjections') {
        return {
          register: (definition) => {
            projectionDefs.push(definition)
            return () => projectionDefs.splice(projectionDefs.indexOf(definition), 1)
          },
          stateOf: (session, key) => session?.weirState?.[key],
        }
      }
      return undefined
    },
    on: (event, handler) => {
      handlers[event] = handler
    },
  }
}

function fakeAgent(id = 'agent-1', weirState) {
  const scoped = []
  return {
    id,
    scoped,
    ctx: {
      tools: {
        register: (definition) => {
          scoped.push(definition)
          return () => scoped.splice(scoped.indexOf(definition), 1)
        },
      },
    },
    session: { header: { cwd: '/ws' }, weirState },
  }
}

const lspTool = (ctx) => ctx.registered.find((tool) => tool.name === 'lsp')

describe('lsp capability gate', () => {
  it('gate off registers nothing at all (no tool, no command, no projection)', () => {
    const ctx = fakeCtx(fakeSubprocess(), {})
    apply(ctx, {})
    expect(ctx.registered).toHaveLength(0)
    expect(ctx.commandDefs).toHaveLength(0)
    expect(ctx.projectionDefs).toHaveLength(0)
  })

  it('gate on registers the tool, the command, and the projection', () => {
    const ctx = fakeCtx(fakeSubprocess(), { enabled: true })
    apply(ctx, { enabled: true })
    expect(ctx.registered.map((tool) => tool.name)).toEqual(['lsp'])
    expect(ctx.commandDefs.map((command) => command.name)).toEqual(['lsp'])
    expect(ctx.projectionDefs.map((definition) => definition.key)).toEqual([LSP_PROJECTION_KEY])
  })

  it('the settings overlay wins over the row config', () => {
    const settings = fakeSettings()
    settings.setLsp(false)
    const ctx = fakeCtx(fakeSubprocess(), { enabled: true }, { settings })
    apply(ctx, { enabled: true })
    expect(ctx.registered).toHaveLength(0)
  })

  it('sessions start off when the gate is on', () => {
    const ctx = fakeCtx(fakeSubprocess(), { enabled: true })
    apply(ctx, { enabled: true })
    const agent = fakeAgent()
    ctx.handlers['agent/created']({ agent })
    expect(agent.scoped).toHaveLength(0)
  })

  it('flipping the gate off disposes the surface and shuts enabled sessions down', async () => {
    const settings = fakeSettings()
    settings.setLsp(true)
    const ctx = fakeCtx(fakeSubprocess(), {}, { settings })
    apply(ctx, {})
    expect(ctx.registered.map((tool) => tool.name)).toEqual(['lsp'])
    const agent = fakeAgent()
    ctx.handlers['agent/created']({ agent })
    await lspTool(ctx).execute({ enabled: true }, { agent })
    expect(agent.scoped).toHaveLength(5)
    settings.setLsp(false)
    expect(ctx.registered).toHaveLength(0)
    expect(ctx.commandDefs).toHaveLength(0)
    expect(ctx.projectionDefs).toHaveLength(0)
    expect(agent.scoped).toHaveLength(0)
  })

  it('flipping the gate back on restores the surface with sessions off', () => {
    const settings = fakeSettings()
    settings.setLsp(true)
    const ctx = fakeCtx(fakeSubprocess(), {}, { settings })
    apply(ctx, {})
    settings.setLsp(false)
    settings.setLsp(true)
    expect(ctx.registered.map((tool) => tool.name)).toEqual(['lsp'])
    expect(ctx.commandDefs.map((command) => command.name)).toEqual(['lsp'])
    expect(ctx.projectionDefs.map((definition) => definition.key)).toEqual([LSP_PROJECTION_KEY])
  })
})

describe('lsp toggle tool', () => {
  it('enable adds the four tools for the session; disable removes them', async () => {
    const ctx = fakeCtx(fakeSubprocess(), { enabled: true })
    apply(ctx, { enabled: true })
    const agent = fakeAgent()
    await lspTool(ctx).execute({ enabled: true }, { agent })
    expect(agent.scoped.map((tool) => tool.name).sort()).toEqual(['lsp_definition', 'lsp_diagnostics', 'lsp_references', 'lsp_rename', 'lsp_symbols'])
    await lspTool(ctx).execute({ enabled: false }, { agent })
    expect(agent.scoped).toHaveLength(0)
  })

  it('rejects non-boolean enabled and missing agent', async () => {
    const ctx = fakeCtx(fakeSubprocess(), { enabled: true })
    apply(ctx, { enabled: true })
    await expect(async () => lspTool(ctx).execute({ enabled: 'yes' }, { agent: fakeAgent() })).rejects.toThrow(/boolean/)
    await expect(async () => lspTool(ctx).execute({ enabled: true }, {})).rejects.toThrow(/agent/)
  })
})

describe('lsp command', () => {
  const lspCommand = (ctx) => ctx.commandDefs.find((command) => command.name === 'lsp')

  it('/lsp on and /lsp off drive the same per-session state as the tool', async () => {
    const ctx = fakeCtx(fakeSubprocess(), { enabled: true })
    apply(ctx, { enabled: true })
    const agent = fakeAgent()
    const on = await lspCommand(ctx).handler({ agent, rawInput: 'on' })
    expect(on.kind).toBe('success')
    expect(agent.scoped.map((tool) => tool.name).sort()).toEqual(['lsp_definition', 'lsp_diagnostics', 'lsp_references', 'lsp_rename', 'lsp_symbols'])
    const off = await lspCommand(ctx).handler({ agent, rawInput: 'off' })
    expect(off.kind).toBe('success')
    expect(agent.scoped).toHaveLength(0)
  })

  it('rejects bad args and missing agent', async () => {
    const ctx = fakeCtx(fakeSubprocess(), { enabled: true })
    apply(ctx, { enabled: true })
    const bad = await lspCommand(ctx).handler({ agent: fakeAgent(), rawInput: 'maybe' })
    expect(bad.kind).toBe('error')
    const missing = await lspCommand(ctx).handler({})
    expect(missing.kind).toBe('error')
  })
})

describe('weirLsp projection', () => {
  it('folds tool/call and command/run toggles, ignoring the rest', () => {
    const toolOn = { type: 'tool/call', data: { name: 'lsp', arguments: '{"enabled":true}' } }
    const toolOff = { type: 'tool/call', data: { name: 'lsp', arguments: '{"enabled":false}' } }
    const otherTool = { type: 'tool/call', data: { name: 'read', arguments: '{"file_path":"a"}' } }
    const badJson = { type: 'tool/call', data: { name: 'lsp', arguments: 'not json' } }
    const nonBoolean = { type: 'tool/call', data: { name: 'lsp', arguments: '{"enabled":"yes"}' } }
    const commandOn = { type: 'command/run', data: { name: 'lsp', args: 'on' } }
    const commandOffSpaced = { type: 'command/run', data: { name: 'lsp', args: ' off ' } }
    const otherCommand = { type: 'command/run', data: { name: 'plan', args: 'off' } }
    let state = { enabled: false }
    for (const event of [toolOn, otherTool, badJson, nonBoolean, otherCommand]) state = foldLspState(state, event)
    expect(state).toEqual({ enabled: true })
    state = foldLspState(state, commandOffSpaced)
    expect(state).toEqual({ enabled: false })
    state = foldLspState(state, commandOn)
    state = foldLspState(state, toolOff)
    expect(state).toEqual({ enabled: false })
  })

  it('registers with a parse-capable stateSchema and a default-off init', () => {
    const ctx = fakeCtx(fakeSubprocess(), { enabled: true })
    apply(ctx, { enabled: true })
    const definition = ctx.projectionDefs[0]
    expect(definition.init()).toEqual({ enabled: false })
    expect(definition.stateSchema.parse({ enabled: true })).toEqual({ enabled: true })
    expect(() => definition.stateSchema.parse({ enabled: 'yes' })).toThrow()
  })
})

describe('agent restore sync', () => {
  it('agent/created re-enables a session whose folded state is on', () => {
    const ctx = fakeCtx(fakeSubprocess(), { enabled: true })
    apply(ctx, { enabled: true })
    const agent = fakeAgent('agent-1', { [LSP_PROJECTION_KEY]: { enabled: true } })
    ctx.handlers['agent/created']({ agent })
    expect(agent.scoped).toHaveLength(5)
  })

  it('agent/disposed cleans up an enabled session', async () => {
    const ctx = fakeCtx(fakeSubprocess(), { enabled: true })
    apply(ctx, { enabled: true })
    const agent = fakeAgent()
    await lspTool(ctx).execute({ enabled: true }, { agent })
    expect(agent.scoped).toHaveLength(5)
    ctx.handlers['agent/disposed']({ agent })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(agent.scoped).toHaveLength(0)
  })

  it('gate on after a session ran re-syncs from the projection', () => {
    const settings = fakeSettings()
    const ctx = fakeCtx(fakeSubprocess(), {}, { settings })
    apply(ctx, {})
    settings.setLsp(true)
    const agent = fakeAgent('agent-1', { [LSP_PROJECTION_KEY]: { enabled: true } })
    ctx.handlers['agent/created']({ agent })
    expect(agent.scoped).toHaveLength(5)
  })
})

describe('lsp tool flows (gate on)', () => {
  it('diagnostics flow: sync document then read published diagnostics', async () => {
    const ctx = fakeCtx(fakeSubprocess(), { enabled: true })
    apply(ctx, { enabled: true })
    const agent = fakeAgent()
    await lspTool(ctx).execute({ enabled: true }, { agent })
    const diagnosticsTool = agent.scoped.find((tool) => tool.name === 'lsp_diagnostics')
    const result = await diagnosticsTool.execute({ file_path: '/ws/a.ts' }, { agent, signal: undefined })
    expect(result.text).toContain('fake error here')
    expect(result.text).toContain('[error] 1:1')
  })

  it('definition converts 1-based input and renders 1-based locations', async () => {
    const ctx = fakeCtx(fakeSubprocess(), { enabled: true })
    apply(ctx, { enabled: true })
    const agent = fakeAgent()
    await lspTool(ctx).execute({ enabled: true }, { agent })
    const definitionTool = agent.scoped.find((tool) => tool.name === 'lsp_definition')
    const result = await definitionTool.execute({ file_path: '/ws/a.ts', line: 3, character: 5 }, { agent, signal: undefined })
    expect(result.text).toContain('/ws/a.ts:5:2')
  })

  it('references renders every location; symbols renders hierarchy', async () => {
    const ctx = fakeCtx(fakeSubprocess(), { enabled: true })
    apply(ctx, { enabled: true })
    const agent = fakeAgent()
    await lspTool(ctx).execute({ enabled: true }, { agent })
    const referencesTool = agent.scoped.find((tool) => tool.name === 'lsp_references')
    const references = await referencesTool.execute({ file_path: '/ws/a.ts', line: 3, character: 5 }, { agent, signal: undefined })
    expect(references.text).toContain('2 reference(s)')
    const symbolsTool = agent.scoped.find((tool) => tool.name === 'lsp_symbols')
    const symbols = await symbolsTool.execute({ file_path: '/ws/a.ts' }, { agent, signal: undefined })
    expect(symbols.text).toContain('alphaFn (function) :1')
    expect(symbols.text).toContain('  helperVar (constant) :2')
  })

  it('a failed handshake tears the record down and the next call spawns fresh', async () => {
    const subprocess = fakeSubprocess({ failFirstInitialize: true })
    const ctx = fakeCtx(subprocess, { enabled: true })
    apply(ctx, { enabled: true })
    const agent = fakeAgent()
    await lspTool(ctx).execute({ enabled: true }, { agent })
    const diagnosticsTool = agent.scoped.find((tool) => tool.name === 'lsp_diagnostics')
    await expect(async () => diagnosticsTool.execute({ file_path: '/ws/a.ts' }, { agent, signal: undefined })).rejects.toThrow(/boom/)
    expect(subprocess.spawns).toHaveLength(1)
    expect(subprocess.spawns[0].terminated).toBe(1)
    const result = await diagnosticsTool.execute({ file_path: '/ws/a.ts' }, { agent, signal: undefined })
    expect(result.text).toContain('fake error here')
    expect(subprocess.spawns).toHaveLength(2)
  })

  it('missing server binary yields an actionable install hint', async () => {
    const subprocess = fakeSubprocess()
    subprocess.resolveExecutable = async () => {
      throw new Error('not found')
    }
    // hermetic: no extended-directory scan (the machine may really have
    // typescript-language-server installed now)
    const ctx = fakeCtx(subprocess, { enabled: true, extraBinDirs: [] })
    apply(ctx, { enabled: true, extraBinDirs: [] })
    const agent = fakeAgent()
    await lspTool(ctx).execute({ enabled: true }, { agent })
    const diagnosticsTool = agent.scoped.find((tool) => tool.name === 'lsp_diagnostics')
    await expect(async () => diagnosticsTool.execute({ file_path: '/ws/a.ts' }, { agent, signal: undefined })).rejects.toThrow(/install it first/)
  })

  it('unknown file types are rejected before any server starts', async () => {
    const subprocess = fakeSubprocess()
    const ctx = fakeCtx(subprocess, { enabled: true })
    apply(ctx, { enabled: true })
    const agent = fakeAgent()
    await lspTool(ctx).execute({ enabled: true }, { agent })
    const diagnosticsTool = agent.scoped.find((tool) => tool.name === 'lsp_diagnostics')
    await expect(async () => diagnosticsTool.execute({ file_path: '/ws/notes.xyz' }, { agent, signal: undefined })).rejects.toThrow(/no language server for file type/)
    expect(subprocess.spawns).toHaveLength(0)
  })

  it('disable after use shuts the idle server down', async () => {
    const subprocess = fakeSubprocess()
    const ctx = fakeCtx(subprocess, { enabled: true })
    apply(ctx, { enabled: true })
    const agent = fakeAgent()
    await lspTool(ctx).execute({ enabled: true }, { agent })
    const diagnosticsTool = agent.scoped.find((tool) => tool.name === 'lsp_diagnostics')
    await diagnosticsTool.execute({ file_path: '/ws/a.ts' }, { agent, signal: undefined })
    expect(subprocess.spawns).toHaveLength(1)
    await lspTool(ctx).execute({ enabled: false }, { agent })
    expect(subprocess.spawns[0].terminated).toBe(1)
  })

  it('settings tuning values feed the manager and apply live', async () => {
    const settings = fakeSettings()
    settings.setLsp({ enabled: true, idleMs: 50 })
    const subprocess = fakeSubprocess()
    const ctx = fakeCtx(subprocess, {}, { settings })
    apply(ctx, {})
    const agent = fakeAgent()
    await lspTool(ctx).execute({ enabled: true }, { agent })
    const diagnosticsTool = agent.scoped.find((tool) => tool.name === 'lsp_diagnostics')
    await diagnosticsTool.execute({ file_path: '/ws/a.ts' }, { agent, signal: undefined })
    expect(subprocess.spawns).toHaveLength(1)
    // idle 50ms from the settings section fires the shutdown
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(subprocess.spawns[0].terminated).toBe(1)
    // live tuning: raise the idle threshold; the next server must not shut down
    settings.setLsp({ enabled: true, idleMs: 60_000 })
    await diagnosticsTool.execute({ file_path: '/ws/a.ts' }, { agent, signal: undefined })
    expect(subprocess.spawns).toHaveLength(2)
    await new Promise((resolve) => setTimeout(resolve, 250))
    expect(subprocess.spawns[1].terminated).toBe(0)
  })
})

describe('lsp_rename tool', () => {
  const renameEdit = (sl, sc, el, ec, newText) => ({
    range: { start: { line: sl, character: sc }, end: { line: el, character: ec } },
    newText,
  })

  async function renameTool(ctx, agent) {
    await lspTool(ctx).execute({ enabled: true }, { agent })
    return agent.scoped.find((tool) => tool.name === 'lsp_rename')
  }

  it('applies a cross-file WorkspaceEdit through the version guard and renders diffs + summary', async () => {
    const seen = []
    const subprocess = fakeSubprocess({
      capabilities: { renameProvider: true },
      renameResponder: (message) => {
        seen.push(message.params.newName)
        return {
          changes: {
            'file:///ws/a.ts': [renameEdit(0, 6, 0, 13, message.params.newName)],
            'file:///ws/b.ts': [renameEdit(0, 9, 0, 16, message.params.newName)],
          },
        }
      },
    })
    const ctx = fakeCtx(subprocess, { enabled: true })
    ctx.fs.files['/ws/a.ts'] = { text: 'const alphaFn = () => 1\n', version: 'v1' }
    ctx.fs.files['/ws/b.ts'] = { text: 'import { alphaFn } from "./a"\n', version: 'v9' }
    apply(ctx, { enabled: true })
    const agent = fakeAgent()
    const rename = await renameTool(ctx, agent)
    const result = await rename.execute({ file_path: '/ws/a.ts', line: 1, character: 7, new_name: '  betaFn  ' }, { agent, signal: undefined })
    expect(seen).toEqual(['betaFn']) // new_name is trimmed before the request
    expect(ctx.fs.files['/ws/a.ts'].text).toBe('const betaFn = () => 1\n')
    expect(ctx.fs.files['/ws/b.ts'].text).toBe('import { betaFn } from "./a"\n')
    expect(result.text).toContain('renamed: 2 edit(s) across 2 file(s)')
    expect(result.text).toContain('--- a//ws/a.ts')
    expect(result.text).toContain('--- a//ws/b.ts')
    expect(result.text).toContain('-const alphaFn = () => 1')
    expect(result.text).toContain('+const betaFn = () => 1')
  })

  it('preserves the CRLF line-ending style on write-back', async () => {
    const subprocess = fakeSubprocess({
      capabilities: { renameProvider: true },
      renameResponder: (message) => ({
        changes: {
          'file:///ws/c.ts': [renameEdit(0, 6, 0, 13, message.params.newName), renameEdit(1, 9, 1, 16, message.params.newName)],
        },
      }),
    })
    const ctx = fakeCtx(subprocess, { enabled: true })
    ctx.fs.files['/ws/c.ts'] = { text: 'const alphaFn = 1\r\nexport { alphaFn }\r\n', version: 'v1' }
    apply(ctx, { enabled: true })
    const agent = fakeAgent()
    const rename = await renameTool(ctx, agent)
    const result = await rename.execute({ file_path: '/ws/c.ts', line: 1, character: 7, new_name: 'betaFn' }, { agent, signal: undefined })
    expect(ctx.fs.files['/ws/c.ts'].text).toBe('const betaFn = 1\r\nexport { betaFn }\r\n')
    expect(result.text).toContain('renamed: 2 edit(s) across 1 file(s)')
  })

  it('fails as an ordinary tool error when the server did not advertise renameProvider', async () => {
    const subprocess = fakeSubprocess({ capabilities: { definitionProvider: true } })
    const ctx = fakeCtx(subprocess, { enabled: true })
    ctx.fs.files['/ws/a.ts'] = { text: 'const alphaFn = () => 1\n', version: 'v1' }
    apply(ctx, { enabled: true })
    const agent = fakeAgent()
    const rename = await renameTool(ctx, agent)
    await expect(async () => rename.execute({ file_path: '/ws/a.ts', line: 1, character: 7, new_name: 'betaFn' }, { agent, signal: undefined })).rejects.toThrow(/does not support rename/)
    expect(ctx.fs.writes).toHaveLength(0)
  })

  it('rejects a documentChanges response explicitly and writes nothing', async () => {
    const subprocess = fakeSubprocess({
      capabilities: { renameProvider: true },
      renameResponder: () => ({ documentChanges: [{ textDocument: { uri: 'file:///ws/a.ts', version: 1 }, edits: [] }] }),
    })
    const ctx = fakeCtx(subprocess, { enabled: true })
    ctx.fs.files['/ws/a.ts'] = { text: 'const alphaFn = () => 1\n', version: 'v1' }
    apply(ctx, { enabled: true })
    const agent = fakeAgent()
    const rename = await renameTool(ctx, agent)
    await expect(async () => rename.execute({ file_path: '/ws/a.ts', line: 1, character: 7, new_name: 'betaFn' }, { agent, signal: undefined })).rejects.toThrow(/documentChanges.*does not apply/)
    expect(ctx.fs.writes).toHaveLength(0)
  })

  it('reports a no-op for empty changes and for identity edits (zero writes)', async () => {
    const subprocess = fakeSubprocess({
      capabilities: { renameProvider: true },
      renameResponder: () => ({ changes: {} }),
    })
    const ctx = fakeCtx(subprocess, { enabled: true })
    ctx.fs.files['/ws/a.ts'] = { text: 'const alphaFn = () => 1\n', version: 'v1' }
    apply(ctx, { enabled: true })
    const agent = fakeAgent()
    const rename = await renameTool(ctx, agent)
    const empty = await rename.execute({ file_path: '/ws/a.ts', line: 1, character: 7, new_name: 'betaFn' }, { agent, signal: undefined })
    expect(empty.text).toContain('no-op')
    expect(ctx.fs.writes).toHaveLength(0)
    // identity: the server's edit replaces the symbol with the same text
    const identitySub = fakeSubprocess({
      capabilities: { renameProvider: true },
      renameResponder: () => ({ changes: { 'file:///ws/a.ts': [renameEdit(0, 6, 0, 13, 'alphaFn')] } }),
    })
    const ctx2 = fakeCtx(identitySub, { enabled: true })
    ctx2.fs.files['/ws/a.ts'] = { text: 'const alphaFn = () => 1\n', version: 'v1' }
    apply(ctx2, { enabled: true })
    const agent2 = fakeAgent()
    const rename2 = await renameTool(ctx2, agent2)
    const identity = await rename2.execute({ file_path: '/ws/a.ts', line: 1, character: 7, new_name: 'alphaFn' }, { agent: agent2, signal: undefined })
    expect(identity.text).toContain('no-op')
    expect(identity.text).toContain('unchanged')
    expect(ctx2.fs.writes).toHaveLength(0)
  })

  it('preflight failure (out-of-bounds or overlapping edits) writes nothing at all', async () => {
    const subprocess = fakeSubprocess({
      capabilities: { renameProvider: true },
      renameResponder: () => ({
        changes: {
          'file:///ws/a.ts': [renameEdit(0, 6, 0, 13, 'betaFn')],
          'file:///ws/b.ts': [renameEdit(4, 0, 4, 3, 'betaFn')],
        },
      }),
    })
    const ctx = fakeCtx(subprocess, { enabled: true })
    ctx.fs.files['/ws/a.ts'] = { text: 'const alphaFn = () => 1\n', version: 'v1' }
    ctx.fs.files['/ws/b.ts'] = { text: 'import { alphaFn } from "./a"\n', version: 'v9' }
    apply(ctx, { enabled: true })
    const agent = fakeAgent()
    const rename = await renameTool(ctx, agent)
    await expect(async () => rename.execute({ file_path: '/ws/a.ts', line: 1, character: 7, new_name: 'betaFn' }, { agent, signal: undefined })).rejects.toThrow(/out of bounds/)
    expect(ctx.fs.writes).toHaveLength(0)
    expect(ctx.fs.files['/ws/a.ts'].text).toBe('const alphaFn = () => 1\n')
    expect(ctx.fs.files['/ws/b.ts'].text).toBe('import { alphaFn } from "./a"\n')

    const overlapping = fakeSubprocess({
      capabilities: { renameProvider: true },
      renameResponder: () => ({ changes: { 'file:///ws/a.ts': [renameEdit(0, 0, 0, 10, 'x'), renameEdit(0, 6, 0, 13, 'y')] } }),
    })
    const ctx2 = fakeCtx(overlapping, { enabled: true })
    ctx2.fs.files['/ws/a.ts'] = { text: 'const alphaFn = () => 1\n', version: 'v1' }
    apply(ctx2, { enabled: true })
    const agent2 = fakeAgent()
    const rename2 = await renameTool(ctx2, agent2)
    await expect(async () => rename2.execute({ file_path: '/ws/a.ts', line: 1, character: 7, new_name: 'betaFn' }, { agent: agent2, signal: undefined })).rejects.toThrow(/overlapping/)
    expect(ctx2.fs.writes).toHaveLength(0)
  })

  it('a stale version mid-write stops immediately and names written/not-written files', async () => {
    const subprocess = fakeSubprocess({
      capabilities: { renameProvider: true },
      renameResponder: (message) => ({
        changes: {
          'file:///ws/a.ts': [renameEdit(0, 6, 0, 13, message.params.newName)],
          'file:///ws/b.ts': [renameEdit(0, 9, 0, 16, message.params.newName)],
        },
      }),
    })
    const ctx = fakeCtx(subprocess, { enabled: true })
    ctx.fs.files['/ws/a.ts'] = { text: 'const alphaFn = () => 1\n', version: 'v1' }
    ctx.fs.files['/ws/b.ts'] = { text: 'import { alphaFn } from "./a"\n', version: 'v9' }
    // Deterministic mid-write injection: the first write bumps b's version,
    // so b's replaceIfVersion rejects exactly like an external modification
    // between preflight and write.
    ctx.fs.onWrite = (path) => {
      if (path === '/ws/a.ts') ctx.fs.files['/ws/b.ts'].version = 'external-edit'
    }
    apply(ctx, { enabled: true })
    const agent = fakeAgent()
    const rename = await renameTool(ctx, agent)
    let failure
    try {
      await rename.execute({ file_path: '/ws/a.ts', line: 1, character: 7, new_name: 'betaFn' }, { agent, signal: undefined })
    } catch (error) {
      failure = error
    }
    expect(failure).toBeTruthy()
    expect(failure.message).toContain('FS_STALE_VERSION')
    expect(failure.message).toContain('filesAlreadyWritten: [/ws/a.ts]')
    expect(failure.message).toContain('filesNotWritten: [/ws/b.ts]')
    // a.ts was written; b.ts kept its original bytes; nothing further written
    expect(ctx.fs.files['/ws/a.ts'].text).toBe('const betaFn = () => 1\n')
    expect(ctx.fs.files['/ws/b.ts'].text).toBe('import { alphaFn } from "./a"\n')
    expect(ctx.fs.writes).toEqual(['/ws/a.ts', '/ws/b.ts'])
  })

  it('rejects an empty or blank new_name before any server round-trip', async () => {
    const subprocess = fakeSubprocess({ capabilities: { renameProvider: true } })
    const ctx = fakeCtx(subprocess, { enabled: true })
    apply(ctx, { enabled: true })
    const agent = fakeAgent()
    const rename = await renameTool(ctx, agent)
    await expect(async () => rename.execute({ file_path: '/ws/a.ts', line: 1, character: 7, new_name: '' }, { agent, signal: undefined })).rejects.toThrow(/new_name/)
    await expect(async () => rename.execute({ file_path: '/ws/a.ts', line: 1, character: 7, new_name: '   ' }, { agent, signal: undefined })).rejects.toThrow(/new_name/)
    expect(subprocess.spawns).toHaveLength(0)
  })
})
