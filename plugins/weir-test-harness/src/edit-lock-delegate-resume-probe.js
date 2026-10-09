// DEV ONLY: observe a real managed publication, then interrupt only its child.
// No authority mutation, synthetic session event, or child-facing owner tool.
import { appendFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT } from './mock-kit.js'
import { textOf } from './message-text.js'
import { childPrompt, firstContent, target } from './scenarios/editlock-delegate-resume.js'

export const name = 'weir-it-edit-lock-delegate-resume-probe'
export const inject = ['subagents', 'weirEditLock']
export function apply(ctx, config = {}) {
  if (config.enabled !== true || process.env.WEIR_IT_SCENARIO !== 'editlock-delegate-resume') return
  let parent, child, fired = false
  const tap = record => appendFileSync(process.env.WEIR_IT_TRACE, JSON.stringify({ ...record, at: Date.now() }) + '\n')
  const snapshot = () => JSON.parse(readFileSync(join(IT_ROOT, 'ws/.weir/edit-lock/snapshot.json'), 'utf8')).payload.state
  ctx.on('agent/created', ({ agent }) => {
    if (agent.session.header.origin !== 'subagent') parent ??= agent
  })
  ctx.on('agent/inbox/inserted', ({ agent, message }) => {
    if (!child && agent.session.header.origin === 'subagent' && agent.session.header.delegationDepth === 1 && textOf(message).includes(`TASK: ${childPrompt}:`)) child = agent
  })
  ctx.on('tools/result', (exec, result) => {
    // A cold resume replaces the Agent handle, not the durable child session.
    if (!exec.agent || (exec.agent.id !== child?.id && exec.agent !== parent)) return
    tap({ kind: 'resume-tool-result', session: exec.agent.id, name: exec.name, args: exec.arguments, isError: result.isError, text: textOf(result) })
    if (fired || exec.agent !== child || exec.name !== 'write' || result.isError || exec.arguments?.file_path !== target) return
    const before = snapshot()
    const lock = before.locks.find(row => row.resourceId === target)
    const session = before.sessions.find(row => row.sessionId === child.id)
    if (lock?.owner !== child.id || lock.status !== 'active' || session?.interrupted !== false || readFileSync(target, 'utf8') !== firstContent) return
    fired = true
    tap({ kind: 'resume-interrupt-before', session: child.id, parent: parent.id, lock, authoritySession: session, continuationBlocked: ctx.weirEditLock.blocksContinuation(child) })
    // Deliberately synchronous: emit ignores promises, so no awaited observation
    // can allow another child step to race ahead of the user cancellation.
    ctx.subagents.interrupt(child.id, { kind: 'user', parentSessionId: parent.id })
    tap({ kind: 'resume-interrupt-issued', session: child.id, signalAborted: exec.signal.aborted })
  })
  ctx.on('subagent/end', info => {
    if (info.id === child?.id) tap({ kind: 'resume-host-end', ...info })
  })
  ctx.on('agent/disposed', ({ agent }) => {
    if (agent.id === child?.id) tap({ kind: 'resume-agent-disposed', session: agent.id })
  })
  ctx.on('session/event', (session, event) => {
    if (session.id === child?.id && event.type === 'turn/end') tap({ kind: 'resume-child-turn-end', session: session.id, reason: event.data.reason })
  })
}
