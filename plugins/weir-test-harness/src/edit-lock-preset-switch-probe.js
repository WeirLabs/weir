// Dev-only integration probe (editlock-preset-switch scenario; openspec
// edit-lock-shared-domain-mounts, task 4.1). Composes TWO Edit-Lock preset
// revisions in one headless process — the single-process shape of the
// weir ↔ weir-creative incident — and drives the blank-window switch flow
// through one agent: created under preset A, switched to preset B, switched
// back to A, with a managed write at every stage. Every fact the scenario
// asserts on is written to <ws>/editlock-preset-switch.json.
//
// Harness boundary, stated honestly: headless has no Web session creator, so
// the switch is driven through the registry's own select() (the same API the
// Web session creator calls) and writes are driven through ctx.tools.execute
// with the probe agent (the negotiation scenario's established fidelity for
// direct tool executions). Both presets pin one FIXED authority inside the IT
// sandbox: per-root discovery from the sandbox would escape to an enclosing
// real authority, and identical fixed configs are exactly what the shared
// registry's discriminator requires for sharing (production presets carry no
// fixed config, which is the identical-discriminator case by construction).
import { randomUUID } from 'node:crypto'
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const name = 'weir-it-edit-lock-preset-switch-probe'
export const inject = ['agentPresets', 'agents', 'tools']

const PRESET_A = 'weir-it-lock-a'
const PRESET_B = 'weir-it-lock-b'

/** One Edit-Lock preset revision: the provider row alone inside its isolate
 * realm (S24: preset services require isolate realms), pinning the shared
 * fixed authority. Identical configs on both revisions = the sharing case. */
function presetPlugins(id, authorityRoot, authorityDir) {
  return [{
    id: `editing-${id}`,
    name: 'cordis:group',
    group: true,
    isolate: { weirEditLock: true },
    config: [{
      id: `edit-lock-${id}`,
      name: 'weir-harness/edit-lock',
      config: { enabled: true, root: authorityRoot, authorityDirectory: authorityDir },
    }],
  }]
}

/** Bounded poll until the predicate holds (domain start is async). */
async function until(predicate, label) {
  for (let i = 0; i < 200; i++) {
    let value
    try { value = predicate() } catch { value = undefined }
    if (value) return value
    await new Promise(resolve => setTimeout(resolve, 50))
  }
  throw new Error(`probe timed out waiting for: ${label}`)
}

export function apply(ctx, config = {}) {
  if (config.enabled !== true) return
  const itRoot = process.env.WEIR_IT_ROOT
  const trace = process.env.WEIR_IT_TRACE
  if (!itRoot || !trace) return
  const ws = join(itRoot, 'ws')
  // The fixed management root is the workspace itself (the editlock scenario
  // family's shape): write targets under ws stay inside the managed domain;
  // the authority owns a private directory below it.
  const authorityRoot = ws
  const authorityDir = join(ws, '.weir', 'edit-lock-preset-switch')
  mkdirSync(authorityDir, { recursive: true })
  const files = [join(ws, 'preset-switch-1.txt'), join(ws, 'preset-switch-2.txt'), join(ws, 'preset-switch-3.txt')]

  const fact = record => { try { appendFileSync(trace, JSON.stringify(record) + '\n') } catch { /* best effort */ } }
  const snapshot = () => {
    const path = join(authorityDir, 'snapshot.json')
    if (!existsSync(path)) return null
    try { return JSON.parse(readFileSync(path, 'utf8'))?.payload?.state ?? null } catch { return null }
  }
  const epochOf = (state, sessionId) => state?.sessions?.find(session => session.sessionId === sessionId)?.executionEpoch ?? null

  let handles = []
  let unregister = []
  ctx.on('dispose', async () => {
    for (const handle of handles.splice(0)) await handle.dispose().catch(() => {})
    for (const undo of unregister.splice(0)) await undo().catch(() => {})
  })

  ctx.tools.register({
    name: 'qa_editlock_preset_switch',
    description: 'QA only: compose two Edit-Lock presets and drive a blank-window preset switch back and forth with a managed write at every stage.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: { type: 'object' }, render: (_args, result) => [{ type: 'text', text: result.message }] },
    timeoutMs: 120000,
    async execute(_args, exec) {
      const report = { completed: false, phases: [] }
      try {
        const registry = ctx.get('agentPresets')
        if (!registry) throw new Error('agent preset registry unavailable')
        const cwd = exec.agent.session.header.cwd
        unregister.push(await registry.register({ id: PRESET_A, plugins: presetPlugins(PRESET_A, authorityRoot, authorityDir) }))
        unregister.push(await registry.register({ id: PRESET_B, plugins: presetPlugins(PRESET_B, authorityRoot, authorityDir) }))
        for (const id of [PRESET_A, PRESET_B]) {
          const resolved = await registry.resolve(id)
          if (resolved.broken) throw new Error(`preset ${id} broken: ${resolved.broken}`)
        }

        // Session created under preset A (blank window: no turn ever runs on it).
        const handle = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd, agentPreset: PRESET_A },
          setup: agentCtx => registry.mount(agentCtx, PRESET_A).then(() => undefined) })
        handles.push(handle)
        const agent = handle.agent
        report.sessionId = agent.id
        const serviceOf = () => { try { return registry.serviceFor(agent, 'weirEditLock') ?? null } catch { return null } }
        const serviceA = await until(() => serviceOf(), 'preset A service resolution')
        await until(() => serviceOf()?.blocksContinuation?.(agent) === false, 'initial binding')
        report.initialServiceIsA = serviceOf() === serviceA

        const phase = async (label, preset, file, content) => {
          if (preset) await registry.select(agent, preset)
          // The unscoped agent-preset/selected dispatch is asynchronous; wait
          // for the standing-mount resolution and the settled binding.
          const service = await until(() => {
            const current = serviceOf()
            return current && current.blocksContinuation(agent) === false ? current : null
          }, `settled binding under ${label}`)
          const before = epochOf(snapshot(), agent.id)
          const write = await ctx.tools.execute({ name: 'write', callId: randomUUID(), arguments: { file_path: file, content }, agent, signal: new AbortController().signal })
          const after = epochOf(snapshot(), agent.id)
          const status = (await service.describe(agent)).status
          const row = {
            label,
            writeAdmitted: write?.isError !== true,
            writeError: write?.isError === true ? String(write.error?.message ?? JSON.stringify(write.error) ?? 'unknown') : null,
            writeResult: (() => { try { return JSON.stringify(write)?.slice(0, 500) ?? null } catch { return null } })(),
            epochBefore: before,
            epochAfter: after,
            state: status.state,
            epoch: status.executionEpoch,
            locks: status.locks.length,
            startupFailure: service.startupFailure(agent),
          }
          report.phases.push(row)
          return service
        }

        await phase('created-under-A', null, files[0], 'one\n')
        const serviceB = await phase('switched-to-B', PRESET_B, files[1], 'two\n')
        // Status read from BOTH mounts after the switch (either mount answers).
        const [fromA, fromB] = await Promise.all([serviceA.describe(agent), serviceB.describe(agent)])
        report.crossRead = {
          serviceSwiched: serviceB !== serviceA,
          modeA: fromA.mode, modeB: fromB.mode,
          stateA: fromA.status.state, stateB: fromB.status.state,
          epochA: fromA.status.executionEpoch, epochB: fromB.status.executionEpoch,
          failureA: serviceA.startupFailure(agent),
          failureB: serviceB.startupFailure(agent),
        }
        await phase('switched-back-to-A', PRESET_A, files[2], 'three\n')
        const [backA, backB] = await Promise.all([serviceA.describe(agent), serviceB.describe(agent)])
        report.crossReadBack = { epochA: backA.status.executionEpoch, epochB: backB.status.executionEpoch, stateA: backA.status.state }

        // In-session Edit Lock failure notices addressed to this session.
        report.failureNotices = agent.session.snapshotEvents()
          .filter(event => event.type === 'user/message' && String(event.data?.source?.kind ?? '').startsWith('weir-edit-lock'))
          .map(event => JSON.stringify(event.data?.content ?? '').slice(0, 200))
        report.completed = true
      } catch (error) {
        report.error = String(error?.stack ?? error)
      }
      writeFileSync(join(ws, 'editlock-preset-switch.json'), JSON.stringify(report, null, 2) + '\n')
      fact({ kind: 'qa-editlock-preset-switch', completed: report.completed, error: report.error ?? null })
      return { message: report.completed ? 'QA_PRESET_SWITCH_FINISHED' : `QA_PRESET_SWITCH_FAILED ${String(report.error).slice(0, 300)}` }
    },
  })
}
