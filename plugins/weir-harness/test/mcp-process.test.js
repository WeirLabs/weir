import { test, expect } from './helpers.js'
import assert from 'node:assert/strict'
import { createMcpProcessAdapter } from '../src/capabilities/mcp-process.js'
import { spawnArgv } from '../src/process/index.js'
import { win32 } from 'node:path'

test('MCP stdio preparation preserves args, resolves the executable and injects PATH below explicit env', async () => {
  const adapter = createMcpProcessAdapter({
    subprocess: {},
    resolve: async (_service, command) => `/resolved/${command}`,
    env: { PATH: '/usr/bin:/bin', HOME: '/home/test' },
  })
  const args = ['-y', 'package with spaces', '--token=secret-arg']
  const prepared = await adapter.prepare({ transport: 'stdio', command: 'npx', args, env: { TOKEN: 'explicit', PATH: '/custom' } })
  expect(prepared.client.command).toBe('/resolved/npx')
  expect(prepared.client.args).toEqual(args)
  expect(prepared.client.env.TOKEN).toBe('explicit')
  expect(prepared.client.env.PATH).toBe('/custom')
  expect(prepared.execution).toEqual({ requestedCommand: 'npx', resolvedCommand: '/resolved/npx', argumentCount: 3, windowsShim: false })
  const augmented = await createMcpProcessAdapter({ resolve: async () => '/resolved/node', env: { PATH: '/usr/bin', HOME: '/home/test' } }).prepare({ transport: 'stdio', command: 'node', args: [], env: {} })
  expect(augmented.client.env.PATH).toContain('/usr/bin')
  expect(augmented.client.env.PATH).toContain('/home/test/.npm-global/bin')
})

test('missing executable is actionable and HTTP never enters process preparation', async () => {
  const adapter = createMcpProcessAdapter({ resolve: async () => undefined })
  await assert.rejects(adapter.prepare({ transport: 'stdio', command: 'missing-npx', args: [] }), error => error.code === 'executable-not-found' && error.status === 'validation-failed')
  const http = await adapter.prepare({ transport: 'streamable-http', url: 'https://example.test/mcp' })
  expect(http.execution).toBeNull()
  expect(http.client.url).toBe('https://example.test/mcp')
})

test('Windows npm shim unwrap preserves original args and Windows child environment', async () => {
  const adapter = createMcpProcessAdapter({
    platform: 'win32',
    resolve: async () => 'C:\\npm\\npx.cmd',
    env: { PATH: 'C:\\Windows\\system32', SystemRoot: 'C:\\Windows', ComSpec: 'C:\\Windows\\system32\\cmd.exe', HOME: 'C:\\Users\\test' },
    launchShape: (command, args, platform) => spawnArgv(command, args, platform, {
      binaryPath: 'C:\\node\\node.exe',
      readTextFile: () => '@ECHO OFF\r\n"node" "C:/npm/server.js" %*\r\n',
      existsFile: path => path === 'C:/npm/server.js',
      join: win32.join,
      dirname: win32.dirname,
    }),
  })
  const prepared = await adapter.prepare({ transport: 'stdio', command: 'npx', args: ['-y', 'hello world'], env: {} })
  expect(prepared.client.command).toBe('C:\\node\\node.exe')
  expect(prepared.client.args).toEqual(['C:/npm/server.js', '-y', 'hello world'])
  expect(prepared.client.env.SystemRoot).toBe('C:\\Windows')
  expect(prepared.client.env.ComSpec).toBe('C:\\Windows\\system32\\cmd.exe')
  expect(prepared.client.env.PATH).toContain('C:\\Windows\\system32')
  expect(prepared.execution.windowsShim).toBe(true)
})

test('shim error subject is generic while the legacy LSP message remains byte-compatible', () => {
  const options = { readTextFile: () => 'unknown', existsFile: () => false }
  assert.throws(() => spawnArgv('C:\\bad path\\x.cmd', ['unsafe arg'], 'win32', options), error => error.message.startsWith('lsp:') && error.message.includes('point lspServers'))
  assert.throws(() => spawnArgv('C:\\bad path\\x.cmd', ['unsafe arg'], 'win32', { ...options, subject: 'mcp', setting: 'command' }), error => error.message.startsWith('mcp:') && error.message.includes('point command'))
})
