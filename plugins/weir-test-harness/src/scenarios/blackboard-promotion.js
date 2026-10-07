// Scenario: blackboard-promotion — slice 3 end to end. The main agent writes
// one board entry, then drives the blackboard remote probe's promotion op —
// the panel button's exact pinned request path (design D8/D6) — which injects
// the promotion-evaluation brief into the SAME conversation's main agent via
// the timer-deferred steer/followup delivery. The brief arrives in history
// (never in the system prompt: before the click the agent knows NOTHING about
// promotion). The scripted agent then runs the evaluation the brief demands:
// list, read, adjudicate the one candidate through the stock ask_user_question
// funnel (the stub answers with the first option — the recommended destination
// docs/spikes.md), land the durable copy with the write tool, mark the entry
// promoted with blackboard_mark_promoted, and finish with the probe's
// promotion-verify op proving the entry is read-only with the promoted marker
// in subsequent list rows. The post-run workspace file is the doc-landing
// evidence.
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lastOfRole, toolCallChunks, textChunks, transcript, waitForMarker } from '../mock-kit.js'
import { PROMOTION_NOTICE_PREFIX } from '../../../weir-harness/src/blackboard/promote.js'

const id = 'blackboard-promotion'
const prompt = 'blackboard-promotion-probe'
const PROMO_CONTENT = 'PROMO_DURABLE_PAYLOAD'
const LANDED_MARKER = 'PROMO_LANDED'

const WRITER_SUMMARY = 'the durable finding to promote (one probe; re-verify: blackboard_list promote.key)'

const LANDED_DOC = `## S-promote promote.key\n\nFact: the durable finding to promote\nEvidence: ${PROMO_CONTENT}\nRe-verify: blackboard_list promote.key\n\n${LANDED_MARKER}\n`

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const lastTool = lastOfRole(options, 'tool')

  // Settle: the marker is the scenario's own final reply.
  if (history.includes('BB_PROMO_DONE')) return textChunks('blackboard promotion scenario finished')

  // Phase E: the read-only verification probe reported — finish.
  if (history.includes('done BB_VERIFY')) return textChunks('BB_PROMO_DONE: blackboard promotion scenario finished')

  // Phase D: the entry is marked — drive the verification probe.
  if (history.includes('Marked entry "promote.key" promoted to docs/spikes.md')) {
    return toolCallChunks('blackboard_remote_probe', { op: 'promotion-verify', _marker: 'BB_VERIFY' })
  }

  // Phase C: the promotion brief arrived — run the evaluation it demands.
  if (history.includes(PROMOTION_NOTICE_PREFIX)) {
    if (!history.includes('- promote.key (map)')) return toolCallChunks('blackboard_list', {})
    if (!history.includes(PROMO_CONTENT)) return toolCallChunks('blackboard_read', { keys: ['promote.key'] })
    // Adjudicate the one candidate through the real ask funnel: the stub
    // answers with the first option (the scripted recommendation). The
    // userQuestions fold drops settled ask results from later histories, so
    // the answer is read from the IMMEDIATE next request's lastTool, while
    // the landing marker (a regular tool result) is a monotonic history fact.
    if (lastTool.includes('"selected":["docs/spikes.md"]')) {
      return toolCallChunks('write', { file_path: 'docs/spikes.md', content: LANDED_DOC })
    }
    if (!history.includes('Created file')) {
      return toolCallChunks('ask_user_question', {
        questions: [{
          id: 'blackboard-promotion',
          question: 'Where should the blackboard entry promote.key land?',
          options: [
            { label: 'docs/spikes.md', description: 'A verified durable finding: land it in the runtime contract log.' },
            { label: 'runtime map', description: 'Layout knowledge: merge into the runtime-layout documentation.' },
            { label: 'AGENTS.md pointer', description: 'Cross-cutting discipline: a pointer in AGENTS.md.' },
            { label: 'discard', description: 'Leave the entry on the board untouched.' },
          ],
        }],
      })
	    }
	    return toolCallChunks('blackboard_mark_promoted', { key: 'promote.key', destination: 'docs/spikes.md' })
  }

  // Phase B: the entry exists — request the promotion evaluation through the
  // pinned remote service (the panel button's path), then keep the turn alive
  // until the deferred brief lands.
  if (history.includes('Created entry "promote.key"')) {
    if (!history.includes('done BB_PROMO')) {
      return toolCallChunks('blackboard_remote_probe', { op: 'promotion', _marker: 'BB_PROMO' })
    }
    const verdict = waitForMarker(history, PROMOTION_NOTICE_PREFIX)
    if (verdict.state === 'wait') return verdict.chunks
    return textChunks('waiting for the promotion brief to arrive')
  }

  // Phase A: write the candidate entry.
  return toolCallChunks('blackboard_write', { key: 'promote.key', entryType: 'map', summary: WRITER_SUMMARY, content: PROMO_CONTENT })
}

function observe(obs) {
  const history = obs?.transcript ?? ''
  const system = `${obs.system ?? ''}\n${history}`
  return {
    sawPromotionBrief: history.includes(PROMOTION_NOTICE_PREFIX),
    // The brief rides the inbox, never the system prompt: before the button
    // click the agent knows NOTHING about promotion (design D6).
    briefInSystemPrompt: system.includes(PROMOTION_NOTICE_PREFIX) && !history.includes(PROMOTION_NOTICE_PREFIX),
    adjudicated: history.includes('"selected":["docs/spikes.md"]'),
    marked: history.includes('Marked entry "promote.key" promoted to docs/spikes.md'),
    verified: /done BB_VERIFY:.*"promotedMarker":"docs\/spikes\.md"/.test(history),
  }
}

function assert(run) {
  const requests = run.requests
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
  run.check('the flow completed', run.stdout.includes('BB_PROMO_DONE'), run.stdout.slice(-400))

  // The button trigger: the pinned remote request path delivered the brief.
  run.check('the main agent received the promotion brief through the remote request', requests.some((r) => r.sawPromotionBrief), '')
  run.check('the brief never leaked into the system prompt (zero promotion knowledge before the click)', requests.every((r) => !r.briefInSystemPrompt), JSON.stringify(requests.filter((r) => r.briefInSystemPrompt).map((r) => r.system?.slice(-200))))

  // The evaluation + adjudication the brief demands, end to end.
  run.check('the agent listed and read the candidate during the evaluation', requests.some((r) => r.sawPromotionBrief && r.lastTool.includes('- promote.key (map)')) && requests.some((r) => r.sawPromotionBrief && r.lastTool.includes(PROMO_CONTENT)), '')
  run.check('the adjudication went through the stock ask_user_question funnel', requests.some((r) => Array.isArray(r.emittedNames) && r.emittedNames.includes('ask_user_question')), '')
  run.check('the scripted user answered with the recommended destination', requests.some((r) => r.adjudicated), '')

  // Doc landing: the durable copy exists in the workspace after the run.
  let landed = ''
  try { landed = readFileSync(join(run.ws, 'docs', 'spikes.md'), 'utf8') } catch { /* reported below */ }
  run.check('the durable copy landed in the target document', landed.includes(LANDED_MARKER) && landed.includes(PROMO_CONTENT), landed.slice(0, 200))

  // The after-marking: promoted + read-only with the marker in list results.
  run.check('the agent marked the entry promoted with the destination', requests.some((r) => r.marked), '')
  run.check('the verification probe saw the promoted marker and every mutation refused', requests.some((r) => r.verified && r.lastTool.includes('"writeRefused":true') && r.lastTool.includes('"removeRefused":true') && r.lastTool.includes('"applyRefused":true') && r.lastTool.includes('"alreadyMarked":true')), JSON.stringify(requests.filter((r) => r.verified).map((r) => r.lastTool.slice(0, 700))))
}

export default { id, prompt, decide, observe, assert, env: { WEIR_IT_BLACKBOARD: '1', WEIR_IT_BLACKBOARD_PROMOTION: '1' } }
