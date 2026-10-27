import { test, expect } from './helpers.js'
import assert from 'node:assert/strict'
import {
  MCP_LIMITS,
  parseMcpDocument,
  normalizeMcpServer,
  redactMcpEntry,
  fingerprintMcpEntry,
  hasMcpSecrets,
} from '../src/capabilities/mcp-config.js'

const secret = 'paste-canary-secret'

test('stdio normalization covers official advanced fields, refs, secret argv and bounded redacted preview', () => {
  const normalized = normalizeMcpServer({
    identity: 'docs', label: 'Documentation', command: 'npx', args: ['-y', 'server', { ref: 'MCP_CLI_TOKEN' }],
    env: { TOKEN: secret, REGION: { ref: 'MCP_REGION' } }, cwd: '/tmp',
    serverName: 'docs', toolCallTimeoutMs: 1000, maxInstructionBytes: 4096,
    reconnect: { enabled: false, initialDelayMs: 10, maxDelayMs: 100, maxAttempts: 2 },
    failOnStartupError: false,
  })
  expect(normalized.entry.transport.kind).toBe('stdio')
  expect(normalized.entry.client.failOnStartupError).toBe(true)
  expect(normalized.entry.client.env).toEqual({})
  expect(normalized.entry.secretRefs.env.REGION).toEqual({ ref: 'MCP_REGION' })
  expect(normalized.entry.secretRefs.args[2]).toEqual({ ref: 'MCP_CLI_TOKEN' })
  expect(normalized.secretValues.env.TOKEN).toEqual({ action: 'replace', value: secret })
  expect(normalized.hasSecrets).toBe(true)
  const plan = parseMcpDocument({ mcpServers: { docs: { command: 'npx', args: ['-y', 'server'], env: { TOKEN: secret } } } })
  expect(plan.entries).toHaveLength(1)
  expect(plan.digest).toMatch(/^[a-f0-9]{64}$/)
  expect(JSON.stringify(plan)).not.toContain(secret)
  expect(plan.plan[0].fingerprint).toMatch(/^[a-f0-9]{64}$/)
})

test('streamable HTTP supports headers, credential URL and advanced fields without stdio leakage', () => {
  const sensitive = `https://user:${secret}@example.test/mcp?token=${secret}#fragment`
  const { entry, secretValues, hasSecrets } = normalizeMcpServer({
    identity: 'web', type: 'http', url: sensitive,
    headers: { Authorization: { ref: 'MCP_TOKEN', prefix: 'Bearer ' }, 'X-Secret': secret },
    toolCallTimeoutMs: 2000, reconnect: { enabled: true, initialDelayMs: 20, maxDelayMs: 200 },
  })
  expect(entry.transport.kind).toBe('streamable-http')
  expect(entry.client.url).toBeUndefined()
  expect(entry.client.env).toBeUndefined()
  expect(entry.client.headers).toEqual({})
  expect(entry.secretRefs.headers.Authorization).toEqual({ ref: 'MCP_TOKEN', prefix: 'Bearer ' })
  expect(secretValues.url.value).toBe(sensitive)
  expect(secretValues.headers['X-Secret'].value).toBe(secret)
  expect(hasSecrets).toBe(true)
  const redacted = redactMcpEntry(entry)
  expect(JSON.stringify(redacted)).not.toContain(secret)
  const refsOnly = normalizeMcpServer({ identity: 'web', transport: 'streamable-http', url: { ref: 'PRIVATE_URL' }, headers: {} }, { surface: 'refs' })
  expect(refsOnly.entry.secretRefs.url).toEqual({ ref: 'PRIVATE_URL' })
  assert.throws(() => normalizeMcpServer({ identity: 'web', url: sensitive }, { surface: 'refs' }), /credential reference/)
})

test('invalid transport, cross-field and reconnect inputs fail before any operation seam is reachable', () => {
  for (const raw of [
    { identity: 'x', transport: 'sse', url: 'https://example.test' },
    { identity: 'x', command: 'node', url: 'https://example.test' },
    { identity: 'x', command: 'node', shell: true },
    { identity: 'x', command: 'node', reconnect: { initialDelayMs: 50, maxDelayMs: 10 } },
    { identity: 'x', command: 'node', args: Array.from({ length: MCP_LIMITS.args + 1 }, () => 'x') },
    { identity: 'x', url: 'https://example.test', command: 'node' },
  ]) assert.throws(() => normalizeMcpServer(raw), /./)
  assert.throws(() => normalizeMcpServer({ identity: 'x', command: 'node', env: Object.fromEntries(Array.from({ length: 65 }, (_, i) => [`K${i}`, 'v'])) }), /64-entry/)
})

test('single and batch JSON enforce byte/count/plan bounds and validate the whole batch', () => {
  assert.throws(() => parseMcpDocument(`"${'x'.repeat(MCP_LIMITS.documentBytes + 1)}"`), /byte limit/)
  const servers = Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`s${i}`, { command: 'node' }]))
  assert.throws(() => parseMcpDocument({ mcpServers: servers }), /between 1 and 32/)
  assert.throws(() => parseMcpDocument({ mcpServers: { good: { command: 'node' }, bad: { command: 'node', unknown: true } } }), /mcpServers.bad.client.unknown|unknown field/)
  const huge = { identity: 'huge', command: 'node', args: ['x'.repeat(MCP_LIMITS.planBytes)] }
  assert.throws(() => parseMcpDocument(huge), /plan.*limit/)
})

test('blank secrets keep, remove differs from replace, and legacy literals remain hidden but fingerprinted', () => {
  const blank = normalizeMcpServer({ identity: 'docs', command: 'node', secretValues: { env: { TOKEN: '' } } })
  expect(blank.secretValues.env.TOKEN).toEqual({ action: 'keep' })
  const removal = normalizeMcpServer({ identity: 'docs', command: 'node', secretValues: { env: { TOKEN: { action: 'remove' } } } })
  expect(removal.secretValues.env.TOKEN).toEqual({ action: 'remove' })
  const legacy = normalizeMcpServer({ identity: 'old', command: 'node', env: { TOKEN: secret } }, { surface: 'legacy' })
  expect(legacy.entry.client.env.TOKEN).toBe(secret)
  expect(legacy.legacyLiteralSecrets).toBe(true)
  expect(hasMcpSecrets(legacy.entry)).toBe(true)
  expect(JSON.stringify(redactMcpEntry(legacy.entry))).not.toContain(secret)
  expect(fingerprintMcpEntry(legacy.entry)).toMatch(/^[a-f0-9]{64}$/)
  expect(hasMcpSecrets(normalizeMcpServer({ identity: 'plain', command: 'node' }).entry)).toBe(false)
})

test('redaction projection keeps plain argv exact and redacts only secret-indexed args and sensitive URLs', () => {
  const { entry } = normalizeMcpServer({
    identity: 'docs', command: 'node',
    args: ['--port=8080', 'FOO=bar', { ref: 'MCP_CLI_TOKEN' }, 'https://user:pw@example.test/x?token=1'],
  }, { surface: 'refs' })
  const projected = redactMcpEntry(entry)
  expect(projected.client.args).toEqual(['--port=8080', 'FOO=bar', '[redacted]', 'https://example.test/x[redacted-url]'])
  expect(projected.secretRefs.args[2].ref).toBe('MCP_CLI_TOKEN')
  // Known secret values are still removed from structured fields.
  expect(redactMcpEntry({ ...entry, label: `label ${secret}` }, [secret]).label).toBe('label [redacted]')
})
