// Child-process roles for test/capability-store-race.test.js. Every role is a
// separate OS process so the lock is exercised across real pids.
import { writeSync } from 'node:fs'
import { createInterface } from 'node:readline'
import { createNodeFs, instrumentFs } from '../../src/capabilities/store/fs-adapter.js'
import { createLiveness } from '../../src/capabilities/store/liveness.js'
import { createLockProtocol } from '../../src/capabilities/store/lock.js'
import { openCapabilityStore } from '../../src/capabilities/store/store.js'

const { role, root, unit, expected, id, point, leaseMs, dir, deadlineMs } = JSON.parse(process.argv[2])
const line = (/** @type {string} */ text) => writeSync(1, `${text}\n`)
const input = createInterface({ input: process.stdin })
const commands = input[Symbol.asyncIterator]()
/** Block without polling until the parent writes `word` on stdin; polling starves timing-sensitive suites running in parallel. @param {string} word */
const until = async word => {
  for (;;) {
    const next = await commands.next()
    if (next.done) throw new Error(`stdin closed before ${word}`)
    if (next.value === word) return
  }
}

if (role === 'commit') {
  const store = openCapabilityStore({ root, platform: 'darwin' })
  line('READY')
  await until('GO')
  const result = await store.commit(unit, expected, () => ({ writer: id }), { requestId: id, requestDigest: id })
  line(JSON.stringify({ id, status: result.status }))
} else if (role === 'crash') {
  let renamed = false
  /** @param {string} op @param {string[]} args */
  const reached = (op, args) => {
    if (op === 'rename' && args[1].endsWith('/selection.json')) renamed = true
    switch (point) {
      case 'after-lock-create': return op === 'link' && args[1].endsWith('/selection.lock')
      case 'after-write-temp': return op === 'createExclusive' && args[0].endsWith('.tmp')
      case 'after-fsync': return op === 'fsyncFile' && args[0].endsWith('.tmp')
      case 'after-rename': return op === 'rename' && args[1].endsWith('/selection.json')
      case 'after-dir-fsync': return op === 'fsyncDir' && renamed
      case 'after-release': return op === 'unlink' && args[0].endsWith('/selection.lock')
      default: throw new Error(`unknown crash point ${point}`)
    }
  }
  const fs = instrumentFs(createNodeFs(), async (op, args, phase) => {
    if (phase !== 'after' || !reached(op, args)) return
    setInterval(() => {}, 1000)
    line(`AT ${point}`)
    await new Promise(() => {})
  })
  const store = openCapabilityStore({ root, platform: 'darwin', fs, leaseMs })
  await store.commit(unit, expected, () => ({ writer: 'crash', point }))
  line('DONE')
} else if (role === 'publish-crash') {
  let switched = false
  /** @param {string} op @param {string[]} args */
  const reached = (op, args) => {
    if (op === 'rename' && args[1].endsWith('/active.json')) switched = true
    switch (point) {
      case 'after-generation-file': return op === 'createExclusive' && args[0].includes('/generations/')
      case 'after-generation-fsync': return op === 'fsyncDir' && args[0].endsWith('/generations')
      case 'after-write-temp': return op === 'createExclusive' && args[0].endsWith('.tmp')
      case 'after-rename': return op === 'rename' && args[1].endsWith('/active.json')
      case 'after-dir-fsync': return op === 'fsyncDir' && switched
      default: throw new Error(`unknown publish crash point ${point}`)
    }
  }
  const fs = instrumentFs(createNodeFs(), async (op, args, phase) => {
    if (phase !== 'after' || !reached(op, args)) return
    setInterval(() => {}, 1000)
    line(`AT ${point}`)
    await new Promise(() => {})
  })
  const store = openCapabilityStore({ root, platform: 'darwin', fs, leaseMs })
  await store.publishPointer('global', { expectedRevision: expected, generationId: id, files: { 'SKILL.md': `body ${id}`, 'b.txt': `b ${id}` }, provenance: { writer: id } })
  line('DONE')
} else if (role === 'reclaim') {
  const lockFile = `${dir}/selection.lock`
  /** @type {string[]} */
  const lockOps = []
  const fs = instrumentFs(createNodeFs(), (op, args, phase) => {
    if (phase === 'before' && (op === 'rename' || op === 'unlink') && args[0] === lockFile) lockOps.push(op)
  })
  const lock = createLockProtocol({ fs, liveness: createLiveness(), deadlineMs })
  line('READY')
  await until('GO')
  const result = await lock.acquire(dir, 'selection')
  line(JSON.stringify({ id, ok: result.ok, token: result.ok ? result.token : null, reclaimed: result.ok ? result.reclaimed : false, reason: result.ok ? null : result.reason, stats: result.stats, lockOps }))
  if (result.ok) {
    await until('RELEASE')
    await lock.release(dir, 'selection', result.token)
  }
  line('DONE')
} else {
  throw new Error(`unknown role ${role}`)
}
input.close()
