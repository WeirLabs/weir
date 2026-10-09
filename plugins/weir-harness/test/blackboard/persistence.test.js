import { test } from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir, hostname } from 'node:os'
import { createBlackboardStorage, locateSession, decodeRecord } from '../../src/blackboard/storage.js'
import { createDurableBlackboard, resolveDurableRoot } from '../../src/blackboard/durable.js'
import { createBlackboardRemoteService } from '../../src/blackboard/remote.js'

const ID = 'session-root'
const entry = { holderId: ID, key: 'knowledge', entryType: 'contract', summary: 'A nonempty summary.', content: 'durable body', ttlMs: 60000 }
async function fixture(t, options = {}) {
  const home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'weir-bb-')))
  const cwd = join(home, 'workspace')
  const dir = join(home, 'sessions', 'workspace', ID)
  await fs.mkdir(dir, { recursive: true })
  const log = join(dir, 'session.v4.jsonl')
  await fs.writeFile(log, JSON.stringify({ type: 'session', version: 4, id: ID, cwd }) + '\n')
  const storage = createBlackboardStorage({ home, ...options })
  const board = createDurableBlackboard({ storage, ...options.runtime })
  board.bind(ID, cwd)
  t.after(async () => { await board.clearRuntime(ID); assert.equal(await fs.realpath(home), home); await fs.rm(home, { recursive: true, force: true }) })
  return { home, cwd, dir, log, side: log + '_bb', storage, board }
}

test('empty creation; durable entries, counts, promotion; authority never restored', async t => {
  const f = await fixture(t)
  assert.deepEqual(await f.board.list(ID), [])
  assert.deepEqual(JSON.parse(await fs.readFile(f.side, 'utf8')).entries, [])
  await f.board.write(ID, entry)
  await f.board.read(ID, ['knowledge', 'knowledge'])
  await f.board.apply(ID, { holderId: ID, key: entry.key, ttlMs: 60000 })
  await f.board.apply(ID, { holderId: 'child', key: entry.key, ttlMs: 60000 })
  await f.board.markPromoted(ID, { key: entry.key, destination: 'runtime-map' })
  const other = createDurableBlackboard({ storage: createBlackboardStorage({ home: f.home }) })
  const rows = await other.entriesOf(ID)
  assert.equal(rows[0].summary, entry.summary)
  assert.equal(rows[0].content, entry.content)
  assert.equal(rows[0].readCount, 2)
  assert.equal(rows[0].subscribeCount, 1)
  assert.equal(rows[0].promoted.destination, 'runtime-map')
  assert.deepEqual(await other.tokensOf(ID), [])
  assert.deepEqual(await other.subscriptionsOf(ID), [])
  assert.equal((await other.write(ID, entry)).status, 'promoted')
  const record = JSON.parse(await fs.readFile(f.side, 'utf8'))
  assert.deepEqual(Object.keys(record).sort(), ['entries', 'revision', 'rootSessionId', 'schemaVersion'])
})

test('restarted non-promoted board rejects unconsumed old authority', async t => {
  const f = await fixture(t)
  await f.board.write(ID, entry)
  await f.board.apply(ID, { holderId: ID, key: entry.key, ttlMs: 60000 })
  const cold = createDurableBlackboard({ storage: createBlackboardStorage({ home: f.home }) })
  assert.equal((await cold.write(ID, entry)).status, 'no-authority')
})

for (const op of ['create', 'file-fsync', 'rename']) test(`${op} failure preserves bytes, token and notices`, async t => {
  let failing = false
  const f = await fixture(t, { hook: async stage => { if (failing && stage === op) throw new Error('disk fault') } })
  await f.board.write(ID, entry)
  await f.board.apply(ID, { holderId: ID, key: entry.key, ttlMs: 60000 })
  await f.board.apply(ID, { holderId: 'child', key: entry.key, ttlMs: 60000 })
  const before = await fs.readFile(f.side, 'utf8')
  const notices = []
  f.board.onRelease(e => notices.push(e))
  failing = true
  await assert.rejects(f.board.write(ID, { ...entry, content: 'new' }), /disk fault/)
  assert.equal(await fs.readFile(f.side, 'utf8'), before)
  assert.equal((await f.board.tokensOf(ID))[0].holder, ID)
  assert.equal(notices.length, 0)
  failing = false
  await f.board.write(ID, { ...entry, content: 'new' })
  assert.equal(notices.length, 1)
})

test('uncertain directory fsync confirms authoritative bytes before publishing', async t => {
  let fail = false
  const f = await fixture(t, { hook: async op => { if (fail && op === 'dir-fsync') throw new Error('sync failed') } })
  await f.board.ensure(ID)
  fail = true
  assert.equal((await f.board.write(ID, entry)).status, 'created')
  assert.equal(decodeRecord(await fs.readFile(f.side, 'utf8'), ID).entries[0].content, entry.content)
})

test('paused fsync serializes expiry, successor acquisition and holder disposal', async t => {
  let clock = 1000
  let armed = false, unblock, reached
  const paused = new Promise(resolve => { reached = resolve })
  const gate = new Promise(resolve => { unblock = resolve })
  const f = await fixture(t, { runtime: { now: () => clock }, hook: async op => { if (armed && op === 'file-fsync') { armed = false; reached(); await gate } } })
  await f.board.write(ID, entry)
  await f.board.apply(ID, { holderId: ID, key: entry.key, ttlMs: 5 })
  armed = true
  const writing = f.board.write(ID, { ...entry, content: 'committed' })
  await paused
  clock = 1015
  const disposed = f.board.releaseHolder(ID)
  const successor = f.board.apply(ID, { holderId: 'child', key: entry.key, ttlMs: 60000 })
  await new Promise(resolve => setTimeout(resolve, 15))
  unblock()
  await writing
  await disposed
  assert.equal((await successor).status, 'granted')
  assert.equal((await f.board.tokensOf(ID))[0].holder, 'child')
})

test('concurrent reads are serialized and no successful counter update is lost', async t => {
  const f = await fixture(t)
  await f.board.write(ID, entry)
  await Promise.all(Array.from({ length: 12 }, () => f.board.read(ID, [entry.key])))
  assert.equal((await f.board.entriesOf(ID))[0].readCount, 12)
})

test('v4 to v5/compression migration preserves content and does not touch host files', async t => {
  const f = await fixture(t)
  await f.board.write(ID, entry)
  await fs.writeFile(join(f.dir, 'session.lock'), 'host-owned')
  await fs.writeFile(join(f.dir, 'session.v5.jsonl'), JSON.stringify({ type: 'session', version: 5, id: ID, cwd: f.cwd }) + '\n')
  assert.equal((await f.board.entriesOf(ID))[0].summary, entry.summary)
  await assert.rejects(fs.stat(f.side), { code: 'ENOENT' })
  assert.ok(await fs.stat(join(f.dir, 'session.v5.jsonl_bb')))
  assert.equal(await fs.readFile(join(f.dir, 'session.lock'), 'utf8'), 'host-owned')
  assert.ok(await fs.stat(f.log))
})

for (const kind of ['corrupt', 'schema', 'identity', 'conflict']) test(`${kind} records fail closed and preserve original bytes`, async t => {
  const f = await fixture(t)
  await f.board.write(ID, entry)
  let text = await fs.readFile(f.side, 'utf8')
  if (kind === 'corrupt') text = '{'
  if (kind === 'schema') text = text.replace('"schemaVersion":1', '"schemaVersion":99')
  if (kind === 'identity') text = text.replace(ID, 'wrong-root')
  await fs.writeFile(f.side, text)
  if (kind === 'conflict') await fs.writeFile(join(f.dir, 'session.v3.jsonl_bb'), text.replace('durable body', 'other body'))
  await assert.rejects(f.board.list(ID))
  assert.equal(await fs.readFile(f.side, 'utf8'), text)
})

test('log-only deletion preserves bytes; full directory deletion is never recreated', async t => {
  const f = await fixture(t)
  await f.board.write(ID, entry)
  const bytes = await fs.readFile(f.side, 'utf8')
  assert.equal(await fs.realpath(f.log), f.log); await fs.unlink(f.log)
  await assert.rejects(f.board.write(ID, entry), /log unavailable/)
  assert.equal(await fs.readFile(f.side, 'utf8'), bytes)
  assert.equal(await fs.realpath(f.dir), f.dir); await fs.rm(f.dir, { recursive: true })
  await assert.rejects(f.board.list(ID), /log unavailable/)
  await assert.rejects(fs.stat(f.dir), { code: 'ENOENT' })
})

test('locator refuses traversal, wrong cwd/id, ambiguous directories and symlinks', async t => {
  const f = await fixture(t)
  await assert.rejects(locateSession(f.home, '../root'))
  await assert.rejects(locateSession(f.home, ID, '/wrong'))
  const second = join(f.home, 'sessions', 'other', ID)
  await fs.mkdir(second, { recursive: true }); await fs.copyFile(f.log, join(second, 'session.v4.jsonl'))
  await assert.rejects(locateSession(f.home, ID), /ambiguous/)
  assert.equal(await fs.realpath(second), second); await fs.rm(second, { recursive: true })
  await fs.writeFile(f.log, JSON.stringify({ type: 'session', version: 4, id: 'foreign', cwd: f.cwd }))
  await assert.rejects(locateSession(f.home, ID), /mismatch/)
  assert.equal(await fs.realpath(f.log), f.log); await fs.unlink(f.log)
  await fs.symlink(join(f.home, 'missing'), f.log)
  await assert.rejects(locateSession(f.home, ID), /untrusted/)
})

test('a same-PID different nonce is never proof a writer or lock died', async t => {
  const f = await fixture(t, { timeoutMs: 10 })
  await fs.writeFile(join(f.dir, 'weir-blackboard.lock'), JSON.stringify({ schemaVersion: 1, host: hostname(), pid: process.pid, token: 'old-module' }))
  await assert.rejects(f.board.list(ID), /live\/unknown/)
  assert.equal(await fs.realpath(join(f.dir, 'weir-blackboard.lock')), join(f.dir, 'weir-blackboard.lock')); await fs.unlink(join(f.dir, 'weir-blackboard.lock'))
  await fs.writeFile(join(f.dir, 'weir-blackboard.writer'), JSON.stringify({ schemaVersion: 1, host: hostname(), pid: process.pid, token: 'old-module' }))
  await assert.rejects(f.board.list(ID), /another live/)
})

test('remote audit does not count and delayed rejection cannot report success', async t => {
  const f = await fixture(t)
  const agent = { id: ID }
  const remote = createBlackboardRemoteService({ bridge: () => ({ kernel: f.board, boardOf: async () => ID, ttlMs: () => 60000 }) })
  assert.deepEqual(await remote.write(agent, entry), { ok: true, revision: 1 })
  assert.equal((await remote.read(agent, { keys: [entry.key] })).entries[0].readCount, 0)
  const bad = createBlackboardRemoteService({ bridge: () => ({ kernel: { write: async () => { await Promise.resolve(); throw new Error('late fault') } }, boardOf: async () => ID, ttlMs: () => 60000 }) })
  assert.deepEqual(await bad.write(agent, entry), { ok: false, error: 'blackboard write failed: late fault' })
})

test('nested cold ancestry resolves root and never creates child sidecars', async t => {
  const f = await fixture(t)
  const childDir = join(f.home, 'sessions', 'workspace', 'child-parent')
  await fs.mkdir(childDir)
  await fs.writeFile(join(childDir, 'session.v4.jsonl'), JSON.stringify({ type: 'session', version: 4, id: 'child-parent', cwd: f.cwd, delegationDepth: 1, parentSession: ID }))
  const runtime = { storage: f.storage, kernel: f.board, flushed: new WeakSet() }
  const ctx = { get: () => undefined }
  const root = await resolveDurableRoot(ctx, { id: 'grandchild', session: { header: { id: 'grandchild', cwd: f.cwd, delegationDepth: 2, parentSession: 'child-parent' } } }, runtime)
  assert.equal(root, ID)
  assert.deepEqual(await fs.readdir(childDir), ['session.v4.jsonl'])
})


test('two processes preserve every successful commit and reject competing authority', async t => {
  const { execFile } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const worker = fileURLToPath(new URL('./worker.js', import.meta.url))
  const f = await fixture(t)
  const run = key => new Promise((resolve, reject) => execFile(process.execPath, [worker, f.home, key], (error, out) => error ? reject(error) : resolve(JSON.parse(out.trim()))))
  const outcomes = await Promise.all(['alpha', 'beta'].map(run))
  const successful = outcomes.flatMap((out, i) => out.ok ? [['alpha', 'beta'][i]] : [])
  assert.ok(successful.length >= 1)
  const rows = await f.board.list(ID)
  for (const key of successful) assert.ok(rows.some(row => row.key === key))
  await f.board.write(ID, { ...entry, key: 'successor' })
  assert.equal((await f.board.list(ID)).length, successful.length + 1)
})

test('SIGKILLed lock owner is reclaimed; a live paused holder is never stolen', async t => {
  const { spawn } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const f = await fixture(t, { timeoutMs: 30 })
  const child = spawn(process.execPath, [fileURLToPath(new URL('./worker.js', import.meta.url)), f.home, 'crashed', 'lock'], { stdio: ['ignore', 'pipe', 'pipe'] })
  await new Promise((resolve, reject) => { child.stdout.once('data', resolve); child.once('error', reject); child.once('exit', () => reject(new Error('worker exited before lock'))) })
  await assert.rejects(f.board.list(ID), /live\/unknown/)
  const exited = new Promise(resolve => child.once('exit', resolve))
  child.kill('SIGKILL'); await exited
  await f.board.write(ID, entry)
  assert.equal((await f.board.entriesOf(ID))[0].content, entry.content)
})


test('compression basename migration keeps one sidecar and identical entries', async t => {
  const { zstdCompressSync } = await import('node:zlib')
  const f = await fixture(t)
  await f.board.write(ID, entry)
  const before = await f.board.entriesOf(ID)
  const bytes = await fs.readFile(f.log)
  await fs.writeFile(f.log + '.zstd', zstdCompressSync(bytes))
  await assert.rejects(f.board.list(ID), /ambiguous canonical/)
  assert.equal(await fs.realpath(f.log), f.log); await fs.unlink(f.log)
  assert.deepEqual(await f.board.entriesOf(ID), before)
  await assert.rejects(fs.stat(f.side), { code: 'ENOENT' })
  assert.ok(await fs.stat(f.log + '.zstd_bb'))
})

test('failed initial creation cannot claim an empty durable sidecar exists', async t => {
  const f = await fixture(t, { hook: async op => { if (op === 'create') throw new Error('no permission') } })
  await assert.rejects(f.board.ensure(ID), /no permission/)
  await assert.rejects(fs.stat(f.side), { code: 'ENOENT' })
})

test('sidecar symlinks are rejected without modifying their referent', async t => {
  const f = await fixture(t)
  const target = join(f.home, 'foreign')
  await fs.writeFile(target, 'keep me')
  await fs.symlink(target, f.side)
  await assert.rejects(f.board.ensure(ID), /untrusted/)
  assert.equal(await fs.readFile(target, 'utf8'), 'keep me')
})


test('late mount catches up existing root; disposal and remount keep durable entries', async t => {
  const { createBlackboardPlugin } = await import('../../src/blackboard/index.js')
  const f = await fixture(t)
  const session = { id: ID, header: { id: ID, cwd: f.cwd, version: 4, delegationDepth: 0 } }
  let agent = { id: ID, session }
  const handlers = new Map(), provided = new Map()
  let flushes = 0
  const ctx = {
    get(name) {
      if (name === 'profileContext') return { home: f.home }
      if (name === 'sessions') return { get: id => id === ID ? session : undefined, flush: async () => { flushes++; return true } }
      if (name === 'sessionPersistence') return { stat: async () => ({ header: session.header }) }
      if (name === 'agents') return { list: () => [agent], get: id => id === ID ? agent : undefined }
    },
    tools: { register() {}, view: () => ({ visible: new Set() }) },
    systemPrompt: { section: () => () => {}, variable: () => () => {} },
    reflect: { provide: (name, service) => provided.set(name, service) },
    on: (name, handler) => { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn() {} }, emit() {}, effect() {},
  }
  const mount = createBlackboardPlugin()
  const dispose = mount(ctx)
  const deadline = Date.now() + 3000
  while (true) {
    try { await fs.stat(f.side); break } catch (error) { if (Date.now() >= deadline) throw error; await new Promise(resolve => setTimeout(resolve, 5)) }
  }
  assert.equal(flushes, 1)
  assert.deepEqual(JSON.parse(await fs.readFile(f.side, 'utf8')).entries, [])
  const service = provided.get('weirBlackboard')
  await service.write({ agent }, entry)
  await service.apply({ agent }, entry.key)
  await handlers.get('agent/disposed')({ agent })
  await service.releaseHolder(ID)
  assert.deepEqual(await service.tokensOf(ID), [])
  // The host process remains alive, but its final board participant is gone:
  // a second process can now adopt the board rather than being falsely locked.
  const { execFile } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  const outcome = await new Promise((resolve, reject) => execFile(process.execPath, [fileURLToPath(new URL('./worker.js', import.meta.url)), f.home, 'handoff'], (error, out) => error ? reject(error) : resolve(JSON.parse(out.trim()))))
  assert.equal(outcome.ok, true, JSON.stringify(outcome))
  assert.equal((await service.entriesOf(ID)).find(row => row.key === entry.key).content, entry.content)
  await dispose()
  agent = { id: ID, session } // a disposed incarnation cannot be re-admitted
  const disposeAgain = mount(ctx)
  assert.equal((await provided.get('weirBlackboard').read({ agent }, [entry.key])).found[0].content, entry.content)
  await disposeAgain()
})


test('disposal queued during first admission revokes the unpublished token', async t => {
  let unblock, reached, once = true
  const paused = new Promise(resolve => { reached = resolve })
  const gate = new Promise(resolve => { unblock = resolve })
  const f = await fixture(t, { hook: async op => { if (once && op === 'create') { once = false; reached(); await gate } } })
  const applying = f.board.apply(ID, { holderId: ID, key: entry.key, ttlMs: 60000 })
  await paused
  const disposed = f.board.releaseHolder(ID)
  unblock()
  await applying; await disposed
  assert.deepEqual(await f.board.tokensOf(ID), [])
})

test('volatile revocation still works when the durable log has disappeared', async t => {
  const f = await fixture(t)
  await f.board.apply(ID, { holderId: ID, key: entry.key, ttlMs: 60000 })
  const before = await fs.readFile(f.side)
  assert.equal(await fs.realpath(f.log), f.log); await fs.unlink(f.log)
  await f.board.releaseHolder(ID)
  assert.deepEqual(await f.board.tokensOf(ID), [])
  assert.deepEqual(await fs.readFile(f.side), before)
})


test('depth-zero fork remains an isolated root despite parentSession metadata', async t => {
  const f = await fixture(t)
  await f.board.write(ID, entry)
  const id = 'session-fork'
  const dir = join(f.home, 'sessions', 'workspace', id)
  await fs.mkdir(dir)
  await fs.writeFile(join(dir, 'session.v4.jsonl'), JSON.stringify({ type: 'session', version: 4, id, cwd: f.cwd, delegationDepth: 0, parentSession: ID }))
  const root = await resolveDurableRoot({ get: () => undefined }, { id }, { storage: f.storage, kernel: f.board, flushed: new WeakSet() })
  assert.equal(root, id)
  assert.deepEqual(await f.board.list(id), [])
})

test('unsafe generation numbers and relative header cwd cannot select a write target', async t => {
  const f = await fixture(t)
  await fs.writeFile(f.log, JSON.stringify({ type: 'session', version: 4, id: ID, cwd: '../relative' }))
  await assert.rejects(f.board.list(ID), /cwd mismatch/)
  await fs.writeFile(join(f.dir, 'session.v9007199254740993.jsonl'), '{}')
  await assert.rejects(f.board.list(ID), /generation number/)
  await assert.rejects(fs.stat(f.side), { code: 'ENOENT' })
})

async function mountedFixture(t) {
  const { createBlackboardPlugin } = await import('../../src/blackboard/index.js')
  const { runtimeBlackboard } = await import('../../src/blackboard/durable.js')
  const f = await fixture(t)
  const agents = new Map()
  const agent = { id: ID, session: { header: { id: ID, cwd: f.cwd, delegationDepth: 0 } } }
  agents.set(ID, agent)
  function mount() {
    const handlers = new Map(), provided = new Map()
    const ctx = {
      get(name) {
        if (name === 'profileContext') return { home: f.home }
        if (name === 'agents') return { get: id => agents.get(id), list: () => [] }
        if (name === 'sessionPersistence') return { stat: async () => true }
        if (name === 'sessions') return { flush: async () => true }
      },
      tools: { register() {} }, systemPrompt: { section: () => () => {}, variable: () => () => {} },
      reflect: { provide: (name, value) => provided.set(name, value) },
      on: (name, fn) => { handlers.set(name, fn); return () => handlers.delete(name) },
      logger: { warn() {} }, emit() {}, effect() {},
    }
    const dispose = createBlackboardPlugin()(ctx)
    const runtime = runtimeBlackboard(ctx)
    t.after(async () => { await dispose(); await runtime.kernel.clearRuntime(ID, { releaseWriter: true }) })
    return { dispose, handlers, runtime, service: provided.get('weirBlackboard') }
  }
  return { ...f, agents, agent, mount }
}
async function secondHost(home) {
  const { execFile } = await import('node:child_process')
  const { fileURLToPath } = await import('node:url')
  return new Promise((resolve, reject) => execFile(process.execPath, [fileURLToPath(new URL('./worker.js', import.meta.url)), home, 'handoff'], (error, out) => error ? reject(error) : resolve(JSON.parse(out.trim()))))
}

test('unmount before Agent disposal releases final writer for second host', async t => {
  const f = await mountedFixture(t), m = f.mount()
  await m.service.write({ agent: f.agent }, entry)
  await m.dispose()
  f.agents.delete(ID)
  m.handlers.get('agent/disposed')?.({ agent: f.agent })
  assert.equal((await secondHost(f.home)).ok, true)
})

test('unmount does not revoke another mounted participant of the same Agent', async t => {
  const f = await mountedFixture(t), a = f.mount(), b = f.mount()
  await a.service.apply({ agent: f.agent }, entry.key)
  await b.service.apply({ agent: f.agent }, entry.key)
  await a.dispose()
  assert.equal((await b.service.tokensOf(ID))[0].holder, ID)
  assert.equal((await secondHost(f.home)).ok, false)
  await b.dispose()
  assert.equal((await secondHost(f.home)).ok, true)
})

for (const face of ['tool', 'remote']) test(`${face} apply paused in ensure cannot grant after disposal`, async t => {
  const f = await mountedFixture(t), m = f.mount()
  let resume, reached
  const gate = new Promise(resolve => { resume = resolve })
  const paused = new Promise(resolve => { reached = resolve })
  const ensure = m.runtime.kernel.ensure
  m.runtime.kernel.ensure = async id => { await ensure(id); reached(); await gate }
  const pending = face === 'tool' ? m.service.apply({ agent: f.agent }, entry.key) : createBlackboardRemoteService().apply(f.agent, { key: entry.key })
  const rejected = assert.rejects(pending, /disposed|inactive/)
  await paused
  f.agents.delete(ID)
  const disposal = m.handlers.get('agent/disposed')({ agent: f.agent })
  resume()
  await rejected
  await disposal
  assert.deepEqual(await m.service.tokensOf(ID), [])
  assert.equal((await secondHost(f.home)).ok, true)
  m.runtime.kernel.ensure = ensure
  const replacement = { ...f.agent }
  f.agents.set(ID, replacement)
  assert.equal((await m.service.apply({ agent: replacement }, entry.key)).status, 'granted')
  assert.equal((await m.service.tokensOf(ID))[0].holder, ID)
})

test('unmount during ensure fences pending calls and drains writer before remount', async t => {
  const f = await mountedFixture(t), a = f.mount()
  let resume, reached
  const gate = new Promise(resolve => { resume = resolve })
  const paused = new Promise(resolve => { reached = resolve })
  const ensure = a.runtime.kernel.ensure
  a.runtime.kernel.ensure = async id => { await ensure(id); reached(); await gate }
  const rejected = assert.rejects(a.service.apply({ agent: f.agent }, entry.key), /inactive/)
  await paused
  const closing = a.dispose()
  const b = f.mount()
  const replacement = b.service.apply({ agent: f.agent }, 'replacement')
  resume()
  await rejected; await closing
  assert.equal((await replacement).status, 'granted')
  assert.deepEqual((await b.service.tokensOf(ID)).map(row => row.key), ['replacement'])
  a.runtime.kernel.ensure = ensure
  assert.equal((await secondHost(f.home)).ok, false)
  await b.dispose()
  assert.equal((await secondHost(f.home)).ok, true)
})

test('distinct mounted child survives root mount removal and stale disposal', async t => {
  const f = await mountedFixture(t), a = f.mount(), b = f.mount()
  const child = { id: 'child', session: { header: { id: 'child', cwd: f.cwd, delegationDepth: 1, parentSession: ID } } }
  f.agents.set(child.id, child)
  await a.service.apply({ agent: f.agent }, 'root-key')
  await b.service.apply({ agent: child }, 'child-key')
  await a.dispose()
  assert.deepEqual((await b.service.tokensOf(ID)).map(row => row.holder), ['child'])
  assert.equal((await secondHost(f.home)).ok, false)
  const replacement = { ...child }
  f.agents.set(child.id, replacement)
  await b.service.apply({ agent: replacement }, 'replacement')
  await b.handlers.get('agent/disposed')({ agent: child })
  assert.deepEqual((await b.service.tokensOf(ID)).map(row => row.key), ['replacement'])
  await b.dispose()
  assert.equal((await secondHost(f.home)).ok, true)
})

for (const face of ['tool', 'remote']) test(`${face} disposal while apply is in flight rejects result and drains authority`, async t => {
  const f = await mountedFixture(t), m = f.mount()
  let resume, reached
  const gate = new Promise(resolve => { resume = resolve })
  const paused = new Promise(resolve => { reached = resolve })
  const apply = m.runtime.kernel.apply
  m.runtime.kernel.apply = async (...args) => { reached(); await gate; return apply(...args) }
  const pending = face === 'tool' ? m.service.apply({ agent: f.agent }, entry.key) : createBlackboardRemoteService().apply(f.agent, { key: entry.key })
  const rejected = assert.rejects(pending, /disposed/)
  await paused
  f.agents.delete(ID)
  const disposed = m.handlers.get('agent/disposed')({ agent: f.agent })
  resume()
  await rejected; await disposed
  assert.deepEqual(await m.service.tokensOf(ID), [])
  assert.equal((await secondHost(f.home)).ok, true)
  m.runtime.kernel.apply = apply
})
