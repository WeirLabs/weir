// Session blackboard subscription delivery (design D3, slice 2): the kernel's
// release events become in-session pushes to the subscribed agents. Cold-safe
// by construction — the cordis audit-channel emission lives in the blackboard
// plugin, this module ONLY builds the message and delivers it through the
// established safe-injection pattern (src/notify/ and the worktree lane
// notices): timer-deferred (never synchronous inside tool execution or event
// dispatch), producer-tagged source so the message is never mistaken for a
// user instruction, bounded retry, and a delivery failure can never reach a
// turn. NEVER session.append (cold-read red line S13).
//
// Three delivery paths, tried in order per subscriber:
//   1. the live agent is busy    → steer into its current turn (no new turn);
//   2. the live agent is idle    → followup (the wake semantics of the
//                                  runtime's built-in settlement channel);
//   3. no live agent (a delegated child between turns — the runtime drops a
//      settled child's agent handle and re-materializes it on the next wake)
//      → subagents.sendMessage through the child's live parent, which wakes
//      the child with the notice.
// A subscriber with none of the three is skipped: the one-shot subscription
// is consumed by the release either way, and the TTL semantics are unchanged.
//
// Pure module — ctx-like faces and timers are injected, so unit tests drive
// every path without a runtime.
import { userTextMessage } from '../shared/user-message.js'

/** The notification source kind (producer tag, never 'user'). */
export const RELEASE_SOURCE_KIND = 'orrery-blackboard'

/** The marker every release notice starts with (integration assertions pin it). */
export const RELEASE_NOTICE_PREFIX = 'Blackboard notice'

/** Delivery attempts before the final failure is logged and dropped. */
export const MAX_DELIVERY_ATTEMPTS = 3

/**
 * The human-readable release clause per reason. Instance content (the key) is
 * embedded verbatim; the template is English.
 * @param {string} key
 * @param {'write'|'delete'|'expire'|'terminate'} reason
 * @returns {string}
 */
export function releaseClause(key, reason) {
  switch (reason) {
    case 'write':
      return `write authority for key "${key}" was released after a write`
    case 'delete':
      return `the blackboard entry "${key}" was deleted`
    case 'expire':
      return `write authority for key "${key}" was released after it expired`
    case 'terminate':
      return `write authority for key "${key}" was released because its holder terminated`
    default:
      return `write authority for key "${key}" was released`
  }
}

/**
 * Compose the in-session release notice for one subscriber. Framed as an
 * automatic notification so it is never mistaken for a user instruction.
 * @param {{ key: string, reason: 'write'|'delete'|'expire'|'terminate' }} event
 * @returns {string}
 */
export function renderReleaseNotice({ key, reason }) {
  const next = reason === 'delete'
    ? 'The key is free again — call blackboard_apply if you still need it.'
    : 'Call blackboard_apply again if you still need this key.'
  return `${RELEASE_NOTICE_PREFIX}: ${releaseClause(key, reason)}. ${next} This is an automatic board notification, not a user instruction.`
}

/**
 * Create the release-notification deliverer.
 * @param {object} deps
 * @param {() => ({ get?: (id: string) => any } | undefined)} deps.agents - live agents registry accessor (resolved per delivery)
 * @param {(childId: string) => string | undefined | Promise<string | undefined>} [deps.parentOf] - resolves a child's parent session id (live sessions first, persistence-backed fallback)
 * @param {() => ({ sendMessage?: (parent: any, childId: string, blocks: Array<object>, options: object) => Promise<unknown> | unknown } | undefined)} [deps.subagents] - the runtime's subagent channel
 * @param {{ warn?: (message: string) => void } | undefined} [deps.logger]
 * @param {(fn: () => void, ms: number) => unknown} [deps.setTimer]
 * @returns {(event: { key: string, reason: 'write'|'delete'|'expire'|'terminate', subscriberIds: string[] }) => void}
 */
export function createReleaseNotifier({ agents, parentOf, subagents, logger, setTimer }) {
  const arm = setTimer ?? ((/** @type {() => void} */ fn, /** @type {number} */ ms) => {
    const handle = globalThis.setTimeout(fn, ms)
    // A pending delivery must never keep the host process alive.
    ;/** @type {any} */ (handle)?.unref?.()
    return handle
  })

  const safeGet = (/** @type {(() => any) | undefined} */ registry, /** @type {string} */ id) => {
    if (!registry) return undefined
    try { return registry()?.get?.(id) } catch { return undefined }
  }
  const subagentsService = () => {
    try { return subagents?.() } catch { return undefined }
  }

  /** @param {number} attempt */
  const retry = (/** @type {number} */ attempt, /** @type {() => void} */ fn, /** @type {(error: any) => void} */ giveUp) => {
    arm(() => {
      let outcome
      try {
        outcome = fn()
      } catch (error) {
        outcome = Promise.reject(error)
      }
      Promise.resolve(outcome).catch((/** @type {any} */ error) => {
        if (attempt < MAX_DELIVERY_ATTEMPTS) {
          retry(attempt + 1, fn, giveUp)
          return
        }
        giveUp(error)
      })
    }, attempt === 1 ? 0 : 200 * (attempt - 1))
  }

  /**
   * Timer-deferred, bounded-retry delivery into one subscriber: steer while
   * the live agent works, followup when it is idle, and — for a delegated
   * child whose agent handle is dropped between turns — the subagents channel
   * through its live parent.
   * @param {string} subscriberId @param {object} message @param {number} attempt
   */
  function deliver(subscriberId, message, attempt) {
    const agent = safeGet(agents, subscriberId)
    const channel = subagentsService()
    // A subscriber with no live agent and no subagent channel is gone: the
    // one-shot subscription is consumed either way, so skip without a timer.
    if (!agent && !channel?.sendMessage) return
    retry(attempt, async () => {
      if (agent && typeof agent.steer === 'function' && typeof agent.followup === 'function') {
        return agent.status === 'idle' ? agent.followup(message) : agent.steer(message)
      }
      let parentId
      try {
        parentId = await parentOf?.(subscriberId)
      } catch {
        parentId = undefined
      }
      const parent = typeof parentId === 'string' && parentId.length > 0 ? safeGet(agents, parentId) : undefined
      if (!parent) throw new Error(`subscriber "${subscriberId}" is between turns and its parent agent is unavailable`)
      return channel.sendMessage(parent, subscriberId, [{ type: 'text', text: message.content[0].text }], { signal: new AbortController().signal })
    }, (error) => {
      logger?.warn?.(`blackboard: release notice delivery to "${subscriberId}" failed after ${MAX_DELIVERY_ATTEMPTS} attempts: ${error?.message ?? error}`)
    })
  }

  return (event) => {
    if (!Array.isArray(event.subscriberIds) || event.subscriberIds.length === 0) return
    const message = userTextMessage(renderReleaseNotice(event), RELEASE_SOURCE_KIND)
    for (const subscriberId of event.subscriberIds) {
      if (typeof subscriberId !== 'string' || subscriberId.length === 0) continue
      deliver(subscriberId, message, 1)
    }
  }
}
