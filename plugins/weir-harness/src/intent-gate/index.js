// Weir intent gate: detects configured intent keywords in fresh user prompts
// and injects the matching context (skill pointer / message) through the
// agent/pre-step waterfall, or raises reasoning effort through agent/request.
// Optional semantic classification (llm sidecar / experimental jev) kicks in
// only when regex misses. Plain ESM, ctx-only.
import { createClassifier } from './classifier.js'
import { AUDIT_TYPES, createAudit } from '../shared/audit.js'
import { userTextMessage } from '../shared/user-message.js'
import { isGenuineUserMessage, overlayConfig } from '../shared/runtime-messages.js'
import {
  compileIntentTable,
  DEFAULT_INTENTS,
  matchIntents,
  renderReminder,
  renderSkillPointer,
  stripQuotedRegions,
} from './matcher.js'
import { createSkillConsumerView } from '../capabilities/consumer-view.js'
import { skillSelectionFor } from '../capabilities/skill-selection-plugin.js'

const name = 'weir-intent-gate'
const inject = ['llm']

/** Extract the text of the newest genuine user message in the proposed step batch. Runtime-injected messages (settlement notices, continuation nudges, this gate's own notices) share the user role but carry producer sources; only source.kind 'user' is a fresh user prompt. */
function latestUserText(messages) {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (!message || message.role !== 'user' || !Array.isArray(message.content)) continue
    if (!isGenuineUserMessage(message)) continue
    const text = message.content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    if (text.trim().length > 0) return text
  }
  return undefined
}

function apply(ctx, config = {}) {
  const audit = createAudit(ctx)
  const rowConfig = config
  const nestKeys = { jev: { endpoint: 'jevEndpoint', model: 'jevModel', apiKeyEnv: 'jevApiKeyEnv' } }
  // Settings overlay (absent service = no-op): intentGate section wins over row config.
  config = overlayConfig(ctx, 'intentGate', config, { nestKeys })
  const table = compileIntentTable(config.intents ?? DEFAULT_INTENTS)
  const disabled = new Set(Array.isArray(config.disabled) ? config.disabled : [])
  const intents = table.filter((intent) => !disabled.has(intent.id))

  // Semantic classifier: null in regex mode (regex-only behavior, zero cost).
  const classifier = createClassifier({
    mode: config.classifier ?? 'regex',
    llm: ctx.llm,
    // rc.2 cordis activates providers only after the apply batch, so an
    // apply-time ctx.get can never see the settings service (S-rc2 evidence in
    // openspec change fix-intent-classifier-route/design.md D1). Resolve the
    // route override per classification — a late-arriving overlay still works.
    resolveRouteOverride: () => {
      const live = overlayConfig(ctx, 'intentGate', rowConfig, { nestKeys })
      return {
        ...(live.classifierProvider ? { provider: live.classifierProvider } : {}),
        ...(live.classifierModel ? { model: live.classifierModel } : {}),
        ...(live.classifierReasoningEffort ? { reasoningEffort: live.classifierReasoningEffort } : {}),
      }
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
          audit(agent.session, AUDIT_TYPES.intentClassify, event)
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

    // Task 7.3: skill pointers and reminders share the unified consumer
    // view — a pointer is injected only while the skill is selected,
    // available and model-invocable in THIS session. A suppressed first hit
    // stays unarmed (the ledger below never sees it), so a later hit once
    // the skill is available still injects the full initial pointer; nothing
    // is injected in its place and nothing already injected is withdrawn.
    const selection = skillSelectionFor(ctx)
    const skillView = selection?.provider ? createSkillConsumerView({ provider: selection.provider }) : null
    const eligibility = skillView
      ? skill => skillView.conclusion({ cwd: agent.session?.header?.cwd, scope: { session: { id: sessionId } } }, skill, 'model')
      : null

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
      if (intent.injection.kind === 'skill-pointer' && eligibility) {
        const verdict = await eligibility(intent.injection.skill)
        if (!verdict?.invocable) {
          record(ctx, agent, intent, false, { suppressed: verdict?.reason ?? 'not-selected' })
          continue
        }
      }
      const first = !ledger.has(intent.id)
      if (first && intent.oncePerSession) ledger.add(intent.id)
      const body = intent.injection.kind === 'skill-pointer'
        ? (first ? renderSkillPointer(intent) : renderReminder(intent))
        : (first || !intent.oncePerSession ? intent.injection.text : renderReminder(intent))
      injections.push(userTextMessage(body, 'weir-intent-gate'))
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
  function record(_ctx, agent, intent, first, extra) {
    audit(agent.session, AUDIT_TYPES.intentHit, { intent: intent.id, first, ...(extra?.suppressed ? { suppressed: extra.suppressed } : {}) })
  }

  // Dispose: clear the in-memory ledgers (symmetric with todo-driver /
  // context-guard; the ctx.on listeners are reaped by the runtime itself).
  return () => {
    armed.clear()
    effortTurns.clear()
  }
}

export { name, inject, apply }
