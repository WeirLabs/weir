// Supervised group coordinator: registry state machine for grouped delegation.
// Pure logic (no DSH imports) — the mount layer (index.js/tool.js) feeds it
// session events and injects the effectors (sendMessage/interrupt/timers).

export const SUPERVISION_CONTRACT = `

## Terminal status contract (supervised delegation)

You are a SUPERVISED child. You must end your work with exactly one status report:

STATUS: completed
REPORT: <what you delivered, with evidence>

or

STATUS: blocked
REPORT: <what blocks you, what you tried, what you need>

Rules:
- These are your ONLY verdicts. You may NOT declare the task unnecessary or abandon it — that judgment belongs to your parent.
- Use blocked only for genuine blockers you cannot clear yourself (missing access, failing provider, ambiguous requirements). Your parent can resume you with context, redirect the task with a fresh child, or terminate it.
- Put STATUS on its own line, REPORT: on the next line. Nothing after the report matters.`

export const DEFAULT_SUPERVISION = {
  maxRetries: 5,
  initialBackoffMs: 30_000,
  maxBackoffMs: 300_000,
}

/** Parse a child's final assistant text into a terminal status, or null. */
export function parseTerminalStatus(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const match = /^STATUS:[ \t]*(completed|blocked)[ \t]*$/m.exec(text)
  if (!match) return null
  const reportMatch = /^REPORT:[ \t]*([\s\S]*)$/m.exec(text.slice(match.index))
  return { status: match[1], report: (reportMatch?.[1] ?? '').trim() }
}

/**
 * Create the coordinator for one parent agent's supervised delegations.
 * Effectors are injected so the state machine stays testable:
 * @param {object} deps
 * @param {(childId: string, text: string) => Promise<void>} deps.sendTo - deliver a user message to a child (sendMessage)
 * @param {(childId: string) => void} deps.interruptChild - interrupt a running child
 * @param {(delayMs: number, fn: () => void) => void} deps.schedule - delayed retry scheduler
 * @param {(reason: string) => void} [deps.onAudit]
 */
export function createGroupCoordinator(deps, config = {}) {
  const cfg = { ...DEFAULT_SUPERVISION, ...config }
  /** @type {Map<string, { id: string, name: string, group: string, status: string, report: string, retries: number, lastText: string }>} */
  const children = new Map()
  /** @type {Map<string, { name: string, memberIds: string[], settled: boolean }>} */
  const groups = new Map()
  /** Outbound notices for the parent, flushed at turn boundaries. */
  const outbox = []

  function groupLive(name) {
    const group = groups.get(name)
    return group !== undefined && !group.settled
  }

  /**
   * Call-level gate: a group name must be free before its batch is assigned.
   * A settled group's name is reusable (a new group, not an insertion).
   */
  function assertGroupAvailable(name) {
    if (groupLive(name)) {
      throw new Error(`delegate: group "${name}" is already live and does not accept insertion`)
    }
  }

  /** Register one freshly spawned supervised member (call-level gate did the check). */
  function registerMember({ id, name, group }) {
    children.set(id, { id, name, group, status: 'running', report: '', retries: 0, lastText: '' })
    let entry = groups.get(group)
    if (!entry) {
      entry = { name: group, memberIds: [], settled: false }
      groups.set(group, entry)
    }
    entry.memberIds.push(id)
    return entry
  }

  /** Seal a group after its batch is fully registered. */
  function sealGroup(name) {
    const entry = groups.get(name)
    if (entry) entry.sealed = true
  }

  function memberByRef(ref) {
    if (children.has(ref)) return children.get(ref)
    for (const child of children.values()) {
      if (child.name === ref) return child
    }
    return undefined
  }

  function noteAssistantText(childId, text) {
    const child = children.get(childId)
    if (child && typeof text === 'string' && text.length > 0) child.lastText = text
  }

  function settle(child, status, report) {
    child.status = status
    child.report = report
    if (status === 'blocked') {
      outbox.push(renderBlockedNotice(child))
    }
    checkGroupCompletion(child.group)
  }

  function checkGroupCompletion(groupName) {
    const entry = groups.get(groupName)
    if (!entry || entry.settled || !entry.sealed) return
    const allSettled = entry.memberIds.every((id) => {
      const status = children.get(id)?.status
      return status === 'completed' || status === 'terminated'
    })
    if (!allSettled) return
    entry.settled = true
    outbox.push(renderGroupReport(entry, children))
  }

  /**
   * Classify a supervised child's turn end and act (nudge / backoff / settle).
   * @returns {Promise<'settled' | 'nudged' | 'retry-scheduled' | 'ignored'>}
   */
  async function onTurnEnd(childId, reason) {
    const child = children.get(childId)
    if (!child || child.status === 'completed' || child.status === 'terminated') return 'ignored'

    const kind = reason?.kind
    if (kind === 'completed') {
      const terminal = parseTerminalStatus(child.lastText)
      if (terminal) {
        settle(child, terminal.status, terminal.report)
        return 'settled'
      }
      if (child.retries >= cfg.maxRetries) {
        settle(child, 'blocked', `Supervised continuation exhausted: the child ended ${cfg.maxRetries} time(s) without a STATUS report.`)
        deps.onAudit?.(`child ${child.name}: continuation exhausted (no status)`)
        return 'settled'
      }
      child.retries += 1
      await deps.sendTo(childId, NUDGE_MESSAGE)
      return 'nudged'
    }

    if (kind === 'error') {
      if (child.retries >= cfg.maxRetries) {
        settle(child, 'blocked', `Supervised continuation exhausted: ${cfg.maxRetries} consecutive provider-error retries failed (${reason?.error?.message ?? 'unknown error'}).`)
        deps.onAudit?.(`child ${child.name}: continuation exhausted (provider errors)`)
        return 'settled'
      }
      child.retries += 1
      const delay = Math.min(cfg.initialBackoffMs * 2 ** (child.retries - 1), cfg.maxBackoffMs)
      scheduleRetry(childId, delay)
      return 'retry-scheduled'
    }

    if (kind === 'aborted') {
      const cause = reason?.reason?.kind
      if (cause === 'user') {
        // A user interruption is intentional: never auto-continue.
        settle(child, 'blocked', 'Interrupted by the user before a terminal status was reported.')
        return 'settled'
      }
      settle(child, 'terminated', `Aborted (${cause ?? 'unknown cause'}) before a terminal status was reported.`)
      return 'settled'
    }

    // max-tokens / interrupted / blocked / forked: treat as needs-nudge.
    if (child.retries >= cfg.maxRetries) {
      settle(child, 'blocked', `Supervised continuation exhausted after turn end '${kind}'.`)
      return 'settled'
    }
    child.retries += 1
    await deps.sendTo(childId, NUDGE_MESSAGE)
    return 'nudged'
  }

  function scheduleRetry(childId, delay) {
    deps.onAudit?.(`child ${children.get(childId)?.name}: retry in ${delay}ms`)
    deps.schedule(delay, () => {
      void deps.sendTo(childId, RETRY_MESSAGE)
    })
  }

  /** resume_agent: blocked → running with resume context. */
  async function resume(ref, context) {
    const child = memberByRef(ref)
    if (!child) throw new Error(`resume_agent: no supervised child named "${ref}"`)
    if (child.status !== 'blocked') {
      throw new Error(`resume_agent: child "${child.name}" is ${child.status}, not blocked`)
    }
    child.retries = 0
    child.status = 'running'
    await deps.sendTo(child.id, renderResumeMessage(context))
    return { id: child.id, name: child.name, status: child.status }
  }

  /** terminate_agent: running → interrupt + terminated; else bookkeeping. */
  function terminate(ref, reason) {
    const child = memberByRef(ref)
    if (!child) throw new Error(`terminate_agent: no supervised child named "${ref}"`)
    if (child.status === 'terminated') return { id: child.id, name: child.name, status: child.status, interrupted: false }
    const wasRunning = child.status === 'running'
    if (wasRunning) deps.interruptChild(child.id)
    child.status = 'terminated'
    child.report = reason ?? (wasRunning ? 'Terminated by the main agent.' : 'Terminated by the main agent (state bookkeeping).')
    checkGroupCompletion(child.group)
    return { id: child.id, name: child.name, status: child.status, interrupted: wasRunning }
  }

  /** Drain queued parent notices (turn-boundary flush). */
  function drainOutbox() {
    return outbox.splice(0, outbox.length)
  }

  return {
    registerMember,
    assertGroupAvailable,
    sealGroup,
    noteAssistantText,
    onTurnEnd,
    resume,
    terminate,
    drainOutbox,
    memberByRef,
    groupLive,
    _children: children,
    _groups: groups,
  }
}

const NUDGE_MESSAGE = `You ended without the required status report. Reply now with exactly:
STATUS: completed
REPORT: <what you delivered>
or
STATUS: blocked
REPORT: <what blocks you>`

const RETRY_MESSAGE = `Your previous turn ended on a provider error. Continue the task now, and remember to end with exactly:
STATUS: completed
REPORT: <what you delivered>
or
STATUS: blocked
REPORT: <what blocks you>`

function renderResumeMessage(context) {
  return `Your parent cleared your blocker. Resume the task with this context:

<resume_context>
${context}
</resume_context>

Continue the work, then end with exactly:
STATUS: completed
REPORT: <what you delivered>
or
STATUS: blocked
REPORT: <what blocks you>`
}

function renderBlockedNotice(child) {
  return `<supervised_blocked child="${child.name}" id="${child.id}">
STATUS: blocked
REPORT:
${child.report || '(no report body)'}

You may resume this child with resume_agent (attach unblocking context), or terminate it with terminate_agent.
</supervised_blocked>`
}

function renderGroupReport(group, children) {
  const lines = group.memberIds.map((id, index) => {
    const child = children.get(id)
    const status = child?.status ?? 'unknown'
    const report = child?.report?.trim() || '(no report)'
    return `## ${index + 1}. ${child?.name ?? id} — ${status}\n\n${report}`
  })
  return `<supervised_group_report group="${group.name}" members="${group.memberIds.length}">
All members of this group reached a terminal state. Merged report:

${lines.join('\n\n')}
</supervised_group_report>`
}
