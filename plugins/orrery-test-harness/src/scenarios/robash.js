// Scenario: robash — a curated read-only child proves the wait primitive and
// gets a write denied by the guard. Migrated from mock-llm.js decideRobash /
// run.mjs assertRobash (D1/D2).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lastOfRole, shellCall, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'robash'
const prompt = 'robash-probe'

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const lastRole = options.messages?.at(-1)?.role
  // Child brain (explore curated agent): prove the wait primitive is
  // allow-listed, then run a denied write. The wait leg is the end-to-end
  // regression pin for the cross-platform gap: `Start-Sleep` is unreachable on
  // Windows unless BOTH the module default AND the preset patch row carry it,
  // so without that pairing this child is refused here while passing on macOS.
  if (history.includes('ROBASH_CHILD') && !history.includes('robash-probe')) {
    if (lastRole === 'tool') {
      const toolText = lastOfRole(options, 'tool')
      if (toolText.includes('ROBASH_WAIT_RAN') && !history.includes('read-only agent')) {
        return shellCall('remove-file', { path: 'fixture.txt' }, 'Try to delete the fixture')
      }
      return textChunks('MARKER_ROBASH_OK: wait ran, write was denied')
    }
    return shellCall('echo-and-wait', { text: 'ROBASH_WAIT_RAN', seconds: 1 }, 'Prove the read-only shell and its wait primitive both work')
  }
  // Parent brain: delegate to the explore curated agent.
  if (lastRole === 'tool') {
    return textChunks('parent observed robash child result')
  }
  if (history.includes('robash-probe')) {
    return toolCallChunks('delegate', {
      agent: 'explore',
      prompt: 'ROBASH_CHILD\nTASK: prove bash works, then attempt a write command\nDELIVERABLE: report both outcomes\nSCOPE: bash only\nVERIFY: the echo output and the denial both observed\nSTOP WHEN: reported',
      task_summary: 'robash child',
    })
  }
  return textChunks('unhandled robash turn')
}

function observe(obs) {
  return {
    sawRobashChild: obs.transcript.includes('ROBASH_CHILD'),
    roBashWaitSeen: obs.transcript.includes('ROBASH_WAIT_RAN'),
    roBashRmDenied: obs.transcript.includes('explicitly denied'),
  }
}

function assert(run) {
  const requests = run.requests
  const created = run.created
  const fixture = readFileSync(join(run.ws, 'fixture.txt'), 'utf8')
  run.check('parent delegated to a curated explore child', created.some((r) => r.origin === 'subagent' && r.depth === 1), JSON.stringify(created))
  run.check('child ran an allowed read-only shell command through the guard', requests.some((r) => r.sawRobashChild && r.roBashWaitSeen), JSON.stringify(requests.map((r) => [r.sawRobashChild, r.roBashWaitSeen])))
  run.check('child write command was denied by the guard', requests.some((r) => r.sawRobashChild && r.roBashRmDenied), JSON.stringify(requests.map((r) => [r.sawRobashChild, r.roBashRmDenied])))
  run.check('fixture survived the denied write command', fixture.split('\n')[0] === 'line one' && fixture.includes('CHANGED-BY-HASHLINE'), fixture)
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, assert }
