// Orrery core: registers the Orchestrator doctrine prompt section for agents
// composed under the orrery preset. Plain ESM, ctx-only (no @deepseek-ai
// imports — they do not resolve from a linked bundle).
import { DOCTRINE, DOCTRINE_SECTION_NAME, DOCTRINE_SECTION_ORDER } from './doctrine.js'

const name = 'orrery-core'
const inject = ['systemPrompt']

/**
 * @param {object} ctx - Cordis plugin context (preset scope).
 * @returns {() => void} the section registration disposer.
 */
function apply(ctx) {
  return ctx.systemPrompt.section({
    name: DOCTRINE_SECTION_NAME,
    order: DOCTRINE_SECTION_ORDER,
    text: DOCTRINE,
  })
}

export { name, inject, apply }
