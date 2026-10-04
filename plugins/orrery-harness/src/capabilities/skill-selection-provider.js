import { readFile, realpath } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { createSkillIdentity, skillIdentityKey } from './skill-identity.js'
import { parseSkillText } from './frontmatter.js'

export const SELECTION_PROVIDER = 'orrery-selected'
const message = error => error instanceof Error ? error.message : String(error)

/** Validate explicit identities, never names. Conflicts reject the entire Apply. */
export function validateSkillSelection(identities) {
  if (!Array.isArray(identities)) throw new TypeError('Selected skills must be an identity array')
  const unique = new Map(identities.map(identity => {
    const value = createSkillIdentity(identity)
    return [skillIdentityKey(value), value]
  }))
  const names = new Map()
  for (const identity of unique.values()) {
    const group = names.get(identity.name) ?? []
    group.push(identity)
    names.set(identity.name, group)
  }
  return {
    identities: [...unique.values()],
    conflicts: [...names].filter(([, items]) => items.length > 1).map(([name, identities]) => ({ name, identities })),
  }
}

/**
 * Orrery-owned identity selection. The host registry still resolves get by name.
 * readSelection(options) returns identities; inventory(options, previous) returns
 * the raw Orrery inventory. No host merged catalog is used as an inventory.
 * acceptSelection is an in-memory publication hook AFTER durable Apply succeeds;
 * it does not write policy. Call validateSkillSelection before committing policy.
 */
export function createSkillSelectionProvider({ control, readSelection, inventory, denials = () => [], fs = { readFile, realpath } }) {
  const states = new Map()
  let emitting = false
  let scheduled
  let disposed = false
  const keyOf = options => JSON.stringify([options.scope?.session?.id ?? null, options.cwd ?? null])
  const stateOf = options => {
    const key = keyOf(options)
    if (!states.has(key)) states.set(key, { options, selected: null, snapshot: null, result: null, pending: null, epoch: 0, error: null, conflicts: [] })
    return states.get(key)
  }
  const invalidate = () => {
    if (disposed) return
    emitting = true
    try { control.invalidate() } finally { emitting = false }
  }
  const clear = state => { state.epoch++; state.result = null }
  async function collect(state) {
    if (disposed) return { candidates: denials(), complete: false }
    if (state.result) return state.result
    if (state.pending) return state.pending
    const epoch = state.epoch
    state.pending = (async () => {
      try {
        const selection = validateSkillSelection(state.selected ?? await readSelection(state.options))
        state.conflicts = selection.conflicts
        if (selection.conflicts.length) throw new Error('Selected skill names conflict; explicit resolution is required')
        if (!selection.identities.length) {
          state.error = null
          if (epoch !== state.epoch) return { candidates: denials(), complete: false }
          state.result = { candidates: denials(), complete: true }
          return state.result
        }
        const snapshot = await inventory(state.options, state.snapshot)
        state.snapshot = snapshot
        const selected = new Set(selection.identities.map(skillIdentityKey))
        const matches = snapshot.candidates.filter(candidate => candidate.status === 'parsed' && selected.has(skillIdentityKey(candidate.identity)))
        // Missing, ambiguous or stale inventory cannot authorize a substitute.
        if (!snapshot.complete || matches.length !== selected.size || new Set(matches.map(c => skillIdentityKey(c.identity))).size !== matches.length) {
          throw new Error('Selected skill inventory is missing, ambiguous or incomplete')
        }
        const candidates = [...matches.map(candidate => ({ ...candidate, provider: SELECTION_PROVIDER })),
          ...denials().filter(candidate => !matches.some(match => match.name === candidate.name))]
        state.error = null
        if (epoch !== state.epoch) return { candidates: denials(), complete: false }
        state.result = { candidates, complete: true }
        return state.result
      } catch (error) {
        state.error = message(error)
        return { candidates: denials(), complete: false }
      }
    })().finally(() => { state.pending = null })
    return state.pending
  }
  const provider = {
    name: SELECTION_PROVIDER,
    list: (options = {}) => collect(stateOf(options)),
    async get(candidate, options = {}) {
      const state = stateOf(options)
      try {
        if (!candidate.identity) return undefined
        const epoch = state.epoch
        const current = (await collect(state)).candidates.find(item => item.identity && skillIdentityKey(item.identity) === skillIdentityKey(candidate.identity))
        if (!current || epoch !== state.epoch || disposed) return undefined
        if (current.load) {
          const loaded = await current.load(options)
          if (!loaded || loaded.name !== current.name || epoch !== state.epoch || disposed) return undefined
          return { ...loaded, provider: SELECTION_PROVIDER }
        }
        if (await fs.realpath(current.locator.path) !== current.path) throw new Error('Selected skill path changed')
        const raw = await fs.readFile(current.path, 'utf8')
        if (createHash('sha256').update(raw).digest('hex') !== current.digest) throw new Error('Selected skill content changed; refresh required')
        const parsed = parseSkillText(raw)
        if (parsed.name !== current.identity.name || epoch !== state.epoch || disposed) return undefined
        return { ...parsed, provider: SELECTION_PROVIDER, source: current.source, resourceBase: current.resourceBase }
      } catch (error) {
        state.error = message(error)
        clear(state)
        invalidate()
        return undefined
      }
    },
    status(options = {}) {
      const state = stateOf(options)
      return structuredClone({ error: state.error, conflicts: state.conflicts })
    },
    acceptSelection(identities, options = {}) {
      const state = stateOf(options)
      const selection = validateSkillSelection(identities)
      state.conflicts = selection.conflicts
      if (selection.conflicts.length) return { accepted: false, conflicts: structuredClone(selection.conflicts) }
      state.selected = selection.identities
      clear(state)
      invalidate()
      return { accepted: true, conflicts: [] }
    },
    // The host emits skills/change without a source. Ignore our synchronous echo
    // and coalesce each burst; enumerate lazily on the next list boundary.
    sourceChanged() {
      if (emitting || disposed || scheduled) return
      for (const state of states.values()) clear(state)
      scheduled = Promise.resolve().then(() => { scheduled = null })
      // Invalidate synchronously while every observer's burst guard is active;
      // deferring the emission would let multiple mounted providers ping-pong.
      invalidate()
    },
    dispose() { disposed = true; states.clear() },
  }
  control.signal?.addEventListener('abort', () => provider.dispose(), { once: true })
  return provider
}
