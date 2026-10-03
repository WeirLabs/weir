// Worktree lane service: the host side of the lane pipeline. Every lane
// mutation in the product — tools, /worktree commands, child settlement —
// goes through this module, which reads facts from git, decides with the pure
// rule/state modules, persists through the ledger, and reports the next step.
// ctx-free by construction: git, shell, questions, notifications, audit and
// the session-mode reader are injected (src/worktree/index.js wires them).
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve as resolvePath, sep } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WORKTREE_CODES, WorktreeError } from './errors.js'
import { CHECKABLE, DISPATCHABLE, LANDABLE_FROM, TRANSIENT, isActive, nextFor, transition } from './state.js'
import { MANAGER_INSTALL, branchFor, laneIdFor, normalizeRoot, parseRepoConfig, scopesOverlap, setupManagerFor, suggestChecks } from './rules.js'
import { setupMissingReason } from './pkgmgr.js'
import { reconcile } from './reconcile.js'
import { createLedger } from './ledger.js'
import { ensureExclude, hasExclude } from './exclude.js'
import { renderBoard, renderChildContract, renderNotice } from './prompts.js'
import { cardCopy, cardLocale } from './cards.js'

export const CONFIG_FILE = '.config.json'
const SETUP_TIMEOUT_MS = 600_000
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
 * @property {(manager: string) => Promise<{ ok: true, source: string, command: string, display: string } | { ok: false, manager: string }>} [resolveSetup] - resolves a DERIVED setup's manager into an executable invocation; absent = legacy bare command
 * @property {(sessionId: string | undefined) => string | undefined} [localeOf] - the GUI language last reported for a session
 * @property {() => number} [now]
 * @property {number} [pid] - this process id (tests)
 * @property {{ warn?: (message: string) => void }} [logger]
 */

/** @param {LaneServiceDeps} deps */
export function createLaneService(deps) {
  const { git, settings } = deps
  const now = deps.now ?? Date.now
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
    const lane = await repo.ledger.update((/** @type {any} */ ledger) => {
      const index = ledger.lanes.findIndex((/** @type {any} */ entry) => entry.id === laneId)
      if (index === -1) throw new WorktreeError(WORKTREE_CODES.UNKNOWN_LANE, `no lane "${laneId}"`)
      check?.(ledger.lanes[index], ledger)
      const next = transition(ledger.lanes[index], { at: now(), ...event })
      ledger.lanes[index] = next
      return { ledger, result: next }
    })
    const kind = AUDIT_KIND[/** @type {keyof typeof AUDIT_KIND} */ (event.type)]
    if (kind) deps.audit(kind, { lane: lane.id, from: lane.history.at(-1)?.from, to: lane.state, event: event.type, reason: event.reason ?? null, by: event.by ?? 'host' }, repo.mainRoot, lane.ownerSession)
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

  // ─── open / setup ─────────────────────────────────────────────────────

  /**
   * The invocation for a DERIVED setup: resolved through deps.resolveSetup
   * when available (system tool first, DSH bundled runtime second), else the
   * legacy bare command. A user-configured setup never reaches this helper.
   * @param {string} manager
   * @returns {Promise<{ command: string, display: string } | { error: string }>}
   */
  async function deriveSetup(manager) {
    if (deps.resolveSetup) {
      const resolution = await deps.resolveSetup(manager)
      if (!resolution.ok) return { error: setupMissingReason(manager) }
      return { command: resolution.command, display: resolution.display }
    }
    const display = `${manager} ${MANAGER_INSTALL[manager].join(' ')}`
    return { command: display, display }
  }


  /**
   * @param {any} session - the owning (main) session
   * @param {{ title: string, scope?: string[] }} args
   */
  async function open(session, args) {
    const settingsNow = config()
    if (typeof args?.title !== 'string' || args.title.trim().length === 0) throw new Error('worktree_open: title must be a non-empty string')
    const scope = args.scope ?? []
    if (!Array.isArray(scope) || scope.some((glob) => typeof glob !== 'string' || glob.trim().length === 0)) throw new Error('worktree_open: scope must be an array of non-empty path globs')
    const repo = await repoFor(cwdOf(session))
    const base = await git.currentBranch(repo.mainRoot)
    if (!base) throw new WorktreeError(WORKTREE_CODES.DETACHED_HEAD, 'the main worktree is on a detached HEAD; check out a branch first', { next: { waitFor: 'user', hint: 'the user checks out a base branch' } })
    const baseCommit = await git.revParse(repo.mainRoot, 'HEAD')
    await refresh(repo)
    ensureExclude(repo.commonDir, repo.root)
    const at = now()
    const lane = await repo.ledger.update((/** @type {any} */ ledger) => {
      const active = ledger.lanes.filter(isActive)
      if (active.length >= settingsNow.maxActive) {
        throw new WorktreeError(WORKTREE_CODES.MAX_ACTIVE, `${active.length} lanes are active (limit ${settingsNow.maxActive}); land, clean up, or abandon one first`, { next: { waitFor: 'user', hint: 'land, clean up, or abandon an active lane' } })
      }
      const clash = active.find((/** @type {any} */ other) => scopesOverlap(scope, other.scope ?? []))
      if (clash) throw new WorktreeError(WORKTREE_CODES.SCOPE_OVERLAP, `scope ${scope.join(', ')} overlaps lane ${clash.id} (${clash.scope.join(', ')})`, { lane: clash.id })
      const seq = ledger.seq + 1
      const id = laneIdFor(args.title, seq)
      const record = {
        id,
        title: args.title.trim(),
        path: join(repo.rootPath, id),
        branch: branchFor(id),
        base: { branch: base, commit: baseCommit },
        scope,
        state: 'preparing',
        ownerSession: session.id ?? null,
        boundChild: null,
        baseMoved: false,
        landableTree: null,
        setup: { status: 'pending' },
        check: null,
        land: null,
        cleanup: null,
        reason: null,
        createdAt: at,
        updatedAt: at,
        history: [],
      }
      return { ledger: { ...ledger, seq, lanes: [...ledger.lanes, record] }, result: record }
    })
    try {
      if (await git.branchExists(repo.mainRoot, lane.branch)) throw new WorktreeError(WORKTREE_CODES.BRANCH_EXISTS, `branch ${lane.branch} already exists`)
      mkdirSync(repo.rootPath, { recursive: true })
      await git.worktreeAdd(repo.mainRoot, lane.path, lane.branch, baseCommit)
    } catch (error) {
      await repo.ledger.update((/** @type {any} */ ledger) => ({ ledger: { ...ledger, lanes: ledger.lanes.filter((/** @type {any} */ entry) => entry.id !== lane.id) } }))
      throw error
    }
    deps.audit('open', { lane: lane.id, title: lane.title, branch: lane.branch, base: lane.base, scope }, repo.mainRoot, lane.ownerSession)
    let command = null
    let display = null
    let configError = null
    if (settingsNow.autoSetup) {
      try {
        const configured = readConfig(repo).setup ?? null
        if (configured) {
          command = display = configured
        } else {
          const manager = setupManagerFor(readdirSync(lane.path))
          if (manager) {
            const derived = await deriveSetup(manager)
            if ('error' in derived) configError = derived.error.replaceAll('<lane>', lane.id)
            else ({ command, display } = derived)
          }
        }
      } catch (error) {
        configError = /** @type {any} */ (error)?.message ?? String(error)
      }
    }
    if (configError) {
      const failed = await apply(repo, lane.id, { type: 'setup-fail', reason: configError, patch: { setup: { status: 'failed' } } })
      return result(failed, `lane opened at ${failed.path}, but setup could not start: ${configError}`)
    }
    if (!command) {
      const ready = await apply(repo, lane.id, { type: 'setup-ok', patch: { setup: { status: settingsNow.autoSetup ? 'none' : 'disabled' } } })
      return result(ready, `lane opened at ${ready.path} on ${ready.branch} (base ${base})`)
    }
    const preparing = await patchLane(repo, lane.id, () => ({ setup: { status: 'running', command, display: display ?? command } }))
    void runSetup(repo, lane.id, command, session, display ?? command)
    return result(preparing, `lane opened at ${preparing.path}; running setup: ${display ?? command}`)
  }

  /** @param {any} repo @param {string} laneId @param {string} command @param {any} session @param {string} [display] */
  async function runSetup(repo, laneId, command, session, display = command) {
    const log = logFile(repo, laneId, '0-setup')
    /** @type {{ ok: boolean, reason?: string }} */
    let outcome
    if (!deps.shellRun) {
      outcome = { ok: false, reason: `${WORKTREE_CODES.SHELL_UNAVAILABLE}: no shell executor is available to run "${command}"` }
    } else {
      try {
        const run = await deps.shellRun({ command, cwd: laneOf(repo, laneId).path, timeoutMs: SETUP_TIMEOUT_MS, session })
        writeFileSync(log, `$ ${display}\n\n${run.output}`)
        outcome = run.code === 0
          ? { ok: true }
          : { ok: false, reason: run.denied ? `sandbox denied the setup (exit ${run.code}); switch the session permission and retry with /worktree setup ${laneId}, or skip with /worktree setup ${laneId} --skip` : run.timedOut ? 'setup timed out' : `setup exited ${run.code}` }
      } catch (error) {
        outcome = { ok: false, reason: `setup could not run: ${/** @type {any} */ (error)?.message ?? error}` }
      }
    }
    try {
      const lane = await apply(repo, laneId, outcome.ok
        ? { type: 'setup-ok', patch: { setup: { status: 'ok', command: display, log } } }
        : { type: 'setup-fail', reason: outcome.reason, patch: { setup: { status: 'failed', command: display, log } } })
      notifyOwner(lane, outcome.ok ? `setup finished: ${display}` : `${outcome.reason}; log ${log}`)
    } catch {
      // the lane moved on (abandoned) while setup ran: nothing to report
    }
  }

  /** /worktree setup <id> [--skip] @param {any} session @param {string} laneId @param {{ skip?: boolean }} options */
  async function setup(session, laneId, options = {}) {
    const repo = await repoFor(cwdOf(session))
    if (options.skip) {
      const lane = await apply(repo, laneId, { type: 'setup-ok', by: 'user', patch: { setup: { ...laneOf(repo, laneId).setup, status: 'skipped' } } })
      return result(lane, 'setup skipped by the user')
    }
    const current = laneOf(repo, laneId)
    let command = null
    let display = current.setup?.display ?? current.setup?.command ?? null
    try {
      command = readConfig(repo).setup ?? current.setup?.command ?? null
      if (command) display = readConfig(repo).setup ?? display
      else {
        const manager = setupManagerFor(readdirSync(current.path))
        if (manager) {
          const derived = await deriveSetup(manager)
          if ('error' in derived) {
            const failed = await apply(repo, laneId, { type: 'setup-fail', reason: derived.error.replaceAll('<lane>', laneId), patch: { setup: { status: 'failed' } } })
            return result(failed, `setup could not start: ${failed.reason}`)
          }
          ({ command, display } = derived)
        }
      }
    } catch (error) {
      throw new Error(/** @type {any} */ (error)?.message ?? String(error))
    }
    if (!command) {
      const lane = await apply(repo, laneId, { type: 'setup-ok', by: 'user', patch: { setup: { status: 'none' } } })
      return result(lane, 'no setup command applies; lane is ready')
    }
    const lane = await apply(repo, laneId, { type: 'setup-retry', by: 'user', patch: { setup: { status: 'running', command, display: display ?? command } } })
    void runSetup(repo, laneId, command, session, display ?? command)
    return result(lane, `setup restarted: ${display ?? command}`)
  }

  // ─── binding ──────────────────────────────────────────────────────────

  /**
   * Reserve a lane for a child before it is spawned. Writers move the lane to
   * `working` under the lock (a second writer is refused LANE_BUSY);
   * read-only investigators leave the lane state alone.
   * @param {any} parentSession @param {string} laneId @param {{ readOnly: boolean }} options
   */
  async function prepareBind(parentSession, laneId, { readOnly }) {
    const repo = await repoFor(cwdOf(parentSession))
    const spec = (/** @type {any} */ lane) => ({ laneId: lane.id, lanePath: pathKey(lane.path), scope: lane.scope?.length ? lane.scope : null, readOnly })
    if (readOnly) {
      const lane = laneOf(repo, laneId)
      if (!isActive(lane) && lane.state !== 'kept') throw new WorktreeError(WORKTREE_CODES.LANE_NOT_DISPATCHABLE, `lane ${laneId} is ${lane.state}`, { lane: laneId })
      return { lane, repo, spec: spec(lane), contract: renderChildContract(lane, { readOnly: true }), commit: async () => {}, rollback: async () => {} }
    }
    const nonce = `pending:${randomUUID()}`
    /** @type {any} */
    let before
    const lane = await apply(repo, laneId, { type: 'bind', patch: { boundChild: nonce }, code: WORKTREE_CODES.LANE_NOT_DISPATCHABLE }, (current) => {
      if (current.state === 'working' && current.boundChild) throw new WorktreeError(WORKTREE_CODES.LANE_BUSY, `lane ${laneId} already has a bound worker (${current.boundChild})`, { lane: laneId, next: nextFor(current) })
      before = current
    })
    return {
      lane,
      repo,
      spec: spec(lane),
      contract: renderChildContract(lane, { readOnly: false }),
      /** @param {string} childId */
      commit: async (childId) => {
        await patchLane(repo, laneId, (current) => (current.boundChild === nonce ? { boundChild: childId } : {}))
      },
      rollback: async () => {
        await repo.ledger.update((/** @type {any} */ ledger) => {
          const index = ledger.lanes.findIndex((/** @type {any} */ entry) => entry.id === laneId)
          if (index === -1 || ledger.lanes[index].boundChild !== nonce) return {}
          ledger.lanes[index] = before
          return { ledger }
        })
      },
    }
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
    if (lane.boundChild) throw new WorktreeError(WORKTREE_CODES.LANE_BUSY, `lane ${laneId} has a running worker; the host checks it when the worker settles`, { lane: laneId, next: nextFor(lane) })
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

  // ─── landing ──────────────────────────────────────────────────────────

  /**
   * worktree_land (agent asks the user) or /worktree land (the user's
   * command is the approval).
   * @param {any} agent - the calling main agent
   * @param {string} laneId
   * @param {{ userApproved?: boolean, signal?: AbortSignal }} [options]
   */
  async function land(agent, laneId, options = {}) {
    const session = agent?.session
    const repo = await repoFor(cwdOf(session))
    const { mainBranch } = await refresh(repo)
    const lane = laneOf(repo, laneId)
    if (!LANDABLE_FROM.includes(lane.state) || !lane.landableTree) {
      throw new WorktreeError(WORKTREE_CODES.NOT_LANDABLE, `lane ${laneId} is ${lane.state}${lane.reason ? ` (${lane.reason})` : ''}; only a checked, landable lane can be merged`, { lane: laneId, next: nextFor(lane) })
    }
    const tree = await git.tree(lane.path)
    if (tree !== lane.landableTree) throw new WorktreeError(WORKTREE_CODES.STALE_LANDABLE, `lane ${laneId} changed after it was checked`, { lane: laneId, next: { tool: 'worktree_check', args: { lane: laneId } } })
    if (mainBranch !== lane.base.branch) {
      throw new WorktreeError(WORKTREE_CODES.BASE_MOVED, `the main worktree is on ${mainBranch ?? 'a detached HEAD'}, not ${lane.base.branch}`, { lane: laneId, next: { waitFor: 'user', hint: `the user checks out ${lane.base.branch} in the main worktree` } })
    }
    const precheck = await git.mergeTreeCheck(repo.mainRoot, lane.base.branch, lane.branch)
    if (!precheck.clean) {
      const conflicted = await apply(repo, laneId, { type: 'conflict', reason: `conflicts with ${lane.base.branch}: ${precheck.conflicts.join(', ')}`, patch: { conflicts: precheck.conflicts } })
      return result(conflicted, `not merged: ${precheck.conflicts.length} conflicting path(s)`, { conflicts: precheck.conflicts })
    }
    if (!(await git.indexEmpty(repo.mainRoot))) {
      throw new WorktreeError(WORKTREE_CODES.MAIN_STAGED, 'the main worktree has staged changes; commit or unstage them before merging', { lane: laneId, next: { waitFor: 'user', hint: 'the user commits or unstages the staged changes' } })
    }
    const changed = await git.changedFiles(repo.mainRoot, lane.base.branch, lane.branch)
    const dirty = (await git.status(repo.mainRoot)).map((entry) => entry.path)
    const overlap = dirty.filter((path) => changed.includes(path))
    if (overlap.length > 0) {
      throw new WorktreeError(WORKTREE_CODES.MAIN_DIRTY_OVERLAP, `uncommitted changes in the main worktree touch lane files: ${overlap.join(', ')}`, { lane: laneId, data: { paths: overlap }, next: { waitFor: 'user', hint: 'the user commits or stashes those files' } })
    }
    const heads = { main: await git.revParse(repo.mainRoot, 'HEAD'), lane: await git.revParse(lane.path, 'HEAD') }
    const stat = await git.diffStat(repo.mainRoot, lane.base.branch, lane.branch)
    const by = options.userApproved ? 'user' : 'host'
    if (!options.userApproved) {
      const declined = (/** @type {string} */ reason, /** @type {string | undefined} */ feedback) => apply(repo, laneId, { type: 'decline', reason, patch: { decline: { reason, feedback: feedback ?? null, at: now() } } })
      if (!deps.ask) {
        await apply(repo, laneId, { type: 'ask' })
        const lane2 = await declined('no user-question answerer is available')
        return result(lane2, 'not merged: nobody could be asked for approval')
      }
      await apply(repo, laneId, { type: 'ask', patch: { asking: { pid, at: now() } } })
      asking.add(laneId)
      const commits = await git.commits(repo.mainRoot, lane.base.branch, lane.branch)
      const copy = cardCopy(cardLocale(deps.localeOf?.(session?.id)))
      const mergeLabel = copy.mergeOption(lane.base.branch)
      /** @type {any} */
      let answer
      try {
        answer = await deps.ask(agent, [{
          id: 'merge',
          header: copy.mergeHeader,
          question: copy.mergeQuestion(lane.title, lane.base.branch),
          detail: copy.mergeDetail({ lane, commits, stat, verification: lane.check }),
          options: [{ label: mergeLabel, description: copy.mergeOptionDescription(lane.branch) }, { label: copy.notNow, description: copy.notNowDescription }],
        }], options.signal)
      } catch (error) {
        const lane2 = await declined(`approval not given (${/** @type {any} */ (error)?.code ?? /** @type {any} */ (error)?.message ?? 'cancelled'})`)
        return result(lane2, 'not merged: the approval card was dismissed or unavailable')
      } finally {
        asking.delete(laneId)
      }
      const reply = answer?.answers?.find((/** @type {any} */ entry) => entry.id === 'merge')
      const approved = reply?.selected?.length === 1 && reply.selected[0] === mergeLabel && !reply.custom
      if (!approved) {
        const lane2 = await declined(reply?.custom ? 'the user replied instead of approving' : 'the user chose not to merge now', reply?.custom)
        return result(lane2, 'not merged: the user did not approve', reply?.custom ? { feedback: reply.custom } : {})
      }
      const sameMain = (await git.revParse(repo.mainRoot, 'HEAD')) === heads.main && (await git.currentBranch(repo.mainRoot)) === lane.base.branch
      const sameLane = (await git.revParse(lane.path, 'HEAD')) === heads.lane && (await git.tree(lane.path)) === lane.landableTree
      if (!sameMain || !sameLane) {
        await declined('the main worktree or the lane changed while the approval card was open')
        throw new WorktreeError(WORKTREE_CODES.STALE_LANDABLE, 'the main worktree or the lane changed while the approval card was open; nothing was merged', { lane: laneId, next: { tool: 'worktree_check', args: { lane: laneId } } })
      }
    }
    const merged = await git.mergeNoFf(repo.mainRoot, lane.branch, `merge(lane): ${lane.title} (${lane.id})`)
    if (!merged.ok) {
      const conflicted = await apply(repo, laneId, { type: 'conflict', reason: `merge failed and was aborted: ${merged.detail}` })
      return result(conflicted, 'not merged: git refused the merge (aborted, main worktree unchanged)')
    }
    const landed = await apply(repo, laneId, { type: 'land', by, patch: { land: { commit: merged.commit, at: now(), by, stat } } })
    const diff = await git.diff(repo.mainRoot, `${merged.commit}^1`, merged.commit, 60_000).catch(() => '')
    return result(landed, `merged ${lane.branch} into ${lane.base.branch} as ${merged.commit?.slice(0, 7)}`, { merge: { commit: merged.commit, stat }, diff })
  }

  /**
   * The post-merge cleanup card (user chooses keep / worktree / all).
   * @param {any} agent @param {string} laneId @param {AbortSignal} [signal]
   */
  async function askCleanup(agent, laneId, signal) {
    if (!deps.ask) return null
    const repo = await repoFor(cwdOf(agent.session))
    const lane = laneOf(repo, laneId)
    if (lane.state !== 'landed') return null
    const copy = cardCopy(cardLocale(deps.localeOf?.(agent.session?.id)))
    /** @type {any} */
    let answer
    try {
      answer = await deps.ask(agent, [{
        id: 'cleanup',
        header: copy.cleanupHeader,
        question: copy.cleanupQuestion(lane.title),
        detail: copy.cleanupDetail(lane, lane.land?.stat ?? { files: 0, added: 0, removed: 0 }, repo.mainRoot),
        options: [
          { label: copy.choices.keep, description: copy.cleanupDescriptions.keep },
          { label: copy.choices.worktree, description: copy.cleanupDescriptions.worktree },
          { label: copy.choices.all, description: copy.cleanupDescriptions.all },
        ],
      }], signal)
    } catch {
      return null
    }
    const choice = answer?.answers?.find((/** @type {any} */ entry) => entry.id === 'cleanup')?.selected?.[0]
    const mode = Object.entries(copy.choices).find(([, label]) => label === choice)?.[0]
    if (!mode) return null
    return cleanup(agent.session, laneId, /** @type {'keep' | 'worktree' | 'all'} */ (mode), { by: 'user' })
  }

  // ─── cleanup / abandon ────────────────────────────────────────────────

  /** Copy the lane's .orrery scratch into the main repository. @param {any} repo @param {any} lane */
  function syncScratch(repo, lane) {
    const source = join(lane.path, '.orrery')
    if (!existsSync(source)) return null
    const target = join(repo.mainRoot, '.orrery', 'lanes', lane.id)
    mkdirSync(target, { recursive: true })
    cpSync(source, target, { recursive: true, force: true })
    return target
  }

  /**
   * @param {any} session @param {string} laneId @param {'keep' | 'worktree' | 'all'} mode @param {{ by?: string }} [options]
   */
  async function cleanup(session, laneId, mode, options = {}) {
    if (!['keep', 'worktree', 'all'].includes(mode)) throw new Error('cleanup mode must be keep, worktree, or all')
    const repo = await repoFor(cwdOf(session))
    const lane = laneOf(repo, laneId)
    const by = options.by ?? 'user'
    if (!['landed', 'kept', 'abandoned'].includes(lane.state)) {
      throw new WorktreeError(WORKTREE_CODES.ILLEGAL_TRANSITION, `lane ${laneId} is ${lane.state}; cleanup applies to merged (or abandoned) lanes`, { lane: laneId, next: nextFor(lane) })
    }
    if (mode === 'keep') {
      if (lane.state !== 'landed') return result(lane, 'nothing to do: the worktree is already kept')
      const kept = await apply(repo, laneId, { type: 'keep', by, patch: { cleanup: { mode: 'keep', at: now(), by } } })
      return result(kept, `kept ${kept.path}`)
    }
    const scratch = existsSync(lane.path) ? syncScratch(repo, lane) : null
    if (existsSync(lane.path)) await git.worktreeRemove(repo.mainRoot, lane.path)
    let branchNote = ''
    if (mode === 'all' && (await git.branchExists(repo.mainRoot, lane.branch))) {
      try {
        await git.branchDelete(repo.mainRoot, lane.branch)
        branchNote = `; deleted ${lane.branch}`
      } catch (error) {
        branchNote = `; kept ${lane.branch} (${/** @type {any} */ (error)?.message ?? error})`
      }
    }
    const record = { mode, at: now(), by, scratch }
    const next = lane.state === 'abandoned'
      ? await patchLane(repo, laneId, () => ({ cleanup: record }))
      : await apply(repo, laneId, { type: 'clean', by, patch: { cleanup: record } })
    deps.audit('cleanup', { lane: laneId, mode, by, scratch }, repo.mainRoot, lane.ownerSession)
    return result(next, `removed ${lane.path}${branchNote}${scratch ? `; scratch copied to ${scratch}` : ''}`)
  }

  /**
   * @param {any} agent @param {string} laneId
   * @param {{ mode?: 'keep' | 'worktree' | 'all', signal?: AbortSignal }} [options] - a mode is the user's typed choice (command path)
   */
  async function abandon(agent, laneId, options = {}) {
    const repo = await repoFor(cwdOf(agent?.session))
    const lane = laneOf(repo, laneId)
    if (!isActive(lane)) throw new WorktreeError(WORKTREE_CODES.ILLEGAL_TRANSITION, `lane ${laneId} is already ${lane.state}`, { lane: laneId })
    const unmerged = (await git.branchExists(repo.mainRoot, lane.branch)) ? await git.unmergedCount(repo.mainRoot, lane.base.branch, lane.branch) : 0
    let mode = options.mode
    const copy = cardCopy(cardLocale(deps.localeOf?.(agent?.session?.id)))
    if (!mode) {
      if (!deps.ask) throw new WorktreeError(WORKTREE_CODES.MAIN_AGENT_ONLY, 'abandoning needs the user\'s confirmation and no answerer is available')
      /** @type {any} */
      let answer
      try {
        answer = await deps.ask(agent, [{
          id: 'abandon',
          header: copy.abandonHeader,
          question: copy.abandonQuestion(lane.title),
          detail: copy.abandonDetail(lane, unmerged, repo.mainRoot),
          options: [
            { label: copy.choices.keep, description: copy.abandonDescriptions.keep },
            { label: copy.choices.worktree, description: copy.abandonDescriptions.worktree },
            { label: copy.choices.all, description: copy.abandonDescriptions.all(unmerged) },
            { label: copy.cancel, description: copy.abandonDescriptions.cancel },
          ],
        }], options.signal)
      } catch {
        return result(lane, 'not abandoned: the confirmation card was dismissed')
      }
      const choice = answer?.answers?.find((/** @type {any} */ entry) => entry.id === 'abandon')?.selected?.[0]
      mode = /** @type {any} */ (Object.entries(copy.choices).find(([, label]) => label === choice)?.[0])
      if (!mode) return result(lane, 'not abandoned: the user cancelled')
    }
    if (lane.boundChild) throw new WorktreeError(WORKTREE_CODES.LANE_BUSY, `lane ${laneId} has a running worker; stop it first`, { lane: laneId })
    const abandoned = await apply(repo, laneId, { type: 'abandon', by: 'user', reason: 'abandoned by the user', patch: { cleanup: { mode, at: now(), by: 'user' } } })
    if (mode === 'keep') return result(abandoned, `abandoned; ${abandoned.path} and ${abandoned.branch} are kept`)
    const scratch = existsSync(lane.path) ? syncScratch(repo, lane) : null
    if (existsSync(lane.path)) {
      try {
        await git.worktreeRemove(repo.mainRoot, lane.path)
      } catch (error) {
        // Abandoned, but the worktree stays: record it as kept so a later
        // cleanup can retry once the blocking files are dealt with.
        await patchLane(repo, laneId, (current) => ({ cleanup: { ...current.cleanup, mode: 'keep', blocked: String(/** @type {any} */ (error)?.message ?? error) } }))
        throw error
      }
    }
    let branchNote = ''
    if (mode === 'all' && (await git.branchExists(repo.mainRoot, lane.branch))) {
      await git.branchDelete(repo.mainRoot, lane.branch, { force: unmerged > 0 })
      branchNote = `; deleted ${lane.branch}${unmerged > 0 ? ` (${unmerged} unmerged commit(s) discarded)` : ''}`
    }
    const final = await patchLane(repo, laneId, (current) => ({ cleanup: { ...current.cleanup, scratch } }))
    return result(final, `abandoned; removed ${lane.path}${branchNote}`)
  }

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
   */
  async function view(session) {
    let repo
    try {
      repo = await repoFor(cwdOf(session))
    } catch (error) {
      const known = error instanceof WorktreeError
      return { available: false, mode: safeMode(session), error: known ? error.toJSON() : { code: 'ERROR', message: String(/** @type {any} */ (error)?.message ?? error) } }
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
          actions: actionsFor(lane),
        })
      }
      return {
        available: true,
        mode: safeMode(session),
        ownedBySession: lanes.filter((lane) => lane.ownerSession === session?.id).map((lane) => lane.id),
        repo: { mainRoot: repo.mainRoot, root: repo.root, rootPath: repo.rootPath, branch: mainBranch, gitVersion: repo.version?.join('.') ?? null, exclude: hasExclude(repo.commonDir, repo.root), verification },
        lanes,
        unmanaged,
      }
    } catch (error) {
      const known = error instanceof WorktreeError
      return { available: false, mode: safeMode(session), error: known ? error.toJSON() : { code: 'ERROR', message: String(/** @type {any} */ (error)?.message ?? error) } }
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
      return renderBoard({ lanes: repo.ledger.read().lanes, mode })
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

  // ─── repository config ────────────────────────────────────────────────

  /** /worktree init: current config + detected suggestions (never written here). @param {any} session */
  async function initSuggestions(session) {
    const repo = await repoFor(cwdOf(session))
    let current = null
    let error = null
    try {
      current = readConfig(repo)
    } catch (caught) {
      error = String(/** @type {any} */ (caught)?.message ?? caught)
    }
    const files = readdirSync(repo.mainRoot)
    let packageJson
    try {
      packageJson = JSON.parse(readFileSync(join(repo.mainRoot, 'package.json'), 'utf8'))
    } catch {
      packageJson = undefined
    }
    // The setup suggestion must be an invocation that works on THIS host
    // (bundled-runtime resolution), not a bare manager name — the user may
    // accept it verbatim into the config.
    let setup = null
    const manager = setupManagerFor(files)
    if (manager) {
      const derived = await deriveSetup(manager)
      setup = 'error' in derived ? `${manager} ${MANAGER_INSTALL[manager].join(' ')}` : derived.command
    }
    return { file: join(repo.rootPath, CONFIG_FILE), current, error, suggested: { setup, check: suggestChecks({ packageJson, fileNames: files }) } }
  }

  /** Write the repository config after the user confirmed it. @param {any} session @param {any} value */
  async function writeConfig(session, value) {
    const repo = await repoFor(cwdOf(session))
    const parsed = parseRepoConfig(value)
    ensureExclude(repo.commonDir, repo.root)
    mkdirSync(repo.rootPath, { recursive: true })
    const file = join(repo.rootPath, CONFIG_FILE)
    writeFileSync(file, `${JSON.stringify({ ...(parsed.setup ? { setup: parsed.setup } : {}), check: parsed.check }, null, 2)}\n`)
    return { file, config: parsed }
  }

  /** /worktree reconcile [--rebuild] @param {any} session @param {{ rebuild?: boolean }} [options] */
  async function reconcileCommand(session, options = {}) {
    const repo = await repoFor(cwdOf(session))
    if (options.rebuild) {
      const worktrees = await git.worktreeList(repo.mainRoot)
      const prefix = `${pathKey(repo.rootPath)}/`
      const at = now()
      const lanes = worktrees
        .filter((entry) => pathKey(entry.path).startsWith(prefix) && entry.branch?.startsWith('orrery/'))
        .map((entry) => {
          const id = /** @type {string} */ (entry.branch).slice('orrery/'.length)
          return {
            id, title: id, path: entry.path, branch: /** @type {string} */ (entry.branch), base: { branch: 'main', commit: null }, scope: [], state: 'working',
            ownerSession: session?.id ?? null, boundChild: null, baseMoved: false, landableTree: null, setup: { status: 'unknown' }, check: null, land: null,
            cleanup: null, reason: 'rebuilt from git; base assumed from the main worktree branch', createdAt: at, updatedAt: at, history: [],
          }
        })
      const mainBranch = await git.currentBranch(repo.mainRoot)
      for (const lane of lanes) lane.base.branch = mainBranch ?? 'main'
      const seq = lanes.reduce((max, lane) => Math.max(max, Number(/-(\d+)$/.exec(lane.id)?.[1] ?? 0)), 0)
      await repo.ledger.replace({ schemaVersion: 1, seq, lanes })
      deps.audit('reconcile', { rebuilt: lanes.map((lane) => lane.id) }, repo.mainRoot, session?.id ?? null)
      return { rebuilt: lanes.map((lane) => lane.id), unmanaged: [] }
    }
    const outcome = await refresh(repo)
    return { rebuilt: null, unmanaged: outcome.unmanaged }
  }

  /** Normalized absolute path of a tool argument relative to a session cwd. @param {string} cwd @param {string} path */
  function resolveArgPath(cwd, path) {
    return pathKey(isAbsolute(path) ? path : resolvePath(cwd, path))
  }

  return {
    repoFor, refresh, open, setup, prepareBind, childSettled, check, land, askCleanup, cleanup, abandon,
    view, diffOf, board, summaryOf, initSuggestions, writeConfig, reconcile: reconcileCommand, resolveArgPath, actionsFor,
  }
}
