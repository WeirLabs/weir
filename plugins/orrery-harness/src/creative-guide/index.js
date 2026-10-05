// Creative-guide prompt section, mounted only by the orrery-creative preset.
// Plain ESM, ctx-only (no @deepseek-ai imports — they do not resolve from a
// linked bundle). Mirrors the orrery-core doctrine pattern.
import { CREATIVE_GUIDE, CREATIVE_GUIDE_SECTION_NAME, CREATIVE_GUIDE_SECTION_ORDER } from './guide.js'

const name = 'orrery-creative-guide'
const inject = ['systemPrompt']

/**
 * @param {object} ctx - Cordis plugin context (preset scope).
 * @returns {() => void} the section registration disposer.
 */
function apply(ctx) {
  return ctx.systemPrompt.section({
    name: CREATIVE_GUIDE_SECTION_NAME,
    order: CREATIVE_GUIDE_SECTION_ORDER,
    text: CREATIVE_GUIDE,
  })
}

export { name, inject, apply }
