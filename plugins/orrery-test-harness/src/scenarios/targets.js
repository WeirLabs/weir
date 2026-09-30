// Scenario: targets — the injected delegation-target guidance is present and
// lists only ENABLED targets, and a disabled category is neither advertised nor
// spawnable (change: delegate-routing-and-discovery, tasks 4.1/4.2).
//
// The disabled category arrives through ORRERY_IT_DISABLED_CATEGORY (the
// `env` export below), which the harness patch turns into a registry-level
// `disabled: true`; the shared baseline therefore keeps every category enabled.
// The guidance markers are derived from the product constants so a heading or
// variable rename can never leave this scenario asserting a stale string.
import { textChunks, toolCallChunks } from '../mock-kit.js'
import { DELEGATE_TARGETS_TEMPLATE, DELEGATE_TARGETS_VARIABLE_NAME } from '../../../orrery-harness/src/delegate/targets.js'

const id = 'targets'
const prompt = 'targets-probe'
const DISABLED = 'artistry'
const UNKNOWN = 'nope-not-a-category'
const GUIDANCE_HEADING = DELEGATE_TARGETS_TEMPLATE.split('\n', 1)[0]

/** One rendered category line, in the renderer's documented `- <name> — …` shape. */
function categoryLine(name) {
  return `- ${name} —`
}

function decide(options, obs) {
  const lastTool = obs.lastTool ?? ''
  if (lastTool.includes(DISABLED)) {
    // The disabled-category rejection arrived: probe the available-target list.
    return toolCallChunks('delegate', { category: UNKNOWN, prompt: 'TASK: unreachable probe (unknown category)' })
  }
  if (lastTool.includes(UNKNOWN)) {
    return textChunks('MARKER_TARGETS_DONE')
  }
  return toolCallChunks('delegate', { category: DISABLED, prompt: 'TASK: unreachable probe (disabled category)' })
}

function observe(obs) {
  // The agent request carries the rendered system prompt in-history as a
  // system-role message; sidecar requests use `system`. Concatenate both.
  const system = `${obs.system ?? ''}\n${obs.transcript ?? ''}`
  return {
    sawTargetsGuidance: system.includes(GUIDANCE_HEADING),
    guidanceListsEnabledCategory: system.includes(categoryLine('quick')),
    guidanceListsDisabledCategory: system.includes(categoryLine(DISABLED)),
    guidanceLeftVariableRaw: system.includes(`{{${DELEGATE_TARGETS_VARIABLE_NAME}}}`),
  }
}

function assert(run) {
  const requests = run.requests
  // The parent is the request that emitted the delegate call (children, had any
  // been spawned, would carry the same guidance but no delegate emission).
  const parent = requests.find((r) => r.emittedNames?.includes('delegate'))
  run.check('parent system prompt carries the delegation-target guidance', Boolean(parent?.sawTargetsGuidance), JSON.stringify(requests.map((r) => r.emittedNames)))
  run.check('guidance lists an enabled category', Boolean(parent?.guidanceListsEnabledCategory))
  run.check('guidance omits the disabled category', parent?.guidanceListsDisabledCategory === false)
  run.check('guidance variable was interpolated, not left raw', parent?.guidanceLeftVariableRaw === false)

  const disabledAttempt = requests.find((r) => (r.lastTool ?? '').includes(DISABLED))
  run.check('spawning a disabled category is rejected as disabled', Boolean(disabledAttempt) && /disabled/i.test(disabledAttempt.lastTool), disabledAttempt?.lastTool)

  const unknownAttempt = requests.find((r) => (r.lastTool ?? '').includes('unknown_target'))
  run.check('the unknown-category error does not advertise the disabled category', Boolean(unknownAttempt) && !unknownAttempt.lastTool.includes(DISABLED), unknownAttempt?.lastTool)

  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, assert, env: { ORRERY_IT_DISABLED_CATEGORY: DISABLED } }
