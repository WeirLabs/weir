import { describe, expect, it } from './helpers.js'
import { mkdtemp, mkdir, realpath, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openEditLockStore } from '../src/edit-lock/store.js'
import { createEditLockManager } from '../src/edit-lock/manager.js'
import { authorityResidue } from '../src/worktree/authority.js'

async function tempRoot(prefix = 'orrery-wt-auth-') {
  // realpath: the probe passes the root as the snapshot domain id, which the
  // store canonicalizes the same way (macOS /var → /private/var).
  return realpath(await mkdtemp(join(tmpdir(), prefix)))
}

/** Open a real authority at <root>/.orrery/edit-lock and hand out the manager. */
async function openAuthority(t, root) {
  const directory = join(root, '.orrery', 'edit-lock')
  await mkdir(directory, { recursive: true })
  const store = await openEditLockStore({ directory, domainId: root, mode: 'create' })
  t.after(async () => { await rm(root, { recursive: true, force: true }) })
  return { directory, store, manager: createEditLockManager({ store, managerIncarnation: 'm' }) }
}

/** A real authority whose 'child' session owns an UNKNOWN publication and its retained lock. */
async function authorityWithUnknown(t) {
  const root = await tempRoot()
  const { directory, store, manager } = await openAuthority(t, root)
  const child = await manager.openSession('child')
  const token = await manager.acquire(child, '/w/child.txt')
  const input = {
    operationId: 'interrupted', tool: 'write', filePath: '/w/child.txt', cwd: '/w', args: {}, content: 'new',
    effectivePolicy: { mode: 'workspace-write' },
    target: { kind: 'update', resourceId: token.resourceId, generation: token.generation, policy: { kind: 'replaceIfVersion', version: 'old' } },
  }
  const publisher = { validate() {}, publish: async () => { throw new Error('invoked failure') }, identify: () => token.resourceId }
  const ready = await manager.prepare(child, input, publisher)
  await manager.commit(ready.submission).then(() => expect(1).toBe(0), () => {})
  expect(manager.history('child', 'interrupted').phase).toBe('unknown')
  await store.close()
  return { root, directory }
}

/** A real authority whose 'child' session holds an ACTIVE lock and a PREPARED (never committed) operation. */
async function authorityWithPrepared(t) {
  const root = await tempRoot()
  const { directory, store, manager } = await openAuthority(t, root)
  const child = await manager.openSession('child')
  const token = await manager.acquire(child, '/w/child.txt')
  const input = {
    operationId: 'pending', tool: 'write', filePath: '/w/child.txt', cwd: '/w', args: {}, content: 'new',
    effectivePolicy: { mode: 'workspace-write' },
    target: { kind: 'update', resourceId: token.resourceId, generation: token.generation, policy: { kind: 'replaceIfVersion', version: 'old' } },
  }
  const publisher = { validate() {}, publish: async () => {}, identify: () => token.resourceId }
  await manager.prepare(child, input, publisher)
  expect(manager.history('child', 'pending').phase).toBe('prepared')
  await store.close()
  return { root, directory }
}

describe('authorityResidue (read-only probe)', () => {
  it('reports an unknown publication and its lock for the owner session, byte-identical afterwards', async (t) => {
    const { root, directory } = await authorityWithUnknown(t)
    const before = await readFile(join(directory, 'snapshot.json'))
    expect(authorityResidue(root, 'child')).toEqual({ operations: 1, locks: 1 })
    // Another session owns nothing: silent.
    expect(authorityResidue(root, 'someone-else')).toBe(null)
    const after = await readFile(join(directory, 'snapshot.json'))
    expect(after.equals(before)).toBe(true)
  })

  it('reports a prepared operation and an active lock as residue', async (t) => {
    const { root } = await authorityWithPrepared(t)
    expect(authorityResidue(root, 'child')).toEqual({ operations: 1, locks: 1 })
  })

  it('is silent for a clean authority, a missing authority, and bad arguments', async (t) => {
    const root = await tempRoot()
    const { store } = await openAuthority(t, root)
    await store.close()
    expect(authorityResidue(root, 'child')).toBe(null)
    const empty = await tempRoot('orrery-wt-none-')
    t.after(async () => { await rm(empty, { recursive: true, force: true }) })
    expect(authorityResidue(empty, 'child')).toBe(null)
    expect(authorityResidue(root, null)).toBe(null)
    expect(authorityResidue(root, undefined)).toBe(null)
    expect(authorityResidue('', 'child')).toBe(null)
  })

  it('is silent on a corrupt or non-snapshot file and never throws', async (t) => {
    const { root, directory } = await authorityWithUnknown(t)
    const snapshotPath = join(directory, 'snapshot.json')
    const original = (await readFile(snapshotPath)).toString('utf8')
    const corrupted = original.replace(/"checksum":"([a-f0-9])/, (_match, digit) => `"checksum":"${digit === 'a' ? 'b' : 'a'}`)
    await writeFile(snapshotPath, corrupted)
    expect(authorityResidue(root, 'child')).toBe(null)
    await writeFile(snapshotPath, 'not json at all')
    expect(authorityResidue(root, 'child')).toBe(null)
  })
})
