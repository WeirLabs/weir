// Delegate-side pins for lane-binding commit authority
// (lane-binding-authoritative-commit D3): when the lane refuses the binding
// commit (LANE_RESERVATION_LOST — the reservation was reclaimed while the
// spawn was in flight), the freshly spawned child must never run: one-shot
// spawns are disposed before the error surfaces (spawn-adapter onGuardFailure
// precedent), supervised-group members are terminated by the existing group
// rollback. These pins drive the REAL lane service (makeRepo fixture) so the
// refusal comes from the real commit closure, not a fake — pre-fix the commit
// silently no-ops and both tests are red.
import { describe, expect, it } from './helpers.js'
import { createGit } from '../src/worktree/git.js'
import { createLaneService } from '../src/worktree/lanes.js'
import { createDelegateTool } from '../src/delegate/tool.js'
import { createGroupCoordinator } from '../src/delegate/group-coordinator.js'
import { makeRepo, nodeGitRun } from './helpers/worktree-fixtures.js'

function harness() {
  const fixture = makeRepo()
  const audits = []
  const service = createLaneService({
    git: createGit(nodeGitRun),
    shellRun: null,
    settings: () => ({ enabled: true, root: '.weir/worktrees', maxActive: 4, autoSetup: true }),
    ask: null,
    notify: () => {},
    audit: (type, data, root) => audits.push({ type, data, root }),
    modeOf: () => false,
  })
  // The delegate consumes the preset service wrapper (worktree/index.js
  // ctx.reflect.provide), not the raw lane service: mirror that shape.
  const lanes = {
    enabled: () => true,
    modeOf: () => false,
    prepareBind: service.prepareBind,
    childSettled: service.childSettled,
    resolveArgPath: service.resolveArgPath,
  }
  const session = { id: 'main-1', header: { cwd: fixture.repo, delegationDepth: 0 } }
  const laneOf = async (id) => (await service.repoFor(fixture.repo)).ledger.read().lanes.find((lane) => lane.id === id)
  const disposed = []
  const spawned = []
  const continued = []
  // Mid-spawn reservation clearer: a force-reclaim landing between the
  // delegate's prepareBind and its commit, exactly the C1 interleaving.
  const state = { reclaimOnSpawn: false }
  const reclaimReservation = async () => {
    const ledger = (await service.repoFor(fixture.repo)).ledger.read()
    const reserved = ledger.lanes.find((lane) => typeof lane.boundChild === 'string' && lane.boundChild.startsWith('pending:'))
    if (reserved) await service.childSettled(reserved.boundChild, session)
  }
  const agent = { ctx: { tools: { guard: () => () => {} } } }
  const coordinator = createGroupCoordinator({ sendTo: async () => {}, interruptChild: () => {}, schedule: () => {} })
  const tool = createDelegateTool({
    resolveTarget: async () => ({ persona: 'p', label: 'quick', readOnly: false }),
    loadSkill: async () => '',
    subagents: {
      async start(_name, request) {
        spawned.push(request)
        if (state.reclaimOnSpawn) await reclaimReservation()
        const id = `child-${spawned.length}`
        return {
          id,
          localAgent: agent,
          result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }),
          dispose: async () => { disposed.push(id) },
        }
      },
      async startContinuable(spec) {
        continued.push(spec)
        if (state.reclaimOnSpawn) await reclaimReservation()
        return { childId: `child-c${continued.length}`, messageId: `msg-c${continued.length}` }
      },
      interrupt() {},
    },
    jobs: undefined,
    robash: () => ({ enabled: false, lists: {} }),
    coordinatorFor: async () => coordinator,
    agents: { get: () => agent },
    lanes: () => lanes,
  })
  const exec = { agent: { id: 'main-1', session }, signal: new AbortController().signal }
  return { ...fixture, service, laneOf, tool, exec, audits, disposed, spawned, continued, coordinator, state }
}

describe('delegate lane-commit refusal', () => {
  it('disposes a spawned one-shot child when the binding commit refuses (stale reservation)', async () => {
    const h = harness()
    try {
      const { lane } = await h.service.open(h.exec.agent.session, { title: 'stale commit' })
      h.state.reclaimOnSpawn = true
      const error = await h.tool.execute({ category: 'quick', prompt: 'TASK: x', worktree: lane }, h.exec).then(
        () => null,
        (caught) => caught,
      )
      expect(error?.code).toBe('LANE_RESERVATION_LOST')
      expect(error.lane).toBe(lane)
      expect(error.next).toBeTruthy()
      // The unauthorised child was torn down before the error surfaced, and
      // its id never reached the ledger.
      expect(h.disposed).toEqual(['child-1'])
      expect((await h.laneOf(lane)).boundChild).toBeNull()
      expect(h.audits.some((entry) => entry.type === 'bind' && entry.data?.outcome === 'refused')).toBe(true)
    } finally {
      h.cleanup()
    }
  })

  it('terminates spawned supervised members when a binding commit refuses mid-batch', async () => {
    const h = harness()
    try {
      const { lane } = await h.service.open(h.exec.agent.session, { title: 'group commit' })
      h.state.reclaimOnSpawn = true
      const error = await h.tool.execute(
        { group: 'crew', worktree: lane, tasks: [{ category: 'quick', prompt: 'TASK: a', name: 'alpha' }] },
        h.exec,
      ).then(() => null, (caught) => caught)
      expect(error?.code).toBe('LANE_RESERVATION_LOST')
      // The existing group rollback terminated the spawned member and freed
      // the group name: a retry binds and commits cleanly.
      expect(h.coordinator.memberOf('child-c1')?.status).toBe('terminated')
      h.state.reclaimOnSpawn = false
      const retry = await h.tool.execute(
        { group: 'crew', worktree: lane, tasks: [{ category: 'quick', prompt: 'TASK: b', name: 'beta' }] },
        h.exec,
      )
      expect(retry.supervised).toBe(true)
      expect(retry.members).toEqual([{ id: 'child-c2', name: 'quick' }])
      expect((await h.laneOf(lane)).boundChild).toBe('child-c2')
    } finally {
      h.cleanup()
    }
  })
})
