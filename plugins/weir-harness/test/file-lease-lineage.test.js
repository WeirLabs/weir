import { describe, expect, it } from './helpers.js'
import { createLineageResolver } from '../src/file-lease/lineage.js'

// The lineage rule (design D9): a root session is its own lineage, and a
// delegated child inherits its initiator's. Same chain ⇒ never a conflict;
// different chains ⇒ ordinary conflict. The resolver is pure, read-only against
// the sessions registry, and total (no input makes it throw).

/**
 * A sessions registry with just the surface the resolver may touch.
 * @param {Record<string, any>} headers session id → header
 */
function registry(headers) {
  const map = new Map(Object.entries(headers).map(([id, header]) => [id, { id, header }]))
  return {
    map,
    get(id) {
      return map.get(id)
    },
    set(id, header) {
      map.set(id, { id, header })
    },
    delete(id) {
      map.delete(id)
    },
  }
}

/** @param {string} id @param {any} [extra] */
function root(id, extra = {}) {
  return { id, delegationDepth: 0, ...extra }
}

/** @param {string} id @param {string} parentSession @param {number} [depth] @param {any} [extra] */
function child(id, parentSession, depth = 1, extra = {}) {
  return { id, parentSession, delegationDepth: depth, ...extra }
}

/** @param {any} header */
function agentFor(header) {
  return { session: { id: header.id, header } }
}

describe('file-lease lineage: inheritance (D9)', () => {
  it('makes a root session its own lineage', () => {
    const sessions = registry({ root: root('root') })
    const resolver = createLineageResolver({ sessions })
    expect(resolver.lineageOf(agentFor(root('root')))).toBe('root')
  })

  it('falls back to the session id when the header carries none', () => {
    const resolver = createLineageResolver({ sessions: registry({}) })
    // A header without an id still names a lineage: the session itself.
    expect(resolver.lineageOf({ session: { id: 'sess-1', header: { delegationDepth: 0 } } })).toBe('sess-1')
    // No header at all is a root too (the default depth is 0).
    expect(resolver.lineageOf({ session: { id: 'sess-2' } })).toBe('sess-2')
    // A resume/fork incarnation at depth 0 stays its own root even with a parent.
    expect(resolver.lineageOf(agentFor(root('fork-9', { parentSession: 'root' })))).toBe('fork-9')
  })

  it('gives a child and a grandchild the same lineage as the root', () => {
    const sessions = registry({
      root: root('root'),
      child: child('child', 'root', 1),
      grandchild: child('grandchild', 'child', 2),
    })
    const resolver = createLineageResolver({ sessions })
    expect(resolver.lineageOf(agentFor(child('child', 'root', 1)))).toBe('root')
    expect(resolver.lineageOf(agentFor(child('grandchild', 'child', 2)))).toBe('root')
    // Sibling subagents share it too — one orchestrated chain, one identity.
    expect(resolver.lineageOf(agentFor(child('sibling', 'root', 1)))).toBe('root')
  })

  it('degrades to the direct parent id when the parent session is unknown', () => {
    const sessions = registry({ orphan: child('orphan', 'vanished-root', 1) })
    const resolver = createLineageResolver({ sessions })
    expect(resolver.lineageOf(agentFor(child('orphan', 'vanished-root', 1)))).toBe('vanished-root')
    // Every descendant of the same missing session still shares one lineage.
    sessions.set('orphan-child', child('orphan-child', 'orphan', 2))
    expect(resolver.lineageOf(agentFor(child('orphan-child', 'orphan', 2)))).toBe('vanished-root')
  })

  it('keeps a child with no parent header on itself', () => {
    const resolver = createLineageResolver({ sessions: registry({}) })
    expect(resolver.lineageOf(agentFor({ id: 'loose', delegationDepth: 3 }))).toBe('loose')
  })

  it('stops after 16 hops instead of walking an unbounded chain', () => {
    /** @type {Record<string, any>} */
    const headers = { c0: root('c0') }
    for (let index = 1; index <= 20; index += 1) {
      headers[`c${index}`] = child(`c${index}`, `c${index - 1}`, index)
    }
    const resolver = createLineageResolver({ sessions: registry(headers) })
    const resolved = resolver.lineageOf(agentFor(headers.c20))
    // Sixteen hops up from c20 lands on c3: bounded, and never the root.
    expect(resolved).toBe('c3')
    expect(resolved).not.toBe('c0')
  })

  it('caches a complete resolution but never a degraded one', () => {
    const sessions = registry({ root: root('root'), child: child('child', 'root', 1) })
    const cache = new Map()
    const resolver = createLineageResolver({ sessions, cache })
    expect(resolver.lineageOf(agentFor(child('child', 'root', 1)))).toBe('root')
    // A cached answer survives the parent leaving the registry.
    sessions.delete('root')
    expect(resolver.lineageOf(agentFor(child('child', 'root', 1)))).toBe('root')

    // A degraded answer is NOT cached: once the parent loads, the root wins.
    const late = registry({ waiter: child('waiter', 'not-loaded-yet', 1) })
    const lateResolver = createLineageResolver({ sessions: late })
    expect(lateResolver.lineageOf(agentFor(child('waiter', 'not-loaded-yet', 1)))).toBe('not-loaded-yet')
    late.set('not-loaded-yet', root('real-root'))
    expect(lateResolver.lineageOf(agentFor(child('waiter', 'not-loaded-yet', 1)))).toBe('real-root')
  })

  it('never throws when the registry itself does', () => {
    const resolver = createLineageResolver({
      sessions: {
        get() {
          throw new Error('registry exploded')
        },
      },
    })
    expect(resolver.lineageOf(agentFor(child('child', 'root', 1)))).toBe('root')
    expect(resolver.lineageOf(agentFor(root('root')))).toBe('root')
    expect(resolver.lineageOf(undefined)).toBe('session')
  })
})

describe('file-lease lineage: labels', () => {
  it('prefers the session title, then the agent display name, then a generic noun', () => {
    const resolver = createLineageResolver({ sessions: registry({}) })
    expect(resolver.labelOf({ session: { header: { title: 'Lease rebuild' } }, displayName: 'orchestrator' })).toBe('Lease rebuild')
    expect(resolver.labelOf({ session: { header: {} }, displayName: 'orchestrator' })).toBe('orchestrator')
    expect(resolver.labelOf({ session: { header: {} }, name: 'reviewer' })).toBe('reviewer')
    expect(resolver.labelOf({ session: { header: {} } })).toBe('session')
    expect(resolver.labelOf(undefined)).toBe('session')
    expect(resolver.labelOf({ session: { header: { title: '   ' } }, name: 'reviewer' })).toBe('reviewer')
  })

  it('never leaks an absolute path', () => {
    const resolver = createLineageResolver({ sessions: registry({}) })
    const glued = resolver.labelOf({ session: { header: { title: '/Users/young/Documents/Orrery/plugins/weir-harness/src/a.js' } } })
    expect(glued).toBe('a.js')
    expect(glued.includes('/Users')).toBe(false)

    const embedded = resolver.labelOf({ session: { header: { title: 'Fix /Users/young/Documents/Orrery/src/a.js today' } } })
    expect(embedded.includes('/Users')).toBe(false)
    expect(embedded).toBe('Fix a.js today')

    const windows = resolver.labelOf({ session: { header: { title: 'C:\\Users\\ada\\project\\b.ts' } } })
    expect(windows).toBe('b.ts')

    const unc = resolver.labelOf({ displayName: '\\\\server\\share\\notes.md' })
    expect(unc).toBe('notes.md')

    // A slash inside an ordinary word is not a path and stays put.
    expect(resolver.labelOf({ session: { header: { title: 'fix/typo' } } })).toBe('fix/typo')
  })

  it('keeps labels to one short line', () => {
    const resolver = createLineageResolver({ sessions: registry({}) })
    const long = 'a'.repeat(200)
    const label = resolver.labelOf({ session: { header: { title: long } } })
    expect(label.length).toBe(60)
    expect(label.endsWith('…')).toBe(true)
    expect(resolver.labelOf({ session: { header: { title: 'first line\nsecond line' } } })).toBe('first line')
    expect(resolver.labelOf({ session: { header: { title: 'tab\there\u0007bell' } } })).toBe('tab here bell')
  })

  it('never throws on a hostile value', () => {
    const resolver = createLineageResolver({ sessions: registry({}) })
    const hostile = {
      get session() {
        throw new Error('nope')
      },
    }
    expect(resolver.labelOf(hostile)).toBe('session')
    expect(typeof resolver.labelOf({ displayName: 42 })).toBe('string')
  })
})
