// Lane-binding commit authority (lane-binding-authoritative-commit): the
// commit closure a prepareBind hands to the delegate is a CAS under the ledger
// lock — the reservation nonce AND the lane's `working` state must both still
// hold, otherwise the commit refuses with LANE_RESERVATION_LOST and the stale
// child id never reaches the ledger. Pins the three mid-spawn reservation
// clearers (force-reclaim, reconcile --rebuild, external worktree removal) and
// the commit audit trail (success AND refusal).
import { describe, expect, it } from './helpers.js'
import { createGit } from '../src/worktree/git.js'
import { createLaneService } from '../src/worktree/lanes.js'
import { makeRepo, nodeGitRun, sh } from './helpers/worktree-fixtures.js'

function harness({ settings = {} } = {}) {
  const fixture = makeRepo()
  const notices = []
  const audits = []
  const service = createLaneService({
    git: createGit(nodeGitRun),
    shellRun: null,
    settings: () => ({ enabled: true, root: '.weir/worktrees', maxActive: 4, autoSetup: true, ...settings }),
    ask: null,
    notify: (sessionId, text) => notices.push({ sessionId, text }),
    audit: (type, data, root) => audits.push({ type, data, root }),
    modeOf: () => false,
  })
  const session = { id: 'main-1', header: { cwd: fixture.repo } }
  return { ...fixture, service, session, notices, audits }
}

const laneOf = async (h, id) => (await h.service.repoFor(h.repo)).ledger.read().lanes.find((lane) => lane.id === id)

/** The commit audit this service wrote for one outcome, if any. */
const commitAudit = (h, outcome) => h.audits.find((entry) => entry.type === 'bind' && entry.data?.outcome === outcome)

describe('lane binding commit authority', () => {
  it('commits a standing reservation and audits the commit', async () => {
    const h = harness()
    try {
      const { lane } = await h.service.open(h.session, { title: 'happy commit' })
      const binding = await h.service.prepareBind(h.session, lane, { readOnly: false })
      const nonce = (await laneOf(h, lane)).boundChild
      expect(nonce).toMatch(/^pending:/)
      await binding.commit('child-1')
      const record = await laneOf(h, lane)
      expect(record.state).toBe('working')
      expect(record.boundChild).toBe('child-1')
      const audit = commitAudit(h, 'committed')
      expect(audit).toBeTruthy()
      expect(audit.data.lane).toBe(lane)
      expect(audit.data.nonce).toBe(nonce)
      expect(audit.data.child).toBe('child-1')
      expect(audit.root).toBe(h.repo)
    } finally {
      h.cleanup()
    }
  })

  it('refuses a commit whose reservation was force-reclaimed mid-spawn (stale nonce)', async () => {
    const h = harness()
    try {
      const { lane } = await h.service.open(h.session, { title: 'stale nonce' })
      const binding = await h.service.prepareBind(h.session, lane, { readOnly: false })
      const nonce = (await laneOf(h, lane)).boundChild
      // The abandon card's force-reclaim clears the reservation through the
      // exact childSettled path while the delegate spawn is still in flight.
      await h.service.childSettled(nonce, h.session)
      expect((await laneOf(h, lane)).boundChild).toBeNull()
      const error = await binding.commit('child-1').then(() => null, (caught) => caught)
      expect(error?.code).toBe('LANE_RESERVATION_LOST')
      expect(error.lane).toBe(lane)
      expect(error.next).toBeTruthy()
      // The stale commit never lands: the child id is not written anywhere.
      expect((await laneOf(h, lane)).boundChild).toBeNull()
      const refusal = commitAudit(h, 'refused')
      expect(refusal).toBeTruthy()
      expect(refusal.data.lane).toBe(lane)
      expect(refusal.data.nonce).toBe(nonce)
      expect(refusal.data.child).toBeNull()
      expect(refusal.data.reservationHeld).toBe(false)
    } finally {
      h.cleanup()
    }
  })

  it('refuses a commit after reconcile --rebuild cleared the reservation, then re-binds cleanly', async () => {
    const h = harness()
    try {
      const { lane } = await h.service.open(h.session, { title: 'rebuild race' })
      const binding = await h.service.prepareBind(h.session, lane, { readOnly: false })
      const rebuilt = await h.service.reconcile(h.session, { rebuild: true })
      expect(rebuilt.rebuilt).toContain(lane)
      // The rebuilt ledger keeps the lane working but drops every binding.
      const rebuiltLane = await laneOf(h, lane)
      expect(rebuiltLane.state).toBe('working')
      expect(rebuiltLane.boundChild).toBeNull()
      const error = await binding.commit('child-zombie').then(() => null, (caught) => caught)
      expect(error?.code).toBe('LANE_RESERVATION_LOST')
      expect((await laneOf(h, lane)).boundChild).toBeNull()
      // The lane recovers through the normal path: check, re-bind, commit.
      await h.service.check(h.session, lane)
      const rebound = await h.service.prepareBind(h.session, lane, { readOnly: false })
      await rebound.commit('child-new')
      expect((await laneOf(h, lane)).boundChild).toBe('child-new')
    } finally {
      h.cleanup()
    }
  })

  it('refuses a commit on a lane abandoned by an external worktree removal (nonce standing, state gone)', async () => {
    const h = harness()
    try {
      const opened = await h.service.open(h.session, { title: 'external removal' })
      const binding = await h.service.prepareBind(h.session, opened.lane, { readOnly: false })
      const nonce = (await laneOf(h, opened.lane)).boundChild
      // The user removes the worktree outside the product; the next reconcile
      // transitions the lane to `abandoned` WITHOUT clearing the nonce.
      sh(h.repo, 'worktree', 'remove', '--force', opened.path)
      await h.service.check(h.session, opened.lane).then(() => expect(1).toBe(0), () => {})
      const abandoned = await laneOf(h, opened.lane)
      expect(abandoned.state).toBe('abandoned')
      expect(abandoned.boundChild).toBe(nonce)
      const error = await binding.commit('child-orphan').then(() => null, (caught) => caught)
      expect(error?.code).toBe('LANE_RESERVATION_LOST')
      expect(error.next).toBeTruthy()
      // The refused commit never overwrites the dead lane's record.
      expect((await laneOf(h, opened.lane)).boundChild).toBe(nonce)
      expect(commitAudit(h, 'refused')).toBeTruthy()
    } finally {
      h.cleanup()
    }
  })
})
