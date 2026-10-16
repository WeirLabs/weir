// Lane read views: actionsFor / view / safeMode / diffOf / board / summaryOf.
// Read-only over the ledger (repo.ledger.read()); refresh is reused from the
// core, so the read path keeps its existing reconciliation side effects
// (expired-watch pruning and orphan-card declines still audit there). This
// module itself adds no writes.
import { existsSync } from 'node:fs'
import { WorktreeError } from './errors.js'
import { CHECKABLE, LANDABLE_FROM, TRANSIENT, isActive, nextFor } from './state.js'
import { watchFacts } from './watches.js'
import { hasExclude } from './exclude.js'
import { renderBoard } from './prompts.js'

/** @param {ReturnType<typeof import('./lane-core.js').createLaneCore>} core */
export function createLaneViews(core) {
  const { deps, git, approveModeSafe, approveModeSourceSafe, cwdOf, repoFor, repoCached, laneOf, refresh, readConfig } = core

  // ─── views ────────────────────────────────────────────────────────────

  /** Legal actions per lane for the panel (disabled ones carry the reason). @param {any} lane */
  function actionsFor(lane) {
    const deny = (/** @type {string} */ reason) => ({ enabled: false, reason })
    const allow = { enabled: true }
    const exists = !['cleaned'].includes(lane.state) && !(lane.state === 'abandoned' && lane.cleanup?.mode !== 'keep')
    return {
      diff: lane.state === 'preparing' ? deny('setup is still running') : allow,
      check: !CHECKABLE.includes(lane.state) ? deny(`not available while ${lane.state}`) : lane.boundChild ? deny('a worker is running in this lane') : allow,
      land: !LANDABLE_FROM.includes(lane.state) ? deny(`only a landable lane can be merged (now ${lane.state})`) : lane.baseMoved ? deny(`the main worktree is not on ${lane.base.branch}`) : allow,
      clean: ['landed', 'kept'].includes(lane.state) || (lane.state === 'abandoned' && lane.cleanup?.mode === 'keep') ? allow : deny('cleanup applies after merging'),
      abandon: isActive(lane) ? (lane.boundChild ? deny('a worker is running in this lane') : allow) : deny(`already ${lane.state}`),
      setup: lane.state === 'setup-failed' ? allow : deny('setup only reruns after a failure'),
      copyPath: exists ? allow : deny('the worktree was removed'),
    }
  }

  /**
   * Full read-only view for the GUI panel.
   * @param {any} session
   * @param {{ mode?: boolean, approve?: string | null, approveSource?: 'session' | 'global' }} [options] - cold-read override: a boolean
   *   `mode` replaces the live projection read (a pseudo session folded from
   *   the persisted log by sessionQuery has no live projection cells); `approve`
   *   and `approveSource` carry the cold-folded auto-approve override the same
   *   way (null = no override → the global default answers).
   */
  async function view(session, options) {
    const viewMode = () => (typeof options?.mode === 'boolean' ? options.mode : safeMode(session))
    const viewApproveMode = () => (options && typeof options.approve === 'string' ? options.approve : approveModeSafe(session))
    const viewApproveModeSource = () => (options && (options.approveSource === 'session' || options.approveSource === 'global') ? options.approveSource : approveModeSourceSafe(session))
    let repo
    try {
      repo = await repoFor(cwdOf(session))
    } catch (error) {
      const known = error instanceof WorktreeError
      return { available: false, mode: viewMode(), approveMode: viewApproveMode(), approveModeSource: viewApproveModeSource(), error: known ? error.toJSON() : { code: 'ERROR', message: String(/** @type {any} */ (error)?.message ?? error) } }
    }
    try {
      const { mainBranch, unmanaged } = await refresh(repo)
      const ledger = repo.ledger.read()
      /** @type {any} */
      let verification
      try {
        const repoConfig = readConfig(repo)
        verification = { enabled: repoConfig.check.length > 0, commands: repoConfig.check.map((entry) => entry.name), setup: repoConfig.setup }
      } catch (error) {
        verification = { enabled: true, commands: [], error: String(/** @type {any} */ (error)?.message ?? error) }
      }
      const lanes = []
      for (const lane of [...ledger.lanes].reverse()) {
        const exists = existsSync(lane.path)
        let counts = null
        let stat = null
        if ((await git.branchExists(repo.mainRoot, lane.branch).catch(() => false))) {
          counts = await git.aheadBehind(repo.mainRoot, lane.base.branch, lane.branch).catch(() => null)
          stat = await git.diffStat(repo.mainRoot, lane.base.branch, lane.branch).catch(() => null)
        }
        lanes.push({
          ...lane,
          history: (lane.history ?? []).slice(-12),
          exists,
          ahead: counts?.ahead ?? null,
          behind: counts?.behind ?? null,
          stat,
          next: nextFor(lane),
          transient: TRANSIENT.includes(lane.state),
          ...watchFacts(ledger.watches, lane.id),
          actions: actionsFor(lane),
        })
      }
      return {
        available: true,
        mode: viewMode(),
        approveMode: viewApproveMode(),
        approveModeSource: viewApproveModeSource(),
        ownedBySession: lanes.filter((lane) => lane.ownerSession === session?.id).map((lane) => lane.id),
        repo: { mainRoot: repo.mainRoot, root: repo.root, rootPath: repo.rootPath, branch: mainBranch, gitVersion: repo.version?.join('.') ?? null, exclude: hasExclude(repo.commonDir, repo.root), verification },
        lanes,
        unmanaged,
      }
    } catch (error) {
      const known = error instanceof WorktreeError
      return { available: false, mode: viewMode(), approveMode: viewApproveMode(), approveModeSource: viewApproveModeSource(), error: known ? error.toJSON() : { code: 'ERROR', message: String(/** @type {any} */ (error)?.message ?? error) } }
    }
  }

  /** @param {any} session */
  function safeMode(session) {
    try {
      return deps.modeOf(session) === true
    } catch {
      return false
    }
  }

  /** @param {any} session @param {string} laneId */
  async function diffOf(session, laneId) {
    const repo = await repoFor(cwdOf(session))
    const lane = laneOf(repo, laneId)
    if (lane.land?.commit) return git.diff(repo.mainRoot, `${lane.land.commit}^1`, lane.land.commit)
    return git.diff(repo.mainRoot, lane.base.branch, lane.branch)
  }

  /** Runtime-context board (sync; empty until the repo resolved once). @param {any} session */
  function board(session) {
    const repo = repoCached(session)
    const mode = safeMode(session)
    if (!repo) return mode ? renderBoard({ lanes: [], mode }) : ''
    try {
      const ledger = repo.ledger.read()
      return renderBoard({ lanes: ledger.lanes, watches: ledger.watches, mode })
    } catch {
      return ''
    }
  }

  /** Lane ids this session owns / active counts for quick status. @param {any} session */
  function summaryOf(session) {
    const repo = repoCached(session)
    if (!repo) return null
    try {
      const lanes = repo.ledger.read().lanes.filter((/** @type {any} */ lane) => lane.ownerSession === session?.id)
      return { active: lanes.filter(isActive).length, awaiting: lanes.filter((/** @type {any} */ lane) => lane.state === 'awaiting-approval').length }
    } catch {
      return null
    }
  }

  return { actionsFor, view, diffOf, board, summaryOf }
}
