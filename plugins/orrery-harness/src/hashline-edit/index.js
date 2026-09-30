// Orrery hashline edit: hash-anchored read output and the fail-closed
// hash_edit tool. Plain ESM, ctx-only.
import { anchorFor } from './anchors.js'
import { applyOps, renderMismatch, validateOps } from './apply-ops.js'
import { diffResult } from './diff.js'
import { escalationHintMarker, probeEscalation, resolveCallPolicy, sandboxDenialMarker } from './sandbox.js'

const name = 'orrery-hashline-edit'
const inject = ['tools', 'fs']

export const HASH_EDIT_NAME = 'hash_edit'
const STOCK_EDIT_NAME = 'edit'

/**
 * Hide the stock edit tool. Uniform mechanism: per-agent restriction on
 * creation. At an agent's scope the stock edit is always *inherited* (from
 * the global layer, or from the preset layer in preset compositions), and
 * inherited tools are restrictable — the agent's catalog hides it. This
 * covers host-level mounts (headless compositions) and preset mounts alike;
 * a mount-time restrict cannot work in either (unscoped at host level; at
 * preset standing scope the fs row's scoped edit is not restrictable).
 * Listeners are awaited before creation resolves, so the restriction lands
 * before the agent's first request.
 */
function hideStockEdit(ctx) {
  ctx.on('agent/created', ({ agent }) => {
    if (!ctx.tools.get(STOCK_EDIT_NAME, agent)) return // this agent has no stock edit
    agent.ctx.tools.restrict({ deny: [STOCK_EDIT_NAME] })
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
  // Settings overlay (absent service = no-op): hashlineEdit section wins over row config.
  const settingsOverride = ctx.get?.('orrerySettings')?.get('hashlineEdit')
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

  // Optional: hide the stock edit tool from this preset's agents.
  if (config.hideStockEdit === true) {
    hideStockEdit(ctx)
  }

  ctx.tools.register({
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
      let outcome
      try {
        outcome = await ctx.fs.writeText(
          target,
          after,
          { kind: 'replaceIfVersion', version: info.version },
          exec.signal,
          policy,
        )
      } catch (error) {
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
  })
}

export { name, inject, apply }
