// Dev-only installed-host probe. Preserve the real filesystem implementation;
// its documented internals hooks gate real staging/publication, not mock results.
import { link } from 'node:fs/promises'
import { basename } from 'node:path'

export function installStopProbe(ctx, tap) {
  const mode = process.env.ORRERY_IT_STOP_BOUNDARY
  if (!mode) return
  let parent
  let child
  let signal
  let stopped = false
  const stop = async (boundary) => {
    if (stopped) throw new Error('stop probe entered twice')
    stopped = true
    tap({ kind: 'stop-probe', boundary, parent: parent.id, child: child.id,
      parentStatus: parent.status, childStatus: child.status, abortedBefore: signal.aborted })
    parent.cancel({ kind: 'user' }, { keepInbox: true })
    tap({ kind: 'stop-cascade', aborted: signal.aborted })
    // Release the gate only after synchronous cancellation propagation. Never
    // await whenIdle here: the real agent joins this outstanding filesystem call.
    await Promise.resolve()
  }
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.origin === 'subagent') child = agent
    else parent ??= agent
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'write' && exec.agent === child) {
      signal = exec.signal
      if (mode === 'predispatch') await stop('tools/pre-execute')
    }
    return next()
  })
  const internals = ctx.fs.internals
  if (!internals) throw new Error('installed filesystem lacks atomic publication hooks')
  const old = { ...internals }
  internals.inspectTemp = async (paths) => {
    await old.inspectTemp?.(paths)
    if (signal && mode === 'staged' && basename(paths.tempPath).startsWith('stop-')) await stop('staged-before-final-abort-check')
  }
  internals.linkFile = async (source, target) => {
    if (signal && basename(target).startsWith('stop-') && mode === 'publication') await stop('after-final-abort-check-before-link')
    return (old.linkFile ?? link)(source, target)
  }
  // No cleanup until writeText and both turns have settled; the driver waits
  // for normal headless exit. Do not delete reservations or synthesize outcomes.
  ctx.on('session/event', (session, event) => {
    if (event.type === 'turn/end') tap({ kind: 'stop-turn-end', session: session.id, reason: event.data.reason })
  })
  ctx.on('dispose', () => {
    for (const key of ['inspectTemp', 'linkFile']) {
      if (old[key]) internals[key] = old[key]
      else delete internals[key]
    }
  })
}
