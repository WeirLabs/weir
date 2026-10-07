// Scenario: lifecycle-inheritance — task 6.6 first-turn leak gates across the
// creation paths. An accepted parent selection is seeded through the real
// apply engine, then one-shot / background / supervised-group / escalation /
// fork children are spawned; every child must get a durable inherited
// capture (6.2) whose first prompt assembly obeys the accepted set (no
// unselected skill, ever). The parent then narrows to fixture-a only, the
// probe recaptures the newest child in-process through the same
// captureInherited the agent/created listener invokes at an explicit resume
// — child-previous ∩ current-parent (6.3) — and the parent corrupts its own
// record to prove the root fail-closed rule (6.4).
// Evidence notes: the subagent resume/escalation ∩ semantics are pinned by
// test/lifecycle-inheritance.test.js (the CLI refuses to drive subagent
// sessions directly, and send_message handles are not stable in this mock);
// the G4b yielding counter-example stays with the spike plus the 6.1 static
// no-await and timing unit tests — in this host the serial dispatch awaits a
// sleeping listener, so a sleep-shaped sabotage still captures (measured).
import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { lastOfRole, textChunks, toolCallChunks, transcript, waitForMarker } from '../mock-kit.js'

const id = 'lifecycle-inheritance'
const prompt = 'lifecycle-probe'
const resumePrompt = 'lifecycle-resume-child'

const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const lastTool = lastOfRole(options, 'tool')
  const lastUser = obs?.lastUser ?? ''
  // Child brains are keyed on the session's OWN latest user text PREFIX: a
  // fork or resumed child carries the parent's history, and delegate result
  // headings echo the child prompt ('## quick: CHILD_X — completed'), so
  // only a leading marker identifies the child itself.
  const child = marker => lastUser.startsWith(marker)

  // ---- child brains ----
  // The resumed child answers the resume prompt before any history guard.
  if (lastUser.includes(resumePrompt)) return textChunks('MARKER_RESUMED_CHILD')
  if (!history.includes(prompt)) {
    // Settled child sessions stay quiet on later turns (the selection
    // provider's invalidate re-fetches the catalog, which wakes every live
    // session with a system-reminder — without these guards a settled child
    // falls into the parent ladder and delegates at depth 1, the loop that
    // burned thirteen thousand turns in the first draft).
    if (history.includes('escalated child settled')) return textChunks('escalated child settled')
    if (history.includes('group member alpha done')) return textChunks('STATUS: completed\nREPORT: group member alpha done')
    if (history.includes('group member beta done')) return textChunks('STATUS: completed\nREPORT: group member beta done')
    if (history.includes('MARKER_SABOTAGE')) return textChunks('MARKER_SABOTAGE')
    if (history.includes('MARKER_ONESHOT')) return textChunks('MARKER_ONESHOT')
    if (history.includes('MARKER_BG')) return textChunks('MARKER_BG')
    if (history.includes('MARKER_FORK')) return textChunks('MARKER_FORK')
    if (history.includes('MARKER_RESUME_CHILD')) return textChunks('MARKER_RESUME_CHILD')
      if (child('CHILD_ONESHOT')) return textChunks('MARKER_ONESHOT')
    if (child('CHILD_BG')) return textChunks('MARKER_BG')
    if (child('GROUP_CHILD_A')) return textChunks('STATUS: completed\nREPORT: group member alpha done')
    if (child('GROUP_CHILD_B')) return textChunks('STATUS: completed\nREPORT: group member beta done')
    if (child('ESCALATE_CHILD')) {
      if (history.includes('escalation_findings')) return textChunks('escalated child settled')
      return textChunks('ESCALATE: deep-plus\nescalation_findings boundary hit')
    }
    if (child('CHILD_FORK')) return textChunks('MARKER_FORK')
    if (child('CHILD_RESUME')) return textChunks('MARKER_RESUME_CHILD')
    // Transcript-keyed first turns: a reminder can arrive before the child's
    // prompt becomes lastUser, and the escalation respawn prepends findings.
    if (history.includes('ESCALATE_CHILD')) {
      if (history.includes('escalation_findings')) return textChunks('escalated child settled')
      return textChunks('ESCALATE: deep-plus\nescalation_findings boundary hit')
    }
    if (history.includes('GROUP_CHILD_A')) return textChunks('STATUS: completed\nREPORT: group member alpha done')
    if (history.includes('GROUP_CHILD_B')) return textChunks('STATUS: completed\nREPORT: group member beta done')
    if (history.includes('CHILD_ONESHOT')) return textChunks('MARKER_ONESHOT')
    if (history.includes('CHILD_BG')) return textChunks('MARKER_BG')
    if (history.includes('CHILD_FORK')) return textChunks('MARKER_FORK')
    if (history.includes('CHILD_RESUME')) return textChunks('MARKER_RESUME_CHILD')
    return textChunks('child idle turn')
  }

  // ---- main parent brain ----
  if (lastTool.includes('LIFECYCLE_PROBE error')) return textChunks(`probe halted: ${lastTool.slice(0, 200)}`)
  if (!history.includes('done corruptSelf')) {
    return toolCallChunks('lifecycle_probe', { op: 'corruptSelf' })
  }
  if (!history.includes('done catalog')) {
    return toolCallChunks('lifecycle_probe', { op: 'catalog' })
  }
  if (!history.includes('done repairSelf')) {
    return toolCallChunks('lifecycle_probe', { op: 'repairSelf' })
  }
  if (!history.includes('done apply:[fixture-a+fixture-b]')) {
    return toolCallChunks('lifecycle_probe', { op: 'apply', skills: ['fixture-a', 'fixture-b'] })
  }
  if (!history.includes('MARKER_ONESHOT')) {
    return toolCallChunks('delegate', { category: 'quick', prompt: 'CHILD_ONESHOT\nTASK: reply with the exact marker text MARKER_ONESHOT\nDELIVERABLE: the marker\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done' })
  }
  if (!history.includes('CHILD_BG')) {
    return toolCallChunks('delegate', { category: 'quick', run_in_background: true, prompt: 'CHILD_BG\nTASK: reply with the exact marker text MARKER_BG\nDELIVERABLE: the marker\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done' })
  }
  if (!history.includes('group member alpha done')) {
    if (!history.includes('GROUP_CHILD_A')) {
      return toolCallChunks('delegate', {
        group: 'lifecycle-group',
        tasks: [
          { category: 'quick', prompt: 'GROUP_CHILD_A\nTASK: probe alpha\nDELIVERABLE: the marker\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done' },
          { category: 'quick', prompt: 'GROUP_CHILD_B\nTASK: probe beta\nDELIVERABLE: the marker\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done' },
        ],
      })
    }
    // Bounded marker wait (design D1): keep the turn alive until the alpha
    // member settles. The old gate reused lastOfRole ('Supervised group'),
    // which only worked because sleep output is empty — make the wait
    // explicit, bounded, and interleave-immune.
    const verdict = waitForMarker(history, 'group member alpha done')
    if (verdict.state === 'wait') return verdict.chunks
    return textChunks('unhandled lifecycle-inheritance wait')
  }
  if (!history.includes('escalated to deep-plus') && !lastTool.includes('escalated to deep-plus') && !history.includes('escalated child settled')) {
    return toolCallChunks('delegate', { category: 'deep', prompt: 'ESCALATE_CHILD\nTASK: probe escalation\nDELIVERABLE: the marker\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done' })
  }
  if (!history.includes('CHILD_FORK')) {
    return toolCallChunks('subagent_fork', { description: 'fork probe child', prompt: 'CHILD_FORK\nTASK: reply with the exact marker text MARKER_FORK\nDELIVERABLE: the marker\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done' })
  }
  if (!history.includes('CHILD_RESUME')) {
    return toolCallChunks('delegate', { category: 'quick', prompt: 'CHILD_RESUME\nTASK: reply with the exact marker text MARKER_RESUME_CHILD\nDELIVERABLE: the marker\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done' })
  }
  if (!history.includes('done apply:[fixture-a]')) {
    return toolCallChunks('lifecycle_probe', { op: 'apply', skills: ['fixture-a'] })
  }
  if (!history.includes('done recapture')) {
    return toolCallChunks('lifecycle_probe', { op: 'recapture' })
  }
  if (!lastTool.includes('done report')) {
    return toolCallChunks('lifecycle_probe', { op: 'report' })
  }
  return textChunks('parent observed lifecycle report')
}

function observe(obs) {
  const system = `${obs.system ?? ''}\n${obs.transcript ?? ''}`
  return {
    catalogLeak: system.includes('unselected-skill'),
    sawOneshot: obs.transcript.includes('MARKER_ONESHOT'),
    sawGroupSettled: obs.transcript.includes('group member alpha done') && obs.transcript.includes('group member beta done'),
    sawEscalated: obs.transcript.includes('escalated child settled'),
    sawFork: obs.transcript.includes('MARKER_FORK'),
    sawResumeCandidate: obs.transcript.includes('MARKER_RESUME_CHILD'),
  }
}

/** Single-boot runner with a clean lifecycle store (boot ids repeat). */
async function run(ctx) {
  // Boot session ids repeat across boots of this scenario, and a previous
  // boot's corruptSelf poison would fail the next boot's first apply. The
  // lifecycle store state this scenario drives is disposable — start clean.
  rmSync(join(ctx.IT_ROOT, 'home', 'weir', 'profiles', 'weir-it', 'capabilities', 'sessions'), { recursive: true, force: true })
  rmSync(join(ctx.IT_ROOT, 'home', 'weir', 'profiles', 'weir-it', 'capabilities', 'workspaces'), { recursive: true, force: true })
  const trace = join(ctx.IT_ROOT, `trace-${id}.jsonl`)
  const main = await ctx.spawnHeadless(['weir-it', prompt], ctx.scenarioEnv(id, trace, { WEIR_IT_LIFECYCLE: '1' }))
  return { scenario: id, trace, code: main.code, stdout: main.stdout, stderr: main.stderr }
}

function assert(run) {
  // makeRunView carries a fixed field set (records/requests/created/events
  // plus code/stdout/stderr); per-boot artifacts are read back from files,
  // the cold-session pattern.
  const itRoot = join(run.ws, '..')
  const report = readJson(join(run.ws, 'lifecycle-report.json'))
  run.check('main run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
  run.check('parent observed the lifecycle report', run.stdout.includes('parent observed lifecycle report'), run.stdout.slice(-400))
  run.check('probe report landed', Boolean(report), JSON.stringify(report ?? null).slice(0, 300))

  const inherited = Object.entries(report?.sessions ?? {}).filter(([, entry]) => entry.inherited?.revision >= 1)
  run.check('every spawn path produced a durable inherited capture', inherited.length >= 6, JSON.stringify(inherited.map(([session, entry]) => [session, entry.inherited])).slice(0, 600))
  run.check('every capture links the accepted parent', inherited.every(([, entry]) => entry.inherited.origin === 'inherited' && entry.inherited.parent?.sessionId === report.caller), JSON.stringify(inherited).slice(0, 400))
  run.check('every capture stays within the accepted set', inherited.every(([, entry]) => (entry.inherited.skillNames ?? []).every(name => ['fixture-a', 'fixture-b'].includes(name))), JSON.stringify(inherited.map(([, entry]) => entry.inherited.skillNames)))

  run.check('the explicit recapture is child-previous ∩ current-parent (6.3)', report?.recapture?.revision === 2 && (report?.recapture?.skillNames ?? []).join(',') === 'fixture-a', JSON.stringify(report?.recapture ?? null))

  const blocked = readJson(join(run.ws, 'lifecycle-catalog.json'))
  run.check('a corrupt record before any acceptance fails closed with the classified reason (6.4)', blocked?.statusReason === 'policy-unreadable:corrupt', JSON.stringify(blocked))
  run.check('the blocked catalog lists no fixture skill (never a guessed grant)', (blocked?.catalog ?? []).length === 0, JSON.stringify(blocked))
  run.check('an Apply after manual repair recovers the session (6.4 recovery entry)', (report?.sessions?.[report.caller]?.selection?.revision ?? 0) >= 2, JSON.stringify(report?.sessions?.[report.caller] ?? null).slice(0, 200))

  run.check('no request ever listed the unselected skill', run.requests.every(r => !r.catalogLeak), JSON.stringify(run.requests.filter(r => r.catalogLeak).length))
  run.check('one-shot child settled', run.requests.some(r => r.sawOneshot))
  run.check('supervised group settled', run.requests.some(r => r.sawGroupSettled))
  run.check('escalation respawn settled', run.requests.some(r => r.sawEscalated))
  run.check('fork child settled', run.requests.some(r => r.sawFork))
  run.check('resume candidate settled in the main run', run.requests.some(r => r.sawResumeCandidate))
}

export default { id, prompt, decide, observe, run, assert }
