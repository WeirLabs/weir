// Session blackboard promotion-request delivery (design D6, slice 3): the
// panel's promotion button becomes an injected evaluation brief for the
// conversation's MAIN agent. Cold-safe by construction, same pattern as
// ./notify.js: timer-deferred (never synchronous inside tool execution or
// event dispatch), producer-tagged source so the brief is never mistaken for
// a user instruction, bounded retry, and a delivery failure can never reach
// a turn. NEVER session.append (cold-read red line S13).
//
// Delivery: followup when the main agent is idle (wakes exactly one turn —
// the evaluation pass), steer when it is busy (the brief joins the current
// turn, no new turn). The main-agent lookup is composed in by the blackboard
// plugin: the conversation's root agent, resolved through the same boardOf
// walk the board itself uses, so a panel attached to a child session still
// delivers to the root.
//
// Pure module — faces and timers are injected, so unit tests drive every
// path without a runtime.
import { userTextMessage } from '../shared/user-message.js'
import { PROMOTION_REQUEST_TEMPLATE } from './contracts.js'

/** The promotion-brief source kind (producer tag, never 'user'). */
export const PROMOTION_SOURCE_KIND = 'weir-blackboard-promotion'

/** The marker every promotion brief starts with (integration assertions pin it). */
export const PROMOTION_NOTICE_PREFIX = 'Blackboard promotion request'

/** Delivery attempts before the final failure is logged and dropped. */
export const MAX_DELIVERY_ATTEMPTS = 3

/**
 * Create the promotion-request deliverer.
 * @param {object} deps
 * @param {(actingAgent: any) => any | undefined} deps.resolveMainAgent - the conversation's main agent for an acting agent handle
 * @param {string} [deps.template] - the injected brief text (default the contracts template)
 * @param {(fn: () => void, ms: number) => unknown} [deps.setTimer]
 * @param {{ warn?: (message: string) => void } | undefined} [deps.logger]
 * @returns {(actingAgent: any) => { requested: true, channel: 'steer' | 'followup' }}
 */
export function createPromotionRequester({ resolveMainAgent, template = PROMOTION_REQUEST_TEMPLATE, setTimer, logger }) {
  const arm = setTimer ?? ((/** @type {() => void} */ fn, /** @type {number} */ ms) => {
    const handle = globalThis.setTimeout(fn, ms)
    // A pending delivery must never keep the host process alive.
    ;/** @type {any} */ (handle)?.unref?.()
    return handle
  })

  /** @param {number} attempt */
  const retry = (/** @type {number} */ attempt, /** @type {() => void | Promise<void>} */ fn, /** @type {(error: any) => void} */ giveUp) => {
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

  return function requestPromotion(actingAgent) {
    // The liveness check is synchronous so the remote can refuse the click
    // explicitly; the delivery itself is deferred (message discipline: never
    // synchronously inside a tool call or event dispatch).
    const main = resolveMainAgent(actingAgent)
    if (!main || typeof main.steer !== 'function' || typeof main.followup !== 'function') {
      throw new Error("the conversation's main agent is not live; the promotion-evaluation brief was not delivered")
    }
    const message = userTextMessage(template, PROMOTION_SOURCE_KIND)
    const channel = main.status === 'idle' ? 'followup' : 'steer'
    retry(1, () => {
      // Status re-checked at delivery time: the brief defers, never races the
      // turn state.
      return main.status === 'idle' ? main.followup(message) : main.steer(message)
    }, (error) => {
      logger?.warn?.(`blackboard: promotion brief delivery failed after ${MAX_DELIVERY_ATTEMPTS} attempts: ${error?.message ?? error}`)
    })
    return { requested: true, channel }
  }
}
