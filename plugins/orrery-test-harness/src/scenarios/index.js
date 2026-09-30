// Scenario registry (design D1): one module per integration scenario, this
// index is the single registration point. SCENARIOS order is the historical
// driver order (former run.mjs SCENARIOS list); byId is the lookup used by
// both the mock LLM entry (ORRERY_IT_SCENARIO) and the driver (argv filter).
import deepwork from './deepwork.js'
import delegate from './delegate.js'
import hashline from './hashline.js'
import pressure from './pressure.js'
import robash from './robash.js'
import semantic from './semantic.js'
import grouped from './grouped.js'
import escalate from './escalate.js'
import background from './background.js'
import terminate from './terminate.js'
import rehydrate from './rehydrate.js'
import lsp from './lsp.js'

const SCENARIOS = [deepwork, delegate, hashline, pressure, robash, semantic, grouped, escalate, background, terminate, rehydrate, lsp]

/**
 * Find a scenario entry by id.
 * @param {string} id - scenario id (same as its module filename)
 * @returns {object|undefined} the registry entry, or undefined when unknown
 */
function byId(id) {
  return SCENARIOS.find((scenario) => scenario.id === id)
}

export { SCENARIOS, byId }
