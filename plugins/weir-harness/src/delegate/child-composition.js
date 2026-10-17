// Child composition shim: the creation-window replacement for the
// request-level `persona`/`toolFilter` fields DSH 0.2.1 removed from
// `subagents.startActivation`. The delegate module reserves the childId before
// spawning, registers the composition here, and the `agent/created` listener
// applies it inside the child's creation window — before the subagent runtime
// delivers the initial prompt (startLocal → materialize → agents.create →
// setup → announce → submitMaterialized, verified against 0.2.1).
//
// Timing is race-free by construction and fail-closed: a fresh spawn waits for
// the recorded verdict and tears the child down when the composition did not
// land, so no child ever runs with the orchestrator-tool deny list missing.
//
// Cold resume: the applied sections/restrictions are runtime state of one
// agent incarnation, so a host restart loses them. Every spawn therefore also
// writes a `delegate/spawn` fact on the shared audit channel (the cold-safe
// channel — never a custom session event type, S13) and this listener replays
// the composition for a resumed child whose fact is still in the audit tail.
// Missing fact: persona/allow-lists degrade fail-open (same posture as the
// supervision rebuild), while the orchestrator-tool deny floor is still applied
// whenever the child is attributable to a weir-managed parent session.
import { AUDIT_TYPES, AUDIT_SUBTYPES } from '../shared/audit.js'
import { auditFilePathOf, readAuditTail } from '../shared/terminal-evidence.js'
import { CHILD_DENY_TOOLS, childToolFilter } from '../shared/child-scope.js'

/** The spawn-fact event type; matches the AUDIT_TYPES/AUDIT_SUBTYPES registry. */
export const SPAWN_FACT_TYPE = `weir/${AUDIT_TYPES.delegate}/${AUDIT_SUBTYPES.delegate[0]}`

/** Deployment persona prefix section (dsh-system-prompt / dsh-persona contract). */
const PERSONA_PREFIX_SECTION = 'deployment:persona-prefix'
const PERSONA_PREFIX_ORDER = 'DEPLOYMENT_PERSONA_PREFIX'

/**
 * @typedef {object} SpawnComposition
 * @property {string} [childId]
 * @property {string} [lane] - one of 'one-shot' | 'continuable' | 'supervised'
 * @property {string} [label]
 * @property {string} persona - full persona text applied as the child's prefix section
 * @property {{ allow?: string[], deny?: string[] }} [toolFilter] - requested child tool filter
 */

/**
 * Mount the composition listener on one plugin ctx.
 * @param {object} deps
 * @param {any} deps.ctx - plugin context (on / tools)
 * @param {(session: object | null, type: string, data?: unknown) => void} deps.audit - createAudit sink
 * @param {{ warn?: (message: string) => void }} [deps.logger]
 * @param {() => Set<string> | undefined} [deps.restrictableNames] - fallback composition view
 * @param {(fact: { session?: object | null, childId: string, lane?: string }) => void} [deps.onSpawn] - live spawn-fact sink (supervision catalog cross-check)
 * @returns {{ beginSpawn: (composition: SpawnComposition & { session?: object | null }) => { outcome: () => { ok: boolean, error?: Error }, forget: () => void }, dispose: () => void }}
 */
export function createChildComposition({ ctx, audit, logger, restrictableNames, onSpawn }) {
  /** @type {Map<string, { session: object | null, childId: string, lane: string, label: string, persona: string, toolFilter?: object, applied: boolean, error?: Error }>} */
  const pending = new Map()

  /**
   * Reserve one composition and write its cold-safe spawn fact. Called
   * synchronously BEFORE startActivation: the child's creation window runs
   * inside that call, so the entry is always present when the listener fires.
   * @param {SpawnComposition & { session?: object | null }} composition
   */
  function beginSpawn(composition) {
    const entry = {
      session: composition.session ?? null,
      childId: composition.childId,
      lane: composition.lane ?? 'one-shot',
      label: composition.label ?? '',
      persona: composition.persona ?? '',
      toolFilter: composition.toolFilter,
      applied: false,
      error: undefined,
    }
    pending.set(entry.childId, entry)
    // Audit mirrors the fact to <cwd>/.weir/audit.jsonl (cold-safe replay) and
    // emits it in-process. Never throws.
    const fact = {
      childId: entry.childId,
      lane: entry.lane,
      label: entry.label,
      persona: entry.persona,
      ...(entry.toolFilter ? { toolFilter: entry.toolFilter } : {}),
    }
    audit(entry.session, SPAWN_FACT_TYPE, fact)
    // Live consumers (the supervision catalog cross-check) see the same fact
    // without re-reading the file.
    try {
      onSpawn?.({ session: entry.session, childId: entry.childId, lane: entry.lane })
    } catch {
      // a live sink failure must never break the spawn
    }
    return {
      outcome: () => (entry.applied
        ? { ok: true }
        : {
            ok: false,
            error: entry.error ?? new Error(`child "${entry.childId}": the composition was not applied inside the creation window`),
          }),
      forget: () => {
        if (pending.get(entry.childId) === entry) pending.delete(entry.childId)
      },
    }
  }

  /** Apply a composition to one live child agent (throws on any failure). */
  function apply(agent, composition) {
    const systemPrompt = agent?.ctx?.systemPrompt
    const tools = agent?.ctx?.tools
    if (typeof composition.persona === 'string' && composition.persona.length > 0) {
      if (typeof systemPrompt?.section !== 'function') {
        throw new Error('the child agent exposes no systemPrompt service')
      }
      // Same section name the deployment/preset persona uses, so the child's
      // own layer shadows it instead of duplicating a prompt paragraph.
      systemPrompt.section({
        name: PERSONA_PREFIX_SECTION,
        order: systemPrompt.getSectionOrder(PERSONA_PREFIX_ORDER),
        text: composition.persona,
      })
    }
    const filter = composition.toolFilter
    if (!filter) return
    if (typeof tools?.restrict !== 'function') {
      // An allow filter with no restriction channel would silently widen the
      // child surface; the deny list is the safety floor. Fail closed.
      throw new Error('the child agent exposes no tools service')
    }
    // tools.restrict() rejects unknown deny/allow names, so the deny list is
    // merged against the CHILD scope's restrictable set (the composition's own
    // view is only a fallback). childToolFilter keeps the existing merge
    // semantics: allow-list filters pass through, every other filter gets
    // CHILD_DENY_TOOLS intersected in, so the orchestrator-tool deny never
    // degrades with the requested filter. The final deny list is then
    // intersected with that same child set: a name the child scope never
    // registered needs no deny (it is absent either way) and naming it would
    // make restrict() throw.
    const known = restrictableNamesOf(agent) ?? restrictableNames?.()
    const merged = childToolFilter(filter, known)
    const deny = Array.isArray(merged.deny) && known ? merged.deny.filter((name) => known.has(name)) : merged.deny
    const effective = deny === merged.deny ? merged : { ...merged, deny }
    const hasAllow = effective.allow !== undefined
    const hasDeny = Array.isArray(effective.deny) && effective.deny.length > 0
    if (!hasAllow && !hasDeny) return
    tools.restrict(effective)
  }

  /** Resolve the child scope's restrictable tool names (undefined when unavailable). */
  function restrictableNamesOf(agent) {
    try {
      const view = agent?.ctx?.tools?.view?.(agent)
      if (view?.restrictableNames instanceof Set) return view.restrictableNames
    } catch {
      // view() failures fall back to the composition view
    }
    return undefined
  }

  /**
   * Replay the composition of a cold-resumed child from the audit tail.
   * @param {any} agent
   * @param {object} header - the child session header
   */
  function replayFromAudit(agent, header) {
    const file = auditFilePathOf(agent.session)
    const records = readAuditTail(file)
    if (records.length === 0) return
    let fact
    let parentManaged = false
    for (const record of records) {
      if (!record || typeof record !== 'object') continue
      if (record.session !== header.parentSession) continue
      if (typeof record.type !== 'string' || !record.type.startsWith('weir/')) continue
      parentManaged = true
      if (record.type === SPAWN_FACT_TYPE && record.data?.childId === agent.id) fact = record.data
    }
    if (!parentManaged) return // not a weir-managed parent session: not our child
    if (!fact) {
      // Degraded: the spawn fact aged out of the tail (or the audit channel was
      // unavailable). Persona and allow-lists stay unapplied, but the
      // orchestrator-tool deny floor never does.
      logger?.warn?.(`weir-delegate: child "${agent.id}" has no delegate/spawn fact in the audit tail — replaying the static orchestrator-tool deny floor only`)
      applyDenyFloor(agent)
      return
    }
    try {
      apply(agent, fact)
    } catch (error) {
      logger?.warn?.(`weir-delegate: child "${agent.id}" composition replay failed (fail-open): ${String(error?.message ?? error)}`)
      applyDenyFloor(agent)
    }
  }

  /** Apply only the static orchestrator-tool deny floor (best-effort, warns). */
  function applyDenyFloor(agent) {
    try {
      const known = restrictableNamesOf(agent) ?? restrictableNames?.()
      const deny = known ? CHILD_DENY_TOOLS.filter((name) => known.has(name)) : [...CHILD_DENY_TOOLS]
      if (deny.length === 0) return
      agent.ctx.tools.restrict({ deny })
    } catch (error) {
      logger?.warn?.(`weir-delegate: child "${agent.id}" deny-floor application failed: ${String(error?.message ?? error)}`)
    }
  }

  /**
   * `agent/created` listener. A failure on the fresh-spawn path is thrown so
   * the spawn call itself rejects (the runtime disposes the unpublished child
   * after a rejected creation announcement); the recorded verdict lets the
   * spawn's own fail-closed branch also catch a listener that never ran.
   */
  function onAgentCreated(payload) {
    const agent = payload?.agent
    const header = agent?.session?.header
    if (!header) return
    if ((header.delegationDepth ?? 0) < 1) return
    const childId = agent.id
    const entry = pending.get(childId)
    if (entry) {
      pending.delete(childId)
      try {
        apply(agent, entry)
        entry.applied = true
      } catch (error) {
        entry.error = compositionError(childId, error)
        throw entry.error
      }
      return
    }
    replayFromAudit(agent, header)
  }

  const off = ctx.on('agent/created', onAgentCreated)

  return {
    beginSpawn,
    dispose: () => {
      pending.clear()
      off?.()
    },
  }
}

/** Wrap one composition failure with the delegate-facing cause. */
function compositionError(childId, error) {
  const wrapped = new Error(`delegate: failed to apply the child composition for "${childId}" — ${String(error?.message ?? error)}`)
  wrapped.cause = error
  return wrapped
}
