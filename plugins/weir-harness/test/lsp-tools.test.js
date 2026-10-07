// Unit tests for the five lsp_* tools driven through the manager's NAMED
// OPERATIONS interface (change lsp-manager-operations, D5): the manager
// stand-in below implements exactly { requestOn, diagnosticsFor,
// capabilitiesOf } and deliberately carries NO record field shapes (no
// client/diagnostics/capabilities fields) — the encapsulation invariant is
// pinned by construction here.
import { describe, expect, it } from './helpers.js'
import { createLspTools } from '../src/lsp/tools.js'

const URI = 'file:///ws/a.ts'

/**
 * Fake named-operations manager. `handlers` customizes results:
 * `onRequest(method, params)`, `diagnosticsResult`, `capabilitiesResult`.
 */
function fakeManager(handlers = {}) {
  const calls = []
  const manager = {
    async requestOn(languageId, cwd, target, sessionId, method, paramsOf, signal) {
      const params = paramsOf(URI)
      calls.push({ op: 'requestOn', languageId, cwd, target, sessionId, method, params, signal })
      return handlers.onRequest ? handlers.onRequest(method, params) : null
    },
    async diagnosticsFor(languageId, cwd, target, sessionId, signal) {
      calls.push({ op: 'diagnosticsFor', languageId, cwd, target, sessionId, signal })
      return handlers.diagnosticsResult ?? { uri: URI, diagnostics: [] }
    },
    async capabilitiesOf(languageId, cwd, sessionId, signal) {
      calls.push({ op: 'capabilitiesOf', languageId, cwd, sessionId, signal })
      return handlers.capabilitiesResult ?? {}
    },
  }
  return { manager, calls }
}

function fakeCtx() {
  return {
    fs: {
      resolve: async (path) => ({ displayPath: path, processPath: path }),
    },
  }
}

const agent = { id: 'agent-1', session: { header: { cwd: '/ws' } } }
const signal = { fakeSignal: true }
const exec = { agent, signal }

function toolsUnder(handlers) {
  const { manager, calls } = fakeManager(handlers)
  const tools = createLspTools({ manager, ctx: fakeCtx(), agent })
  const byName = (name) => tools.find((tool) => tool.name === name)
  return { byName, calls }
}

describe('lsp tools over named operations', () => {
  it('rejects non-1-based line/character before any manager operation', async () => {
    const { byName, calls } = toolsUnder()
    const definition = byName('lsp_definition')
    await expect(async () => definition.execute({ file_path: '/ws/a.ts', line: 0, character: 5 }, exec)).rejects.toThrow(/1-based/)
    await expect(async () => definition.execute({ file_path: '/ws/a.ts', line: 3, character: 0 }, exec)).rejects.toThrow(/1-based/)
    await expect(async () => definition.execute({ file_path: '/ws/a.ts', line: 1.5, character: 5 }, exec)).rejects.toThrow(/1-based/)
    const rename = byName('lsp_rename')
    await expect(async () => rename.execute({ file_path: '/ws/a.ts', line: 1, character: 7, new_name: '' }, exec)).rejects.toThrow(/new_name/)
    await expect(async () => rename.execute({ file_path: '/ws/a.ts', line: 1, character: 7, new_name: '   ' }, exec)).rejects.toThrow(/new_name/)
    expect(calls).toHaveLength(0)
  })

  it('definition builds 0-based params from 1-based input and renders 1-based locations', async () => {
    const { byName, calls } = toolsUnder({
      onRequest: (method, params) => [{ uri: params.textDocument.uri, range: { start: { line: 4, character: 1 }, end: { line: 4, character: 9 } } }],
    })
    const result = await byName('lsp_definition').execute({ file_path: '/ws/a.ts', line: 3, character: 5 }, exec)
    expect(calls).toHaveLength(1)
    expect(calls[0].op).toBe('requestOn')
    expect(calls[0].languageId).toBe('typescript')
    expect(calls[0].cwd).toBe('/ws')
    expect(calls[0].sessionId).toBe('agent-1')
    expect(calls[0].signal).toBe(signal)
    expect(calls[0].method).toBe('textDocument/definition')
    expect(calls[0].params).toEqual({ textDocument: { uri: URI }, position: { line: 2, character: 4 } })
    expect(result.text).toContain('Definition location(s):')
    expect(result.text).toContain('- /ws/a.ts:5:2')
  })

  it('references passes includeDeclaration through and renders every location', async () => {
    const { byName, calls } = toolsUnder({
      onRequest: () => [
        { uri: URI, range: { start: { line: 4, character: 1 }, end: { line: 4, character: 9 } } },
        { uri: URI, range: { start: { line: 9, character: 2 }, end: { line: 9, character: 10 } } },
      ],
    })
    const references = byName('lsp_references')
    const result = await references.execute({ file_path: '/ws/a.ts', line: 3, character: 5 }, exec)
    expect(calls[0].method).toBe('textDocument/references')
    expect(calls[0].params).toEqual({
      textDocument: { uri: URI },
      position: { line: 2, character: 4 },
      context: { includeDeclaration: true },
    })
    expect(result.text).toContain('2 reference(s)')
    expect(result.text).toContain('- /ws/a.ts:10:3')
    await references.execute({ file_path: '/ws/a.ts', line: 3, character: 5, includeDeclaration: false }, exec)
    expect(calls[1].params.context).toEqual({ includeDeclaration: false })
  })

  it('documentSymbol sends the uri-only params and renders the hierarchy', async () => {
    const { byName, calls } = toolsUnder({
      onRequest: () => [
        { name: 'alphaFn', kind: 12, range: { start: { line: 0, character: 0 }, end: { line: 2, character: 1 } }, children: [{ name: 'helperVar', kind: 14, range: { start: { line: 1, character: 2 }, end: { line: 1, character: 10 } } }] },
      ],
    })
    const result = await byName('lsp_symbols').execute({ file_path: '/ws/a.ts' }, exec)
    expect(calls[0].method).toBe('textDocument/documentSymbol')
    expect(calls[0].params).toEqual({ textDocument: { uri: URI } })
    expect(result.text).toContain('Document symbols:')
    expect(result.text).toContain('alphaFn (function) :1')
    expect(result.text).toContain('  helperVar (constant) :2')
  })

  it('diagnostics renders severity lines, and the empty case reads clean', async () => {
    const { byName, calls } = toolsUnder({
      diagnosticsResult: {
        uri: URI,
        diagnostics: [
          { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, message: 'fake error here', source: 'fake-lsp' },
          { range: { start: { line: 2, character: 4 }, end: { line: 2, character: 8 } }, severity: 2, message: 'fake warning' },
        ],
      },
    })
    const diagnostics = byName('lsp_diagnostics')
    const result = await diagnostics.execute({ file_path: '/ws/a.ts' }, exec)
    expect(calls[0].op).toBe('diagnosticsFor')
    expect(calls[0].languageId).toBe('typescript')
    expect(calls[0].sessionId).toBe('agent-1')
    expect(result.text).toContain('2 diagnostic(s) for /ws/a.ts:')
    expect(result.text).toContain('[error] 1:1 fake error here (fake-lsp)')
    expect(result.text).toContain('[warning] 3:5 fake warning')

    const empty = toolsUnder({ diagnosticsResult: { uri: URI, diagnostics: [] } })
    const emptyResult = await empty.byName('lsp_diagnostics').execute({ file_path: '/ws/a.ts' }, exec)
    expect(emptyResult.text).toBe('No diagnostics reported for /ws/a.ts.')
  })

  it('rename without renameProvider fails as an ordinary tool error without issuing the request', async () => {
    const { byName, calls } = toolsUnder({ capabilitiesResult: { definitionProvider: true } })
    const rename = byName('lsp_rename')
    await expect(async () => rename.execute({ file_path: '/ws/a.ts', line: 1, character: 7, new_name: 'betaFn' }, exec)).rejects.toThrow(/does not support rename/)
    // the capability gate ran; no rename request followed it
    expect(calls.map((call) => call.op)).toEqual(['capabilitiesOf'])
    expect(calls[0].languageId).toBe('typescript')
  })
})
