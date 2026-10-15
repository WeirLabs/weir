/** Per-agent binding state machine (change edit-lock-deepening, design D3):
 * setupAgentOnce / setupAgent / retryBinding / disposeAgent / startupFailure /
 * dispositionFor and the closure state they share, extracted from the
 * composition (index.js), which now keeps pure wiring: tool registration, the
 * pre-execute guard, HTTP endpoints, the /edit-lock command, drivers and event
 * listeners. The move is mechanical — no logic changed; every container keeps
 * exactly the lifetime it had in the mount closure.
 *
 * Lifetime table (itemized BEFORE the move; the move changed nothing in it):
 *
 *   state               lifetime       home after the move
 *   ------------------  -------------  --------------------------------------
 *   settled             cross-mount    sharedDomainRegistryFor entry (existing
 *                       precedent, with recoveryNotices); INJECTED, not owned
 *   writeScopes         host-lifetime  writeScopesFor(host) store, surviving a
 *                       preset rebind; INJECTED — the preset-rebind survival
 *                       semantics and the `ctx.root ?? ctx` host key are
 *                       unchanged
 *   disposedAgents      per-mount      this module (WeakSet)
 *   startFailures       per-mount      this module (WeakMap)
 *   bindingFailures     per-mount      this module (WeakMap)
 *   setupInFlight       per-mount      this module (WeakMap)
 *   boundAgents         per-mount      this module (Map by session id)
 *   dispositions        per-mount      this module (Map by session id; the
 *                       latest incarnation stays joinable after synchronous
 *                       cleanup)
 *   agentDispositions   per-mount      this module (WeakMap)
 *   disposalTasks       per-mount      this module (WeakMap)
 *   pendingAutoResume   per-mount      composition turn wiring; INJECTED (a
 *                       successful retry clears an armed auto-resume)
 *   delegateResumes     per-mount      composition delegate-lifecycle wiring;
 *                       INJECTED (a fresh bind replays a pending resume)
 *   turnClassifications per-mount      composition turn/end listener; INJECTED
 *                       (dispose awaits the durable classification first)
 *   replyTools          per-mount      composition negotiation wiring;
 *                       INJECTED (dispose retires the reply tool)
 *   expiry              per-mount      composition retention-timer wiring;
 *                       INJECTED (dispose clears the timer)
 *
 * Cross-mount state rides the EXISTING sharedDomainRegistryFor entry — no new
 * cross-mount container is introduced. Mount-generation flags arrive as
 * getters (isClosed/platformFailure) so the machine reads the live value.
 * @param {{
 *   ctx: any, sessionOf: (agent: any) => string | undefined, GUARDED_TOOLS: readonly string[],
 *   options: any, registry: any, settled: WeakMap<object, any>, writeScopes: WeakMap<object, import('./write-scopes.js').WriteScopeEntry>,
 *   domainOf: (agent: any) => Promise<any>, servingRuntime: (sessionId: string) => any,
 *   ownAgent: (agent: any) => boolean, installWriteScope: (agent: any) => import('./write-scopes.js').WriteScopeEntry,
 *   evidence: any, audit: (session: any, type: any, data: any, options?: any) => void, deliverLocal: (agent: any, text: string, wake?: boolean) => void,
 *   pendingAutoResume: WeakMap<object, boolean>, delegateResumes: Map<string, any>, turnClassifications: WeakMap<object, Promise<unknown>>,
 *   replyTools: WeakMap<object, {dispose: () => void, stale: boolean}>, expiry: WeakMap<object, {timer?: any}>, settle: any,
 *   isClosed: () => boolean, platformFailure: () => any,
 * }} deps
 */
import { AUDIT_TYPES } from '../shared/audit.js'
import { disposeWriteScope } from './write-scopes.js'

/** In-session binding-failure notice copy (change edit-lock-binding-transfer,
 * design D4): the transferable class (same-process idle holder) is a calm
 * self-heal announcement rather than an editing-disabled alarm and never
 * carries the raw holder classification or the reservation warning; a mid-turn
 * holder names the real state and the retry moment. Template layer stays
 * English (AGENTS §3.7). @param {string} reason @param {any} failure */
function bindingFailureNotice(reason, failure) {
  if (failure?.code === 'binding-duplicate' && failure.holderKind === 'transferable') {
    return "Edit Lock: this session's editing authority is held by an inactive attachment of this same session; it transfers automatically when you send a message."
  }
  if (failure?.code === 'binding-duplicate' && failure.holderKind === 'serving') {
    return "Edit Lock: this session is being edited in another attachment right now; managed file editing stays unavailable until that turn finishes. Do not retry the failed edit; use /edit-lock retry (or the panel's Retry connection) once it finishes — retry does not Continue editing."
  }
  return `Edit Lock could not start this session's edit domain (${reason}); managed file editing is temporarily unavailable. ${failure?.code === 'binding-duplicate' ? 'Do not retry the failed edit: the binding is retried automatically when the user next sends a message, after which editing works normally. Never remove a live publisher reservation.' : 'Inspect Edit Lock maintenance before continuing.'}`
}

export function createBindingMachine(deps) {
  const {
    ctx, sessionOf, GUARDED_TOOLS, options, registry, settled, writeScopes,
    domainOf, servingRuntime, ownAgent, installWriteScope,
    evidence, audit, deliverLocal,
    pendingAutoResume, delegateResumes, turnClassifications, replyTools, expiry, settle,
    isClosed, platformFailure,
  } = deps
  /** Agents disposed in this mount; their undispatched sweep work cancels.
   * @type {WeakSet<object>} */
  const disposedAgents = new WeakSet()
  /** Why registration failed for an agent, for the panel. @type {WeakMap<object, string>} */
  const startFailures = new WeakMap()
  /** Publisher-classified failures, never inferred from text. @type {WeakMap<object, any>} */
  const bindingFailures = new WeakMap()
  /** In-flight setup per agent, shared by every entry point (creation,
   * preset-switch, catch-up, lazy re-bind) so concurrent callers can never
   * double-register. @type {WeakMap<object, Promise<void>>} */
  const setupInFlight = new WeakMap()
  const boundAgents = new Map()
  // Keep the latest incarnation joinable even after synchronous binding cleanup.
  // Exact-handle waiters retain their own record when a session activates again.
  const dispositions = new Map()
  const agentDispositions = new WeakMap()
  const disposalTasks = new WeakMap()

  function dispositionFor(agent) {
    let record = agentDispositions.get(agent)
    if (!record) {
      record = Promise.withResolvers()
      record.promise.catch(() => {}) // emit initiators have no awaiting caller
      agentDispositions.set(agent, record)
      dispositions.set(agent.id, record)
    }
    return record
  }

  /** Only this live Agent's diagnostic; no domain reads or startup side effects. @param {any} agent */
  function startupFailure(agent) {
    const platform = platformFailure()
    if (platform) return { state: 'unavailable', reason: platform.message, bindingFailure: null }
    if (!agent || settled.has(agent) || !startFailures.has(agent)) return null
    let eligible = false
    try {
      const serving = servingRuntime(agent.id)
      eligible = !isClosed() && !disposedAgents.has(agent) && ownAgent(agent)
        && (serving === agent
          // The registry names ANOTHER live local agent — the dual-agent defect
          // this change heals (edit-lock-binding-transfer). The recorded
          // duplicate-binding failure is still THIS agent's honest panel state:
          // show it, with its Retry action, instead of hiding behind the ghost's
          // healthy binding. An empty registry stays hidden (unattestable).
          || (serving !== undefined && bindingFailures.get(agent)?.code === 'binding-duplicate'))
    } catch { /* no trusted live identity */ }
    if (!eligible) return null
    const failure = bindingFailures.get(agent)
    return { state: 'unavailable', reason: startFailures.get(agent),
      bindingFailure: failure ? { ...failure, inFlight: setupInFlight.has(agent) } : null }
  }

  /** Per-agent Edit Lock setup, shared by the creation listener, the
   * preset-switch re-bind, the late-mount catch-up and the guard/acquire lazy
   * re-bind, so the paths can never diverge. Root selection and successful
   * startup are separate: explicit binding retry reuses the existing scope
   * and root, while ordinary entry points never repeat a failed startup.
   * @param {any} agent @param {boolean} [retry] @param {boolean} [transfer]
   * transfer (change edit-lock-binding-transfer) marks the driving-ingress
   * transfer admission: the domain's transferStart re-adjudicates holder
   * idleness at execution, and the post-bind registry-identity check is
   * skipped because the registry legitimately still names the idle holder. */
  async function setupAgentOnce(agent, retry = false, transfer = false) {
    if (isClosed() || settled.has(agent)) return
    // No writer scope, root resolution, directory, reservation or session
    // authority may be installed when the mount preflight failed.
    if (platformFailure()) return
    if (!registry.rootOf(agent)) try {
      // A previous generation's managed write survives in the agent's own
      // scope layer (a preset rebind never disposes own-layer registrations);
      // retire it first or the scope registry throws duplicate-registration
      // and the re-bind dies here (design D3).
      disposeWriteScope(writeScopes, agent)
      writeScopes.set(agent, installWriteScope(agent))
      registry.bind(agent, options.fixed?.root ?? agent?.session?.header?.cwd)
    } catch (error) {
      // The denial itself must never escape: restrict() throws on names the
      // agent's composition does not know, and an escape from this setup path
      // is fiber-fatal during a reload (2026-10-05 host crash). Deny only the
      // guarded tools the agent actually has.
      try {
        const known = GUARDED_TOOLS.filter(name => ctx.tools?.get?.(name, agent) !== undefined)
        if (known.length > 0) agent?.ctx?.tools?.restrict?.({ deny: [...known] })
      } catch { /* the denial is best-effort; the records below are the visible account */ }
      // Failure visibility (design D4): the same reason lands in the panel
      // state, the maintenance evidence, an in-session notice and the durable
      // audit; the warn stays as the host ring-buffer copy.
      const reason = String(/** @type {any} */ (error)?.message ?? error)
      startFailures.set(agent, reason)
      try { evidence?.recordSessionFailure?.(sessionOf(agent), reason) } catch { /* reporting only */ }
      audit(agent?.session ?? null, AUDIT_TYPES.editLockMaintenance, { kind: 'setup-failed', sessionId: sessionOf(agent) ?? null, reason })
      try { deliverLocal(agent, `Edit Lock is unavailable for this session (${reason}); managed file editing is disabled and the failed edit must not be retried. This failure is not repaired automatically: the user can restart DeepSeek Harness or start a new conversation.`) } catch { /* the audit record is the durable account */ }
      ctx.logger?.warn?.(`edit lock scope failed; edit tools denied: ${reason}`)
      return
    }
    try {
      const domain = await domainOf(agent)
      if (transfer) await domain.transferStart(agent)
      else if (retry) await domain.retryStart(agent)
      else await domain.start(agent)
      if (isClosed() || disposedAgents.has(agent) || (retry && (!ownAgent(agent) || (!transfer && servingRuntime(agent.id) !== agent)))) {
        await domain.forget(agent)
        throw new Error('Edit Lock mount changed during binding')
      }
      startFailures.delete(agent)
      bindingFailures.delete(agent)
      try { evidence?.clearSessionFailure?.(sessionOf(agent)) } catch { /* reporting cannot undo a successful bind */ }
      // A genuine message from a turn that ran while binding was unavailable
      // is not a Continue receipt for a later injected wake after connection retry.
      if (retry) pendingAutoResume.delete(agent)
      settled.set(agent, domain)
      boundAgents.set(agent.id, agent)
      dispositionFor(agent)
      if (!retry) await delegateResumes.get(agent.id)?.resume(agent, domain)
    } catch (error) {
      // Kept so the panel can say WHY editing is unavailable instead of
      // showing "starting" forever; the notice aligns this catch with the
      // write-scope failure above.
      const reason = String(/** @type {any} */ (error)?.message ?? error)
      startFailures.set(agent, reason)
      const failure = /** @type {any} */ (error)?.bindingFailure
      if (failure?.code === 'binding-duplicate') bindingFailures.set(agent, failure)
      else bindingFailures.delete(agent)
      try { evidence?.recordSessionFailure?.(sessionOf(agent), reason) } catch { /* reporting only */ }
      try { deliverLocal(agent, bindingFailureNotice(reason, failure)) } catch { /* the panel record remains */ }
      ctx.logger?.warn?.(`edit lock registration failed for ${sessionOf(agent)}: ${reason}`)
    }
  }
  /** Concurrent entry points (agent/created, preset-switch, lazy re-bind)
   * share one in-flight setup per agent; a completed setup short-circuits on
   * the root binding. @param {any} agent @returns {Promise<void>} */
  function setupAgent(agent) {
    const pending = setupInFlight.get(agent)
    if (pending) return pending
    if (isClosed() || settled.has(agent) || registry.rootOf(agent)) return Promise.resolve()
    const inner = setupAgentOnce(agent)
    const task = inner.finally(() => { if (setupInFlight.get(agent) === task) setupInFlight.delete(agent) })
    setupInFlight.set(agent, task)
    return task
  }
  /** Trusted driving ingresses only: the explicit /edit-lock retry (and panel
   * action), the message-armed pre-step retry, and the write-guard lazy
   * re-bind. Same Agent/root/mount; no writer reinstallation. Every attempt
   * past the eligibility gate is audited — a silently swallowed refusal is a
   * defect (change edit-lock-binding-transfer, design D3/D5).
   * @param {any} agent @param {'command' | 'message' | 'write-guard'} [via] */
  async function retryBinding(agent, via = 'command') {
    if (isClosed() || disposedAgents.has(agent) || !ownAgent(agent)) throw new Error('Edit Lock retry requires the current live Agent of this mount')
    if (!registry.rootOf(agent) || bindingFailures.get(agent)?.code !== 'binding-duplicate') throw new Error('Edit Lock startup failure is not eligible for binding retry')
    const cause = bindingFailures.get(agent)
    const sessionId = sessionOf(agent) ?? null
    const root = registry.rootOf(agent) ?? undefined
    /** @param {string} result @param {Record<string, unknown>} [extra] */
    const record = (result, extra = {}) => audit(agent?.session ?? null, AUDIT_TYPES.editLockMaintenance, {
      kind: 'binding-transfer', sessionId, code: cause?.code ?? 'binding-duplicate', result, ...extra,
    }, { root })
    // Attestation trichotomy (design D5): the registry naming THIS claimant
    // keeps the existing superseded rebind; naming ANOTHER live local agent
    // routes to the transfer admission (holder idleness is re-adjudicated at
    // execution, publisher-side); an unavailable or empty registry stays
    // fail-closed — the holder cannot be attested.
    let serving
    try { serving = servingRuntime(agent.id) } catch { serving = undefined }
    if (serving === undefined) {
      const error = new Error('Edit Lock binding retry refused: the agent registry is unavailable or names no live agent for this session, so the holder cannot be attested. The recorded cause stays; a later retry remains possible.')
      record('refused', { reason: 'registry-unattestable', detail: error.message })
      throw error
    }
    const transfer = serving !== agent
    try {
      let task = setupInFlight.get(agent)
      if (!task) {
        const inner = setupAgentOnce(agent, true, transfer)
        task = inner.finally(() => { if (setupInFlight.get(agent) === task) setupInFlight.delete(agent) })
        setupInFlight.set(agent, task)
      }
      await task
    } catch (error) {
      record('refused', { reason: /** @type {any} */ (error)?.bindingFailure?.holderKind ?? 'retry-refused', detail: String(/** @type {any} */ (error)?.message ?? error) })
      throw error
    }
    const failure = startFailures.get(agent)
    if (failure || !settled.has(agent)) {
      // setupAgentOnce records instead of rethrowing: the refusal's holder
      // class comes from the freshly re-recorded structured failure.
      const error = new Error(failure ?? 'Edit Lock binding remains unavailable')
      record('refused', { reason: bindingFailures.get(agent)?.holderKind ?? 'binding-unavailable', detail: error.message })
      throw error
    }
    if (transfer) {
      record('transferred', { holder: cause?.holderKind ?? null })
    } else if (via === 'message') {
      // The message-armed superseded success keeps its established audit shape
      // (pinned by the editlock-binding-auto-retry integration scenario).
      audit(agent?.session ?? null, AUDIT_TYPES.editLockMaintenance, {
        kind: 'binding-auto-retry', sessionId, code: cause?.code ?? 'binding-duplicate', result: 'recovered',
      }, { root })
    }
    return 'Edit Lock connection recovered. Editing remains interrupted; use Continue editing when ready. No failed edit was replayed.'
  }
  function disposeAgent(agent) {
    if (disposedAgents.has(agent)) return disposalTasks.get(agent) ?? Promise.resolve()
    if (boundAgents.get(agent.id) === agent) boundAgents.delete(agent.id)
    // Undispatched sweep work armed by this agent cancels here (an in-flight
    // authority transaction is never cancelled or reinterpreted).
    disposedAgents.add(agent)
    // The managed write lives on the agent's own scope layer, which dies with
    // the agent: retire the host-lifetime registration here (design D3).
    disposeWriteScope(writeScopes, agent)
    replyTools.get(agent)?.dispose()
    replyTools.delete(agent)
    const timer = expiry.get(agent)?.timer
    if (timer) clearTimeout(timer)
    expiry.delete(agent)
    settle.settled(agent)
    const domain = settled.get(agent)
    settled.delete(agent)
    // The emit hook must cancel timers/scopes/sweeps synchronously. Only the
    // final authority disposal waits for durable abnormal classification.
    const record = dispositionFor(agent)
    const task = Promise.resolve(turnClassifications.get(agent)).then(() => domain?.dispose(agent))
    task.then(record.resolve, record.reject)
    disposalTasks.set(agent, record.promise)
    return record.promise
  }

  return {
    disposedAgents, startFailures, bindingFailures, setupInFlight,
    boundAgents, dispositions, agentDispositions,
    setupAgent, retryBinding, disposeAgent, startupFailure,
  }
}
