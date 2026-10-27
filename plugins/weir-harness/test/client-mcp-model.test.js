import { test, expect } from './helpers.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import vm from 'node:vm'

function loadModel() {
  const source = readFileSync(fileURLToPath(new URL('../lib/client.capability-model.js', import.meta.url)), 'utf8')
  const loaded = {}
  const sandbox = { __ModuleLoader__: { load: ({ factory }) => { loaded.exports = factory(() => { throw new Error('zero-dependency chunk') }) } } }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  return loaded.exports
}
const realmless = value => JSON.parse(JSON.stringify(value))
const model = Object.fromEntries(Object.entries(loadModel()).map(([key, fn]) => [key, (...args) => realmless(fn(...args))]))

const managedServer = () => ({
  identity: 'docs', label: 'Documentation', serverName: 'docs-public', transport: 'stdio',
  incarnation: 'inc-1', generation: 3, defaultEnabled: true, state: 'degraded', fingerprint: 'f-1',
  config: {
    identity: 'docs', label: 'Documentation', transport: { kind: 'stdio', ref: 'cmd:node' },
    client: { transport: 'stdio', serverName: 'docs-public', command: 'node', args: ['--flag', '[redacted]'], env: { LEGACY: '[redacted]' }, reconnect: { enabled: true, initialDelayMs: 10, maxDelayMs: 100 } },
    secretRefs: { env: { TOKEN: { ref: 'USER_TOKEN' } }, args: { 1: { ref: 'CLI_TOKEN' } } },
  },
})

test('inventory keeps every managed state and failed reads retain last-good rows as stale', () => {
  const partition = model.partitionManagerListing({
    skills: [], mcpServers: [
      { identity: 'mounted', state: 'mounted' }, { identity: 'degraded', state: 'degraded' },
      { identity: 'cleanup', state: 'cleanup-unknown' }, { identity: 'conflict', state: 'conflict' },
      { identity: 'unknown', state: 'future-state' }, { serverName: 'host', state: 'unmanaged' },
    ],
  })
  expect(partition.mcpManaged.map(row => row.identity)).toEqual(['mounted', 'degraded', 'cleanup', 'conflict', 'unknown'])
  expect(partition.mcpUnmanaged).toEqual([{ serverName: 'host', state: 'unmanaged' }])
  expect(model.mcpStateOf({ state: 'future-state' })).toBe('unknown')

  const good = { mcpServers: [{ identity: 'docs', config: { client: { env: { TOKEN: '[redacted]' } } } }] }
  const stale = model.mcpListingAfterRead(good, { error: true })
  expect(stale.stale).toBe(true)
  expect(stale.refreshError).toBe(true)
  expect(stale.mcpServers).toEqual(good.mcpServers)
  expect(model.mcpListingAfterRead(null, { error: true })).toEqual({ error: true })
  expect(model.mcpListingAfterRead(good, { mcpServers: [] })).toEqual({ mcpServers: [] })
})

test('redacted edit config supports blank-keep, ref replacement, secret replacement and removal without echo', () => {
  const server = managedServer()
  const editor = model.mcpEditorFromServer(server, 7)
  expect(editor.registryRevision).toBe(7)
  expect(editor.targetFingerprint).toBe('f-1')
  expect(editor.argsText).toBe('["--flag",""]')
  expect(editor.envRows.every(row => row.value === '')).toBe(true)
  expect(editor.reconnectEnabled).toBe(true)
  expect(model.mcpEditorHasSecrets(editor)).toBe(true)

  const keep = model.mcpConfigFromEditor({ ...editor, label: 'Renamed' })
  expect(keep.label).toBe('Renamed')
  expect(keep.secretRefs).toBeUndefined()
  expect(keep.secretValues).toBeUndefined()
  expect(JSON.stringify(keep)).not.toContain('[redacted]')

  const replacedRef = model.mcpConfigFromEditor({
    ...editor,
    envRows: editor.envRows.map(row => row.key === 'TOKEN' ? { ...row, action: 'replace', source: 'ref', ref: 'OTHER_TOKEN' } : row),
  })
  expect(replacedRef.secretRefs.env.TOKEN).toEqual({ ref: 'OTHER_TOKEN' })

  const replacedSecret = model.mcpConfigFromEditor({
    ...editor,
    envRows: editor.envRows.map(row => row.key === 'TOKEN' ? { ...row, action: 'replace', source: 'value', value: 'new-canary', prefix: 'Bearer ' } : row),
    secretArgRows: editor.secretArgRows.map(row => ({ ...row, action: 'replace', source: 'value', value: 'arg-canary', prefix: 'Bearer ' })),
  })
  expect(replacedSecret.secretValues.env.TOKEN).toEqual({ action: 'replace', value: 'new-canary', prefix: 'Bearer ' })
  expect(replacedSecret.secretValues.args[1]).toEqual({ action: 'replace', value: 'arg-canary', prefix: 'Bearer ' })
  const clearedPrefix = model.mcpConfigFromEditor({
    ...editor,
    envRows: editor.envRows.map(row => row.key === 'TOKEN' ? { ...row, action: 'replace', source: 'value', value: 'next-canary', prefix: '', prefixDirty: true } : row),
  })
  expect(clearedPrefix.secretValues.env.TOKEN).toEqual({ action: 'replace', value: 'next-canary', prefix: '' })
  expect(replacedSecret.client).toBeUndefined()

  const removed = model.mcpConfigFromEditor({
    ...editor,
    envRows: editor.envRows.map(row => row.key === 'LEGACY' ? { ...row, action: 'remove' } : row),
  })
  expect(removed.secretValues.env.LEGACY).toEqual({ action: 'remove' })
  expect(model.mcpPreviewSupportOf({ capabilities: { credentials: false, ephemeral: false } }, true))
    .toEqual(['credentials-unavailable', 'ephemeral-loader-unavailable'])
  expect(model.mcpPreviewSupportOf({ capabilities: { credentials: false, ephemeral: false } }, false)).toEqual([])
})

test('transport-specific advanced validation names fields without throwing on bad args', () => {
  const editor = {
    ...model.mcpEditorFromServer(null, 0), identity: 'bad identity', serverName: 'bad name', command: '', argsText: '[invalid',
    toolCallTimeoutMs: '-1', maxInstructionBytes: '1.5', reconnectInitialDelayMs: '50', reconnectMaxDelayMs: '10',
    envRows: [{ key: 'DUP', action: 'replace', source: 'ref', ref: 'bad-ref', value: '' }, { key: 'DUP', action: 'replace', source: 'ref', ref: 'ALSO_BAD', value: '' }],
    secretArgRows: [{ index: '99', action: 'replace', source: 'value', value: 'x' }],
  }
  const errors = model.mcpEditorErrorsOf(editor)
  expect(errors.identity).toBe('invalid')
  expect(errors.serverName).toBe('invalid')
  expect(errors.command).toBe('required')
  expect(errors.args).toBe('invalid')
  expect(errors.toolCallTimeoutMs).toBe('invalid')
  expect(errors.maxInstructionBytes).toBe('invalid')
  expect(errors.reconnect).toBe('invalid')
  expect(errors['env.0']).toBe('invalid-ref')
  expect(errors['env.1']).toBe('duplicate')
  expect(errors['args.0']).toBe('invalid-index')

  const empty = { ...model.mcpEditorFromServer(null, 0), identity: 'docs', serverName: 'docs' }
  empty.command = 'node'
  empty.envRows = [{ key: '', action: 'replace', source: 'value', ref: '', value: '' }]
  expect(model.mcpEditorErrorsOf(empty)).toEqual({})
  expect(model.mcpConfigFromEditor(empty).secretValues).toBeUndefined()
})

test('sensitive HTTP URLs use transient secret values while ordinary URLs stay portable', () => {
  const base = { ...model.mcpEditorFromServer(null, 0), transport: 'streamable-http', identity: 'http', serverName: 'http' }
  const sensitive = model.mcpConfigFromEditor({ ...base, url: 'https://user:pass@example.test/mcp?token=canary#frag' })
  expect(sensitive.url).toBeUndefined()
  expect(sensitive.secretValues.url.action).toBe('replace')
  expect(sensitive.secretValues.url.value).toContain('token=canary')
  expect(model.mcpSensitiveUrl('https://example.test/mcp')).toBe(false)
  expect(model.mcpConfigFromEditor({ ...base, url: 'https://example.test/mcp' }).url).toBe('https://example.test/mcp')
  expect(model.mcpConfigFromEditor({ ...base, urlMode: 'ref', urlRef: 'PRIVATE_URL' }).secretRefs.url).toEqual({ ref: 'PRIVATE_URL' })
})

test('raw JSON byte guards and retry extraction stay bounded and independent of portable presets', () => {
  expect(model.mcpUtf8Bytes('a中🙂')).toBe(8)
  expect(model.mcpJsonGuard(`"${'x'.repeat(1024 * 1024 + 1)}"`).code).toBe('document-too-large')
  expect(model.mcpJsonGuard('[]').code).toBe('invalid-document')
  expect(model.mcpJsonGuard('{').code).toBe('invalid-json')
  const text = JSON.stringify({ mcpServers: { docs: { command: 'node', env: { TOKEN: 'raw-in-memory' } }, other: { command: 'node' } } })
  const retry = model.mcpDocumentEntryOf(text, 'docs')
  expect(retry.identity).toBe('docs')
  expect(retry.command).toBe('node')
  expect(retry.env.TOKEN).toBe('raw-in-memory')
  expect(model.mcpDocumentEntryOf(text, 'missing')).toBeNull()
})

test('batch results count only mounted as success and preserve saved/not-attempted facts', () => {
  const items = model.mcpBatchItemsOf({ items: [
    { identity: 'ok', status: 'mounted', saved: true },
    { identity: 'degraded', status: 'saved-degraded', saved: true },
    { identity: 'later', status: 'not-attempted', saved: false },
  ] })
  expect(items.map(item => item.succeeded)).toEqual([true, false, false])
  expect(items[1].failed).toBe(true)
  expect(items[1].saved).toBe(true)
  expect(items[2].notAttempted).toBe(true)
})

test('an unchanged edit omits args so the Host keeps the stored argv; a changed edit sends them', () => {
  const server = managedServer()
  server.config.client.args = ['--port=8080', 'FOO=bar', '[redacted]']
  server.config.secretRefs.args = { 2: { ref: 'CLI_TOKEN' } }
  const editor = model.mcpEditorFromServer(server, 1)
  expect(editor.argsText).toBe('["--port=8080","FOO=bar",""]')
  expect(Object.hasOwn(model.mcpConfigFromEditor({ ...editor, label: 'Renamed' }), 'args')).toBe(false)
  const changed = model.mcpConfigFromEditor({ ...editor, argsText: '["--port=9090","FOO=bar",""]' })
  expect(changed.args).toEqual(['--port=9090', 'FOO=bar', ''])
  const added = model.mcpConfigFromEditor({ ...model.mcpEditorFromServer(null, 0), identity: 'x', command: 'node', argsText: '["a"]' })
  expect(added.args).toEqual(['a'])
})
