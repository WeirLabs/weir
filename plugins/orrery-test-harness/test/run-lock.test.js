// Unit suite for the run.mjs advisory lock (design D3, task 2.1): occupied
// root diverts to a private suffixed root with one loud line, stale locks are
// silently taken over, exit cleanup removes only the run's own lock, and an
// explicit ORRERY_IT_ROOT bypasses the lock logic entirely (source-pinned).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { LOCK_NAME, acquireRunLock, releaseRunLock } from '../src/run-lock.js'

/** A live pid that is not this process (spawned sleeper, killed on cleanup). */
function livePid() {
  const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore' })
  return child
}

/** A pid that is guaranteed dead by the time the promise resolves. */
function deadPid() {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, ['-e', ''], { stdio: 'ignore' })
    child.on('exit', () => resolvePromise(child.pid))
  })
}

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'orrery-run-lock-'))
  try {
    return fn(root)
  } finally {
    rmSync(root, { recursive: true, force: true })
    rmSync(`${root}-p${process.pid}`, { recursive: true, force: true })
  }
}

describe('acquireRunLock', () => {
  it('creates the lock O_EXCL with pid + ISO time on a free root', () => {
    withRoot((root) => {
      const lock = acquireRunLock(root, { log: () => assert.fail('no line on a free root') })
      assert.equal(lock.root, root)
      assert.equal(lock.diverted, false)
      const content = readFileSync(lock.lockPath, 'utf8')
      assert.match(content, new RegExp(`^${process.pid} \\d{4}-\\d{2}-\\d{2}T`))
      releaseRunLock(lock)
    })
  })

  it('diverts to a private suffixed root with one loud line when the holder is alive', () => {
    withRoot((root) => {
      const holder = livePid()
      try {
        writeFileSync(join(root, LOCK_NAME), `${holder.pid} 2026-10-06T00:00:00.000Z\n`)
        const lines = []
        const lock = acquireRunLock(root, { log: (line) => lines.push(line) })
        assert.equal(lock.diverted, true)
        assert.equal(lock.root, `${root}-p${process.pid}`)
        assert.equal(lock.lockPath, null, 'a diverted run holds no lock')
        assert.equal(lines.length, 1, 'exactly one loud stdout line')
        assert.match(lines[0], /locked by live pid/)
        // The holder's lock is untouched.
        assert.match(readFileSync(join(root, LOCK_NAME), 'utf8'), new RegExp(`^${holder.pid} `))
      } finally {
        holder.kill()
      }
    })
  })

  it('silently takes over a stale lock whose holder pid is dead', async () => {
    const stale = await deadPid()
    withRoot((root) => {
      writeFileSync(join(root, LOCK_NAME), `${stale} 2026-10-06T00:00:00.000Z\n`)
      const lock = acquireRunLock(root, { log: () => assert.fail('takeover is silent') })
      assert.equal(lock.diverted, false)
      assert.equal(lock.root, root)
      assert.match(readFileSync(lock.lockPath, 'utf8'), new RegExp(`^${process.pid} `))
      releaseRunLock(lock)
    })
  })

  it('takes over a lock with unreadable (garbage) content', () => {
    withRoot((root) => {
      writeFileSync(join(root, LOCK_NAME), 'not-a-pid\n')
      const lock = acquireRunLock(root, { log: () => assert.fail('takeover is silent') })
      assert.equal(lock.diverted, false)
      assert.match(readFileSync(lock.lockPath, 'utf8'), new RegExp(`^${process.pid} `))
      releaseRunLock(lock)
    })
  })
})

describe('releaseRunLock', () => {
  it('deletes the run’s own lock', () => {
    withRoot((root) => {
      const lock = acquireRunLock(root, { log: () => {} })
      releaseRunLock(lock)
      assert.equal(existsSync(join(root, LOCK_NAME)), false)
    })
  })

  it('never deletes another pid’s lock', () => {
    withRoot((root) => {
      const holder = livePid()
      try {
        const lockPath = join(root, LOCK_NAME)
        writeFileSync(lockPath, `${holder.pid} 2026-10-06T00:00:00.000Z\n`)
        releaseRunLock({ root, lockPath, diverted: false })
        assert.equal(existsSync(lockPath), true)
      } finally {
        holder.kill()
      }
    })
  })

  it('is a no-op for a diverted run (no lock held)', () => {
    releaseRunLock({ root: '/nonexistent', lockPath: null, diverted: true })
    releaseRunLock(null)
  })
})

describe('run.mjs wiring (source-pinned, like it-root.test.js)', () => {
  it('bypasses the lock entirely when ORRERY_IT_ROOT is explicit', async () => {
    const source = readFileSync(new URL('../run.mjs', import.meta.url), 'utf8')
    assert.match(source, /const RUN_LOCK = process\.env\.ORRERY_IT_ROOT \? null : acquireRunLock\(IT_ROOT\)/)
  })

  it('derives every runtime path from the root this run actually uses', async () => {
    const source = readFileSync(new URL('../run.mjs', import.meta.url), 'utf8')
    assert.match(source, /const RUN_ROOT = RUN_LOCK\?\.root \?\? IT_ROOT/)
    assert.match(source, /const HOME = join\(RUN_ROOT, 'home'\)/)
    assert.match(source, /ORRERY_IT_ROOT: RUN_ROOT/)
  })
})
