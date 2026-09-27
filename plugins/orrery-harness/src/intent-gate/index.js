// Orrery intent gate: detects configured intent keywords in fresh user prompts
// and injects the matching context (skill pointer / message) through the
// agent/pre-step waterfall, or raises reasoning effort through agent/request.
// Optional semantic classification (llm sidecar / experimental jev) kicks in
// only when regex misses. Plain ESM, ctx-only.
import { createClassifier } from './classifier.js'
import { createAudit } from '../shared/audit.js'
import {
  compileIntentTable,
  DEFAULT_INTENTS,
  matchIntents,
  renderReminder,
  renderSkillPointer,
  stripQuotedRegions,
} from './matcher.js'

const name = 'orrery-intent-gate'
const inject = ['llm']

/** Extract the text of the newest user message in the proposed step batch. */
function latestUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message || message.role !== 'user' || !Array.isArray(message.content)) continue
    const text = message.content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    if (text.trim().length > 0) return text
  }
  return undefined
}

/** Build the injection message appended to the step (durable, logged). */
function injectionMessage(text) {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: 'orrery-intent-gate' },
  }
}

function apply(ctx, config = {}) {
  const audit = createAudit(ctx)
  const table = compileIntentTable(config.intents ?? DEFAULT_INTENTS)
  const disabled = new Set(Array.isArray(config.disabled) ? config.disabled : [])
  const intents = table.filter((intent) => !disabled.has(intent.id))

  // Semantic classifier: null in regex mode (regex-only behavior, zero cost).
  const classifier = createClassifier({
    mode: config.classifier ?? 'regex',
    llm: ctx.llm,
    routeOverride: {
      ...(config.classifierProvider ? { provider: config.classifierProvider } : {}),
      ...(config.classifierModel ? { model: config.classifierModel } : {}),
    },
    timeoutMs: config.classifierTimeoutMs,
    jev: config.jev,
  })

  // Per-session arming ledger: intent id set, so a full payload fires once.
  const armed = new Map()
  // Per-session effort flags: turns whose requests get the raised effort.
  const effortTurns = new Map()

  ctx.on('agent/pre-step', async ({ agent, messages, turn }, next) => {
    const text = latestUserText(messages)
    if (text === undefined) return next()
    const stripped = stripQuotedRegions(text)
    let hits = matchIntents(stripped, intents)

    // Semantic front-end: only when regex missed entirely (short-circuit).
    if (hits.length === 0 && classifier) {
      const semanticHit = await classifier(stripped, intents, {
        agent,
        onAudit: (event) => {
          audit(agent.session, 'intent-classify', event)
        },
      })
      if (semanticHit) {
        const intent = intents.find((entry) => entry.id === semanticHit)
        if (intent) hits = [intent]
      }
    }
    if (hits.length === 0) return next()

    const sessionId = agent.id
    let ledger = armed.get(sessionId)
    if (!ledger) {
      ledger = new Set()
      armed.set(sessionId, ledger)
    }

    const injections = []
    for (const intent of hits) {
      if (intent.injection.kind === 'effort') {
        let turns = effortTurns.get(sessionId)
        if (!turns) {
          turns = new Set()
          effortTurns.set(sessionId, turns)
        }
        turns.add(turn)
        record(ctx, agent, intent, true)
        continue
      }
      const first = !ledger.has(intent.id)
      if (first && intent.oncePerSession) ledger.add(intent.id)
      const body = intent.injection.kind === 'skill-pointer'
        ? (first ? renderSkillPointer(intent) : renderReminder(intent))
        : (first || !intent.oncePerSession ? intent.injection.text : renderReminder(intent))
      injections.push(injectionMessage(body))
      record(ctx, agent, intent, first)
    }

    const downstream = await next()
    if (injections.length === 0 || downstream.kind !== 'enter') return downstream
    return { ...downstream, messages: [...(downstream.messages ?? []), ...injections] }
  })

  ctx.on('agent/request', async ({ agent, turn }, next) => {
    const configOut = await next()
    const turns = effortTurns.get(agent.id)
    if (!turns || !turns.has(turn)) return configOut
    const hit = intents.find((intent) => intent.injection.kind === 'effort')
    if (!hit) return configOut
    return { ...configOut, reasoningEffort: hit.injection.reasoningEffort }
  })

  // Cold-safe durable audit of intent hits (never session.append — see
  // src/shared/audit.js for the hard contract).
  function record(_ctx, agent, intent, first) {
    audit(agent.session, 'intent-hit', { intent: intent.id, first })
  }
}

export { name, inject, apply }
