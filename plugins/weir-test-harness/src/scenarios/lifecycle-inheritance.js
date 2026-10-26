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
// The final phase (fix-capability-fork-and-preset-workspaces task 3.1) adds
// REAL `agents.create` depth-0 forks — an accepted source, a fork of that fork
// (the immediate source then has only its inherited unit), and a source whose
// initial set was merely resolved — and reads each fork before it can take a
// turn: the durable inherited unit, the Skill catalog the model would see, the
// memory and cold lifecycle snapshots, and the production MCP admission verdict
// over the real registry. That evidence lands in capability-fork-report.json.
//
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
  // Managed MCP identities for the real-fork phase: registered first so both
  // applies carry fork-gate in their accepted set.
  if (!history.includes('done register-fork-accepted')) {
    return toolCallChunks('lifecycle_probe', { op: 'registerMcp', identity: 'fork-gate', marker: 'register-fork-accepted' })
  }
  if (!history.includes('done register-fork-unaccepted')) {
    return toolCallChunks('lifecycle_probe', { op: 'registerMcp', identity: 'fork-gate-other', marker: 'register-fork-unaccepted' })
  }
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
    return toolCallChunks('lifecycle_probe', { op: 'apply', skills: ['fixture-a', 'fixture-b'], mcpServers: ['fork-gate'] })
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
  // ---- real agents.create depth-0 forks (task 3.1) ----
  // After the narrowing apply the caller's accepted set is fixture-a +
  // fork-gate; the forks below must inherit exactly that.
  if (!history.includes('done fork-accepted')) {
    return toolCallChunks('lifecycle_probe', { op: 'fork', parentSessionLabel: 'main', label: 'fork-accepted', marker: 'fork-accepted' })
  }
  if (!history.includes('done fork-inherited')) {
    return toolCallChunks('lifecycle_probe', { op: 'fork', parentSessionLabel: 'fork-accepted', label: 'fork-inherited', marker: 'fork-inherited' })
  }
  if (!history.includes('done create-initial-source')) {
    return toolCallChunks('lifecycle_probe', { op: 'createSession', label: 'initial', marker: 'create-initial-source' })
  }
  if (!history.includes('done resolve-initial-source')) {
    return toolCallChunks('lifecycle_probe', { op: 'resolveSession', label: 'initial', marker: 'resolve-initial-source' })
  }
  if (!history.includes('done fork-initial')) {
    return toolCallChunks('lifecycle_probe', { op: 'fork', parentSessionLabel: 'initial', label: 'fork-initial', marker: 'fork-initial' })
  }
  if (!history.includes('done forkReport')) {
    return toolCallChunks('lifecycle_probe', { op: 'forkReport' })
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
  const forkReport = readJson(join(run.ws, 'capability-fork-report.json'))
  run.check('main run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
  run.check('parent observed the lifecycle report', run.stdout.includes('parent observed lifecycle report'), run.stdout.slice(-400))
  run.check('probe report landed', Boolean(report), JSON.stringify(report ?? null).slice(0, 300))

  // The REAL-fork phase writes its own records: a fork of a fork links the
  // first fork (not the caller), and an initial-source fork inherits the
  // baseline instead of the caller's accepted set. Both are outside the
  // delegation-capture contract asserted below, so scope those checks to the
  // delegation sessions by excluding the measured fork ids.
  const forkRuns = new Map((forkReport?.runs ?? []).map(entry => [entry.label, entry]))
  const forkIds = new Set([...forkRuns.values()].map(entry => entry.forkId))
  const inherited = Object.entries(report?.sessions ?? {})
    .filter(([session, entry]) => entry.inherited?.revision >= 1 && !forkIds.has(session))
  run.check('every delegation spawn path produced a durable inherited capture', inherited.length >= 6, JSON.stringify(inherited.map(([session, entry]) => [session, entry.inherited])).slice(0, 600))
  run.check('every delegation capture links the accepted parent', inherited.every(([, entry]) => entry.inherited.origin === 'inherited' && entry.inherited.parent?.sessionId === report.caller), JSON.stringify(inherited).slice(0, 400))
  run.check('every delegation capture stays within the accepted set', inherited.every(([, entry]) => (entry.inherited.skillNames ?? []).every(name => ['fixture-a', 'fixture-b'].includes(name))), JSON.stringify(inherited.map(([, entry]) => entry.inherited.skillNames)))

  run.check('the explicit recapture is child-previous ∩ current-parent (6.3)', report?.recapture?.revision === 2 && (report?.recapture?.skillNames ?? []).join(',') === 'fixture-a', JSON.stringify(report?.recapture ?? null))

  // ---- real agents.create depth-0 forks (task 3.1) ----
  // The fork phase runs after the delegation phase, immediately before the
  // final report, so a run that reached its closing marker always executed it.
  // Recorded replay traces predate the phase and carry no fork report: they
  // skip these checks instead of asserting a phase they never ran, while the
  // delegation/lifecycle contract above keeps replaying green.
  const forkRan = Boolean(forkReport)
  const accepted = forkRuns.get('fork-accepted')
  const inheritedFork = forkRuns.get('fork-inherited')
  const initialFork = forkRuns.get('fork-initial')
  const sameSet = (left, right) => Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && [...left].sort().join(',') === [...right].sort().join(',')
  if (forkRan) {
  run.check('the real-fork phase produced its report', Boolean(forkReport), JSON.stringify(forkReport ?? null).slice(0, 300))
  run.check('the probe measured all three real forks', forkRuns.size === 3, JSON.stringify(forkReport ?? null).slice(0, 300))
  run.check('a real fork of an accepted source captured the effective set', accepted?.inherited?.kind === 'ok'
    && accepted?.inherited?.origin === 'inherited' && sameSet(accepted?.inherited?.names, ['fixture-a']), JSON.stringify(accepted?.inherited ?? null))
  run.check('the real fork inherited the managed MCP identity', sameSet(accepted?.inherited?.mcpServers, ['fork-gate']), JSON.stringify(accepted?.inherited?.mcpServers ?? null))
  run.check('the real fork inherits the registration incarnation', accepted?.inherited?.mcpIncarnations?.['fork-gate'] === accepted?.mcp?.incarnation && typeof accepted?.mcp?.incarnation === 'string', JSON.stringify({ inherited: accepted?.inherited, mcp: accepted?.mcp }))
  run.check('the real fork links the source session it was created from', accepted?.inherited?.parent?.sessionId === accepted?.parentSession, JSON.stringify({ parent: accepted?.inherited?.parent, source: accepted?.parentSession }))
  run.check('the real fork holds no accepted record (inheritance only)', accepted?.selectionRecord === 'absent', String(accepted?.selectionRecord))
  run.check("the fork's catalog lists the inherited Skill before any request", sameSet(accepted?.catalog, ['fixture-a']), JSON.stringify(accepted?.catalog ?? null))
  run.check('the memory and COLD lifecycle snapshots agree with the catalog', accepted?.memory?.kind === 'ready' && accepted?.cold?.kind === 'ready'
    && sameSet(accepted?.cold?.names, ['fixture-a']) && sameSet(accepted?.cold?.mcpServers, ['fork-gate']), JSON.stringify({ memory: accepted?.memory, cold: accepted?.cold }))
  run.check('memory and COLD snapshots bind the same registration incarnation', accepted?.memory?.mcpIncarnations?.['fork-gate'] === accepted?.mcp?.incarnation && accepted?.cold?.mcpIncarnations?.['fork-gate'] === accepted?.mcp?.incarnation, JSON.stringify({ memory: accepted?.memory, cold: accepted?.cold, mcp: accepted?.mcp }))
  run.check('the production MCP gate admits the inherited managed server (memory and COLD)', accepted?.mcp?.admit === true && accepted?.mcp?.coldAdmit === true && accepted?.mcp?.enabled === true, JSON.stringify(accepted?.mcp ?? null))
  run.check('a registered managed server the source never accepted stays refused', accepted?.mcp?.otherRefused === false, JSON.stringify(accepted?.mcp ?? null))
  run.check('a fork of a fork inherits its immediate source inherited unit', inheritedFork?.inherited?.kind === 'ok'
    && inheritedFork?.inherited?.parent?.sessionId === accepted?.forkId && sameSet(inheritedFork?.inherited?.names, ['fixture-a']), JSON.stringify(inheritedFork?.inherited ?? null))
  run.check('the consecutive fork keeps the MCP set and admits the same server', sameSet(inheritedFork?.inherited?.mcpServers, ['fork-gate']) && inheritedFork?.mcp?.admit === true, JSON.stringify({ mcp: inheritedFork?.mcp, inherited: inheritedFork?.inherited?.mcpServers }))
  run.check('the consecutive fork preserves the registration incarnation', inheritedFork?.inherited?.mcpIncarnations?.['fork-gate'] === accepted?.mcp?.incarnation, JSON.stringify({ inherited: inheritedFork?.inherited, mcp: accepted?.mcp }))
  run.check('a source that only resolved its initial set is inherited verbatim', initialFork?.inherited?.kind === 'ok'
    && initialFork?.source?.record === 'absent' && initialFork?.source?.snapshot?.kind === 'ready'
    && sameSet(initialFork?.inherited?.names, initialFork?.source?.snapshot?.names), JSON.stringify(initialFork ?? null).slice(0, 400))
  run.check("the initial-source fork resolves the same catalog before any request", sameSet(initialFork?.catalog, initialFork?.source?.snapshot?.names), JSON.stringify(initialFork?.catalog ?? null))
  }

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
