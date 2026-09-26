// Intent matcher — pure core, no runtime dependencies.
// Detects configured intent keywords in user prompts. Quoted and code regions
// are blanked before matching so mentioned keywords never trigger a mode.

/** Blank fenced code blocks, inline code spans, and blockquote lines. */
export function stripQuotedRegions(text) {
  return (
    text
      // fenced code blocks (``` or ~~~, optional info string)
      .replace(/(^|\n)[ \t]*(```|~~~)[\s\S]*?\2[ \t]*(?=\n|$)/g, '$1')
      // inline code spans
      .replace(/`[^`\n]*`/g, ' ')
      // blockquote lines
      .replace(/^[ \t]*>.*$/gm, '')
  )
}

/**
 * @typedef {object} IntentEntry
 * @property {string} id
 * @property {RegExp[]} patterns - compiled matchers
 * @property {boolean} oncePerSession
 * @property {{ kind: 'skill-pointer', skill: string }
 *   | { kind: 'message', text: string }
 *   | { kind: 'effort', reasoningEffort: string }} injection
 */

/**
 * Validate and compile the raw intent table. Throws with the offending entry
 * id on any invalid entry (fail loud at activation, not at match time).
 * @param {unknown} raw - config.intents
 * @returns {IntentEntry[]}
 */
export function compileIntentTable(raw) {
  if (!Array.isArray(raw)) throw new Error('intent-gate: `intents` must be an array')
  const seen = new Set()
  return raw.map((entry, index) => {
    const where = entry && typeof entry === 'object' && typeof entry.id === 'string' ? entry.id : `index ${index}`
    if (!entry || typeof entry !== 'object') throw new Error(`intent-gate: entry ${where} must be an object`)
    if (typeof entry.id !== 'string' || entry.id.length === 0) throw new Error(`intent-gate: entry at index ${index} needs a non-empty id`)
    if (seen.has(entry.id)) throw new Error(`intent-gate: duplicate intent id "${entry.id}"`)
    seen.add(entry.id)
    if (!Array.isArray(entry.matchers) || entry.matchers.length === 0) {
      throw new Error(`intent-gate: intent "${entry.id}" needs a non-empty matchers array`)
    }
    const patterns = entry.matchers.map((matcher) => {
      if (typeof matcher !== 'string' || matcher.length === 0) {
        throw new Error(`intent-gate: intent "${entry.id}" has a non-string matcher`)
      }
      try {
        return new RegExp(matcher, 'i')
      } catch (error) {
        throw new Error(`intent-gate: intent "${entry.id}" has an invalid matcher ${JSON.stringify(matcher)}: ${error.message}`)
      }
    })
    const injection = entry.injection
    if (!injection || typeof injection !== 'object') {
      throw new Error(`intent-gate: intent "${entry.id}" needs an injection object`)
    }
    if (injection.kind === 'skill-pointer') {
      if (typeof injection.skill !== 'string' || injection.skill.length === 0) {
        throw new Error(`intent-gate: intent "${entry.id}" skill-pointer needs a skill name`)
      }
    } else if (injection.kind === 'message') {
      if (typeof injection.text !== 'string' || injection.text.length === 0) {
        throw new Error(`intent-gate: intent "${entry.id}" message injection needs text`)
      }
    } else if (injection.kind === 'effort') {
      if (typeof injection.reasoningEffort !== 'string' || injection.reasoningEffort.length === 0) {
        throw new Error(`intent-gate: intent "${entry.id}" effort injection needs reasoningEffort`)
      }
    } else {
      throw new Error(`intent-gate: intent "${entry.id}" has unknown injection kind ${JSON.stringify(injection.kind)}`)
    }
    return {
      id: entry.id,
      patterns,
      oncePerSession: entry.oncePerSession !== false,
      injection,
    }
  })
}

/**
 * Match the intent table against already-stripped prompt text.
 * @param {string} stripped
 * @param {IntentEntry[]} intents
 * @returns {IntentEntry[]} matched intents in table order
 */
export function matchIntents(stripped, intents) {
  return intents.filter((intent) => intent.patterns.some((pattern) => pattern.test(stripped)))
}

/** The default intent table (English templates; runtime content follows the session language). */
export const DEFAULT_INTENTS = [
  {
    id: 'deep-work',
    matchers: ['\\bdeep[- ]?work\\b', '深度工作', '深度作业'],
    injection: { kind: 'skill-pointer', skill: 'deep-work' },
  },
  {
    id: 'research',
    matchers: ['\\bdeep research\\b', '\\bresearch\\b', '深度调研', '调研'],
    injection: { kind: 'skill-pointer', skill: 'research' },
  },
  {
    id: 'review',
    matchers: ['\\breview[- ]?work\\b', '\\bcode review\\b', '验收', '审查'],
    injection: { kind: 'skill-pointer', skill: 'review-work' },
  },
  {
    id: 'debug',
    matchers: ['\\bdebug\\b', '\\bdebugging\\b', '调试', '排查'],
    injection: { kind: 'skill-pointer', skill: 'debugging' },
  },
  {
    id: 'think',
    matchers: ['\\bthink hard\\b', '\\bultrathink\\b', '深思熟虑'],
    oncePerSession: false,
    injection: { kind: 'effort', reasoningEffort: 'high' },
  },
]

/** The full-payload notice injected on the first hit of a skill-pointer intent. */
export function renderSkillPointer(intent) {
  return `<intent-gate id="${intent.id}">
The user's request matched the "${intent.id}" intent. Load and follow the "${intent.injection.skill}" skill NOW via the skill tool (skill(name="${intent.injection.skill}")) and treat its contract as binding for this task. This notice appears once per session; the mode stays armed until the task completes.
</intent-gate>`
}

/** The short reminder injected on repeat hits of an armed intent. */
export function renderReminder(intent) {
  return `<intent-gate id="${intent.id}">The "${intent.id}" intent is already armed for this session; its contract still applies.</intent-gate>`
}
