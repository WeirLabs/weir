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

export function selectorEnvelope(sessionId, mode, agentId = null) {
  if (!['off', 'auto', 'agent'].includes(mode)) throw new Error(`unsupported selector mode: ${mode}`)
  if (mode === 'agent' && (typeof agentId !== 'string' || !agentId)) throw new Error('agent selector mode requires agentId')
  return mode === 'agent' ? { sessionId, mode, agentId } : { sessionId, mode }
}

export function selectorMatches(selector, mode, agentId = null) {
  if (mode === 'agent') return selector?.mode === 'agent' && selector?.agentId === agentId
  if (mode === 'off' || mode === 'auto') return selector?.mode === mode && (selector?.agentId ?? null) === null
  return false
}

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

export function routeHistoryProblems(detail, dom) {
  const expected = Array.isArray(detail?.routeDecisions) ? detail.routeDecisions : []
  const actual = Array.isArray(dom?.routeHistory) ? dom.routeHistory : []
  const problems = []
  if (expected.length !== actual.length) problems.push(`route history count ${actual.length} != ${expected.length}`)
  for (let index = 0; index < Math.min(expected.length, actual.length); index += 1) {
    if (String(expected[index]?.createdAt ?? '') !== String(actual[index]?.createdAt ?? '')) problems.push(`route history timestamp ${index} differs`)
    if (!String(actual[index]?.text ?? '').trim()) problems.push(`route history row ${index} is not readable`)
  }
  return problems
}

export function immutableChanges(phases) {
  const attempts = new Map()
  const snapshotContent = new Map()
  const routes = new Map()
  const missingRoutes = new Set()
  const changes = []
  for (const phase of phases) {
    for (const row of phase.rows?.attempts ?? []) {
      const value = JSON.stringify(row)
      if (attempts.has(row.attempt_id) && attempts.get(row.attempt_id) !== value) changes.push({ kind: 'attempt', id: row.attempt_id, phase: phase.phase })
      attempts.set(row.attempt_id, value)
    }
    const presentRoutes = new Set()
    for (const row of phase.rows?.route_decisions ?? []) {
      const value = JSON.stringify(row)
      presentRoutes.add(row.route_decision_id)
      if (routes.has(row.route_decision_id) && routes.get(row.route_decision_id) !== value) changes.push({ kind: 'route', id: row.route_decision_id, phase: phase.phase })
      routes.set(row.route_decision_id, value)
    }
    if (Array.isArray(phase.rows?.route_decisions)) {
      for (const id of routes.keys()) {
        if (!presentRoutes.has(id) && !missingRoutes.has(id)) {
          changes.push({ kind: 'route-missing', id, phase: phase.phase })
          missingRoutes.add(id)
        }
      }
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

function cssRectProblems(value, label = 'CSS rect') {
  if (!value || typeof value !== 'object') return [`missing ${label}`]
  const fields = ['x', 'y', 'left', 'top', 'width', 'height', 'right', 'bottom']
  const problems = fields.filter(field => !Number.isFinite(value[field])).map(field => `${label} lacks finite ${field}`)
  if (value.width <= 0 || value.height <= 0) problems.push(`${label} must have positive CSS dimensions`)
  return problems
}

export function nativeModalProblems(measurement) {
  const problems = []
  if (measurement?.implementation !== 'native-dialog' || measurement?.tagName !== 'DIALOG') problems.push('expected a native <dialog>, not an absolute/fixed substitute')
  if (measurement?.open !== true) problems.push('native dialog is not open')
  if (measurement?.modal !== true) problems.push('native dialog does not match :modal')
  if (measurement?.ariaModal !== 'true') problems.push('native dialog lacks aria-modal=true')
  if (measurement?.showModalCalls !== 1 || measurement?.showModalError !== null) problems.push('showModal must succeed exactly once without an opening error')
  if (measurement?.composerContainsDialog !== true) problems.push('native dialog is not mounted from the composer probe origin')
  if (measurement?.focusInside !== true) problems.push('native modal focus did not enter the dialog')
  problems.push(...cssRectProblems(measurement?.rect, 'native dialog CSS rect'))
  return problems
}

export function viewportMeasurementProblems(measurement, expected = {}) {
  const problems = []
  if (!Number.isFinite(measurement?.innerWidth) || measurement.innerWidth <= 0) problems.push('missing real innerWidth')
  if (!Number.isFinite(measurement?.innerHeight) || measurement.innerHeight <= 0) problems.push('missing real innerHeight')
  if (!Number.isFinite(measurement?.devicePixelRatio) || measurement.devicePixelRatio <= 0) problems.push('missing real devicePixelRatio')
  const visual = measurement?.visualViewport
  if (!Number.isFinite(visual?.scale) || visual.scale <= 0) problems.push('missing real visualViewport.scale')
  if (!Number.isFinite(visual?.width) || visual.width <= 0 || !Number.isFinite(visual?.height) || visual.height <= 0) problems.push('missing real visual viewport dimensions')
  if (expected.innerWidth !== undefined && measurement?.innerWidth !== expected.innerWidth) problems.push(`innerWidth ${measurement?.innerWidth} != ${expected.innerWidth}`)
  if (expected.scale !== undefined && Math.abs((visual?.scale ?? 0) - expected.scale) >= 0.01) problems.push(`visualViewport.scale ${visual?.scale} != ${expected.scale}`)
  for (const [name, value] of Object.entries(measurement?.rects ?? {})) problems.push(...cssRectProblems(value, `CSS rect ${name}`))
  for (const name of expected.withinVisualViewport ?? []) {
    const value = measurement?.rects?.[name]
    if (!value) { problems.push(`missing CSS rect ${name}`); continue }
    const left = visual?.offsetLeft ?? 0
    const top = visual?.offsetTop ?? 0
    if (value.left < left - 1 || value.top < top - 1 || value.right > left + (visual?.width ?? 0) + 1 || value.bottom > top + (visual?.height ?? 0) + 1) problems.push(`CSS rect ${name} is outside the real visual viewport`)
  }
  return problems
}

export function browserZoomProblems(evidence, expectedScale = 2) {
  const problems = []
  if (evidence?.operation?.method !== 'Emulation.setPageScaleFactor' || evidence?.operation?.pageScaleFactor !== expectedScale) problems.push(`real browser zoom requires Emulation.setPageScaleFactor(${expectedScale}) pageScaleFactor evidence`)
  if (expectedScale !== 1 && (evidence?.metricsOperation?.method !== 'Emulation.setDeviceMetricsOverride' || evidence?.metricsOperation?.mobile !== true)) problems.push('real page-scale zoom requires the proven mobile device-metrics path')
  problems.push(...viewportMeasurementProblems(evidence?.before, { scale: 1 }).map(problem => `before zoom: ${problem}`))
  problems.push(...viewportMeasurementProblems(evidence?.after, { scale: expectedScale }).map(problem => `after zoom: ${problem}`))
  const beforeWidth = evidence?.before?.visualViewport?.width
  const afterWidth = evidence?.after?.visualViewport?.width
  if (Number.isFinite(beforeWidth) && Number.isFinite(afterWidth) && beforeWidth > 0 && afterWidth > 0 && Math.abs(beforeWidth / afterWidth - expectedScale) > 0.02) problems.push(`visualViewport CSS width ratio ${beforeWidth / afterWidth} != ${expectedScale}`)
  if (Object.keys(evidence?.after?.rects ?? {}).length === 0) problems.push('real zoom lacks a measured CSS rect')
  return problems
}

export function scrollLockProblems({ before, during, after }, requiredContainers = []) {
  const problems = []
  for (const name of requiredContainers) {
    const initial = before?.[name]
    const locked = during?.[name]
    const restored = after?.[name]
    if (!initial || !locked || !restored) { problems.push(`${name}: missing root/nested scroller measurement`); continue }
    if (locked.inline?.overflow !== 'hidden') problems.push(`${name}: overflow was not locked`)
    if (locked.inline?.overscrollBehavior !== 'none') problems.push(`${name}: overscroll was not contained`)
    if (locked.scrollTop !== initial.scrollTop || locked.scrollLeft !== initial.scrollLeft) problems.push(`${name}: background scroll moved while locked`)
    if (!same(restored.inline, initial.inline)) problems.push(`${name}: inline styles were not restored exactly`)
    if (restored.scrollTop !== initial.scrollTop || restored.scrollLeft !== initial.scrollLeft) problems.push(`${name}: scroll position was not restored exactly`)
  }
  return problems
}

export function coldRevealProblems({ loading, ready, refreshed }, tolerance = 2) {
  const problems = []
  if (loading?.status !== 'loading' || loading?.revealCount !== 0) problems.push('loading must not trigger a reveal')
  if (!['ready', 'error'].includes(ready?.status)) problems.push('first ready or error content is required')
  if (ready?.revealCount !== 1) problems.push('ready content must reveal exactly once')
  if (ready?.behavior !== 'instant' || ready?.block !== 'end') problems.push('reveal must use instant/end positioning')
  if (!Number.isFinite(ready?.targetBottom) || !Number.isFinite(ready?.scrollerBottom) || Math.abs(ready.targetBottom - ready.scrollerBottom) > tolerance) problems.push('revealed content bottom is not aligned with its actual scroller')
  if (loading?.active !== ready?.active || loading?.draft !== ready?.draft) problems.push('reveal stole focus or changed the input draft')
  if (refreshed?.revealCount !== 1 || refreshed?.scrollTop !== ready?.scrollTop) problems.push('refresh caused a repeated reveal or scroll jump')
  if (ready?.active !== refreshed?.active || ready?.draft !== refreshed?.draft) problems.push('refresh changed focus or draft')
  return problems
}

export function masterDetailProblems({ desktop, narrowList, drillIn, returned, restored }) {
  const problems = []
  if (!desktop?.listVisible || !desktop?.detailVisible || desktop?.independentRegions !== true) problems.push('desktop must retain an independent list and detail region')
  problems.push(...cssRectProblems(desktop?.listRect, 'desktop list CSS rect'), ...cssRectProblems(desktop?.detailRect, 'desktop detail CSS rect'))
  if (!narrowList?.listVisible || narrowList?.detailVisible) problems.push('narrow list must start without a visible detail')
  if (drillIn?.listVisible || !drillIn?.detailVisible) problems.push('narrow drill-in must show only detail')
  if (!returned?.listVisible || returned?.detailVisible) problems.push('Back must restore the narrow list view')
  if (restored?.listVisible || !restored?.detailVisible) problems.push('same-target restoration must reopen only detail')
  for (const [name, value] of Object.entries({ desktop, narrowList, drillIn, returned, restored })) if (value?.horizontalOverflow !== false) problems.push(`${name}: horizontal overflow evidence is missing or failing`)
  for (const [name, stage] of [['returned', returned], ['restored', restored]]) {
    if (stage?.selectedAgentId !== drillIn?.selectedAgentId) problems.push(`${name}: selected assistant changed`)
    if (!same(stage?.draft, drillIn?.draft)) problems.push(`${name}: exact draft changed`)
    if (!same(stage?.learning, drillIn?.learning)) problems.push(`${name}: learning review context changed`)
  }
  if (restored?.readCount !== drillIn?.readCount) problems.push('same-target restoration caused an authority reread')
  return problems
}
