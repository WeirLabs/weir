// Stateless composition for exactly one Decision Attempt.
import { evaluateGates, gateFailureOutcome } from '../gates.js'
import { buildContextPack } from './pack.js'
import { failureOutcome, parseDecision } from './parse.js'
import { streamDecision } from './sidecar.js'

/** @param {Record<string,any>} input */
export async function runDecisionAttempt(input) {
  const attemptStartedAt = input.attemptStartedAt ?? Date.now()
  const pack = input.packed ?? buildContextPack({
    profile: input.profile,
    request: input.request,
    evidence: input.evidence,
    modelRoute: input.modelRoute,
    budgetTokens: input.budgetTokens,
    criticalEvidenceIds: input.criticalEvidenceIds,
  })
  const pinned = {
    pins: pack.pins,
    packManifest: pack.packManifest,
    contextPackHash: pack.contextPackHash,
  }
  if (pack.outcome !== 'ready') return { ...pack, ...pinned }

  const streamed = await streamDecision({
    llm: input.ctx.llm,
    route: input.modelRoute,
    pack,
    maxOutputTokens: input.maxOutputTokens,
    timeoutMs: input.timeoutMs,
    signal: input.signal,
  })
  const usage = { inputTokens: streamed.inputTokens, outputTokens: streamed.outputTokens }
  const finishReason = ({ error: 'model_error', 'max-tokens': 'truncated' })[streamed.finishReason] ?? streamed.finishReason
  if (['timeout', 'model_error', 'aborted', 'route_unavailable'].includes(finishReason)) {
    return { ...failureOutcome(finishReason, streamed.failureCode), ...pinned, ...usage }
  }
  const parsed = parseDecision(streamed.text, {
    evidenceIds: pack.packManifest.evidenceIds,
    ...(finishReason === 'truncated' ? { finishReason } : {}),
  })
  if (parsed.outcome === 'failed') return { ...parsed, ...pinned, ...usage }
  if (parsed.outcome !== 'answer') return { ...parsed, ...pinned, ...usage }

  const gates = evaluateGates({
    claims: parsed.claims,
    answers: parsed.answers,
    questions: input.questions ?? input.request.questions ?? [],
    evidence: pack.layers.L5,
    packEvidenceIds: pack.packManifest.evidenceIds,
    profile: input.profile,
    workspaceKey: input.workspaceKey,
    scope: input.scope,
    authorizationClass: input.authorizationClass,
    intentKind: input.intentKind,
    attemptStartedAt,
    attemptEndedAt: Date.now(),
    recheckEvidence: input.recheckEvidence,
    conflictPairs: input.conflictPairs,
    currentObservationHashes: input.currentObservationHashes,
  })
  const common = {
    claims: parsed.claims,
    answers: parsed.answers,
    citedEvidenceIds: [...new Set(parsed.claims.flatMap(claim => claim.evidenceIds))],
    gates,
    ...pinned,
    ...usage,
  }
  const failure = gateFailureOutcome(gates)
  if (failure) return { ...failure, ...common }
  return { outcome: 'answer', ...common }
}
