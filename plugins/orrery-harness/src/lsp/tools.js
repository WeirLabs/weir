// The LSP semantic tools: four read-only queries plus `lsp_rename`, the one
// rewriting tool (cross-file WorkspaceEdit application through the fs version
// guard). Pure-object definitions with object-rooted schemas; 1-based
// positions in, structured text out; every LSP failure becomes an ordinary
// tool error result, never a broken turn.
import { familyForLanguageId, languageIdForFile } from './registry.js'
import { uriToPath } from './manager.js'
import { applyTextEdits, detectLineEndings, extractChanges, normalizeLineEndings, restoreLineEndings } from './rename.js'
import { unifiedDiff } from '../hashline-edit/diff.js'

const SEVERITY = { 1: 'error', 2: 'warning', 3: 'information', 4: 'hint' }

function zeroBased(value, name) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`lsp: ${name} must be a 1-based positive integer`)
  return value - 1
}

function oneBasedLocation(uri, range) {
  const path = uriToPath(uri)
  const line = (range?.start?.line ?? 0) + 1
  const character = (range?.start?.character ?? 0) + 1
  return `${path}:${line}:${character}`
}

function asLocationArray(result) {
  if (result === null || result === undefined) return []
  const list = Array.isArray(result) ? result : [result]
  return list
    .map((item) => {
      if (item?.uri && item?.range) return oneBasedLocation(item.uri, item.range)
      if (item?.targetUri && item?.targetRange) return oneBasedLocation(item.targetUri, item.targetRange)
      return undefined
    })
    .filter(Boolean)
}

/** Build the five tool definitions for one calling agent's enable. */
export function createLspTools({ manager, ctx, agent, diagnosticsWaitMs = 2_000 }) {
  // Optional sandbox policy capture (S23, mirrors hashline-edit): the
  // sandboxed fs backend enforces the session policy only when the caller
  // passes it per call. Absent service (headless test compositions, other
  // hosts) = today's call shape. lsp_rename v1 does no escalation
  // orchestration — only the policy-aware write.
  let sandboxPolicyRef = null
  ctx.inject?.(['sandboxPolicy'], (scope) => {
    sandboxPolicyRef = scope.sandboxPolicy
  })

  async function resolveTarget(args, exec) {
    const cwd = exec.agent?.session?.header?.cwd
    const target = await ctx.fs.resolve(args.file_path, cwd ? { cwd } : {})
    const languageId = languageIdForFile(target.displayPath)
    if (!languageId || !familyForLanguageId(languageId)) {
      throw new Error(`lsp: no language server for file type of ${args.file_path}`)
    }
    return { cwd, target, languageId }
  }

  async function resolveAndCall(args, exec, method, paramsOf) {
    const { cwd, target, languageId } = await resolveTarget(args, exec)
    return manager.call(languageId, cwd ?? '.', target, agent.id, async (record, uri) => {
      return record.client.request(method, paramsOf(uri))
    }, exec.signal)
  }

  const positionParams = {
    file_path: { type: 'string', description: 'File to inspect, resolved by the filesystem backend.' },
    line: { type: 'number', description: '1-based line of the symbol.' },
    character: { type: 'number', description: '1-based column of the symbol.' },
  }

  return [
    {
      name: 'lsp_diagnostics',
      description: `Language-server diagnostics for one file (errors, warnings, hints with ranges). Read-only. The document is synced before reading; if the server has not published yet, the answer may lag one call behind on very large projects.`,
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'File to diagnose, resolved by the filesystem backend.' },
        },
        required: ['file_path'],
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        const { cwd, target, languageId } = await resolveTarget(args, exec)
        const { uri, items } = await manager.call(languageId, cwd ?? '.', target, agent.id, async (record, uri) => {
          let entry = record.diagnostics.get(uri)
          if (!entry) {
            await new Promise((resolvePromise) => setTimeout(resolvePromise, diagnosticsWaitMs))
            entry = record.diagnostics.get(uri)
          }
          return { uri, items: entry?.diagnostics ?? [] }
        }, exec.signal)
        const lines = items.map((diagnostic) => {
          const severity = SEVERITY[diagnostic.severity] ?? `severity-${diagnostic.severity ?? '?'}`
          const line = (diagnostic.range?.start?.line ?? 0) + 1
          const character = (diagnostic.range?.start?.character ?? 0) + 1
          return `[${severity}] ${line}:${character} ${diagnostic.message}${diagnostic.source ? ` (${diagnostic.source})` : ''}`
        })
        return {
          text: lines.length > 0
            ? `${items.length} diagnostic(s) for ${uriToPath(uri)}:\n${lines.join('\n')}`
            : `No diagnostics reported for ${uriToPath(uri)}.`,
        }
      },
    },
    {
      name: 'lsp_definition',
      description: `Go to definition: resolve the definition location(s) of the symbol at a 1-based position. Read-only.`,
      parameters: { type: 'object', properties: positionParams, required: ['file_path', 'line', 'character'] },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        const line = zeroBased(args.line, 'line')
        const character = zeroBased(args.character, 'character')
        const result = await resolveAndCall(args, exec, 'textDocument/definition', (uri) => ({
          textDocument: { uri },
          position: { line, character },
        }))
        const locations = asLocationArray(result)
        return {
          text: locations.length > 0
            ? `Definition location(s):\n${locations.map((location) => `- ${location}`).join('\n')}`
            : 'No definition found at that position.',
        }
      },
    },
    {
      name: 'lsp_references',
      description: `Find references: list every reference location of the symbol at a 1-based position. Read-only.`,
      parameters: {
        type: 'object',
        properties: {
          ...positionParams,
          includeDeclaration: { type: 'boolean', description: 'Include the declaration itself (default true).' },
        },
        required: ['file_path', 'line', 'character'],
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        const line = zeroBased(args.line, 'line')
        const character = zeroBased(args.character, 'character')
        const result = await resolveAndCall(args, exec, 'textDocument/references', (uri) => ({
          textDocument: { uri },
          position: { line, character },
          context: { includeDeclaration: args.includeDeclaration !== false },
        }))
        const locations = asLocationArray(result)
        return {
          text: locations.length > 0
            ? `${locations.length} reference(s):\n${locations.map((location) => `- ${location}`).join('\n')}`
            : 'No references found at that position.',
        }
      },
    },
    {
      name: 'lsp_symbols',
      description: `Document symbols of one file: classes, functions, methods, constants with ranges (hierarchical when the server provides it). Read-only.`,
      parameters: {
        type: 'object',
        properties: {
          file_path: { type: 'string', description: 'File to outline, resolved by the filesystem backend.' },
        },
        required: ['file_path'],
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        const result = await resolveAndCall(args, exec, 'textDocument/documentSymbol', (uri) => ({
          textDocument: { uri },
        }))
        const lines = flattenSymbols(result)
        return {
          text: lines.length > 0 ? `Document symbols:\n${lines.join('\n')}` : 'No document symbols reported.',
        }
      },
    },
    {
      name: 'lsp_rename',
      description: `Rename the symbol at a 1-based position across the workspace: the language server computes every edit location and the resulting WorkspaceEdit is applied to disk through the filesystem version guard. Every target file is preflighted before anything is written (a bad edit range aborts the call with zero writes); then files are written one by one and a mid-write failure (file changed on disk, sandbox denial, I/O) stops immediately, reporting exactly which files were already written and which were not. The original line-ending style (LF/CRLF) of each file is preserved.`,
      parameters: {
        type: 'object',
        properties: {
          ...positionParams,
          new_name: { type: 'string', description: 'The new symbol name (must be non-empty after trimming).' },
        },
        required: ['file_path', 'line', 'character', 'new_name'],
      },
      output: {
        schema: { type: 'object' },
        render: (_args, value) => [{ type: 'text', text: value.text }],
      },
      async execute(args, exec) {
        const line = zeroBased(args.line, 'line')
        const character = zeroBased(args.character, 'character')
        const newName = typeof args.new_name === 'string' ? args.new_name.trim() : ''
        if (newName.length === 0) throw new Error('lsp_rename: new_name must be a non-empty string')

        const { cwd, target, languageId } = await resolveTarget(args, exec)
        const workspaceEdit = await manager.call(languageId, cwd ?? '.', target, agent.id, async (record, uri) => {
          if (!record.capabilities?.renameProvider) {
            throw new Error('lsp_rename: the language server does not support rename')
          }
          return record.client.request('textDocument/rename', {
            textDocument: { uri },
            position: { line, character },
            newName,
          })
        }, exec.signal)

        // Throws on documentChanges (v1 does not apply them); null = no-op.
        const changes = extractChanges(workspaceEdit)
        if (!changes) {
          return { text: `lsp_rename: no-op — the server returned no edits for that symbol; nothing was written.` }
        }

        // Per-call sandbox policy (S23 shape): resolve once, use its root as
        // the resolve cwd, and pass it as the 5th writeText argument.
        const policy = sandboxPolicyRef?.resolve({ session: exec.agent?.session })
        const resolveCwd = policy?.workspaceRoot ?? cwd
        const resolveOpts = resolveCwd ? { cwd: resolveCwd } : {}

        // Phase 1 — preflight, ZERO writes: resolve, stat, read, sample the
        // line-ending style, and synthesize the new full text of EVERY target
        // file. Any failure here aborts the whole call untouched.
        const plans = []
        for (const change of changes) {
          const fileTarget = await ctx.fs.resolve(change.path, resolveOpts)
          const info = await ctx.fs.stat(fileTarget, exec.signal)
          if (!info || info.type !== 'file') {
            throw new Error(`lsp_rename: no regular file at ${change.path} — preflight failed, no files were written`)
          }
          const before = await ctx.fs.readText(fileTarget, exec.signal)
          const sample = await ctx.fs.readByteRange(fileTarget, { offset: 0, length: Math.min(info.size, 65536) }, exec.signal)
          const style = detectLineEndings(sample)
          const normalized = normalizeLineEndings(before)
          const afterNormalized = applyTextEdits(normalized, change.edits)
          plans.push({
            target: fileTarget,
            version: info.version,
            edits: change.edits.length,
            before,
            normalized,
            afterNormalized,
            after: restoreLineEndings(afterNormalized, style),
          })
        }

        // Byte identity (restored synthesis === original bytes) = no-op.
        const writePlans = plans.filter((plan) => plan.after !== plan.before)
        if (writePlans.length === 0) {
          return { text: `lsp_rename: no-op — the server's edits leave every file unchanged; nothing was written.` }
        }

        // Phase 2 — write pass: one atomic replaceIfVersion write per file.
        // A failure stops the pass immediately and names both file lists.
        const written = []
        for (const plan of writePlans) {
          try {
            await ctx.fs.writeText(plan.target, plan.after, { kind: 'replaceIfVersion', version: plan.version }, exec.signal, policy)
            written.push(plan)
          } catch (error) {
            const notWritten = writePlans.slice(written.length).map((plan) => plan.target.displayPath)
            const already = written.map((plan) => plan.target.displayPath)
            throw new Error(
              `lsp_rename: write failed for ${plan.target.displayPath}: ${error?.message ?? error}\n` +
                `Rename partially applied. filesAlreadyWritten: [${already.join(', ')}]; filesNotWritten: [${notWritten.join(', ')}]`,
            )
          }
        }

        const editCount = writePlans.reduce((sum, plan) => sum + plan.edits, 0)
        const summary = `renamed: ${editCount} edit(s) across ${written.length} file(s)`
        const diffs = written
          .map((plan) => unifiedDiff(plan.target.displayPath, plan.normalized, plan.afterNormalized))
          .filter((diff) => diff.length > 0)
        return { text: diffs.length > 0 ? `${summary}\n\n${diffs.join('\n\n')}` : summary }
      },
    },
  ]
}

const SYMBOL_KINDS = {
  1: 'file', 2: 'module', 3: 'namespace', 4: 'package', 5: 'class', 6: 'method',
  7: 'property', 8: 'field', 9: 'constructor', 10: 'enum', 11: 'interface',
  12: 'function', 13: 'variable', 14: 'constant', 15: 'string', 26: 'type-parameter',
}

function flattenSymbols(result, depth = 0, out = []) {
  if (!Array.isArray(result)) return out
  for (const symbol of result) {
    if (!symbol || typeof symbol.name !== 'string') continue
    const kind = SYMBOL_KINDS[symbol.kind] ?? `kind-${symbol.kind ?? '?'}`
    const range = symbol.range ?? symbol.location?.range
    const line = (range?.start?.line ?? 0) + 1
    out.push(`${'  '.repeat(depth)}${symbol.name} (${kind}) :${line}`)
    if (Array.isArray(symbol.children)) flattenSymbols(symbol.children, depth + 1, out)
  }
  return out
}
