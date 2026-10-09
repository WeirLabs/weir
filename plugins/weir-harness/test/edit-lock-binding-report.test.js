import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createChannelBindingArbitration } from '../src/edit-lock/remote.js'
import { bindingGuidance, bindingRefusalReason } from '../src/edit-lock/binding-guidance.js'
import { createEditLockEvidence, maintenanceStatus, registerEditLockMaintenanceEndpoints } from '../src/edit-lock/maintenance.js'

for (const [label, pid, state, expected, excluded] of [
  ['serving', process.pid, 'serving', /active in the DeepSeek Harness window.*Use the session in that window/, /stale runtime/],
  ['same-process unknown', process.pid, 'unknown', /same process.*stale runtime incarnation.*Restart/, /window/],
  ['cross-process', process.pid + 1, 'unknown', new RegExp(`pid ${process.pid + 1}.*Quit that holder process`), /window/],
  ['old publisher', undefined, 'unknown', /holder cannot be attested.*Restart/, /window/],
]) test(`duplicate-binding guidance: ${label}`, () => {
  const reason = bindingRefusalReason(pid, state)
  assert.doesNotMatch(reason, /Restart|reservation|window/)
  const text = bindingGuidance('session-1', reason)
  assert.match(text, expected)
  assert.doesNotMatch(text, excluded)
  assert.match(text, /Do NOT remove the publisher reservation.*while its process is alive/)
})

test('guidance trusts publisher classification, not the rendering process pid', () => {
  const text = bindingGuidance('s', `session already bound: holder=cross-process-pid; pid=${process.pid}`)
  assert.match(text, /Quit that holder process/)
  assert.doesNotMatch(text, /same process/)
  const same = bindingGuidance('s', 'session already bound: holder=same-process-unattestable; pid=123')
  assert.match(same, /same process.*pid 123/)
  for (const reason of ['session already bound', 'session already bound: holder=future', 'session already bound: holder=cross-process-pid; pid=oops']) {
    assert.match(bindingGuidance('s', reason), /holder cannot be attested/)
  }
})

test('maintenance bindings are live read-only host observations, not nonce or filesystem disclosures', async () => {
  const root = await mkdtemp(join(tmpdir(), 'weir-binding-report-'))
  const dir = join(root, '.weir', 'edit-lock')
  await mkdir(dir, { recursive: true })
  const image = join(dir, 'snapshot.json')
  await writeFile(image, 'sentinel: reading status must not modify or parse this image')
  const before = await readFile(image)
  let verdict = 'serving', disconnects = 0
  const arbitration = createChannelBindingArbitration(() => verdict)
  const socket = { destroyed: false }
  await arbitration.open('s', socket, async () => ({ peer: { async disconnect() { disconnects++ } } }), { pid: process.pid, nonce: 'private-nonce' })
  const evidence = createEditLockEvidence()
  const publisher = evidence.recordMount({ enabled: true, phase: 'installed' })
  publisher.recordDomain(root, { mode: 'publisher', bindings: arbitration.bindings })
  // A later client mount for the same root must not hide the publisher's holder.
  evidence.recordMount({ enabled: true, phase: 'installed' }).recordDomain(root, { mode: 'client' })
  const deps = { savedEnabled: () => true, evidence, candidateRoots: () => [root] }
  const rows = () => maintenanceStatus(deps).domains[0].bindings
  assert.deepEqual(rows(), [{ sessionId: 's', present: true, holderPid: process.pid, attestable: true, attestation: 'serving' }])
  verdict = 'unknown'
  assert.equal(rows()[0].attestable, false)
  assert.equal(rows()[0].attestation, 'unknown')
  const routes = new Map()
  const unregister = registerEditLockMaintenanceEndpoints({ connection: { fetch: { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } } } }, deps)
  try {
    const response = await routes.get('/api/weir-edit-lock/maintenance/status').fetch()
    const report = await response.json()
    assert.deepEqual(report.value.domains[0].bindings, rows())
    assert.doesNotMatch(JSON.stringify(report.value.domains[0].bindings), /private-nonce|snapshot|root|file|action/)
    assert.deepEqual(await readFile(image), before)
    assert.equal(disconnects, 0)
  } finally { unregister(); publisher.dispose() }
  assert.deepEqual(rows(), [])
})

test('failed EOF disconnect keeps its mapping for later retry', async () => {
  let calls = 0
  const arbitration = createChannelBindingArbitration()
  const socket = { destroyed: true }
  await arbitration.open('s', socket, async () => ({ peer: { async disconnect() { if (++calls === 1) throw Error('durable failure') } } }))
  await arbitration.release('s', socket)
  assert.equal(arbitration.bindings().length, 1)
  await arbitration.open('s', { destroyed: false }, async () => ({ peer: { async disconnect() {} } }))
  assert.equal(calls, 2)
})
