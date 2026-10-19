// Lane decision workflows: the phases that carry a user or policy decision —
// open / setup, binding (reserve for a child; the disputed-binding card),
// landing, cleanup / abandon, watches, repository config. Decision cards,
// auto-approve and removal semantics live only in this module. Every
// state-machine transition goes through the core's apply(); the direct
// ledger writes here are non-transition writes only (open's append, the
// subscribe check-vs-insert, the reconcile command's rebuild). ctx-free:
// all effects reach the injected deps through the core context.
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { isAbsolute, join, resolve as resolvePath } from 'node:path'
import { randomUUID } from 'node:crypto'
import { WORKTREE_CODES, WorktreeError } from './errors.js'
import { LANDABLE_FROM, isActive, nextFor } from './state.js'
import { createWatch, normalizeWatchStates, upsertWatch, watchTimeoutMinutesOf } from './watches.js'
import { branchFor, laneIdFor, parseRepoConfig, scopesOverlap, setupManagerFor, suggestChecks } from './rules.js'
import { bareSetupCommand, setupMissingReason } from './pkgmgr.js'
import { ensureExclude } from './exclude.js'
import { renderChildContract, renderWatchHit } from './prompts.js'
import { cardCopy, cardLocale, hasDirtyContent } from './cards.js'
import { CONFIG_FILE, pathKey } from './lane-core.js'

const SETUP_TIMEOUT_MS = 600_000

/** @param {ReturnType<typeof import('./lane-core.js').createLaneCore>} core */
export function createLaneWorkflows(core) {
  const { deps, git, now, pid, asking, approveModeSafe, cwdOf, config, repoFor, laneOf, apply, patchLane, commitBinding, notifyOwner, result, readConfig, logFile, refresh, reconcileNote, reconcileBinding, armWatch, disarmWatch } = core

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
    const display = bareSetupCommand(manager)
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
        const lanes = active.map((/** @type {any} */ lane) => ({
          id: lane.id, state: lane.state,
          hint: lane.state === 'landable'
            ? `call worktree_land({ lane: "${lane.id}" })`
            : `wait for lane ${lane.id} or call worktree_abandon({ lane: "${lane.id}" })`,
        }))
        const hint = (lanes.find((lane) => lane.state === 'landable') ?? lanes[0]).hint
        throw new WorktreeError(WORKTREE_CODES.MAX_ACTIVE, `${active.length} lanes are active (limit ${settingsNow.maxActive}):\n${lanes.map((lane) => `${lane.id} · ${lane.state} · ${lane.hint}`).join('\n')}`, {
          data: { lanes }, next: { waitFor: 'user', hint },
        })
      }
      const clash = active.find((/** @type {any} */ other) => scopesOverlap(scope, other.scope ?? []))
      if (clash) {
        const overlapping = {
          scope: scope.filter((glob) => scopesOverlap([glob], clash.scope)),
          laneScope: clash.scope.filter((glob) => scopesOverlap(scope, [glob])),
        }
        const hint = `narrow the new scope to avoid ${overlapping.laneScope.join(', ')} or wait for lane ${clash.id} to land before opening it`
        throw new WorktreeError(WORKTREE_CODES.SCOPE_OVERLAP, `scope ${overlapping.scope.join(', ')} overlaps lane ${clash.id} (${overlapping.laneScope.join(', ')}); ${hint}`, {
          lane: clash.id, data: { overlapping }, next: { waitFor: 'user', hint },
        })
      }
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
    /** @type {{ kind: 'configured' } | { kind: 'derived', manager: string } | null} */
    let provenance = null
    let configError = null
    if (settingsNow.autoSetup) {
      try {
        const configured = readConfig(repo).setup ?? null
        if (configured) {
          command = display = configured
          provenance = { kind: 'configured' }
        } else {
          const manager = setupManagerFor(readdirSync(lane.path))
          if (manager) {
            provenance = { kind: 'derived', manager }
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
    const preparing = await patchLane(repo, lane.id, () => ({ setup: { status: 'running', display: display ?? command, provenance } }))
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
        ? { type: 'setup-ok', patch: { setup: { ...laneOf(repo, laneId).setup, status: 'ok', display, log } } }
        : { type: 'setup-fail', reason: outcome.reason, patch: { setup: { ...laneOf(repo, laneId).setup, status: 'failed', display, log } } })
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
    // Execution strings are NEVER taken from the ledger: a stored display
    // may be the bare or unquoted form, and tools change between attempts.
    // Provenance decides the source — config wins, otherwise the lane's
    // lockfile (or the manager recorded at open) — and derived commands are
    // resolved fresh on every attempt.
    let command = null
    let display = current.setup?.display ?? null
    /** @type {string | null} */
    let manager = null
    try {
      const configured = readConfig(repo).setup ?? null
      if (configured) {
        command = display = configured
      } else {
        manager = setupManagerFor(readdirSync(current.path)) ?? current.setup?.provenance?.manager ?? null
        if (manager) {
          const derived = await deriveSetup(manager)
          if ('error' in derived) {
            // Still setup-failed: keep the state legal and refresh the reason.
            const failed = await patchLane(repo, laneId, (record) => ({
              setup: { ...record.setup, status: 'failed' },
              reason: derived.error.replaceAll('<lane>', laneId),
            }))
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
    const provenance = manager ? { kind: 'derived', manager } : { kind: 'configured' }
    const lane = await apply(repo, laneId, { type: 'setup-retry', by: 'user', patch: { setup: { status: 'running', display: display ?? command, provenance } } })
    void runSetup(repo, laneId, command, session, display ?? command)
    return result(lane, `setup restarted: ${display ?? command}`)
  }

  // ─── binding (reserve a lane for a child; the disputed-binding card) ────

  /**
   * The disputed-binding card (design D4): the reconciliation outcome leads
   * and the only constructive choice is an explicit force-reclaim.
   * @param {any} agent @param {any} lane @param {any} reconciliation @param {any} copy @param {any} repo @param {AbortSignal} [signal]
   * @returns {Promise<boolean>} whether the user confirmed the force-reclaim
   */
  async function askForceReclaim(agent, lane, reconciliation, copy, repo, signal) {
    if (!deps.ask) return false
    /** @type {any} */
    let answer
    try {
      answer = await deps.ask(agent, [{
        id: 'abandon',
        header: copy.abandonHeader,
        question: copy.abandonQuestion(lane.title),
        detail: copy.abandonDisputedDetail(lane, lane.boundChild, reconciliation?.verdict ?? null, repo.mainRoot),
        options: [
          { label: copy.forceReclaim, description: copy.forceReclaimDescription },
          { label: copy.cancel, description: copy.abandonDescriptions.cancel },
        ],
      }], signal)
    } catch {
      return false
    }
    return answer?.answers?.find((/** @type {any} */ entry) => entry.id === 'abandon')?.selected?.[0] === copy.forceReclaim
  }

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
    // Zombie-binding reconciliation (D1): a lane stuck in `working` on a dead
    // binding settles first, so the bind proceeds from the lane's post-settle
    // state; a standing refusal is re-thrown atomically inside apply below.
    const stuck = laneOf(repo, laneId)
    if (stuck.state === 'working' && stuck.boundChild) await reconcileBinding(repo, stuck, parentSession)
    const lane = await apply(repo, laneId, { type: 'bind', patch: { boundChild: nonce }, code: WORKTREE_CODES.LANE_NOT_DISPATCHABLE }, (current) => {
      if (current.state === 'working' && current.boundChild) throw new WorktreeError(WORKTREE_CODES.LANE_BUSY, `lane ${laneId} already has a bound worker (${current.boundChild})`, { lane: laneId, next: nextFor(current) })
      before = current
    })
    return {
      lane,
      repo,
      spec: spec(lane),
      contract: renderChildContract(lane, { readOnly: false }),
      /**
       * Commit the spawned child's id onto the reservation — authoritative
       * (lane-binding-authoritative-commit): the core's commitBinding CAS
       * checks nonce AND `working` inside the ledger lock, so a reservation
       * reclaimed mid-spawn (force-reclaim / reconcile --rebuild) or a lane
       * reconciled to `abandoned` refuses LANE_RESERVATION_LOST instead of
       * silently authorising the child. Success and refusal are both audited
       * (D4); the refusal's model-facing copy and `next` live here (D2).
       * @param {string} childId
       */
      commit: async (childId) => {
        try {
          const committed = await commitBinding(repo, laneId, nonce, childId)
          deps.audit('bind', { lane: laneId, nonce, child: childId, outcome: 'committed' }, repo.mainRoot, parentSession?.id ?? null)
          return committed
        } catch (error) {
          if (/** @type {any} */ (error)?.code !== WORKTREE_CODES.LANE_RESERVATION_LOST) throw error
          const facts = /** @type {any} */ (error).data ?? {}
          deps.audit('bind', { lane: laneId, nonce, child: null, outcome: 'refused', state: facts.state ?? null, reservationHeld: facts.reservationHeld ?? false }, repo.mainRoot, parentSession?.id ?? null)
          /** @type {any} */
          let current = null
          try {
            current = laneOf(repo, laneId)
          } catch {
            // the lane record is gone (a rebuild dropped it): no nextFor
          }
          const state = facts.state ?? current?.state ?? 'gone'
          const detail = facts.reservationHeld
            ? `the lane left the working state (now ${state})`
            : `the reservation was reclaimed while the worker spawned (the lane is now ${state})`
          throw new WorktreeError(WORKTREE_CODES.LANE_RESERVATION_LOST, `lane ${laneId} refused the binding commit: ${detail}; the spawned child was never authorised and is torn down`, {
            lane: laneId,
            next: (current ? nextFor(current) : null) ?? { waitFor: 'user', hint: 'the lane is gone or abandoned; open a fresh lane with worktree_open and re-delegate' },
          })
        }
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
    const approveMode = approveModeSafe(agent?.session)
    const auto = approveMode !== 'manual'
    // Auto-approve mode (design D3): the approval card is bypassed entirely —
    // no `awaiting-approval`, no ask funnel, no card-open re-verification
    // window (the entry tree check above already bound the merge target).
    // Every precheck before this point is shared with the manual path. The
    // manual path below stays byte-identical.
    if (!options.userApproved && !auto) {
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
    const landed = await apply(repo, laneId, { type: 'land', by, audit: auto ? { auto: true, approveMode } : undefined, patch: { land: { commit: merged.commit, at: now(), by, stat } } })
    const diff = await git.diff(repo.mainRoot, `${merged.commit}^1`, merged.commit, 60_000).catch(() => '')
    if (!auto) {
      return result(landed, `merged ${lane.branch} into ${lane.base.branch} as ${merged.commit?.slice(0, 7)}`, { merge: { commit: merged.commit, stat }, diff })
    }
    // Auto cleanup after the merge (design D3): auto-keep → mode worktree,
    // auto-clean → mode all. The existing cleanup() body runs unchanged —
    // scratch sync first, never --force on an auto path. A blocked removal
    // stays `landed` and is reported concisely with the typed --force retry
    // instead of a false success (the user can clean up later).
    const cleanupMode = approveMode === 'auto-keep' ? 'worktree' : 'all'
    try {
      const cleaned = await cleanup(session, laneId, /** @type {'worktree' | 'all'} */ (cleanupMode), { by: 'host', auto: true, approveMode })
      return result(landed, `merged ${lane.branch} into ${lane.base.branch} as ${merged.commit?.slice(0, 7)}; auto cleanup (mode ${cleanupMode}): ${cleaned.summary}`, { merge: { commit: merged.commit, stat }, diff, cleanup: { state: cleaned.state, summary: cleaned.summary }, next: cleaned.next })
    } catch (error) {
      const message = String(/** @type {any} */ (error)?.message ?? error)
      const next = /** @type {any} */ (error)?.next ?? null
      return result(landed, `merged ${lane.branch} into ${lane.base.branch} as ${merged.commit?.slice(0, 7)}; auto cleanup blocked: ${message}`, { merge: { commit: merged.commit, stat }, diff, cleanup: { error: message, ...(next ? { next } : {}) } })
    }
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
    // Read-only dirty probe BEFORE the card: the card discloses the counts and
    // a destructive choice is then the user's informed explicit force removal.
    const dirty = existsSync(lane.path) ? await git.dirtyCounts(lane.path) : null
    const dirtyCard = hasDirtyContent(dirty)
    /** @type {any} */
    let answer
    try {
      answer = await deps.ask(agent, [{
        id: 'cleanup',
        header: copy.cleanupHeader,
        question: copy.cleanupQuestion(lane.title),
        detail: copy.cleanupDetail(lane, lane.land?.stat ?? { files: 0, added: 0, removed: 0 }, repo.mainRoot, dirtyCard ? dirty : null),
        options: [
          { label: copy.choices.keep, description: copy.cleanupDescriptions.keep },
          { label: copy.choices.worktree, description: dirtyCard ? copy.cleanupDescriptionsDirty.worktree : copy.cleanupDescriptions.worktree },
          { label: copy.choices.all, description: dirtyCard ? copy.cleanupDescriptionsDirty.all : copy.cleanupDescriptions.all },
        ],
      }], signal)
    } catch {
      return null
    }
    const choice = answer?.answers?.find((/** @type {any} */ entry) => entry.id === 'cleanup')?.selected?.[0]
    const mode = Object.entries(copy.choices).find(([, label]) => label === choice)?.[0]
    if (!mode) return null
    return cleanup(agent.session, laneId, /** @type {'keep' | 'worktree' | 'all'} */ (mode), { by: 'user', ...(mode !== 'keep' && dirtyCard ? { force: true } : {}) })
  }

  // ─── cleanup / abandon ────────────────────────────────────────────────

  /** Copy the lane's .weir scratch into the main repository. @param {any} repo @param {any} lane */
  function syncScratch(repo, lane) {
    const source = join(lane.path, '.weir')
    if (!existsSync(source)) return null
    const target = join(repo.mainRoot, '.weir', 'lanes', lane.id)
    mkdirSync(target, { recursive: true })
    cpSync(source, target, { recursive: true, force: true })
    return target
  }

  /**
   * Concise blocked-removal error: the reason names the dirty counts when the
   * probe sees them (never the raw git `fatal:` output), and `next` names the
   * exact typed `--force` retry — the in-product escape for a lane that cannot
   * be removed. Force stays the USER's privilege, so the hint directs whoever
   * reads it (the model included) to the user's typed command.
   * @param {any} lane @param {string} mode
   */
  async function blockedRemovalError(lane, mode) {
    const dirty = existsSync(lane.path) ? await git.dirtyCounts(lane.path) : { modified: 0, untracked: 0 }
    const reason = dirty.modified + dirty.untracked > 0
      ? `removal blocked: the worktree contains modified or untracked files (${dirty.modified} modified, ${dirty.untracked} untracked)`
      : 'removal blocked: git refused to remove the worktree (it may be locked)'
    return new WorktreeError(WORKTREE_CODES.REMOVE_BLOCKED, reason, {
      lane: lane.id,
      next: { waitFor: 'user', hint: `the user retries with the explicit force override: /worktree clean ${lane.id} ${mode} --force` },
    })
  }

  /**
   * Auto paths (design D3) reuse this exact body with `{ by: 'host', auto: true,
   * approveMode }`: the scratch sync, the removal (forced ONLY behind the
   * user's informed explicit choice — a disclosed card choice or a typed
   * `--force`, never an auto/model path) and the blocked-removal semantics are
   * identical; only the audit payload gains the auto marker.
   * @param {any} session @param {string} laneId @param {'keep' | 'worktree' | 'all'} mode @param {{ by?: string, auto?: boolean, approveMode?: string, force?: boolean }} [options]
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
    // `force` reaches git only from an informed explicit user choice (a
    // disclosed card choice via askCleanup, or the typed `--force`); auto and
    // model paths never force.
    const force = options.force === true && options.auto !== true
    if (existsSync(lane.path)) {
      try {
        await git.worktreeRemove(repo.mainRoot, lane.path, { force })
      } catch (error) {
        if (!(error instanceof WorktreeError) || error.code !== WORKTREE_CODES.REMOVE_BLOCKED) throw error
        // State unchanged: the blocked removal is recorded on the lane (so it
        // stays retryable) and reported concisely with the --force escape.
        const blocked = await blockedRemovalError(lane, mode)
        await patchLane(repo, laneId, (current) => ({ cleanup: { ...(current.cleanup ?? {}), blocked: blocked.reason } }))
        throw blocked
      }
    }
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
    deps.audit('cleanup', { lane: laneId, mode, by, scratch, ...(force ? { forced: true } : {}), ...(options.auto === true ? { auto: true, approveMode: options.approveMode ?? null } : {}) }, repo.mainRoot, lane.ownerSession)
    return result(next, `removed ${lane.path}${branchNote}${scratch ? `; scratch copied to ${scratch}` : ''}`)
  }

  /**
   * @param {any} agent @param {string} laneId
   * @param {{ mode?: 'keep' | 'worktree' | 'all', force?: boolean, signal?: AbortSignal }} [options] - a mode is the user's typed choice (command path); `force` is the typed `--force` override
   */
  async function abandon(agent, laneId, options = {}) {
    const repo = await repoFor(cwdOf(agent?.session))
    let lane = laneOf(repo, laneId)
    if (!isActive(lane)) throw new WorktreeError(WORKTREE_CODES.ILLEGAL_TRANSITION, `lane ${laneId} is already ${lane.state}`, { lane: laneId })
    // Zombie-binding reconciliation BEFORE the confirmation card (design
    // D1/D4): a binding with terminal evidence and no live side settles here
    // through the childSettled path; a standing one is disclosed on the card
    // with an explicit force-reclaim choice.
    /** @type {any} */
    let reconciliation = null
    if (lane.boundChild) {
      reconciliation = await reconcileBinding(repo, lane, agent?.session)
      if (reconciliation?.settled) lane = reconciliation.lane
      if (!isActive(lane)) throw new WorktreeError(WORKTREE_CODES.ILLEGAL_TRANSITION, `lane ${laneId} is already ${lane.state}`, { lane: laneId })
    }
    const unmerged = (await git.branchExists(repo.mainRoot, lane.branch)) ? await git.unmergedCount(repo.mainRoot, lane.base.branch, lane.branch) : 0
    let mode = options.mode
    // Auto-approve path (design D3): no card, the mapped mode decides —
    // auto-keep removes the worktree and keeps the branch, auto-clean also
    // deletes it. Force-reclaim is NEVER auto: a binding the reconciliation
    // would not clear skips this branch entirely and falls back to the manual
    // card below (reconciliation outcome + force-reclaim choice) in EVERY mode.
    const approveMode = approveModeSafe(agent?.session)
    const auto = !mode && approveMode !== 'manual' && !lane.boundChild
    if (auto) mode = approveMode === 'auto-keep' ? 'worktree' : 'all'
    const copy = cardCopy(cardLocale(deps.localeOf?.(agent?.session?.id)))
    // Card-path facts: whether a destructive card choice is the user's informed
    // explicit force removal (the card disclosed the dirty counts).
    let cardChoice = false
    let dirtyCard = false
    if (!mode) {
      if (!deps.ask) throw new WorktreeError(WORKTREE_CODES.MAIN_AGENT_ONLY, 'abandoning needs the user\'s confirmation and no answerer is available')
      // A binding the reconciliation would not clear is the user's call
      // (design D4): the disputed card states the outcome, and the explicit
      // force-reclaim settles through the same path, audited as forced.
      if (lane.boundChild) {
        const reclaim = await askForceReclaim(agent, lane, reconciliation, copy, repo, options.signal)
        if (!reclaim) return result(lane, 'not abandoned: the user cancelled')
        reconciliation = await reconcileBinding(repo, lane, agent?.session, { forced: true })
        lane = laneOf(repo, laneId)
        if (lane.boundChild) throw new WorktreeError(WORKTREE_CODES.LANE_BUSY, `lane ${laneId} is still bound to ${lane.boundChild}; the force-reclaim could not settle it`, { lane: laneId })
      }
      // Read-only dirty probe BEFORE the card: the card discloses the counts
      // and the destructive options name the permanent destruction.
      const dirty = existsSync(lane.path) ? await git.dirtyCounts(lane.path) : null
      dirtyCard = hasDirtyContent(dirty)
      /** @type {any} */
      let answer
      try {
        answer = await deps.ask(agent, [{
          id: 'abandon',
          header: copy.abandonHeader,
          question: copy.abandonQuestion(lane.title),
          detail: copy.abandonDetail(lane, unmerged, repo.mainRoot, reconciliation?.settled ? { child: reconciliation.childId, forced: reconciliation.forced } : null, dirtyCard ? dirty : null),
          options: [
            { label: copy.choices.keep, description: copy.abandonDescriptions.keep },
            { label: copy.choices.worktree, description: dirtyCard ? copy.abandonDescriptionsDirty.worktree : copy.abandonDescriptions.worktree },
            { label: copy.choices.all, description: (dirtyCard ? copy.abandonDescriptionsDirty.all : copy.abandonDescriptions.all)(unmerged) },
            { label: copy.cancel, description: copy.abandonDescriptions.cancel },
          ],
        }], options.signal)
      } catch {
        return result(lane, 'not abandoned: the confirmation card was dismissed')
      }
      const choice = answer?.answers?.find((/** @type {any} */ entry) => entry.id === 'abandon')?.selected?.[0]
      mode = /** @type {any} */ (Object.entries(copy.choices).find(([, label]) => label === choice)?.[0])
      if (!mode) return result(lane, 'not abandoned: the user cancelled')
      cardChoice = true
    }
    if (lane.boundChild) {
      const detail = reconciliation?.verdict ? ` (binding reconciliation: ${reconcileNote(reconciliation.verdict)}; call worktree_abandon without a mode and use the card's force-reclaim)` : ''
      throw new WorktreeError(WORKTREE_CODES.LANE_BUSY, `lane ${laneId} has a running worker; stop it first${detail}`, { lane: laneId })
    }
    // Removal is forced ONLY behind the user's informed explicit choice: a
    // destructive choice on the dirty-disclosing card, or the typed `--force`.
    // Typed-mode and auto paths (auto never reaches the card) never force.
    const force = (options.force === true && !auto) || (cardChoice && dirtyCard)
    const auditExtra = { ...(auto ? { auto: true, approveMode } : {}), ...(force ? { forced: true } : {}) }
    const abandoned = await apply(repo, laneId, { type: 'abandon', by: auto ? 'host' : 'user', reason: auto ? `abandoned automatically (${approveMode} mode)` : 'abandoned by the user', audit: Object.keys(auditExtra).length > 0 ? auditExtra : undefined, patch: { cleanup: { mode, at: now(), by: auto ? 'host' : 'user' } } })
    if (mode === 'keep') return result(abandoned, `abandoned; ${abandoned.path} and ${abandoned.branch} are kept`)
    const scratch = existsSync(lane.path) ? syncScratch(repo, lane) : null
    if (existsSync(lane.path)) {
      try {
        await git.worktreeRemove(repo.mainRoot, lane.path, { force })
      } catch (error) {
        if (!(error instanceof WorktreeError) || error.code !== WORKTREE_CODES.REMOVE_BLOCKED) throw error
        // Abandoned, but the worktree stays: recorded as kept+blocked so a
        // later cleanup retries once the user types the explicit override.
        const blocked = await blockedRemovalError(lane, mode)
        await patchLane(repo, laneId, (current) => ({ cleanup: { ...current.cleanup, mode: 'keep', blocked: blocked.reason } }))
        throw blocked
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

  // ─── watches (lane state subscriptions) ────────────────────────────────

  /**
   * worktree_watch: subscribe the calling session to conclusion states of one
   * lane in this repository (including lanes another session opened). One-shot:
   * the first target state hit — or the expiry — delivers exactly one notice
   * to the SUBSCRIBER and removes the watch. Re-subscribing the same lane
   * replaces the old watch. A lane already in a target state hits immediately
   * (delivered once, never stored). The lifetime comes from the
   * worktreeWatchTimeoutMinutes setting, frozen into `expiresAt` at subscribe
   * time; the model cannot override it (no timeout parameter).
   * @param {any} session - the subscribing (main) session
   * @param {{ lane: string, states: string[] }} args
   */
  async function watch(session, args) {
    const states = normalizeWatchStates(args?.states)
    const laneId = typeof args?.lane === 'string' ? args.lane : ''
    const sessionId = session?.id
    if (typeof sessionId !== 'string' || !sessionId) throw new Error('worktree_watch: the subscribing session has no id')
    const repo = await repoFor(cwdOf(session))
    // Reconcile first so the immediate-hit test below reads the lane's true
    // state (and so expired watches are pruned before this one is stored).
    await refresh(repo)
    const timeoutMinutes = watchTimeoutMinutesOf(config())
    const entry = createWatch({ id: randomUUID(), laneId, sessionId, states, now: now(), timeoutMinutes })
    // Check-vs-insert is atomic inside the ledger lock: a lane that reaches a
    // target state concurrently either hits BEFORE (immediate path) or AFTER
    // (the transition's own hit scan) this subscribe — never both, never none.
    const outcome = await repo.ledger.update((/** @type {any} */ ledger) => {
      const current = ledger.lanes.find((/** @type {any} */ record) => record.id === laneId)
      if (!current) throw new WorktreeError(WORKTREE_CODES.UNKNOWN_LANE, `no lane "${laneId}" in ${repo.rootPath}`)
      if (states.includes(current.state)) return { result: { lane: current, immediate: true, replaced: null } }
      const replaced = upsertWatch(ledger, entry)
      return { ledger, result: { lane: current, immediate: false, replaced } }
    })
    const { lane, immediate, replaced } = /** @type {any} */ (outcome)
    if (replaced) disarmWatch(replaced.id)
    if (immediate) {
      deps.audit('watch', { lane: lane.id, sessionId, states, outcome: 'hit-immediate' }, repo.mainRoot, sessionId)
      try {
        deps.notify(sessionId, renderWatchHit(lane))
      } catch (error) {
        deps.logger?.warn?.(`worktree: watch-hit notification failed: ${/** @type {any} */ (error)?.message ?? error}`)
      }
      return result(lane, `already ${lane.state}; the watch fired immediately and was not stored`, { hit: lane.state })
    }
    armWatch(repo, entry)
    deps.audit('watch', { lane: lane.id, sessionId, states, expiresAt: entry.expiresAt, replaced: replaced?.id ?? null, outcome: 'subscribed' }, repo.mainRoot, sessionId)
    return result(lane, `watching for ${states.join(', ')} until ${new Date(entry.expiresAt).toISOString()}`, { watch: { lane: lane.id, states: entry.states, expiresAt: entry.expiresAt } })
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
    let setupWarning = null
    const manager = setupManagerFor(files)
    if (manager) {
      const derived = await deriveSetup(manager)
      if ('error' in derived) {
        setup = bareSetupCommand(manager)
        setupWarning = setupMissingReason(manager).replace('setup needs', 'suggestion note:')
      } else {
        setup = derived.command
      }
    }
    return { file: join(repo.rootPath, CONFIG_FILE), current, error, suggested: { setup, setupWarning, check: suggestChecks({ packageJson, fileNames: files }) } }
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
        .filter((entry) => pathKey(entry.path).startsWith(prefix) && entry.branch?.startsWith('weir/'))
        .map((entry) => {
          const id = /** @type {string} */ (entry.branch).slice('weir/'.length)
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

  /** The resolved global auto-approve default (command echo; never a raw invalid value). */
  const approveGlobalSafe = () => {
    try {
      return deps.approveGlobal?.() ?? 'auto-clean'
    } catch {
      return 'auto-clean'
    }
  }

  return {
    open, setup, prepareBind, land, askCleanup, cleanup, abandon, watch,
    initSuggestions, writeConfig, reconcile: reconcileCommand, resolveArgPath,
    approveGlobal: approveGlobalSafe,
  }
}
