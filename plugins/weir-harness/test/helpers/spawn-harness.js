// DSH 0.2.1 spawn-surface test double shared by the delegate suites.
//
// 0.2.1 has ONE start entry: `subagents.startActivation(spec)`. The lanes differ
// only by `delivery` ('caller' for one-shot, 'parent' for continuable and
// supervised) and by the composition shim, which applies persona + tool filter
// from inside the child's `agent/created` window. This double reproduces that
// order faithfully:
//
//   1. reserve a deterministic child id (reserveChildId),
//   2. record the activation spec by delivery,
//   3. build a fake child agent whose composition application is observable,
//   4. dispatch the REAL composition listener with that agent (the runtime
//      announces agent/created before startActivation resolves),
//   5. return the SubagentActivation shape { childId, messageId, result, dispose }.
//
// Tests therefore assert on what the child actually received
// (`children[i].applied.sections/restrictions`) instead of on request fields
// that no longer exist.
import { createChildComposition } from '../../src/delegate/child-composition.js'
import { CHILD_DENY_TOOLS } from '../../src/shared/child-scope.js'

/** Tool names a headless-ish composition registers (the fake child's view). */
export const FAKE_RESTRICTABLE = new Set(['bash', 'read', 'write', 'edit', 'glob', 'grep', ...CHILD_DENY_TOOLS])

/**
 * Multi-listener event recorder used by every delegate harness: `ctx.on`
 * keeps EVERY listener per event (cordis semantics), and `handlers[event]`
 * dispatches all of them — one shared entry point tests can fire directly.
 * A synchronous listener throw propagates synchronously (the composition
 * fail-closed contract depends on it); async listeners are awaited through
 * the returned promise.
 * @returns {{ on: (event: string, handler: Function) => () => void, handlers: Record<string, Function> }}
 */
export function createHandlerRecorder() {
  /** @type {Record<string, Function[]>} */
  const listeners = {}
  const handlers = {}
  function refresh(event) {
    const list = listeners[event]
    if (!list || list.length === 0) {
      delete handlers[event]
      return
    }
    handlers[event] = (...args) => {
      const outcomes = list.map((handler) => handler(...args))
      return outcomes.some((outcome) => outcome && typeof outcome.then === 'function') ? Promise.all(outcomes) : undefined
    }
  }
  return {
    handlers,
    on(event, handler) {
      const list = listeners[event] ?? (listeners[event] = [])
      list.push(handler)
      refresh(event)
      return () => {
        const index = list.indexOf(handler)
        if (index >= 0) list.splice(index, 1)
        refresh(event)
      }
    },
  }
}

/**
 * Build one fake child agent whose composition application is observable.
 * @param {string} id
 * @param {{ restrictableNames?: Set<string>, onChild?: (child: object) => void }} [options]
 */
export function createFakeChildAgent(id, options = {}) {
  const known = options.restrictableNames ?? FAKE_RESTRICTABLE
  const applied = { sections: [], restrictions: [], guards: [] }
  const agent = {
    id,
    session: { header: { delegationDepth: 1, parentSession: 'parent-session', cwd: undefined } },
    ctx: {
      systemPrompt: {
        section: (section) => {
          applied.sections.push(section)
          return () => {}
        },
        getSectionOrder: () => 0,
      },
      tools: {
        view: () => ({ restrictableNames: known }),
        restrict: (filter) => {
          applied.restrictions.push(filter)
          return () => {}
        },
        guard: (fn) => {
          applied.guards.push(fn)
          return () => {}
        },
      },
    },
  }
  const child = { id, agent, applied, disposed: 0 }
  options.onChild?.(child)
  return child
}

/**
 * The `subagents` service double plus its observable recorders.
 * @param {object} [options]
 * @param {Record<string, Function>} [options.handlers] - the ctx.on recorder the agent/created dispatch uses
 * @param {(n: number) => string} [options.childIdFor] - deterministic reserved id per spawn (1-based)
 * @param {(spec: object) => object} [options.result] - SubagentResult factory per activation
 * @param {string} [options.label] - child id prefix; defaults to 'child'
 * @param {Set<string>} [options.restrictableNames] - the fake child's restrictable set
 * @param {(child: object) => void} [options.onChild] - mutate one fake child
 */
export function createSpawnSurface(options = {}) {
  const spawned = []
  const continued = []
  const interrupted = []
  const children = []
  const handlers = options.handlers ?? {}
  let sequence = 0
  const prefix = options.label ?? 'child'
  const childIdFor = options.childIdFor ?? ((n) => `${prefix}-${n}`)
  const resultOf = options.result ?? (() => ({ output: [{ type: 'text', text: 'done the thing' }], stopReason: 'completed' }))
  /** @type {Map<string, object>} */
  const agentsById = new Map()

  function makeChild(id) {
    const child = createFakeChildAgent(id, { restrictableNames: options.restrictableNames, onChild: options.onChild })
    agentsById.set(id, child.agent)
    children.push(child)
    return child
  }

  const subagents = {
    async startActivation(spec) {
      const record = { ...spec }
      if (spec.delivery === 'caller') spawned.push(record)
      else continued.push(record)
      const child = makeChild(spec.childId ?? childIdFor(++sequence))
      // The runtime announces agent/created inside the start call, before the
      // initial prompt is delivered — dispatch the real listener here.
      handlers['agent/created']?.({ agent: child.agent, source: 'startup' })
      return {
        childId: child.id,
        messageId: `msg-${child.id}`,
        result: Promise.resolve(resultOf(spec)),
        dispose: async () => {
          child.disposed += 1
          agentsById.delete(child.id)
        },
      }
    },
    interrupt(targetId, authority) {
      interrupted.push({ targetId, authority })
    },
  }

  return {
    subagents,
    spawned,
    continued,
    interrupted,
    children,
    handlers,
    agentsById,
    agents: { get: (id) => agentsById.get(id) },
    reserveChildId: () => childIdFor(++sequence),
  }
}

/**
 * A complete DelegateDeps double (spawn surface + real composition shim).
 * @param {object} [options] - createSpawnSurface options plus `deps` overrides
 */
export function createSpawnHarness(options = {}) {
  const recorder = createHandlerRecorder()
  const ctx = { on: recorder.on }
  const handlers = recorder.handlers
  const surface = createSpawnSurface({ ...options, handlers })
  const composition = createChildComposition({
    ctx,
    audit: () => {},
    logger: { warn: () => {} },
    restrictableNames: () => options.restrictableNames ?? FAKE_RESTRICTABLE,
  })
  const deps = {
    resolveTarget: async (item) => ({ persona: 'persona', label: item.name ?? 'child' }),
    loadSkill: async () => 'skill-body',
    subagents: surface.subagents,
    agents: surface.agents,
    reserveChildId: surface.reserveChildId,
    composition,
    ...options.deps,
  }
  return { ...surface, deps, composition, handlers }
}
