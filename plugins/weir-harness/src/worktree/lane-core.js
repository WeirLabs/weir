// Lane core: the ledger + check engine every lane mutation in the product
// funnels through. Owns the repo-resolution plumbing, this instance's
// watch-expiry timers, refresh/reconciliation, zombie-binding settlement
// (reconcileBinding / childSettled), and the single apply() that performs
// every state-machine transition — one-shot watch hits are collected in the
// same atomic ledger write (design D3), audit + delivery after the write.
// Workflows and views build on this module; it never imports them.
// ctx-free by construction: git, shell, questions, notifications, audit and
// the session-mode reader are injected (src/worktree/index.js wires them).
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, join, sep } from 'node:path'
import { WORKTREE_CODES, WorktreeError } from './errors.js'
import { CHECKABLE, LANDABLE_FROM, nextFor, transition } from './state.js'
import { collectWatchHits, pruneExpiredWatches, removeWatchForExpiry } from './watches.js'
import { normalizeRoot, parseRepoConfig } from './rules.js'
import { reconcile } from './reconcile.js'
import { createLedger } from './ledger.js'
import { renderNotice, renderWatchExpired, renderWatchHit } from './prompts.js'
import { authorityResidue } from './authority.js'

export const CONFIG_FILE = '.config.json'
const LOG_TAIL_LINES = 40

/** Audit kind per state-machine event (AUDIT_SUBTYPES.worktree). */
const AUDIT_KIND = Object.freeze({
  'setup-ok': 'setup', 'setup-fail': 'setup', 'setup-retry': 'setup', bind: 'bind', checked: 'checked',
  'check-pass': 'check', 'check-fail': 'check', invalidate: 'invalidate', ask: 'ask', decline: 'decline',
  conflict: 'conflict', land: 'land', keep: 'cleanup', clean: 'cleanup', abandon: 'abandon', missing: 'abandon',
})

/**
 * Comparable form of a path: realpath when it exists, '/'-separated, and
 * case-folded on win32.
 * @param {string} path
 * @param {string} [platform]
 */
export function pathKey(path, platform = process.platform) {
  let real = path
  try {
    real = realpathSync.native(path)
  } catch {
    // a path that does not exist yet keeps its lexical form
    let parent = dirname(path)
    const tail = [path.slice(parent.length + 1)]
    while (parent !== dirname(parent)) {
      try {
        real = join(realpathSync.native(parent), ...tail.reverse())
        break
      } catch {
        tail.push(parent.slice(dirname(parent).length + 1))
        parent = dirname(parent)
      }
    }
  }
  const slashed = real.split(sep).join('/').replace(/\/+$/, '')
  return platform === 'win32' ? slashed.toLowerCase() : slashed
}

/**
 * @typedef {object} LaneServiceDeps
 * @property {ReturnType<typeof import('./git.js').createGit>} git
 * @property {null | ((request: { command: string, cwd: string, timeoutMs: number, session?: any }) => Promise<{ code: number, output: string, denied: boolean, timedOut: boolean }>)} shellRun
 * @property {() => { enabled: boolean, root: string, maxActive: number, autoSetup: boolean }} settings
 * @property {null | ((agent: any, questions: any[], signal?: AbortSignal) => Promise<{ answers: Array<{ id: string, selected: string[], custom?: string }> }>)} ask
 * @property {(sessionId: string, text: string) => void} notify
 * @property {(type: string, data: any, root: string, sessionId?: string | null) => void} audit
  * @property {(session: any) => boolean} modeOf
  * @property {(session: any) => 'manual' | 'auto-keep' | 'auto-clean'} [approveModeOf] - the session's effective auto-approve mode (projection override ?? global setting ?? module default); absent = manual (no auto paths)
  * @property {(session: any) => 'session' | 'global'} [approveModeSourceOf] - where the effective mode comes from; absent = global
  * @property {() => 'manual' | 'auto-keep' | 'auto-clean'} [approveGlobal] - the resolved global default (module default when unset/invalid); absent = auto-clean
 * @property {(sessionId: string | undefined) => string | undefined} [localeOf] - the GUI language last reported for a session
 * @property {() => number} [now]
 * @property {(handler: () => void, delayMs: number) => any} [setTimer] - watch-expiry scheduler (tests); defaults to an unref'd setTimeout
 * @property {(handle: any) => void} [clearTimer]
 * @property {number} [pid] - this process id (tests)
 * @property {{ warn?: (message: string) => void }} [logger]
 * @property {(root: string, sessionId: string | null | undefined) => ({ operations: number, locks: number } | null)} [authorityResidue] - read-only Edit Lock residue probe feeding the cleanup/abandon warning (tests); defaults to the bounded snapshot read in ./authority.js
 * @property {(boundChild: string, ownerSession: string | null, context: { root: string }) => Promise<{ childAlive: boolean, ownerAlive: boolean, terminalEvidence: { source: string, detail: string } | null }>} [bindingLiveness] - read-only zombie-binding probe (design D2); absent = LANE_BUSY refusals stand unreconciled
 */

/** @param {LaneServiceDeps} deps */
export function createLaneCore(deps) {
  const { git, settings } = deps
  const now = deps.now ?? Date.now
  /** Effective auto-approve mode for a session, fail-safe to `manual` so a missing dep (tests, older wiring) never auto-approves. @param {any} session */
  const approveModeSafe = (session) => {
    try {
      return deps.approveModeOf?.(session) ?? 'manual'
    } catch {
      return 'manual'
    }
  }
  /** Where the effective mode comes from ('session' override vs 'global' setting). @param {any} session */
  const approveModeSourceSafe = (session) => {
    try {
      return deps.approveModeSourceOf?.(session) ?? 'global'
    } catch {
      return 'global'
    }
  }
  /** @type {Map<string, Promise<any>>} cwd+root → repo */
  const pending = new Map()
  /** @type {Map<string, any>} cwd+root → resolved repo (sync access for the prompt board) */
  const resolved = new Map()
  /** @type {Promise<number[] | null> | null} */
  let versionProbe = null
  /** Lanes whose approval card is open in THIS process. @type {Set<string>} */
  const asking = new Set()
  const pid = deps.pid ?? process.pid
  /** Whether an approval card recorded in the ledger is still open somewhere. @param {any} lane */
  const askAlive = (lane) => {
    const owner = lane.asking?.pid
    if (owner === pid) return asking.has(lane.id)
    if (typeof owner !== 'number') return false
    try {
      process.kill(owner, 0)
      return true
    } catch {
      return false
    }
  }

  // ─── watch-expiry timers (this instance only; the ledger owns the truth) ─

  /** Watch-expiry timers armed by THIS service instance, watch id → handle.
   * The lock arbitrates between instances: whichever instance removes the
   * record under the ledger lock delivers that watch's single expiry notice. */
  const watchTimers = new Map()
  const setTimer = deps.setTimer ?? ((/** @type {() => void} */ handler, /** @type {number} */ delayMs) => {
    const timer = setTimeout(handler, delayMs)
    timer.unref?.()
    return timer
  })
  const clearTimer = deps.clearTimer ?? clearTimeout

  /** @param {string} watchId */
  function disarmWatch(watchId) {
    const handle = watchTimers.get(watchId)
    if (handle !== undefined) {
      clearTimer(handle)
      watchTimers.delete(watchId)
    }
  }

  /** @param {any} repo @param {any} entry */
  function armWatch(repo, entry) {
    if (watchTimers.has(entry.id)) return
    const delay = entry.expiresAt - now()
    if (delay <= 0) return
    watchTimers.set(entry.id, setTimer(() => {
      watchTimers.delete(entry.id)
      void expireWatch(repo, entry.id).catch((error) => deps.logger?.warn?.(`worktree: watch expiry failed: ${/** @type {any} */ (error)?.message ?? error}`))
    }, delay))
  }

  /**
   * An expiry timer fired: remove the watch under the ledger lock; only the
   * instance that actually removes the record delivers the expiry notice
   * (the watch's single delivery), so two instances can never double-deliver.
   * @param {any} repo @param {string} watchId
   */
  async function expireWatch(repo, watchId) {
    const removed = await repo.ledger.update((/** @type {any} */ ledger) => {
      const watch = removeWatchForExpiry(ledger, watchId, now())
      return watch ? { ledger, result: watch } : {}
    })
    if (!removed) return
    deps.audit('watch', { lane: removed.laneId, sessionId: removed.sessionId, states: removed.states, outcome: 'expired' }, repo.mainRoot, removed.sessionId)
    try {
      deps.notify(removed.sessionId, renderWatchExpired(removed))
    } catch (error) {
      deps.logger?.warn?.(`worktree: watch-expiry notification failed: ${/** @type {any} */ (error)?.message ?? error}`)
    }
  }

  /**
   * Ledger lazy-cleanup + per-instance timer arming (design D4). Runs on every
   * refresh — which is also the host-load path: watches whose deadline passed
   * while the host was down are pruned silently + audited (never delivered,
   * never hit-tested); every live watch gets this instance's expiry timer.
   * @param {any} repo
   */
  async function syncWatches(repo) {
    const pruned = await repo.ledger.update((/** @type {any} */ ledger) => {
      const expired = pruneExpiredWatches(ledger, now())
      return expired.length > 0 ? { ledger, result: expired } : {}
    })
    for (const watch of pruned ?? []) {
      deps.audit('watch', { lane: watch.laneId, sessionId: watch.sessionId, states: watch.states, outcome: 'pruned' }, repo.mainRoot, watch.sessionId)
    }
    for (const entry of repo.ledger.read().watches) armWatch(repo, entry)
  }

  const cwdOf = (/** @type {any} */ session) => {
    const cwd = session?.header?.cwd
    if (typeof cwd !== 'string' || !cwd) throw new WorktreeError(WORKTREE_CODES.NOT_A_REPO, 'this session has no working directory')
    return cwd
  }

  function config() {
    const value = settings()
    if (!value.enabled) throw new WorktreeError(WORKTREE_CODES.WORKTREE_DISABLED, 'worktree lanes are disabled (worktreeEnabled is off)')
    return value
  }

  /** @param {string} cwd */
  async function repoFor(cwd) {
    const root = normalizeRoot(config().root)
    const key = `${cwd}\0${root}`
    if (!pending.has(key)) {
      const promise = resolveRepo(cwd, root).then((repo) => {
        resolved.set(key, repo)
        return repo
      })
      promise.catch(() => pending.delete(key))
      pending.set(key, promise)
    }
    return pending.get(key)
  }

  /** @param {string} cwd @param {string} root */
  async function resolveRepo(cwd, root) {
    versionProbe ??= git.version(cwd)
    const version = await versionProbe
    if (!git.supported(version)) {
      versionProbe = null
      throw new WorktreeError(WORKTREE_CODES.GIT_TOO_OLD, version
        ? `git ${version.join('.')} is too old; worktree lanes need git 2.38 or newer`
        : `git could not be run (${git.lastVersionError ?? 'unknown error'}); worktree lanes need git 2.38 or newer`)
    }
    const info = await git.repoOf(cwd)
    if (!info) throw new WorktreeError(WORKTREE_CODES.NOT_A_REPO, `${cwd} is not inside a git repository`)
    const mainRoot = realpathSync.native(info.mainRoot)
    const rootPath = join(mainRoot, ...root.split('/'))
    return { cwd, mainRoot, commonDir: info.commonDir, root, rootPath, ledger: createLedger(rootPath, { now }), version, unmanaged: /** @type {string[]} */ ([]) }
  }

  /** Resolved repo for sync callers (prompt board), or null. @param {any} session */
  function repoCached(session) {
    try {
      const value = settings()
      if (!value.enabled) return null
      const cwd = cwdOf(session)
      const key = `${cwd}\0${normalizeRoot(value.root)}`
      if (!resolved.has(key) && !pending.has(key)) void repoFor(cwd).catch(() => {})
      return resolved.get(key) ?? null
    } catch {
      return null
    }
  }

  // ─── ledger helpers ───────────────────────────────────────────────────

  /** @param {any} repo @param {string} laneId */
  function laneOf(repo, laneId) {
    const lane = repo.ledger.read().lanes.find((/** @type {any} */ entry) => entry.id === laneId)
    if (!lane) throw new WorktreeError(WORKTREE_CODES.UNKNOWN_LANE, `no lane "${laneId}" in ${repo.rootPath}`)
    return lane
  }

  /**
   * Transition one lane under the ledger lock; `check` runs inside the lock
   * against the current record (throw to refuse).
   * @param {any} repo @param {string} laneId @param {any} event @param {(lane: any, ledger: any) => void} [check]
   */
  async function apply(repo, laneId, event, check) {
    /** Watches this transition consumed (removed in the same atomic write). @type {any[]} */
    let hits = []
    const lane = await repo.ledger.update((/** @type {any} */ ledger) => {
      const index = ledger.lanes.findIndex((/** @type {any} */ entry) => entry.id === laneId)
      if (index === -1) throw new WorktreeError(WORKTREE_CODES.UNKNOWN_LANE, `no lane "${laneId}"`)
      check?.(ledger.lanes[index], ledger)
      const next = transition(ledger.lanes[index], { at: now(), ...event })
      ledger.lanes[index] = next
      // One-shot watches: a hit is removed in the SAME atomic write as the
      // state transition, so it can never be collected twice (design D3).
      hits = collectWatchHits(ledger, next)
      return { ledger, result: next }
    })
    const kind = AUDIT_KIND[/** @type {keyof typeof AUDIT_KIND} */ (event.type)]
    // `event.audit` carries extra payload for the SAME kind (the auto-approve
    // marker on land/abandon) without a new audit type; transition() ignores
    // the key, so it never leaks into the lane record.
    if (kind) deps.audit(kind, { lane: lane.id, from: lane.history.at(-1)?.from, to: lane.state, event: event.type, reason: event.reason ?? null, by: event.by ?? 'host', ...(event.audit ?? {}) }, repo.mainRoot, lane.ownerSession)
    for (const hit of hits) {
      disarmWatch(hit.id)
      try {
        deps.notify(hit.sessionId, renderWatchHit(lane))
      } catch (error) {
        deps.logger?.warn?.(`worktree: watch-hit notification failed: ${/** @type {any} */ (error)?.message ?? error}`)
      }
    }
    return lane
  }

  /** Non-state field update (no transition). @param {any} repo @param {string} laneId @param {(lane: any) => any} patch */
  async function patchLane(repo, laneId, patch) {
    return repo.ledger.update((/** @type {any} */ ledger) => {
      const index = ledger.lanes.findIndex((/** @type {any} */ entry) => entry.id === laneId)
      if (index === -1) return {}
      ledger.lanes[index] = { ...ledger.lanes[index], ...patch(ledger.lanes[index]), updatedAt: now() }
      return { ledger, result: ledger.lanes[index] }
    })
  }

  /** @param {any} lane @param {string} [detail] */
  function notifyOwner(lane, detail) {
    if (!lane?.ownerSession) return
    try {
      deps.notify(lane.ownerSession, renderNotice(lane, detail))
    } catch (error) {
      deps.logger?.warn?.(`worktree: notification failed: ${/** @type {any} */ (error)?.message ?? error}`)
    }
  }

  /**
   * Best-effort Edit Lock authority-residue probe (design D5): does the
   * lane's owner session still own unresolved operations or locks in the
   * management domain? Warning input only — read-only, and a failed check
   * is silent (never blocks the cleanup/abandon transition).
   * @param {any} repo @param {any} lane @returns {{ operations: number, locks: number } | null}
   */
  function residueOf(repo, lane) {
    try {
      return (deps.authorityResidue ?? authorityResidue)(repo.mainRoot, lane?.ownerSession) ?? null
    } catch (error) {
      deps.logger?.warn?.(`worktree: authority-residue check failed: ${/** @type {any} */ (error)?.message ?? error}`)
      return null
    }
  }

  /** @param {any} lane */
  function result(lane, summary, extra = {}) {
    return {
      lane: lane.id, state: lane.state, summary, path: lane.path, branch: lane.branch, next: nextFor(lane),
      ...(lane.check?.enabled && Array.isArray(lane.check.results) && lane.check.results.length ? { check: { results: lane.check.results.map((/** @type {any} */ entry) => ({ name: entry.name, exit: entry.exit, ms: entry.ms })) } } : {}),
      ...extra,
    }
  }

  /** @param {any} repo */
  function readConfig(repo) {
    const file = join(repo.rootPath, CONFIG_FILE)
    if (!existsSync(file)) return parseRepoConfig(undefined)
    let raw
    try {
      raw = JSON.parse(readFileSync(file, 'utf8'))
    } catch (error) {
      throw new Error(`invalid ${file}: ${/** @type {any} */ (error)?.message ?? error}`)
    }
    try {
      return parseRepoConfig(raw)
    } catch (error) {
      throw new Error(`invalid ${file}: ${/** @type {any} */ (error)?.message ?? error}`)
    }
  }

  /** @param {any} repo @param {string} laneId @param {string} name */
  function logFile(repo, laneId, name) {
    const dir = join(repo.rootPath, '.logs', laneId)
    mkdirSync(dir, { recursive: true })
    return join(dir, `${name}.log`)
  }

  // ─── reconciliation ───────────────────────────────────────────────────

  /** @param {any} repo */
  async function refresh(repo) {
    // Watch maintenance first (design D4): prune watches that expired while
    // the host was down (silent + audited) and arm this instance's timers;
    // the reconcile transitions below then hit only live watches.
    await syncWatches(repo)
    const worktrees = await git.worktreeList(repo.mainRoot)
    const ledger = repo.ledger.read()
    const mainBranch = await git.currentBranch(repo.mainRoot)
    /** @type {Map<string, string | null>} */
    const trees = new Map()
    for (const lane of ledger.lanes) {
      if (LANDABLE_FROM.includes(lane.state) && lane.landableTree && existsSync(lane.path)) trees.set(lane.id, await git.tree(lane.path))
    }
    const outcome = reconcile({ lanes: ledger.lanes, worktrees, rootPath: repo.rootPath, mainBranch, trees, normalize: (path) => pathKey(path) })
    for (const event of outcome.events) {
      await apply(repo, event.id, { type: event.type, reason: event.reason }).catch(() => {})
    }
    // An approval card dies with the tool call that raised it (restart,
    // crash): such a lane is declined, never left waiting forever.
    for (const lane of ledger.lanes) {
      if (lane.state === 'awaiting-approval' && !askAlive(lane)) {
        await apply(repo, lane.id, { type: 'decline', reason: 'the approval card was closed before an answer (the tool call ended)' }).catch(() => {})
      }
    }
    const flagsChanged = ledger.lanes.some((/** @type {any} */ lane) => outcome.baseMoved.has(lane.id) && Boolean(lane.baseMoved) !== outcome.baseMoved.get(lane.id))
    if (flagsChanged) {
      await repo.ledger.update((/** @type {any} */ current) => {
        for (const lane of current.lanes) if (outcome.baseMoved.has(lane.id)) lane.baseMoved = outcome.baseMoved.get(lane.id)
        return { ledger: current }
      })
    }
    if (outcome.unmanaged.length && outcome.unmanaged.join() !== repo.unmanaged.join()) {
      deps.audit('reconcile', { unmanaged: outcome.unmanaged }, repo.mainRoot, null)
    }
    repo.unmanaged = outcome.unmanaged
    return { mainBranch, unmanaged: outcome.unmanaged }
  }

  // ─── binding reconciliation (zombie-lane settlement) ────────────────────

  /** One-phrase reconciliation outcome for LANE_BUSY messages. @param {any} verdict */
  function reconcileNote(verdict) {
    if (verdict?.childAlive) return 'the bound worker is still live'
    if (verdict?.ownerAlive) return 'the lane owner session is still live'
    return 'no terminal evidence exists for the bound worker (offline is not dead)'
  }

  /**
   * Zombie-binding reconciliation (worktree-zombie-lane-reclamation D1/D2):
   * the read-only liveness probe runs before any LANE_BUSY refusal. Only
   * terminal evidence ∧ both sides dead settles the binding — through the
   * exact childSettled path, so a reconciled settlement is indistinguishable
   * from a live one downstream — and the settlement is audited
   * (worktree/reconcile-binding), exactly once (the call that actually
   * cleared the binding audits; a concurrent/repeat reconcile finds the
   * binding gone and audits nothing). A refusal leaves the ledger untouched.
   * `forced` skips the probe: the user's explicit card decision (D4).
   * @param {any} repo @param {any} lane @param {any} session @param {{ forced?: boolean }} [options]
   * @returns {Promise<{ settled: boolean, lane: any, verdict: any, childId: string, forced: boolean } | null>} null = no binding, or no probe available
   */
  async function reconcileBinding(repo, lane, session, options = {}) {
    if (!lane?.boundChild) return null
    const childId = lane.boundChild
    const forced = options.forced === true
    /** @type {any} */
    let verdict = null
    if (!forced) {
      if (typeof deps.bindingLiveness !== 'function') return null
      try {
        verdict = await deps.bindingLiveness(childId, lane.ownerSession ?? null, { root: repo.mainRoot })
      } catch (error) {
        deps.logger?.warn?.(`worktree: binding liveness probe failed for lane ${lane.id}: ${/** @type {any} */ (error)?.message ?? error}`)
        return null
      }
      if (!verdict || verdict.childAlive || verdict.ownerAlive || !verdict.terminalEvidence) {
        return { settled: false, lane, verdict, childId, forced }
      }
    }
    const cleared = await childSettled(childId, session)
    const after = laneOf(repo, lane.id)
    if (cleared != null) {
      deps.audit('reconcile-binding', {
        lane: lane.id,
        child: childId,
        ownerSession: lane.ownerSession ?? null,
        forced,
        evidence: verdict?.terminalEvidence ?? null,
        childAlive: verdict?.childAlive ?? null,
        ownerAlive: verdict?.ownerAlive ?? null,
      }, repo.mainRoot, lane.ownerSession)
    }
    return { settled: after.boundChild == null, lane: after, verdict, childId, forced }
  }

  /**
   * A bound writer settled: free the lane and run the host check. `silent`
   * suppresses the immediate notice when the caller reports the outcome
   * itself (foreground result / job result); background verification still
   * notifies when it finishes.
   * @param {string} childId @param {any} parentSession @param {{ silent?: boolean }} [options]
   */
  async function childSettled(childId, parentSession, options = {}) {
    let repo
    try {
      repo = await repoFor(cwdOf(parentSession))
    } catch {
      return null
    }
    const lane = repo.ledger.read().lanes.find((/** @type {any} */ entry) => entry.boundChild === childId)
    if (!lane) return null
    await patchLane(repo, lane.id, () => ({ boundChild: null }))
    const checked = await runChecks(repo, lane.id, parentSession, { trigger: 'settle', silent: options.silent })
    return { ...checked, notice: renderNotice(checked, checked.reason ?? undefined) }
  }

  // ─── checks ───────────────────────────────────────────────────────────

  /**
   * Mandatory preconditions, then (when configured) verification in the
   * background. Returns the lane as of the precondition outcome.
   * @param {any} repo @param {string} laneId @param {any} session @param {{ trigger: string, awaitVerification?: boolean, silent?: boolean }} options
   */
  async function runChecks(repo, laneId, session, options) {
    const tell = (/** @type {any} */ lane, /** @type {string} */ detail) => {
      if (!options.silent) notifyOwner(lane, detail)
    }
    const lane = laneOf(repo, laneId)
    if (!CHECKABLE.includes(lane.state)) return lane
    if (lane.boundChild) {
      // Zombie-binding reconciliation (D1) before the refusal: only terminal
      // evidence ∧ both sides dead clears the binding (audited); the settle
      // path then ran this very check, so return its outcome.
      const outcome = await reconcileBinding(repo, lane, session)
      if (outcome?.settled) return outcome.lane
      const detail = outcome?.verdict ? ` (binding reconciliation: ${reconcileNote(outcome.verdict)}; the abandon confirmation card offers a force-reclaim)` : ''
      throw new WorktreeError(WORKTREE_CODES.LANE_BUSY, `lane ${laneId} has a running worker; the host checks it when the worker settles${detail}`, { lane: laneId, next: nextFor(lane) })
    }
    const changes = await git.status(lane.path)
    /** @type {{ to: string, reason: string } | null} */
    let failed = null
    if (changes.length > 0) failed = { to: 'dirty', reason: `${changes.length} uncommitted path(s): ${changes.slice(0, 5).map((entry) => entry.path).join(', ')}` }
    else if ((await git.currentBranch(lane.path)) !== lane.branch) failed = { to: 'branch-moved', reason: `HEAD is not on ${lane.branch}` }
    else if ((await git.aheadBehind(repo.mainRoot, lane.base.branch, lane.branch)).ahead === 0) failed = { to: 'no-commits', reason: `no commits ahead of ${lane.base.branch}` }
    if (failed) {
      const next = await apply(repo, laneId, { type: 'checked', to: failed.to, reason: failed.reason })
      tell(next, failed.reason)
      return next
    }
    const tree = await git.tree(lane.path)
    /** @type {any} */
    let repoConfig
    try {
      repoConfig = readConfig(repo)
    } catch (error) {
      const checking = await apply(repo, laneId, { type: 'checked', to: 'checking', patch: { check: { enabled: true, tree, results: [] } } })
      const failedLane = await apply(repo, checking.id, { type: 'check-fail', reason: /** @type {any} */ (error)?.message ?? String(error) })
      tell(failedLane, failedLane.reason)
      return failedLane
    }
    if (repoConfig.check.length === 0) {
      const landable = await apply(repo, laneId, { type: 'checked', to: 'landable', patch: { landableTree: tree, check: { enabled: false, tree } } })
      tell(landable, 'mandatory checks passed; verification is not enabled for this repository')
      return landable
    }
    const checking = await apply(repo, laneId, { type: 'checked', to: 'checking', patch: { check: { enabled: true, tree, results: [], startedAt: now() } } })
    const run = runVerification(repo, laneId, repoConfig.check, session, tree)
    if (options.awaitVerification) return run
    void run
    return checking
  }

  /** @param {any} repo @param {string} laneId @param {Array<{ name: string, run: string, timeoutSec: number }>} commands @param {any} session @param {string | null} tree */
  async function runVerification(repo, laneId, commands, session, tree) {
    const lanePath = laneOf(repo, laneId).path
    /** @type {any[]} */
    const results = []
    /** @type {string | null} */
    let failure = null
    let tail = ''
    if (!deps.shellRun) failure = `${WORKTREE_CODES.SHELL_UNAVAILABLE}: no shell executor is available for verification`
    for (const [index, command] of commands.entries()) {
      if (failure) break
      const log = logFile(repo, laneId, `${index + 1}-${command.name.replace(/[^A-Za-z0-9_.-]+/g, '-')}`)
      const started = now()
      try {
        const run = await /** @type {any} */ (deps.shellRun)({ command: command.run, cwd: lanePath, timeoutMs: command.timeoutSec * 1000, session })
        writeFileSync(log, run.output)
        results.push({ name: command.name, run: command.run, exit: run.code, ms: now() - started, log, denied: run.denied })
        if (run.code !== 0) {
          failure = `${command.name} ${run.timedOut ? 'timed out' : `exited ${run.code}`}${run.denied ? ' (sandbox denied)' : ''}`
          tail = run.output.split(/\r?\n/).slice(-LOG_TAIL_LINES).join('\n')
        }
      } catch (error) {
        results.push({ name: command.name, run: command.run, exit: -1, ms: now() - started, log })
        failure = `${command.name} could not run: ${/** @type {any} */ (error)?.message ?? error}`
      }
    }
    if (!failure) {
      const after = await git.status(lanePath)
      if (after.length > 0 || (await git.tree(lanePath)) !== tree) failure = 'verification modified lane content'
    }
    try {
      const lane = failure
        ? await apply(repo, laneId, { type: 'check-fail', reason: failure, patch: { check: { enabled: true, tree, results, finishedAt: now() } } })
        : await apply(repo, laneId, { type: 'check-pass', patch: { landableTree: tree, check: { enabled: true, tree, results, finishedAt: now() } } })
      const last = results.at(-1)
      notifyOwner(lane, failure ? `${failure}; log ${last?.log ?? 'n/a'}${tail ? `\n${tail}` : ''}` : `verification passed: ${results.map((entry) => entry.name).join(', ')}`)
      return lane
    } catch {
      return null
    }
  }

  /**
   * worktree_check / /worktree check.
   * @param {any} session @param {string} laneId @param {{ verificationOnly?: boolean, awaitVerification?: boolean }} [options]
   */
  async function check(session, laneId, options = {}) {
    const repo = await repoFor(cwdOf(session))
    await refresh(repo)
    const current = laneOf(repo, laneId)
    if (options.verificationOnly && readConfig(repo).check.length === 0) {
      throw new WorktreeError(WORKTREE_CODES.VERIFICATION_DISABLED, 'verification is not enabled for this repository (no "check" in the worktree config)', { lane: laneId, next: nextFor(current) })
    }
    if (!CHECKABLE.includes(current.state)) {
      throw new WorktreeError(WORKTREE_CODES.ILLEGAL_TRANSITION, `lane ${laneId} is ${current.state} and cannot be checked`, { lane: laneId, next: nextFor(current) })
    }
    const lane = await runChecks(repo, laneId, session, { trigger: 'check', awaitVerification: options.awaitVerification })
    return result(lane, `lane ${lane.state}${lane.reason ? `: ${lane.reason}` : ''}`)
  }

  return {
    deps, git, now, pid, asking,
    approveModeSafe, approveModeSourceSafe,
    cwdOf, config, repoFor, repoCached,
    armWatch, disarmWatch,
    laneOf, apply, patchLane, notifyOwner, residueOf, result, readConfig, logFile,
    refresh, reconcileNote, reconcileBinding, childSettled, check,
  }
}
