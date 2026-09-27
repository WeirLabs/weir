import { describe, expect, it } from './helpers.js'
import { PassThrough } from 'node:stream'
import { apply } from '../src/lsp/index.js'

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

function fakeCtx(subprocess, config) {
  const registered = []
  const handlers = {}
  return {
    registered,
    handlers,
    tools: { register: (definition) => registered.push(definition) },
    subprocess,
    fs: {
      resolve: async (path) => ({ displayPath: path, processPath: path }),
      readText: async () => 'const alphaFn = () => 1\n',
    },
    get: () => undefined,
    on: (event, handler) => {
      handlers[event] = handler
    },
  }
}

function fakeAgent(id = 'agent-1') {
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
    session: { header: { cwd: '/ws' } },
  }
}

describe('lsp plugin', () => {
  it('registers only the toggle by default; enable adds the four tools for the session', async () => {
    const ctx = fakeCtx(fakeSubprocess(), {})
    apply(ctx, {})
    expect(ctx.registered.map((tool) => tool.name)).toEqual(['lsp'])
    const agent = fakeAgent()
    await ctx.registered[0].execute({ enabled: true }, { agent })
    expect(agent.scoped.map((tool) => tool.name).sort()).toEqual(['lsp_definition', 'lsp_diagnostics', 'lsp_references', 'lsp_symbols'])
  })

  it('disable unregisters the tools and releases the session', async () => {
    const ctx = fakeCtx(fakeSubprocess(), {})
    apply(ctx, {})
    const agent = fakeAgent()
    await ctx.registered[0].execute({ enabled: true }, { agent })
    await ctx.registered[0].execute({ enabled: false }, { agent })
    expect(agent.scoped).toHaveLength(0)
  })

  it('config.enabled auto-enables on agent/created', () => {
    const ctx = fakeCtx(fakeSubprocess(), {})
    apply(ctx, { enabled: true })
    const agent = fakeAgent()
    ctx.handlers['agent/created']({ agent })
    expect(agent.scoped).toHaveLength(4)
  })

  it('diagnostics flow: sync document then read published diagnostics', async () => {
    const ctx = fakeCtx(fakeSubprocess(), {})
    apply(ctx, {})
    const agent = fakeAgent()
    await ctx.registered[0].execute({ enabled: true }, { agent })
    const diagnosticsTool = agent.scoped.find((tool) => tool.name === 'lsp_diagnostics')
    const result = await diagnosticsTool.execute({ file_path: '/ws/a.ts' }, { agent, signal: undefined })
    expect(result.text).toContain('fake error here')
    expect(result.text).toContain('[error] 1:1')
  })

  it('definition converts 1-based input and renders 1-based locations', async () => {
    const ctx = fakeCtx(fakeSubprocess(), {})
    apply(ctx, {})
    const agent = fakeAgent()
    await ctx.registered[0].execute({ enabled: true }, { agent })
    const definitionTool = agent.scoped.find((tool) => tool.name === 'lsp_definition')
    const result = await definitionTool.execute({ file_path: '/ws/a.ts', line: 3, character: 5 }, { agent, signal: undefined })
    expect(result.text).toContain('/ws/a.ts:5:2')
  })

  it('references renders every location; symbols renders hierarchy', async () => {
    const ctx = fakeCtx(fakeSubprocess(), {})
    apply(ctx, {})
    const agent = fakeAgent()
    await ctx.registered[0].execute({ enabled: true }, { agent })
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
    const ctx = fakeCtx(subprocess, {})
    apply(ctx, {})
    const agent = fakeAgent()
    await ctx.registered[0].execute({ enabled: true }, { agent })
    const diagnosticsTool = agent.scoped.find((tool) => tool.name === 'lsp_diagnostics')
    await expect(async () => diagnosticsTool.execute({ file_path: '/ws/a.ts' }, { agent, signal: undefined })).rejects.toThrow(/install it first/)
  })

  it('unknown file types are rejected before any server starts', async () => {
    const subprocess = fakeSubprocess()
    const ctx = fakeCtx(subprocess, {})
    apply(ctx, {})
    const agent = fakeAgent()
    await ctx.registered[0].execute({ enabled: true }, { agent })
    const diagnosticsTool = agent.scoped.find((tool) => tool.name === 'lsp_diagnostics')
    await expect(async () => diagnosticsTool.execute({ file_path: '/ws/notes.md' }, { agent, signal: undefined })).rejects.toThrow(/no language server for file type/)
    expect(subprocess.spawns).toHaveLength(0)
  })

  it('disable after use shuts the idle server down', async () => {
    const subprocess = fakeSubprocess()
    const ctx = fakeCtx(subprocess, {})
    apply(ctx, {})
    const agent = fakeAgent()
    await ctx.registered[0].execute({ enabled: true }, { agent })
    const diagnosticsTool = agent.scoped.find((tool) => tool.name === 'lsp_diagnostics')
    await diagnosticsTool.execute({ file_path: '/ws/a.ts' }, { agent, signal: undefined })
    expect(subprocess.spawns).toHaveLength(1)
    await ctx.registered[0].execute({ enabled: false }, { agent })
    expect(subprocess.spawns[0].terminated).toBe(1)
  })
})
