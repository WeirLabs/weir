// Dev-only two-incarnation probe. Deliberately retain the first client's socket
// across real AgentFactory dispose/resume; never install in a production profile.
import { randomUUID } from 'node:crypto'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { openEditLockRuntime } from '../../weir-harness/src/edit-lock/runtime.js'
import { createEditLockLifecycle } from '../../weir-harness/src/edit-lock/lifecycle.js'
import { createRemoteEditLockDomain, endpointFor, serveEditLockEndpoint } from '../../weir-harness/src/edit-lock/remote.js'
import { createBindingAttester, registerBindingRuntime } from '../../weir-harness/src/edit-lock/binding-attestation.js'

export function installBindingProbe(ctx, tap) {
  if (process.env.WEIR_IT_BINDING_PROBE !== '1') return
  ctx.tools.register({
    name: 'edit_lock_binding_probe',
    description: 'Run the isolated two-incarnation Edit Lock regression and report runtime identity evidence.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: JSON.stringify(value) }] },
    async execute(_args, exec) {
      const id = randomUUID()
      const root = exec.agent.session.header.cwd
      const directory = join(root, '.weir', `binding-probe-${id}`)
      await mkdir(directory, { recursive: true })
      const runtime = await openEditLockRuntime({ root, directory, domainId: id, mode: 'create', fs: ctx.fs, assertExclusive() {} })
      const lifecycle = createEditLockLifecycle(runtime, agent => agent.id)
      const endpoint = endpointFor(directory)
      const server = await serveEditLockEndpoint(lifecycle, endpoint, new WeakMap(), createBindingAttester(id => ctx.agents.get(id)))
      const remote = createRemoteEditLockDomain(endpoint, { onNotice() {}, onChannelOpen: registerBindingRuntime })
      let first, second, firstSetup, secondSetup
      const report = { kind: 'binding-probe', session: id }
      let creations = 0
      const offCreated = ctx.on('agent/created', ({ agent }) => {
        if (agent.id !== id) return
        report[++creations === 1 ? 'firstCreatedRegistryIsAgent' : 'secondCreatedRegistryIsAgent'] = ctx.agents.get(id) === agent
      })
      try {
        first = await ctx.agents.create({ sessionId: id, meta: { cwd: root }, setup(_ctx, agent) { firstSetup = agent } })
        report.firstRegistryIsHandle = ctx.agents.get(id) === first.agent
        report.firstRegistryIsSetup = ctx.agents.get(id) === firstSetup
        await remote.channelFor(first.agent)
        const held = await remote.call(first.agent, 'acquire', { filePath: 'fixture.txt', cwd: root })
        try { await remote.channelFor({ id }); report.servingRefused = false }
        catch (error) { report.servingRefused = /session already bound/.test(String(error?.message)) }
        // This domain is intentionally not attached to the agent's disposal.
        await first.dispose()
        report.registryAbsentAfterDispose = ctx.agents.get(id) === undefined
        second = await ctx.agents.resume({ resumeSessionId: id, setup(_ctx, agent) { secondSetup = agent } })
        report.distinctIncarnations = first.agent !== second.agent
        report.secondRegistryIsHandle = ctx.agents.get(id) === second.agent
        report.secondRegistryIsSetup = ctx.agents.get(id) === secondSetup
        report.registryStillFirst = ctx.agents.get(id) === first.agent
        try {
          report.secondState = (await remote.channelFor(second.agent)).state
          report.healed = true
          const locks = await remote.call(second.agent, 'allLocks')
          report.locksRetained = locks.some(lock => lock.owner === id && lock.generation === held.generation)
          await remote.call(second.agent, 'resume', { requestId: randomUUID() })
          const filePath = join(root, `binding-restored-${id}.txt`)
          await remote.call(second.agent, 'publish', { tool: 'write', filePath, args: {}, content: 'restored\n', expected: { kind: 'createIfAbsent' }, cwd: root, effectivePolicy: { mode: 'workspace-write', workspaceRoot: root } })
          report.editingRestored = await readFile(filePath, 'utf8') === 'restored\n'
        } catch (error) {
          report.healed = false
          report.refusal = String(error?.message ?? error)
        }
      } catch (error) { report.error = String(error?.stack ?? error) }
      finally {
        offCreated()
        remote.close()
        await second?.dispose()
        await first?.dispose()
        await server.close()
        await lifecycle.close()
      }
      tap(report)
      return report
    },
  })
}
