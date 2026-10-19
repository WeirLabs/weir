// Weir hashline edit: hash-anchored read output and the fail-closed
// hash_edit tool. Plain ESM, ctx-only.
import { anchorFor } from './anchors.js'
import { applyOps, renderMismatch, validateOps } from './apply-ops.js'
import { diffResult } from './diff.js'
import { escalationHintMarker, probeEscalation, resolveCallPolicy, sandboxDenialMarker } from './sandbox.js'
import { createManagedWriteTool, MANAGED_WRITE_NAME } from './write-tool.js'
import { createEditorLease } from '../file-lease/singleton.js'
import { isLeaseConflict } from '../file-lease/client.js'

const name = 'weir-hashline-edit'
const inject = ['tools', 'fs']

export const HASH_EDIT_NAME = 'hash_edit'
const STOCK_EDIT_NAME = 'edit'
const STOCK_WRITE_NAME = 'write'

/**
 * Install the managed editors on every created agent (design D11): hide the
 * stock `edit` AND the stock `write`, then provide our own `write` at the SAME
 * scope.
 *
 * Uniform mechanism: per-agent restriction on creation. At an agent's scope the
 * stock tools are always *inherited* (from the global layer, or from the preset
 * layer in preset compositions), and inherited tools are restrictable — the
 * agent's catalog hides them — while a definition registered at that same scope
 * wins over the denied name. This covers host-level mounts (headless
 * compositions) and preset mounts alike; a mount-time restrict cannot work in
 * either (unscoped at host level; at preset standing scope the fs row's scoped
 * tools are not restrictable). Listeners are awaited before creation resolves,
 * so the denial and the registration both land before the agent's first
 * request.
 *
 * The two steps must stay in one listener: a deny without the registration
 * leaves the agent with no writer at all, and a registration without the deny
 * leaves the unmanaged stock writer reachable. The registration is verified —
 * if our definition is not the one this agent resolves, it is disposed and the
 * stock writers stay hidden, because an unmanaged write is exactly what this
 * path exists to prevent.
 * @param {any} ctx @param {any} lease @param {() => any} sandboxPolicy
 */
function installManagedEditors(ctx, lease, sandboxPolicy) {
  /** @type {WeakMap<object, any>} definitions this mount installed, per agent */
  const installed = new WeakMap()
  ctx.on('agent/created', ({ agent }) => {
    const scope = agent?.ctx?.tools
    if (typeof scope?.restrict !== 'function') return
    // Nothing to replace: this agent sees neither stock editor (a composition
    // without the host fs row). Registering our writer there would only add a
    // tool whose observation guard could never be answered.
    if (typeof ctx.tools?.get === 'function'
      && !ctx.tools.get(STOCK_EDIT_NAME, agent)
      && !ctx.tools.get(STOCK_WRITE_NAME, agent)) return
    if (installed.has(agent)) return
    scope.restrict({ deny: [STOCK_EDIT_NAME, STOCK_WRITE_NAME] })
    const definition = createManagedWriteTool(ctx, lease, sandboxPolicy())
    const dispose = typeof scope.register === 'function' ? scope.register(definition) : undefined
    installed.set(agent, definition)
    const resolved = typeof ctx.tools?.get === 'function' ? ctx.tools.get(MANAGED_WRITE_NAME, agent) : definition
    if (resolved === definition) return
    installed.delete(agent)
    try { dispose?.() } catch { /* the scope's own teardown may have run first */ }
    ctx.logger?.warn?.('hashline-edit: the managed write was not installed for this agent; the stock writers stay hidden')
  })
}

export const HASH_EDIT_DESCRIPTION = `Edit a UTF-8 text file through hash anchors (\`LINE#ID\`) from read output.

SNAPSHOT: All edits in one call reference the ORIGINAL file state. Anchors MUST be copied exactly from a recent read result — never hand-transcribed, never guessed. Any stale or mismatched anchor rejects the WHOLE call with a \`>>> mismatch\` report and leaves the file byte-identical (zero writes). Invalid-JSON arguments fail the ENTIRE turn before this tool runs — no write, no report.

Operations (\`text\`: one string, \\n between lines, e.g. "a\\nb"):
- replace: { op:'replace', pos:'N#XX', end?:'N#YY', text:'...' } — replace the anchored line, or the inclusive pos..end range; text:'' deletes the range.
- append: { op:'append', pos:'N#XX', text:'...' } — insert AFTER the anchored line (never empty).
- prepend: { op:'prepend', pos:'N#XX', text:'...' } — insert BEFORE the anchored line (never empty).

On a mismatch report, re-read the file and copy the current anchors verbatim before retrying.`

/** Rewrite a read result's content lines with `N#XX|` anchors. */
export function anchorReadContent(value, content) {
  const lines = value?.lines
  if (!Array.isArray(lines) || lines.length === 0) return content
  if (!Array.isArray(content)) return content

  return content.map((block) => {
    if (block?.type !== 'text' || typeof block.text !== 'string') return block
    const textLines = block.text.split('\n')
    let cursor = 0
    const rewritten = textLines.map((textLine) => {
      if (cursor >= lines.length) return textLine
      const expected = lines[cursor]
      const prefix = `${expected.number}: `
      if (!textLine.startsWith(prefix)) return textLine
      const body = textLine.slice(prefix.length)
      if (body === expected.text) {
        cursor++
        return `${expected.number}#${anchorIdOf(expected)}| ${body}`
      }
      // The read window caps long lines: keep truncated lines anchor-free
      // (any anchor referencing them fails validation — fail-closed).
      if (expected.text.startsWith(body)) {
        cursor++
        return `${expected.number}| ${body}`
      }
      return textLine
    })
    return { ...block, text: rewritten.join('\n') }
  })
}

function anchorIdOf(line) {
  return anchorFor(line.number, line.text).split('#')[1]
}

/**
 * True when the thrown error is the structured sandbox denial. The stock
 * tools compare `FsError.code`, which this plugin cannot import — accept
 * the code channel when present, else the shared denial-marker text.
 */
function isSandboxDenial(error) {
  if (error?.code === 'FS_SANDBOX_DENIED') return true
  return String(error?.message ?? '').includes('[sandbox: file access denied under')
}

function apply(ctx, config = {}) {
  // The injection seam (unit tests, embedders): an explicit client wins and
  // creates no singleton. Read BEFORE the settings overlay so a settings value
  // can never shadow it. Default: the process-wide client (D11), resolved on
  // the first managed write.
  const leaseClient = config.leaseClient
  // Settings overlay (absent service = no-op): hashlineEdit section wins over row config.
  const settingsOverride = ctx.get?.('weirSettings')?.get('hashlineEdit')
  if (settingsOverride && typeof settingsOverride === 'object') {
    config = { ...config, ...settingsOverride }
  }
  // Optional sandbox policy capture (S23): the sandboxed fs backend enforces
  // the session policy only when the caller passes it per call. Absent service
  // (headless test compositions, other hosts) = today's call shape.
  let sandboxPolicyRef = null
  ctx.inject?.(['sandboxPolicy'], (scope) => {
    sandboxPolicyRef = scope.sandboxPolicy
  })
  const lease = createEditorLease({ leaseClient, ctx })

  // Sandbox escalation capability fact (mirrors the stock fs tools): a
  // confining backend exposes ctx.fs.sandboxMode; only then does hash_edit
  // advertise the one-shot escalation fields.
  const escalation = probeEscalation(ctx.fs)

  // Read enhancer: annotate read results with anchors.
  ctx.on('tools/post-execute', async (exec, result, next) => {
    const downstream = await next()
    if (exec.name !== 'read' || result.isError) return downstream
    const content = downstream.content ?? result.content
    const rewritten = anchorReadContent(result.value, content)
    if (rewritten === content) return downstream
    return { ...downstream, content: rewritten }
  })

  // Managed editors: hide the stock `edit` and `write`, provide our `write`.
  if (config.hideStockEdit === true) {
    installManagedEditors(ctx, lease, () => sandboxPolicyRef)
  }

  const definition = {
    name: HASH_EDIT_NAME,
    description: HASH_EDIT_DESCRIPTION,
    parameters: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Path to edit, resolved by the filesystem backend.' },
        edits: {
          type: 'array',
          description: 'One or more anchored edit operations, applied against the original file state.',
          items: {
            type: 'object',
            properties: {
              op: { type: 'string', enum: ['replace', 'append', 'prepend'] },
              pos: { type: 'string', description: 'Anchor N#XX copied from read output.' },
              end: { type: 'string', description: 'Inclusive end anchor for replace ranges.' },
              text: { type: 'string', description: 'Content as one string, lines joined by the two-character escape \\n. Empty string deletes the anchored range under replace.' },
            },
            required: ['op', 'pos', 'text'],
          },
        },
        // One-shot sandbox escalation, advertised only under a confining
        // filesystem backend — the same fields the stock write/edit tools
        // expose, with the same descriptions.
        ...(escalation?.fields ?? {}),
      },
      required: ['file_path', 'edits'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: `hash_edit applied ${value.ops} op(s) to ${value.path}:\n\n${value.diff}` }],
      // Persisted presentation metadata for the conversation diff view
      // (keyed `tool.call.toolview`); same comparison as the rendered text.
      presentationMeta: (_args, value) => ({ diffs: Array.isArray(value.fragments) ? value.fragments : [] }),
    },
    async execute(args, exec) {
      if (typeof args.file_path !== 'string' || args.file_path.length === 0) {
        throw new Error('hash_edit: file_path must be a non-empty string')
      }
      if (!Array.isArray(args.edits) || args.edits.length === 0) {
        throw new Error('hash_edit: edits must be a non-empty array of edit objects — call again with the corrected shape')
      }

      // One-shot escalation (mirrors the stock resolvePolicy): the malformed
      // pairing fails before any filesystem work; a same-mode repeat rides
      // the standing policy; a strictly wider mode runs through the user
      // approval channel and widens THIS call only.
      const { policy, resolveCwd } = await resolveCallPolicy(args, {
        escalation,
        sandboxPolicy: sandboxPolicyRef,
        session: exec.agent?.session,
        sessionCwd: exec.agent?.session?.header?.cwd,
        approval: {
          approver: ctx.get?.('approval'),
          agent: exec.agent,
          toolName: HASH_EDIT_NAME,
          ...(exec.callId !== undefined ? { callId: exec.callId } : {}),
          ...(exec.signal ? { signal: exec.signal } : {}),
        },
      })
      const target = await ctx.fs.resolve(args.file_path, resolveCwd ? { cwd: resolveCwd } : {})
      const info = await ctx.fs.stat(target, exec.signal)
      if (!info || info.type !== 'file') {
        throw new Error(`hash_edit: no regular file at ${args.file_path}`)
      }
      const before = await ctx.fs.readText(target, exec.signal)
      const lines = before.split('\n')

      const validation = validateOps(args.edits, lines)
      if (!validation.ok) {
        throw new Error(renderMismatch(validation.mismatches))
      }

      const after = applyOps(lines, args.edits).join('\n')
      // Managed commit (design D2, D11): the lease is acquired for this lineage
      // BEFORE the write and kept for the remainder of the turn, so a sibling
      // session is refused with the target untouched. A real conflict is never
      // rewritten as anything else; an unhealthy arbiter degrades and this edit
      // proceeds (D7). Anchors, the version guard and the sandbox policy are
      // unchanged by the wrap.
      let outcome
      try {
        outcome = await lease.client().withLeases(
          lease.ownerOf(exec.agent),
          [target.displayPath],
          lease.scopeOf(exec.agent, resolveCwd),
          () => ctx.fs.writeText(
            target,
            after,
            { kind: 'replaceIfVersion', version: info.version },
            exec.signal,
            policy,
          ),
        )
      } catch (error) {
        // A refused claim is the arbiter's answer: pass it through untouched so
        // the model sees the conflict (and never a stale-version or sandbox
        // story that did not happen).
        if (isLeaseConflict(error)) throw error
        if (String(error?.code ?? error?.message ?? '').includes('FS_STALE_VERSION')) {
          throw new Error('hash_edit: the file changed on disk between your read and this edit. Re-read it and copy the current anchors before retrying.')
        }
        // Sandbox denial: report the shared marker naming the effective mode
        // plus the same-turn escalation hint (only when this composition
        // advertises the escalation fields). Any other error passes through.
        if (isSandboxDenial(error) && escalation !== null) {
          throw new Error(`${sandboxDenialMarker(policy?.mode ?? 'unknown')}\n${escalationHintMarker('operation')}`)
        }
        throw error
      }
      const result = diffResult(target.displayPath, before, after)
      return {
        path: target.displayPath,
        ops: args.edits.length,
        diff: result.text,
        fragments: result.fragments,
        version: String(outcome.version),
      }
    },
  }
  ctx.tools.register(definition)
}

export { name, inject, apply }
