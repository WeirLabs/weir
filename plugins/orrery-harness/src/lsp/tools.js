// The four read-only LSP semantic tools. Pure-object definitions with
// object-rooted schemas; 1-based positions in, structured text out; every LSP
// failure becomes an ordinary tool error result, never a broken turn.
import { familyForLanguageId, languageIdForFile } from './registry.js'
import { uriToPath } from './manager.js'

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

/** Build the four tool definitions for one calling agent's enable. */
export function createLspTools({ manager, ctx, agent, diagnosticsWaitMs = 2_000 }) {
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
