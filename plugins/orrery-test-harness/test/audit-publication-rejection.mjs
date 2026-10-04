// Explicit installed-provider probe; not part of the portable unit-test glob.
// ORRERY_AUDIT_HOST_ROOT points to a DSH checkout containing node_modules.
// ORRERY_AUDIT_ROOT must be an isolated writable directory, never a live domain.
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { join, isAbsolute } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createHash } from 'node:crypto'
import { openEditLockRuntime } from '../../orrery-harness/src/edit-lock/runtime.js'

const host = process.env.ORRERY_AUDIT_HOST_ROOT
const output = process.env.ORRERY_AUDIT_ROOT
assert.ok(host && isAbsolute(host), 'absolute ORRERY_AUDIT_HOST_ROOT required')
assert.ok(output && isAbsolute(output), 'absolute isolated ORRERY_AUDIT_ROOT required')
await mkdir(output, { recursive: true })
const load = name => import(pathToFileURL(join(host, 'node_modules/@deepseek-ai', name, 'lib/index.js')).href)
const { Context } = await load('cordis')
const { LocalFileSystem } = await load('dsh-fs-local')
const { SandboxedFileSystem } = await load('dsh-fs-sandbox')
const { FsError } = await load('dsh-fs')
const sourcePath = join(host, 'node_modules/@deepseek-ai/dsh-fs-local/lib/index.js')
const hash = async () => createHash('sha256').update(await readFile(sourcePath)).digest('hex')
console.log(JSON.stringify({ node: process.version, localDiskSHA256: await hash() }))

async function fixture(Provider) {
  const root = realpathSync(await mkdtemp(join(output, 'publication-')))
  const path = join(root, 'target')
  await writeFile(path, 'before')
  const ctx = new Context()
  ctx.reflect.provide('sandboxPolicy', { defaultMode: 'workspace-write', resolve: () => policy })
  const fiber = ctx.plugin(Provider, { cwd: root, diffBasisMaxBytes: 1024 })
  await fiber.inertia
  const fs = ctx.fs
  const raw = fs[Symbol.for('cordis.original')]
  const policy = { mode: 'workspace-write', workspaceRoot: root }
  const target = await fs.resolve(path, { cwd: root })
  const version = (await fs.stat(target)).version
  const signal = new AbortController().signal
  const args = [target, 'after', { kind: 'replaceIfVersion', version }, signal, policy]
  return { root, path, fs, raw, policy, args, close: () => fiber.dispose() }
}

for (const Provider of [LocalFileSystem, SandboxedFileSystem]) {
  test(`${Provider.name}: genuine stale guard rejects before staging`, async () => {
    const f = await fixture(Provider)
    let staged = 0
    f.raw.internals.inspectTemp = () => { staged++ }
    try {
      const args = [...f.args]
      args[2] = { kind: 'replaceIfVersion', version: 'stale' }
      await assert.rejects(f.fs.writeText(...args), error => error instanceof FsError && error.code === 'FS_STALE_VERSION')
      assert.equal(staged, 0)
      assert.equal(await readFile(f.path, 'utf8'), 'before')
    } finally { await f.close() }
  })

  test(`${Provider.name}: transient postcommit method restores every descriptor yet throws genuine stale`, async () => {
    const f = await fixture(Provider)
    try {
      let stale
      const bad = [...f.args]
      bad[2] = { kind: 'replaceIfVersion', version: 'stale' }
      await assert.rejects(f.fs.writeText(...bad), error => { stale = error; return error instanceof FsError && error.code === 'FS_STALE_VERSION' })
      const before = Object.getOwnPropertyDescriptors(f.raw)
      const protoBefore = Object.getOwnPropertyDescriptors(Object.getPrototypeOf(f.raw))
      const diskBefore = await hash()
      const method = f.raw.versionAfterWrite
      assert.equal(Object.hasOwn(f.raw, 'versionAfterWrite'), false)
      assert.deepEqual(Reflect.ownKeys(f.raw.internals), [])
      const pending = f.fs.writeText(...f.args)
      // The original async write has been dispatched, but has not resumed its
      // awaited probe. No provider method, staging hook, or module is replaced
      // at either boundary snapshot. The postpublication lookup is still live.
      f.raw.versionAfterWrite = function () {
        delete f.raw.versionAfterWrite
        throw stale
      }
      await assert.rejects(pending, error => error === stale)
      assert.equal(await readFile(f.path, 'utf8'), 'after')
      assert.equal(f.raw.versionAfterWrite, method)
      assert.deepEqual(Object.getOwnPropertyDescriptors(f.raw), before)
      assert.deepEqual(Object.getOwnPropertyDescriptors(Object.getPrototypeOf(f.raw)), protoBefore)
      assert.deepEqual(Reflect.ownKeys(f.raw.internals), [])
      assert.equal(await hash(), diskBefore)
    } finally { await f.close() }
  })

  for (const fault of ['stale', 'EIO']) {
    test(`${Provider.name}: publisher retains unknown, ownership and nonreplay after committed ${fault}`, async () => {
      const f = await fixture(Provider)
      let runtime
      try {
        const directory = join(f.root, '.authority')
        await mkdir(directory)
        let failure
        if (fault === 'stale') {
          const bad = [...f.args]
          bad[2] = { kind: 'replaceIfVersion', version: 'stale' }
          await assert.rejects(f.fs.writeText(...bad), error => { failure = error; return error instanceof FsError && error.code === 'FS_STALE_VERSION' })
        } else failure = Object.assign(new Error('postcommit metadata EIO'), { code: 'EIO' })
        const write = f.fs.writeText.bind(f.fs)
        const calls = []
        const backend = {
          resolve: f.fs.resolve.bind(f.fs),
          async writeText(...args) { calls.push(args); await write(...args); throw failure },
        }
        runtime = await openEditLockRuntime({ root: f.root, directory, domainId: 'audit', mode: 'create', fs: backend, assertExclusive() {} })
        const execution = await runtime.control.openSession('alice')
        const request = { operationId: 'one', tool: 'write', filePath: f.path, cwd: f.root,
          args: { content: 'after' }, content: 'after', expected: f.args[2], effectivePolicy: f.policy }
        const controller = new AbortController()
        const ready = await runtime.requests.prepare(execution, request, controller.signal)
        await assert.rejects(runtime.requests.commit(ready.submission), error => error === failure)
        const history = runtime.control.history('alice', 'one')
        assert.equal(history.phase, 'unknown')
        assert.ok(history.fence)
        assert.equal(runtime.control.status().locks[0].owner, 'alice')
        assert.equal(await readFile(f.path, 'utf8'), 'after')
        assert.equal((await runtime.requests.commit(ready.submission)).phase, 'unknown')
        assert.equal((await runtime.requests.prepare(execution, request, controller.signal)).kind, 'history')
        assert.equal(calls.length, 1)
        assert.equal(calls[0].length, 5)
        assert.deepEqual(calls[0][0], f.args[0])
        assert.equal(calls[0][1], 'after')
        assert.deepEqual(calls[0][2], f.args[2])
        assert.notEqual(calls[0][3], controller.signal)
        assert.equal(calls[0][3].aborted, false)
        assert.deepEqual(calls[0][4], f.policy)
      } finally { await runtime?.close(); await f.close() }
    })
  }
}
