// Mock LSP server for the weir-it integration profile: speaks JSON-RPC 2.0
// with Content-Length framing over stdio, answering initialize/documentSymbol/
// definition/references/rename and pushing publishDiagnostics after didOpen.
// Protocol fixture for testing the weir-harness/lsp client end-to-end.
//
// Rename: the server tracks synced documents (didOpen/didChange full text),
// derives the identifier at the requested position, and answers a cross-file
// WorkspaceEdit computed from the fixture files on disk (siblings of this
// script inside the integration workspace). newName 'staleProbe' selects the
// deterministic stale-version variant: the changes map carries a THIRD entry
// for probe-other.ts under a './'-spelled alias URI (a distinct JSON key that
// ctx.fs.resolve normalizes to the same on-disk file). The write pass writes
// probe.ts, then probe-other.ts (bumping its version), so the alias entry's
// replaceIfVersion rejects with FS_STALE_VERSION on every run — no timers, no
// races. The alias entry's newText carries an 'X' suffix so its rejected
// content is provably absent from disk.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const RENAME_FILES = ['probe.ts', 'probe-other.ts']
const STALE_PROBE_NAME = 'staleProbe'

let buffer = Buffer.alloc(0)

const FIXTURE_DIAGNOSTIC = {
  range: { start: { line: 0, character: 0 }, end: { line: 0, character: 8 } },
  severity: 2,
  message: 'mock-diagnostic: fixture warning',
  source: 'mock-lsp',
}

const FIXTURE_SYMBOL = {
  name: 'fixtureSymbol',
  kind: 12,
  range: { start: { line: 2, character: 0 }, end: { line: 2, character: 13 } },
  selectionRange: { start: { line: 2, character: 4 }, end: { line: 2, character: 17 } },
}

/** uri → latest synced full text (didOpen/didChange). */
const openDocs = new Map()

function send(message) {
  const body = JSON.stringify(message)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
}

function publishDiagnostics(uri) {
  setTimeout(() => {
    send({
      jsonrpc: '2.0',
      method: 'textDocument/publishDiagnostics',
      params: { uri, diagnostics: [FIXTURE_DIAGNOSTIC] },
    })
  }, 20)
}

const isIdentChar = (char) => /[A-Za-z0-9_$]/.test(char ?? '')

/** Identifier spanning the 0-based position in the synced text, or null. */
function symbolAt(text, line, character) {
  const row = text.split(/\r?\n/)[line] ?? ''
  let start = Math.min(character, row.length)
  let end = start
  while (start > 0 && isIdentChar(row[start - 1])) start--
  while (end < row.length && isIdentChar(row[end])) end++
  return start < end ? row.slice(start, end) : null
}

/** One TextEdit per whole-word occurrence of symbol in content (positions over /\r?\n/ lines). */
function occurrencesOf(content, symbol, newText) {
  const edits = []
  content.split(/\r?\n/).forEach((row, line) => {
    let index = 0
    for (;;) {
      const found = row.indexOf(symbol, index)
      if (found === -1) break
      if (!isIdentChar(row[found - 1]) && !isIdentChar(row[found + symbol.length])) {
        edits.push({
          range: { start: { line, character: found }, end: { line, character: found + symbol.length } },
          newText,
        })
      }
      index = found + symbol.length
    }
  })
  return edits
}

function renameResult(params) {
  const synced = openDocs.get(params?.textDocument?.uri) ?? ''
  const symbol = symbolAt(synced, params?.position?.line ?? -1, params?.position?.character ?? 0)
  if (!symbol) return null
  const changes = {}
  for (const name of RENAME_FILES) {
    const filePath = join(HERE, name)
    let content
    try {
      content = readFileSync(filePath, 'utf8')
    } catch {
      continue
    }
    const edits = occurrencesOf(content, symbol, params.newName)
    if (edits.length > 0) changes[`file://${filePath}`] = edits
  }
  if (params.newName === STALE_PROBE_NAME) {
    // See the header comment: deterministic mid-write stale injection via a
    // same-file alias entry ordered after the real one.
    const last = RENAME_FILES[RENAME_FILES.length - 1]
    const lastPath = join(HERE, last)
    // HERE ends with '/'; strip it so the alias is exactly one '/./' segment.
    const base = HERE.endsWith('/') ? HERE.slice(0, -1) : HERE
    try {
      const edits = occurrencesOf(readFileSync(lastPath, 'utf8'), symbol, `${params.newName}X`)
      if (edits.length > 0) changes[`file://${base}/./${last}`] = edits
    } catch {
      // fixture missing: no alias entry
    }
  }
  return Object.keys(changes).length > 0 ? { changes } : null
}

function routeMessage(message) {
  if (typeof message.method !== 'string') return
  const { id, method, params } = message

  if (method === 'initialize') {
    send({
      jsonrpc: '2.0',
      id,
      result: {
        capabilities: {
          textDocumentSync: 1,
          definitionProvider: true,
          referencesProvider: true,
          documentSymbolProvider: true,
          renameProvider: true,
        },
        serverInfo: { name: 'mock-lsp', version: '0.1.0' },
      },
    })
    return
  }
  if (method === 'initialized') return
  if (method === 'textDocument/didOpen') {
    if (params?.textDocument?.uri) {
      openDocs.set(params.textDocument.uri, params.textDocument.text ?? '')
      publishDiagnostics(params.textDocument.uri)
    }
    return
  }
  if (method === 'textDocument/didChange') {
    if (params?.textDocument?.uri) {
      openDocs.set(params.textDocument.uri, params.contentChanges?.[0]?.text ?? '')
      publishDiagnostics(params.textDocument.uri)
    }
    return
  }
  if (method === 'textDocument/documentSymbol') {
    send({ jsonrpc: '2.0', id, result: [FIXTURE_SYMBOL] })
    return
  }
  if (method === 'textDocument/definition') {
    send({
      jsonrpc: '2.0',
      id,
      result: [
        {
          uri: params.textDocument.uri,
          range: { start: { line: 2, character: 4 }, end: { line: 2, character: 17 } },
        },
      ],
    })
    return
  }
  if (method === 'textDocument/references') {
    send({
      jsonrpc: '2.0',
      id,
      result: [
        { uri: params.textDocument.uri, range: { start: { line: 2, character: 4 }, end: { line: 2, character: 17 } } },
        { uri: params.textDocument.uri, range: { start: { line: 7, character: 9 }, end: { line: 7, character: 22 } } },
      ],
    })
    return
  }
  if (method === 'textDocument/rename') {
    send({ jsonrpc: '2.0', id, result: renameResult(params) })
    return
  }
  if (method === 'shutdown') {
    send({ jsonrpc: '2.0', id, result: null })
    return
  }
  if (method === 'exit') {
    process.exit(0)
  }
  if (id !== undefined) {
    send({ jsonrpc: '2.0', id, result: null })
  }
}

process.stdin.on('data', (chunk) => {
  buffer = Buffer.concat([buffer, chunk])
  for (;;) {
    const headerEnd = buffer.indexOf('\r\n\r\n')
    if (headerEnd === -1) return
    const header = buffer.slice(0, headerEnd).toString('utf8')
    const match = /Content-Length:[ \t]*(\d+)/i.exec(header)
    if (!match) {
      buffer = buffer.slice(headerEnd + 4)
      continue
    }
    const length = Number.parseInt(match[1], 10)
    if (buffer.length < headerEnd + 4 + length) return
    const body = buffer.slice(headerEnd + 4, headerEnd + 4 + length)
    buffer = buffer.slice(headerEnd + 4 + length)
    try {
      routeMessage(JSON.parse(body.toString('utf8')))
    } catch {
      // skip undecodable frame
    }
  }
})
