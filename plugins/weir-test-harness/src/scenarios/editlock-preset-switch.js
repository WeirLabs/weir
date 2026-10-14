// Scenario: editlock-preset-switch — two Edit-Lock preset revisions composed
// in ONE headless process (the single-process shape of weir ↔ weir-creative),
// a session created under preset A, switched to preset B in the blank window
// and switched back, with a managed write at every stage (openspec
// edit-lock-shared-domain-mounts, task 4.1). Asserts the switch is a no-op:
// every write admitted, the execution epoch never moves, both mounts report
// publisher mode (no same-process client), zero binding-transfer /
// binding-auto-retry / setup-failed audit, zero in-session failure notices,
// and the reservation is released when the boot's presets unload.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'editlock-preset-switch'
const WS = join(IT_ROOT, 'ws')
const REPORT = join(WS, 'editlock-preset-switch.json')
const AUDIT = join(WS, '.weir', 'audit.jsonl')
const RESERVATION = join(WS, '.weir', '.edit-lock-preset-switch.publisher-reservation')
const FILES = ['preset-switch-1.txt', 'preset-switch-2.txt', 'preset-switch-3.txt'].map(name => join(WS, name))

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  if (!history.includes('QA_PRESET_SWITCH_FINISHED')) return toolCallChunks('qa_editlock_preset_switch', {})
  return textChunks('preset switch done')
}

function observe(obs) {
  return { probeSeen: obs.toolNames.includes('qa_editlock_preset_switch') }
}

function assert(run) {
  let report = null
  try { report = JSON.parse(readFileSync(REPORT, 'utf8')) } catch { /* missing report fails below */ }
  run.check('the probe composed both Edit-Lock presets and completed', report?.completed === true && run.requests.some((r) => r.probeSeen), JSON.stringify(report?.error ?? report).slice(0, 600))

  const phases = report?.phases ?? []
  const [created, switched, back] = phases
  run.check('session created under preset A: managed write admitted, epoch 1, active', created?.label === 'created-under-A' && created.writeAdmitted === true && created.epochAfter === 1 && created.state === 'active', JSON.stringify(created))
  run.check('blank-window switch to preset B: write admitted, the epoch never moved, prior locks retained (never revoked)', switched?.label === 'switched-to-B' && switched.writeAdmitted === true && switched.epochBefore === 1 && switched.epochAfter === 1 && switched.state === 'active' && switched.locks === 2, JSON.stringify(switched))
  run.check('switch back to preset A: write admitted and the epoch still never moved', back?.label === 'switched-back-to-A' && back.writeAdmitted === true && back.epochBefore === 1 && back.epochAfter === 1 && back.state === 'active', JSON.stringify(back))
  run.check('every managed write landed its content on disk', FILES.every((file, index) => existsSync(file) && readFileSync(file, 'utf8') === ['one\n', 'two\n', 'three\n'][index]), FILES.map(file => (existsSync(file) ? readFileSync(file, 'utf8') : '<missing>')).join('|'))

  const cross = report?.crossRead
  run.check('the standing mount moved to the sibling service and BOTH mounts report the same publisher-mode binding (no same-process client)', cross?.serviceSwiched === true && cross.modeA === 'publisher' && cross.modeB === 'publisher' && cross.stateA === 'active' && cross.stateB === 'active' && cross.epochA === 1 && cross.epochB === 1, JSON.stringify(cross))
  run.check('no mount recorded a startup failure at any stage', phases.every((phase) => phase.startupFailure === null) && cross?.failureA === null && cross?.failureB === null, JSON.stringify({ phases: phases.map((phase) => phase.startupFailure), cross }))
  run.check('status reads from either mount agree after switching back', report?.crossReadBack?.epochA === 1 && report?.crossReadBack?.epochB === 1 && report?.crossReadBack?.stateA === 'active', JSON.stringify(report?.crossReadBack))
  run.check('no Edit Lock failure notice ever entered the conversation', Array.isArray(report?.failureNotices) && report.failureNotices.length === 0, JSON.stringify(report?.failureNotices))

  // The mirror anchors at the fixed root (ws) and is shared with other
  // editlock scenarios in a full run: filter by THIS session's id.
  const audit = existsSync(AUDIT) ? readFileSync(AUDIT, 'utf8') : ''
  const bindingAudits = audit.split('\n').filter((line) => line.includes(`"session":"${report?.sessionId}"`) && /"kind":"(binding-transfer|binding-auto-retry|setup-failed)"/.test(line))
  run.check('zero binding-transfer / binding-auto-retry / setup-failed audit in the durable mirror', bindingAudits.length === 0, bindingAudits.join('\n').slice(0, 600))

  run.check('the publisher reservation was released when the boot unloaded', !existsSync(RESERVATION))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt: `${id}-probe`, env: { WEIR_IT_PRESET_SWITCH: '1' }, decide, observe, assert }
