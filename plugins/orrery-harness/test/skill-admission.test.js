import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, realpath, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { openCapabilityStore } from '../src/capabilities/store/store.js'
import { createStubLiveness } from './helpers/stub-liveness.js'
import { createSkillIdentity } from '../src/capabilities/skill-identity.js'
import { createAdmissionFence, createApplyEngine, createDrainCoordinator } from '../src/capabilities/apply-engine.js'
import { createSkillAdmission } from '../src/capabilities/skill-admission.js'

const SESSION = 'session-66666666-7777-4888-8999-000000000000'
const auth = { id: SESSION, authenticated: true }

const identity = (scope, name) => createSkillIdentity({ scope, root: `/${scope}`, name, opaqueId: `${scope}-${name}` })
const alpha = identity('user', 'alpha')
const beta = identity('project', 'beta')

const candidateOf = value => ({ status: 'parsed', name: value.name, identity: value,
  path: `/${value.scope}/${value.name}/SKILL.md`, digest: createHash('sha256').update(`${value.scope}:${value.name}`).digest('hex') })

async function fixture(t, { engineOptions = {}, wrapStore } = {}) {
  const base = await realpath(tmpdir())
  const root = await mkdtemp(join(base, 'orrery-skill-admission-'))
  t.after(async () => {
    assert.equal(dirname(resolve(root)), base)
    assert.ok(root.startsWith(join(base, 'orrery-skill-admission-')))
    await rm(root, { recursive: true, force: true })
  })
  const real = openCapabilityStore({ root, platform: 'darwin', liveness: createStubLiveness() })
  const store = wrapStore ? wrapStore(real) : real
  const events = []
  const trace = (event, data) => events.push({ event, ...data })
  const fence = createAdmissionFence()
  const drain = createDrainCoordinator()
  const engine = createApplyEngine({
    store,
    locateSession: async session => session?.id === SESSION ? { sessionId: SESSION, cwd: '/server-workspace' } : null,
    inventory: async () => ({ complete: true, candidates: [alpha, beta].map(candidateOf) }),
    provider: { acceptSelection: () => ({ accepted: true, conflicts: [] }) },
    fence, drain, trace,
    ...engineOptions,
  })
  const admission = createSkillAdmission({ authority: sessionId => engine.authority(sessionId), fence: engine.fence, trace })
  return { root, store, engine, admission, fence, drain, events }
}

const applyRequest = ({ requestId = 'req-1', expectedRevision = 0, selection, unresolved = [] } = {}) =>
  ({ requestId, expectedRevision, selection: selection ?? { skills: [alpha], mcpServers: [] }, unresolved })

/** A store wrapper that pauses the SECOND selection commit (revision 1 -> 2). */
const gateSecondSelectionCommit = real => {
  let release
  const gate = new Promise(resolve => { release = resolve })
  const wrapper = { ...real, entered: false, release: () => release(),
    commit: async (...args) => {
      if (args[0].kind === 'selection' && args[1] === 1) { wrapper.entered = true; await gate }
      return real.commit(...args)
    } }
  return wrapper
}

test('path 1: an unselected skill call is explicitly unavailable and its body is never loaded', async t => {
  const { engine, admission } = await fixture(t)
  await engine.apply(auth, applyRequest({ selection: { skills: [alpha], mcpServers: [] } }))
  let loads = 0
  const loader = async () => { loads++; return 'BODY' }
  const result = await admission.loadBody(SESSION, beta, loader)
  assert.equal(result.status, 'unavailable')
  assert.equal(result.reason, 'skill-not-selected')
  assert.equal(result.revision, 1)
  assert.match(result.message, /not selected/)
  assert.equal(loads, 0)
  const admitted = await admission.admit(SESSION, alpha)
  assert.equal(admitted.status, 'admitted')
  assert.equal(admitted.revision, 1)
  const denied = await admission.admit(SESSION, beta)
  assert.equal(denied.status, 'unavailable')
  assert.equal(denied.reason, 'skill-not-selected')
  // The selected skill loads and publishes normally.
  const loaded = await admission.loadBody(SESSION, alpha, loader)
  assert.equal(loaded.status, 'loaded')
  assert.equal(loaded.content, 'BODY')
  assert.equal(loaded.revision, 1)
  assert.equal(loads, 1)
})

test('path 2: slash submissions are re-validated server-side against the current selection, never trusting client filtering', async t => {
  const { engine, admission, events } = await fixture(t)
  await engine.apply(auth, applyRequest({ selection: { skills: [alpha], mcpServers: [] } }))
  // A client-filtered list would never offer beta, but the server is asked
  // anyway — the submission is re-checked against the current selection.
  const smuggled = await admission.validateSlash(SESSION, beta)
  assert.equal(smuggled.status, 'unavailable')
  assert.equal(smuggled.reason, 'skill-not-selected')
  const legitimate = await admission.validateSlash(SESSION, alpha)
  assert.equal(legitimate.status, 'admitted')
  assert.equal(legitimate.revision, 1)
  // After a removal the server-side verdict flips for the same submission.
  await engine.apply(auth, applyRequest({ requestId: 'req-2', expectedRevision: 1, selection: { skills: [], mcpServers: [] } }))
  const revoked = await admission.validateSlash(SESSION, alpha)
  assert.equal(revoked.status, 'unavailable')
  assert.equal(revoked.reason, 'skill-not-selected')
  assert.equal(revoked.revision, 2)
  const revalidations = events.filter(entry => entry.event === 'slash-revalidation')
  assert.deepEqual(revalidations.map(entry => entry.status), ['unavailable', 'admitted', 'unavailable'])
})

test('path 3 and pre-publication refusal: a handed-off read completing after a removal is revoked before any content is returned (read is not authorization)', async t => {
  const { engine, admission, events } = await fixture(t)
  await engine.apply(auth, applyRequest({ selection: { skills: [alpha], mcpServers: [] } }))
  let entered = false
  let release
  const gate = new Promise(resolve => { release = resolve })
  const loader = async () => { entered = true; await gate; return 'SECRET BODY' }
  // The read is handed off under revision 1, then suspended mid-flight.
  const pending = admission.loadBody(SESSION, alpha, loader)
  while (!entered) await new Promise(resolve => setImmediate(resolve))
  // The removal lands while the body is being read.
  const removed = await engine.apply(auth, applyRequest({ requestId: 'req-2', expectedRevision: 1, selection: { skills: [], mcpServers: [] } }))
  assert.equal(removed.status, 'applied')
  release()
  const result = await pending
  assert.equal(result.status, 'revoked')
  assert.equal(result.reason, 'selection-revoked')
  assert.equal(result.revision, 2)
  assert.equal('content' in result, false)
  assert.ok(events.some(entry => entry.event === 'publication-revoked'))
})

test('after a removal is accepted, not-handed-off body loads and prompt publications are refused', async t => {
  const { engine, admission, events } = await fixture(t)
  await engine.apply(auth, applyRequest({ selection: { skills: [alpha], mcpServers: [] } }))
  await engine.apply(auth, applyRequest({ requestId: 'req-2', expectedRevision: 1, selection: { skills: [], mcpServers: [] } }))
  let loads = 0
  const loader = async () => { loads++; return 'BODY' }
  const blocked = await admission.loadBody(SESSION, alpha, loader)
  assert.equal(blocked.status, 'unavailable')
  assert.equal(blocked.reason, 'skill-not-selected')
  assert.equal(blocked.revision, 2)
  assert.equal(loads, 0)
  const prompt = await admission.admitPromptPublication(SESSION, alpha)
  assert.equal(prompt.status, 'unavailable')
  assert.equal(prompt.reason, 'skill-not-selected')
  const publications = events.filter(entry => entry.event === 'prompt-publication')
  assert.deepEqual(publications.map(entry => entry.reason), ['skill-not-selected'])
})

test('the admission fence refuses not-yet-handed-off calls and prompt publications while an Apply commits', async t => {
  const { store, engine, admission, fence } = await fixture(t, { wrapStore: gateSecondSelectionCommit })
  await engine.apply(auth, applyRequest({ selection: { skills: [alpha], mcpServers: [] } }))
  const removal = engine.apply(auth, applyRequest({ requestId: 'req-2', expectedRevision: 1, selection: { skills: [], mcpServers: [] } }))
  while (!store.entered) await new Promise(resolve => setImmediate(resolve))
  assert.equal(fence.isHeld(SESSION), true)
  let loads = 0
  const loader = async () => { loads++; return 'BODY' }
  for (const attempt of [
    () => admission.admit(SESSION, alpha),
    () => admission.admitPromptPublication(SESSION, alpha),
    () => admission.validateSlash(SESSION, alpha),
    () => admission.loadBody(SESSION, alpha, loader),
  ]) {
    const denied = await attempt()
    assert.equal(denied.status, 'unavailable')
    assert.equal(denied.reason, 'admission-fence-held')
    assert.equal(denied.revision, null)
  }
  assert.equal(loads, 0)
  store.release()
  assert.equal((await removal).status, 'applied')
  // Once the removal is accepted the denial becomes the explicit post-removal state.
  const after = await admission.admit(SESSION, alpha)
  assert.equal(after.status, 'unavailable')
  assert.equal(after.reason, 'skill-not-selected')
})

test('a handed-off read may finish while the fence is held when the authority is unchanged', async t => {
  const { store, engine, admission, fence } = await fixture(t, { wrapStore: gateSecondSelectionCommit })
  await engine.apply(auth, applyRequest({ selection: { skills: [alpha], mcpServers: [] } }))
  let entered = false
  let releaseRead
  const readGate = new Promise(resolve => { releaseRead = resolve })
  const pending = admission.loadBody(SESSION, alpha, async () => { entered = true; await readGate; return 'BODY' })
  while (!entered) await new Promise(resolve => setImmediate(resolve))
  // An Apply starts and holds the fence, but has not committed yet: the
  // authority the read was handed off under is still current.
  const second = engine.apply(auth, applyRequest({ requestId: 'req-2', expectedRevision: 1, selection: { skills: [alpha], mcpServers: ['mcp-a'] } }))
  while (!store.entered) await new Promise(resolve => setImmediate(resolve))
  assert.equal(fence.isHeld(SESSION), true)
  releaseRead()
  const result = await pending
  assert.equal(result.status, 'loaded')
  assert.equal(result.content, 'BODY')
  assert.equal(result.revision, 1)
  store.release()
  assert.equal((await second).status, 'applied')
})

test('a read admitted under a superseded revision is revoked even when the skill stays selected', async t => {
  const { engine, admission } = await fixture(t)
  await engine.apply(auth, applyRequest({ selection: { skills: [alpha], mcpServers: [] } }))
  let entered = false
  let release
  const gate = new Promise(resolve => { release = resolve })
  const pending = admission.loadBody(SESSION, alpha, async () => { entered = true; await gate; return 'BODY' })
  while (!entered) await new Promise(resolve => setImmediate(resolve))
  // An unrelated (MCP-only) Apply still supersedes the authority revision;
  // the publication is revoked conservatively and the caller may retry.
  const applied = await engine.apply(auth, applyRequest({ requestId: 'req-2', expectedRevision: 1, selection: { skills: [alpha], mcpServers: ['mcp-a'] } }))
  assert.equal(applied.status, 'applied')
  release()
  const result = await pending
  assert.equal(result.status, 'revoked')
  assert.equal(result.reason, 'selection-revoked')
  assert.equal(result.revision, 2)
  // A fresh read under the new authority publishes again.
  const retry = await admission.loadBody(SESSION, alpha, async () => 'BODY')
  assert.equal(retry.status, 'loaded')
  assert.equal(retry.revision, 2)
})

test('admission fails closed when no selection authority is loaded, and an explicit empty selection is a distinct denial', async t => {
  const { engine, admission } = await fixture(t)
  let loads = 0
  const loader = async () => { loads++; return 'BODY' }
  const missing = await admission.admit(SESSION, alpha)
  assert.equal(missing.status, 'unavailable')
  assert.equal(missing.reason, 'selection-authority-unavailable')
  assert.equal(missing.revision, null)
  const blocked = await admission.loadBody(SESSION, alpha, loader)
  assert.equal(blocked.reason, 'selection-authority-unavailable')
  assert.equal(loads, 0)
  // An explicitly emptied selection IS a loaded authority: 'not selected',
  // never conflated with 'authority unavailable'.
  await engine.apply(auth, applyRequest({ selection: { skills: [], mcpServers: [] } }))
  const emptied = await admission.admit(SESSION, alpha)
  assert.equal(emptied.status, 'unavailable')
  assert.equal(emptied.reason, 'skill-not-selected')
  assert.equal(emptied.revision, 1)
})

test('malformed sessions and identities fail closed without loading', async t => {
  const { engine, admission } = await fixture(t)
  await engine.apply(auth, applyRequest())
  let loads = 0
  const loader = async () => { loads++; return 'BODY' }
  const badSession = await admission.admit('not a session', alpha)
  assert.equal(badSession.status, 'unavailable')
  assert.equal(badSession.reason, 'invalid-session')
  const badIdentity = await admission.loadBody(SESSION, { scope: 'user', root: '', name: 'x' }, loader)
  assert.equal(badIdentity.status, 'unavailable')
  assert.equal(badIdentity.reason, 'invalid-identity')
  assert.equal(loads, 0)
})
