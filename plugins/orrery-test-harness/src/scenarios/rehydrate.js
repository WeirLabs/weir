// Scenario: rehydrate — two-phase restart simulation: phase 1 spawns the
// supervised group and exits with a member still blocked; phase 2 adopts the
// SAME session in a fresh process (empty coordinator registry) and resumes on
// the rebuilt state. Migrated from mock-llm.js decideRehydrate / run.mjs
// assertRehydrate + runRehydrateScenario (D1/D2; the run override is D5).
import { join } from 'node:path'
import { IT_ROOT, lastOfRole, shellCall, textChunks, toolCallChunks, transcript } from '../mock-kit.js'
import { parseJsonlLines, readJsonl } from '../jsonl.js'
import { shellToolName } from '../shell.js'

const id = 'rehydrate'
const prompt = 'rehydrate-probe'

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  // Child A: proves the inherited toolset works via bash, then completes.
  // (The bash round-trip makes a second request whose tool list is observable
  // in the trace — the first request of an agent carries no tools there.)
  if (history.includes('REHYDRATE_CHILD_A') && !history.includes('rehydrate-probe') && !history.includes('rehydrate-resume-probe')) {
    if (options.messages?.at(-1)?.role === 'tool') {
      return textChunks('STATUS: completed\nREPORT: alpha rehydrate done')
    }
    return shellCall('echo-only', { text: 'REHYDRATE_A_BASH_RAN' }, 'prove the inherited toolset works')
  }
  // Child B: blocks in phase 1; after the post-restart resume message, completes.
  if (history.includes('REHYDRATE_CHILD_B') && !history.includes('rehydrate-probe') && !history.includes('rehydrate-resume-probe')) {
    if (history.includes('Your parent cleared your blocker')) {
      return textChunks('STATUS: completed\nREPORT: beta resumed after restart')
    }
    return textChunks('STATUS: blocked\nREPORT: rehydrate child stuck on missing payload')
  }
  // Parent phase 2 (adopted session, fresh process): resume the blocked child
  // on the rehydrated registry, then observe the group-settled signal.
  if (history.includes('rehydrate-resume-probe')) {
    if (history.includes('<supervised_group_settled')) {
      return textChunks('parent observed post-restart group-settled signal')
    }
    if (history.includes('Resumed supervised child') && !history.includes('REHYDRATE_WAITED')) {
      return shellCall('echo-and-wait', { text: 'REHYDRATE_WAITED', seconds: 2 }, 'Let the resumed child settle')
    }
    if (history.includes('REHYDRATE_WAITED')) {
      // End the turn: the group-settled signal then arrives via the deferred
      // followup — never loop on sleeps.
      return textChunks('waiting for the post-restart group-settled signal')
    }
    return toolCallChunks('resume_agent', { agent: 'beta', context: 'payload ready' })
  }
  // Parent phase 1: delegate the group, then STOP once the blocked notice
  // arrives — the run exits with the child still blocked (simulated restart
  // happens between the two phases).
  const lastRole = options.messages?.at(-1)?.role
  if (lastRole === 'tool') {
    const toolText = lastOfRole(options, 'tool')
    if (toolText.includes('Supervised group')) {
      return shellCall('wait', { seconds: 1 }, 'Let supervised children settle')
    }
    return textChunks('unhandled rehydrate tool turn')
  }
  if (history.includes('rehydrate child stuck on missing payload')) {
    return textChunks('parent observed the built-in blocked settlement; stopping before the simulated restart')
  }
  if (history.includes('rehydrate-probe') && !history.includes('Supervised group')) {
    return toolCallChunks('delegate', {
      group: 'probe-group',
      tasks: [
        { category: 'quick', name: 'alpha', prompt: 'REHYDRATE_CHILD_A\nTASK: probe alpha\nDELIVERABLE: the marker\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done' },
        { category: 'quick', name: 'beta', prompt: 'REHYDRATE_CHILD_B\nTASK: probe beta\nDELIVERABLE: the marker\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done' },
      ],
    })
  }
  return textChunks('unhandled rehydrate turn')
}

function observe(obs) {
  return {
    sawRehydrateProbe: obs.transcript.includes('rehydrate-probe'),
    settlementBlockedSeen: obs.transcript.includes('rehydrate child stuck on missing payload'),
    rehydrateResumeCallSeen: obs.transcript.includes('rehydrate-resume-probe'),
    rehydrateResumeContextSeen: obs.transcript.includes('Your parent cleared your blocker'),
    rehydrateResumedReportSeen: obs.transcript.includes('beta resumed after restart'),
    rehydrateChildASeen: obs.transcript.includes('REHYDRATE_CHILD_A'),
  }
}

/**
 * Two-phase runner override. ctx is supplied by the driver:
 *   - ctx.spawnHeadless(args, env) → Promise<{ code, stdout, stderr }>
 *   - ctx.scenarioEnv(scenarioId, trace) → the ORRERY_IT_* env for one boot
 */
async function run(ctx) {
  const trace1 = join(IT_ROOT, 'trace-rehydrate.jsonl')
  const trace2 = join(IT_ROOT, 'trace-rehydrate-phase2.jsonl')
  const p1 = await ctx.spawnHeadless(['orrery-it', '--json', prompt], ctx.scenarioEnv(id, trace1))
  const sessionLine = parseJsonlLines(p1.stdout).find((entry) => entry?.type === 'session')
  const sessionId = sessionLine?.sessionId
  if (!sessionId) {
    return { scenario: id, trace: trace1, trace2, sessionId: null, code: p1.code, stdout: p1.stdout, stderr: p1.stderr, phase1: p1, phase2: null }
  }
  const p2 = await ctx.spawnHeadless(['orrery-it', '--session-id', sessionId, 'rehydrate-resume-probe'], ctx.scenarioEnv(id, trace2))
  return { scenario: id, trace: trace1, trace2, sessionId, code: p2.code, stdout: p2.stdout, stderr: p2.stderr, phase1: p1, phase2: p2 }
}

/** Supervision facts recorded on the durable audit channel for one session. */
function auditFactsSeen(ws, sessionId) {
  if (!sessionId) return false
  const records = readJsonl(join(ws, '.orrery', 'audit.jsonl')).filter(
    (record) => record?.session === sessionId && typeof record?.type === 'string' && record.type.startsWith('orrery/supervision/'),
  )
  const kinds = records.map((record) => record.data?.kind)
  return kinds.includes('spawn') && kinds.includes('seal') && kinds.includes('settle') && kinds.includes('resume') && kinds.includes('group-settled')
}

function assert(run) {
  const requests1 = run.requests
  const requests2 = run.requests2
  const READONLY_SHELL = shellToolName()
  run.check('phase 1 session id captured', typeof run.sessionId === 'string' && run.sessionId.length > 0, JSON.stringify(run.sessionId))
  run.check('parent delegated a supervised group in phase 1', requests1.some((r) => r.emitted.includes('tool-call') && r.sawRehydrateProbe), JSON.stringify(requests1.map((r) => [r.sawRehydrateProbe, r.emitted])))
  run.check('built-in settlement notice carried the blocked report in phase 1', requests1.some((r) => r.settlementBlockedSeen), JSON.stringify(requests1.map((r) => r.settlementBlockedSeen)))
  run.check('supervised members exclude send_message, the parent keeps it', requests1.some((r) => r.rehydrateChildASeen && r.tools.length > 0 && r.tools.includes(READONLY_SHELL) && !r.tools.includes('send_message')) && requests1.some((r) => r.sawRehydrateProbe && r.tools.includes('send_message')), JSON.stringify(requests1.map((r) => [r.rehydrateChildASeen, r.tools.length, r.tools.includes('send_message')])))
  run.check('audit JSONL recorded supervision facts in phase 1', auditFactsSeen(run.ws, run.sessionId), '')
  run.check('parent resumed the blocked child on the rebuilt registry', requests2.some((r) => r.emitted.includes('tool-call') && r.rehydrateResumeCallSeen), JSON.stringify(requests2.map((r) => [r.rehydrateResumeCallSeen, r.emitted])))
  run.check('resume context reached the child after the restart', requests2.some((r) => r.rehydrateResumeContextSeen), JSON.stringify(requests2.map((r) => r.rehydrateResumeContextSeen)))
  run.check('resumed child reported completion', requests2.some((r) => r.rehydrateResumedReportSeen), JSON.stringify(requests2.map((r) => r.rehydrateResumedReportSeen)))
  run.check('parent observed the group-settled signal after the restart', run.stdout.includes('parent observed post-restart group-settled signal'), run.stdout.slice(-400))
  run.check('phase 2 exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, run, assert }
