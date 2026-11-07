// P0-S8: both real production presets mounted in one Host via the real registry.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lastOfRole, textChunks, toolCallChunks } from '../mock-kit.js'
import { writeDecisionEvidence } from '../decision-spike-evidence.js'

const id = 'decision-spike-multi-mount'
const prompt = 'decision-spike-multi-mount-probe'

function decide(options, obs) {
  const lastTool = lastOfRole(options, 'tool')
  if (lastTool.includes('DECISION_SPIKE')) return textChunks(lastTool.includes('"pass":true') ? 'S8_MULTI_MOUNT_DONE' : 'S8_MULTI_MOUNT_FAILED')
  if (lastTool.includes('unknown tool')) return textChunks('S8_MULTI_MOUNT_FAILED')
  if (obs.transcript.includes(prompt)) return toolCallChunks('decision_multi_mount_spike', {})
  return textChunks('unhandled decision multi-mount turn')
}

async function run(driver) {
  return driver.runPresetDelegationSurface({ id, prompt, env: { WEIR_IT_DECISION_SPIKE: 'multi-mount' } }, 'weir')
}

function assert(run) {
  const path = join(run.ws, 'decision-spike-multi-mount.json')
  const report = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
  const realmErrorText = [...(report?.realmErrors ?? []), run.stderr].filter(text => String(text).includes('Preset services require isolate realms'))
  const pass = report?.pass === true && report.sessions.length === 2 && report.sessions.every(session => session.claimCount === 1 && session.crossSessionClaims === 0) && realmErrorText.length === 0 && run.stdout.includes('S8_MULTI_MOUNT_DONE') && (run.code === 0 || run.code === null)
  writeDecisionEvidence(run, 'S8', 'multi-mount.json', {
    presetsMountedSimultaneously: report?.sessions?.map(session => session.preset) ?? [],
    sessions: report?.sessions ?? [], claims: report?.claims ?? [], realmErrors: realmErrorText,
    assertions: {
      exactlyOneClaimPerRequest: report?.sessions?.every(session => session.claimCount === 1) === true,
      noCrossSessionClaim: report?.sessions?.every(session => session.crossSessionClaims === 0) === true,
      noPresetRealmError: realmErrorText.length === 0,
    },
    rawReport: report, pass,
  })
  run.check('weir and weir-creative each claimed their own request exactly once', report?.pass === true && report.sessions.length === 2, JSON.stringify(report))
  run.check('no cross-session claim or preset realm error', report?.sessions?.every(session => session.crossSessionClaims === 0) === true && realmErrorText.length === 0, JSON.stringify({ report, stderr: run.stderr.slice(-500) }))
  run.check('headless multi-mount run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-500)}`)
}

export default { id, prompt, decide, run, assert, env: { WEIR_IT_DECISION_SPIKE: 'multi-mount' } }
