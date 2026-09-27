// Mock LSP server for the orrery-it integration profile: speaks JSON-RPC 2.0
// with Content-Length framing over stdio, answering initialize/documentSymbol/
// definition/references and pushing publishDiagnostics after didOpen.
// Protocol fixture for testing the orrery-harness/lsp client end-to-end.

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
        },
        serverInfo: { name: 'mock-lsp', version: '0.1.0' },
      },
    })
    return
  }
  if (method === 'initialized') return
  if (method === 'textDocument/didOpen' || method === 'textDocument/didChange') {
    if (params?.textDocument?.uri) publishDiagnostics(params.textDocument.uri)
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
