// Profile-level Decision Broker plugin: one authoritative store per profile.
import { DecisionBroker } from './broker.js'
import { createDecisionAudit } from './audit.js'
import { overlayConfig } from '../shared/runtime-messages.js'

/** Map the settings section to the Broker's versioned flat runtime options.
 * The legacy `decisionAgentAutoAnswerClasses` array is deliberately ignored:
 * the answer permission is the single boolean `decisionAgentAutoAnswer`, and a
 * stored value that is not a boolean opens as "off". */
export function decisionBrokerConfig(ctx) {
  const value = overlayConfig(ctx, 'decisionAgent', {}, { defaults: {
    enabled: false, answerTimeoutMs: 60000, maxAttemptsPerCase: 3,
    contextBudgetTokens: 24000, maxOutputTokens: 4096, maxConcurrentAttempts: 4,
    chains: {}, retentionDays: 0, storePath: '',
    selectorDefault: 'off', autoShadow: false, autoAnswer: false,
  } })
  return {
    decisionAgentsEnabled: value.enabled,
    decisionAgentAnswerTimeoutMs: value.answerTimeoutMs,
    decisionAgentMaxAttemptsPerCase: value.maxAttemptsPerCase,
    decisionAgentContextBudgetTokens: value.contextBudgetTokens,
    decisionAgentMaxOutputTokens: value.maxOutputTokens,
    decisionAgentMaxConcurrentAttempts: value.maxConcurrentAttempts,
    decisionAgentChains: value.chains,
    decisionAgentRetentionDays: value.retentionDays,
    decisionAgentStorePath: value.storePath,
    decisionAgentSelectorDefault: value.selectorDefault === 'auto' ? 'auto' : 'off',
    decisionAgentAutoShadow: value.autoShadow === true,
    decisionAgentAutoAnswer: value.autoAnswer === true,
  }
}

export function apply(ctx) {
  const broker = new DecisionBroker({
    profileContext: ctx.get('profileContext'),
    config: () => decisionBrokerConfig(ctx),
    ctx,
    audit: createDecisionAudit(ctx),
  })
  ctx.reflect.provide('weirDecisionBroker', broker)
  const starting = broker.start()
  ctx.effect(() => () => { void starting.then(() => broker.flush()) })
  return broker
}

export const name = 'weir-decision-broker'
export const inject = ['agents', 'llm', 'sessionQuery', 'fs']
