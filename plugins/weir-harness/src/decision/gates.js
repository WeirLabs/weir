// Structural G1–G7 gates. No confidence scores or threshold-based admission.
import { canonicalJson } from './contracts.js'
import { scopeCovers, profileScopeCovers } from './scope.js'

/**
 * @param {{claims?:any[],answers?:any[],questions?:any[],evidence?:any[],packEvidenceIds?:string[],profile:any,workspaceKey:string,scope:object,intentKind?:string,attemptStartedAt:number,attemptEndedAt?:number,recheckEvidence?:(evidenceId:string)=>any,conflictPairs?:[string,string][],currentObservationHashes?:Record<string,string>}} input
 */
export function evaluateGates(input) {
  const gaps = []
  const claims = input.claims ?? []
  const answers = input.answers ?? []
  const questions = input.questions ?? []
  const evidence = input.evidence ?? []
  const packIds = new Set(input.packEvidenceIds ?? evidence.map(item => item.evidenceId))
  const byId = new Map(evidence.map(item => [item.evidenceId, item]))
  const scopeText = canonicalJson(input.scope)
  const refreshed = new Map()

  // G1: every decisive claim maps to at least one ref from this exact pack.
  claims.forEach((claim, claimIndex) => {
    const ids = Array.isArray(claim?.evidenceIds) ? claim.evidenceIds : []
    if (!ids.length || ids.some(id => !packIds.has(id))) {
      gap(gaps, 'G1', 'MISSING_CONTEXT', { claim: claimIndex, scope: scopeText, evidenceId: ids.find(id => !packIds.has(id)) ?? 'none' }, `Claim ${claimIndex} lacks a citation from this pack`)
    }
  })

  // G2: Agent authority and evidence scope must cover the exact request workspace/scope.
  // The Agent identity is profile-global and its authority is profile-wide: only its
  // optional paths/tags hints participate here, never a workspace membership.
  if (!profileScopeCovers(input.profile.scope, input.scope)) {
    gap(gaps, 'G2', 'OUT_OF_SCOPE', { claim: 'profile', scope: scopeText, evidenceId: 'none' }, `Agent profile does not cover request scope ${scopeText}`)
  }
  for (const item of evidence) {
    if (item.agentId !== undefined && item.agentId !== input.profile.agentId) {
      gap(gaps, 'G2', 'OUT_OF_SCOPE', { claim: 'evidence', scope: scopeText, evidenceId: item.evidenceId }, `Evidence ${item.evidenceId} belongs to another Agent`)
    }
    if (!scopeCovers(item.scope, input.scope, input.workspaceKey)) {
      gap(gaps, 'G2', 'OUT_OF_SCOPE', { claim: 'evidence', scope: scopeText, evidenceId: item.evidenceId }, `Evidence ${item.evidenceId} does not cover scope ${scopeText}`)
    }
  }

  // G3: re-read every cited ref at gate time, not only at pack time.
  const citedIds = [...new Set(claims.flatMap(claim => claim?.evidenceIds ?? []))]
  for (const evidenceId of citedIds) {
    const original = byId.get(evidenceId)
    const current = input.recheckEvidence ? input.recheckEvidence(evidenceId) : original
    refreshed.set(evidenceId, current)
    const ref = current?.evidence ?? current
    if (!original || !ref || ref.status !== 'active' || current?.sourceCase?.feedbackState === 'disputed' || current?.sourceCase?.feedback_state === 'disputed') {
      gap(gaps, 'G3', 'STALE_EVIDENCE', { claim: claims.findIndex(claim => claim?.evidenceIds?.includes(evidenceId)), scope: scopeText, evidenceId }, `Evidence ${evidenceId} was deleted, superseded, disputed, or is unavailable`)
    }
  }

  // G4: conflicts are explicit structural facts; prose is never guessed into opposition.
  for (const pair of input.conflictPairs ?? []) {
    const [left, right] = pair
    if (citedIds.includes(left) || citedIds.includes(right)) {
      gap(gaps, 'G4', 'CONFLICTING_EVIDENCE', { claim: 'evidence', scope: scopeText, evidenceId: `${left},${right}` }, `Evidence ${left} conflicts with ${right} in scope ${scopeText}`)
    }
  }

  // G5: repository/current facts require a fresh observation within this Attempt and an identical current hash.
  const endedAt = input.attemptEndedAt ?? Number.MAX_SAFE_INTEGER
  for (const original of evidence) {
    if (!['repo_doc', 'current_observation'].includes(original.source)) continue
    const currentHash = input.currentObservationHashes?.[original.evidenceId]
    if (!Number.isFinite(original.observedAt) || original.observedAt < input.attemptStartedAt || original.observedAt > endedAt || !original.hash || original.hash !== currentHash) {
      gap(gaps, 'G5', 'STALE_EVIDENCE', { claim: 'observation', scope: scopeText, evidenceId: original.evidenceId }, `Evidence ${original.evidenceId} is not a fresh hash-matching observation for this Attempt`)
    }
  }

  // G6: excluded authority can only escalate, regardless of evidence or proposed answers.
  if (['approval', 'plan-review'].includes(input.intentKind ?? '')) {
    gap(gaps, 'G6', null, { claim: 'authorization', scope: scopeText, evidenceId: 'none' }, `Request intent ${input.intentKind} requires user escalation`)
  }

  // G7: the complete answer batch must exactly match question ids/order/options/selection shape.
  if (answers.length !== questions.length) {
    gap(gaps, 'G7', 'UNSUPPORTED_OPTIONS', { claim: 'batch', scope: scopeText, evidenceId: 'none' }, `Answer count ${answers.length} does not match question count ${questions.length}`)
  }
  questions.forEach((question, index) => {
    const answer = answers[index]
    const labels = question.options?.map(option => option.label) ?? []
    if (!answer || answer.id !== question.id) {
      gap(gaps, 'G7', 'UNSUPPORTED_OPTIONS', { claim: `question:${question.id}`, scope: scopeText, evidenceId: 'none' }, `Answer ${index} must use question id ${question.id} in original order`)
      return
    }
    const selected = Array.isArray(answer.selected) ? answer.selected : []
    if (selected.some(value => !labels.includes(value)) || (!question.options && selected.length > 0)) {
      gap(gaps, 'G7', 'UNSUPPORTED_OPTIONS', { claim: `question:${question.id}`, scope: scopeText, evidenceId: 'none' }, `Answer ${question.id} selects a value outside the supplied options`)
    }
    if (!question.multiSelect && selected.length > 1) {
      gap(gaps, 'G7', 'UNSUPPORTED_OPTIONS', { claim: `question:${question.id}`, scope: scopeText, evidenceId: 'none' }, `Answer ${question.id} violates single-select shape`)
    }
    if (answer.custom !== undefined && question.options) {
      gap(gaps, 'G7', 'UNSUPPORTED_OPTIONS', { claim: `question:${question.id}`, scope: scopeText, evidenceId: 'none' }, `Answer ${question.id} cannot add custom text to a fixed-option question`)
    }
  })

  const gates = { g1: true, g2: true, g3: true, g4: true, g5: true, g6: true, g7: true, gaps }
  for (const item of gaps) gates[item.gate.toLowerCase()] = false
  return gates
}

/** @param {ReturnType<typeof evaluateGates>} gates */
export function gateFailureOutcome(gates) {
  if (gates.gaps.length === 0) return null
  const first = gates.gaps[0]
  if (first.gate === 'G6') return { outcome: 'escalate', reasonCode: 'AUTHORITY', hint: first.detail, missing: [first.detail] }
  return { outcome: 'return', reasonCode: first.code, hint: first.detail }
}

/** @param {any[]} gaps @param {string} gate @param {string|null} code @param {object} fields @param {string} detail */
function gap(gaps, gate, code, fields, detail) {
  gaps.push({ gate, code, ...fields, detail })
}
