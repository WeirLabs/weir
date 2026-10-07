// Weir session blackboard kernel: the session-scoped in-memory entry store
// and the write-token arbitration state machine (design D1/D3,
// docs/features/blackboard.md). Pure: no ctx, no node: imports, no
// persistence, no session log — blackboard state never leaves this process
// and never enters a conversation (cold-read red line S13).
//
// One kernel instance serves every conversation board; a board is keyed by
// the top-level (root) session id and created lazily on the first access.
// Arbitration is the kernel's ONLY job (D8): apply grants a one-shot token
// with a TTL, write/delete consume it, expiry or an agent's termination
// releases it, and release events carry the subscriber ids so slice 2 can
// wire delivery. The kernel is concept-isomorphic to Edit Lock but shares
// none of its code: no persistence, no recovery, no cross-process story.

/** The closed entry-type taxonomy (D4); schema `enum` and runtime both pin it. */
export const ENTRY_TYPES = Object.freeze(['map', 'contract', 'deadend', 'wiring', 'recipe', 'why'])

/** The closed promotion destinations (slice 3): the durable documents a
 * promoted entry can land in. `discard` is NOT a destination — a discarded
 * entry is simply left unmarked on the board (editable, re-evaluable). */
export const PROMOTION_DESTINATIONS = Object.freeze(['docs/spikes.md', 'runtime-map', 'agents-pointer'])

/** Short ASCII identifier: letter/digit first, then letters, digits and . _ - / */
const KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,159}$/

/** Free-text summary cap; the detail belongs in content. */
const SUMMARY_MAX_LENGTH = 500

/**
 * Validate one entryType against the closed enum. Throws on anything else:
 * the enum is the mechanism, the error names it (D4).
 * @param {unknown} entryType
 * @returns {string} the validated value
 */
export function validateEntryType(entryType) {
  if (typeof entryType !== 'string' || !ENTRY_TYPES.includes(entryType)) {
    throw new Error(`blackboard: entryType must be one of: ${ENTRY_TYPES.join(', ')} (got ${JSON.stringify(entryType)})`)
  }
  return entryType
}

/**
 * Validate one promotion destination against the closed set. Throws on
 * anything else, naming the set (the enum is the mechanism).
 * @param {unknown} destination
 * @returns {string} the validated value
 */
export function validatePromotionDestination(destination) {
  if (typeof destination !== 'string' || !PROMOTION_DESTINATIONS.includes(destination)) {
    throw new Error(`blackboard: destination must be one of: ${PROMOTION_DESTINATIONS.join(', ')} (got ${JSON.stringify(destination)})`)
  }
  return destination
}

/**
 * Validate and normalize a free-text summary: one or two sentences, no
 * enforced inner structure (the fact/cost/re-verify guidance lives in the
 * tool description as writing advice, not schema — UX refinement: the
 * structured triple was too fine-grained and less generic than the original
 * summary + content two-layer design).
 * @param {unknown} summary
 * @returns {string} the normalized summary
 */
export function validateSummary(summary) {
  if (typeof summary !== 'string' || summary.trim().length === 0) {
    throw new Error('blackboard: summary must be a non-empty free-text string (one or two sentences; keep the detail in content)')
  }
  const trimmed = summary.trim()
  if (trimmed.length > SUMMARY_MAX_LENGTH) {
    throw new Error(`blackboard: summary must be at most ${SUMMARY_MAX_LENGTH} characters (got ${trimmed.length}); keep the detail in content`)
  }
  return trimmed
}

/**
 * Validate a board key: a short ASCII identifier, never a classification
 * carrier (identity and taxonomy are decoupled, D4).
 * @param {unknown} key
 * @returns {string} the validated key
 */
export function validateKey(key) {
  if (typeof key !== 'string' || key.trim().length === 0) throw new Error('blackboard: key must be a non-empty string')
  if (!KEY_PATTERN.test(key)) {
    throw new Error(`blackboard: key must be a short ASCII identifier starting with a letter or digit (allowed: letters, digits, . _ - /), got ${JSON.stringify(key)}`)
  }
  return key
}

/**
 * Create a blackboard kernel.
 * @param {object} [dependencies] test seams
 * @param {() => number} [dependencies.now] clock (default Date.now)
 * @param {(fn: () => void, ms: number) => unknown} [dependencies.setTimer] timer arming (default setTimeout, unref'd)
 * @param {(handle: unknown) => void} [dependencies.clearTimer] timer disarming
 */
export function createBlackboardKernel({ now = Date.now, setTimer, clearTimer } = {}) {
  const arm = setTimer ?? ((/** @type {() => void} */ fn, /** @type {number} */ ms) => {
    const handle = globalThis.setTimeout(fn, Math.min(ms, 2 ** 31 - 1))
    ;/** @type {any} */ (handle)?.unref?.()
    return handle
  })
  const disarm = clearTimer ?? ((/** @type {any} */ handle) => globalThis.clearTimeout(handle))

  /** @type {Map<string, { entries: Map<string, object>, tokens: Map<string, object>, subscribers: Map<string, Set<string>> }>} */
  const boards = new Map()
  /** @type {Set<(event: object) => void>} release listeners (slice 2 delivery wiring) */
  const listeners = new Set()

  /** @param {string} boardId @returns {any} the board, created lazily */
  function board(boardId) {
    if (typeof boardId !== 'string' || boardId.length === 0) throw new Error('blackboard: session identity unavailable')
    let state = boards.get(boardId)
    if (!state) {
      state = { entries: new Map(), tokens: new Map(), subscribers: new Map() }
      boards.set(boardId, state)
    }
    return state
  }

  /**
   * Deliver one release event to every registered listener. Delivery is
   * best-effort and NEVER breaks arbitration; events only fire when someone
   * actually waits (subscriberIds non-empty) so slice 2 gets a signal, not
   * noise.
   * @param {object} event
   */
  function fireRelease(event) {
    if (!Array.isArray(event.subscriberIds) || event.subscriberIds.length === 0) return
    for (const listener of listeners) {
      try { listener(event) } catch { /* a delivery failure must never break the kernel */ }
    }
  }

  /**
   * Release one key's token and notify its subscribers. Subscriptions are
   * one-shot: the notification consumes them.
   * @param {any} state @param {string} boardId @param {string} key
   * @param {string} holder @param {'write'|'delete'|'expire'|'terminate'} reason @param {number} at
   */
  function release(state, boardId, key, holder, reason, at) {
    const subscriberIds = [...(state.subscribers.get(key) ?? [])]
    state.subscribers.delete(key)
    fireRelease({ boardId, key, holder, reason, subscriberIds, at })
  }

  /**
   * Read-time settlement is authoritative (the Edit Lock lesson): an expired
   * token is released before ANY decision reads the key, so a lost or delayed
   * timer can delay delivery but never change an outcome.
   * @param {string} boardId @param {string} key @param {number} at
   */
  function settle(boardId, key, at) {
    const state = boards.get(boardId)
    const token = state?.tokens.get(key)
    if (!token || token.expiresAt > at) return
    state.tokens.delete(key)
    if (token.timer !== undefined) disarm(token.timer)
    release(state, boardId, key, token.holder, 'expire', at)
  }

  /**
   * Arm (or re-arm, replacing any existing token) the one-shot token for a key.
   * @param {any} state @param {string} boardId @param {string} key @param {string} holderId @param {number} ttlMs @param {number} at
   * @returns {number} the new expiry instant
   */
  function grant(state, boardId, key, holderId, ttlMs, at) {
    const previous = state.tokens.get(key)
    if (previous?.timer !== undefined) disarm(previous.timer)
    const expiresAt = at + ttlMs
    state.tokens.set(key, { key, holder: holderId, expiresAt, timer: arm(() => settle(boardId, key, now()), ttlMs) })
    return expiresAt
  }

  /** Consume the token a successful mutation spent. @param {any} state @param {string} boardId @param {string} key @param {'write'|'delete'} reason @param {number} at */
  function consume(state, boardId, key, reason, at) {
    const token = state.tokens.get(key)
    if (!token) return
    state.tokens.delete(key)
    if (token.timer !== undefined) disarm(token.timer)
    release(state, boardId, key, token.holder, reason, at)
  }

  /**
   * Keys similar to a would-be new key (case-insensitive containment either
   * way, both sides at least 4 characters — too short a fragment matches
   * everything). The apply hint is a mitigation for key-name drift, not a
   * gate: search-before-create discipline lives in the tool descriptions and
   * the injected write contract.
   * @param {any} state @param {string} key @returns {string[]} at most 8 existing keys
   */
  function similarKeys(state, key) {
    const needle = key.toLowerCase()
    const matches = []
    for (const existing of state.entries.keys()) {
      if (existing === key) continue
      const candidate = existing.toLowerCase()
      if (Math.min(candidate.length, needle.length) >= 4 && (candidate.includes(needle) || needle.includes(candidate))) matches.push(existing)
      if (matches.length >= 8) break
    }
    return matches
  }

  /**
   * The promoted read-only refusal: a promoted entry keeps its content and
   * counters forever, but every authority-bearing mutation is refused with
   * this explicit status (slice 3). Returns null for unmarked entries.
   * @param {any} state @param {string} key
   */
  function promotedRefusal(state, key) {
    const entry = state.entries.get(key)
    if (!entry?.promoted) return null
    return { status: 'promoted', key, destination: entry.promoted.destination, promotedAt: entry.promoted.at }
  }

  return Object.freeze({
    /**
     * Register a release listener (slice 2 wires notification delivery here).
     * Returns the unregister function.
     * @param {(event: { boardId: string, key: string, holder: string, reason: 'write'|'delete'|'expire'|'terminate', subscriberIds: string[], at: number }) => void} listener
     */
    onRelease(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },

    /**
     * Aggregate rows: key + entryType + summary + usage counts, NEVER content
     * (D2 — progressive disclosure is enforced by this shape, not by prompts).
     * @param {string} boardId @param {{ query?: string, entryType?: string }} [filter]
     */
    list(boardId, filter = {}) {
      const state = board(boardId)
      const query = typeof filter.query === 'string' && filter.query.trim().length > 0 ? filter.query.trim().toLowerCase() : null
      const entryType = filter.entryType === undefined ? null : validateEntryType(filter.entryType)
      const rows = []
      for (const entry of state.entries.values()) {
        if (entryType !== null && entry.entryType !== entryType) continue
        if (query !== null) {
          const haystack = `${entry.key} ${entry.summary}`.toLowerCase()
          if (!haystack.includes(query)) continue
        }
        rows.push({
          key: entry.key, entryType: entry.entryType, summary: entry.summary,
          readCount: entry.readCount, subscribeCount: entry.subscribeCount,
          createdAt: entry.createdAt, updatedAt: entry.updatedAt,
          ...(entry.promoted ? { promoted: { destination: entry.promoted.destination, at: entry.promoted.at } } : {}),
        })
      }
      rows.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
      return rows
    },

    /**
     * Batch content read. Unknown keys are values, not errors.
     * `count` defaults to true (agent tool reads are usage evidence, D5);
     * the panel's audit views pass { count: false } — a user inspecting an
     * entry is auditing, not reusing, and must not move the count.
     * @param {string} boardId @param {string[]} keys @param {{ count?: boolean }} [options]
     */
    read(boardId, keys, { count = true } = {}) {
      if (!Array.isArray(keys) || keys.length === 0) throw new Error('blackboard: keys must be a non-empty array of key strings')
      const state = board(boardId)
      const found = []
      const missing = []
      for (const raw of keys) {
        const key = validateKey(raw)
        const entry = state.entries.get(key)
        if (!entry) { missing.push(key); continue }
        if (count) entry.readCount += 1
        found.push({
          key, entryType: entry.entryType, summary: entry.summary, content: entry.content,
          readCount: entry.readCount, subscribeCount: entry.subscribeCount,
          createdAt: entry.createdAt, updatedAt: entry.updatedAt,
          ...(entry.promoted ? { promoted: { destination: entry.promoted.destination, at: entry.promoted.at } } : {}),
        })
      }
      return { found, missing }
    },

    /**
     * Acquire the one-shot write token for a key. A key another agent holds
     * FAILS and auto-subscribes the caller (contended); a key the caller
     * already holds is renewed (self-apply has no contention cost). Expired
     * tokens are settled first, so apply never waits on a dead token.
     * @param {string} boardId
     * @param {{ holderId: string, key: string, ttlMs: number }} request
     */
    apply(boardId, { holderId, key, ttlMs }, at = now()) {
      if (typeof holderId !== 'string' || holderId.length === 0) throw new Error('blackboard: session identity unavailable')
      key = validateKey(key)
      if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('blackboard: ttlMs must be a positive number')
      const state = board(boardId)
      settle(boardId, key, at)
      const promoted = promotedRefusal(state, key)
      if (promoted) return promoted
      const token = state.tokens.get(key)
      if (token && token.holder !== holderId) {
        const subscribers = state.subscribers.get(key) ?? new Set()
        subscribers.add(holderId)
        state.subscribers.set(key, subscribers)
        const entry = state.entries.get(key)
        if (entry) entry.subscribeCount += 1
        return { status: 'contended', key, holder: token.holder, expiresAt: token.expiresAt, ttlMs, subscribed: true }
      }
      const renewed = token !== undefined
      const expiresAt = grant(state, boardId, key, holderId, ttlMs, at)
      const entry = state.entries.get(key)
      return { status: 'granted', key, holder: holderId, expiresAt, ttlMs, renewed, similarKeys: entry ? [] : similarKeys(state, key) }
    },

    /**
     * Create or update an entry. Update requires the caller's live token;
     * create acquires the token for the new key inside the same call (设计:
     * 创建即对新键先取得写入权). The mutation consumes the token (one-shot).
     * @param {string} boardId
     * @param {{ holderId: string, key: string, entryType: string, summary: string, content: string, ttlMs: number }} request
     */
    write(boardId, { holderId, key, entryType, summary, content, ttlMs }, at = now()) {
      if (typeof holderId !== 'string' || holderId.length === 0) throw new Error('blackboard: session identity unavailable')
      key = validateKey(key)
      validateEntryType(entryType)
      const normalized = validateSummary(summary)
      if (typeof content !== 'string' || content.trim().length === 0) throw new Error('blackboard: content must be a non-empty string')
      if (typeof ttlMs !== 'number' || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('blackboard: ttlMs must be a positive number')
      const state = board(boardId)
      settle(boardId, key, at)
      const existing = state.entries.get(key)
      if (existing) {
        const promoted = promotedRefusal(state, key)
        if (promoted) return promoted
      }
      if (!existing) {
        const token = state.tokens.get(key)
        if (token && token.holder !== holderId) {
          const subscribers = state.subscribers.get(key) ?? new Set()
          subscribers.add(holderId)
          state.subscribers.set(key, subscribers)
          return { status: 'contended', key, holder: token.holder, expiresAt: token.expiresAt, subscribed: true }
        }
        grant(state, boardId, key, holderId, ttlMs, at)
        state.entries.set(key, { key, entryType, summary: normalized, content, readCount: 0, subscribeCount: 0, revision: 1, createdAt: at, updatedAt: at })
        const revision = 1
        consume(state, boardId, key, 'write', at)
        return { status: 'created', key, entryType, revision }
      }
      const token = state.tokens.get(key)
      if (!token || token.holder !== holderId) {
        return { status: 'no-authority', key, holder: token?.holder ?? null, expiresAt: token?.expiresAt ?? null }
      }
      // Usage counts are entry-lifetime evidence (D5): an update replaces the
      // payload but preserves the counters and the creation instant.
       const revision = (existing.revision ?? 1) + 1
       state.entries.set(key, { ...existing, entryType, summary: normalized, content, revision, updatedAt: at })
      consume(state, boardId, key, 'write', at)
       return { status: 'updated', key, entryType, revision }
    },

    /**
     * Delete an entry. Requires the caller's live token; consumes it and
     * notifies subscribers (unlock/delete release the waiters, design D3).
     * @param {string} boardId @param {{ holderId: string, key: string }} request
     */
    deleteKey(boardId, { holderId, key }, at = now()) {
      if (typeof holderId !== 'string' || holderId.length === 0) throw new Error('blackboard: session identity unavailable')
      key = validateKey(key)
      const state = board(boardId)
      settle(boardId, key, at)
      if (!state.entries.has(key)) return { status: 'missing', key }
      const promoted = promotedRefusal(state, key)
      if (promoted) return promoted
      const token = state.tokens.get(key)
      if (!token || token.holder !== holderId) {
        return { status: 'no-authority', key, holder: token?.holder ?? null, expiresAt: token?.expiresAt ?? null }
      }
      state.entries.delete(key)
      consume(state, boardId, key, 'delete', at)
      return { status: 'deleted', key }
    },

    /**
     * Mark one entry promoted to a durable document (slice 3): records the
     * destination + timestamp on the entry and makes it read-only — apply,
     * write and delete refuse it with the explicit promoted status while
     * read/subscribe counts keep accumulating (the in-session references
     * must never break). Marking twice reports the existing marker; the
     * content payload is never touched, so no write token is required — the
     * decision to promote belongs to the user, executed by the main agent.
     * @param {string} boardId
     * @param {{ key: string, destination: string }} request
     */
    markPromoted(boardId, { key, destination }, at = now()) {
      key = validateKey(key)
      destination = validatePromotionDestination(destination)
      const state = board(boardId)
      const existing = state.entries.get(key)
      if (!existing) return { status: 'missing', key }
      if (existing.promoted) return { status: 'already-promoted', key, destination: existing.promoted.destination, promotedAt: existing.promoted.at }
      existing.promoted = { destination, at }
      return { status: 'promoted', key, destination, promotedAt: at }
    },

    /**
     * The terminate path (design D3): release every token one agent holds,
     * across all boards. Idempotent; notifications fire once per key.
     * @param {string} holderId
     * @returns {Array<{ boardId: string, key: string, holder: string, reason: 'terminate', subscriberIds: string[], at: number }>}
     */
    releaseHolder(holderId, at = now()) {
      if (typeof holderId !== 'string' || holderId.length === 0) return []
      const released = []
      for (const [boardId, state] of boards) {
        for (const [key, token] of [...state.tokens]) {
          if (token.holder !== holderId) continue
          state.tokens.delete(key)
          if (token.timer !== undefined) disarm(token.timer)
          released.push({ boardId, key, holder: holderId, reason: 'terminate', subscriberIds: [...(state.subscribers.get(key) ?? [])], at })
          state.subscribers.delete(key)
        }
      }
      for (const event of released) fireRelease(event)
      return released
    },

    /** The conversation ended: clear the board and disarm every timer. @param {string} boardId */
    dropBoard(boardId) {
      const state = boards.get(boardId)
      if (!state) return
      for (const token of state.tokens.values()) if (token.timer !== undefined) disarm(token.timer)
      boards.delete(boardId)
    },

    /** Full entries incl. content and counts (panel/promotion views, slice 2/3). @param {string} boardId */
    entriesOf(boardId) {
      const state = boards.get(boardId)
      return state ? [...state.entries.values()].map(entry => ({ ...entry, summary: { ...entry.summary } })) : []
    },

    /** Live tokens: { key, holder, expiresAt }. @param {string} boardId */
    tokensOf(boardId) {
      const state = boards.get(boardId)
      return state ? [...state.tokens.values()].map(token => ({ key: token.key, holder: token.holder, expiresAt: token.expiresAt })) : []
    },

    /** Live subscriptions: { key, subscriberIds }. @param {string} boardId */
    subscriptionsOf(boardId) {
      const state = boards.get(boardId)
      return state ? [...state.subscribers.entries()].map(([key, subscriberIds]) => ({ key, subscriberIds: [...subscriberIds] })) : []
    },
  })
}
