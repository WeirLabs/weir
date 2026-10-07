// Zombie lane-binding reclamation (worktree-zombie-lane-reclamation): unit
// coverage for the three LANE_BUSY reconciliation points (bind/check/abandon),
// the bindingLiveness probe, the D3 restart-rebuild re-emission, and the D4
// force-reclaim card. Lives in the test-harness package because the lane scope
// does not cover plugins/weir-harness/test/**; cross-package imports follow
// the audit-types.test.js precedent.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { exec } from 'node:child_process'
import { appendFileSync, mkdtempSync, mkdirSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createGit } from '../../weir-harness/src/worktree/git.js'
import { createLaneService } from '../../weir-harness/src/worktree/lanes.js'
import { createBindingLiveness } from '../../weir-harness/src/worktree/index.js'
import { cardCopy } from '../../weir-harness/src/worktree/cards.js'
import { createGroupCoordinator } from '../../weir-harness/src/delegate/group-coordinator.js'
import { applyChildLogRecovery } from '../../weir-harness/src/delegate/rehydrate.js'
import { mountSupervision } from '../../weir-harness/src/delegate/supervision-mount.js'
import { makeRepo, nodeGitRun } from '../../weir-harness/test/helpers/worktree-fixtures.js'

/** Shell runner over child_process with the host runner's result shape. */
function nodeShellRun({ command, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output: `${stdout}${stderr}`, denied: false, timedOut: Boolean(error?.killed) })
    })
  })
}

const EVIDENCE = { source: 'audit', detail: 'weir/supervision/settle (childId child-1)' }

/** A probe verdict per quadrant (design D2). */
const verdicts = {
  cleared: { childAlive: false, ownerAlive: false, terminalEvidence: EVIDENCE },
  ownerLive: { childAlive: false, ownerAlive: true, terminalEvidence: EVIDENCE },
  childLive: { childAlive: true, ownerAlive: false, terminalEvidence: EVIDENCE },
  noEvidence: { childAlive: false, ownerAlive: false, terminalEvidence: null },
}

function harness({ ask = null, bindingLiveness } = {}) {
  const fixture = makeRepo()
  const notices = []
  const audits = []
  const asked = []
  const warnings = []
  const service = createLaneService({
    git: createGit(nodeGitRun),
    shellRun: nodeShellRun,
    settings: () => ({ enabled: true, root: '.weir/worktrees', maxActive: 4, autoSetup: true }),
    ask: ask ? async (agent, questions) => { asked.push(questions); return ask(questions) } : null,
    notify: (sessionId, text) => notices.push({ sessionId, text }),
    audit: (type, data, root) => audits.push({ type, data, root }),
    modeOf: () => false,
    logger: { warn: (message) => warnings.push(message) },
    ...(bindingLiveness !== undefined ? { bindingLiveness } : {}),
  })
  const session = { id: 'main-1', header: { cwd: fixture.repo } }
  const agent = { session }
  return { ...fixture, service, session, agent, notices, audits, asked, warnings }
}

const laneOf = async (h, id) => (await h.service.repoFor(h.repo)).ledger.read().lanes.find((lane) => lane.id === id)

/** Open a lane and bind a writer child to it (lane is `working` afterwards). */
async function boundLane(h, childId = 'child-1', title = 'Zombie work') {
  const opened = await h.service.open(h.session, { title })
  const bound = await h.service.prepareBind(h.session, opened.lane, { readOnly: false })
  await bound.commit(childId)
  return opened.lane
}

const probeReturning = (verdict) => async () => verdict
const reconcileAudits = (h) => h.audits.filter((entry) => entry.type === 'reconcile-binding')

describe('binding reconciliation: cleared quadrant (terminal evidence ∧ both sides dead)', () => {
  it('check proceeds through the settle path and audits the reclamation once', async () => {
    const h = harness({ bindingLiveness: probeReturning(verdicts.cleared) })
    try {
      const laneId = await boundLane(h)
      const checked = await h.service.check(h.session, laneId)
      // No commits in the lane: the settle-triggered host check concludes no-commits.
      assert.equal(checked.state, 'no-commits')
      assert.equal((await laneOf(h, laneId)).boundChild, null)
      const audits = reconcileAudits(h)
      assert.equal(audits.length, 1)
      assert.equal(audits[0].data.lane, laneId)
      assert.equal(audits[0].data.child, 'child-1')
      assert.equal(audits[0].data.ownerSession, 'main-1')
      assert.equal(audits[0].data.forced, false)
      assert.deepEqual(audits[0].data.evidence, EVIDENCE)
      assert.equal(audits[0].data.childAlive, false)
      assert.equal(audits[0].data.ownerAlive, false)
      assert.equal(audits[0].root, h.repo)
    } finally {
      h.cleanup()
    }
  })

  it('rebind proceeds from the post-settle state', async () => {
    const h = harness({ bindingLiveness: probeReturning(verdicts.cleared) })
    try {
      const laneId = await boundLane(h)
      const bound = await h.service.prepareBind(h.session, laneId, { readOnly: false })
      await bound.commit('child-2')
      const lane = await laneOf(h, laneId)
      assert.equal(lane.state, 'working')
      assert.equal(lane.boundChild, 'child-2')
      assert.equal(reconcileAudits(h).length, 1)
    } finally {
      h.cleanup()
    }
  })

  it('abandon proceeds after the automatic settlement', async () => {
    const h = harness({ bindingLiveness: probeReturning(verdicts.cleared) })
    try {
      const laneId = await boundLane(h)
      const abandoned = await h.service.abandon(h.agent, laneId, { mode: 'keep' })
      assert.equal(abandoned.state, 'abandoned')
      const audits = reconcileAudits(h)
      assert.equal(audits.length, 1)
      assert.equal(audits[0].data.forced, false)
    } finally {
      h.cleanup()
    }
  })

  it('repeated reconciliation does not double-audit (childSettled idempotency)', async () => {
    const h = harness({ bindingLiveness: probeReturning(verdicts.cleared) })
    try {
      const laneId = await boundLane(h)
      await h.service.check(h.session, laneId)
      await h.service.check(h.session, laneId)
      await h.service.prepareBind(h.session, laneId, { readOnly: true })
      assert.equal(reconcileAudits(h).length, 1)
    } finally {
      h.cleanup()
    }
  })
})

describe('binding reconciliation: refusing quadrants', () => {
  for (const [name, verdict] of [['owner live', verdicts.ownerLive], ['child live', verdicts.childLive], ['no terminal evidence', verdicts.noEvidence]]) {
    it(`${name}: bind, check and abandon all keep the LANE_BUSY refusal`, async () => {
      const h = harness({ bindingLiveness: probeReturning(verdict) })
      try {
        const laneId = await boundLane(h)
        await assert.rejects(h.service.prepareBind(h.session, laneId, { readOnly: false }), (error) => error.code === 'LANE_BUSY')
        await assert.rejects(h.service.check(h.session, laneId), (error) => error.code === 'LANE_BUSY')
        await assert.rejects(h.service.abandon(h.agent, laneId, { mode: 'keep' }), (error) => error.code === 'LANE_BUSY')
        const lane = await laneOf(h, laneId)
        assert.equal(lane.state, 'working')
        assert.equal(lane.boundChild, 'child-1')
        assert.equal(reconcileAudits(h).length, 0)
      } finally {
        h.cleanup()
      }
    })
  }

  it('an absent probe dep keeps the legacy refusal (no reconciliation)', async () => {
    const h = harness()
    try {
      const laneId = await boundLane(h)
      await assert.rejects(h.service.check(h.session, laneId), (error) => error.code === 'LANE_BUSY')
      assert.equal(reconcileAudits(h).length, 0)
    } finally {
      h.cleanup()
    }
  })

  it('a throwing probe keeps the refusal and warns', async () => {
    const h = harness({ bindingLiveness: async () => { throw new Error('probe exploded') } })
    try {
      const laneId = await boundLane(h)
      await assert.rejects(h.service.check(h.session, laneId), (error) => error.code === 'LANE_BUSY')
      assert.ok(h.warnings.some((message) => message.includes('probe exploded')))
      assert.equal(reconcileAudits(h).length, 0)
    } finally {
      h.cleanup()
    }
  })
})

describe('force-reclaim (D4): the abandon card on a disputed binding', () => {
  it('the disputed card states the reconciliation outcome and force-reclaim settles audited forced:true', async () => {
    const copy = cardCopy('en')
    const answers = [copy.forceReclaim, copy.choices.keep]
    const h = harness({
      bindingLiveness: probeReturning(verdicts.noEvidence),
      ask: async (questions) => ({ answers: [{ id: questions[0].id, selected: [answers.shift()] }] }),
    })
    try {
      const laneId = await boundLane(h)
      const abandoned = await h.service.abandon(h.agent, laneId)
      assert.equal(abandoned.state, 'abandoned')
      // Two cards: the disputed force-reclaim card, then the mode card.
      assert.equal(h.asked.length, 2)
      const [disputed, modeCard] = h.asked
      assert.deepEqual(disputed[0].options.map((option) => option.label), [copy.forceReclaim, copy.cancel])
      assert.ok(disputed[0].detail.includes('Disputed worker binding'))
      assert.ok(disputed[0].detail.includes('child-1'))
      assert.ok(disputed[0].detail.includes(copy.disputedReasons.noEvidence))
      assert.ok(modeCard[0].detail.includes('Binding force-reclaimed'))
      const audits = reconcileAudits(h)
      assert.equal(audits.length, 1)
      assert.equal(audits[0].data.forced, true)
      assert.equal(audits[0].data.child, 'child-1')
    } finally {
      h.cleanup()
    }
  })

  it('cancelling the disputed card leaves the binding and the lane untouched', async () => {
    const copy = cardCopy('en')
    const h = harness({
      bindingLiveness: probeReturning(verdicts.ownerLive),
      ask: async (questions) => ({ answers: [{ id: questions[0].id, selected: [copy.cancel] }] }),
    })
    try {
      const laneId = await boundLane(h)
      const outcome = await h.service.abandon(h.agent, laneId)
      assert.ok(outcome.summary.includes('not abandoned'))
      const lane = await laneOf(h, laneId)
      assert.equal(lane.state, 'working')
      assert.equal(lane.boundChild, 'child-1')
      assert.equal(reconcileAudits(h).length, 0)
    } finally {
      h.cleanup()
    }
  })

  it('an automatically reconciled binding is disclosed on the mode card (not forced)', async () => {
    const copy = cardCopy('en')
    const h = harness({
      bindingLiveness: probeReturning(verdicts.cleared),
      ask: async (questions) => ({ answers: [{ id: questions[0].id, selected: [copy.choices.keep] }] }),
    })
    try {
      const laneId = await boundLane(h)
      await h.service.abandon(h.agent, laneId)
      assert.equal(h.asked.length, 1)
      assert.ok(h.asked[0][0].detail.includes('Binding reconciliation'))
      assert.ok(h.asked[0][0].detail.includes('settled automatically'))
      const audits = reconcileAudits(h)
      assert.equal(audits.length, 1)
      assert.equal(audits[0].data.forced, false)
    } finally {
      h.cleanup()
    }
  })
})

describe('disputed-card copy (both locales)', () => {
  const lane = { id: 'a-001', title: 'Fix login', state: 'working', branch: 'weir/a-001', base: { branch: 'main' }, path: '/r/.weir/worktrees/a-001' }

  it('maps the verdict to the right standing reason', () => {
    for (const locale of ['en', 'zh']) {
      const copy = cardCopy(locale)
      assert.equal(copy.disputedReason({ childAlive: true, ownerAlive: false, terminalEvidence: null }), copy.disputedReasons.childLive)
      assert.equal(copy.disputedReason({ childAlive: false, ownerAlive: true, terminalEvidence: null }), copy.disputedReasons.ownerLive)
      assert.equal(copy.disputedReason({ childAlive: false, ownerAlive: false, terminalEvidence: null }), copy.disputedReasons.noEvidence)
      assert.equal(copy.disputedReason(null), copy.disputedReasons.unavailable)
    }
  })

  it('the disputed detail names the worker and the reason as its own warning paragraph', () => {
    for (const locale of ['en', 'zh']) {
      const copy = cardCopy(locale)
      const detail = copy.abandonDisputedDetail(lane, 'child-9', { childAlive: false, ownerAlive: true, terminalEvidence: null }, '/r')
      const paragraphs = detail.split('\n\n')
      assert.ok(paragraphs[0].split('\n').every((line) => line.startsWith('- ')))
      const warning = paragraphs.at(-1)
      assert.ok(warning.startsWith('⚠️'))
      assert.ok(warning.includes('child-9'))
      assert.ok(warning.includes(copy.disputedReasons.ownerLive))
      assert.ok(locale === 'zh' ? warning.includes('审计记录为强制') : warning.includes('audited as forced'))
      assert.ok(copy.forceReclaim.length > 0 && copy.forceReclaim !== copy.cancel)
      assert.ok(copy.forceReclaimDescription.length > 0)
    }
  })

  it('the mode card discloses a settled binding (forced and automatic wordings differ)', () => {
    for (const locale of ['en', 'zh']) {
      const copy = cardCopy(locale)
      const forced = copy.abandonDetail(lane, 0, '/r', null, { child: 'child-9', forced: true })
      const automatic = copy.abandonDetail(lane, 0, '/r', null, { child: 'child-9', forced: false })
      assert.ok(forced.includes(copy.reconciledNote('child-9', true)))
      assert.ok(automatic.includes(copy.reconciledNote('child-9', false)))
      assert.notEqual(copy.reconciledNote('child-9', true), copy.reconciledNote('child-9', false))
      // No settled binding → byte-identical to the pre-disclosure shape.
      assert.ok(!copy.abandonDetail(lane, 0, '/r').includes('child-9'))
    }
  })
})

describe('createBindingLiveness (worktree/index.js probe)', () => {
  function makeCtx({ agents = new Map(), sessionQuery } = {}) {
    return { get: (name) => ({ agents, sessionQuery })[name] }
  }
  function makeRoot() {
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'weir-bl-')))
    mkdirSync(join(root, '.weir'), { recursive: true })
    return { root, cleanup: () => rmSync(root, { recursive: true, force: true }) }
  }
  const auditRecord = (type, data) => `${JSON.stringify({ time: 1, session: 'owner-1', type, data })}\n`

  it('finds a settle fact in the audit tail as terminal evidence', async () => {
    const { root, cleanup } = makeRoot()
    try {
      appendFileSync(join(root, '.weir', 'audit.jsonl'), auditRecord('weir/supervision/settle', { kind: 'settle', childId: 'child-1', status: 'completed', report: 'done' }))
      const verdict = await createBindingLiveness(makeCtx())('child-1', 'owner-1', { root })
      assert.deepEqual(verdict, { childAlive: false, ownerAlive: false, terminalEvidence: { source: 'audit', detail: 'weir/supervision/settle (childId child-1)' } })
    } finally {
      cleanup()
    }
  })

  it('finds a terminate fact in the audit tail as terminal evidence', async () => {
    const { root, cleanup } = makeRoot()
    try {
      appendFileSync(join(root, '.weir', 'audit.jsonl'), auditRecord('weir/supervision/terminate', { kind: 'terminate', childId: 'child-1', reason: 'redirected' }))
      const verdict = await createBindingLiveness(makeCtx())('child-1', 'owner-1', { root })
      assert.equal(verdict.terminalEvidence?.source, 'audit')
    } finally {
      cleanup()
    }
  })

  it('falls back to the child session log terminal STATUS report', async () => {
    const { root, cleanup } = makeRoot()
    try {
      const sessionQuery = {
        readSession: async (childId) => ({
          events: childId === 'child-1'
            ? [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'STATUS: completed\nREPORT: shipped' }] } } }]
            : [],
        }),
      }
      const verdict = await createBindingLiveness(makeCtx({ sessionQuery }))('child-1', 'owner-1', { root })
      assert.deepEqual(verdict.terminalEvidence, { source: 'session-log', detail: 'terminal STATUS: completed' })
    } finally {
      cleanup()
    }
  })

  it('reports liveness from the agents registry and skips the evidence search for a live child', async () => {
    const { root, cleanup } = makeRoot()
    try {
      appendFileSync(join(root, '.weir', 'audit.jsonl'), auditRecord('weir/supervision/settle', { kind: 'settle', childId: 'child-1', status: 'completed', report: 'done' }))
      const verdict = await createBindingLiveness(makeCtx({ agents: new Map([['child-1', {}], ['owner-1', {}]]) }))('child-1', 'owner-1', { root })
      assert.equal(verdict.childAlive, true)
      assert.equal(verdict.ownerAlive, true)
      assert.equal(verdict.terminalEvidence, null)
    } finally {
      cleanup()
    }
  })

  it('returns no evidence when neither source has a terminal fact', async () => {
    const { root, cleanup } = makeRoot()
    try {
      appendFileSync(join(root, '.weir', 'audit.jsonl'), auditRecord('weir/supervision/settle', { kind: 'settle', childId: 'someone-else', status: 'completed', report: '' }))
      const sessionQuery = { readSession: async () => ({ events: [] }) }
      const verdict = await createBindingLiveness(makeCtx({ sessionQuery }))('child-1', 'owner-1', { root })
      assert.deepEqual(verdict, { childAlive: false, ownerAlive: false, terminalEvidence: null })
    } finally {
      cleanup()
    }
  })

  it('a blocked settle fact in the audit tail is NOT terminal evidence (D6)', async () => {
    const { root, cleanup } = makeRoot()
    try {
      appendFileSync(join(root, '.weir', 'audit.jsonl'), auditRecord('weir/supervision/settle', { kind: 'settle', childId: 'child-1', status: 'blocked', report: 'standing by' }))
      const verdict = await createBindingLiveness(makeCtx())('child-1', 'owner-1', { root })
      assert.deepEqual(verdict, { childAlive: false, ownerAlive: false, terminalEvidence: null })
    } finally {
      cleanup()
    }
  })

  it('a STATUS: blocked final word in the child log is NOT terminal evidence (D6)', async () => {
    const { root, cleanup } = makeRoot()
    try {
      const sessionQuery = {
        readSession: async () => ({
          events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'STATUS: blocked\nREPORT: still waiting' }] } } }],
        }),
      }
      const verdict = await createBindingLiveness(makeCtx({ sessionQuery }))('child-1', 'owner-1', { root })
      assert.equal(verdict.terminalEvidence, null)
    } finally {
      cleanup()
    }
  })

  it('a blocked settle followed by a completed settle in the audit tail IS terminal evidence (D6)', async () => {
    const { root, cleanup } = makeRoot()
    try {
      appendFileSync(join(root, '.weir', 'audit.jsonl'), auditRecord('weir/supervision/settle', { kind: 'settle', childId: 'child-1', status: 'blocked', report: 'standing by' }))
      appendFileSync(join(root, '.weir', 'audit.jsonl'), auditRecord('weir/supervision/settle', { kind: 'settle', childId: 'child-1', status: 'completed', report: 'done after resume' }))
      const verdict = await createBindingLiveness(makeCtx())('child-1', 'owner-1', { root })
      assert.deepEqual(verdict.terminalEvidence, { source: 'audit', detail: 'weir/supervision/settle (childId child-1)' })
    } finally {
      cleanup()
    }
  })
})

describe('rebuild re-emission (D3): pure layer', () => {
  it('hydrate re-emits a settle/terminate fact per TERMINAL member (blocked is skipped), tagged with its evidence', () => {
    const facts = []
    const coordinator = createGroupCoordinator({
      sendTo: async () => {},
      interruptChild: () => {},
      schedule: () => {},
      onFact: (fact) => facts.push(fact),
    })
    coordinator.hydrate({
      children: [
        { id: 'c1', name: 'alpha', group: 'g', status: 'completed', report: 'done' },
        { id: 'c2', name: 'beta', group: 'g', status: 'terminated', report: 'redirected' },
        { id: 'c3', name: 'gamma', group: 'g', status: 'running', report: '' },
        { id: 'c4', name: 'delta', group: 'g', status: 'blocked', report: 'stuck' },
      ],
      groups: [],
      untracked: [],
      confidence: 'full',
      recovered: [{ childId: 'c4', status: 'blocked', report: 'stuck' }],
    })
    // resumable-lane-workers D6(b): c4 (blocked) is NOT re-emitted — blocked
    // is a stand-by, not a terminal outcome, and a restart must not
    // manufacture fresh settle evidence for a still-resumable member.
    assert.deepEqual(facts, [
      { kind: 'settle', childId: 'c1', status: 'completed', report: 'done', recovered: true, evidence: 'audit-replay' },
      { kind: 'terminate', childId: 'c2', reason: 'redirected', recovered: true, evidence: 'audit-replay' },
    ])
  })

  it('applyChildLogRecovery records the promoted members in state.recovered', async () => {
    const state = {
      children: [{ id: 'c1', name: 'alpha', group: 'g', status: 'running', report: '', retries: 0, lastText: '' }],
      groups: [],
      untracked: [{ id: 'orphan-1', label: 'leftover', mode: 'continuable' }],
      confidence: 'partial',
    }
    await applyChildLogRecovery(state, async (childId) => ({
      c1: 'STATUS: completed\nREPORT: refined',
      'orphan-1': 'STATUS: blocked\nREPORT: promoted',
    })[childId] ?? null)
    assert.deepEqual(state.recovered, [
      { childId: 'orphan-1', status: 'blocked', report: 'promoted' },
      { childId: 'c1', status: 'completed', report: 'refined' },
    ])
  })

  it('applyChildLogRecovery records an empty list when nothing promotes', async () => {
    const state = { children: [], groups: [], untracked: [], confidence: 'partial' }
    await applyChildLogRecovery(state, async () => null)
    assert.deepEqual(state.recovered, [])
  })
})

describe('restart rebuild (D3): re-emitted settlement frees the zombie lane', () => {
  it('a lane bound to a recovered-terminal child clears exactly as a live settle', async () => {
    const h = harness()
    try {
      // Zombie lane: bound to child c1 whose settle fact was never delivered.
      const zombieId = await boundLane(h, 'c1', 'Zombie lane')
      // Control lane: a live settle for comparison.
      const controlId = await boundLane(h, 'c2', 'Control lane')
      await h.service.childSettled('c2', h.session, { silent: true })
      const control = await laneOf(h, controlId)

      const audits = []
      const handlers = new Map()
      const ctx = {
        on: (event, fn) => handlers.set(event, fn),
        subagents: {
          sendMessage: async () => {},
          interrupt: () => {},
          listChildren: async () => [{ id: 'c1', label: 'zombie', mode: 'continuable' }],
        },
        get: (name) => ({
          sessionQuery: {
            readSession: async () => ({ events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'STATUS: completed\nREPORT: done before the restart' }] } } }] }),
          },
        })[name],
        logger: { warn: () => {} },
      }
      const parent = { id: 'main-1', session: h.session, status: 'idle', steer: () => {}, followup: () => {} }
      const mount = mountSupervision({
        ctx,
        audit: (session, type, payload) => audits.push({ session, type, payload }),
        supervisionNow: () => ({}),
        onChildSettled: (childId, p) => {
          void h.service.childSettled(childId, p?.session, { silent: true })?.catch?.(() => {})
        },
      })
      await mount.coordinatorFor(parent)
      // The re-emitted settle fact rides a microtask before reaching the lane,
      // and the settle-triggered host check is async: wait for the full
      // post-settle state, not just the cleared binding.
      const deadline = Date.now() + 10_000
      let recovered = await laneOf(h, zombieId)
      while ((recovered.boundChild !== null || recovered.state === 'working') && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20))
        recovered = await laneOf(h, zombieId)
      }
      assert.equal(recovered.boundChild, null)
      assert.equal(recovered.state, control.state)
      // The recovery promotion closed its audit trail: a settle fact exists.
      assert.ok(audits.some((entry) => entry.type === 'supervision/settle' && entry.payload?.childId === 'c1'))
      mount.dispose()
    } finally {
      h.cleanup()
    }
  })
})

describe('resumable lane workers (resumable-lane-workers D1/D2): terminal-only lane settlement', () => {
  // A lane-bound supervised member reporting blocked keeps its lane binding
  // (resume_agent continues it); only the terminal report frees the lane and
  // runs the host check. Driven through the REAL mount + lane service.
  function mountFor(h) {
    const audits = []
    const handlers = new Map()
    const ctx = {
      on: (event, fn) => handlers.set(event, fn),
      subagents: { sendMessage: async () => {}, interrupt: () => {}, listChildren: async () => [] },
      get: () => undefined,
      logger: { warn: () => {} },
    }
    const parent = { id: 'main-1', session: h.session, status: 'idle', steer: () => {}, followup: () => {} }
    const mount = mountSupervision({
      ctx,
      audit: (session, type, payload) => audits.push({ session, type, payload }),
      supervisionNow: () => ({}),
      onChildSettled: (childId, p) => {
        void h.service.childSettled(childId, p?.session, { silent: true })?.catch?.(() => {})
      },
    })
    const feed = (session, event) => handlers.get('session/event')(session, event)
    return { mount, parent, audits, feed }
  }

  async function statusTurn(feed, childId, status) {
    feed({ id: childId }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: `STATUS: ${status}\nREPORT: ${status} report` }] } } })
    feed({ id: childId }, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  async function awaitSettled(h, laneId) {
    const deadline = Date.now() + 10_000
    let lane = await laneOf(h, laneId)
    while ((lane.boundChild !== null || lane.state === 'working') && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20))
      lane = await laneOf(h, laneId)
    }
    return lane
  }

  async function runningMember(h, childId = 'child-1') {
    const laneId = await boundLane(h, childId, 'Resumable work')
    const kit = mountFor(h)
    const coordinator = await kit.mount.coordinatorFor(kit.parent)
    coordinator.hydrate({
      children: [{ id: childId, name: 'worker', group: `lane:${laneId}`, status: 'running' }],
      groups: [{ name: `lane:${laneId}`, sealed: true, memberIds: [childId] }],
      untracked: [],
      confidence: 'full',
    })
    return { laneId, coordinator, ...kit }
  }

  it('blocked keeps the lane working and bound (no host check), rebind stays LANE_BUSY; resume -> completed frees and checks it', async () => {
    const h = harness()
    try {
      const { laneId, coordinator, mount, feed, audits } = await runningMember(h)

      await statusTurn(feed, 'child-1', 'blocked')
      // The blocked settle fact is audited, but the lane is untouched: still
      // working, still bound, and NO host check ran (a settle-triggered check
      // would have moved the lane out of `working`).
      assert.ok(audits.some((entry) => entry.type === 'supervision/settle' && entry.payload?.status === 'blocked'))
      let lane = await laneOf(h, laneId)
      assert.equal(lane.state, 'working')
      assert.equal(lane.boundChild, 'child-1')

      // A second writer is still refused — the binding survived the blocked report.
      await assert.rejects(h.service.prepareBind(h.session, laneId, { readOnly: false }), (error) => error.code === 'LANE_BUSY')
      lane = await laneOf(h, laneId)
      assert.equal(lane.boundChild, 'child-1')

      // Resume (no lane-side re-bind needed) -> the terminal completed report
      // settles the lane through the normal childSettled path.
      const resumed = await coordinator.resume('child-1', 'blocker cleared')
      assert.equal(resumed.status, 'running')
      await statusTurn(feed, 'child-1', 'completed')
      lane = await awaitSettled(h, laneId)
      assert.equal(lane.boundChild, null)
      assert.equal(lane.state, 'no-commits')
      mount.dispose()
    } finally {
      h.cleanup()
    }
  })

  it('terminating a blocked member frees the lane and runs the host check (regression)', async () => {
    const h = harness()
    try {
      const { laneId, coordinator, mount, feed } = await runningMember(h)
      await statusTurn(feed, 'child-1', 'blocked')
      assert.equal((await laneOf(h, laneId)).boundChild, 'child-1')

      coordinator.terminate('child-1', 'redirected elsewhere')
      const lane = await awaitSettled(h, laneId)
      assert.equal(lane.boundChild, null)
      assert.equal(lane.state, 'no-commits')
      mount.dispose()
    } finally {
      h.cleanup()
    }
  })

  it('a restart rebuild of a blocked lane-bound member re-emits NOTHING: binding kept, no fresh audit settle fact, member stays resumable (D6b)', async () => {
    const h = harness()
    try {
      const laneId = await boundLane(h, 'child-1', 'Resumable work')
      const { mount, parent, audits } = mountFor(h)
      const coordinator = await mount.coordinatorFor(parent)
      coordinator.hydrate({
        children: [{ id: 'child-1', name: 'worker', group: `lane:${laneId}`, status: 'blocked', report: 'stuck across the restart' }],
        groups: [{ name: `lane:${laneId}`, sealed: true, memberIds: ['child-1'] }],
        untracked: [],
        confidence: 'full',
      })
      await new Promise((resolve) => setTimeout(resolve, 50))

      const lane = await laneOf(h, laneId)
      assert.equal(lane.state, 'working')
      assert.equal(lane.boundChild, 'child-1')
      assert.ok(!audits.some((entry) => entry.type === 'supervision/settle' && entry.payload?.childId === 'child-1'))

      const resumed = await coordinator.resume('child-1', 'go again')
      assert.equal(resumed.status, 'running')
      mount.dispose()
    } finally {
      h.cleanup()
    }
  })
})

describe('binding reconciliation: blocked is not terminal evidence (resumable-lane-workers D6)', () => {
  // Lane-level quadrants through the REAL createBindingLiveness probe.
  const realProbe = () => (child, owner, context) =>
    createBindingLiveness({ get: (name) => ({ agents: new Map() })[name] })(child, owner, context)
  const auditLine = (data) => `${JSON.stringify({ time: 1, session: 'main-1', type: 'weir/supervision/settle', data })}\n`

  it('blocked-only audit evidence + both sides dead keeps the LANE_BUSY refusal (the force-reclaim card is the escape)', async () => {
    const h = harness({ bindingLiveness: realProbe() })
    try {
      const laneId = await boundLane(h)
      appendFileSync(join(h.repo, '.weir', 'audit.jsonl'), auditLine({ kind: 'settle', childId: 'child-1', status: 'blocked', report: 'standing by' }))
      await assert.rejects(h.service.check(h.session, laneId), (error) => error.code === 'LANE_BUSY')
      const lane = await laneOf(h, laneId)
      assert.equal(lane.state, 'working')
      assert.equal(lane.boundChild, 'child-1')
      assert.equal(reconcileAudits(h).length, 0)
    } finally {
      h.cleanup()
    }
  })

  it('blocked-then-completed audit evidence releases the binding through the settle path', async () => {
    const h = harness({ bindingLiveness: realProbe() })
    try {
      const laneId = await boundLane(h)
      appendFileSync(join(h.repo, '.weir', 'audit.jsonl'), auditLine({ kind: 'settle', childId: 'child-1', status: 'blocked', report: 'standing by' }))
      appendFileSync(join(h.repo, '.weir', 'audit.jsonl'), auditLine({ kind: 'settle', childId: 'child-1', status: 'completed', report: 'done after resume' }))
      const checked = await h.service.check(h.session, laneId)
      assert.equal(checked.state, 'no-commits')
      assert.equal((await laneOf(h, laneId)).boundChild, null)
      const audits = reconcileAudits(h)
      assert.equal(audits.length, 1)
      assert.equal(audits[0].data.evidence?.source, 'audit')
    } finally {
      h.cleanup()
    }
  })
})
