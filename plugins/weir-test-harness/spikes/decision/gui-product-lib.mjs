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

export function mainRegionProblems(audit) {
  const problems = []
  const main = audit?.mainRegion
  if (!main) return ['missing Decision main-region geometry and hit-test evidence']
  const visualWidth = Number(audit?.viewport?.visualWidth ?? audit?.viewport?.width)
  if (!Number.isFinite(visualWidth) || visualWidth <= 0) problems.push('missing real visual width for Decision main region')
  const pageMinimum = Math.min(320, Math.max(1, visualWidth - 24))
  const contentMinimum = Math.min(280, Math.max(1, visualWidth - 24))
  const inspect = (name, target, minimumWidth = 0, required = true) => {
    if (!target) {
      if (required) problems.push(`missing ${name} geometry`)
      return
    }
    const value = target.rect
    if (!value || !['left', 'right', 'top', 'bottom', 'width', 'height'].every(field => Number.isFinite(value[field])) || value.width <= 0 || value.height <= 0) {
      problems.push(`missing finite ${name} CSS rect`)
    } else if (minimumWidth > 0 && value.width + 1 < minimumWidth) {
      problems.push(`${name} lacks readable width: ${value.width} < ${minimumWidth}`)
    }
    if (!Number.isInteger(target.hitTestSamples) || target.hitTestSamples <= 0 || !Array.isArray(target.occlusions)) problems.push(`${name} lacks independent hit-test evidence`)
    for (const hit of target.occlusions ?? []) problems.push(`${name} occluded by foreign hit-test winner at ${hit.x},${hit.y}`)
  }
  const regions = main.regions ?? {}
  inspect('Decision page', regions.page, pageMinimum)
  inspect('Decision inner', regions.inner, pageMinimum)
  for (const name of ['header', 'nav', 'view']) inspect(`Decision ${name}`, regions[name], contentMinimum)
  inspect('Decision title', regions.title)
  for (const [index, card] of (regions.cards ?? []).entries()) inspect(`Decision card ${index + 1}`, card, contentMinimum)
  if (!Array.isArray(main.navigationActions) || main.navigationActions.length !== 3) problems.push('Decision must expose exactly three primary navigation actions')
  for (const action of main.navigationActions ?? []) inspect(`Decision navigation action ${action.name ?? 'unnamed'}`, action)
  for (const action of main.primaryActions ?? []) inspect(`Decision primary action ${action.name ?? 'unnamed'}`, action)
  const ordinaryNarrow = Math.abs((audit?.viewport?.scale ?? 1) - 1) < 0.01 && Number(audit?.viewport?.width) <= 400
  if (ordinaryNarrow && !main.hostNavigation) problems.push('missing visible host navigation return action at ordinary narrow width')
  else if (main.hostNavigation) inspect('host navigation return action', main.hostNavigation)
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

const SELECTOR_FORBIDDEN_COPY = [
  { label: 'Off', pattern: /\bOff\b/i },
  { label: 'Auto', pattern: /\bAuto\b/i },
  { label: 'Shadow', pattern: /\bShadow\b/i },
  { label: 'whitelist', pattern: /白名单|whitelist/i },
  { label: 'A/B/C codes', pattern: /\b[ABC]\s*\/\s*[ABC]\s*\/\s*[ABC]\b|\b[ABC]\s*,\s*[ABC](?:\s*,\s*[ABC])?\b/ },
]

export function selectorCopyProblems(value, expected = {}) {
  const text = typeof value === 'string' ? value : ''
  const problems = SELECTOR_FORBIDDEN_COPY.filter(({ pattern }) => pattern.test(text)).map(({ label }) => `forbidden default selector jargon: ${label}`)
  const zh = expected.language !== 'en'
  const required = zh
    ? [{ label: 'off task label', pattern: /不启用助手/ }, { label: 'auto task label', pattern: /自动选择助手/ }]
    : [{ label: 'off task label', pattern: /Do not use an assistant/i }, { label: 'auto task label', pattern: /Automatically choose an assistant/i }]
  if (expected.emptyScope) required.push({ label: 'empty scope and continued asking', pattern: zh ? /尚未允许自动回答[；;。\s]*新判断仍会询问你/ : /No decisions are currently allowed for automatic answers[;,.\s]*new decisions will still ask you/i })
  if (Number.isInteger(expected.allowedCount)) required.push({ label: `allowedCount ${expected.allowedCount}`, pattern: zh ? new RegExp(`当前允许自动回答\\s*${expected.allowedCount}\\s*类判断`) : new RegExp(`allowed for\\s*${expected.allowedCount}\\s*decision categories`, 'i') })
  if (expected.unknown) required.push({ label: 'unknown automatic-answer state', pattern: zh ? /自动回答状态未知/ : /Automatic-answer status is unknown/i }, { label: 'unknown comparison state', pattern: zh ? /选择对比状态未知/ : /Selection comparison status is unknown/i })
  if (expected.shadow === true) required.push({ label: 'comparison on', pattern: zh ? /选择对比已开启/ : /Selection comparison is on/i })
  if (expected.shadow === false) required.push({ label: 'comparison off', pattern: zh ? /选择对比未开启/ : /Selection comparison is not enabled/i })
  for (const item of required) if (!item.pattern.test(text)) problems.push(`missing ${item.label}`)
  return problems
}
function cssRectProblems(value, label = 'CSS rect') {
  if (!value || typeof value !== 'object') return [`missing ${label}`]
  const fields = ['x', 'y', 'left', 'top', 'width', 'height', 'right', 'bottom']
  const problems = fields.filter(field => !Number.isFinite(value[field])).map(field => `${label} lacks finite ${field}`)
  if (value.width <= 0 || value.height <= 0) problems.push(`${label} must have positive CSS dimensions`)
  return problems
}

export function nativeModalProblems(measurement, options = {}) {
  const problems = []
  if (measurement?.implementation !== 'native-dialog' || measurement?.tagName !== 'DIALOG') problems.push('expected a native <dialog>, not an absolute/fixed substitute')
  if (measurement?.open !== true) problems.push('native dialog is not open')
  if (measurement?.modal !== true) problems.push('native dialog does not match :modal')
  if (measurement?.ariaModal !== 'true') problems.push('native dialog lacks aria-modal=true')
  if (measurement?.showModalCalls !== 1 || measurement?.showModalError !== null) problems.push('showModal must succeed exactly once without an opening error')
  if (options.requireComposer !== false && measurement?.composerContainsDialog !== true) problems.push('native dialog is not mounted from the composer probe origin')
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

export function selectorLayoutProblems(measurement, expected = {}) {
  const problems = [...nativeModalProblems(measurement?.native)]
  const viewport = measurement?.viewport
  const visual = viewport?.visualViewport
  problems.push(...viewportMeasurementProblems(viewport, { scale: expected.scale, withinVisualViewport: ['dialog', 'header', 'body', 'footer'] }))
  const dialog = viewport?.rects?.dialog
  if (dialog && dialog.width > 360 + 1) problems.push(`selector dialog width ${dialog.width} exceeds 360 CSS px`)
  if (dialog && visual) {
    const left = visual.offsetLeft ?? 0
    const top = visual.offsetTop ?? 0
    if (dialog.left < left + 7.5 || dialog.right > left + visual.width - 7.5 || dialog.top < top + 7.5 || dialog.bottom > top + visual.height - 7.5) problems.push('selector dialog does not retain 8 CSS px visual viewport margins')
    if (dialog.height > Math.min(560, visual.height - 16) + 1) problems.push('selector dialog exceeds its compact dynamic-viewport height')
  }
  if (measurement?.native?.backdropCoversVisualViewport !== true) problems.push('native backdrop does not cover the full visual viewport')
  if (measurement?.native?.backgroundInert !== true) problems.push('native modal background is not inert')
  if (measurement?.panelOverflow !== 'hidden') problems.push('selector panel itself must not scroll')
  if (!['auto', 'scroll'].includes(measurement?.bodyOverflow) || measurement?.bodyOverscroll !== 'contain') problems.push('selector body is not an independent contained scroller')
  if (measurement?.horizontalOverflow !== false) problems.push('selector introduces horizontal overflow')
  if (expected.scrollable) {
    if (!(measurement?.bodyScrollHeight > measurement?.bodyClientHeight)) problems.push('selector fixture did not produce a genuinely scrollable body')
    if (!(measurement?.bodyScrollTopAfter > measurement?.bodyScrollTopBefore)) problems.push('selector body did not scroll independently')
  } else {
    if (measurement?.bodyScrollHeight > measurement?.bodyClientHeight + 1) problems.push('few-option selector unexpectedly overflows its body')
    if (measurement?.bodyScrollTopAfter !== measurement?.bodyScrollTopBefore) problems.push('few-option selector body moved without scrollable content')
  }
  for (const [name, before, after] of [['header', measurement?.headerBefore, measurement?.headerAfter], ['footer', measurement?.footerBefore, measurement?.footerAfter]]) {
    if (!before || !after || Math.abs(before.top - after.top) > 0.5 || Math.abs(before.bottom - after.bottom) > 0.5) problems.push(`${name} moved while only the selector body scrolled`)
  }
  return problems
}

export function confirmationFocusProblems({ beforeSettle, afterSettle } = {}) {
  const problems = []
  if (beforeSettle?.promiseSettled !== false || beforeSettle?.targetFocused || beforeSettle?.fallbackFocused) problems.push('confirmation restored focus before the action Promise settled')
  if (afterSettle?.promiseSettled !== true) problems.push('confirmation focus evidence was captured before Promise settlement')
  const valid = target => target?.connected === true && target?.enabled === true && target?.visible === true && target?.focused === true
  if (!valid(afterSettle?.target) && !(valid(afterSettle?.fallback) && afterSettle?.fallback?.logical === true)) problems.push('confirmation did not focus a valid target or logical fallback')
  return problems
}

function validContentMutation(value) {
  return Boolean(
    value && typeof value.method === 'string' && value.method && value.args && typeof value.args === 'object' && !Array.isArray(value.args)
    && typeof value.rpcId === 'string' && value.rpcId && value.response?.rpcId === value.rpcId
    && value.response?.result?.ok === true && value.response?.result?.value?.ok === true
    && value.settled === true && value.authoritative?.confirmed === true
  )
}

function reducedScrollRange(initial, restored, sizeKey, clientKey) {
  const values = [initial?.[sizeKey], initial?.[clientKey], restored?.[sizeKey], restored?.[clientKey]]
  if (!values.every(Number.isFinite)) return null
  const beforeMaximum = Math.max(0, initial[sizeKey] - initial[clientKey])
  const afterMaximum = Math.max(0, restored[sizeKey] - restored[clientKey])
  return restored[sizeKey] < initial[sizeKey] && afterMaximum < beforeMaximum ? afterMaximum : null
}

export function scrollLockProblems({ before, during, after, attempts = [], contentMutation = null }, requiredContainers = [], requiredAttempts = []) {
  const problems = []
  const mutationValid = validContentMutation(contentMutation)
  if (contentMutation !== null && !mutationValid) problems.push('shrunk-content restoration lacks a settled authoritative mutation receipt')
  for (const name of requiredContainers) {
    const initial = before?.[name]
    const locked = during?.[name]
    const restored = after?.[name]
    if (!initial || !locked || !restored) { problems.push(`${name}: missing root/nested scroller measurement`); continue }
    if (locked.inline?.overflow !== 'hidden') problems.push(`${name}: overflow was not locked`)
    if (locked.inline?.overscrollBehavior !== 'none') problems.push(`${name}: overscroll was not contained`)
    if (locked.scrollTop !== initial.scrollTop || locked.scrollLeft !== initial.scrollLeft) problems.push(`${name}: background scroll moved while locked`)
    if (!same(restored.inline, initial.inline)) problems.push(`${name}: inline styles were not restored exactly`)

    const verticalReduction = reducedScrollRange(initial, restored, 'scrollHeight', 'clientHeight')
    const horizontalReduction = reducedScrollRange(initial, restored, 'scrollWidth', 'clientWidth')
    if ((verticalReduction !== null || horizontalReduction !== null) && !mutationValid) problems.push(`${name}: reduced scroll range lacks settled authoritative mutation evidence`)
    const verticalMaximum = mutationValid && locked.scrollHeight === initial.scrollHeight && locked.clientHeight === initial.clientHeight ? verticalReduction : null
    const horizontalMaximum = mutationValid && locked.scrollWidth === initial.scrollWidth && locked.clientWidth === initial.clientWidth ? horizontalReduction : null
    const expectedTop = verticalMaximum === null ? initial.scrollTop : Math.min(Math.max(initial.scrollTop, 0), verticalMaximum)
    const expectedLeft = horizontalMaximum === null ? initial.scrollLeft : Math.min(Math.max(initial.scrollLeft, 0), horizontalMaximum)
    if (restored.scrollTop !== expectedTop) {
      if (verticalMaximum === null) problems.push(`${name}: scroll position was not restored exactly`)
      else problems.push(`${name}: scrollTop ${restored.scrollTop} != clamp(${initial.scrollTop}, ${verticalMaximum}) after confirmed content shrink`)
    }
    if (restored.scrollLeft !== expectedLeft) {
      if (horizontalMaximum === null) problems.push(`${name}: scroll position was not restored exactly`)
      else problems.push(`${name}: scrollLeft ${restored.scrollLeft} != clamp(${initial.scrollLeft}, ${horizontalMaximum}) after confirmed content shrink`)
    }
  }
  for (const type of requiredAttempts) if (!attempts.some(attempt => attempt?.type === type && attempt?.observed === true)) problems.push(`missing observed ${type} background-scroll attempt`)
  return problems
}

export function coldRevealProblems({ loading, ready, refreshed, refreshBaseline }, tolerance = 2) {
  const problems = []
  if (loading?.status !== 'loading' || loading?.revealCount !== 0) problems.push('loading must not trigger a reveal')
  if (!['ready', 'error'].includes(ready?.status)) problems.push('first ready or error content is required')
  if (ready?.revealCount !== 1) problems.push('ready content must reveal exactly once')
  if (ready?.behavior !== 'instant' || ready?.block !== 'end') problems.push('reveal must use instant/end positioning')
  if (!Number.isFinite(ready?.targetBottom) || !Number.isFinite(ready?.scrollerBottom) || Math.abs(ready.targetBottom - ready.scrollerBottom) > tolerance) problems.push('revealed content bottom is not aligned with its actual scroller')
  if (loading?.active !== ready?.active || loading?.draft !== ready?.draft) problems.push('reveal stole focus or changed the input draft')
  const baseline = refreshBaseline ?? ready
  if (!Number.isFinite(refreshed?.targetBottom)) problems.push('refresh unmounted the revealed target')
  if (refreshed?.revealCount !== 1 || refreshed?.scrollTop !== baseline?.scrollTop) problems.push('refresh caused a repeated reveal or scroll jump')
  if (baseline?.active !== refreshed?.active || baseline?.draft !== refreshed?.draft) problems.push('refresh changed focus or draft')
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
  if (returned?.readCount !== drillIn?.readCount) problems.push('Back caused an authority reread')
  if (restored?.readCount !== drillIn?.readCount) problems.push('same-target restoration caused an authority reread')
  return problems
}
