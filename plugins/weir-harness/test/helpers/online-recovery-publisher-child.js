// Publisher child for the two-process online administrative recovery probe
// (design D4, openspec edit-lock-autonomous-recovery P3). Opens the authority
// as publisher, serves the peer endpoint, manufactures one interrupted
// owner's unknown publication, then stays alive serving channels. Facts are
// appended as JSON lines to the facts file named in argv.
import { appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { openEditLockRuntime } from '../../src/edit-lock/runtime.js'
import { createEditLockLifecycle } from '../../src/edit-lock/lifecycle.js'
import { serveEditLockEndpoint } from '../../src/edit-lock/remote.js'

const [directory, root, endpoint, facts] = process.argv.slice(2)
const fact = record => appendFileSync(facts, `${JSON.stringify(record)}\n`)
const stubFs = { async resolve() { throw new Error('unused') }, async writeText() { throw new Error('unused') } }
const runtime = await openEditLockRuntime({ directory, root, domainId: root, mode: 'create', fs: stubFs, assertExclusive() {} })
const lifecycle = createEditLockLifecycle(runtime, agent => agent.id, {
  onAdminRecovery: info => fact({ kind: 'audit', trigger: info.trigger, owner: info.record.owner,
    actor: info.record.actor, recoveryId: info.record.recoveryId, revision: info.revision, idempotent: info.idempotent }),
})
await serveEditLockEndpoint(lifecycle, endpoint, new WeakMap())
await runtime.control.openSession('victim')
const status = runtime.control.status()
const execution = { managerIncarnation: status.managerIncarnation, sessionId: 'victim', executionEpoch: 1 }
// The target must arrive in the publisher's canonical (native) spelling:
// `${root}/a.txt` mixes separators on win32 and would miss the generations row.
const target = join(root, 'a.txt')
const token = await runtime.control.acquire(execution, target)
const request = { operationId: 'op-peer', tool: 'write', filePath: target, cwd: root, args: {}, content: 'late',
  effectivePolicy: { mode: 'workspace-write' },
  target: { kind: 'update', resourceId: target, generation: token.generation, policy: { kind: 'replaceIfVersion', version: 'old' } } }
const ready = await runtime.control.prepare(execution, request, {
  validate() {}, publish: async () => { throw new Error('unknown writer outcome') }, identify: () => target,
})
try { await runtime.control.commit(ready.submission) } catch { /* expected: the manufactured unknown */ }
await runtime.control.cancel(execution)
fact({ kind: 'ready' })
