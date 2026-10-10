// Dev-only outer owner keeps headless alive without extending the tested parent turn.
import { randomUUID } from 'node:crypto'
import { textOf } from '../message-text.js'

export function installJobsAwareTodoProbe(ctx, tap) {
  if (process.env.WEIR_IT_JOBS_AWARE_TODO !== '1') return
  ctx.tools.register({
    name: 'jobs_aware_todo_probe', description: 'Observe the tested parent stop before draining its real background job.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    async execute(_args, exec) {
      const sessionId = `session-${randomUUID()}`
      const jobs = ctx.get('jobs')
      let handle
      const inbox = []
      const offInbox = ctx.on('agent/inbox/inserted', ({ agent, message }) => {
        if (agent.id === sessionId) inbox.push(textOf(message))
      })
      const offJobs = jobs.events.subscribe({ owner: sessionId }, (event) => {
        if (event.type === 'settled') tap({ kind: 'jobs-aware-settlement', session: sessionId, job: event.job, cause: event.cause, awaited: event.awaited })
      })
      const snapshot = () => {
        const events = handle.agent.session.snapshotEvents()
        const end = events.filter((e) => e.type === 'turn/end').at(-1)
        const todos = events.filter((e) => e.type === 'todo/write').at(-1)?.data?.todos ?? []
        return {
          completed: end?.data?.reason?.kind === 'completed', endSeq: end?.seq,
          todoPending: todos.some((todo) => todo.status === 'pending'),
          noContinuation: !events.some((e) => e.type === 'user/message' && textOf(e.data).includes('<todo_continuation>')),
          noInboxContinuation: !inbox.some((text) => text.includes('<todo_continuation>')),
        }
      }
      try {
        handle = await ctx.agents.create({ sessionId, parentAgent: exec.agent,
          meta: { cwd: exec.agent.session.header.cwd }, agentOptions: { provider: 'mock', model: 'mock-1' } })
        tap({ kind: 'jobs-aware-subject', session: sessionId })
        handle.agent.followup({ id: randomUUID(), role: 'user', source: { kind: 'user' }, content: [{ type: 'text', text: 'jobs-aware-todo-probe' }] })
        await handle.agent.whenIdle()
        const owned = jobs.list(sessionId).filter((job) => job.owner === sessionId && job.kind === 'subagent')
        if (owned.length !== 1) throw new Error(`Expected exactly one owned subagent job, got ${owned.length}`)
        // Read the native durable facts BEFORE looking up the live job, then wait
        // immediately; the tested parent never waits or runs an extra model turn.
        const before = snapshot()
        const job = jobs.get(owned[0].id, sessionId)
        tap({ kind: 'jobs-aware-before-wait', session: sessionId, ...before, job })
        const result = await jobs.wait(job.id, 15000, sessionId, exec.signal)
        tap({ kind: 'jobs-aware-after-wait', session: sessionId, ...snapshot(), job: result })
        if (!before.completed || !before.todoPending || !before.noContinuation || !before.noInboxContinuation || job.status !== 'running') {
          throw new Error('Parent did not stop with pending todo and no continuation while its job was running')
        }
        if (result.status !== 'completed') throw new Error(`Background job did not complete: ${result.status}`)
        const after = snapshot()
        if (!after.noContinuation || !after.noInboxContinuation) throw new Error('Continuation appeared while the outer owner drained the job')
        return { text: 'jobs-aware-owner-finished' }
      } catch (error) {
        tap({ kind: 'jobs-aware-probe-error', session: sessionId, message: String(error) })
        return { text: 'jobs-aware-owner-failed' }
      } finally {
        offInbox?.(); offJobs?.()
        await handle?.dispose()
      }
    },
  })
}
