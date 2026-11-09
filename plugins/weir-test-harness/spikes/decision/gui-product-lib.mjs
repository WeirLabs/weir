// Pure guards shared by the real Desktop product-UX driver and focused tests.
// No DOM implementation lives here: layout/accessibility facts come from CDP.

export function parseDecisionRequest(url, postData) {
  if (!String(url).includes('/api/weirDecision/')) return null
  let body
  try { body = JSON.parse(postData) } catch { return { method: null, args: null, rpcId: null, raw: postData } }
  const args = body?.payload?.args?.args ?? body?.payload?.args ?? body?.args ?? null
  return {
    method: typeof body?.method === 'string' ? body.method.split('/').at(-1) : String(url).split('/').at(-1),
    args,
    rpcId: body?.rpcId ?? body?.id ?? null,
    request: body,
  }
}

// Composes the CSS selector first, then JSON-encodes it once: a literal
// `${article} form.weir-da-answers` splice produces invalid browser source.
export function answerFormExpression(caseId) {
  const selector = `article[data-case-id="${caseId}"] form.weir-da-answers`
  return `Boolean(document.querySelector(${JSON.stringify(selector)}))`
}

function same(left, right) {
  if (Object.is(left, right)) return true
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false
  if (Array.isArray(left) !== Array.isArray(right)) return false
  const a = Array.isArray(left) ? left : Object.keys(left).sort()
  const b = Array.isArray(right) ? right : Object.keys(right).sort()
  if (a.length !== b.length) return false
  if (Array.isArray(left)) return left.every((value, index) => same(value, right[index]))
  return a.every((key, index) => key === b[index] && same(left[key], right[key]))
}

export function exactArgs(left, right) { return same(left, right) }

export function exactMutation(entries, method, args) {
  const matches = entries.filter(entry => entry.method === method && same(entry.args, args))
  if (matches.length !== 1) throw new Error(`Expected exactly one ${method} RPC with exact args; found ${matches.length}`)
  const entry = matches[0]
  if (!entry.rpcId || !entry.response) throw new Error(`${method} lacks raw rpcId or response evidence`)
  return entry
}

export function layoutProblems(audit) {
  const problems = []
  if (!audit || audit.viewport?.width <= 0) problems.push('missing real viewport')
  if (audit?.document?.horizontalOverflow) problems.push('document horizontal overflow')
  for (const item of audit?.surfaceOverflow ?? []) problems.push(`surface horizontal overflow: ${item}`)
  for (const item of audit?.clippedPrimary ?? []) problems.push(`clipped primary action: ${item}`)
  for (const item of audit?.unnamedControls ?? []) problems.push(`unnamed control: ${item}`)
  for (const item of audit?.internalVocabulary ?? []) problems.push(`default-view internal vocabulary: ${item}`)
  return problems
}

export function recordProjectionProblems(detail, dom) {
  const problems = []
  const current = detail?.case
  if (!current || !dom) return ['missing authoritative record or rendered projection']
  if (dom.caseId !== current.caseId) problems.push('rendered record caseId differs')
  for (const question of current.request?.questions ?? []) {
    if (!dom.defaultText.includes(question.question)) problems.push(`missing question ${question.id}`)
    const answer = current.decision?.answers?.find(item => item.id === question.id)
    for (const value of [...(answer?.selected ?? []), ...(answer?.custom ? [answer.custom] : [])]) {
      if (!dom.defaultText.includes(value)) problems.push(`missing answer ${question.id}:${value}`)
    }
  }
  const currentAttempt = (current.decision?.attemptId
    ? detail.attempts?.find(attempt => attempt.attemptId === current.decision.attemptId)
    : null) ?? detail.attempts?.at(-1)
  for (const evidence of currentAttempt?.evidence ?? []) {
    if (evidence.excerpt && !dom.currentEvidence.includes(evidence.excerpt)) problems.push(`missing current evidence ${evidence.evidenceId}`)
  }
  if (dom.defaultText.includes(current.caseId)) problems.push('default view leaks caseId')
  if (!dom.advancedText.includes(current.caseId)) problems.push('advanced diagnostics omit caseId')
  return problems
}

// Spec requires the correction preview to state three facts: the scope it applies
// to, the answer it supersedes, and that only future judgments change. Labels are
// localized ("适用于" / "Applies to"), so match their meaning, not one literal
// string (run wab8MC: an `/scope|适用范围/` oracle rejected a correct preview).
const CORRECTION_PREVIEW_FACTS = [
  { fact: 'scope', pattern: /适用于|适用范围|applies to|scope/i },
  { fact: 'superseded answer', pattern: /取代|supersedes/i },
  { fact: 'future-only consequence', pattern: /只影响|future/i },
]

export function correctionPreviewProblems(preview) {
  const text = typeof preview === 'string' ? preview : ''
  if (!text.trim()) return ['missing correction preview']
  return CORRECTION_PREVIEW_FACTS
    .filter(({ pattern }) => !pattern.test(text))
    .map(({ fact }) => `correction preview omits ${fact}`)
}

export function immutableChanges(phases) {
  const attempts = new Map()
  const snapshotContent = new Map()
  const changes = []
  for (const phase of phases) {
    for (const row of phase.rows?.attempts ?? []) {
      const value = JSON.stringify(row)
      if (attempts.has(row.attempt_id) && attempts.get(row.attempt_id) !== value) changes.push({ kind: 'attempt', id: row.attempt_id, phase: phase.phase })
      attempts.set(row.attempt_id, value)
    }
    for (const row of phase.rows?.memory_snapshots ?? []) {
      const value = JSON.stringify({
        version: row.version, parent_snapshot_id: row.parent_snapshot_id,
        principles_json: row.principles_json, generated_description_json: row.generated_description_json,
        learning_run_id: row.learning_run_id, created_at: row.created_at, schema_version: row.schema_version,
      })
      if (snapshotContent.has(row.snapshot_id) && snapshotContent.get(row.snapshot_id) !== value) changes.push({ kind: 'snapshot-content', id: row.snapshot_id, phase: phase.phase })
      snapshotContent.set(row.snapshot_id, value)
    }
  }
  return changes
}
