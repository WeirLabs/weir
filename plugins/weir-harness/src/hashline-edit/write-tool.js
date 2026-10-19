// The managed `write` tool (design D11), now owned by hashline-edit.
//
// Byte-for-byte the tool that used to live in `src/edit-lock/write-tool.js`:
// same description of the contract, same stock observation guard, same diff
// metadata, same `fs/observed` event and the same error texts. The single
// difference is the commit itself — instead of asking a publisher service to
// write on our behalf, the write happens INSIDE
// `client.withLeases(owner, [path], scope, () => ctx.fs.writeText(...))`.
//
// Why that is not a downgrade: the version guard (`replaceIfVersion` /
// `createIfAbsent`) still runs in the host filesystem, so no unread overwrite is
// possible; the lease adds what the version guard cannot give — a sibling
// session is refused BEFORE any target-side effect, and that claim lasts for the
// remainder of the turn (design D2). A real conflict refuses the write; an
// unhealthy arbiter degrades and lets the write through (design D7).
//
// Nothing here imports `src/edit-lock/**`, and nothing imports `@deepseek-ai/*`:
// the filesystem arrives through `ctx`.

import { probeEscalation, resolveCallPolicy } from './sandbox.js'
import { diffResult } from './diff.js'

/** The stock name this definition replaces at the agent's scope. */
export const MANAGED_WRITE_NAME = 'write'

/** The observation guards the stock policy may hand back (`fs/write-intent`). */
const OBSERVATION_GUARDS = ['createIfAbsent', 'replaceIfVersion']

/**
 * Build the definition only. The caller must hide the inherited stock `write`
 * at the agent's scope and register THIS definition there, so the managed
 * writer is the one the agent resolves (fail-closed otherwise).
 *
 * @param {any} ctx the row context (`fs`, `waterfall`, `emit`, `emit`-style hooks)
 * @param {any} lease `{ client(), ownerOf(agent), scopeOf(agent, fallback) }` — see `file-lease/singleton.js`
 * @param {any} sandboxPolicy the effective-policy provider captured at mount (may be null)
 * @returns {any} a plain tool definition
 */
export function createManagedWriteTool(ctx, lease, sandboxPolicy) {
  const escalation = probeEscalation(ctx.fs)
  return {
    name: MANAGED_WRITE_NAME,
    description: 'Create or fully replace a UTF-8 text file through the file lease. Read an existing file before overwriting it.',
    parameters: { type: 'object', properties: {
      file_path: { type: 'string', description: 'Path to write, resolved by the filesystem backend.' },
      content: { type: 'string', description: 'Full UTF-8 text content to write.' },
      ...(escalation?.fields ?? {}),
    }, required: ['file_path', 'content'] },
    output: {
      schema: { type: 'object' },
      render: (/** @type {any} */ _args, /** @type {any} */ value) => [{ type: 'text', text: `${value.operation === 'create' ? 'Created' : 'Updated'} file: ${value.path}` }],
      presentationMeta: (/** @type {any} */ _args, /** @type {any} */ value) => ({ diffs: value.fragments }),
    },
    async execute(/** @type {any} */ args, /** @type {any} */ exec) {
      if (typeof args.file_path !== 'string' || !args.file_path.trim() || typeof args.content !== 'string') throw new Error('write requires file_path and content strings')
      const { policy, resolveCwd } = await resolveCallPolicy(args, {
        escalation, sandboxPolicy, session: exec.agent?.session, sessionCwd: exec.agent?.session?.header?.cwd,
        approval: { approver: ctx.get?.('approval'), agent: exec.agent, toolName: MANAGED_WRITE_NAME,
          ...(exec.callId !== undefined ? {callId: exec.callId} : {}), ...(exec.signal ? {signal: exec.signal} : {}) },
      })
      if (!resolveCwd || !policy) throw new Error('managed write requires trusted cwd and effective policy')
      const target = await ctx.fs.resolve(args.file_path, {cwd: resolveCwd})
      // Keep the stock observation policy's exact guard; do not stat a fresh
      // version and thereby silently authorize an unread overwrite.
      const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
      if (!intent || !OBSERVATION_GUARDS.includes(intent.kind)) throw new Error('managed write requires an explicit observation guard')
      const before = intent.kind === 'replaceIfVersion' ? await ctx.fs.readText(target, exec.signal) : null
      // The claim is taken before the write and NOT released here: it belongs to
      // the turn (D2), so a second write of this file in the same turn reuses it.
      const outcome = await lease.client().withLeases(
        lease.ownerOf(exec.agent),
        [target.displayPath],
        lease.scopeOf(exec.agent, resolveCwd),
        () => ctx.fs.writeText(target, args.content, intent, exec.signal, policy),
      )
      if (!outcome || !('version' in outcome)) throw new Error('write publication not acknowledged')
      ctx.emit('fs/observed', target, {kind: 'present', version: outcome.version}, exec)
      const fragments = before === null ? [] : diffResult(target.displayPath, before, args.content).fragments
      return {
        path: target.displayPath,
        // The guard is what decides create-vs-update: `createIfAbsent` can only
        // have produced a new file, `replaceIfVersion` only replaced one.
        operation: intent.kind === 'createIfAbsent' ? 'create' : 'update',
        before,
        after: args.content,
        fragments,
      }
    },
  }
}
