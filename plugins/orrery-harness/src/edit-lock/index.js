// Orrery Edit Lock composition: one in-process authority for one configured
// work-directory domain. Disabled (zero behavior, no service) unless the row
// config sets `enabled: true`. Plain ESM, ctx-only.
//
// Order contract: this row MUST precede hashline-edit and lsp so they capture
// the `orreryEditLock` service at mount. A mis-ordered or unmanaged editor is
// not trusted to "probably" be fine: the pre-execute guard denies every
// write/edit/hash_edit/lsp_rename definition that was not claimed through
// this service, so composition mistakes fail closed instead of bypassing.
import { existsSync, mkdirSync, readdirSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'
import { openReservedEditLockRuntime } from './reserved-runtime.js'
import { createEditLockLifecycle } from './lifecycle.js'
import { installEditLockWriteScope } from './tool-scope.js'
import { createResourceIdentity } from './resource-identity.js'

const name = 'orrery-edit-lock'
const inject = ['tools', 'fs']

/** Tool names whose definitions must be Edit Lock routed when enabled. */
export const GUARDED_TOOLS = Object.freeze(['write', 'edit', 'hash_edit', 'lsp_rename', 'str_replace_editor'])

/** @param {unknown} config */
export function editLockOptions(config) {
  const value = /** @type {any} */ (config ?? {})
  if (value.enabled !== true) return null
  for (const key of ['root', 'authorityDirectory']) {
    if (typeof value[key] !== 'string' || !isAbsolute(value[key])) throw new Error(`edit lock: ${key} must be an absolute path`)
  }
  if (value.domainId !== undefined && (typeof value.domainId !== 'string' || !value.domainId.trim())) throw new Error('edit lock: domainId must be a non-empty string')
  return { root: value.root, directory: value.authorityDirectory, domainId: value.domainId ?? value.root }
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

/** @param {any} lifecycle @param {any} agent @param {string} raw @param {string} commandId */
async function runCommand(lifecycle, agent, raw, commandId) {
  const [verb, ...rest] = raw.trim().split(/\s+/u)
  if (!verb || verb === 'status') return describe(lifecycle.status(agent))
  if (verb === 'stop') {
    await lifecycle.stop(agent)
    return `Edit authority durably revoked for this session.\n${describe(lifecycle.status(agent))}`
  }
  if (verb === 'resume') {
    const status = await lifecycle.resume(agent, `command:${commandId}`)
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
    await lifecycle.confirm(agent, observation.resourceId)
    return `Confirmed ${observation.resourceId}.\n${describe(lifecycle.status(agent))}`
  }
  throw new Error('Usage: /edit-lock [status|stop|resume|confirm <path>]')
}

/** @param {any} status */
function describe(status) {
  const lines = [`Edit Lock session ${status.sessionId}: ${status.state}${status.interrupted ? ' (interrupted)' : ''}, epoch ${status.executionEpoch ?? '-'}`]
  for (const lock of status.locks) lines.push(`- ${lock.resourceId} [${lock.status}${lock.reason ? `: ${lock.reason}` : ''}] generation ${lock.generation}`)
  if (status.locks.length === 0) lines.push('- no locks held')
  return lines.join('\n')
}

/** Arrow on purpose: cordis constructs prototype-bearing callbacks with `new`
 * and then drops their returned disposer, which would leak the reservation.
 * @param {any} ctx @param {unknown} config */
const apply = (ctx, config = {}) => {
  const options = editLockOptions(config)
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
  /** @type {any} */
  let lifecycleNow
  const ready = (async () => {
    const mode = storeMode(options.directory)
    const runtime = await openReservedEditLockRuntime({ ...options, mode, fs })
    return createEditLockLifecycle(runtime, sessionOf)
  })()
  ready.catch((/** @type {any} */ error) => {
    ctx.logger?.warn?.(`edit lock unavailable; controlled writes fail closed: ${error?.message ?? error}`)
  })
  const service = Object.freeze({
    /** @param {any} exec @param {any} request */
    async publish(exec, request) { return (await ready).service.publish(exec, request) },
    /** @param {any} exec @param {any} request */
    async publishBatch(exec, request) { return (await ready).service.publishBatch(exec, request) },
    /** Mount-time handshake from a managed editor. @param {object} definition */
    claim(definition) {
      const execute = /** @type {any} */ (definition)?.execute
      if (typeof execute === 'function') managed.add(execute)
    },
    /** Continuation gate: an interrupted session is never re-armed implicitly.
     * Unknown/unavailable state also blocks. @param {any} agent */
    blocksContinuation(agent) {
      try { return !lifecycleNow || lifecycleNow.status(agent).state !== 'active' } catch { return true }
    },
  })
  void ready.then(lifecycle => { lifecycleNow = lifecycle }, () => {})
  ctx.reflect.provide('orreryEditLock', service)

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
    } catch (error) {
      agent?.ctx?.tools?.restrict?.({ deny: [...GUARDED_TOOLS] })
      ctx.logger?.warn?.(`edit lock scope failed; edit tools denied: ${/** @type {any} */ (error)?.message ?? error}`)
      return
    }
    try { await (await ready).start(agent) }
    catch (error) { ctx.logger?.warn?.(`edit lock registration failed for ${sessionOf(agent)}: ${/** @type {any} */ (error)?.message ?? error}`) }
  })

  // Stock Stop aborts the active turn signal synchronously: close admission at
  // that instant. Idle Stop has no signal; /edit-lock stop is the awaitable path.
  /** @type {WeakSet<AbortSignal>} */
  const watched = new WeakSet()
  ctx.on('agent/pre-step', (/** @type {any} */ event, /** @type {() => Promise<any>} */ next) => {
    const { agent, signal } = event ?? {}
    if (lifecycleNow && agent && signal && !watched.has(signal)) {
      watched.add(signal)
      const lifecycle = lifecycleNow
      const latch = () => { lifecycle.stop(agent).catch(() => {}) }
      if (signal.aborted) latch()
      else signal.addEventListener('abort', latch, { once: true })
    }
    return next()
  })

  ctx.on('agent/disposed', (/** @type {any} */ { agent }) => {
    void ready.then(lifecycle => lifecycle.dispose(agent)).catch(() => {})
  })

  const commands = ctx.get?.('commands')
  const offCommand = commands?.register({
    name: 'edit-lock',
    description: 'Edit Lock for this session: status, stop (durable revoke), resume (explicit Continue), confirm <path>.',
    input: { hint: 'status | stop | resume | confirm <path>' },
    handler: async (/** @type {any} */ invocation) => {
      const agent = invocation?.agent
      if (!agent) return { kind: 'error', text: 'edit-lock: requires an owning agent session' }
      try {
        const lifecycle = await ready
        return { kind: 'success', text: await runCommand(lifecycle, agent, String(invocation.rawInput ?? ''), String(invocation.commandId)) }
      } catch (error) {
        return { kind: 'error', text: `edit-lock: ${/** @type {any} */ (error)?.message ?? error}` }
      }
    },
  })

  return () => {
    closed = true
    offCommand?.()
    // Stops every session durably, drains publication, then releases the
    // cross-process reservation. Failure retains it for operator recovery.
    void ready.then(lifecycle => lifecycle.close()).catch((/** @type {any} */ error) => {
      ctx.logger?.warn?.(`edit lock shutdown incomplete; reservation retained: ${error?.message ?? error}`)
    })
  }
}

export { name, inject, apply }
