// Weir core: registers the Orchestrator doctrine prompt section for agents
// composed under the weir preset. Plain ESM, ctx-only (no @deepseek-ai
// imports — they do not resolve from a linked bundle).
import { DOCTRINE, DOCTRINE_SECTION_NAME, DOCTRINE_SECTION_ORDER, DOCTRINE_VARIABLE_NAME } from './doctrine.js'
import { isDelegatedChild } from '../shared/child-scope.js'

const name = 'weir-core'
const inject = ['systemPrompt']

/**
 * @param {object} ctx - Cordis plugin context (preset scope).
 * @returns {() => void} the section registration disposer.
 */
function apply(ctx) {
  // The section text is a STATIC bare variable reference; the suppression
  // for delegated children rides the variable provider, which DSH evaluates
  // at every prompt assembly — a function-valued section text proved fragile
  // in this runtime (it broke the supervised continuation path in the
  // grouped/background/rehydrate integration scenarios), while variable
  // providers and function context texts already run per assembly in
  // production. Main agents render DOCTRINE byte-identically; a delegated
  // child renders '' (its collaboration contract rides the persona instead —
  // WORKER_CONTRACT in src/shared/child-scope.js); isDelegatedChild fails
  // open to main agents.
  const disposeSection = ctx.systemPrompt.section({
    name: DOCTRINE_SECTION_NAME,
    order: DOCTRINE_SECTION_ORDER,
    text: `{{${DOCTRINE_VARIABLE_NAME}}}`,
  })
  const disposeVariable = ctx.systemPrompt.variable(DOCTRINE_VARIABLE_NAME, (context) =>
    isDelegatedChild(context) ? '' : DOCTRINE,
  )
  return () => {
    disposeSection()
    disposeVariable()
  }
}

export { name, inject, apply }
