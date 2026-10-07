import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createOfficeAdapter, officeDenials } from '../src/capabilities/skill-office-adapter.js'
import { createSkillSelectionProvider } from '../src/capabilities/skill-selection-provider.js'

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'weir-office-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'office-docx'))
  const locator = join(root, 'office-docx/SKILL.md')
  await writeFile(locator, 'raw body')
  const raw = { name: 'office-docx', description: 'Office', provider: 'dsh-office', source: 'bundled', rank: 600,
    invocation: { modelInvocable: true, userInvocable: true }, locator }
  const upstream = { list: async () => [raw], get: async () => ({ ...raw, content: 'body + validated runtime' }) }
  const providers = new Map([['dsh-office', { provider: upstream }]])
  const adapter = createOfficeAdapter({ layers: { global: { providers } }, list() { throw new Error('merged catalog forbidden') } }, 'machine')
  return { adapter, providers, upstream }
}

test('raw Office identity preserves the actual provider loader and runtime', async t => {
  const { adapter, providers } = await fixture(t)
  const inventory = await adapter({})
  const identity = inventory.candidates[0].identity
  assert.equal(identity.name, 'office-docx')
  assert.equal(identity.portable, false)
  assert.deepEqual((await adapter({})).candidates[0].identity, identity)
  const provider = createSkillSelectionProvider({ control: { invalidate() {} }, readSelection: async () => [identity], inventory: adapter, denials: officeDenials })
  const selected = (await provider.list()).candidates.find(c => c.identity)
  assert.equal((await provider.get(selected)).content, 'body + validated runtime')
  providers.clear()
  assert.equal(await provider.get(selected), undefined)
})

test('unselected, failed policy and failed discovery all retain three non-invocable shadows', async t => {
  const { adapter } = await fixture(t)
  const identity = (await adapter({})).candidates[0].identity
  for (const readSelection of [async () => [], async () => { throw new Error('policy unreadable') }, async () => [identity]]) {
    const provider = createSkillSelectionProvider({ control: { invalidate() {} }, readSelection,
      inventory: async () => { throw new Error('discovery unavailable') }, denials: officeDenials })
    const result = await provider.list()
    assert.equal(result.candidates.length, 3)
    for (const candidate of result.candidates) {
      assert.deepEqual(candidate.invocation, { modelInvocable: false, userInvocable: false })
      assert.equal(await provider.get(candidate), undefined)
    }
  }
})

test('unsupported registry and malformed raw candidates fail explicitly', async t => {
  await assert.rejects(createOfficeAdapter({}, 'machine')({}), /registry is unavailable/)
  const { adapter, upstream } = await fixture(t)
  upstream.list = async () => [{ name: 'other' }]
  await assert.rejects(adapter({}), /Unsupported Office provider candidate/)
})

test('revocation during upstream load cannot publish a stale Office definition', async t => {
  const { adapter, upstream } = await fixture(t)
  const identity = (await adapter({})).candidates[0].identity
  let release
  const gate = new Promise(resolve => { release = resolve })
  upstream.get = async () => { await gate; return { name: 'office-docx', content: 'stale' } }
  const provider = createSkillSelectionProvider({ control: { invalidate() {} }, readSelection: async () => [identity], inventory: adapter, denials: officeDenials })
  const selected = (await provider.list()).candidates.find(c => c.identity)
  const pending = provider.get(selected)
  provider.acceptSelection([])
  release()
  assert.equal(await pending, undefined)
  assert.equal((await provider.list()).candidates.every(c => !c.invocation.modelInvocable), true)
})
