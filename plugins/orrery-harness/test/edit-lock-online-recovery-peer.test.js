import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { mkdtemp, mkdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRemoteEditLockDomain } from '../src/edit-lock/remote.js'
import { remoteDomain } from '../src/edit-lock/domain.js'
import { recoveryConfirmation } from '../src/edit-lock/admin-recovery.js'
import { inspectAuthority } from '../src/edit-lock/maintenance.js'
import { ONLINE_RECOVERY_ACTOR } from '../src/edit-lock/admin-ledger.js'
import { fixtureEndpoint } from './helpers/edit-lock-fixtures.js'

const childScript = fileURLToPath(new URL('./helpers/online-recovery-publisher-child.js', import.meta.url))
const sleep = ms => new Promise(resolve => {
  const timer = setTimeout(resolve, ms)
  timer.unref?.()
})
async function waitForFact(facts, kind, child, childErr) {
  const deadline = Date.now() + 30_000
  while (true) {
    if (existsSync(facts)) {
      const rows = readFileSync(facts, 'utf8').trim().split('\n').filter(Boolean)
        .map(line => { try { return JSON.parse(line) } catch { return null } })
      const found = rows.find(row => row?.kind === kind)
      if (found) return found
    }
    if (Date.now() > deadline) throw new Error(`publisher child never reported ${kind}: ${childErr()}`)
    if (child.exitCode !== null) throw new Error(`publisher child exited early (${child.exitCode}): ${childErr()}`)
    await sleep(10)
  }
}

test('two-process probe: a client host settles a live publisher\'s unknown over the peer channel', async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'orrery-online-peer-')))
  // The production authority layout, so the maintenance inspector reads it.
  const directory = join(root, '.orrery', 'edit-lock')
  await mkdir(directory, { recursive: true })
  await writeFile(join(root, 'a.txt'), 'original')
  const endpoint = fixtureEndpoint(directory)
  const facts = join(root, 'facts.jsonl')
  const child = spawn(process.execPath, [childScript, directory, root, endpoint, facts], { stdio: ['ignore', 'pipe', 'pipe'] })
  let stderr = ''
  child.stderr.on('data', data => { stderr += data })
  const childErr = () => stderr
  try {
    await waitForFact(facts, 'ready', child, childErr)
    const remote = createRemoteEditLockDomain(endpoint, { onNotice() {} })
    try {
      const domain = remoteDomain(remote)
      const agent = { id: 'operator-session' }
      assert.equal(await domain.start(agent), 'active')
      // The operator reads the scope exactly like the maintenance panel does.
      const inspected = inspectAuthority(root)
      assert.equal(inspected.presence, 'valid')
      assert.equal(inspected.snapshot.unresolved.length, 1)
      assert.equal(inspected.snapshot.unresolved[0].admissionBlocked, true)
      assert.equal(inspected.snapshot.sessions.find(s => s.sessionId === 'victim').interrupted, true)
      const recovery = { owner: 'victim', expectedRevision: inspected.snapshot.revision, operationIds: ['op-peer'],
        recoveryId: 'peer-case-1', reason: 'Operator accepts residual late writer risk', acceptLateWriterRisk: true }
      recovery.confirmation = recoveryConfirmation({ root, ...recovery })
      // The one click, forwarded through this host's channel to the publisher.
      const result = await domain.adminRecover(agent, recovery)
      assert.equal(result.idempotent, false)
      assert.equal(result.record.actor, ONLINE_RECOVERY_ACTOR)
      assert.equal(result.record.owner, 'victim')
      // The publisher-side audit took the trigger from the CHANNEL agent,
      // never from the payload (the payload carries no identity field at all).
      const audit = await waitForFact(facts, 'audit', child, childErr)
      assert.equal(audit.trigger, 'operator-session')
      assert.equal(audit.revision, result.revision)
      assert.equal(audit.actor, ONLINE_RECOVERY_ACTOR)
      // No restart anywhere: the client host's fenced acquisition is admitted.
      const acquired = await remote.call(agent, 'acquire', { filePath: 'a.txt', cwd: root })
      assert.equal(acquired.generation, 2)
      // History stays unknown; the disposition shows exactly like the offline path.
      const after = inspectAuthority(root)
      assert.equal(after.snapshot.unresolved[0].phase, 'unknown')
      assert.equal(after.snapshot.unresolved[0].admissionBlocked, false)
      assert.equal(after.snapshot.unresolved[0].administrativeRecoveryId, 'peer-case-1')
      // An idempotent retry over the same channel.
      const retry = await domain.adminRecover(agent, recovery)
      assert.equal(retry.idempotent, true)
      assert.equal(retry.record.recoveryId, 'peer-case-1')
    } finally {
      remote.close()
    }
  } finally {
    child.kill('SIGKILL')
    await new Promise(resolve => child.once('exit', resolve))
    await rm(root, { recursive: true, force: true })
  }
})
