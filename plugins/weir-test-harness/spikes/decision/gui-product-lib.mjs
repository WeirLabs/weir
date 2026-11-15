// Pure guards shared by the real Desktop product-UX driver and focused tests.
// No DOM implementation lives here: layout/accessibility facts come from CDP.
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'

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
  // Compact padding and a real scrollbar can consume 32 CSS px at 200% zoom.
  const contentMinimum = Math.min(280, Math.max(1, visualWidth - 32))
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
  if (ordinaryNarrow) {
    if (!main.hostNavigation) problems.push('missing visible host navigation return action at ordinary narrow width')
    else inspect('host navigation return action', main.hostNavigation)
  }
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
  if (expected.emptyScope) required.push(
    { label: 'routes but does not auto-answer', pattern: zh ? /仍会自动选择助手/ : /still chosen to evaluate/i },
    { label: 'empty scope and continued asking', pattern: zh ? /自动回答尚未允许[；;，,。\s]*新判断仍会询问你/ : /not allowed yet[;,.\s]*new decisions will still ask you/i })
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
  if (expected.longStatus) {
    const status = measurement?.longStatus
    const text = expected.longStatus.text
    if (!status || status.expected !== text || status.actual !== text) problems.push('selector lacks the exact long bilingual product status text')
    if (status?.role !== 'alert') problems.push('long product status is not a visible alert')
    if (status?.whiteSpace !== 'normal' || !['anywhere', 'break-word'].includes(status?.overflowWrap)) problems.push('long product status does not use natural wrapping')
    if (!Number.isFinite(status?.clientWidth) || !Number.isFinite(status?.scrollWidth) || status.scrollWidth > status.clientWidth + 1) problems.push('long product status introduces horizontal wrapping overflow')
    if (!Number.isFinite(status?.rectHeight) || !Number.isFinite(status?.lineHeight) || status.rectHeight <= status.lineHeight * 1.5) problems.push('long product status did not wrap to multiple rendered lines')
    const actionName = expected.longStatus.language === 'en' ? /Retry/i : /重试/
    if (!status?.primaryAction?.visible || !status?.primaryAction?.hitTest || !actionName.test(status?.primaryAction?.accessibleName ?? '')) problems.push('long product status primary action is not reachable')
    if (status?.primaryAction?.keyboard?.reached !== true) problems.push('long product status primary action lacks native keyboard reachability evidence')
    const ax = Array.isArray(status?.ax) ? status.ax : []
    if (!ax.some(node => !node.ignored && node.role === 'alert') || !ax.some(node => !node.ignored && String(node.name ?? '').includes(text))) problems.push('long product status lacks accessible alert and exact long-text evidence')
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
    if (locked.inline?.overflowAnchor !== 'none') problems.push(`${name}: browser scroll anchoring was not disabled`)
    if (locked.scrollTop !== initial.scrollTop || locked.scrollLeft !== initial.scrollLeft) problems.push(`${name}: background scroll moved while locked`)
    if (!same(restored.inline, initial.inline)) problems.push(`${name}: inline styles were not restored exactly`)

    const verticalReduction = reducedScrollRange(initial, restored, 'scrollHeight', 'clientHeight')
    const horizontalReduction = reducedScrollRange(initial, restored, 'scrollWidth', 'clientWidth')
    const verticalClampRequired = verticalReduction !== null && initial.scrollTop > verticalReduction
    const horizontalClampRequired = horizontalReduction !== null && initial.scrollLeft > horizontalReduction
    if ((verticalClampRequired || horizontalClampRequired) && !mutationValid) problems.push(`${name}: reduced scroll range lacks settled authoritative mutation evidence`)
    const verticalMaximum = verticalClampRequired && mutationValid && locked.scrollHeight === initial.scrollHeight && locked.clientHeight === initial.clientHeight ? verticalReduction : null
    const horizontalMaximum = horizontalClampRequired && mutationValid && locked.scrollWidth === initial.scrollWidth && locked.clientWidth === initial.clientWidth ? horizontalReduction : null
    const expectedTop = verticalMaximum === null ? initial.scrollTop : Math.min(Math.max(initial.scrollTop, 0), verticalMaximum)
    const expectedLeft = horizontalMaximum === null ? initial.scrollLeft : Math.min(Math.max(initial.scrollLeft, 0), horizontalMaximum)
    // scrollHeight/clientHeight are integer-rounded while the layout itself is
    // fractional, so the real maximum a browser clamps to can sit half a pixel past
    // the rounded maximum. Only that sub-pixel rounding is tolerated: a whole-pixel
    // deviation is still a failure, and an exact restoration must match exactly.
    if (verticalMaximum === null ? restored.scrollTop !== expectedTop : Math.abs(restored.scrollTop - expectedTop) > 0.75) {
      if (verticalMaximum === null) problems.push(`${name}: scroll position was not restored exactly`)
      else problems.push(`${name}: scrollTop ${restored.scrollTop} != clamp(${initial.scrollTop}, ${verticalMaximum}) after confirmed content shrink`)
    }
    if (horizontalMaximum === null ? restored.scrollLeft !== expectedLeft : Math.abs(restored.scrollLeft - expectedLeft) > 0.75) {
      if (horizontalMaximum === null) problems.push(`${name}: scroll position was not restored exactly`)
      else problems.push(`${name}: scrollLeft ${restored.scrollLeft} != clamp(${initial.scrollLeft}, ${horizontalMaximum}) after confirmed content shrink`)
    }
  }
  for (const type of requiredAttempts) if (!attempts.some(attempt => attempt?.type === type && attempt?.observed === true)) problems.push(`missing observed ${type} background-scroll attempt`)
  return problems
}

export function shutdownSocketClosureEntries(logs = {}) {
  return Object.entries(logs).flatMap(([path, contents]) => String(contents ?? '').split('\n').flatMap((text, index) => /\[TypeError: fetch failed\]|SocketError: other side closed/i.test(text) ? [{
    scope: 'desktop-shutdown-socket-closure-stderr', path, line: index + 1, text,
    countsAsRuntimeError: false, countsAsImportFailure: false,
  }] : []))
}

export function sessionScrollerProblems(audit) {
  const problems = []
  const proof = audit?.sessionIdentity
  if (!proof) return ['missing session scroller identity or absence justification']
  if (proof.originConnected !== true) problems.push('session scroller origin is not connected')
  if (proof.required === false) {
    if (proof.relation !== 'not-present' || !Array.isArray(proof.ancestorChain) || proof.ancestorChain.length !== 0) problems.push('session absence lacks a not-present proof with an empty real overflow-ancestor chain')
    for (const phase of ['before', 'during', 'after']) if (audit?.[phase]?.session) problems.push(`${phase}: session evidence contradicts the not-present justification`)
    return problems
  }
  if (proof.required !== true) problems.push('session scroller requirement is not explicit')
  const shared = proof.relation === 'same-element'
  const distinct = proof.relation === 'distinct-element'
  if (!shared && !distinct) problems.push('session scroller relation must be same-element or distinct-element')
  if (shared && (proof.sameElement !== true || proof.aliasOf !== 'composer' || proof.onlyOneOverflowAncestor !== true || !same(proof.composer, proof.session))) problems.push('shared session evidence lacks explicit same-element composer alias proof')
  if (distinct && (proof.sameElement !== false || proof.aliasOf !== null || proof.onlyOneOverflowAncestor !== false || same(proof.composer, proof.session))) problems.push('distinct session evidence lacks a separate real identity')
  for (const phase of ['before', 'during', 'after']) {
    const session = audit?.[phase]?.session
    if (!session) { problems.push(`${phase}: missing named session scroller measurement`); continue }
    if (shared && (session.sameElement !== true || session.aliasOf !== 'composer' || !same(session.identity, audit?.[phase]?.composer?.identity))) problems.push(`${phase}: session alias differs from the real composer element`)
    if (distinct && (session.sameElement !== false || session.aliasOf !== null || !same(session.identity, proof.session))) problems.push(`${phase}: distinct session identity differs from the measured ancestor`)
  }
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
  for (const [name, value] of Object.entries({ desktop, narrowList, drillIn, returned, restored })) {
    if (value?.horizontalOverflow !== false) problems.push(`${name}: horizontal overflow evidence is missing or failing`)
    const focus = value?.focus
    if (!focus?.selector) problems.push(`${name}: missing intended activeElement focus evidence`)
    else {
      if (focus.connected !== true) problems.push(`${name}: focus target is not connected`)
      if (focus.visible !== true) problems.push(`${name}: focus target is not visible`)
      if (focus.active !== true || ['body', 'html'].includes(focus.activeTag)) problems.push(`${name}: intended activeElement was not reached`)
    }
  }
  for (const [name, stage] of [['returned', returned], ['restored', restored]]) {
    if (stage?.selectedAgentId !== drillIn?.selectedAgentId) problems.push(`${name}: selected assistant changed`)
    if (!same(stage?.draft, drillIn?.draft)) problems.push(`${name}: exact draft changed`)
    if (!same(stage?.learning, drillIn?.learning)) problems.push(`${name}: learning review context changed`)
  }
  if (returned?.readCount !== drillIn?.readCount) problems.push('Back caused an authority reread')
  if (restored?.readCount !== drillIn?.readCount) problems.push('same-target restoration caused an authority reread')
  return problems
}

// ---------------------------------------------------------------------------
// Cross-workspace memory matrix guards (OpenSpec 6.7).
//
// The real Desktop matrix records DOM and RPC facts; these pure guards decide
// whether those facts satisfy the shared-identity contract. They never inspect
// a component tree: everything comes from a real isolated Electron run.
// ---------------------------------------------------------------------------

/** The assistant detail must show two memory zones and nothing fabricated. */
export function memoryZoneProblems(audit = {}) {
  const problems = []
  const zones = audit.zones ?? {}
  if (!zones.public || !zones.workspace) problems.push('assistant detail must render both memory zones')
  const headings = (audit.headings ?? []).map(String)
  if (!headings.some(text => /公共记忆|Public memory/i.test(text))) problems.push('missing the public memory heading')
  if (!headings.some(text => /当前工作区经验|Current workspace experience/i.test(text))) problems.push('missing the current workspace experience heading')
  if (!/不是判断依据|not evidence/i.test(String(audit.guidance ?? ''))) problems.push('public memory must say it is guidance, not evidence')
  if (!/只在.{0,12}工作区|only .{0,16}workspace/i.test(String(audit.privateIsolation ?? ''))) problems.push('the private zone must say it is workspace-local')
  const text = String(audit.text ?? '')
  for (const path of audit.workspacePaths ?? []) if (path && text.includes(path)) problems.push(`default detail shows a workspace path: ${path}`)
  for (const id of audit.foreignRecordIds ?? []) if (id && text.includes(id)) problems.push(`default detail shows a foreign record id: ${id}`)
  if (!Array.isArray(audit.navigation) || audit.navigation.length !== 3) problems.push('assistant detail must keep exactly three primary navigation actions')
  const controls = (audit.controls ?? []).map(item => String(item?.text ?? item))
  if (controls.some(label => /自动发布|发布全部|publish automatically|auto[- ]?publish/i.test(label))) problems.push('no automatic publication control may exist')
  const status = audit.status ?? {}
  if (status.present === true && (status.role !== 'status' || status.live !== 'polite')) problems.push('the public zone status must be a polite live region')
  const disclosure = audit.disclosure ?? {}
  if (disclosure.required === true) {
    if (disclosure.acknowledge !== true) problems.push('the first public review must offer an explicit acknowledgement control')
    if (audit.candidate?.present === true) problems.push('no candidate may be reviewable before the disclosure acknowledgement')
  }
  const candidate = audit.candidate ?? {}
  if (candidate.present === true) {
    if (candidate.replay !== 'passed') problems.push('the candidate review must show its structural replay result')
    const aliases = candidate.aliases ?? []
    if (!aliases.length) problems.push('the candidate review must group sources by opaque workspace alias')
    for (const alias of aliases) if (!/^origin_[0-9a-f]{6,}$/.test(String(alias))) problems.push(`public source alias is not opaque: ${alias}`)
    if (candidate.readableLinks > 0) problems.push('public sources must never offer foreign record navigation')
    if (!(candidate.adopt === true && candidate.discard === true)) problems.push('the candidate review must expose an explicit adopt and discard')
    if (candidate.adoptOnRender === true) problems.push('adoption must never happen on render; it needs an explicit confirmation')
  }
  if (audit.current?.version != null && audit.current.rollback !== true) problems.push('a published public version must expose rollback')
  return problems
}

const FAIL_CLOSED_CODES = new Set(['OUT_OF_SCOPE', 'FORBIDDEN', 'PERMISSION_DENIED'])
// The two product paths that answer a foreign private read with an empty body.
const NULL_BODY_METHODS = new Set(['record', 'records'])
// Both learning read paths deny with an explicit code AND one audit record.
const AUDITED_DENIAL_METHODS = ['learningRun', 'memorySnapshot']

/**
 * Two workspaces of one profile share identity and public memory, never records.
 * Denials must fail closed in the shape the product really produces: `record`
 * returns an empty body, the learning reads return an explicit denial code with
 * an audit record that carries ids and state only. A placeholder version or an
 * unexercised read path is a problem, never a pass.
 */
export function crossWorkspaceShareProblems(audit = {}) {
  const problems = []
  const workspaces = audit.workspaces ?? []
  if (workspaces.length < 2) return ['the cross-workspace matrix needs at least two real workspaces']
  const identities = workspaces.map(item => (item.assistantNames ?? []).join('|'))
  if (new Set(identities).size !== 1) problems.push('both workspaces must see the same assistant identities')
  const versions = workspaces.map(item => item.publicVersion)
  if (versions.some(version => !Number.isInteger(version) || version < 1)) problems.push('every workspace must report the public version it really rendered, not a placeholder')
  else if (new Set(versions).size !== 1) problems.push('both workspaces must see the same public version')
  const sets = workspaces.map(item => new Set(item.privateRecordIds ?? []))
  if (sets.some((set, index) => [...set].some(id => sets.some((other, at) => at !== index && other.has(id))))) problems.push('private records must never be readable across workspaces')
  for (const item of workspaces) {
    for (const path of audit.workspacePaths ?? []) if (path && String(item.text ?? '').includes(path)) problems.push(`${item.label ?? 'workspace'}: assistant detail shows a workspace path`)
    if (!Array.isArray(item.navigation) || item.navigation.length !== 3) problems.push(`${item.label ?? 'workspace'}: navigation must stay three actions`)
  }
  const denials = audit.denials ?? []
  if (!denials.length) problems.push('the matrix must prove cross-workspace private record denials')
  const exercised = new Set(denials.map(item => String(item?.method ?? '')))
  if (!exercised.has('record')) problems.push('the private denial probe never exercised record')
  for (const method of AUDITED_DENIAL_METHODS) if (!exercised.has(method)) problems.push(`the private denial probe never exercised ${method}`)
  for (const denial of denials) {
    const method = String(denial?.method ?? '')
    if (denial?.bodyLeaked === true) problems.push(`private record denial ${method} leaked body text`)
    if (denial?.shape === 'null') {
      if (!NULL_BODY_METHODS.has(method)) problems.push(`private read ${method} must not silently return an empty body`)
      else if (denial.returnedNull !== true) problems.push(`private read ${method} did not return an empty body`)
    } else if (denial?.shape === 'error') {
      if (!FAIL_CLOSED_CODES.has(String(denial.code ?? ''))) problems.push(`private read ${method} did not fail closed`)
      const receipt = denial.audit ?? null
      if (!receipt || receipt.recorded !== true || receipt.action !== 'boundary-reject' || receipt.code !== denial.code || receipt.idsOnly !== true) {
        problems.push(`private read ${method} denial is not audited with ids and state only`)
      }
    } else {
      problems.push(`private read ${method} did not fail closed`)
    }
  }
  const auto = audit.autoShare ?? {}
  if (auto.selectorAccepted !== true) problems.push('the shared assistant must stay selectable from the other workspace Auto path')
  if (auto.answered === true && (auto.attemptCount ?? 0) === 0) problems.push('an Auto answer must come from a real current-workspace Attempt')
  if (auto.answered === true && (auto.citedEvidenceCount ?? 0) === 0) problems.push('an Auto answer must cite current-workspace evidence, never public memory alone')
  if (auto.answered !== true) {
    // With no current-workspace L5 the only legal non-answer is an escalated,
    // evidence-free Attempt that waits for the user — never a public-memory answer.
    const escalated = (auto.attemptCount ?? 0) >= 1 && auto.lastAttemptOutcome === 'escalate' && (auto.citedEvidenceCount ?? 0) === 0
    const reasons = ['no_route', 'route_ambiguous', 'authority', 'exhausted', 'partial_batch', 'interrupted']
    if (!escalated && !reasons.includes(String(auto.awaitingReason ?? ''))) problems.push('an unanswered Auto request must fail closed by escalating with no cited evidence or a real awaiting reason')
    if ((auto.citedEvidenceCount ?? 0) > 0) problems.push('an unanswered Auto request must not carry cited evidence it never validated')
  }
  return problems
}

/**
 * The real migrated legacy profile, read from the live surface twice (boot and
 * restart): identity survives, the old private Snapshot stays owned by its own
 * workspace, the public zone starts and stays empty, and no history row is
 * rewritten, added or resurrected by the boots.
 */
export function legacyLiveSurfaceProblems(audit = {}) {
  const problems = []
  const expected = audit.expected ?? {}
  const boot = audit.boot ?? {}
  const restart = audit.restart ?? {}
  const history = audit.history ?? {}
  if (!Array.isArray(boot.agents) || boot.agents.length === 0) return ['the migrated legacy profile was never read through the rendered surface']
  const bootIds = boot.agents.map(agent => agent.agentId)
  for (const id of expected.agentIds ?? []) if (!bootIds.includes(id)) problems.push(`migrated assistant ${id} is missing from the live profile`)
  for (const agent of boot.agents) {
    const wanted = expected.names?.[agent.agentId]
    if (wanted !== undefined && agent.name !== wanted) problems.push(`migrated assistant ${agent.agentId} lost its name`)
    if (agent.hasWorkspaces === true) problems.push(`migrated assistant ${agent.agentId} still scopes by workspace membership`)
  }
  if (!Array.isArray(boot.renderedIds)) problems.push('the rendered management page was never read')
  else for (const id of expected.agentIds ?? []) if (!boot.renderedIds.includes(id)) problems.push(`the rendered management page does not list migrated assistant ${id}`)
  // Workspace-local rows that shared one display name must survive as distinct,
  // listable identities: no row is merged and no name stays ambiguous.
  if (new Set(boot.agents.map(agent => agent.name)).size !== boot.agents.length) problems.push('the migrated assistants must keep distinct display names after their workspace-local names collapsed into one shared identity')
  if (Array.isArray(expected.agentIds) && boot.agents.length !== expected.agentIds.length) problems.push('the live profile must list exactly the migrated assistants, with no identity merged or copied')
  for (const path of audit.legacyWorkspacePaths ?? []) if (path && String(boot.pageText ?? '').includes(path)) problems.push(`the rendered page exposes a legacy workspace path: ${path}`)
  if (boot.public?.currentVersion != null) problems.push('a migrated legacy profile must not show a public version')
  if (boot.public?.candidate === true) problems.push('a migrated legacy profile must not resurrect a public candidate')
  if ((boot.public?.publishedSnapshots ?? -1) !== 0 || (boot.public?.learningRuns ?? -1) !== 0) problems.push('a migrated legacy profile must start with an empty public zone')
  if (boot.attemptPin?.memorySnapshotId !== expected.attemptPinSnapshotId) problems.push('the old Attempt pin must still resolve to its migrated Snapshot')
  if (boot.snapshot?.zone !== 'workspace' || boot.snapshot?.namespace_workspace_key !== expected.privateWorkspaceKey) problems.push('the migrated Snapshot must keep its own private namespace')
  if (boot.currentSnapshotId != null) problems.push('a foreign workspace must not see the legacy private Snapshot as current')
  const denials = boot.denials ?? []
  if (denials.length < 2) problems.push('the legacy surface must prove both private read paths fail closed')
  for (const denial of denials) {
    if (denial?.shape !== 'error' || !FAIL_CLOSED_CODES.has(String(denial.code ?? '')) || denial.bodyLeaked === true) problems.push(`reading ${denial?.method ?? 'a private record'} from another workspace did not fail closed`)
    if (denial?.audit?.recorded !== true || denial?.audit?.idsOnly !== true || denial?.audit?.code !== denial?.code) problems.push(`reading ${denial?.method ?? 'a private record'} from another workspace is not audited with ids and state only`)
  }
  if (JSON.stringify(restart.agents ?? null) !== JSON.stringify(boot.agents)) problems.push('restarting the migrated profile changed assistant identity')
  if (restart.currentSnapshotId !== boot.currentSnapshotId) problems.push('restarting the migrated profile changed private memory visibility')
  if (restart.public?.currentVersion != null || restart.public?.candidate === true || (restart.public?.publishedSnapshots ?? -1) !== 0 || (restart.public?.learningRuns ?? -1) !== 0) problems.push('restarting the migrated profile resurrected public memory')
  if (JSON.stringify(restart.denials ?? null) !== JSON.stringify(boot.denials ?? null)) problems.push('restarting the migrated profile changed the private denial behaviour')
  if (history.afterRestart?.integrityCheck !== 'ok') problems.push('the migrated database must still pass integrity_check after the live boots')
  const before = history.before?.tables ?? {}
  if (!Object.keys(before).length) problems.push('the migrated history was never measured before the live boots')
  for (const [table, baseline] of Object.entries(before)) {
    for (const [label, digest] of [['boot', history.afterBoot], ['restart', history.afterRestart]]) {
      const current = digest?.tables?.[table]
      if (current?.rows !== baseline.rows) problems.push(`${table} gained or lost rows while the migrated profile ran (${label})`)
      if (current?.digest !== baseline.digest) problems.push(`${table} bytes changed while the migrated profile ran (${label})`)
    }
  }
  return problems
}

/** A migrated legacy profile keeps identity + private history and starts public-empty. */
export function legacyMigratedProfileProblems(report = {}) {
  const problems = []
  if (report?.versions?.after !== 2) problems.push('the migrated legacy profile must report user_version 2')
  if (!Array.isArray(report?.profilesAfterMigration) || report.profilesAfterMigration.length === 0) problems.push('migration must keep every legacy Agent identity')
  for (const profile of report?.profilesAfterMigration ?? []) {
    if (profile.hasWorkspaceKeyField === true) problems.push(`profile ${profile.agentId} still exposes a workspace identity field`)
    if (Object.hasOwn(profile.scope ?? {}, 'workspaces')) problems.push(`profile ${profile.agentId} still scopes by workspace membership`)
  }
  if (report?.rowCounts?.noRowLoss !== true) problems.push('migration must not lose rows')
  for (const [table, unchanged] of Object.entries(report?.recordBytesUnchanged ?? {})) if (unchanged !== true) problems.push(`${table} bytes changed during migration`)
  if (report?.integrityCheck !== 'ok') problems.push('the migrated database must pass integrity_check')
  if ((report?.publicZone?.publishedSnapshots ?? -1) !== 0) problems.push('a migrated legacy profile must start with no published public Snapshot')
  if ((report?.publicZone?.learningRuns ?? -1) !== 0) problems.push('a migrated legacy profile must start with no public Learning Run')
  if (report?.publicZone?.currentPublicSnapshot != null) problems.push('a migrated legacy profile must start with an empty public zone')
  const snapshots = report?.privateMemory?.snapshots ?? []
  if (!snapshots.length) problems.push('existing private Snapshots must survive migration')
  for (const snapshot of snapshots) if (snapshot.zone !== 'workspace' || !snapshot.namespaceWorkspaceKey) problems.push(`Snapshot ${snapshot.snapshotId} did not migrate to its own workspace zone`)
  if (report?.privateMemory?.currentOtherWorkspace != null) problems.push('private memory must not be readable from another workspace after migration')
  if (report?.attemptPins?.memorySnapshotId && report?.attemptPinSnapshot?.zone !== 'workspace') problems.push('an old Attempt pin must still resolve to a private Snapshot')
  const backups = report?.backups ?? []
  if (!backups.length) problems.push('migration must keep a v1 backup available for rollback')
  for (const backup of backups) if (backup.userVersion !== 1) problems.push(`backup ${backup.name} is not the pre-migration v1 database`)
  if (report?.walSidecarsLeft === true) problems.push('migration must not leave stale WAL/SHM sidecars')
  if (report?.currentAppTouched === true) problems.push('migration must never touch the current App data')
  return problems
}

/**
 * Stage a migrated legacy profile into an isolated Electron root before boot.
 * The generator uses production migration code on a genuine v1 database; the
 * result is copied into the isolated profile's own decisions directory only.
 */
export function stageMigratedLegacyProfile({ root, lane, execPath = process.execPath }) {
  const out = join(root, 'legacy-profile')
  mkdirSync(out, { recursive: true })
  const generated = spawnSync(execPath, [join(lane, 'plugins/weir-test-harness/spikes/decision/migration-fixture.mjs'), out], {
    cwd: lane, encoding: 'utf8', timeout: 180_000,
  })
  const reportPath = join(out, 'fixture-report.json')
  const report = existsSync(reportPath) ? JSON.parse(readFileSync(reportPath, 'utf8')) : null
  const source = join(out, 'fixture-v1-migrated.db')
  // The migrated database must be the store the live isolated instance opens:
  // a copy parked beside it could never be booted, rendered or restarted.
  const target = join(root, 'home', 'weir', 'profiles', 'desktop', 'decisions', 'decision.db')
  mkdirSync(dirname(target), { recursive: true })
  for (const suffix of ['', '-wal', '-shm']) rmSync(`${target}${suffix}`, { force: true })
  if (existsSync(source)) copyFileSync(source, target)
  return { out, reportPath, report, target, exitCode: generated.status, stderr: String(generated.stderr ?? '').slice(-2000) }
}

// ---------------------------------------------------------------------------
// Task 7.3 public-memory layers: pinned guidance, explicit rejection, real
// per-workspace attribution and the candidate-body leak scan. They judge facts a
// live isolated Desktop run recorded; nothing here fabricates a projection.
// ---------------------------------------------------------------------------

/**
 * With a public version published, an Attempt from a workspace with no eligible
 * private experience must pin that exact public Snapshot, receive its
 * principles as guidance with no evidence mapping, and still refuse to answer.
 * One drifted pin, one invented evidence link or one answer fails the guard.
 */
export function publicGuidancePinProblems(audit = {}) {
  const problems = []
  const published = audit.published ?? {}
  const attempt = audit.attempt ?? null
  if (!attempt) return ['no real Attempt was recorded while the public version was published']
  if (published.snapshotId == null) problems.push('the current published public Snapshot is unknown')
  const pins = attempt.pins ?? {}
  const manifest = attempt.packManifest ?? {}
  const memory = manifest.memory ?? {}
  const publicL2 = memory.publicL2 ?? null
  const privateL2 = memory.L2 ?? null
  if (pins.publicMemorySnapshotId !== published.snapshotId) problems.push('the Attempt did not pin the current published public Snapshot')
  if (published.revision != null && pins.publicMemorySnapshotRevision !== published.revision) problems.push('the Attempt did not pin the published public revision')
  if (published.contentHash != null && pins.publicMemorySnapshotHash !== published.contentHash) problems.push('the Attempt did not pin the published public content hash')
  if (!publicL2 || typeof publicL2 !== 'object') problems.push('the Attempt recorded no public L2 partition')
  else {
    if (publicL2.zone !== 'public') problems.push('the public L2 partition is not the public zone')
    if (publicL2.snapshotId !== published.snapshotId) problems.push('the public L2 manifest drifted from the pin')
    const principleIds = publicL2.principleIds
    if (!Array.isArray(principleIds) || principleIds.length < 1) problems.push('the published public principle was not offered as guidance')
    const items = publicL2.items
    if (!Array.isArray(items) || items.length !== (principleIds ?? []).length) problems.push('the public L2 partition does not map every offered principle')
    const citedIds = attempt.citedEvidenceIds ?? []
    for (const item of Array.isArray(items) ? items : []) {
      if (!Array.isArray(item?.evidenceIds)) problems.push(`public principle ${item?.principleId ?? '—'} carries no evidence mapping array`)
      else if (item.evidenceIds.length > 0) problems.push(`public principle ${item?.principleId ?? '—'} claims evidence ids`)
      for (const source of item?.sources ?? []) {
        if (citedIds.includes(source)) problems.push(`public source ${source} was cited as evidence`)
        if ((manifest.evidenceIds ?? []).includes(source)) problems.push(`public source ${source} joined the evidence pack`)
      }
    }
    for (const id of Array.isArray(principleIds) ? principleIds : []) if (citedIds.includes(id)) problems.push(`public principle ${id} was cited as evidence`)
  }
  if (!privateL2 || !Array.isArray(privateL2.principleIds) || privateL2.principleIds.length > 0) problems.push('the workspace was supposed to have no eligible private principles')
  if ((pins.memorySnapshotId ?? null) !== null) problems.push('the workspace without private experience pinned a private Snapshot')
  // The only evidence a workspace without reviewed memory can offer is the
  // assistant's own authored profile, never a learned or foreign workspace record.
  const evidence = Array.isArray(attempt.evidence) ? attempt.evidence : []
  const sources = evidence.map(ref => String(ref?.source ?? ''))
  if (sources.some(source => source !== 'user_profile')) problems.push('the workspace supplied reviewable experience beyond the authored assistant profile')
  const profileEvidenceIds = new Set(evidence.filter(ref => ref?.source === 'user_profile').map(ref => ref.evidenceId))
  for (const id of manifest.evidenceIds ?? []) if (!profileEvidenceIds.has(id)) problems.push(`the pack supplied evidence ${id} outside the authored profile`)
  if (!['return', 'escalate'].includes(String(attempt.outcome))) problems.push('an evidence-free workspace must return or escalate, never answer')
  const cited = attempt.citedEvidenceIds
  if (cited != null && !Array.isArray(cited)) problems.push('the Attempt has a malformed cited-evidence record')
  else if ((cited ?? []).length > 0) problems.push('the Attempt cited evidence ids it never validated')
  return problems
}

/** Every UI gesture that can reach the public zone, and so must be attributed. */
export const PUBLIC_UI_METHODS = Object.freeze(['publicMemoryRefresh', 'publicCandidate', 'snapshotPublish', 'snapshotReject', 'snapshotRollback'])

/**
 * A public action is only attributable if the Decision page that issued it was
 * bound to the intended workspace and the wire carried that same session. Three
 * DOM reads of one panel prove neither, so every gesture is a wire receipt.
 */
export function publicWireAttributionProblems(audit = {}) {
  const problems = []
  const actions = Array.isArray(audit.actions) ? audit.actions : []
  const bindings = Array.isArray(audit.bindings) ? audit.bindings : []
  if (actions.length === 0) problems.push('no UI-triggered public RPC was captured')
  const covered = new Set(actions.map(action => String(action?.method ?? '')))
  for (const method of PUBLIC_UI_METHODS) if (!covered.has(method)) problems.push(`no UI gesture exercised ${method}`)
  for (const action of actions) {
    const label = String(action?.label ?? action?.method ?? 'public action')
    if (!action?.sessionId) problems.push(`${label}: no workspace session on the wire`)
    else if (action.sessionId !== action.expectedSessionId) problems.push(`${label}: carried ${action.sessionId} instead of the intended workspace session`)
    if (!action?.rpcId) problems.push(`${label}: no raw rpc id`)
    if (action?.responded !== true) problems.push(`${label}: no captured response payload`)
    if ((action?.occurrences ?? 0) < 1) problems.push(`${label}: no captured occurrence`)
  }
  const sessions = new Set(actions.map(action => action?.sessionId).filter(Boolean))
  if (sessions.size < 2) problems.push('public actions were proven in one workspace session only')
  if (bindings.length < 2) problems.push('the Decision page was never re-opened per workspace')
  for (const binding of bindings) {
    const label = String(binding?.label ?? 'Decision page')
    const attempts = Array.isArray(binding?.attempts) ? binding.attempts : []
    const last = attempts.at(-1)
    if (!binding?.sessionId) problems.push(`${label}: the intended workspace session is unknown`)
    else if (!last || last.bound !== binding.sessionId) problems.push(`${label}: the Decision page never bound to its own workspace session`)
  }
  return problems
}

/**
 * A rejected public candidate never becomes the current version: the published
 * Snapshot, version and revision stay exactly as they were, the learning run is
 * rejected, the rendered zone keeps the previous version and the workspace owns
 * both audit lines.
 */
export function publicCandidateRejectionProblems(audit = {}) {
  const problems = []
  const candidate = audit.candidate ?? {}
  const before = audit.beforeCurrent ?? null
  const after = audit.afterCurrent ?? null
  if (!candidate.snapshotId || !candidate.learningRunId) problems.push('the second public candidate was never identified')
  if (!audit.sessionId) problems.push('the rejection workspace session is unknown')
  else if (audit.wireSessionId !== audit.sessionId) problems.push('the rejection RPC did not carry the intended workspace session')
  if (audit.auditSessionId && audit.auditSessionId !== audit.sessionId) problems.push('the rejection audit belongs to another workspace')
  if (audit.runOutcome !== 'rejected') problems.push('the rejected public candidate kept a non-rejected learning run')
  if (audit.runId && audit.runId !== candidate.learningRunId) problems.push('the rejected run is not the reviewed candidate run')
  if (audit.snapshotState !== 'draft') problems.push('the rejected public Snapshot is no longer a draft')
  if (!after || after.snapshotId == null) problems.push('the published public version disappeared when the candidate was rejected')
  else {
    if (before?.snapshotId == null) problems.push('the published public version was never read before the rejection')
    else {
      if (before.snapshotId !== after.snapshotId) problems.push('the rejection replaced the current public Snapshot')
      if (before.version !== after.version) problems.push('the rejection changed the current public version')
      if (before.revision !== after.revision) problems.push('the rejection changed the current public revision')
    }
    if (candidate.snapshotId && after.snapshotId === candidate.snapshotId) problems.push('the rejected candidate became the current public version')
    if (Number(audit.domVersion) !== Number(after.version)) problems.push('the public zone no longer renders the previous published version')
  }
  if (audit.domCandidatePresent === true) problems.push('the rejected candidate is still offered for review')
  const lines = Array.isArray(audit.audit) ? audit.audit : []
  if (!lines.some(line => line?.kind === 'learning-run' && line?.outcome === 'rejected' && line?.learningRunId === candidate.learningRunId)) problems.push('the rejected learning run has no audit line')
  if (!lines.some(line => line?.kind === 'snapshot' && line?.action === 'reject' && line?.snapshotId === candidate.snapshotId)) problems.push('the rejected Snapshot has no audit line')
  return problems
}

/**
 * The rendered candidate body stays opaque: no absolute or workspace path, no
 * foreign record id, and only `origin_…` source labels.
 */
export function publicCandidateBodyProblems(audit = {}) {
  const problems = []
  const text = String(audit.text ?? '')
  if (audit.present !== true) problems.push('no candidate body was rendered for the leak scan')
  if (!text.trim()) problems.push('the candidate body was empty')
  for (const path of audit.workspacePaths ?? []) if (path && text.includes(String(path))) problems.push(`the candidate body shows a workspace path: ${path}`)
  for (const id of audit.foreignRecordIds ?? []) if (id && text.includes(String(id))) problems.push(`the candidate body shows a foreign record id: ${id}`)
  if (/(?:^|[\s("'`])(?:\/Users\/|\/home\/|\/private\/|[A-Za-z]:\\)/.test(text)) problems.push('the candidate body shows an absolute path')
  for (const alias of audit.aliases ?? []) if (!/^origin_[0-9a-f]{6,}$/.test(String(alias))) problems.push(`the candidate body shows a non-opaque source label: ${alias}`)
  return problems
}

/**
 * The record detail renders both memory partitions and the public one carries
 * the real published pin, its principle, a guidance-only restatement and an
 * empty evidence mapping. Only the public partition is path-scanned: the raw
 * detail JSON is the diagnostics surface, not the default record body.
 */
export function publicRecordDetailProblems(capture = {}, expected = {}) {
  const problems = []
  if (!capture || capture.caseId == null) return ['the record detail page was never read']
  if (!/公共记忆|Public memory/i.test(String(capture.publicTitle ?? ''))) problems.push('the record detail must title the public partition')
  if (!/当前工作区经验|Current workspace experience/i.test(String(capture.privateTitle ?? ''))) problems.push('the record detail must title the current workspace partition')
  if (capture.advancedOpen !== true) problems.push('the attempt context pack must be opened to read both partitions')
  if (!String(capture.privateText ?? '').trim()) problems.push('the current workspace partition rendered nothing')
  const pin = capture.publicPin ?? null
  if (!pin || typeof pin !== 'object') problems.push('the public partition shows no Snapshot pin')
  else {
    if (expected.snapshotId == null || pin.snapshotId !== expected.snapshotId) problems.push('the public partition does not show the real published public pin')
    if (expected.revision != null && pin.snapshotRevision !== expected.revision) problems.push('the public partition pin is not the published revision')
  }
  const publicPrincipleIds = capture.publicPrincipleIds ?? []
  if (expected.principleId && !publicPrincipleIds.includes(expected.principleId)) problems.push('the public partition does not list the published principle')
  const mapping = Array.isArray(capture.publicMapping) ? capture.publicMapping : []
  if (mapping.length !== publicPrincipleIds.length) problems.push('the public partition does not map every listed principle')
  for (const item of mapping) if ((item?.evidenceIds ?? []).length > 0) problems.push(`the public partition maps evidence ids for ${item?.principleId ?? '—'}`)
  // The record view restates the same contract in its memory summary: the public
  // partition was included as reviewed guidance, never as a judgment basis.
  if (!/公共记忆[^\n]*(指导|guidance)|Public memory[^\n]*(guidance)/i.test(String(capture.summary ?? ''))) problems.push('the record detail must show the public partition was included as guidance')
  const publicText = String(capture.publicText ?? '')
  for (const path of expected.workspacePaths ?? []) if (path && publicText.includes(String(path))) problems.push(`the public partition shows a workspace path: ${path}`)
  for (const id of expected.foreignRecordIds ?? []) if (id && publicText.includes(String(id))) problems.push(`the public partition shows a foreign record id: ${id}`)
  return problems
}

// ---------------------------------------------------------------------------
// B3 public review wording: a user must be able to read the reviewed principle
// text before adopting or discarding it, and the published principles must stay
// readable afterwards without becoming an editor or a provenance surface.
// ---------------------------------------------------------------------------

// A public surface is ordinary language, never provenance, so a hint that would
// carry an absolute path or a record id must never reach a rendered scope.
const PUBLIC_RECORD_ID = new RegExp('(?:^|[^A-Za-z0-9])(?:dc|ev|fb|lr|ms)_[A-Za-z0-9][A-Za-z0-9_-]{4,}')
const PUBLIC_ALIAS = new RegExp('(?:^|[^A-Za-z0-9])origin_[0-9a-z]{6,}', 'i')

const PUBLIC_OPERATION_LABELS = Object.freeze({
  add: [/新增原则/, /Adds a principle/i],
  refine: [/改写原则/, /Rewords a principle/i],
  merge: [/合并原则/, /Merges principles/i],
  narrow: [/收窄原则/, /Narrows a principle/i],
  retire: [/废止原则/, /Retires a principle/i],
})

/** Whitespace-collapsed text: rendered line wrapping is not a wording difference. */
function readableText(value) { return String(value ?? '').replace(/\s+/g, ' ').trim() }

function shortenedText(value, limit = 120) {
  const text = readableText(value)
  return text.length > limit ? `${text.slice(0, limit)}…` : text
}

function ordinaryOperationLabel(op, label) {
  const patterns = PUBLIC_OPERATION_LABELS[String(op ?? '')]
  return Boolean(patterns) && patterns.some(pattern => pattern.test(String(label ?? '')))
}

function unsafePublicHint(value) {
  const text = String(value ?? '')
  if (!text) return false
  if (text.startsWith('/') || text.startsWith('~') || text.startsWith('file:')) return true
  if (text.length > 1 && text[1] === ':' && /[A-Za-z]/.test(text[0])) return true
  return PUBLIC_RECORD_ID.test(text)
}

function scopeHints(scope) {
  const value = scope && typeof scope === 'object' ? scope : {}
  const hints = []
  for (const key of ['paths', 'tags']) for (const entry of Array.isArray(value[key]) ? value[key] : []) if (typeof entry === 'string' && entry) hints.push(entry)
  for (const entry of Array.isArray(value.authorizationClasses) ? value.authorizationClasses : []) if (typeof entry === 'string' && entry) hints.push(entry)
  return hints
}

function reviewedChangeWording(change, principles, current) {
  const own = principles.find(item => item?.principleId === change?.principleId)
  const published = current.find(item => item?.principleId === change?.principleId)
  return [change?.text, own?.text, published?.text].find(value => typeof value === 'string' && value.trim()) ?? ''
}

function publicLeakProblems(text, label, extra = {}) {
  const problems = []
  const body = String(text ?? '')
  if (body.includes('inputFrozen')) problems.push(`${label} shows the raw frozen input`)
  if (PUBLIC_RECORD_ID.test(body)) problems.push(`${label} shows a source record id`)
  if (body.includes('/Users/') || body.includes('/home/') || body.includes('/private/') || body.includes('file:')) problems.push(`${label} shows an absolute path`)
  if (body.includes('{') && body.includes('}') && body.includes('":')) problems.push(`${label} shows raw JSON`)
  for (const path of extra.workspacePaths ?? []) if (path && body.includes(String(path))) problems.push(`${label} shows a workspace path: ${path}`)
  for (const id of extra.foreignRecordIds ?? []) if (id && body.includes(String(id))) problems.push(`${label} shows a foreign record id: ${id}`)
  return problems
}

/**
 * The public candidate review must render the reviewed wording itself, in
 * ordinary language, with the scope hint it really carries — never an
 * operation/id pair, the frozen input, a source record id, an absolute path or
 * raw JSON. Wording comes from the candidate RPC: `changes[].text`, else the
 * candidate principle's own text (narrow), else the published principle a
 * retire removes. A rendered id can never stand in for the reviewed text.
 */
export function publicCandidateWordingProblems(audit = {}) {
  const problems = []
  const rpc = audit.rpc ?? {}
  const dom = audit.dom ?? {}
  const changes = Array.isArray(rpc.changes) ? rpc.changes : []
  const principles = Array.isArray(rpc.principles) ? rpc.principles : []
  const current = Array.isArray(rpc.current) ? rpc.current : []
  const rendered = Array.isArray(dom.changes) ? dom.changes : []
  if (dom.present !== true) problems.push('no public candidate was rendered for the wording review')
  if (changes.length === 0) problems.push('the public candidate RPC carried no reviewed change')
  if (Array.isArray(audit.expectedOps) && audit.expectedOps.length) {
    const ops = changes.map(change => String(change?.op ?? ''))
    for (const op of audit.expectedOps) if (!ops.includes(op)) problems.push(`the reviewed candidate carries no ${op} operation`)
    for (const op of ops) if (!audit.expectedOps.includes(op)) problems.push(`the reviewed candidate carries an unexpected ${op} operation`)
  }
  if (changes.length !== rendered.length) problems.push(`the rendered candidate lists ${rendered.length} changes instead of the reviewed ${changes.length}`)
  for (let index = 0; index < Math.min(changes.length, rendered.length); index += 1) {
    const change = changes[index] ?? {}
    const row = rendered[index] ?? {}
    const label = readableText(row.label)
    const wording = reviewedChangeWording(change, principles, current)
    if (String(row.op ?? '') !== String(change.op ?? '')) problems.push(`change ${index + 1} renders operation ${shortenedText(row.op) || '—'} instead of ${shortenedText(change.op) || '—'}`)
    if (!wording) problems.push(`change ${index + 1} (${shortenedText(change.op)}) carries no readable wording in the candidate RPC`)
    else if (readableText(row.text) !== readableText(wording)) problems.push(`change ${index + 1} (${shortenedText(change.op)}) renders ${JSON.stringify(shortenedText(row.text))} instead of the reviewed wording ${JSON.stringify(shortenedText(wording))}`)
    if (!label) problems.push(`change ${index + 1} renders no operation label`)
    else {
      if (!ordinaryOperationLabel(change.op, label)) problems.push(`change ${index + 1} is not labelled in ordinary language: ${JSON.stringify(shortenedText(label))}`)
      if (change.principleId && !label.includes(change.principleId)) problems.push(`change ${index + 1} does not identify the reviewed principle ${change.principleId}`)
    }
    const hints = scopeHints(change.scope ?? principles.find(item => item?.principleId === change.principleId)?.scope)
    const renderedScope = readableText(row.scope)
    for (const hint of hints) {
      if (unsafePublicHint(hint)) {
        if (renderedScope.includes(hint)) problems.push(`change ${index + 1} renders a scope hint that is a path or a record id`)
        continue
      }
      if (!renderedScope) problems.push(`change ${index + 1} omits the scope hint ${JSON.stringify(hint)} it really carries`)
      else if (!renderedScope.includes(hint)) problems.push(`change ${index + 1} omits the scope hint ${JSON.stringify(hint)}`)
    }
    if (hints.every(unsafePublicHint) && renderedScope) problems.push(`change ${index + 1} renders a scope hint the reviewed change does not carry`)
  }
  if (changes.length === 0 && rendered.length > 0) problems.push('the rendered candidate lists changes the candidate RPC never reviewed')
  const frozen = readableText(dom.frozenInput)
  if (!frozen) problems.push('the candidate review renders no frozen-input summary')
  else if (frozen.includes('{') || frozen.includes('inputFrozen')) problems.push('the frozen-input summary shows raw input instead of counts')
  if (!/工作区|workspace/i.test(frozen) || !/来源|source/i.test(frozen)) problems.push('the frozen-input summary does not state its workspace and source counts')
  problems.push(...publicLeakProblems(dom.text, 'the candidate body', audit))
  for (const alias of audit.aliases ?? []) if (!/^origin_[0-9a-f]{6,}$/.test(String(alias))) problems.push(`the candidate body shows a non-opaque source label: ${alias}`)
  return problems
}

// ---------------------------------------------------------------------------
// Explicit decision data export: the records advanced action, its confirmation,
// the real success surface and a failure that must never look like success.
// ---------------------------------------------------------------------------

/** The export confirmation must restate the scope and the local destination. */
export function exportConfirmationProblems(audit = {}) {
  const problems = []
  const dialog = audit.dialog ?? {}
  const ax = Array.isArray(audit.ax) ? audit.ax : []
  if (dialog.present !== true) return ['no export confirmation dialog was rendered']
  const title = readableText(dialog.title)
  const body = readableText(dialog.body)
  if (!title) problems.push('the export confirmation has no title')
  if (!/导出本工作区的决策数据|Export this workspace/.test(title)) problems.push(`the export confirmation title does not name the workspace export: ${JSON.stringify(shortenedText(title))}`)
  if (!readableText(body)) problems.push('the export confirmation has no body')
  else {
    if (!/导出不会改变或授权|changes? nothing|grants? nothing/i.test(body)) problems.push('the confirmation does not state that exporting changes and authorizes nothing')
    if (!/不提供导入|no import/i.test(body)) problems.push('the confirmation does not state that there is no import')
    if (!/本地|local/i.test(body)) problems.push('the confirmation does not name the local destination')
  }
  const buttons = (Array.isArray(dialog.buttons) ? dialog.buttons : []).map(button => readableText(button?.text))
  if (buttons.length < 2) problems.push(`the confirmation renders ${buttons.length} actions instead of a confirm and a cancel`)
  if (!buttons.some(text => /导出数据|Export data/.test(text))) problems.push('the confirmation has no export action')
  if (!buttons.some(text => /取消|Cancel/.test(text))) problems.push('the confirmation has no cancel action')
  if (!ax.some(node => node?.role === 'dialog' || node?.role === 'alertdialog')) problems.push('the confirmation is not an accessible dialog in the AX tree')
  for (const node of ax) if (node?.role === 'button' && node?.ignored === true) problems.push('the confirmation exposes an ignored button in AX')
  if (!ax.some(node => node?.role === 'button' && !node.ignored && /导出数据|Export data/.test(String(node?.name ?? '')))) problems.push('the export action is not a named button in AX')
  return problems
}

/**
 * Success is only success when the rendered surface, the wire and the file on
 * disk agree: a fabricated path, a mismatched byte count or a bad checksum fails.
 */
export function exportSuccessSurfaceProblems(audit = {}) {
  const problems = []
  const dom = audit.dom ?? {}
  const wire = audit.wire ?? {}
  const file = audit.file ?? {}
  if (dom.present !== true) problems.push('no export success surface was rendered')
  if (dom.errorPresent === true) problems.push('a success and a failure surface were rendered at the same time')
  const fileText = readableText(dom.file)
  const bytesText = readableText(dom.bytesText)
  const shaText = readableText(dom.sha256)
  const path = String(wire.file ?? '')
  if (!path) problems.push('the exportData response carried no file path')
  if (path && !fileText.includes(path)) problems.push(`the success surface does not show the real path: ${JSON.stringify(shortenedText(fileText))} vs ${JSON.stringify(shortenedText(path))}`)
  if (!Number.isInteger(wire.bytes) || wire.bytes <= 0) problems.push('the exportData response carried no byte count')
  if (bytesText && !bytesText.includes(String(wire.bytes)) && !/[0-9.]+\s*(?:B|KB|MB)/.test(bytesText)) problems.push(`the success surface does not show the real size: ${JSON.stringify(shortenedText(bytesText))}`)
  if (!/^[a-f0-9]{64}$/.test(String(wire.sha256 ?? ''))) problems.push('the exportData response carried no sha256 checksum')
  if (shaText && !shaText.includes(String(wire.sha256 ?? ''))) problems.push(`the success surface does not show the real checksum: ${JSON.stringify(shortenedText(shaText))}`)
  // The file itself must be the one the surface describes.
  if (file.exists !== true) problems.push('the exported file does not exist on disk')
  if (file.bytes !== wire.bytes) problems.push(`the file is ${file.bytes} bytes but the response reported ${wire.bytes}`)
  if (file.sha256 !== wire.sha256) problems.push('the file content does not hash to the reported checksum')
  if (file.mode !== '600') problems.push(`the exported file mode is ${file.mode}, not 600`)
  if (file.directoryMode !== '700') problems.push(`the exports directory mode is ${file.directoryMode}, not 700`)
  if (file.envelope?.kind !== 'weir-decision-export' || file.envelope?.formatVersion !== 1) problems.push('the file is not a versioned decision export envelope')
  if (file.envelope?.integrity?.value !== wire.sha256) problems.push('the envelope integrity value is not the reported checksum')
  if (file.envelope?.checksumValid !== true) problems.push('the envelope checksum does not verify from the file content')
  if (!(Number(file.envelope?.counts?.cases) >= 1)) problems.push('the export did not carry the live workspace records')
  if (file.containsWorkspaceKey === true) problems.push('the export file carries a real workspaceKey')
  if (file.containsAbsolutePath !== false) problems.push('the export file carries an absolute path')
  // Public-memory provenance is never included: another workspace's opaque alias
  // is still another workspace's identifier, even without a path or a key.
  const aliases = file.aliases ?? {}
  const caller = String(aliases.caller ?? file.envelope?.scope?.workspaceAlias ?? '')
  const tokens = Array.isArray(aliases.tokens) ? aliases.tokens : null
  const foreign = Array.isArray(aliases.foreign) ? aliases.foreign : []
  if (!tokens) problems.push('the export file was not scanned for origin aliases')
  else {
    if (!caller || !tokens.includes(caller)) problems.push('the export file does not carry the exporting workspace alias')
    if (foreign.length > 0) problems.push(`the export file carries other workspaces' aliases: ${foreign.join(', ')}`)
  }
  // Scope discipline on the wire: only the session is forwarded.
  const wireArgs = audit.wireArgs ?? {}
  const keys = Object.keys(wireArgs).sort()
  if (keys.join(',') !== 'sessionId') problems.push(`the export request forwarded ${JSON.stringify(keys)} instead of only the session`)
  if (audit.focus?.active !== true) problems.push('focus did not return to the export action after the confirmation')
  return problems
}

/** A failed export shows an actionable reason and a retry, never a success. */
export function exportFailureSurfaceProblems(audit = {}) {
  const problems = []
  const dom = audit.dom ?? {}
  if (dom.present !== true) problems.push('no export failure surface was rendered')
  if (dom.successPresent === true) problems.push('the failed export still renders a success surface')
  const reason = readableText(dom.reason)
  if (!reason) problems.push('the failure renders no ordinary-language reason')
  if (!/无法写入|could not be written|unavailable|too large|超过|没有完成/i.test(reason)) problems.push(`the failure reason is not actionable: ${JSON.stringify(shortenedText(reason))}`)
  if (dom.retry !== true) problems.push('the failure offers no retry action')
  if (audit.filesAfter !== audit.filesBefore) problems.push(`the failed export left ${audit.filesAfter} files behind (before: ${audit.filesBefore})`)
  if (audit.focus?.active !== true) problems.push('focus did not return to the export action after the failed attempt')
  return problems
}

/**
 * A refine review leg only discriminates when the refined wording differs from
 * the wording still published: with identical text a stale render and a refined
 * render are indistinguishable, so the review would show nothing new. The
 * rendered refine row must show exactly the reviewed refined text, and the
 * published version must still carry the older wording.
 */
export function publicRefinedWordingProblems(audit = {}) {
  const problems = []
  const changes = Array.isArray(audit.rpc?.changes) ? audit.rpc.changes : []
  const refine = changes.find(change => String(change?.op ?? '') === 'refine')
  if (!refine) return ['the reviewed candidate carries no refine operation to discriminate']
  const refined = readableText(refine.text)
  if (!refined) return ['the refine operation carries no reviewed wording']
  const published = (Array.isArray(audit.published) ? audit.published : []).map(item => readableText(item?.text)).filter(Boolean)
  if (published.length === 0) problems.push('the published version carries no wording to compare the refine against')
  if (published.includes(refined)) problems.push('the refined wording is identical to the wording still published, so a stale render cannot be told apart')
  if (audit.dom?.present !== true) problems.push('no public candidate was rendered for the refined wording review')
  const rendered = (Array.isArray(audit.dom?.changes) ? audit.dom.changes : []).find(row => String(row?.op ?? '') === 'refine')
  if (!rendered) problems.push('the rendered candidate lists no refine change')
  else if (readableText(rendered.text) !== refined) problems.push(`the rendered refine change shows ${JSON.stringify(shortenedText(rendered.text))} instead of the refined wording ${JSON.stringify(shortenedText(refined))}`)
  return problems
}

/**
 * After explicit adoption the public zone must render the published principles
 * read-only, with the wording the agent/refresh response reports, and with no
 * publish/reject/rollback control, source alias, record id or path of its own.
 */
export function publicPublishedPrinciplesProblems(audit = {}) {
  const problems = []
  const expected = (Array.isArray(audit.expected) ? audit.expected : []).filter(item => item && typeof item.principleId === 'string')
  const dom = audit.dom ?? {}
  const section = dom.published ?? {}
  if (expected.length === 0) problems.push('the published public version carries no reviewed wording to render')
  if (section.present !== true) return [...problems, 'the public zone renders no published-principles section']
  const rows = Array.isArray(section.principles) ? section.principles : []
  if (rows.length !== expected.length) problems.push(`the published section lists ${rows.length} principles instead of the published ${expected.length}`)
  for (const principle of expected) {
    const row = rows.find(item => item?.principleId === principle.principleId)
    if (!row) { problems.push(`the published section does not render principle ${principle.principleId}`); continue }
    const wording = readableText(principle.text)
    if (!wording) problems.push(`the published principle ${principle.principleId} carries no reviewed wording`)
    else if (readableText(row.text) !== wording) problems.push(`published principle ${principle.principleId} renders ${JSON.stringify(shortenedText(row.text))} instead of its reviewed wording ${JSON.stringify(shortenedText(wording))}`)
    const hints = scopeHints(principle.scope)
    const renderedScope = readableText(row.scope)
    for (const hint of hints) {
      if (unsafePublicHint(hint)) {
        if (renderedScope.includes(hint)) problems.push(`published principle ${principle.principleId} renders a scope hint that is a path or a record id`)
        continue
      }
      if (!renderedScope.includes(hint)) problems.push(`published principle ${principle.principleId} omits the scope hint ${JSON.stringify(hint)}`)
    }
    if (hints.every(unsafePublicHint) && renderedScope) problems.push(`published principle ${principle.principleId} renders a scope hint the published version does not carry`)
  }
  for (const row of rows) if (!expected.some(item => item.principleId === row?.principleId)) problems.push(`the published section renders ${shortenedText(row?.principleId)} which the current published version does not carry`)
  const controls = Array.isArray(section.controls) ? section.controls : []
  if (controls.length) problems.push(`the published principles section is not read-only: ${shortenedText(controls.map(item => `${item?.tag ?? 'control'}${item?.action ? `[${item.action}]` : ''}`).join(', '))}`)
  if (!Number.isInteger(Number(dom.current?.version)) || Number(dom.current?.version) < 1) problems.push('the public zone no longer renders its published version')
  problems.push(...publicLeakProblems(section.text, 'the published section', audit))
  if (PUBLIC_ALIAS.test(String(section.text ?? ''))) problems.push('the published section shows a source alias')
  if (!readableText(section.text)) problems.push('the published-principles section rendered nothing')
  return problems
}

/**
 * The sidebar entry's pending bubble: a decorative number inside the icon's box,
 * a localized title for mouse users, and a polite live region that carries the
 * count for assistive technology (the host marks the icon container hidden).
 * @param {{present?:boolean,text?:string,title?:string,bubble?:any,entry?:any,live?:any,background?:string,color?:string,svg?:boolean}} state
 * @param {{count?:number,language?:'en'|'zh',liveText?:string}} [expected]
 */
export function pendingBubbleProblems(state = {}, expected = {}) {
  const problems = []
  const count = Number.isInteger(expected.count) ? expected.count : null
  const bubble = state.bubble ?? null
  const entry = state.entry ?? null
  if (!state.svg) problems.push('the entry no longer renders the decision branch-check icon')
  if (!entry || entry.width <= 0 || entry.height <= 0) problems.push('the entry icon box has no measurable size')
  if (count === 0) {
    if (state.present) problems.push(`a zero count rendered a bubble reading ${shortenedText(state.text)}`)
    return problems
  }
  if (state.present !== true) return [...problems, 'the pending bubble is not rendered']
  const expectedText = count === null ? null : count > 9 ? '9+' : String(count)
  if (expectedText !== null && state.text !== expectedText) problems.push(`the bubble reads ${shortenedText(state.text)} instead of ${expectedText}`)
  if (count !== null) {
    const language = expected.language === 'zh' || expected.language === 'en' ? expected.language : null
    const title = readableText(state.title)
    if (!title) problems.push('the bubble carries no title for mouse users')
    else if (!/\d/.test(title)) problems.push(`the bubble title ${shortenedText(title)} names no count`)
    else if (language === 'zh' && !/待你决定/.test(title)) problems.push(`the bubble title ${shortenedText(title)} is not the localized sentence`)
    else if (language === 'en' && !/your decision/i.test(title)) problems.push(`the bubble title ${shortenedText(title)} is not the localized sentence`)
    else if (language === null && !/待你决定|your decision/i.test(title)) problems.push(`the bubble title ${shortenedText(title)} is not the localized sentence`)
  }
  if (!bubble || bubble.width <= 0 || bubble.height <= 0) problems.push('the bubble has no measurable size')
  else {
    // A labelled row keeps the count at its right end (after the title); the
    // icon-only rail keeps the chip on the icon's top-right corner. Neither may
    // be clipped by the sidebar.
    if (state.mode === 'wide' && (bubble.height < 18 || bubble.width < 20)) problems.push(`the labelled row count badge is too small to notice (${Math.round(bubble.width)}x${Math.round(bubble.height)})`)
    if (state.mode !== 'wide' && bubble.height < 14) problems.push(`the rail count chip is too small to notice (${Math.round(bubble.height)}px)`)
    if (!entry) problems.push('the bubble has no entry box to position against')
    else if (state.mode === 'wide') {
      if (bubble.left < entry.right - 1) problems.push('the labelled row still draws the count on the icon instead of the row\u2019s right end')
      if (state.row && !(bubble.left + bubble.width / 2 > state.row.left + state.row.width / 2)) problems.push('the count is not in the row\u2019s right half')
      if (state.row && bubble.right > state.row.right + 1) problems.push(`the bubble is clipped on the right at x=${bubble.right}`)
    } else if (!(bubble.left + bubble.width / 2 > entry.left + entry.width / 2 && bubble.top + bubble.height / 2 < entry.top + entry.height / 2)) problems.push('the rail bubble is not on the icon\u2019s top-right corner')
    if (bubble.left < -1) problems.push(`the bubble is clipped on the left at x=${bubble.left}`)
  }
  if (readableText(state.background) === '' || readableText(state.background) === 'rgba(0, 0, 0, 0)') problems.push('the bubble has no warning fill')
  if (readableText(state.color) === '') problems.push('the bubble has no readable digit colour')
  if (bubble && state.color && state.background && state.color === state.background) problems.push('the bubble digits use the fill colour')
  const live = state.live ?? null
  if (!live) problems.push('the entry registers no polite live region')
  else {
    if (live.role !== 'status') problems.push(`the live region role is ${live.role} instead of status`)
    if (live.ariaLive !== 'polite') problems.push(`the live region is ${live.ariaLive} instead of polite`)
    if (!live.text) problems.push('the live region is empty')
    else if (expected.liveText !== undefined && readableText(live.text) !== readableText(expected.liveText)) problems.push(`the live region says ${shortenedText(live.text)} instead of ${shortenedText(expected.liveText)}`)
    if (live.rect && live.rect.width > 2 && live.rect.height > 2) problems.push('the live region is visible instead of visually hidden')
  }
  return problems
}

/**
 * The grouped pending inbox: one block per source workspace (or assistant),
 * counts on the group heads, one switch offered only when the pending items
 * really span two or more workspaces, and no page-level horizontal scroll.
 * @param {{groups?:any[],switchButtons?:any[],navCount?:number,total?:number,switchAria?:string,horizontalScroll?:number,sourceLabels?:string[]}} state
 */
export function pendingOverviewProblems(state = {}) {
  const problems = []
  const groups = (Array.isArray(state.groups) ? state.groups : []).filter(group => group && typeof group === 'object')
  const total = groups.reduce((sum, group) => sum + (Number.isInteger(group.count) ? group.count : 0), 0)
  if (groups.length === 0) problems.push('the pending inbox renders no group')
  for (const group of groups) {
    if (!readableText(group.label)) problems.push(`the group ${shortenedText(group.key)} carries no readable name`)
    if (!Number.isInteger(group.count) || group.count < 1) problems.push(`the group ${shortenedText(group.label)} carries no positive count`)
    if (!Array.isArray(group.caseIds) || group.caseIds.length !== group.count) problems.push(`the group ${shortenedText(group.label)} shows ${Array.isArray(group.caseIds) ? group.caseIds.length : 0} cards for a count of ${group.count}`)
    if (group.heading !== 'H2' && group.heading !== 'H3') problems.push(`the group ${shortenedText(group.label)} heading is ${group.heading || 'missing'} instead of a heading element`)
  }
  const keys = new Set(groups.map(group => group.key))
  if (keys.size !== groups.length) problems.push('two rendered groups share one key')
  if (Number.isInteger(state.total) && state.total !== total) problems.push(`the rendered groups hold ${state.total} items but their counts sum to ${total}`)
  if (Number.isInteger(state.navCount) && Number.isInteger(state.total) && state.navCount !== state.total && state.total > 0) problems.push(`the navigation count ${state.navCount} differs from the grouped total ${state.total}`)
  const controls = (Array.isArray(state.switchButtons) ? state.switchButtons : []).filter(item => item && typeof item.by === 'string')
  // The switch exists while pending items span two workspaces, whatever the
  // current grouping dimension renders (one assistant can own both workspaces).
  const switchable = state.switchable === 'true' || (state.switchable !== 'false' && groups.length >= 2)
  if (switchable) {
    if (controls.length !== 2) problems.push(`two grouping dimensions exist but ${controls.length} switch controls render`)
    if (!readableText(state.switchAria)) problems.push('the grouping switch carries no accessible name')
    for (const control of controls) if (!readableText(control.label)) problems.push(`the ${control.by} switch carries no readable label`)
    if (controls.length === 2 && controls.filter(control => control.pressed === 'true').length !== 1) problems.push('exactly one grouping dimension must be pressed')
  } else if (controls.length > 0) problems.push('one grouping source must not offer a switch')
  if (state.switchable === 'true' && Number.isInteger(state.workspaceCount) && state.workspaceCount < 2) problems.push('the switch claims two workspaces but the page reports fewer')
  if (Number.isFinite(state.horizontalScroll) && state.horizontalScroll > 0) problems.push(`the inbox introduces ${state.horizontalScroll}px of horizontal scroll`)
  for (const label of Array.isArray(state.sourceLabels) ? state.sourceLabels : []) {
    const text = readableText(label)
    if (!text) problems.push('an inbox card shows no source workspace')
    // A workspace *name* is the only thing the card may show: a path segment
    // anywhere in the label means the page leaked the source directory.
    if (/(^|[\s:：])(?:[A-Za-z]:[\\/]|~[\\/]|\/)/.test(text)) problems.push(`an inbox card shows a path instead of a workspace name: ${shortenedText(label)}`)
  }
  return problems
}
