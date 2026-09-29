import { describe, expect, it } from './helpers.js'
import { PassThrough } from 'node:stream'
import { createLspClient, handshake, shutdownClient } from '../src/lsp/client.js'
import { pathToUri, uriToPath } from '../src/lsp/manager.js'
import { DEFAULT_SERVERS, buildRegistry, displayInstallCommand, familyForLanguageId, installSpecFor, languageIdForFile } from '../src/lsp/registry.js'

function fakeChannel() {
  const stdin = new PassThrough()
  const stdout = new PassThrough()
  return { stdin, stdout }
}

function framed(message) {
  const body = JSON.stringify(message)
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`
}

describe('lsp client framing', () => {
  it('routes a response to its request', async () => {
    const { stdin, stdout } = fakeChannel()
    const client = createLspClient({ stdin, stdout })
    const pendingRequest = client.request('textDocument/definition', { textDocument: { uri: 'file:///x' } })
    stdout.write(framed({ jsonrpc: '2.0', id: 1, result: [{ uri: 'file:///x', range: {} }] }))
    const result = await pendingRequest
    expect(result).toEqual([{ uri: 'file:///x', range: {} }])
  })

  it('parses frames split across chunks and batched in one chunk', async () => {
    const { stdin, stdout } = fakeChannel()
    const client = createLspClient({ stdin, stdout })
    const first = client.request('m/one', {})
    const second = client.request('m/two', {})
    const r1 = framed({ jsonrpc: '2.0', id: 1, result: 'one' })
    const r2 = framed({ jsonrpc: '2.0', id: 2, result: 'two' })
    const joined = r1 + r2
    stdout.write(joined.slice(0, 10))
    stdout.write(joined.slice(10))
    expect(await first).toBe('one')
    expect(await second).toBe('two')
  })

  it('skips malformed headers and resyncs', async () => {
    const { stdin, stdout } = fakeChannel()
    const client = createLspClient({ stdin, stdout })
    const pendingRequest = client.request('m/x', {})
    stdout.write('garbage-header\r\n\r\n')
    stdout.write(framed({ jsonrpc: '2.0', id: 1, result: 'ok' }))
    expect(await pendingRequest).toBe('ok')
  })

  it('dispatches notifications and answers server requests with null', async () => {
    const { stdin, stdout } = fakeChannel()
    const notifications = []
    const client = createLspClient({ stdin, stdout, onNotification: (method, params) => notifications.push({ method, params }) })
    stdout.write(framed({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri: 'file:///d', diagnostics: [] } }))
    stdout.write(framed({ jsonrpc: '2.0', id: 99, method: 'workspace/configuration', params: { items: [] } }))
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 10))
    expect(notifications).toHaveLength(1)
    expect(notifications[0].method).toBe('textDocument/publishDiagnostics')
    const answered = stdin.read()?.toString() ?? ''
    expect(answered).toContain('"id":99')
    expect(answered).toContain('"result":null')
  })

  it('rejects on LSP error responses and on timeout', async () => {
    const { stdin, stdout } = fakeChannel()
    const client = createLspClient({ stdin, stdout, timeoutMs: 20 })
    const withError = client.request('m/bad', {})
    stdout.write(framed({ jsonrpc: '2.0', id: 1, error: { code: -32601, message: 'method not found' } }))
    await expect(async () => withError).rejects.toThrow(/method not found/)
    await expect(async () => client.request('m/slow', {})).rejects.toThrow(/timed out/)
  })

  it('handshake sends initialize then initialized', async () => {
    const { stdin, stdout } = fakeChannel()
    const client = createLspClient({ stdin, stdout })
    const shake = handshake(client, 'file:///ws')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
    stdout.write(framed({ jsonrpc: '2.0', id: 1, result: { capabilities: { definitionProvider: true } } }))
    const capabilities = await shake
    expect(capabilities.definitionProvider).toBe(true)
    const sent = stdin.read()?.toString() ?? ''
    expect(sent).toContain('"method":"initialize"')
    expect(sent).toContain('"method":"initialized"')
  })

  it('handshake declares rename and changes-only workspaceEdit capabilities', async () => {
    const { stdin, stdout } = fakeChannel()
    const client = createLspClient({ stdin, stdout })
    const shake = handshake(client, 'file:///ws')
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
    stdout.write(framed({ jsonrpc: '2.0', id: 1, result: { capabilities: {} } }))
    await shake
    const sent = stdin.read()?.toString() ?? ''
    const headerEnd = sent.indexOf('\r\n\r\n')
    const length = Number.parseInt(/Content-Length:[ \t]*(\d+)/i.exec(sent.slice(0, headerEnd))?.[1] ?? '0', 10)
    const initialize = JSON.parse(sent.slice(headerEnd + 4, headerEnd + 4 + length))
    const capabilities = initialize.params.capabilities
    expect(capabilities.textDocument.rename).toEqual({})
    expect(capabilities.workspace).toEqual({ workspaceEdit: { documentChanges: false } })
  })

  it('shutdownClient requests shutdown, notifies exit, terminates', async () => {
    const { stdin, stdout } = fakeChannel()
    const client = createLspClient({ stdin, stdout })
    let terminated = 0
    const shutdown = shutdownClient(client, () => terminated++)
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 5))
    stdout.write(framed({ jsonrpc: '2.0', id: 1, result: null }))
    await shutdown
    expect(terminated).toBe(1)
    const sent = stdin.read()?.toString() ?? ''
    expect(sent).toContain('"method":"shutdown"')
    expect(sent).toContain('"method":"exit"')
  })
})

describe('lsp registry and uri helpers', () => {
  it('maps file extensions to languageIds and families', () => {
    expect(languageIdForFile('/x/a.ts')).toBe('typescript')
    expect(languageIdForFile('/x/b.tsx')).toBe('typescriptreact')
    expect(languageIdForFile('/x/c.py')).toBe('python')
    expect(languageIdForFile('/x/d.go')).toBe('go')
    expect(languageIdForFile('/x/e.rs')).toBe('rust')
    expect(languageIdForFile('/x/f.md')).toBe('markdown')
    expect(languageIdForFile('/x/g.yml')).toBe('yaml')
    expect(languageIdForFile('/x/h.lua')).toBe('lua')
    expect(languageIdForFile('/x/i.cpp')).toBe('cpp')
    expect(languageIdForFile('/x/j.sh')).toBe('bash')
    expect(languageIdForFile('/x/Dockerfile')).toBe('dockerfile')
    expect(languageIdForFile('/x/unknown.xyz')).toBe(undefined)
    expect(familyForLanguageId('typescriptreact')).toBe('typescript')
    expect(familyForLanguageId('python')).toBe('python')
    expect(familyForLanguageId('c')).toBe('cpp')
    expect(familyForLanguageId('jsonc')).toBe('json')
  })

  it('overlays user server config over defaults', () => {
    const registry = buildRegistry({ typescript: { command: '/custom/tsserver' }, kotlin: { command: 'kotlin-ls', args: [] } })
    expect(registry.typescript.command).toBe('/custom/tsserver')
    expect(registry.typescript.args).toEqual(['--stdio'])
    expect(registry.kotlin.command).toBe('kotlin-ls')
    expect(registry.go.command).toBe('gopls')
  })

  it('resolves platform install specs and display commands', () => {
    expect(installSpecFor(DEFAULT_SERVERS.typescript, 'darwin')).toEqual({ command: 'npm', args: ['install', '-g', 'typescript-language-server', 'typescript'] })
    expect(installSpecFor(DEFAULT_SERVERS.lua, 'darwin')).toEqual({ command: 'brew', args: ['install', 'lua-language-server'] })
    expect(installSpecFor(DEFAULT_SERVERS.lua, 'linux')).toBe(undefined)
    expect(installSpecFor(DEFAULT_SERVERS.cpp, 'linux')).toEqual({ command: 'sudo', args: ['apt-get', 'install', '-y', 'clangd'] })
    expect(installSpecFor({ command: 'x' }, 'darwin')).toBe(undefined)
    expect(displayInstallCommand(DEFAULT_SERVERS.typescript)).toBe('npm install -g typescript-language-server typescript')
    expect(displayInstallCommand(DEFAULT_SERVERS.lua, 'darwin')).toBe('brew install lua-language-server')
    // where the platform has no spec, the display form falls back to the
    // multi-platform hint rather than an empty or wrong command. The platform is
    // passed explicitly: its default is the HOST, so an argument-less call pins a
    // different string on every machine and passed on Windows alone.
    expect(displayInstallCommand(DEFAULT_SERVERS.lua, 'linux')).toBe(DEFAULT_SERVERS.lua.installHint)
  })

  it('round-trips file URIs', () => {
    expect(pathToUri('/tmp/a b/x.ts')).toBe('file:///tmp/a%20b/x.ts')
    expect(uriToPath('file:///tmp/a%20b/x.ts')).toBe('/tmp/a b/x.ts')
  })

  it('strips the leading slash on win32 drive-letter URIs only', () => {
    expect(uriToPath('file:///C:/ws/a.ts')).toBe('C:/ws/a.ts')
    expect(uriToPath('file:///c:/ws/a.ts')).toBe('c:/ws/a.ts')
    // POSIX paths (no drive-letter shape) keep their leading slash
    expect(uriToPath('file:///tmp/a%20b/x.ts')).toBe('/tmp/a b/x.ts')
    expect(uriToPath('file:///home/u/x.ts')).toBe('/home/u/x.ts')
  })
})
