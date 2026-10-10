// Dev-only installed-runtime regression: retain an old remote channel across
// real AgentFactory dispose/resume; the production mount owns the publisher.
import { randomUUID } from 'node:crypto'
import { readFile, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { createRemoteEditLockDomain, endpointFor } from '../../weir-harness/src/edit-lock/remote.js'
import { registerBindingRuntime } from '../../weir-harness/src/edit-lock/binding-attestation.js'
import { reservationPathFor } from '../../weir-harness/src/edit-lock/reservation.js'
import { parseSnapshot } from '../../weir-harness/src/edit-lock/snapshot.js'

export function installBindingProbe(ctx, tap) {
  if (process.env.WEIR_IT_BINDING_PROBE !== '1') return
  ctx.tools.register({
    name: 'edit_lock_binding_probe',
    description: 'Run the isolated real-runtime remote-to-local binding regression.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(_args, exec) {
      const id = randomUUID(), root = exec.agent.session.header.cwd
      const directory = join(root, '.weir', 'edit-lock')
      const report = { kind: 'binding-probe', session: id }
      const snapshot = async () => parseSnapshot(await readFile(join(directory, 'snapshot.json')), root).state
      const reservation = reservationPathFor(directory)
      const reservationBefore = await lstat(reservation)
      const ownerBefore = JSON.parse(await readFile(join(reservation, 'owner.json'), 'utf8'))
      const before = await snapshot()
      let nonce, unregister = () => {}, first, second, firstSetup, secondSetup
      // Initially unknown. Supply trusted stale identity later without closing
      // the old socket: this isolates binding evidence from transport timing.
      const remote = createRemoteEditLockDomain(endpointFor(directory), {
        onNotice() {}, onChannelOpen(token) { nonce = token; return () => unregister() },
      })
      const commands = ctx.get('commands')
      const command = (agent, verb) => commands.execute(agent, `/edit-lock ${verb}`, [], new AbortController().signal)
      const tool = (agent, name, args = {}) => ctx.tools.get(name, agent).execute(args, {
        agent, signal: new AbortController().signal, callId: randomUUID(), deferContext() {},
      })
      let creations = 0
      const offCreated = ctx.on('agent/created', ({ agent }) => {
        if (agent.id !== id) return
        report[++creations === 1 ? 'firstCreatedRegistryIsAgent' : 'secondCreatedRegistryIsAgent'] = ctx.agents.get(id) === agent
      })
      try {
        first = await ctx.agents.create({ sessionId: id, meta: { cwd: root }, async setup(_ctx, agent) {
          firstSetup = agent
          await remote.channelFor(agent)
          await remote.call(agent, 'acquire', { filePath: 'fixture.txt', cwd: root })
        } })
        report.firstRegistryIsHandle = ctx.agents.get(id) === first.agent
        report.firstRegistryIsSetup = ctx.agents.get(id) === firstSetup
        const original = (await snapshot()).locks.find(lock => lock.owner === id)
        report.initialRefused = (await command(first.agent, 'retry'))?.result?.kind === 'error'
        await first.dispose()
        report.registryAbsentAfterDispose = ctx.agents.get(id) === undefined
        second = await ctx.agents.resume({ resumeSessionId: id, setup(_ctx, agent) { secondSetup = agent } })
        report.distinctIncarnations = first.agent !== second.agent
        report.secondRegistryIsHandle = ctx.agents.get(id) === second.agent
        report.secondRegistryIsSetup = ctx.agents.get(id) === secondSetup
        report.registryStillFirst = ctx.agents.get(id) === first.agent
        const unavailable = await tool(second.agent, 'edit_lock_status')
        report.readOnlyFailure = unavailable.state === 'unavailable' && unavailable.bindingFailure?.retryable === true && unavailable.locks === undefined
        const writer = ctx.tools.get('write', second.agent).execute
        report.unknownRefused = (await command(second.agent, 'retry'))?.result?.kind === 'error'
        unregister = registerBindingRuntime(nonce, second.agent, id)
        report.servingRefused = (await command(second.agent, 'retry'))?.result?.kind === 'error'
        unregister()
        unregister = registerBindingRuntime(nonce, first.agent, id)
        const retry = await command(second.agent, 'retry')
        report.healed = retry?.result?.kind === 'success'
        report.retryResult = retry?.result
        report.writerUnchanged = ctx.tools.get('write', second.agent).execute === writer
        const rebound = await snapshot()
        const retained = rebound.locks.find(lock => lock.owner === id)
        report.secondState = rebound.sessions.find(session => session.sessionId === id)?.interrupted ? 'interrupted' : 'active'
        report.locksRetained = retained?.generation === original.generation && retained?.resourceId === original.resourceId
        report.managerUnchanged = rebound.managerIncarnation === before.managerIncarnation
        const reservationAfter = await lstat(reservation)
        const ownerAfter = JSON.parse(await readFile(join(reservation, 'owner.json'), 'utf8'))
        report.reservationUnchanged = reservationBefore.ino === reservationAfter.ino && reservationBefore.dev === reservationAfter.dev && typeof ownerBefore.ownerToken === 'string' && ownerBefore.ownerToken === ownerAfter.ownerToken
        report.failureCleared = (await tool(second.agent, 'edit_lock_status')).state !== 'unavailable'
        const filePath = join(root, `binding-restored-${id}.txt`)
        try { await tool(second.agent, 'write', { file_path: filePath, content: 'must not publish' }); report.retryDidNotResume = false }
        catch { report.retryDidNotResume = true }
        remote.drop(first.agent) // late EOF must not erase the local successor
        report.continued = (await command(second.agent, 'resume'))?.result?.kind === 'success'
        await command(second.agent, 'confirm --all')
        await tool(second.agent, 'write', { file_path: filePath, content: 'restored\n' })
        report.editingRestored = await readFile(filePath, 'utf8') === 'restored\n'
        report.otherSessionUsable = Array.isArray((await tool(exec.agent, 'edit_lock_status')).locks)
      } catch (error) { report.error = String(error?.stack ?? error) }
      finally { offCreated(); remote.close(); unregister(); await second?.dispose(); await first?.dispose() }
      tap(report)
      return report
    },
  })
}
