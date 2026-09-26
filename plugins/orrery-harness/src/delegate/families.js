// Model-family detection for prompt-append variant selection.
// Claude/Kimi-like models follow mechanics-driven checklist prompts best;
// GPT-like models follow principle-driven prompts; everything else gets the
// neutral default.

/**
 * @param {string | undefined} modelId
 * @returns {'mechanics' | 'principle' | 'neutral'}
 */
export function modelFamily(modelId) {
  if (!modelId) return 'neutral'
  const id = modelId.toLowerCase()
  if (id.includes('claude') || id.includes('kimi') || id.includes('glm') || id.includes('k3')) return 'mechanics'
  if (id.includes('gpt') || id.includes('o1') || id.includes('o3') || id.includes('o4')) return 'principle'
  return 'neutral'
}

/**
 * Pick the prompt-append variant for one model family.
 * @param {string | { default: string, mechanics?: string, principle?: string }} append
 * @param {'mechanics' | 'principle' | 'neutral'} family
 * @returns {string}
 */
export function pickVariant(append, family) {
  if (typeof append === 'string') return append
  if (!append || typeof append !== 'object') return ''
  if (family === 'mechanics' && typeof append.mechanics === 'string') return append.mechanics
  if (family === 'principle' && typeof append.principle === 'string') return append.principle
  return typeof append.default === 'string' ? append.default : ''
}
