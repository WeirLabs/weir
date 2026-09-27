// Semantic intent classifier: pluggable front-ends (llm sidecar / jev) behind
// one fail-open abstraction with timeout, per-session cache, and audit hooks.
// The regex mode builds no classifier at all (zero cost). Plain ESM, ctx-only.

export const CLASSIFIER_MODES = ['regex', 'llm', 'jev']
export const DEFAULT_CLASSIFIER_TIMEOUT_MS = 1500

/**
 * Create a classifier for the configured mode, or null for 'regex' / unknown
 * modes (callers then behave exactly like the regex-only gate).
 *
 * @param {object} deps
 * @param {'regex' | 'llm' | 'jev'} deps.mode
 * @param {object} deps.llm - ctx.llm (llm front-end)
 * @param {{ provider?: string, model?: string }} [deps.routeOverride] - classifierProvider/classifierModel
 * @param {number} [deps.timeoutMs]
 * @param {{ endpoint?: string, model?: string, apiKeyEnv?: string }} [deps.jev]
 */
export function createClassifier(deps) {
  const mode = deps.mode ?? 'regex'
  if (mode === 'regex' || !CLASSIFIER_MODES.includes(mode)) return null
  const timeoutMs = deps.timeoutMs ?? DEFAULT_CLASSIFIER_TIMEOUT_MS
  const cache = new Map() // `${sessionId}:${promptText}` → intentId | null

  /**
   * Classify one fresh user prompt to an intent id, or null (fail-open).
   * @param {string} promptText
   * @param {{ id: string, summary?: string, injection: object }[]} intents
   * @param {{ agent?: object, onAudit?: (event: { mode: string, hit: string | null, fallback?: string }) => void }} [context]
   */
  return async function classify(promptText, intents, context = {}) {
    const key = `${context.agent?.id ?? ''}:${promptText}`
    if (cache.has(key)) return cache.get(key)

    let hit = null
    let fallback
    try {
      const raw = await withTimeout(
        () => (mode === 'jev' ? classifyViaJev(deps, promptText, intents) : classifyViaLlm(deps, promptText, intents, context)),
        timeoutMs,
      )
      if (raw === null) {
        // classifier answered "no intent"
      } else if (intents.some((intent) => intent.id === raw)) {
        hit = raw
      } else {
        fallback = `unknown-answer:${String(raw).slice(0, 40)}`
      }
    } catch (error) {
      fallback = error?.name === 'TimeoutError' ? 'timeout' : `error:${String(error?.message ?? error).slice(0, 60)}`
    }

    // fail-open: any fallback resolves to no hit
    cache.set(key, hit)
    context.onAudit?.({ mode, hit, ...(fallback ? { fallback } : {}) })
    return hit
  }
}

function withTimeout(fn, timeoutMs) {
  return new Promise((resolvePromise, rejectPromise) => {
    const timer = setTimeout(() => {
      const error = new Error(`classifier timeout after ${timeoutMs}ms`)
      error.name = 'TimeoutError'
      rejectPromise(error)
    }, timeoutMs)
    Promise.resolve()
      .then(fn)
      .then((value) => resolvePromise(value), (error) => rejectPromise(error))
      .finally(() => clearTimeout(timer))
  })
}

// ---------------------------------------------------------------------------
// llm sidecar front-end
// ---------------------------------------------------------------------------

const CLASSIFY_SYSTEM = `You classify a user prompt into at most one workflow intent.

Reply with EXACTLY ONE token: either the id of the single intent the prompt is asking for, or \`none\` when no intent fits. No punctuation, no explanation, no quotes.

Intents:`

async function classifyViaLlm(deps, promptText, intents, context) {
  const override = deps.routeOverride ?? {}
  const route = override.provider && override.model ? override : routeOf(context.agent)
  if (!route?.provider || !route?.model) throw new Error('no classifier route')

  const catalog = intents.map((intent) => `- ${intent.id}: ${summaryOf(intent)}`).join('\n')
  const options = {
    provider: route.provider,
    model: route.model,
    system: `${CLASSIFY_SYSTEM}\n${catalog}`,
    messages: [{ role: 'user', content: [{ type: 'text', text: promptText.slice(0, 4000) }] }],
    maxTokens: 16,
    temperature: 0,
  }

  let text = ''
  let failure = null
  for await (const chunk of deps.llm.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text
    if (chunk.type === 'finish' && chunk.reason?.kind === 'error') failure = chunk.reason.failure
  }
  if (failure) throw new Error(failure.message ?? 'llm stream error')
  return parseAnswer(text, intents)
}

/** The session's current route, when readable. */
function routeOf(agent) {
  try {
    const context = agent?.session?.requestContext?.()
    return context ? { provider: context.provider, model: context.model } : undefined
  } catch {
    return undefined
  }
}

/** One-line catalog description: explicit summary wins, else derived. */
function summaryOf(intent) {
  if (typeof intent.summary === 'string' && intent.summary.length > 0) return intent.summary
  if (intent.injection?.kind === 'skill-pointer') return `activate the ${intent.injection.skill} working mode`
  if (intent.injection?.kind === 'effort') return `answer with deeper reasoning (${intent.injection.reasoningEffort} effort)`
  return 'custom intent'
}

/** First token that names a table intent, 'none' → null; unknown → the raw token. */
function parseAnswer(text, intents) {
  const token = (text.trim().split(/\s+/)[0] ?? '').replace(/[."'`,;:]+/g, '')
  if (token === '' || token.toLowerCase() === 'none') return null
  if (intents.some((intent) => intent.id === token)) return token
  return token // unknown answer: caller records the fallback
}

// ---------------------------------------------------------------------------
// Jev decision-model front-end (experimental)
// ---------------------------------------------------------------------------

async function classifyViaJev(deps, promptText, intents) {
  const jev = deps.jev ?? {}
  if (!jev.endpoint) throw new Error('jev.endpoint is not configured')
  const apiKey = jev.apiKeyEnv ? process.env[jev.apiKeyEnv] : undefined

  const options = intents.map((intent) => intent.id)
  const response = await fetch(jev.endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    },
    body: JSON.stringify({
      model: jev.model ?? 'jev',
      // Decisions-API shape: pick one option or none. Implementation-time
      // verification point against the published Jev schema; any mismatch
      // must stay contained inside this adapter.
      question: promptText.slice(0, 4000),
      options,
      allow_none: true,
    }),
  })
  if (!response.ok) throw new Error(`jev http ${response.status}`)
  const body = await response.json()
  const answer = body?.option ?? body?.choice ?? body?.answer ?? null
  if (answer === null || answer === 'none') return null
  return String(answer)
}
