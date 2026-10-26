import { test, expect } from './helpers.js'
import assert from 'node:assert/strict'
import {
  allocateMcpCredentialAttempt,
  stageMcpCredentials,
  compensateMcpCredentialAttempt,
  materializeMcpClientConfig,
  collectMcpCredentialRefs,
} from '../src/capabilities/mcp-credentials.js'

function credentialFixture() {
  const values = new Map()
  const sets = []
  const unsets = []
  return {
    values, sets, unsets,
    credentials: {
      async set(ref, value) { sets.push([ref, value]); values.set(ref, value) },
      async unset(ref) { unsets.push(ref); values.delete(ref) },
      async resolve(ref) { return values.has(ref) ? { value: values.get(ref), source: 'test' } : undefined },
    },
  }
}
const entry = () => ({
  identity: 'docs', label: 'Docs', owner: { kind: 'global', key: 'installation' }, generation: 0, configuredAt: 0,
  transport: { kind: 'stdio', ref: 'cmd:node' },
  client: { transport: 'stdio', serverName: 'docs', command: 'node', args: ['server', ''], env: { LEGACY: 'literal' } },
  secretRefs: { env: { USER: { ref: 'USER_TOKEN' } } },
})
const registryWith = servers => ({ read: async () => ({ kind: 'ok', revision: 1, servers }) })

test('concurrent attempts never share refs; staged env/header/args/url materialize only through credentials', async () => {
  const fixture = credentialFixture()
  const first = allocateMcpCredentialAttempt({ identity: 'docs', generation: 4, attemptId: 'a'.repeat(32) })
  const second = allocateMcpCredentialAttempt({ identity: 'docs', generation: 4, attemptId: 'b'.repeat(32) })
  expect(first.refFor('env.TOKEN')).not.toBe(second.refFor('env.TOKEN'))
  expect(first.refFor('env.TOKEN')).toMatch(/^WEIR_MCP_[a-f0-9]+_G4_a{16}_[a-f0-9]+$/)
  const base = entry()
  base.client.headers = {}
  base.client.args = ['server', '']
  const staged = await stageMcpCredentials({
    entry: base, generation: 4, registry: registryWith({}), credentials: fixture.credentials,
    secretValues: {
      env: { TOKEN: 'environment-secret', USER: { action: 'keep' } },
      headers: { Authorization: 'header-secret' },
      args: { 1: 'argument-secret' },
      url: 'https://user:url-secret@example.test/mcp?token=secret',
    },
  })
  expect(staged.status).toBe('staged')
  expect(staged.entry.secretRefs.env.USER).toEqual({ ref: 'USER_TOKEN' })
  expect(staged.entry.client.env.LEGACY).toBe('literal')
  expect(staged.entry.client.env.TOKEN).toBeUndefined()
  expect(staged.entry.client.args[1]).toBe('')
  expect(staged.entry.client.url).toBeUndefined()
  expect(JSON.stringify(staged.entry)).not.toContain('environment-secret')
  fixture.values.set('USER_TOKEN', 'user-value')
  const materialized = await materializeMcpClientConfig(staged.entry, fixture.credentials)
  expect(materialized.client.env.TOKEN).toBe('environment-secret')
  expect(materialized.client.env.USER).toBe('user-value')
  expect(materialized.client.headers.Authorization).toBe('header-secret')
  expect(materialized.client.args[1]).toBe('argument-secret')
  expect(materialized.client.url).toContain('url-secret')
  expect(materialized.client.failOnStartupError).toBe(true)
  expect(materialized.client.secretRefs).toBeUndefined()
  expect(collectMcpCredentialRefs(staged.entry)).toContain('USER_TOKEN')
})

test('blank keep and remove preserve semantics without writing or deleting user refs', async () => {
  const fixture = credentialFixture()
  const staged = await stageMcpCredentials({
    entry: entry(), generation: 2, registry: registryWith({}), credentials: fixture.credentials,
    secretValues: { env: { USER: '', LEGACY: { action: 'remove' } } },
  })
  expect(fixture.sets).toEqual([])
  expect(fixture.unsets).toEqual([])
  expect(staged.entry.secretRefs.env.USER).toEqual({ ref: 'USER_TOKEN' })
  expect(staged.entry.client.env.LEGACY).toBeUndefined()
})

test('partial set failure compensates only this attempt after an unused registry reread', async () => {
  const fixture = credentialFixture()
  const originalSet = fixture.credentials.set
  let calls = 0
  fixture.credentials.set = async (ref, value) => {
    calls += 1
    await originalSet(ref, value)
    if (calls === 2) throw new Error('injected partial set failure')
  }
  const registry = registryWith({ other: { secretRefs: { env: { KEEP: { ref: 'ORPHAN_BUT_NOT_MINE' } } } } })
  await assert.rejects(stageMcpCredentials({
    entry: entry(), generation: 1, registry, credentials: fixture.credentials,
    secretValues: { env: { A: 'a-secret', B: 'b-secret' } },
  }), error => error.code === 'credential-write-failed')
  expect(fixture.unsets).toHaveLength(2)
  expect(fixture.unsets.every(ref => ref.startsWith('WEIR_MCP_'))).toBe(true)
  expect(fixture.unsets).not.toContain('USER_TOKEN')
  expect(fixture.unsets).not.toContain('ORPHAN_BUT_NOT_MINE')
  expect(fixture.values.has('ORPHAN_BUT_NOT_MINE')).toBe(false) // no write/GC against other records
})

test('probe/CAS proven-uncommitted cleanup differs from lost response indeterminate retention', async () => {
  const fixture = credentialFixture()
  const attempt = allocateMcpCredentialAttempt({ identity: 'docs', generation: 1, attemptId: 'c'.repeat(32) })
  const owned = attempt.refFor('env.TOKEN')
  fixture.values.set(owned, 'secret')
  const registry = registryWith({})
  const cleaned = await compensateMcpCredentialAttempt({ attempt, registry, credentials: fixture.credentials, provenUncommitted: true })
  expect(cleaned.status).toBe('cleaned')
  expect(fixture.unsets).toEqual([owned])

  const uncertainAttempt = allocateMcpCredentialAttempt({ identity: 'docs', generation: 1, attemptId: 'd'.repeat(32) })
  const retained = uncertainAttempt.refFor('env.TOKEN')
  fixture.values.set(retained, 'secret')
  const indeterminate = await compensateMcpCredentialAttempt({ attempt: uncertainAttempt, registry, credentials: fixture.credentials, provenUncommitted: false })
  expect(indeterminate.status).toBe('indeterminate')
  expect(indeterminate.retained).toEqual([retained])
  expect(fixture.unsets).not.toContain(retained)
  expect(fixture.values.get(retained)).toBe('secret')
})

test('a committed ref and cleanup failures are never deleted or misreported; user refs and orphan GC are untouched', async () => {
  const fixture = credentialFixture()
  const attempt = allocateMcpCredentialAttempt({ identity: 'docs', generation: 1, attemptId: 'e'.repeat(32) })
  const owned = attempt.refFor('env.TOKEN')
  fixture.values.set(owned, 'secret')
  const registry = registryWith({ docs: { secretRefs: { env: { TOKEN: { ref: owned } }, headers: { Authorization: { ref: 'USER_TOKEN' } } } } })
  const committed = await compensateMcpCredentialAttempt({ attempt, registry, credentials: fixture.credentials, provenUncommitted: true })
  expect(committed.status).toBe('cleaned')
  expect(committed.retained).toEqual([owned])
  expect(fixture.unsets).toEqual([])

  const failedAttempt = allocateMcpCredentialAttempt({ identity: 'docs', generation: 1, attemptId: 'f'.repeat(32) })
  const failedRef = failedAttempt.refFor('env.TOKEN')
  fixture.credentials.unset = async () => { throw new Error('unset failed') }
  const failed = await compensateMcpCredentialAttempt({ attempt: failedAttempt, registry: registryWith({}), credentials: fixture.credentials, provenUncommitted: true })
  expect(failed.status).toBe('cleanup-failed')
  expect(failed.retained).toEqual([failedRef])
  expect(failed.failures[0].message).toContain('unset failed')
})

test('missing/empty credentials fail closed and secret replacement errors stay sanitized', async () => {
  await assert.rejects(materializeMcpClientConfig(entry(), { resolve: async () => ({ value: '' }) }), error => error.code === 'credential-missing')
  const fixture = credentialFixture()
  fixture.credentials.set = async () => { throw new Error('credential backend rejected value') }
  await assert.rejects(stageMcpCredentials({ entry: entry(), generation: 1, registry: registryWith({}), credentials: fixture.credentials, secretValues: { env: { TOKEN: 'do-not-echo' } } }), error => {
    expect(JSON.stringify(error.diagnostic)).not.toContain('do-not-echo')
    return true
  })
})
