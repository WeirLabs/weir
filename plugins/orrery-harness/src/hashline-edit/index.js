// Orrery hashline edit: hash-anchored read output and the fail-closed
// hash_edit tool. Plain ESM, ctx-only.
import { anchorFor } from './anchors.js'
import { applyOps, renderMismatch, validateOps } from './apply-ops.js'
import { unifiedDiff } from './diff.js'

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

SNAPSHOT: All edits in one call reference the ORIGINAL file state. Anchors MUST be copied exactly from a recent read result — never hand-transcribed, never guessed. Any stale or mismatched anchor rejects the WHOLE call with a \`>>> mismatch\` report and leaves the file byte-identical (fail-closed, zero writes).

Operations:
- replace: { op:'replace', pos:'N#XX', end?:'N#YY', lines:[...] } — replace the anchored line, or the inclusive pos..end range, with lines.
- append: { op:'append', pos:'N#XX', lines:[...] } — insert lines AFTER the anchored line.
- prepend: { op:'prepend', pos:'N#XX', lines:[...] } — insert lines BEFORE the anchored line.

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

function apply(ctx, config = {}) {
  // Settings overlay (absent service = no-op): hashlineEdit section wins over row config.
  const settingsOverride = ctx.get?.('orrerySettings')?.get('hashlineEdit')
  if (settingsOverride && typeof settingsOverride === 'object') {
    config = { ...config, ...settingsOverride }
  }
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
              lines: { type: 'array', items: { type: 'string' }, description: 'Replacement or inserted lines.' },
            },
            required: ['op', 'pos', 'lines'],
          },
        },
      },
      required: ['file_path', 'edits'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: `hash_edit applied ${value.ops} op(s) to ${value.path}:\n\n${value.diff}` }],
    },
    async execute(args, exec) {
      if (typeof args.file_path !== 'string' || args.file_path.length === 0) {
        throw new Error('hash_edit: file_path must be a non-empty string')
      }
      if (!Array.isArray(args.edits) || args.edits.length === 0) {
        throw new Error('hash_edit: edits must be a non-empty array')
      }

      const cwd = exec.agent?.session?.header?.cwd
      const target = await ctx.fs.resolve(args.file_path, cwd ? { cwd } : {})
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
        )
      } catch (error) {
        if (String(error?.code ?? error?.message ?? '').includes('FS_STALE_VERSION')) {
          throw new Error('hash_edit: the file changed on disk between your read and this edit. Re-read it and copy the current anchors before retrying.')
        }
        throw error
      }

      return {
        path: target.displayPath,
        ops: args.edits.length,
        diff: unifiedDiff(target.displayPath, before, after),
        version: String(outcome.version),
      }
    },
  })
}

export { name, inject, apply }
