import { describe, expect, it } from './helpers.js'
import { PassThrough } from 'node:stream'
import { apply, foldLspState, LSP_PROJECTION_KEY } from '../src/lsp/index.js'

/** Scripted fake LSP server over PassThrough pipes (auto-handshakes). */
function fakeSubprocess() {
  const spawns = []
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
      // auto-answer initialize and shutdown
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
          answer(message, stdout)
        }
      })
      spawns.push(handle)
      return handle
    },
  }
  return subprocess
}

function answer(message, stdout) {
  const reply = (response) => {
    const body = JSON.stringify(response)
    stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
  }
  if (message.method === 'initialize') {
    reply({ jsonrpc: '2.0', id: message.id, result: { capabilities: {} } })
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
    setLsp(enabled) {
      holder.lsp = enabled === undefined ? undefined : { enabled }
      for (const callback of listeners) callback()
    },
  }
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
    fs: {
      resolve: async (path) => ({ displayPath: path, processPath: path }),
      readText: async () => 'const alphaFn = () => 1\n',
    },
    get: (name) => {
      if (name === 'orrerySettings') return settings.service
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
          stateOf: (session, key) => session?.orreryState?.[key],
        }
      }
      return undefined
    },
    on: (event, handler) => {
      handlers[event] = handler
    },
  }
}

function fakeAgent(id = 'agent-1', orreryState) {
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
    session: { header: { cwd: '/ws' }, orreryState },
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
    expect(agent.scoped).toHaveLength(4)
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
    expect(agent.scoped.map((tool) => tool.name).sort()).toEqual(['lsp_definition', 'lsp_diagnostics', 'lsp_references', 'lsp_symbols'])
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
    expect(agent.scoped.map((tool) => tool.name).sort()).toEqual(['lsp_definition', 'lsp_diagnostics', 'lsp_references', 'lsp_symbols'])
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

describe('orreryLsp projection', () => {
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
    expect(agent.scoped).toHaveLength(4)
  })

  it('agent/disposed cleans up an enabled session', async () => {
    const ctx = fakeCtx(fakeSubprocess(), { enabled: true })
    apply(ctx, { enabled: true })
    const agent = fakeAgent()
    await lspTool(ctx).execute({ enabled: true }, { agent })
    expect(agent.scoped).toHaveLength(4)
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
    expect(agent.scoped).toHaveLength(4)
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

  it('missing server binary yields an actionable install hint', async () => {
    const subprocess = fakeSubprocess()
    subprocess.resolveExecutable = async () => {
      throw new Error('not found')
    }
    const ctx = fakeCtx(subprocess, { enabled: true })
    apply(ctx, { enabled: true })
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
    await expect(async () => diagnosticsTool.execute({ file_path: '/ws/notes.md' }, { agent, signal: undefined })).rejects.toThrow(/no language server for file type/)
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
})
