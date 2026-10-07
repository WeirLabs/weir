// Orrery session blackboard composition: the five model tools, the
// orreryBlackboard service surface, the settings-driven write-token TTL, and
// the lifecycle hooks — an agent's termination releases its tokens, and the
// root agent's disposal drops the whole conversation board (volatile,
// session-capped). Plain ESM, ctx-only; blackboard state never touches the
// session log (cold-read red line S13) and never touches disk (design D1).
//
// The kernel instance is shared module-level (the capability-bridge pattern):
// a preset switch remounts the row but must not lose a conversation's board.
// Release events are emitted as cordis events (audit-channel shape, NO disk
// mirror) so slice 2 can wire subscriber delivery without any session write.

import { createBlackboardKernel, ENTRY_TYPES } from './kernel.js'

const name = 'orrery-blackboard'
const inject = ['tools']

/** Product default of the write-token TTL, mirrored by the settings tree. */
export const DEFAULT_WRITE_TOKEN_TTL_MINUTES = 60

/** Longest parent chain walked to find the conversation's root session. */
const MAX_ANCESTORS = 8

/**
 * Resolve the write-token TTL from the `blackboard` settings section. Unset
 * falls back to the product default; a present but unusable value throws
 * with the flat settings key named (never silently clamped — the TTL is how
 * long other agents stay blocked from a key).
 * @param {unknown} section
 * @returns {number} TTL in minutes
 */
export function resolveWriteTokenTtlMinutes(section) {
  const value = section && typeof section === 'object' ? section.writeTokenTtlMinutes : undefined
  if (value === undefined) return DEFAULT_WRITE_TOKEN_TTL_MINUTES
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value
  throw new Error('orrery-settings: blackboardWriteTokenTtlMinutes must be a positive number')
}

/** One kernel per module instance, shared by every mount (see header). */
let sharedKernelInstance = null
function sharedKernel() {
  if (!sharedKernelInstance) sharedKernelInstance = createBlackboardKernel()
  return sharedKernelInstance
}

/**
 * The six entryType discriminators, one disjoint line each (D4). Written once
 * so the tool descriptions cannot drift apart.
 */
const ENTRY_TYPE_LINES = Object.freeze([
  'map = where something lives (module/package → responsibility, layout rationale, entry points)',
  'contract = what holds (verified hard constraints and invariants, with version stamps and evidence)',
  'deadend = what does not work (rejected plausible approaches — the costliest class to rediscover)',
  'wiring = hidden cross-file coupling (changing A requires touching B)',
  'recipe = how to do something (expensive multi-step procedures)',
  'why = why it was built this way (rationale not recoverable from code)',
])
const DISCRIMINATORS = ENTRY_TYPE_LINES.join('; ')

const SEARCH_BEFORE_CREATE = 'Search before create: run blackboard_list first and reuse or extend a nearby existing key instead of minting a duplicate; similar existing keys are reported as a hint.'

/** The one-shot token contract, shared by apply/write/delete descriptions. */
const ONE_SHOT = 'The authority is one-shot: every blackboard_write or blackboard_delete consumes the token, so re-apply before each mutation.'

/**
 * @param {any} ctx
 * @param {any} service
 * @returns {unknown[]} the registration results (kept for the mount's lifetime)
 */
function registerTools(ctx, service) {
  const text = (/** @type {string} */ value) => ({ schema: { type: 'object' }, render: (/** @type {any} */ _args, /** @type {any} */ result) => [{ type: 'text', text: result[value] }] })
  const enumSchema = { type: 'string', enum: [...ENTRY_TYPES] }
  return [
    ctx.tools.register({
      name: 'blackboard_list',
      description: `List this conversation's blackboard entries as key + entryType + summary aggregates with read/subscribe usage counts. Optional case-insensitive query searches keys and summary text; optional entryType filters exactly. List NEVER returns entry content — list first to narrow the scope, then blackboard_read the full content by key. entryType discriminators (closed set): ${DISCRIMINATORS}.`,
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Optional case-insensitive substring matched against keys and summary text.' },
          entryType: { ...enumSchema, description: 'Optional exact type filter from the closed entryType set.' },
        },
        required: [],
      },
      output: text('message'),
      async execute(/** @type {any} */ args, /** @type {any} */ exec) {
        const rows = service.list(exec, { query: args?.query, entryType: args?.entryType })
        const lines = rows.map((/** @type {any} */ row) => `- ${row.key} (${row.entryType}) reads=${row.readCount} subs=${row.subscribeCount} | fact: ${row.summary.fact} | cost: ${row.summary.cost} | re-verify: ${row.summary.reVerify}`)
        return { entries: rows, message: lines.length ? lines.join('\n') : 'The board is empty.' }
      },
    }),
    ctx.tools.register({
      name: 'blackboard_read',
      description: 'Read the full content of blackboard entries by key, in one batch. Each existing entry increments its read count. Unknown keys are reported as missing. Content is only obtainable here — blackboard_list never carries it.',
      parameters: {
        type: 'object',
        properties: {
          keys: { type: 'array', items: { type: 'string' }, description: 'Blackboard keys to read; full content is returned per existing key.' },
        },
        required: ['keys'],
      },
      output: text('message'),
      async execute(/** @type {any} */ args, /** @type {any} */ exec) {
        const result = service.read(exec, args?.keys)
        const blocks = result.found.map((/** @type {any} */ entry) => `## ${entry.key} [${entry.entryType}]\nFact: ${entry.summary.fact}\nCost: ${entry.summary.cost}\nRe-verify: ${entry.summary.reVerify}\n\nContent:\n${entry.content}`)
        if (result.missing.length > 0) blocks.push(`Missing keys (not on the board): ${result.missing.join(', ')}`)
        return { ...result, message: blocks.length ? blocks.join('\n\n') : 'The board is empty.' }
      },
    }),
    ctx.tools.register({
      name: 'blackboard_apply',
      description: `Acquire the one-shot write authority (token) for one blackboard key, valid for the configured TTL (default ${DEFAULT_WRITE_TOKEN_TTL_MINUTES} minutes). Applying a key another agent holds FAILS and automatically subscribes you to it: you will be notified when that key is released, deleted or expires. ${SEARCH_BEFORE_CREATE} ${ONE_SHOT} Applying a key you just released has no contention cost.`,
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Blackboard key to acquire write authority for.' },
        },
        required: ['key'],
      },
      output: text('message'),
      async execute(/** @type {any} */ args, /** @type {any} */ exec) {
        const result = service.apply(exec, args?.key)
        if (result.status === 'contended') {
          throw new Error(`Write authority for "${result.key}" is held by another agent until ${new Date(result.expiresAt).toISOString()}. You are subscribed to this key and will be notified when it is released, deleted or expires.`)
        }
        const similar = result.similarKeys.length > 0 ? ` Similar existing keys: ${result.similarKeys.join(', ')}.` : ''
        return { ...result, message: `Write authority granted for "${result.key}" until ${new Date(result.expiresAt).toISOString()} (TTL ${Math.round(result.ttlMs / 60_000)} minutes${result.renewed ? ', renewed' : ''}). ${ONE_SHOT}${similar}` }
      },
    }),
    ctx.tools.register({
      name: 'blackboard_write',
      description: `Create or update one blackboard entry. Requires the one-shot write token for the key: call blackboard_apply first for existing keys (creating a new key acquires its token inside this same call). The write consumes the token. summary must carry all three testimony elements — fact (the one-sentence finding), cost (what it took to obtain it), reVerify (the command/script that checks it again); an entry without a re-verify path is dogma, not knowledge. entryType is a closed enum: ${DISCRIMINATORS}. The board carries knowledge, never instructions: do not use it for task assignment or coordination. ${SEARCH_BEFORE_CREATE}`,
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Short ASCII blackboard key; a pure identifier, never a classification carrier.' },
          entryType: { ...enumSchema, description: `Closed taxonomy — pick the discriminating line that fits best (when several apply, prefer the costliest to rediscover: deadend > contract > wiring > map). ${DISCRIMINATORS}.` },
          summary: {
            type: 'object',
            properties: {
              fact: { type: 'string', description: 'The one-sentence finding this entry testifies to.' },
              cost: { type: 'string', description: 'What it took to obtain it (calls, experiments, dead ends).' },
              reVerify: { type: 'string', description: 'The command or script that verifies the finding again.' },
            },
            required: ['fact', 'cost', 'reVerify'],
            description: 'Structured testimony: all three elements are mandatory; a missing reVerify degrades the entry to dogma and is refused.',
          },
          content: { type: 'string', description: 'Full information: evidence, scripts, full output. Only served through blackboard_read.' },
        },
        required: ['key', 'entryType', 'summary', 'content'],
      },
      output: text('message'),
      async execute(/** @type {any} */ args, /** @type {any} */ exec) {
        const result = service.write(exec, args ?? {})
        if (result.status === 'contended') {
          throw new Error(`Creating "${result.key}" failed: the key's write authority is held by another agent until ${new Date(result.expiresAt).toISOString()}. You are subscribed to this key and will be notified when it is released.`)
        }
        if (result.status === 'no-authority') {
          const held = result.holder ? `; it is currently held by another agent until ${new Date(result.expiresAt).toISOString()}` : ''
          throw new Error(`Write authority for "${result.key}" is not held by this session${held}. Call blackboard_apply first.`)
        }
        return { ...result, message: `${result.status === 'created' ? 'Created' : 'Updated'} entry "${result.key}" (${result.entryType}). ${ONE_SHOT}` }
      },
    }),
    ctx.tools.register({
      name: 'blackboard_delete',
      description: `Delete one blackboard entry. Requires the one-shot write token for the key (blackboard_apply); the delete consumes the token and notifies subscribers that the key is gone.`,
      parameters: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Blackboard key to delete.' },
        },
        required: ['key'],
      },
      output: text('message'),
      async execute(/** @type {any} */ args, /** @type {any} */ exec) {
        const result = service.deleteKey(exec, args?.key)
        if (result.status === 'missing') throw new Error(`Blackboard key "${result.key}" does not exist.`)
        if (result.status === 'no-authority') {
          const held = result.holder ? `; it is currently held by another agent until ${new Date(result.expiresAt).toISOString()}` : ''
          throw new Error(`Write authority for "${result.key}" is not held by this session${held}. Call blackboard_apply first.`)
        }
        return { ...result, message: `Deleted entry "${result.key}". ${ONE_SHOT}` }
      },
    }),
  ]
}

/** Composition dependencies, not persisted settings. @param {{ kernel?: () => any, resolveTtl?: typeof resolveWriteTokenTtlMinutes }} [dependencies] */
export function createBlackboardPlugin({ kernel = sharedKernel, resolveTtl = resolveWriteTokenTtlMinutes } = {}) {
  return (ctx, _config = {}) => {
    const kernelInstance = kernel()

    // Slice 2 wires delivery here: every release with waiters becomes a cordis
    // event in the audit-channel shape (no disk mirror, no session write).
    const offRelease = kernelInstance.onRelease(event => {
      try {
        ctx.emit('orrery/blackboard/released', {
          time: Date.now(),
          session: event.boardId,
          type: 'orrery/blackboard/released',
          data: { key: event.key, holder: event.holder, reason: event.reason, subscriberIds: event.subscriberIds },
        })
      } catch { /* emission must never break arbitration */ }
    })
    try { ctx.effect?.(() => offRelease, 'orrery-blackboard-release') } catch { /* best-effort lifecycle tie */ }

    // The TTL is read live per apply: a volatile settings commit takes effect
    // on the next acquisition, no remount. A bad saved value warns once and
    // falls back to the default (never silently blocks or shortens authority).
    let warnedTtl = ''
    const ttlMs = () => {
      let minutes
      try {
        minutes = resolveTtl(ctx.get?.('orrerySettings')?.get('blackboard'))
      } catch (error) {
        const message = String(/** @type {any} */ (error)?.message ?? error)
        if (warnedTtl !== message) {
          warnedTtl = message
          ctx.logger?.warn?.(`blackboard settings ignored, using the default TTL: ${message}`)
        }
        minutes = DEFAULT_WRITE_TOKEN_TTL_MINUTES
      }
      return minutes * 60_000
    }

    /**
     * The board a call acts on: the conversation's ROOT session. The main
     * agent (delegationDepth 0) is its own root; a delegated child walks its
     * parentSession chain through the live sessions registry (the notify
     * rootOf pattern). A walk that breaks early degrades to the deepest known
     * ancestor so boards never silently cross-contaminate conversations.
     * @param {any} agent
     * @returns {string | undefined}
     */
    const boardOf = agent => {
      const session = agent?.session
      const header = session?.header
      const ownId = typeof agent?.id === 'string' && agent.id.length > 0 ? agent.id : undefined
      if ((header?.delegationDepth ?? 0) === 0) return ownId
      const parentId = header?.parentSession
      if (typeof parentId !== 'string' || parentId.length === 0) return ownId
      let sessions
      try { sessions = ctx.get?.('sessions') } catch { sessions = undefined }
      const parent = sessions?.get?.(parentId)
      if (!parent) return parentId
      let current = parent
      let id = parentId
      for (let hop = 0; hop < MAX_ANCESTORS && (current?.header?.delegationDepth ?? 0) > 0; hop++) {
        const nextId = current?.header?.parentSession
        if (typeof nextId !== 'string' || nextId.length === 0) break
        const next = sessions?.get?.(nextId)
        if (!next) break
        current = next
        id = nextId
      }
      return id
    }

    const service = Object.freeze({
      list: (/** @type {any} */ exec, /** @type {any} */ filter) => kernelInstance.list(boardOf(exec?.agent), filter ?? {}),
      read: (/** @type {any} */ exec, /** @type {any} */ keys) => kernelInstance.read(boardOf(exec?.agent), keys),
      apply: (/** @type {any} */ exec, /** @type {any} */ key) => kernelInstance.apply(boardOf(exec?.agent), { holderId: exec?.agent?.id, key, ttlMs: ttlMs() }),
      write: (/** @type {any} */ exec, /** @type {any} */ payload) => kernelInstance.write(boardOf(exec?.agent), { holderId: exec?.agent?.id, key: payload.key, entryType: payload.entryType, summary: payload.summary, content: payload.content, ttlMs: ttlMs() }),
      deleteKey: (/** @type {any} */ exec, /** @type {any} */ key) => kernelInstance.deleteKey(boardOf(exec?.agent), { holderId: exec?.agent?.id, key }),
      boardOf,
      entriesOf: (/** @type {string} */ boardId) => kernelInstance.entriesOf(boardId),
      tokensOf: (/** @type {string} */ boardId) => kernelInstance.tokensOf(boardId),
      subscriptionsOf: (/** @type {string} */ boardId) => kernelInstance.subscriptionsOf(boardId),
      releaseHolder: (/** @type {string} */ holderId) => kernelInstance.releaseHolder(holderId),
      dropBoard: (/** @type {string} */ boardId) => kernelInstance.dropBoard(boardId),
    })
    ctx.reflect.provide('orreryBlackboard', service)

    registerTools(ctx, service)

    // Terminate path (design D3): the supervision terminate fact names the
    // child, and its tokens die with it. TTL stays the backstop for abnormal
    // deaths. The record rides the audit-channel shape (time/session/type/data).
    const offTerminate = ctx.on('orrery/supervision/terminate', (/** @type {any} */ record) => {
      const childId = record?.data?.childId
      if (typeof childId === 'string' && childId.length > 0) service.releaseHolder(childId)
    })
    // An agent that is gone can never write again: release its tokens. The
    // root agent's disposal ends the conversation, so the whole board clears
    // (volatile semantics: noise is capped by the session's own lifetime).
    const offDisposed = ctx.on('agent/disposed', (/** @type {any} */ { agent }) => {
      const id = agent?.id
      if (typeof id !== 'string' || id.length === 0) return
      service.releaseHolder(id)
      if ((agent?.session?.header?.delegationDepth ?? 0) === 0) service.dropBoard(id)
    })
    return () => { offTerminate?.(); offDisposed?.(); offRelease() }
  }
}

const apply = createBlackboardPlugin()

export { name, inject, apply, ENTRY_TYPE_LINES }
