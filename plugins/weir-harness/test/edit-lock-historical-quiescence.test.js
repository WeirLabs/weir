import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openReservedEditLockRuntime } from '../src/edit-lock/reserved-runtime.js'
import { reservationPathFor } from '../src/edit-lock/reservation.js'

test('characterizes the generic handoff gap: rejected adapter can retain a writer after close and recovery', async () => {
  const base = await realpath(await mkdtemp(join(tmpdir(), 'weir-historical-quiescence-')))
  const directory = join(base, 'authority')
  const target = join(base, 'target.txt')
  const gate = Promise.withResolvers()
  let detached
  let oldRuntime
  let recovered
  let calls = 0
  let landed = false
  try {
    await mkdir(directory)
    await writeFile(target, 'before')
    // Deliberately arbitrary adapter, NOT a claim about the installed host fs.
    // Its returned rejection is not a join handle for its detached writer.
    const fs = {
      async resolve(path) { return path },
      async writeText(path, content) {
        calls++
        detached = gate.promise.then(async () => {
          await writeFile(path, content)
          landed = true
        })
        throw new Error('adapter rejected with writer outstanding')
      },
    }
    const options = { directory, root: base, domainId: base, fs }
    oldRuntime = await openReservedEditLockRuntime({ ...options, mode: 'create' })
    const execution = await oldRuntime.control.openSession('old')
    const ready = await oldRuntime.requests.prepare(execution, {
      operationId: 'old-write', tool: 'write', filePath: target, cwd: base,
      args: {}, content: 'late old bytes', effectivePolicy: { mode: 'workspace-write' },
      expected: { kind: 'replaceIfVersion', version: 'original' },
    }, new AbortController().signal)
    await assert.rejects(oldRuntime.requests.commit(ready.submission), /writer outstanding/)
    const history = oldRuntime.control.history('old', 'old-write')
    assert.equal(history.phase, 'unknown')
    await oldRuntime.control.drain()
    assert.equal(landed, false)
    await oldRuntime.close()
    assert.equal(existsSync(reservationPathFor(directory)), false)

    // This intentionally violates recovery's old-publisher-quiescence precondition.
    // Passing assertions preserve evidence of a GAP, not a desired safety guarantee.
    recovered = await openReservedEditLockRuntime({ ...options, mode: 'recover' })
    await recovered.control.openSession('new')
    assert.deepEqual(recovered.control.history('old', 'old-write'), history)
    await assert.rejects(recovered.control.adminUnlock(target, 1), /fence/)
    assert.equal(await readFile(target, 'utf8'), 'before')
    assert.equal(landed, false)
    gate.resolve()
    await detached
    assert.equal(await readFile(target, 'utf8'), 'late old bytes')
    assert.equal(calls, 1)
    assert.deepEqual(recovered.control.history('old', 'old-write'), history)
  } finally {
    gate.resolve()
    // Join the actual writer before closing fixtures or deleting its target.
    if (detached) await detached
    if (recovered) await recovered.close()
    if (oldRuntime) await oldRuntime.close()
    // Exact canonical mkdtemp fixture above, never a real authority snapshot.
    await rm(base, { recursive: true, force: true })
  }
})
