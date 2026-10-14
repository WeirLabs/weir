// Scenario: blackboard-fork — fork blackboard seeding end to end. The probe
// seeds two entries on the main session's durable root board (one promoted,
// both carrying usage counts), forks the session through the real
// agents.create path with the exact meta shape DSH's fork produces, and
// asserts the fork's board opened as a one-time snapshot of the source root
// board: entries, counts and the promotion marker cross; volatile tokens and
// subscriptions never do; the source board keeps exactly its own entries and
// the seeded fork board serves product reads.
import { lastOfRole, textChunks, toolCallChunks } from '../mock-kit.js'

const id = 'blackboard-fork'
const prompt = 'blackboard-fork-probe'

function decide(_options, obs) {
  if (!obs.toolNames.includes('blackboard_fork_check')) return textChunks('blackboard fork probe surface not ready')
  if (/^Error[: ]/.test(lastOfRole(_options, 'tool'))) return textChunks('blackboard fork acceptance failed')
  if (obs.transcript.includes('BLACKBOARD_FORK_CHECK')) return textChunks('blackboard fork seeding verified')
  return toolCallChunks('blackboard_fork_check', {})
}

function assert(run) {
  const row = run.records.find(record => record.kind === 'blackboard-fork-check')
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
  run.check('the flow completed', run.stdout.includes('blackboard fork seeding verified'), run.stdout.slice(-400))
  run.check('the fork probe tapped its report', Boolean(row), JSON.stringify(run.records.slice(-5)))
  run.check('the fork board is rooted at the fork itself at revision 0', Boolean(row) && row.rootSessionId === row.forkId && row.revision === 0, JSON.stringify(row))
  run.check('seeded entries carry bodies, counts and the promotion marker', row?.knowledge?.content === 'durable body' && row?.knowledge?.readCount === 1 && row?.knowledge?.promoted?.destination === 'runtime-map' && row?.editable?.content === 'editable body' && row?.editable?.subscribeCount === 1, JSON.stringify(row))
  run.check('no volatile authority or subscriptions cross the fork', row?.forkTokensEmpty === true && row?.forkSubscriptionsEmpty === true, JSON.stringify(row))
  run.check('the source board keeps exactly its own entries', JSON.stringify(row?.sourceKeys) === JSON.stringify(['editable', 'knowledge']), JSON.stringify(row))
  run.check('the seeded board serves product reads', row?.forkReadContent === 'durable body', JSON.stringify(row))
}

// The observation key reuses the established `probeOk` convention (the
// blackboard/blackboard-persistence scenarios) so the trace record key union
// stays inside the pinned pre-migration set.
const observe = obs => ({ probeOk: (obs?.transcript ?? '').includes('BLACKBOARD_FORK_CHECK') })

export default { id, prompt, decide, observe, assert, env: { WEIR_IT_BLACKBOARD: '1' } }
