// Orrery Edit Lock composition. Disabled (zero behavior, no service) unless
// enabled by the row config or the Orrery settings `editLock.enabled` key
// (read at mount; a change applies after restart). Plain ESM, ctx-only.
//
// Domains: each agent binds at creation to the management root of its session
// cwd (git top level, else the cwd; an enclosing existing authority wins). The
// authority lives in <root>/.orrery/edit-lock and is excluded from git through
// .git/info/exclude. The first host to reserve a root publishes for it; every
// other cooperating host becomes its client over a local socket.
//
// Order contract: this row MUST precede hashline-edit and lsp. A mis-ordered
// or unmanaged editor is not trusted: the pre-execute guard denies every
// write/edit/hash_edit/lsp_rename definition not claimed through the service.
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { openReservedEditLockRuntime } from './reserved-runtime.js'
import { reservationPathFor } from './reservation.js'
import { createEditLockLifecycle } from './lifecycle.js'
import { installEditLockWriteScope } from './tool-scope.js'
import { createResourceIdentity } from './resource-identity.js'
import { userTextMessage } from '../shared/user-message.js'
import { createRemoteEditLockDomain, endpointFor, serveEditLockEndpoint } from './remote.js'
import { localDomain, remoteDomain } from './domain.js'
import { AUTHORITY_DIR, createDomainRegistry, excludeFromGit, managementRootFor } from './domains.js'
import { createRecoveryDriver } from './recovery.js'
import { createSettlementDriver } from './settle.js'
import { editLockLimits } from '../settings/sections.js'
import { buildView, unavailableView } from './view.js'

const name = 'orrery-edit-lock'
const inject = ['tools', 'fs', 'agents']

/** Tool names whose definitions must be Edit Lock routed when enabled. */
export const GUARDED_TOOLS = Object.freeze(['write', 'edit', 'hash_edit', 'lsp_rename', 'str_replace_editor'])

/** Row config wins over the settings section; `root` + `authorityDirectory`
 * pin one fixed domain (development compositions and probes).
 * @param {unknown} config @param {unknown} [settings] */
export function editLockOptions(config, settings) {
  const value = { .../** @type {any} */ (settings ?? {}), .../** @type {any} */ (config ?? {}) }
  if (value.enabled !== true) return null
  if (value.root === undefined && value.authorityDirectory === undefined) return { fixed: null }
  for (const key of ['root', 'authorityDirectory']) {
    if (typeof value[key] !== 'string' || !isAbsolute(value[key])) throw new Error(`edit lock: ${key} must be an absolute path`)
  }
  return { fixed: { root: value.root, directory: value.authorityDirectory } }
}

/** Never initialize over unknown content: empty → create, committed snapshot → recover.
 * @param {string} directory @returns {'create'|'recover'} */
export function storeMode(directory) {
  if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 })
  const entries = readdirSync(directory)
  if (entries.length === 0) return 'create'
  if (entries.includes('snapshot.json')) return 'recover'
  throw new Error(`edit lock: authority directory ${directory} has no committed snapshot and is not empty`)
}

/** @param {any} agent */
function sessionOf(agent) {
  return typeof agent?.id === 'string' && agent.id ? agent.id : undefined
}
/** Confirm every pending-confirmation lock of one session. Each file goes
 * through the ordinary per-file check, so a file that does not qualify is simply
 * skipped; the bulk path can never widen authority. @param {any} domain
 * @param {any} agent @param {{resourceId: string}[]} pending */
async function confirmAll(domain, agent, pending) {
  const confirmed = []
  for (const lock of pending) {
    try {
      await domain.confirm(agent, lock.resourceId)
      confirmed.push(lock.resourceId)
    } catch { /* not confirmable any more; the next status shows why */ }
  }
  return confirmed
}

/** @param {any} domain @param {any} agent @param {string} raw @param {string} commandId @param {{holdDefaultMinutes: number, holdSingleMaxMinutes: number, holdCumulativeMaxMinutes: number}} limits */
async function runCommand(domain, agent, raw, commandId, limits) {
  const [verb, ...rest] = raw.trim().split(/\s+/u)
  if (!verb || verb === 'status') return describe(await domain.status(agent))
  if (verb === 'stop') {
    const status = await domain.stop(agent)
    return `Edit authority durably revoked for this session.\n${describe(status)}`
  }
  if (verb === 'resume') {
    const status = await domain.resume(agent, `command:${commandId}`)
    const pending = status.locks.filter(/** @param {any} lock */ lock => lock.status === 'pending-confirmation')
    // Resume restores authority only; retained files still need an explicit
    // confirmation (the panel's Continue editing runs resume then confirm --all).
    return `Edit authority resumed with a new execution epoch.${pending.length ? ` ${pending.length} retained file(s) wait for confirmation: /edit-lock confirm --all, or /edit-lock confirm <path> for one.` : ''}\n${describe(status)}`
  }
  if (verb === 'hold') {
    const minutes = rest.length > 0 && rest[0] !== '' ? Number(rest[0]) : limits.holdDefaultMinutes
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('Usage: /edit-lock hold [minutes]')
    const held = await domain.hold(agent, Math.round(minutes * 60_000), { singleMaxMs: limits.holdSingleMaxMinutes * 60_000, cumulativeMaxMs: limits.holdCumulativeMaxMinutes * 60_000 })
    return `Keeping ${held.lockCount} file(s) until ${new Date(held.holdUntil).toLocaleTimeString()} (${Math.round(held.holdCumulativeMs / 60_000)} of ${limits.holdCumulativeMaxMinutes} minutes used in this batch).\n${describe(await domain.status(agent))}`
  }
  if (verb === 'confirm') {
    // `--all` only replays the per-file confirmation over files that already
    // qualify; it never widens authority (spec: One-step confirmation).
    if (rest.length === 1 && rest[0] === '--all') {
      const status = await domain.status(agent)
      const pending = status.locks.filter(/** @param {any} lock */ lock => lock.status === 'pending-confirmation')
      const confirmed = await confirmAll(domain, agent, pending)
      return `Confirmed ${confirmed.length} of ${pending.length} retained file(s).\n${describe(await domain.status(agent))}`
    }
    const path = rest.join(' ')
    if (!path) throw new Error('Usage: /edit-lock confirm <path> | /edit-lock confirm --all')
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string') throw new Error('session cwd unavailable')
    const observation = createResourceIdentity().resolve(path, { cwd })
    if (observation.kind !== 'file') throw new Error('confirm requires an existing regular file')
    const status = await domain.confirm(agent, observation.resourceId)
    return `Confirmed ${observation.resourceId}.\n${describe(status)}`
  }
  if (verb === 'release') {
    // Human release of one of this session's own files. It only removes
    // authority, so it stays available while stopped or recovering.
    const path = rest.join(' ')
    if (!path) throw new Error('Usage: /edit-lock release <path>')
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string') throw new Error('session cwd unavailable')
    const own = (await domain.status(agent)).locks.find((/** @type {any} */ lock) => lock.resourceId === path)
    const result = await domain.service.release({ agent }, { filePath: own ? own.resourceId : path, cwd })
    return `Released ${result.resourceId}.\n${describe(await domain.status(agent))}`
  }
  if (verb === 'locks') {
    const locks = await domain.locks(agent)
    return locks.length ? locks.map((/** @type {any} */ lock) => `- ${lock.resourceId} owner=${lock.owner} [${lock.status}${lock.reason ? `: ${lock.reason}` : ''}] generation ${lock.generation}`).join('\n') : 'No Edit Lock ownership is held.'
  }
  if (verb === 'unlock') {
    const generation = Number(rest.at(-1))
    const path = rest.slice(0, -1).join(' ')
    if (!path || !Number.isSafeInteger(generation)) throw new Error('Usage: /edit-lock unlock <path> <generation> (see /edit-lock locks)')
    // An exact listed resource id also works for files that no longer exist.
    let resourceId = (await domain.locks(agent)).find((/** @type {any} */ lock) => lock.resourceId === path)?.resourceId
    if (!resourceId) {
      const cwd = agent?.session?.header?.cwd
      if (typeof cwd !== 'string') throw new Error('session cwd unavailable')
      const observation = createResourceIdentity().resolve(path, { cwd })
      if (observation.kind !== 'file') throw new Error('unlock requires an existing regular file or an exact locked resource id')
      resourceId = observation.resourceId
    }
    const result = await domain.unlock(agent, resourceId, generation)
    return `Unlocked ${result.resourceId} (generation ${result.generation}, owner ${result.owner}). Content was not validated.`
  }
  throw new Error('Usage: /edit-lock [status|locks|hold [minutes]|release <path>|stop|resume|confirm <path>|confirm --all|unlock <path> <generation>]')
}

/** Ordinary owner tools. Ownership derives from exec.agent, never arguments.
 * @param {any} ctx @param {any} service */
function registerLockTools(ctx, service) {
  const filePath = { file_path: { type: 'string', description: 'Existing file path, resolved against the session working directory.' } }
  /** @param {any} args @param {any} exec */
  const request = (args, exec) => {
    if (typeof args?.file_path !== 'string' || !args.file_path.trim()) throw new Error('file_path must be a non-empty string')
    const cwd = exec.agent?.session?.header?.cwd
    if (typeof cwd !== 'string') throw new Error('session working directory unavailable')
    return { filePath: args.file_path, cwd }
  }
  const text = (/** @type {string} */ value) => ({ schema: { type: 'object' }, render: (/** @type {any} */ _args, /** @type {any} */ result) => [{ type: 'text', text: result[value] }] })
  return [
    ctx.tools.register({
      name: 'edit_lock_acquire',
      description: 'Acquire Edit Lock ownership of one existing file before editing it. Edits also acquire implicitly; call this explicitly to reserve a file, and for every file listed as pending-confirmation after a resume. Fails if another session owns the file.',
      parameters: { type: 'object', properties: filePath, required: ['file_path'] },
      output: text('message'),
      async execute(/** @type {any} */ args, /** @type {any} */ exec) {
        const result = await service.acquire(exec, request(args, exec))
        return { ...result, message: `Acquired ${result.resourceId} (generation ${result.generation}).` }
      },
    }),
    ctx.tools.register({
      name: 'edit_lock_release',
      description: 'Release this session\'s Edit Lock ownership of one file so other sessions can edit it. Release when you are done editing a file. Releasing does not validate the file content.',
      parameters: { type: 'object', properties: filePath, required: ['file_path'] },
      output: text('message'),
      async execute(/** @type {any} */ args, /** @type {any} */ exec) {
        const result = await service.release(exec, request(args, exec))
        return { ...result, message: `Released ${result.resourceId}.` }
      },
    }),
    ctx.tools.register({
      name: 'edit_lock_hold',
      description: 'Ask to keep this session\'s Edit Lock ownership for a bounded time counted from now, when you still need the files after this turn ends. The maximum per request and the budget for the whole batch are configurable; once the budget is used up you can only release. Keeping a file never grants permission you did not already have, and no file can be kept permanently.',
      parameters: { type: 'object', properties: {
        minutes: { type: 'number', description: 'How long to keep the files, counted from now. Omit to use the configured default.' },
      }, required: [] },
      output: text('message'),
      async execute(/** @type {any} */ args, /** @type {any} */ exec) {
        const minutes = args?.minutes === undefined ? undefined : Number(args.minutes)
        if (minutes !== undefined && (!Number.isFinite(minutes) || minutes <= 0)) throw new Error('minutes must be a positive number')
        const result = await service.hold(exec, minutes === undefined ? undefined : Math.round(minutes * 60_000))
        return { ...result, message: `Keeping ${result.lockCount} file(s) until ${new Date(result.holdUntil).toISOString()}; ${Math.round(result.holdCumulativeMs / 60_000)} of ${result.cumulativeMaxMinutes} minutes used in this batch.` }
      },
    }),
    ctx.tools.register({
      name: 'edit_lock_try_steal',
      description: 'Ask the session that owns a file to hand Edit Lock ownership over. Returns a pending request_id immediately; it never waits for the holder. The holder decides at a safe point; no reply within the negotiation window keeps their ownership. You are notified of the outcome; check edit_lock_status.',
      parameters: { type: 'object', properties: filePath, required: ['file_path'] },
      output: text('message'),
      async execute(/** @type {any} */ args, /** @type {any} */ exec) {
        const result = await service.trySteal(exec, request(args, exec))
        return { ...result, message: `Request ${result.requestId} is pending with holder ${result.holder} (${result.holderStatus}). Do not edit the file until ownership is granted.` }
      },
    }),
    ctx.tools.register({
      name: 'edit_lock_pause',
      description: 'Only during Edit Lock cleanup-only recovery: ask to keep your abnormal locks while an external problem clears (for example a provider outage). Up to 15 minutes per pause and 30 minutes in total; expiry re-checks the situation, it never releases or extends the locks.',
      parameters: { type: 'object', properties: { minutes: { type: 'number', description: 'Pause length in minutes (at most 15).' } }, required: ['minutes'] },
      output: text('message'),
      async execute(/** @type {any} */ args, /** @type {any} */ exec) {
        const result = await service.pause(exec, Number(args?.minutes))
        return { ...result, message: `Paused for ${Math.round(result.pausedMs / 60_000)} minute(s); ${Math.round(result.cumulativePauseMs / 60_000)} of 30 cumulative minutes used.` }
      },
    }),
    ctx.tools.register({
      name: 'edit_lock_status',
      description: 'List Edit Lock ownership in this work directory: file, owner session, status and reservation. Read-only; grants nothing.',
      parameters: { type: 'object', properties: {}, required: [] },
      output: text('message'),
      async execute(/** @type {any} */ _args, /** @type {any} */ exec) {
        const locks = await service.locks(exec)
        const lines = locks.map((/** @type {any} */ lock) => `- ${lock.resourceId} owner=${lock.mine ? 'this session' : lock.owner} status=${lock.status} generation=${lock.generation}${lock.reason ? ` reason=${lock.reason}` : ''}`)
        // The reservation is part of what the holder needs to know: without it the
        // answer looks identical before and after a successful keep, which invites
        // asking again instead of carrying on with the work.
        const retention = await service.retention(exec)
        if (retention?.held && retention.remainingMs > 0) {
          lines.push(`Reserved for ${Math.ceil(retention.remainingMs / 60_000)} more minute(s); ${Math.round(retention.holdCumulativeMs / 60_000)} minute(s) used in this batch.`)
        }
        return { locks, retention, message: lines.length ? lines.join('\n') : 'No Edit Lock ownership is held.' }
      },
    }),
  ]
}

/** @param {any} service */
function replyToolDefinition(service) {
  return {
    name: 'edit_lock_reply',
    description: 'Answer a pending Edit Lock ownership request addressed to this session. decision "release" hands the file to the requester (your ownership ends); "keep" retains it. Only the current holder execution can answer; stale or expired requests are refused.',
    parameters: { type: 'object', properties: {
      request_id: { type: 'string', description: 'request_id from the ownership request notice.' },
      decision: { type: 'string', enum: ['release', 'keep'], description: 'release to hand over, keep to retain.' },
    }, required: ['request_id', 'decision'] },
    output: { schema: { type: 'object' }, render: (/** @type {any} */ _args, /** @type {any} */ result) => [{ type: 'text', text: `Request ${result.requestId}: ${result.state}.` }] },
    async execute(/** @type {any} */ args, /** @type {any} */ exec) {
      if (typeof args?.request_id !== 'string') throw new Error('request_id must be a string')
      return service.reply(exec, { requestId: args.request_id, decision: args.decision })
    },
  }
}

/** @param {any} status */
function describe(status) {
  const lines = [`Edit Lock session ${status.sessionId}: ${status.state}${status.interrupted ? ' (interrupted)' : ''}, epoch ${status.executionEpoch ?? '-'}`]
  for (const lock of status.locks) lines.push(`- ${lock.resourceId} [${lock.status}${lock.reason ? `: ${lock.reason}` : ''}] generation ${lock.generation}`)
  if (status.locks.length === 0) lines.push('- no locks held')
  const recovery = status.recovery
  if (recovery && (recovery.attempts || recovery.elapsedMs || recovery.pauseMs)) {
    lines.push(`Recovery: ${recovery.attempts}/3 attempts, ${Math.round(recovery.elapsedMs / 1000)}s of 300s, pause ${Math.round(recovery.pauseMs / 60_000)}/30 min used`)
  }
  // Retention is reported as the one thing the user needs from it: how long the
  // files stay reserved. The raw budget belongs to the structured view, not here.
  const retention = status.retention
  if (retention?.held && retention.remainingMs > 0) {
    lines.push(`Reserved for ${Math.ceil(retention.remainingMs / 60_000)} more minute(s); ${Math.round(retention.holdCumulativeMs / 60_000)} minute(s) used in this batch.`)
  }
  return lines.join('\n')
}

/** Composition dependencies, not persisted settings. Defaults are the host paths.
 * @param {{ resolveRoot?: typeof managementRootFor, endpoint?: typeof endpointFor, exclude?: typeof excludeFromGit }} [dependencies] */
export function createEditLockPlugin({ resolveRoot = managementRootFor, endpoint = endpointFor, exclude = excludeFromGit } = {}) {
/** Arrow on purpose: cordis constructs prototype-bearing callbacks with `new`
 * and then drops their returned disposer, which would leak the reservation.
 * @param {any} ctx @param {unknown} config */
return (ctx, config = {}) => {
  const settings = ctx.get?.('orrerySettings')
  const options = editLockOptions(config, settings?.get?.('editLock'))
  // A generation-owned reporter; a later mount cannot overwrite this row.
  const evidence = settings?.editLockEvidence?.recordMount?.({
    enabled: Boolean(options), pinned: Object.hasOwn(config ?? {}, 'enabled'),
    fixed: options?.fixed != null, phase: options ? 'installing' : 'installed',
  })
  if (!options) return evidence ? () => evidence.dispose() : undefined
  try {
  /** @type {any} */
  let sandboxPolicyRef = null
  ctx.inject?.(['sandboxPolicy'], (/** @type {any} */ scope) => { sandboxPolicyRef = scope.sandboxPolicy })
  // Capture the original host filesystem once; the manager is its only writer.
  const fs = ctx.fs
  // The tool registry may hand back a normalized copy of a definition; the
  // claimed execute function is what actually runs, so it is the identity.
  /** @type {WeakSet<Function>} */
  const managed = new WeakSet()
  let closed = false
  /** Remote channel agents on the publisher side → their notice sink.
   * @type {WeakMap<object, (event: unknown) => void>} */
  const sinks = new WeakMap()
  /** Why registration failed for an agent, for the panel. @type {WeakMap<object, string>} */
  const startFailures = new WeakMap()
  /** Settled domain per bound agent, for synchronous gates. @type {WeakMap<object, any>} */
  const settled = new WeakMap()
  /** `wake` is used only for an ownership request addressed to an idle holder:
   * inject alone would sit unread until the holder's next user message, which is
   * how a request expired unanswered. Interrupted holders are never woken.
   * @param {any} agent @param {string} text @param {boolean} [wake] */
  const deliverLocal = (agent, text, wake = false) => {
    const message = userTextMessage(text, 'orrery-edit-lock')
    if (wake && agent?.status === 'idle' && agent?.followup) agent.followup(message)
    else agent.inject(message)
  }
  /** @param {any} agent @param {any} event */
  function deliverEvent(agent, event) {
    if (event?.kind === 'notice' && typeof event.text === 'string') deliverLocal(agent, event.text, event.wake === true)
    if (event?.kind === 'pending' && Number.isSafeInteger(event.count)) syncReplyTool(agent, event.count)
  }

  /** @param {string} root @param {string} directory */
  async function openDomain(root, directory) {
    try {
      if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 })
      let runtime
      try {
        // The store mode is read only after the reservation is held.
        runtime = await openReservedEditLockRuntime({ root, directory, domainId: root, mode: () => storeMode(directory), fs })
      } catch (error) {
        if (/** @type {any} */ (error)?.code !== 'EEXIST') throw error
        // Another cooperating host publishes: become its client, never a writer.
        const domain = remoteDomain(createRemoteEditLockDomain(endpoint(directory), {
          onNotice: deliverEvent,
          // The only way to reach here without a live publisher is a reservation left
          // by a host that crashed or was killed. Say so, and say what clears it.
          unreachableHint: `Another DeepSeek Harness reserved this project but is not answering. If no other Harness window is open on it, quit DeepSeek Harness, remove ${reservationPathFor(directory)}, and start it again.`,
        }))
        try { evidence?.recordDomain?.(root, { mode: domain.mode }) } catch { /* reporting only */ }
        return domain
      }
      const lifecycle = createEditLockLifecycle(runtime, sessionOf, {
        deliver: (agent, text, wake) => { const sink = sinks.get(agent); if (sink) sink({ kind: 'notice', text, wake: wake === true }); else deliverLocal(agent, text, wake) },
        onPending: (agent, count) => { const sink = sinks.get(agent); if (sink) sink({ kind: 'pending', count }); else syncReplyTool(agent, count) },
      })
      let server
      try { server = await serveEditLockEndpoint(lifecycle, endpoint(directory), sinks) }
      catch (error) { ctx.logger?.warn?.(`edit lock endpoint unavailable; other hosts fail closed: ${/** @type {any} */ (error)?.message ?? error}`) }
      const domain = localDomain(lifecycle, server)
      try { evidence?.recordDomain?.(root, { mode: domain.mode }) } catch { /* reporting only */ }
      return domain
    } catch (error) {
      // A domain that never opened is maintenance-visible as initialization
      // blocked; the manager behavior is unchanged.
      try { evidence?.recordDomain?.(root, { error: String(/** @type {any} */ (error)?.message ?? error) }) } catch { /* reporting only */ }
      throw error
    }
  }
  const registry = createDomainRegistry(root => {
    const fixed = options.fixed
    if (fixed) return openDomain(fixed.root, fixed.directory)
    try { exclude(root) } catch (error) { ctx.logger?.warn?.(`edit lock: could not update .git/info/exclude: ${/** @type {any} */ (error)?.message ?? error}`) }
    return openDomain(root, join(root, AUTHORITY_DIR))
  }, resolveRoot)
  /** @param {any} agent */
  const domainOf = agent => registry.forAgent(agent)

  /** The holder's structured reply tool. It is registered on the first request
   * and retired at a turn boundary once no request is pending: unregistering it
   * mid-turn made an expired-but-retried reply report "unknown tool" instead of
   * the real reason.
   * @type {WeakMap<object, {dispose: () => void, stale: boolean}>} */
  const replyTools = new WeakMap()
  /** @param {any} agent @param {number} pending */
  function syncReplyTool(agent, pending) {
    const registered = replyTools.get(agent)
    if (pending > 0 && !registered && agent?.ctx?.tools?.register) {
      replyTools.set(agent, { dispose: agent.ctx.tools.register(replyToolDefinition(service)), stale: false })
    } else if (registered) {
      registered.stale = pending === 0
    }
  }
  /** @param {any} agent */
  function retireReplyTool(agent) {
    const registered = replyTools.get(agent)
    if (!registered?.stale) return
    replyTools.delete(agent)
    registered.dispose()
  }
  /** @param {string} method */
  const route = method => async (/** @type {any} */ exec, /** @type {any} */ request) => /** @type {any} */ ((await domainOf(exec.agent)).service)[method](exec, request)
  const recovery = createRecoveryDriver({
    domainFor: agent => settled.get(agent),
    followup: (agent, text) => /** @type {any} */ (agent).followup(userTextMessage(text, 'orrery-edit-lock-recovery')),
    notify: deliverLocal,
    warn: message => ctx.logger?.warn?.(message),
  })
  /** Retention policy is resolved once per read from the settings section, so a
   * committed change takes effect without a restart and the kernel stays free of
   * configuration. @returns {any} */
  const strictLimits = () => editLockLimits(ctx.get?.('orrerySettings')?.get?.('editLock'))
  /** An incoherent saved combination (each field is validated on its own, so e.g.
   * a single cap below the default can be saved) must never switch off settling,
   * status, release, stop or unlock. Those read the built-in defaults instead and
   * warn; only a retention request is refused, with the named reason, because
   * that is the one decision the bad setting is about. */
  let warnedLimits = ''
  const limits = () => {
    try { return strictLimits() } catch (error) {
      const message = String(/** @type {any} */ (error)?.message ?? error)
      if (warnedLimits !== message) { warnedLimits = message; ctx.logger?.warn?.(`edit lock settings ignored, using defaults: ${message}`) }
      // Fall back for the retention fields only. The notice count and the
      // disposition keep their saved values: a bad cap must never turn a team's
      // "flag for a human" choice into a silent release.
      const section = /** @type {any} */ (ctx.get?.('orrerySettings')?.get?.('editLock')) ?? {}
      let nudge
      try { nudge = editLockLimits({ nudgeAttempts: section.nudgeAttempts, nudgeFallback: section.nudgeFallback }) } catch { nudge = editLockLimits(undefined) }
      return { ...editLockLimits(undefined), nudgeAttempts: nudge.nudgeAttempts, nudgeFallback: nudge.nudgeFallback, holdUnavailable: true }
    }
  }
  /** Turn-end settling: a finished turn that left locks behind is continued once,
   * asking for each file to be released or kept explicitly (design D2/D3). Only
   * `completed` enters here; the error and stop paths keep their own handling. */
  const settle = createSettlementDriver({
    domainFor: agent => settled.get(agent),
    followup: (agent, text) => /** @type {any} */ (agent).followup(userTextMessage(text, 'orrery-edit-lock-settle')),
    notify: deliverLocal,
    limits,
    warn: message => ctx.logger?.warn?.(message),
  })
  /** Expiry timers, keyed per agent. Read-time settlement is authoritative, so a
   * lost timer (suspend, sleep) only delays the release, never the decision.
   * @type {WeakMap<object, {timer?: any}>} */
  const expiry = new WeakMap()
  /** @param {any} agent @param {any} domain */
  function armExpiry(agent, domain) {
    const state = expiry.get(agent) ?? {}
    expiry.set(agent, state)
    if (state.timer) clearTimeout(state.timer)
    state.timer = undefined
    // Awaited: a cross-process client answers retention asynchronously, and a
    // synchronous read there never armed the timer at all.
    void Promise.resolve(domain.retention?.(agent)).then(retention => {
      if (!retention?.held || !(retention.remainingMs > 0)) return
      // Read the host timer through a guarded probe, not a bare member access: an
      // unavailable cordis service throws on access rather than returning undefined.
      const setTimer = safeSetTimer(ctx) ?? globalThis.setTimeout
      state.timer = setTimer(() => {
        state.timer = undefined
        // Busy at expiry: the turn-end handler releases it once that turn ends.
        void Promise.resolve(domain.settleExpired(agent)).then(result => {
          if (!result?.released?.length) return
          settle.settled(agent)
          deliverLocal(agent, `Edit Lock: the reservation ended, so ${result.released.length} file(s) are available to other sessions.`)
        }).catch((/** @type {any} */ error) => ctx.logger?.warn?.(`edit lock expiry release failed: ${error?.message ?? error}`))
      }, Math.min(retention.remainingMs, 2 ** 31 - 1))
      state.timer?.unref?.()
    }).catch((/** @type {any} */ error) => ctx.logger?.warn?.(`edit lock expiry arm failed: ${error?.message ?? error}`))
  }
  const service = Object.freeze({
    publish: route('publish'),
    publishBatch: route('publishBatch'),
    acquire: route('acquire'),
    release: route('release'),
    /** @param {any} exec */
    async locks(exec) { return (await domainOf(exec.agent)).service.locks(exec) },
    trySteal: route('trySteal'),
    reply: route('reply'),
    /** @param {any} exec @param {number} minutes */
    pause(exec, minutes) { return recovery.pause(exec.agent, minutes) },
    /** Ask to keep this session's locks after the turn ends, for a bounded time.
     * Retention only extends ownership; it grants nothing new (spec: Explicit
     * bounded retention). @param {any} exec @param {number} ms */
    async hold(exec, ms) {
      const policy = strictLimits()
      if (ms === undefined) ms = Math.round(policy.holdDefaultMinutes * 60_000)
      const result = await (await domainOf(exec.agent)).hold(exec.agent, ms, {
        singleMaxMs: policy.holdSingleMaxMinutes * 60_000,
        cumulativeMaxMs: policy.holdCumulativeMaxMinutes * 60_000,
      })
      armExpiry(exec.agent, settled.get(exec.agent))
      return { ...result, cumulativeMaxMinutes: policy.holdCumulativeMaxMinutes }
    },
    /** Retention state for this session, settled against now. Resolved through the
     * domain registry — the same path the lock list takes — rather than through the
     * per-agent binding, so a read-only observation works from any tool context.
     * @param {any} exec */
    async retention(exec) {
      const domain = await domainOf(exec.agent)
      return domain.retention(exec.agent)
    },
    /** Mount-time handshake from a managed editor. @param {object} definition */
    claim(definition) {
      const execute = /** @type {any} */ (definition)?.execute
      if (typeof execute === 'function') managed.add(execute)
    },
    /** Continuation gate: an interrupted or recovering session is never
     * re-armed implicitly. Unknown/unavailable state also blocks. @param {any} agent */
    blocksContinuation(agent) {
      const domain = settled.get(agent)
      return !domain || domain.blocks(agent)
    },
    /** Trusted UI observation for one agent; grants nothing. @param {any} agent */
    async describe(agent) {
      const domain = await domainOf(agent)
      return { root: registry.rootOf(agent), mode: domain.mode, status: await domain.status(agent), locks: await domain.locks(agent), recovery: recovery.state(agent) }
    },
  })
  ctx.reflect.provide('orreryEditLock', service)

  const offTools = registerLockTools(ctx, service)

  ctx.on('tools/pre-execute', (/** @type {any} */ exec, /** @type {() => Promise<any>} */ next) => {
    if (!GUARDED_TOOLS.includes(exec?.name)) return next()
    const definition = ctx.tools.get(exec.name, exec.agent)
    if (typeof definition?.execute === 'function' && managed.has(definition.execute)) return next()
    return Promise.resolve({ kind: 'deny', reason: `${exec.name} is not routed through Edit Lock in this composition; unmanaged file mutation refused.` })
  })

  ctx.on('agent/created', async (/** @type {any} */ { agent }) => {
    if (closed) return
    try {
      installEditLockWriteScope(agent, ctx, service, sandboxPolicyRef)
      registry.bind(agent, options.fixed?.root ?? agent?.session?.header?.cwd)
    } catch (error) {
      agent?.ctx?.tools?.restrict?.({ deny: [...GUARDED_TOOLS] })
      ctx.logger?.warn?.(`edit lock scope failed; edit tools denied: ${/** @type {any} */ (error)?.message ?? error}`)
      return
    }
    try {
      const domain = await domainOf(agent)
      await domain.start(agent)
      settled.set(agent, domain)
    } catch (error) {
      // Kept so the panel can say WHY editing is unavailable instead of
      // showing "starting" forever.
      startFailures.set(agent, String(/** @type {any} */ (error)?.message ?? error))
      try { evidence?.recordSessionFailure?.(sessionOf(agent), String(/** @type {any} */ (error)?.message ?? error)) } catch { /* reporting only */ }
      ctx.logger?.warn?.(`edit lock registration failed for ${sessionOf(agent)}: ${/** @type {any} */ (error)?.message ?? error}`)
    }
  })

  // Stock Stop aborts the active turn signal synchronously: close admission at
  // that instant. Idle Stop has no signal; /edit-lock stop is the awaitable path.
  /** Turn identity seen last per agent, so a new turn is detected exactly once.
   * @type {WeakMap<object, unknown>} */
  const lastTurn = new WeakMap()
  /** @type {WeakSet<AbortSignal>} */
  const watched = new WeakSet()
  ctx.on('agent/pre-step', (/** @type {any} */ event, /** @type {() => Promise<any>} */ next) => {
    const { agent, signal, turn } = event ?? {}
    const domain = agent && settled.get(agent)
    // `pre-step` fires once per STEP, not per turn, so "a new turn started" has to
    // be detected on turn identity. Doing it on every step would clear the
    // reservation a holder just asked for, one step later.
    if (domain && turn && lastTurn.get(agent) !== turn) {
      lastTurn.set(agent, turn)
      // The holder is working again: every lock it holds leaves the holding state at
      // once, without waiting for the reservation to run out (design D4), and the
      // notice budget for this batch restarts.
      settle.turnStarted(agent)
      void Promise.resolve(domain.turnStarted(agent)).catch((/** @type {any} */ error) => ctx.logger?.warn?.(`edit lock turn start failed: ${error?.message ?? error}`))
    }
    if (domain && signal && !watched.has(signal)) {
      watched.add(signal)
      const latch = () => { if (abortedByUser(signal)) domain.latch(agent) }
      if (signal.aborted) latch()
      else signal.addEventListener('abort', latch, { once: true })
    }
    return next()
  })

  // Classification and settling read only the durable turn/end reason
  // (AGENTS §3.5): `error` classifies the locks abnormal, `completed` settles the
  // locks the turn left behind, and `aborted` only latches. Nothing is inferred.
  ctx.on('session/event', (/** @type {any} */ session, /** @type {any} */ event) => {
    if (event?.type !== 'turn/end') return
    const agent = ctx.get?.('agents')?.get?.(session?.id)
    const domain = agent && settled.get(agent)
    if (!domain) return
    void recovery.onTurnEnd(agent, event.data?.reason).catch((/** @type {any} */ error) => {
      ctx.logger?.warn?.(`edit lock recovery classification failed: ${error?.message ?? error}`)
    })
    const reason = event.data?.reason
    if (reason?.kind !== 'completed') return
    // A reservation that ran out during the turn is released here (the turn is
    // over, so the session counts as idle). Settling starts in the same tick, not
    // after that release: a host that finishes when the agent goes idle would
    // otherwise end before the follow-up is queued. Its own status read happens
    // behind the release in the manager FIFO, so it sees the files already freed.
    void Promise.resolve(domain.settleExpired(agent, true)).then(result => {
      if (result?.released?.length) {
        settle.settled(agent)
        deliverLocal(agent, `Edit Lock: the reservation ended, so ${result.released.length} file(s) are available to other sessions.`)
      }
    }).catch((/** @type {any} */ error) => ctx.logger?.warn?.(`edit lock deferred release failed: ${error?.message ?? error}`))
    settle.onTurnEnd(agent, reason)
  })

  // A reply tool may only disappear at a turn boundary, never mid-turn.
  ctx.on('agent/turn-stopping', (/** @type {any} */ { agent }) => { retireReplyTool(agent) })

  ctx.on('agent/disposed', (/** @type {any} */ { agent }) => {
    replyTools.get(agent)?.dispose()
    replyTools.delete(agent)
    const timer = expiry.get(agent)?.timer
    if (timer) clearTimeout(timer)
    expiry.delete(agent)
    settle.settled(agent)
    const domain = settled.get(agent)
    settled.delete(agent)
    if (domain) void Promise.resolve(domain.dispose(agent)).catch(() => {})
  })

  // Structured status for the panel (design D6). Reading the view grants nothing
  // and writes nothing to the conversation; every action still goes through an
  // explicit /edit-lock command so it stays on the record. `connection` is a
  // host-plane service, so the isolated realm does not hide it.
  /** @type {() => void} */
  let offView = () => {}
  ctx.inject?.(['connection'], (/** @type {any} */ scope) => {
    const connection = scope.connection
    if (!connection?.fetch?.register) return
    const dispose = connection.fetch.register({
      path: '/api/orrery-edit-lock/view',
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (/** @type {any} */ request) => {
        const reply = (/** @type {any} */ payload, status = 200) => new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } })
        let body
        try { body = await request.json() } catch { body = null }
        const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : ''
        if (!sessionId) return reply({ ok: false, error: { code: 'orrery-edit-lock/invalid', message: 'body needs { sessionId }' } }, 400)
        const agent = ctx.get?.('agents')?.get?.(sessionId)
        const domain = agent && settled.get(agent)
        if (!domain) return reply({ ok: true, value: unavailableView(agent ? startFailures.get(agent) ?? null : null) })
        try {
          const [status, locks] = await Promise.all([domain.status(agent), domain.locks(agent)])
          return reply({ ok: true, value: buildView({ status, locks, cwd: agent?.session?.header?.cwd, root: registry.rootOf(agent), mode: domain.mode, now: Date.now() }) })
        } catch (error) {
          return reply({ ok: false, error: { code: 'orrery-edit-lock/internal', message: /** @type {any} */ (error)?.message ?? String(error) } }, 500)
        }
      },
    })
    offView = () => dispose?.()
    return offView
  })
  const commands = ctx.get?.('commands')
  const offCommand = commands?.register({
    name: 'edit-lock',
    description: 'Edit Lock: status, locks, hold [minutes], release <path>, stop (durable revoke), resume (explicit Continue), confirm <path> | --all, unlock <path> <generation>.',
    input: { hint: 'status | locks | hold [minutes] | release <path> | stop | resume | confirm <path> | unlock <path> <generation>' },
    handler: async (/** @type {any} */ invocation) => {
      const agent = invocation?.agent
      if (!agent) return { kind: 'error', text: 'edit-lock: requires an owning agent session' }
      try {
        const domain = await domainOf(agent)
        const raw = String(invocation.rawInput ?? '')
        // Only the hold verb depends on the retention settings being coherent.
        const policy = /^\s*hold\b/.test(raw) ? strictLimits() : limits()
        const text = await runCommand(domain, agent, raw, String(invocation.commandId), policy)
        return { kind: 'success', text: `${text}\nDomain: ${registry.rootOf(agent)} (${domain.mode})` }
      } catch (error) {
        return { kind: 'error', text: `edit-lock: ${/** @type {any} */ (error)?.message ?? error}` }
      }
    },
  })

  evidence?.installed()
  return async () => {
    if (closed) return
    closed = true
    evidence?.disposing()
    try {
      recovery.close()
      settle.close()
      offView()
      offCommand?.()
      for (const off of offTools) off?.()
      // Retain uncertain evidence until every generation-owned domain is drained.
      const results = await Promise.allSettled(registry.all().map(async domain => (await domain).close()))
      const failure = results.find(result => result.status === 'rejected')
      if (failure?.status === 'rejected') throw failure.reason
      evidence?.dispose()
    } catch (error) {
      evidence?.failed(error)
      ctx.logger?.warn?.(`edit lock shutdown incomplete; reservation retained: ${error?.message ?? error}`)
    }
  }
  } catch (error) {
    evidence?.failed(error)
    throw error
  }
}
}
const apply = createEditLockPlugin()

/** The host timer is an optional service: accessing an unavailable cordis service
 * throws rather than yielding undefined, so it is probed explicitly. Returning
 * undefined lets the caller fall back to the platform timer.
 * @param {any} ctx */
function safeSetTimer(ctx) {
  try {
    const timer = ctx?.setTimeout
    return typeof timer === 'function' ? timer.bind(ctx) : undefined
  } catch { return undefined }
}
/** Any abort latches (denial is always safe) except disposal, which
 * agent/disposed revokes and forgets. @param {AbortSignal} signal */
function abortedByUser(signal) {
  return /** @type {any} */ (signal.reason)?.kind !== 'disposed'
}

export { name, inject, apply }
