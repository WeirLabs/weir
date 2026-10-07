// Supervision mount: one group coordinator per parent session, the six
// effectors binding the coordinator to ctx.subagents/audit, the session/event
// feed with the settlement-notice ordering gate, and the settings-commit push
// into live coordinators. This module is a ctx adapter — per the jsconfig
// purity curation it stays out of include (same precedent as index.js and
// group-coordinator.js).
import { createGroupCoordinator, isTerminalStatus } from './group-coordinator.js'
import { rehydrateSupervision, applyChildLogRecovery } from './rehydrate.js'
import { auditFilePathOf, readAuditTail, readChildFinalText } from './audit-readers.js'
import { AUDIT_TYPES } from '../shared/audit.js'
import { userTextMessage } from '../shared/user-message.js'
import { contentText } from '../shared/content-text.js'

/**
 * Mount the supervision subsystem on the plugin ctx.
 * @param {object} deps
 * @param {any} deps.ctx - plugin context (on / subagents / get / logger)
 * @param {any} deps.audit - createAudit(ctx) sink: (session, type, payload) => void
 * @param {any} deps.settings - weirSettings service handle (absent = no commit push)
 * @param {() => object} deps.supervisionNow - overlay getter for supervision tuning
 * @param {(childId: string, parent: object) => void} [deps.onChildSettled] - a member reached a terminal fact (worktree lane settlement)
 * @returns {{ coordinatorFor: (parent: object) => Promise<object>, dispose: () => void }}
 */
export function mountSupervision({ ctx, audit, settings, supervisionNow, onChildSettled }) {
  // Supervised group coordinators, one per parent session.
  /** @type {Map<string, { coordinator: object, parent: object }>} */
  const coordinators = new Map()
  async function coordinatorFor(parent) {
    let entry = coordinators.get(parent.id)
    if (!entry) {
      const coordinator = createGroupCoordinator(
        {
          sendTo: async (childId, text) => {
            await ctx.subagents.sendMessage(parent, childId, [{ type: 'text', text }], { signal: new AbortController().signal })
          },
          interruptChild: (childId) => {
            ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: parent })
          },
          schedule: (delayMs, fn) => {
            const timer = setTimeout(fn, delayMs)
            timer.unref?.()
          },
          onAudit: (note) => {
            audit(parent.session, AUDIT_TYPES.supervision, { note })
          },
          onFact: (fact) => {
            audit(parent.session, `${AUDIT_TYPES.supervision}/${fact.kind}`, fact)
            // A settled or terminated member frees its worktree lane (the host
            // checks the lane) — TERMINAL outcomes only (resumable-lane-workers
            // D1): a blocked member stands by for resume_agent, so its binding
            // must survive; the blocked fact still rides the audit channel.
            // Deferred: never run lane work inside the fact.
            const settlesLane = fact.kind === 'terminate' || (fact.kind === 'settle' && isTerminalStatus(fact.status))
            if (settlesLane && onChildSettled) {
              void Promise.resolve().then(() => onChildSettled(fact.childId, parent))
            }
          },
          notifyParent: (text) => {
            // Reliable parent-facing delivery: timer-deferred, mirroring the
            // built-in settlement channel (sendWaking): steer into the current
            // turn when the parent is busy so the signal lands right after the
            // last member's settlement notice; followup wake when idle. Bounded
            // retry; the final failure is audited.
            const message = userTextMessage(text, 'weir-delegate')
            const deliver = (attempt) => {
              const delay = attempt === 1 ? 0 : 200 * (attempt - 1)
              const timer = setTimeout(() => {
                let outcome
                try {
                  outcome = parent.status === 'idle' ? parent.followup(message) : parent.steer(message)
                } catch (error) {
                  outcome = Promise.reject(error)
                }
                Promise.resolve(outcome).catch((error) => {
                  ctx.logger?.warn?.(`weir-delegate: group-settled signal delivery (attempt ${attempt}) failed: ${error?.message ?? error}`)
                  if (attempt < 3) deliver(attempt + 1)
                  else audit(parent.session, AUDIT_TYPES.supervision, { note: `group-settled signal delivery failed after ${attempt} attempts: ${String(error?.message ?? error)}` })
                })
              }, delay)
              timer.unref?.() // never hold the process for a pending signal delivery
            }
            deliver(1)
          },
        },
        supervisionNow(),
      )
      // Restart rebuild: replay durable facts, cross-check the DSH catalog.
      const state = await rehydrateForParent(parent)
      coordinator.hydrate(state)
      entry = { coordinator, parent }
      coordinators.set(parent.id, entry)
    }
    return entry.coordinator
  }

  /** Best-effort rehydration inputs for one parent: audit tail + catalog. */
  async function rehydrateForParent(parent) {
    const records = readAuditTail(auditFilePathOf(parent.session))
    let catalogChildren = []
    try {
      catalogChildren = await ctx.subagents.listChildren(parent.id) ?? []
    } catch {
      // catalog unavailable: partial-confidence rebuild still proceeds
    }
    const state = rehydrateSupervision({ parentId: parent.id, records, catalogChildren })
    const sessionQuery = ctx.get?.('sessionQuery')
    if (sessionQuery?.readSession) {
      return applyChildLogRecovery(state, (childId) => readChildFinalText(sessionQuery, childId))
    }
    return state
  }

  /** Find the entry owning a given child session id (event filter). */
  function entryOfChild(sessionId) {
    for (const entry of coordinators.values()) {
      if (entry.coordinator.ownsChild(sessionId)) return entry
    }
    return undefined
  }

  // Supervision feed: child assistant text + turn ends drive the state machine;
  // the parent's own log feeds the settlement-notice ordering gate. Parent-facing
  // signals are delivered through the coordinator's notifyParent effector
  // (timer-deferred dispatch), never synchronously from inside event dispatch.
  ctx.on('session/event', (session, event) => {
    const parentEntry = coordinators.get(session.id)
    if (parentEntry) {
      // Strict ordering: the group-settled signal must follow every member's
      // built-in settlement notice, so observe them as they land in the parent log.
      if (event?.type === 'user/message' && event.data?.source?.kind === 'subagent-settled') {
        const senderId = event.data?.source?.senderSessionId
        if (typeof senderId === 'string' && senderId.length > 0) {
          parentEntry.coordinator.noteSettlementNotice(senderId)
        }
      }
      return
    }
    const entry = entryOfChild(session.id)
    if (!entry) return
    if (event?.type === 'assistant/message') {
      const text = contentText(event.data?.message?.content)
      entry.coordinator.noteAssistantText(session.id, text)
      return
    }
    if (event?.type === 'turn/end') {
      void driveTurnEnd(entry, session.id, event.data?.reason)
    }
  })

  async function driveTurnEnd(entry, childId, reason) {
    try {
      await entry.coordinator.onTurnEnd(childId, reason)
    } catch (error) {
      audit(entry.parent.session, AUDIT_TYPES.supervision, { note: `turn-end processing failed for child ${childId}: ${String(error?.message ?? error)}` })
    }
  }

  // Volatile settings commits: read-time resolution already covers every new
  // delegation, but a coordinator is long-lived (one per parent session), so its
  // supervision parameters must be pushed into the live instances too. Mirrors
  // src/lsp/index.js: the same broadcast that re-registers the LSP surface
  // refreshes the supervision tuning here.
  const offSettings = settings?.onChange?.(() => {
    const supervision = supervisionNow()
    for (const entry of coordinators.values()) entry.coordinator.setSupervision?.(supervision)
  })

  const dispose = () => {
    offSettings?.()
  }

  return { coordinatorFor, dispose }
}
