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

/** Bounded wait for the last settlement notice before the fallback delivery. */
export const SIGNAL_FALLBACK_MS = 1000

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
  * @param {(fact: object) => void} [deps.onFact] - structured supervision facts (durability)
  * @param {(text: string) => void} [deps.notifyParent] - deliver a parent-facing signal (timer-deferred followup)
  */
export function createGroupCoordinator(deps, config = {}) {
  const cfg = { ...DEFAULT_SUPERVISION, ...config }
  /** @type {Map<string, { id: string, name: string, group: string, status: string, report: string, retries: number, lastText: string }>} */
  const children = new Map()
  /** @type {Map<string, { name: string, memberIds: string[], settled: boolean }>} */
  const groups = new Map()
  /** Settlement notices observed in the parent log, per member id (ordering gate). */
  const noticesSeen = new Set()
  /** Coordination state (no outbox — parent signals go through deps.notifyParent). */
  let meta

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
    deps.onFact?.({ kind: 'spawn', childId: id, name, group })
    return entry
  }

  /** Seal a group after its batch is fully registered. */
  function sealGroup(name) {
    const entry = groups.get(name)
    if (entry) {
      entry.sealed = true
      deps.onFact?.({ kind: 'seal', group: name, memberIds: [...entry.memberIds] })
    }
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
    deps.onFact?.({ kind: 'settle', childId: child.id, status, report: report ?? '' })
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
    deps.onFact?.({ kind: 'group-settled', group: groupName })
    requestSignal(groupName)
  }

  /**
   * Deliver the group-settled signal only after every member's terminal
   * settlement notice has been observed in the parent log (strict ordering:
   * the signal always follows the last Background notice). A bounded fallback
   * timer keeps the signal from being lost when a notice never arrives (e.g.
   * a bookkeeping-terminated member whose activation already settled).
   */
  function requestSignal(groupName) {
    const entry = groups.get(groupName)
    if (!entry) return
    const allNoticed = entry.memberIds.every((id) => noticesSeen.has(id))
    if (allNoticed) {
      deps.notifyParent?.(renderGroupSettled(groupName, entry.memberIds.length))
      return
    }
    entry.signalPending = true
    deps.schedule(SIGNAL_FALLBACK_MS, () => {
      const current = groups.get(groupName)
      if (current && current.signalPending) {
        current.signalPending = false
        deps.notifyParent?.(renderGroupSettled(groupName, current.memberIds.length))
      }
    })
  }

  /**
   * Observe one built-in settlement notice in the parent log. Only a notice
   * arriving AFTER the child reached its terminal status counts — a resumed
   * or nudged child's earlier notice must not satisfy the ordering gate.
   */
  function noteSettlementNotice(childId) {
    const child = children.get(childId)
    if (!child) return
    if (child.status !== 'completed' && child.status !== 'terminated') return
    noticesSeen.add(childId)
    const entry = groups.get(child.group)
    if (!entry || !entry.settled || !entry.signalPending) return
    if (!entry.memberIds.every((id) => noticesSeen.has(id))) return
    entry.signalPending = false
    deps.notifyParent?.(renderGroupSettled(entry.name, entry.memberIds.length))
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
      try {
        await deps.sendTo(childId, NUDGE_MESSAGE)
      } catch (error) {
        deps.onAudit?.(`child ${child.name}: nudge delivery failed`)
        settle(child, 'blocked', `Nudge delivery failed: ${String(error?.message ?? error)}`)
        return 'settled'
      }
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
    try {
      await deps.sendTo(childId, NUDGE_MESSAGE)
    } catch (error) {
      deps.onAudit?.(`child ${child.name}: nudge delivery failed`)
      settle(child, 'blocked', `Nudge delivery failed: ${String(error?.message ?? error)}`)
      return 'settled'
    }
    return 'nudged'
  }

  function scheduleRetry(childId, delay) {
    deps.onAudit?.(`child ${children.get(childId)?.name}: retry in ${delay}ms`)
    deps.schedule(delay, () =>
      Promise.resolve()
        .then(() => deps.sendTo(childId, RETRY_MESSAGE))
        .catch((error) => {
          const child = children.get(childId)
          deps.onAudit?.(`child ${child?.name}: retry delivery failed`)
          if (child && child.status === 'running') {
            settle(child, 'blocked', `Retry delivery failed: ${String(error?.message ?? error)}`)
          }
        })
    )
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
    deps.onFact?.({ kind: 'resume', childId: child.id })
    try {
      await deps.sendTo(child.id, renderResumeMessage(context))
    } catch (error) {
      child.status = 'blocked'
      deps.onAudit?.(`child ${child.name}: resume delivery failed`)
      throw new Error(`resume_agent: could not deliver resume context to "${child.name}" — ${String(error?.message ?? error)}`)
    }
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
    deps.onFact?.({ kind: 'terminate', childId: child.id, reason: child.report })
    checkGroupCompletion(child.group)
    return { id: child.id, name: child.name, status: child.status, interrupted: wasRunning }
  }

  /**
   * Release a failed-batch group name: unsealed and fully terminated only.
   * A never-registered name (zero members spawned) releases as a no-op.
   */
  function releaseGroup(name) {
    const entry = groups.get(name)
    if (!entry) return
    if (entry.sealed) throw new Error(`delegate: group "${name}" is sealed and cannot be released`)
    const allTerminated = entry.memberIds.every((id) => children.get(id)?.status === 'terminated')
    if (!allTerminated) throw new Error(`delegate: group "${name}" has non-terminated members and cannot be released`)
    groups.delete(name)
    deps.onFact?.({ kind: 'group-released', group: name })
  }

  /**
   * Apply live supervision parameters (volatile settings commit). Unknown keys
   * are ignored by construction: only the three tuning values are copied, so a
   * caller cannot smuggle state into the coordinator through this door. The
   * registry (children/groups) is untouched — a settings edit must never reset
   * supervision state.
   */
  function setSupervision(config = {}) {
    if (config.maxRetries !== undefined) cfg.maxRetries = config.maxRetries
    if (config.initialBackoffMs !== undefined) cfg.initialBackoffMs = config.initialBackoffMs
    if (config.maxBackoffMs !== undefined) cfg.maxBackoffMs = config.maxBackoffMs
  }



  /**
   * Load a rehydrated state snapshot (restart rebuild). Fills the registry,
   * records rehydration meta for the visibility tool, and re-emits one
   * group-settled signal per fully-settled group.
   * @param {{ children: object[], groups: object[], untracked: object[], confidence: string }} state
   */
  function hydrate(state) {
    for (const child of state.children ?? []) {
      if (!children.has(child.id)) {
        children.set(child.id, {
          id: child.id,
          name: child.name ?? child.id,
          group: child.group ?? 'unknown',
          status: child.status ?? 'unknown',
          report: child.report ?? '',
          retries: 0,
          lastText: '',
        })
      }
    }
    for (const group of state.groups ?? []) {
      groups.set(group.name, {
        name: group.name,
        memberIds: [...(group.memberIds ?? [])],
        sealed: group.sealed === true,
        settled: group.settled === true,
      })
    }
    meta = { confidence: state.confidence ?? 'partial', untracked: state.untracked ?? [], hydrated: true }
    for (const group of groups.values()) {
      if (group.sealed && group.settled && group.memberIds.length > 0) {
        deps.notifyParent?.(renderGroupSettled(group.name, group.memberIds.length))
      }
    }
  }

  return {
    registerMember,
    assertGroupAvailable,
    sealGroup,
    noteAssistantText,
    noteSettlementNotice,
    onTurnEnd,
    resume,
    terminate,
    releaseGroup,
    hydrate,
    setSupervision,
    memberByRef,
    groupLive,
    _children: children,
    _groups: groups,
    get meta() {
      return meta
    },
    set meta(value) {
      meta = value
    },
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

/** One-line group-settled signal: member bodies ride the built-in settlement notices. */
function renderGroupSettled(groupName, memberCount) {
  return `<supervised_group_settled group="${groupName}" members="${memberCount}">All ${memberCount} member(s) reached a terminal state.</supervised_group_settled>`
}
