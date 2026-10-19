import test from 'node:test'
import assert from 'node:assert/strict'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { createHash } from 'node:crypto'
import { mkdtemp, mkdir, readFile, writeFile, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, relative, isAbsolute } from 'node:path'
import { createEditLockPlugin, storeMode } from '../src/edit-lock/index.js'
import { openReservedEditLockRuntime } from '../src/edit-lock/reserved-runtime.js'
import { reservationPathFor } from '../src/edit-lock/reservation.js'
import { createEditLockEvidence, maintenanceStatus, inspectAuthority } from '../src/edit-lock/maintenance.js'
import { apply as applyHashEdit } from '../src/hashline-edit/index.js'
import { anchorFor } from '../src/hashline-edit/anchors.js'

const digest = text => createHash('sha256').update(text).digest('hex')

// Component composition, NOT a Loader/GUI test. Only the host registry, policy,
// observation and stock-write adapter are doubles. Manager, reservation, store,
// resource identity, managed write and hash_edit are production implementations.
function diskFs() {
  return {
    failAfterWrite: false,
    async resolve(path, { cwd } = {}) { return { displayPath: resolve(cwd ?? '', path) } },
    async readText(target) { return readFile(target.displayPath, 'utf8') },
    async stat(target) { return { type: 'file', version: digest(await this.readText(target)) } },
    async writeText(target, content, expected) {
      if (expected.kind === 'replaceIfVersion') {
        assert.equal(digest(await this.readText(target)), expected.version, 'CAS version must match')
      }
      await writeFile(target.displayPath, content)
      if (this.failAfterWrite) throw new Error('publisher acknowledgement lost after disk write')
      return { version: digest(content) }
    },
  }
}

async function fixture(t) {
  const ceiling = await realpath(tmpdir())
  const root = await realpath(await mkdtemp(join(ceiling, 'weir-off-')))
  const directory = join(root, '.weir', 'edit-lock')
  await mkdir(directory, { recursive: true })
  const file = join(root, 'owned.txt')
  await writeFile(file, 'original')
  const cleanup = []
  t.after(async () => {
    // Drain/dispose owners first; never remove a still-owned store or reservation.
    for (const close of cleanup.reverse()) await close()
    assert.equal(await realpath(root), root)
    assert.ok(relative(ceiling, root).startsWith('weir-off-'))
    assert.equal(isAbsolute(relative(ceiling, root)), false)
    await rm(root, { recursive: true, force: true })
  })
  return { root, directory, file, cleanup, fs: diskFs() }
}

function mount(f, saved, evidence = createEditLockEvidence()) {
  const provided = new Map(), tools = new Map(), listeners = new Map()
  const settings = { get: section => section === 'editLock' ? { enabled: saved.enabled } : undefined, editLockEvidence: evidence }
  const policy = { resolve: () => ({ mode: 'workspace-write', workspaceRoot: f.root }) }
  const stockWrite = { name: 'write', async execute(args) {
    const target = await f.fs.resolve(args.file_path, { cwd: f.root })
    return f.fs.writeText(target, args.content, { kind: 'replaceIfVersion', version: (await f.fs.stat(target)).version })
  } }
  tools.set('write', stockWrite)
  tools.set('edit', { name: 'edit' })
  const ctx = {
    fs: f.fs, logger: { warn() {} }, emit() {},
    get: name => name === 'weirSettings' ? settings : provided.get(name),
    reflect: { provide: (name, value) => provided.set(name, value) },
    on(name, fn) { listeners.set(name, [...(listeners.get(name) ?? []), fn]) },
    inject(names, callback) {
      if (names[0] === 'sandboxPolicy') return callback({ sandboxPolicy: policy })
      if (names[0] === 'weirEditLock' && provided.has('weirEditLock')) return callback({ weirEditLock: provided.get('weirEditLock') })
    },
    async waterfall(name, target) {
      assert.equal(name, 'fs/write-intent')
      return { kind: 'replaceIfVersion', version: (await f.fs.stat(target)).version }
    },
    tools: {
      get: (name, agent) => agent ? agent.visible.get(name) : tools.get(name),
      register(definition) { tools.set(definition.name, definition); return () => tools.delete(definition.name) },
    },
  }
  // All domain discovery and sockets stay in the disposable external workspace.
  const endpoint = process.platform === 'win32'
    ? `\\\\.\\pipe\\weir-off-${digest(f.root).slice(0, 16)}`
    : join(f.root, 'publisher.sock')
  const apply = createEditLockPlugin({ resolveRoot: () => f.root, endpoint: () => endpoint, exclude() {} })
  const dispose = apply(ctx, { root: f.root, authorityDirectory: f.directory })
  // hash_edit's commit is the file lease now (design D11), not this service: the
  // subject of this composition test is the Edit Lock guard, so the lease is a
  // pass-through stub — the broker has no part in these assertions and a real
  // client would open a socket from a unit test.
  applyHashEdit(ctx, { leaseClient: { withLeases: async (_owner, _paths, _scope, fn) => await fn() } })
  f.cleanup.push(async () => { await dispose?.() })
  async function agent(id) {
    const visible = new Map(tools)
    const agent = { id, visible, inject() {}, session: { header: { cwd: f.root } }, ctx: { tools: {
      restrict({ deny }) { for (const name of deny) visible.delete(name) },
      register(definition) { visible.set(definition.name, definition); return () => visible.delete(definition.name) },
    } } }
    for (const handler of listeners.get('agent/created') ?? []) await handler({ agent })
    return agent
  }
  async function call(agent, name, args) {
    const exec = { agent, name, signal: new AbortController().signal }
    for (const guard of listeners.get('tools/pre-execute') ?? []) {
      const decision = await guard(exec, async () => ({ kind: 'allow' }))
      if (decision.kind !== 'allow') throw new Error(decision.reason)
    }
    return agent.visible.get(name).execute(args, exec)
  }
  return { agent, call, provided, tools, listeners, evidence, dispose, stockWrite,
    status: () => maintenanceStatus({ savedEnabled: () => saved.enabled, evidence, candidateRoots: () => [f.root] }) }
}

// The recorded publisher PID remains alive across composition changes, so
// legitimate proven-dead automatic recovery must NOT settle this unknown.
// This deliberately covers the conservative re-enable branch, not dead-PID recovery.
async function seed(f, unknown) {
  const runtime = await openReservedEditLockRuntime({ root: f.root, directory: f.directory, domainId: f.root, mode: 'create', fs: f.fs })
  try {
    const owner = await runtime.control.openSession('old-owner')
    await runtime.requests.acquireBatch(owner, [f.file], f.root)
    if (unknown) {
      const ready = await runtime.requests.prepare(owner, {
        operationId: 'lost-ack', tool: 'write', filePath: f.file, cwd: f.root,
        args: { file_path: f.file, content: 'dispatched' }, content: 'dispatched',
        effectivePolicy: { mode: 'workspace-write', workspaceRoot: f.root },
        expected: { kind: 'replaceIfVersion', version: digest('original') },
      }, new AbortController().signal)
      f.fs.failAfterWrite = true
      await assert.rejects(runtime.requests.commit(ready.submission), /acknowledgement lost/)
      f.fs.failAfterWrite = false
      assert.equal(runtime.control.history('old-owner', 'lost-ack').phase, 'unknown')
      assert.equal(await readFile(f.file, 'utf8'), 'dispatched')
    }
    await runtime.control.cancel(owner) // retained interrupted lock, not a fabricated snapshot
  } finally { f.fs.failAfterWrite = false; await runtime.close() }
}

async function foreignReservation(f) {
  // A separate live process owns the real reservation. The off mount must not
  // delete it. Only that process releases its own reservation after assertions.
  const moduleUrl = new URL('../src/edit-lock/reservation.js', import.meta.url).href
  const child = fork('--eval', [`import { reservePublisher } from ${JSON.stringify(moduleUrl)};
    const reservation = await reservePublisher(${JSON.stringify(f.directory)});
    process.send({ ready: true, pid: process.pid });
    process.on('message', () => { reservation.releaseAfterQuiescence(); process.disconnect(); });`],
  { execArgv: ['--input-type=module'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
  const ready = await Promise.race([
    once(child, 'message').then(([message]) => message),
    once(child, 'exit').then(([code]) => { throw new Error(`reservation owner exited before ready: ${code}`) }),
  ])
  assert.equal(ready.ready, true)
  assert.notEqual(ready.pid, process.pid)
  let closed = false
  const close = async () => {
    if (closed) return
    const exit = once(child, 'exit')
    child.send('release-own-reservation')
    const [code] = await exit
    closed = true
    assert.equal(code, 0)
  }
  f.cleanup.push(close)
  return { child, close }
}

test('saved-off intent keeps the enabled generation and both managed editors guarded until restart', async t => {
  const f = await fixture(t), saved = { enabled: true }
  const on = mount(f, saved)
  const holder = await on.agent('holder'), other = await on.agent('other')
  const service = on.provided.get('weirEditLock')
  await service.acquire({ agent: holder }, { filePath: f.file, cwd: f.root })
  saved.enabled = false
  assert.equal(on.status().state, 'disable-requested')
  assert.equal(on.status().restartRequired, true)
  assert.equal(on.provided.get('weirEditLock'), service)
  assert.ok(on.tools.has('edit_lock_acquire'))
  assert.notEqual(other.visible.get('write'), on.stockWrite)
  await assert.rejects(on.call(other, 'write', { file_path: f.file, content: 'bypass' }), /owned/)
  // hash_edit left the Edit Lock surface in step 3C.1: it commits through the
  // file lease and claims nothing here, so the pre-execute guard refuses it as
  // unmanaged. Still zero bytes written — only the reason changed (task 3.8
  // deletes that guard together with the service).
  await assert.rejects(on.call(other, 'hash_edit', { file_path: f.file, edits: [{ op: 'replace', pos: anchorFor(1, 'original'), text: 'bypass' }] }), /not routed through Edit Lock/)
  assert.equal(await readFile(f.file, 'utf8'), 'original')
})

for (const unknown of [false, true]) {
  test(`effective off permits ordinary edits with ${unknown ? 'unknown publication and fence' : 'retained old lock'}; re-enable preserves history`, async t => {
    const f = await fixture(t)
    await seed(f, unknown)
    const initial = inspectAuthority(f.root)
    assert.equal(initial.presence, 'valid')
    assert.equal(initial.snapshot.counts.unresolved, unknown ? 1 : 0)
    assert.equal(initial.snapshot.retainedLocks.length, 1)
    const before = await readFile(join(f.directory, 'snapshot.json'))
    const foreign = await foreignReservation(f)
    const ownerPath = join(reservationPathFor(f.directory), 'owner.json')
    const owner = JSON.parse(await readFile(ownerPath, 'utf8'))
    assert.equal(owner.pid, foreign.child.pid)

    // Restart is a fresh host/agent composition, not a hot removal of a captured
    // service (hot removal intentionally remains fail-closed).
    const saved = { enabled: false }, off = mount(f, saved)
    const editor = await off.agent('off-editor')
    assert.equal(off.status().state, 'disabled')
    assert.equal(off.status().restartRequired, false)
    assert.equal(off.provided.has('weirEditLock'), false)
    assert.deepEqual([...editor.visible.keys()].filter(name => name.startsWith('edit_lock_')), [])
    assert.equal(off.listeners.has('tools/pre-execute'), false)
    assert.equal(editor.visible.get('write'), off.stockWrite)
    await off.call(editor, 'write', { file_path: f.file, content: 'off write' })
    await off.call(editor, 'hash_edit', { file_path: f.file, edits: [{ op: 'replace', pos: anchorFor(1, 'off write'), text: 'off hash edit' }] })
    assert.equal(await readFile(f.file, 'utf8'), 'off hash edit')
    assert.deepEqual(await readFile(join(f.directory, 'snapshot.json')), before)
    assert.deepEqual(inspectAuthority(f.root).snapshot, initial.snapshot)
    assert.equal(JSON.parse(await readFile(ownerPath, 'utf8')).ownerToken, owner.ownerToken)
    process.kill(foreign.child.pid, 0) // reservation belongs to a still-live foreign PID

    await foreign.close() // only the reservation owner performs graceful release
    await off.dispose?.()
    saved.enabled = true
    assert.equal(storeMode(f.directory), 'recover')
    const on = mount(f, saved)
    const newcomer = await on.agent('new-owner')
    assert.equal(on.status().state, 'enforced')
    assert.ok(on.provided.get('weirEditLock'))
    const refusal = unknown ? /unresolved publication fence/ : /owned/
    await assert.rejects(on.call(newcomer, 'write', { file_path: f.file, content: 'must refuse' }), refusal)
    // `write` is still routed through the service in this generation; `hash_edit`
    // left it in step 3C.1 (file lease) and is refused as unmanaged until task
    // 3.8 deletes the guard. Both refuse with zero bytes written.
    await assert.rejects(on.call(newcomer, 'hash_edit', { file_path: f.file, edits: [{ op: 'replace', pos: anchorFor(1, 'off hash edit'), text: 'must refuse' }] }), /not routed through Edit Lock/)
    const returning = await on.agent('old-owner')
    assert.equal((await on.provided.get('weirEditLock').describe(returning)).status.interrupted, true)
    await assert.rejects(on.call(returning, 'write', { file_path: f.file, content: 'implicit resume' }), /stopped|interrupted/)
    const recovered = inspectAuthority(f.root).snapshot
    assert.equal(recovered.retainedLocks[0].owner, 'old-owner')
    assert.equal(recovered.counts.unresolved, unknown ? 1 : 0)
    if (unknown) assert.deepEqual(recovered.unresolved, initial.snapshot.unresolved)
    assert.equal(recovered.counts.operations, initial.snapshot.counts.operations)
    assert.equal(await readFile(f.file, 'utf8'), 'off hash edit')
  })
}
