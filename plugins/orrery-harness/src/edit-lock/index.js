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
import { createEditLockLifecycle } from './lifecycle.js'
import { installEditLockWriteScope } from './tool-scope.js'
import { createResourceIdentity } from './resource-identity.js'
import { userTextMessage } from '../shared/user-message.js'
import { createRemoteEditLockDomain, endpointFor, serveEditLockEndpoint } from './remote.js'
import { localDomain, remoteDomain } from './domain.js'
import { AUTHORITY_DIR, createDomainRegistry, excludeFromGit } from './domains.js'
import { createRecoveryDriver } from './recovery.js'

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

/** @param {any} domain @param {any} agent @param {string} raw @param {string} commandId */
async function runCommand(domain, agent, raw, commandId) {
  const [verb, ...rest] = raw.trim().split(/\s+/u)
  if (!verb || verb === 'status') return describe(await domain.status(agent))
  if (verb === 'stop') {
    const status = await domain.stop(agent)
    return `Edit authority durably revoked for this session.\n${describe(status)}`
  }
  if (verb === 'resume') {
    const status = await domain.resume(agent, `command:${commandId}`)
    const pending = status.locks.filter(/** @param {any} lock */ lock => lock.status === 'pending-confirmation')
    return `Edit authority resumed with a new execution epoch.${pending.length ? ' Confirm each retained file with /edit-lock confirm <path> before editing it.' : ''}\n${describe(status)}`
  }
  if (verb === 'confirm') {
    const path = rest.join(' ')
    if (!path) throw new Error('Usage: /edit-lock confirm <path>')
    const cwd = agent?.session?.header?.cwd
    if (typeof cwd !== 'string') throw new Error('session cwd unavailable')
    const observation = createResourceIdentity().resolve(path, { cwd })
    if (observation.kind !== 'file') throw new Error('confirm requires an existing regular file')
    const status = await domain.confirm(agent, observation.resourceId)
    return `Confirmed ${observation.resourceId}.\n${describe(status)}`
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
  throw new Error('Usage: /edit-lock [status|locks|stop|resume|confirm <path>|unlock <path> <generation>]')
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
      description: 'List Edit Lock ownership in this work directory: file, owner session, status. Read-only; grants nothing.',
      parameters: { type: 'object', properties: {}, required: [] },
      output: text('message'),
      async execute(/** @type {any} */ _args, /** @type {any} */ exec) {
        const locks = await service.locks(exec)
        const lines = locks.map((/** @type {any} */ lock) => `- ${lock.resourceId} owner=${lock.mine ? 'this session' : lock.owner} status=${lock.status}${lock.reason ? ` reason=${lock.reason}` : ''}`)
        return { locks, message: lines.length ? lines.join('\n') : 'No Edit Lock ownership is held.' }
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
  return lines.join('\n')
}

/** Arrow on purpose: cordis constructs prototype-bearing callbacks with `new`
 * and then drops their returned disposer, which would leak the reservation.
 * @param {any} ctx @param {unknown} config */
const apply = (ctx, config = {}) => {
  const options = editLockOptions(config, ctx.get?.('orrerySettings')?.get?.('editLock'))
  if (!options) return
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
  /** Settled domain per bound agent, for synchronous gates. @type {WeakMap<object, any>} */
  const settled = new WeakMap()
  /** inject never wakes an idle or interrupted agent: no nested execution.
   * @param {any} agent @param {string} text */
  const deliverLocal = (agent, text) => agent.inject(userTextMessage(text, 'orrery-edit-lock'))

  /** @param {string} root @param {string} directory */
  async function openDomain(root, directory) {
    if (!existsSync(directory)) mkdirSync(directory, { recursive: true, mode: 0o700 })
    let runtime
    try {
      // The store mode is read only after the reservation is held.
      runtime = await openReservedEditLockRuntime({ root, directory, domainId: root, mode: () => storeMode(directory), fs })
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'EEXIST') throw error
      // Another cooperating host publishes: become its client, never a writer.
      return remoteDomain(createRemoteEditLockDomain(endpointFor(directory), {
        onNotice(agent, event) {
          if (event?.kind === 'notice' && typeof event.text === 'string') deliverLocal(agent, event.text)
          if (event?.kind === 'pending' && Number.isSafeInteger(event.count)) syncReplyTool(agent, event.count)
        },
      }))
    }
    const lifecycle = createEditLockLifecycle(runtime, sessionOf, {
      deliver: (agent, text) => { const sink = sinks.get(agent); if (sink) sink({ kind: 'notice', text }); else deliverLocal(agent, text) },
      onPending: (agent, count) => { const sink = sinks.get(agent); if (sink) sink({ kind: 'pending', count }); else syncReplyTool(agent, count) },
    })
    let endpoint
    try { endpoint = await serveEditLockEndpoint(lifecycle, endpointFor(directory), sinks) }
    catch (error) { ctx.logger?.warn?.(`edit lock endpoint unavailable; other hosts fail closed: ${/** @type {any} */ (error)?.message ?? error}`) }
    return localDomain(lifecycle, endpoint)
  }
  const registry = createDomainRegistry(root => {
    const fixed = options.fixed
    if (fixed) return openDomain(fixed.root, fixed.directory)
    try { excludeFromGit(root) } catch (error) { ctx.logger?.warn?.(`edit lock: could not update .git/info/exclude: ${/** @type {any} */ (error)?.message ?? error}`) }
    return openDomain(root, join(root, AUTHORITY_DIR))
  })
  /** @param {any} agent */
  const domainOf = agent => registry.forAgent(agent)

  /** The holder's structured reply tool exists only while it has pending requests.
   * @type {WeakMap<object, () => void>} */
  const replyTools = new WeakMap()
  /** @param {any} agent @param {number} pending */
  function syncReplyTool(agent, pending) {
    const registered = replyTools.get(agent)
    if (pending > 0 && !registered && agent?.ctx?.tools?.register) {
      replyTools.set(agent, agent.ctx.tools.register(replyToolDefinition(service)))
    } else if (pending === 0 && registered) {
      replyTools.delete(agent)
      registered()
    }
  }
  /** @param {string} method */
  const route = method => async (/** @type {any} */ exec, /** @type {any} */ request) => /** @type {any} */ ((await domainOf(exec.agent)).service)[method](exec, request)
  const recovery = createRecoveryDriver({
    domainFor: agent => settled.get(agent),
    followup: (agent, text) => /** @type {any} */ (agent).followup(userTextMessage(text, 'orrery-edit-lock-recovery')),
    notify: deliverLocal,
    warn: message => ctx.logger?.warn?.(message),
  })
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
    } catch (error) { ctx.logger?.warn?.(`edit lock registration failed for ${sessionOf(agent)}: ${/** @type {any} */ (error)?.message ?? error}`) }
  })

  // Stock Stop aborts the active turn signal synchronously: close admission at
  // that instant. Idle Stop has no signal; /edit-lock stop is the awaitable path.
  /** @type {WeakSet<AbortSignal>} */
  const watched = new WeakSet()
  ctx.on('agent/pre-step', (/** @type {any} */ event, /** @type {() => Promise<any>} */ next) => {
    const { agent, signal } = event ?? {}
    const domain = agent && settled.get(agent)
    if (domain && signal && !watched.has(signal)) {
      watched.add(signal)
      const latch = () => { if (abortedByUser(signal)) domain.latch(agent) }
      if (signal.aborted) latch()
      else signal.addEventListener('abort', latch, { once: true })
    }
    return next()
  })

  // Abnormal classification reads only the durable turn/end reason (AGENTS §3.5).
  ctx.on('session/event', (/** @type {any} */ session, /** @type {any} */ event) => {
    if (event?.type !== 'turn/end') return
    const agent = ctx.get?.('agents')?.get?.(session?.id)
    if (!agent || !settled.get(agent)) return
    void recovery.onTurnEnd(agent, event.data?.reason).catch((/** @type {any} */ error) => {
      ctx.logger?.warn?.(`edit lock recovery classification failed: ${error?.message ?? error}`)
    })
  })

  ctx.on('agent/disposed', (/** @type {any} */ { agent }) => {
    const domain = settled.get(agent)
    settled.delete(agent)
    if (domain) void Promise.resolve(domain.dispose(agent)).catch(() => {})
  })

  const commands = ctx.get?.('commands')
  const offCommand = commands?.register({
    name: 'edit-lock',
    description: 'Edit Lock: status, locks, stop (durable revoke), resume (explicit Continue), confirm <path>, unlock <path> <generation>.',
    input: { hint: 'status | locks | stop | resume | confirm <path> | unlock <path> <generation>' },
    handler: async (/** @type {any} */ invocation) => {
      const agent = invocation?.agent
      if (!agent) return { kind: 'error', text: 'edit-lock: requires an owning agent session' }
      try {
        const domain = await domainOf(agent)
        const text = await runCommand(domain, agent, String(invocation.rawInput ?? ''), String(invocation.commandId))
        return { kind: 'success', text: `${text}\nDomain: ${registry.rootOf(agent)} (${domain.mode})` }
      } catch (error) {
        return { kind: 'error', text: `edit-lock: ${/** @type {any} */ (error)?.message ?? error}` }
      }
    },
  })

  return () => {
    closed = true
    recovery.close()
    offCommand?.()
    for (const off of offTools) off?.()
    // Stops every session durably, drains publication, then releases each
    // cross-process reservation. Failure retains it for operator recovery.
    for (const domain of registry.all()) {
      void domain.then(value => value.close()).catch((/** @type {any} */ error) => {
        ctx.logger?.warn?.(`edit lock shutdown incomplete; reservation retained: ${error?.message ?? error}`)
      })
    }
  }
}

/** Any abort latches (denial is always safe) except disposal, which
 * agent/disposed revokes and forgets. @param {AbortSignal} signal */
function abortedByUser(signal) {
  return /** @type {any} */ (signal.reason)?.kind !== 'disposed'
}

export { name, inject, apply }
