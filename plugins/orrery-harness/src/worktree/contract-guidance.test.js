import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createLaneService } from './lanes.js'
import { renderChildContract } from './prompts.js'

// Exercise the real refusal/serialization path without spawning git processes.
async function fixture(t, states, maxActive = 4) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'worktree-guidance-')))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const commonDir = join(root, '.git')
  mkdirSync(join(commonDir, 'info'), { recursive: true })
  const lanes = states.map((state, i) => ({
    id: `lane-${i}`, state, path: join(root, '.orrery/worktrees', `lane-${i}`),
    branch: `orrery/lane-${i}`, base: { branch: 'main' }, scope: [],
  }))
  let adds = 0
  const service = createLaneService({
    git: {
      version: async () => [2, 40, 0], supported: () => true,
      repoOf: async () => ({ mainRoot: root, commonDir }),
      currentBranch: async () => 'main', revParse: async () => 'base',
      worktreeList: async () => [{ path: root }, ...lanes.map(({ path }) => ({ path }))],
      worktreeAdd: async () => { adds++ },
    },
    settings: () => ({ enabled: true, root: '.orrery/worktrees', maxActive, autoSetup: false }),
    shellRun: null, ask: null, notify() {}, audit() {}, modeOf: () => false,
  })
  const repo = await service.repoFor(root)
  await repo.ledger.replace({ schemaVersion: 1, seq: lanes.length, lanes })
  return { service, repo, lanes, session: { id: 'owner', header: { cwd: root } }, adds: () => adds }
}

test('MAX_ACTIVE lists every active lane and prefers the landable lane', async (t) => {
  const h = await fixture(t, ['working', 'landable', 'ready', 'abandoned'], 3)
  const before = h.repo.ledger.read()
  await assert.rejects(h.service.open(h.session, { title: 'new' }), (error) => {
    const payload = error.toJSON()
    assert.equal(payload.code, 'MAX_ACTIVE')
    assert.deepEqual(payload.data.lanes.map(({ id, state }) => ({ id, state })),
      h.lanes.slice(0, 3).map(({ id, state }) => ({ id, state })))
    for (const lane of payload.data.lanes) assert.ok(payload.message.includes(`${lane.id} · ${lane.state}`))
    assert.match(payload.next.hint, /worktree_land.*lane-1/)
    assert.match(payload.data.lanes[0].hint, /wait.*lane-0.*worktree_abandon/)
    assert.doesNotMatch(payload.message, /lane-3/)
    return true
  })
  assert.deepEqual(h.repo.ledger.read(), before)
  assert.equal(h.adds(), 0)
})

test('MAX_ACTIVE without a landable lane recommends waiting or abandonment', async (t) => {
  const h = await fixture(t, ['working'], 1)
  await assert.rejects(h.service.open(h.session, { title: 'new' }), (error) => {
    assert.equal(error.code, 'MAX_ACTIVE')
    assert.match(error.next.hint, /wait.*lane-0.*worktree_abandon/)
    assert.doesNotMatch(error.next.hint, /worktree_land/)
    return true
  })
})

test('SCOPE_OVERLAP serializes only overlapping globs from both scopes and recovery', async (t) => {
  const h = await fixture(t, ['working'])
  await h.repo.ledger.update((ledger) => {
    ledger.lanes[0].scope = ['src/auth/**', 'docs/**', 'src/shared/**']
    return { ledger }
  })
  const before = h.repo.ledger.read()
  await assert.rejects(h.service.open(h.session, { title: 'new', scope: ['src/**', 'test/**'] }), (error) => {
    const payload = error.toJSON()
    assert.equal(payload.code, 'SCOPE_OVERLAP')
    assert.equal(payload.lane, 'lane-0')
    assert.deepEqual(payload.data.overlapping, { scope: ['src/**'], laneScope: ['src/auth/**', 'src/shared/**'] })
    assert.match(payload.message, /narrow the new scope/)
    assert.match(payload.message, /wait for lane lane-0 to land/)
    assert.match(payload.next.hint, /src\/auth\/\*\*/)
    return true
  })
  assert.deepEqual(h.repo.ledger.read(), before)
  assert.equal(h.adds(), 0)
})

test('worker guidance is present only in the write contract; read-only contract stays exact', () => {
  const lane = { id: 'lane-1', path: '/repo/lane-1', branch: 'orrery/lane-1', base: { branch: 'main' }, scope: ['src/**'] }
  const write = renderChildContract(lane, { readOnly: false })
  const read = renderChildContract(lane, { readOnly: true })
  for (const line of [
    'You are a delegated worker: do not call create_goal/update_goal; goal tools reject non-top-level agents.',
    'Report blockers and outcomes in your final report; do not send_message to the parent (its id is not available to you).',
    'Run every command, tests included, with workdir at the lane root; the integration-test root resolves lane-locally by default.',
  ]) {
    assert.ok(write.includes(line))
    assert.ok(!read.includes(line))
  }
  assert.equal(read, `<lane id="lane-1">
You are investigating lane lane-1 at /repo/lane-1 (branch orrery/lane-1).
- Pass workdir="/repo/lane-1" (or a directory inside it) on every shell call; use absolute paths under it for reads.
</lane>`)
})
