// Orrery core: registers the Orchestrator doctrine prompt section for agents
// composed under the orrery preset. Plain ESM, ctx-only (no @deepseek-ai
// imports — they do not resolve from a linked bundle).
import { DOCTRINE, DOCTRINE_SECTION_NAME, DOCTRINE_SECTION_ORDER } from './doctrine.js'
import { isDelegatedChild } from '../shared/child-scope.js'

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
    // Lazy text: the doctrine is orchestrator-facing, so a delegated child
    // renders '' (its collaboration contract rides the persona instead —
    // WORKER_CONTRACT in src/shared/child-scope.js). Main agents render
    // DOCTRINE byte-identically; isDelegatedChild fails open to them.
    text: (context) => (isDelegatedChild(context) ? '' : DOCTRINE),
  })
}

export { name, inject, apply }
