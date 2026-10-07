// Tasks 6.1/6.2 of the session-capability-manager change (design D6):
// synchronous in-memory lifecycle snapshots and the blocking durable capture
// of inherited subagent snapshots. G4b (EXECUTED) proved the failure shape is
// yielding the event loop, so the listener paths are pinned fully synchronous.
import { test, expect } from './helpers.js'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createHash } from 'node:crypto'
import { createLifecycleSnapshots, INHERITED_ORIGIN } from '../src/capabilities/lifecycle-snapshot.js'
import { preloadLifecycleSnapshots } from '../src/capabilities/lifecycle-preload.js'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { createSkillIdentity } from '../src/capabilities/skill-identity.js'

const base = () => mkdtempSync(join(tmpdir(), 'weir-lifecycle-'))
const alpha = createSkillIdentity({ scope: 'user', root: '/user', name: 'alpha', opaqueId: 'user-alpha' })
const beta = createSkillIdentity({ scope: 'project', root: '/project', name: 'beta', opaqueId: 'project-beta' })

const seedSelection = async (root, sessionId, revision, skills, mcpServers = []) => {
  const store = openCapabilityStore({ root, platform: 'darwin' })
  const first = await store.commit({ kind: 'selection', sessionId }, 0, () => ({ skills, mcpServers }))
  let current = first
  for (let r = 1; r < revision; r += 1) {
    current = await store.commit({ kind: 'selection', sessionId }, r, () => ({ skills, mcpServers }))
  }
  return current
}

const childPayload = (sessionId, parentSession, depth = 1) => ({
  agent: { session: { id: sessionId, header: { delegationDepth: depth, ...(parentSession ? { parentSession } : {}) } } },
})
const rootPayload = sessionId => ({ agent: { session: { id: sessionId, header: { delegationDepth: 0 } } } })

test('6.1 memory snapshot: publish then read hits memory, snapshots are frozen', () => {
  const lifecycle = createLifecycleSnapshots({ root: base() })
  const snapshot = lifecycle.publish('s1', { revision: 3, skills: [alpha], mcpServers: ['docs'] })
  expect(snapshot.state).toBe('ready')
  expect(lifecycle.snapshotFor('s1')).toBe(snapshot)
  expect(Object.isFrozen(snapshot)).toBe(true)
  expect(Object.isFrozen(snapshot.skills)).toBe(true)
  assert.throws(() => { snapshot.skills.push(beta) }, TypeError)
})

test('6.1 disk-miss performs one blocking synchronous read and caches the record', async () => {
  const root = base()
  await seedSelection(root, 's2', 2, [alpha, beta], ['docs'])
  const lifecycle = createLifecycleSnapshots({ root })
  const snapshot = lifecycle.snapshotFor('s2')
  expect(snapshot?.state).toBe('ready')
  expect(snapshot?.revision).toBe(2)
  expect(snapshot?.skills.map(s => s.name)).toEqual(['alpha', 'beta'])
  expect(snapshot?.mcpServers).toEqual(['docs'])
})

test('6.1 absent record returns null (cold state, not a failure)', () => {
  const lifecycle = createLifecycleSnapshots({ root: base() })
  expect(lifecycle.snapshotFor('never-accepted')).toBeNull()
})

test('6.4 root rule: corrupt, unknown-schema and torn records become BLOCKED and the listener never throws', async () => {
  const root = base()
  for (const [sessionId, text] of [
    ['corrupt-session', '{'],
    ['schema-session', JSON.stringify({ schemaVersion: 99, revision: 1, payload: {}, receipts: [], digest: 'x' })],
  ]) {
    mkdirSync(join(root, 'sessions', sessionId), { recursive: true })
    writeFileSync(join(root, 'sessions', sessionId, 'selection.json'), text)
  }
  await seedSelection(root, 'torn-session', 1, [alpha])
  const tornPath = join(root, 'sessions', 'torn-session', 'selection.json')
  const torn = JSON.parse(readFileSync(tornPath, 'utf8'))
  torn.revision = 5 // digest no longer matches
  writeFileSync(tornPath, JSON.stringify(torn))
  const lifecycle = createLifecycleSnapshots({ root })
  expect(lifecycle.snapshotFor('corrupt-session')?.reason).toBe('corrupt')
  expect(lifecycle.snapshotFor('schema-session')?.reason).toBe('unknown-schema')
  expect(lifecycle.snapshotFor('torn-session')?.reason).toBe('torn')
  // The root-session listener path swallows all of these (6.4 rule 1).
  expect(lifecycle.agentCreated(rootPayload('corrupt-session'))).toBeUndefined()
  expect(lifecycle.agentCreated(rootPayload('schema-session'))).toBeUndefined()
  // The original files are never rewritten from the read path.
  expect(readFileSync(join(root, 'sessions', 'corrupt-session', 'selection.json'), 'utf8')).toBe('{')
})

test('6.4 root rule: an unreadable record (EISDIR) becomes BLOCKED, never a guessed authorization', () => {
  const root = base()
  mkdirSync(join(root, 'sessions', 'unreadable-session', 'selection.json'), { recursive: true })
  const lifecycle = createLifecycleSnapshots({ root })
  const snapshot = lifecycle.snapshotFor('unreadable-session')
  expect(snapshot?.state).toBe('blocked')
  expect(snapshot?.reason).toBe('unreadable')
})

test('6.1 unsupported platform and missing profileContext are explicit, not silent', () => {
  expect(createLifecycleSnapshots({ root: base(), platform: 'win32' }).support.supported).toBe(false)
  expect(createLifecycleSnapshots({}).support).toEqual({ supported: false, reason: 'profile-context-unavailable' })
  const lifecycle = createLifecycleSnapshots({ root: base(), platform: 'win32' })
  assert.throws(() => lifecycle.captureInherited('c1', 'p1'), /unsupported/)
})

test('6.2 capture: subagent listener durably captures the parent snapshot verbatim', async () => {
  const root = base()
  await seedSelection(root, 'parent', 2, [alpha, beta], ['docs'])
  const lifecycle = createLifecycleSnapshots({ root })
  expect(lifecycle.agentCreated(childPayload('child-1', 'parent'))).toBeUndefined()
  // Interop: the captured record decodes through the async group-2 store.
  const store = openCapabilityStore({ root, platform: 'darwin' })
  const record = await store.read({ kind: 'inherited', sessionId: 'child-1' })
  expect(record.kind).toBe('ok')
  expect(record.revision).toBe(1)
  expect(record.payload.origin).toBe(INHERITED_ORIGIN)
  expect(record.payload.skills.map(s => s.name)).toEqual(['alpha', 'beta'])
  expect(record.payload.mcpServers).toEqual(['docs'])
  expect(record.payload.parent).toEqual({ sessionId: 'parent', revision: 2 })
  const memory = lifecycle.snapshotFor('child-1')
  expect(memory?.state).toBe('ready')
  expect(memory?.captured?.parentSessionId).toBe('parent')
})

test('6.2 capture: a second capture of the same subagent writes the next revision (resume seam for 6.3)', async () => {
  const root = base()
  await seedSelection(root, 'parent', 1, [alpha])
  const lifecycle = createLifecycleSnapshots({ root })
  lifecycle.agentCreated(childPayload('child-2', 'parent'))
  lifecycle.agentCreated(childPayload('child-2', 'parent'))
  const store = openCapabilityStore({ root, platform: 'darwin' })
  const record = await store.read({ kind: 'inherited', sessionId: 'child-2' })
  expect(record.kind).toBe('ok')
  expect(record.revision).toBe(2)
})

test('6.2 fail closed: a subagent without a parent session id is refused (listener throws)', () => {
  const lifecycle = createLifecycleSnapshots({ root: base() })
  assert.throws(() => lifecycle.agentCreated(childPayload('orphan', null)), /no parent session id/)
})

test('6.2 fail closed: an unreadable parent snapshot refuses the capture and writes nothing', async () => {
  const root = base()
  mkdirSync(join(root, 'sessions', 'parent'), { recursive: true })
  writeFileSync(join(root, 'sessions', 'parent', 'selection.json'), '{')
  const lifecycle = createLifecycleSnapshots({ root })
  assert.throws(() => lifecycle.agentCreated(childPayload('child-3', 'parent')), /unreadable/)
  const store = openCapabilityStore({ root, platform: 'darwin' })
  expect((await store.read({ kind: 'inherited', sessionId: 'child-3' })).kind).toBe('absent')
})

test('6.2 fail closed: an existing undecodable inherited record is never overwritten', async () => {
  const root = base()
  await seedSelection(root, 'parent', 1, [alpha])
  mkdirSync(join(root, 'sessions', 'child-4'), { recursive: true })
  const recordPath = join(root, 'sessions', 'child-4', 'inherited.json')
  writeFileSync(recordPath, 'not json')
  const lifecycle = createLifecycleSnapshots({ root })
  assert.throws(() => lifecycle.captureInherited('child-4', 'parent'), /refusing to overwrite/)
  expect(readFileSync(recordPath, 'utf8')).toBe('not json')
})

test('6.2 capture refuses self-inheritance', () => {
  const lifecycle = createLifecycleSnapshots({ root: base() })
  assert.throws(() => lifecycle.captureInherited('self', 'self'), /cannot inherit from itself/)
})

test('6.1 listener is synchronous: no await anywhere in the module and every success path returns undefined', async () => {
  const source = readFileSync(fileURLToPath(new URL('../src/capabilities/lifecycle-snapshot.js', import.meta.url)), 'utf8')
  // The whole module is the listener path (G4b: yielding, not slowness, is
  // the failure shape) — the token must not appear even in comments.
  expect(/\bawait\b/.test(source)).toBe(false)
  const root = base()
  await seedSelection(root, 'parent', 1, [alpha])
  const lifecycle = createLifecycleSnapshots({ root })
  expect(lifecycle.agentCreated.constructor.name).toBe('Function')
  expect(lifecycle.agentCreated(rootPayload('parent'))).toBeUndefined()
  expect(lifecycle.agentCreated(childPayload('child-5', 'parent'))).toBeUndefined()
})

test('6.1 listener timing: a warm synchronous read stays in the sub-millisecond class', async () => {
  const root = base()
  await seedSelection(root, 'parent', 1, [alpha])
  const lifecycle = createLifecycleSnapshots({ root })
  lifecycle.agentCreated(rootPayload('parent')) // warm the memory snapshot
  const started = performance.now()
  for (let i = 0; i < 50; i += 1) lifecycle.agentCreated(rootPayload('parent'))
  const elapsed = performance.now() - started
  // G4b measured ~0.2 ms per read; 50 warm reads must stay far below any
  // event-loop-yielding budget (generous CI ceiling).
  assert.ok(elapsed < 50, `50 warm agent/created reads took ${elapsed} ms`)
})

test('6.1 preload: accepted records of known sessions load at apply, corrupt ones pre-mark BLOCKED, memory wins', async () => {
  const root = base()
  await seedSelection(root, 'known', 1, [alpha], ['docs'])
  mkdirSync(join(root, 'sessions', 'broken'), { recursive: true })
  writeFileSync(join(root, 'sessions', 'broken', 'selection.json'), '{')
  const lifecycle = createLifecycleSnapshots({ root })
  const fresher = lifecycle.publish('known', { revision: 9, skills: [beta], mcpServers: [] })
  const result = await preloadLifecycleSnapshots({ lifecycle, store: openCapabilityStore({ root, platform: 'darwin' }) })
  expect(result.loaded).toBe(0) // 'known' already had a fresher in-memory publication
  expect(result.blocked).toBe(1)
  expect(lifecycle.snapshotFor('known')).toBe(fresher)
  expect(lifecycle.snapshotFor('broken')?.state).toBe('blocked')
  const cold = createLifecycleSnapshots({ root })
  const second = await preloadLifecycleSnapshots({ lifecycle: cold, store: openCapabilityStore({ root, platform: 'darwin' }) })
  expect(second.loaded).toBe(1)
  expect(cold.snapshotFor('known')?.skills.map(s => s.name)).toEqual(['alpha'])
})

test('6.1 preload: unsupported stores report instead of throwing', async () => {
  const result = await preloadLifecycleSnapshots({ lifecycle: createLifecycleSnapshots({ root: base() }), platform: 'win32' })
  expect(result.loaded).toBe(0)
  expect(typeof result.unsupported).toBe('string')
})

test('6.1 Apply acceptance loads the shared lifecycle snapshot via the engine publishSnapshot hook', async () => {
  const root = base()
  const lifecycle = createLifecycleSnapshots({ root })
  const { createApplyEngine } = await import('../src/capabilities/apply-engine.js')
  const digest = createHash('sha256').update('req-1').digest('hex')
  const engine = createApplyEngine({
    store: openCapabilityStore({ root, platform: 'darwin' }),
    locateSession: () => ({ sessionId: 'apply-session', presetId: 'weir' }),
    inventory: async () => ({ complete: true, candidates: [
      { status: 'parsed', name: 'alpha', identity: alpha, path: '/user/alpha/SKILL.md', digest: 'd1' },
    ] }),
    provider: { acceptSelection: () => ({ accepted: true }) },
    publishSnapshot: (sessionId, next) => lifecycle.publish(sessionId, next),
  })
  const result = await engine.apply({}, {
    requestId: 'req-1',
    requestDigest: digest,
    expectedRevision: 0,
    selection: { skills: [alpha], mcpServers: ['docs'] },
  })
  expect(result.status).toBe('applied')
  const snapshot = lifecycle.snapshotFor('apply-session')
  expect(snapshot?.state).toBe('ready')
  expect(snapshot?.revision).toBe(1)
  expect(snapshot?.skills.map(s => s.name)).toEqual(['alpha'])
  expect(snapshot?.mcpServers).toEqual(['docs'])
})

// --- Resume/fork incarnation capture (capability-resume-incarnation-recovery D1) ---

const incarnationPayload = (sessionId, parentSession) => ({
  agent: { session: { id: sessionId, header: { delegationDepth: 0, ...(parentSession ? { parentSession } : {}) } } },
})

test('D1 incarnation: a depth-0 session with a parentSession captures the parent snapshot at creation (narrower-only)', async () => {
  const root = base()
  await seedSelection(root, 'parent', 2, [alpha, beta], ['docs'])
  const lifecycle = createLifecycleSnapshots({ root })
  expect(lifecycle.agentCreated(incarnationPayload('incarnation-1', 'parent'))).toBeUndefined()
  // Interop: the captured record decodes through the async group-2 store.
  const store = openCapabilityStore({ root, platform: 'darwin' })
  const record = await store.read({ kind: 'inherited', sessionId: 'incarnation-1' })
  expect(record.kind).toBe('ok')
  expect(record.revision).toBe(1)
  expect(record.payload.origin).toBe(INHERITED_ORIGIN)
  expect(record.payload.skills.map(s => s.name)).toEqual(['alpha', 'beta'])
  expect(record.payload.mcpServers).toEqual(['docs'])
  expect(record.payload.parent).toEqual({ sessionId: 'parent', revision: 2 })
  const memory = lifecycle.snapshotFor('incarnation-1')
  expect(memory?.state).toBe('ready')
  expect(memory?.captured?.parentSessionId).toBe('parent')
})

test('D1 incarnation: an unavailable parent snapshot blocks like an unreadable root record and NEVER throws', async () => {
  const root = base()
  mkdirSync(join(root, 'sessions', 'parent'), { recursive: true })
  writeFileSync(join(root, 'sessions', 'parent', 'selection.json'), '{')
  const warnings = []
  const lifecycle = createLifecycleSnapshots({ root, warn: text => warnings.push(text) })
  // The ROOT failure rule (6.4), never the subagent rule: creation is NOT rejected.
  expect(lifecycle.agentCreated(incarnationPayload('incarnation-2', 'parent'))).toBeUndefined()
  const snapshot = lifecycle.snapshotFor('incarnation-2')
  expect(snapshot?.state).toBe('blocked')
  expect(snapshot?.reason).toBe('unreadable')
  expect(warnings.some(text => text.includes('incarnation-2'))).toBe(true)
  // Nothing was captured; no full-discovery fallback happened.
  const store = openCapabilityStore({ root, platform: 'darwin' })
  expect((await store.read({ kind: 'inherited', sessionId: 'incarnation-2' })).kind).toBe('absent')
})

test('D1 incarnation: a parentSession equal to the session id is treated as no parent (defensive)', () => {
  const lifecycle = createLifecycleSnapshots({ root: base() })
  expect(lifecycle.agentCreated(incarnationPayload('self-incarnation', 'self-incarnation'))).toBeUndefined()
  // No capture, no block: the cold absent state is legitimate.
  expect(lifecycle.snapshotFor('self-incarnation')).toBeNull()
})

test('D1 incarnation: an own accepted record wins — no capture, the user selection is never parent-narrowed', async () => {
  const root = base()
  await seedSelection(root, 'parent', 1, [alpha], ['docs'])
  await seedSelection(root, 'incarnation-3', 1, [alpha, beta], ['docs', 'web'])
  const lifecycle = createLifecycleSnapshots({ root })
  expect(lifecycle.agentCreated(incarnationPayload('incarnation-3', 'parent'))).toBeUndefined()
  const snapshot = lifecycle.snapshotFor('incarnation-3')
  expect(snapshot?.state).toBe('ready')
  expect(snapshot?.skills.map(s => s.name)).toEqual(['alpha', 'beta'])
  expect(snapshot?.mcpServers).toEqual(['docs', 'web'])
  expect(snapshot?.captured).toBeNull()
  const store = openCapabilityStore({ root, platform: 'darwin' })
  expect((await store.read({ kind: 'inherited', sessionId: 'incarnation-3' })).kind).toBe('absent')
})
