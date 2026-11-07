// Shared evidence writer for disposable decision-agent spike scenarios.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export function writeDecisionEvidence(run, spike, file, value) {
  const root = join(run.ws, '..', '..', 'decision-spikes', spike)
  mkdirSync(root, { recursive: true })
  const payload = {
    spike,
    scope: 'headless',
    command: `WEIR_IT_DECISION_SPIKES=1 node plugins/weir-test-harness/run.mjs ${run.scenario}`,
    exitCode: run.code,
    stdout: run.stdout,
    stderr: run.stderr,
    ...value,
  }
  writeFileSync(join(root, file), JSON.stringify(payload, null, 2) + '\n')
  return payload
}
