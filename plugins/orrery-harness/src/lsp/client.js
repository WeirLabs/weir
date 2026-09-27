// Minimal self-built LSP client: JSON-RPC 2.0 with Content-Length framing
// over stdio pipes. Zero dependencies — the desktop host cannot resolve bare
// npm specifiers from a link bundle (S14), and the required surface is small
// (initialize handshake, four request methods, notifications).

/**
 * Create one LSP protocol endpoint over a spawned process's stdio.
 * @param {object} deps
 * @param {import('node:stream').Writable} deps.stdin - server process stdin
 * @param {import('node:stream').Readable} deps.stdout - server process stdout
 * @param {(method: string, params: unknown) => void} [deps.onNotification]
 * @param {number} [deps.timeoutMs] - per-request timeout (default 15000)
 */
export function createLspClient({ stdin, stdout, onNotification, timeoutMs = 15_000 }) {
  let nextId = 1
  /** @type {Map<number, { resolve: (v: any) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>} */
  const pending = new Map()
  let buffer = Buffer.alloc(0)

  stdout.on('data', (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    drainFrames()
  })

  function drainFrames() {
    for (;;) {
      const headerEnd = buffer.indexOf('\r\n\r\n')
      if (headerEnd === -1) return
      const header = buffer.slice(0, headerEnd).toString('utf8')
      const match = /Content-Length:[ \t]*(\d+)/i.exec(header)
      if (!match) {
        // Malformed header block: drop it and resync at the next boundary.
        buffer = buffer.slice(headerEnd + 4)
        continue
      }
      const length = Number.parseInt(match[1], 10)
      if (buffer.length < headerEnd + 4 + length) return
      const body = buffer.slice(headerEnd + 4, headerEnd + 4 + length)
      buffer = buffer.slice(headerEnd + 4 + length)
      let message
      try {
        message = JSON.parse(body.toString('utf8'))
      } catch {
        continue // undecodable frame: skip, keep streaming
      }
      routeMessage(message)
    }
  }

  function routeMessage(message) {
    if (message === null || typeof message !== 'object') return
    if (message.id !== undefined && ('result' in message || 'error' in message)) {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      clearTimeout(entry.timer)
      if (message.error) {
        entry.reject(new Error(`LSP ${message.error.code ?? ''} ${message.error.message ?? 'request failed'}`.trim()))
      } else {
        entry.resolve(message.result)
      }
      return
    }
    if (typeof message.method === 'string') {
      if (message.id !== undefined) {
        // Server→client request: we support none of them; answer null so the
        // server never stalls on us (e.g. workspace/configuration).
        send({ jsonrpc: '2.0', id: message.id, result: null })
      } else {
        onNotification?.(message.method, message.params)
      }
    }
  }

  function send(message) {
    const body = JSON.stringify(message)
    stdin.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
  }

  /** One JSON-RPC request with timeout. */
  function request(method, params) {
    const id = nextId++
    return new Promise((resolvePromise, rejectPromise) => {
      const timer = setTimeout(() => {
        pending.delete(id)
        rejectPromise(new Error(`lsp: request '${method}' timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      timer.unref?.()
      pending.set(id, { resolve: resolvePromise, reject: rejectPromise, timer })
      send({ jsonrpc: '2.0', id, method, params })
    })
  }

  /** One JSON-RPC notification (fire-and-forget). */
  function notify(method, params) {
    send({ jsonrpc: '2.0', method, params })
  }

  return { request, notify }
}

/** The initialize handshake: initialize → initialized. */
export async function handshake(client, rootUri, clientInfo = { name: 'orrery-lsp', version: '0.2.0' }) {
  const result = await client.request('initialize', {
    processId: null,
    rootUri,
    capabilities: {
      textDocument: {
        synchronization: { didSave: false, willSave: false, change: 1 /* Full */ },
        definition: {},
        references: {},
        documentSymbol: {},
        publishDiagnostics: {},
      },
    },
    clientInfo,
  })
  client.notify('initialized', {})
  return result?.capabilities ?? {}
}

/** Graceful shutdown: shutdown → exit, terminate on any failure. */
export async function shutdownClient(client, terminate) {
  try {
    await client.request('shutdown')
  } catch {
    // a dead or hung server gets terminated below anyway
  }
  try {
    client.notify('exit')
  } catch {
    // stdin already gone
  }
  terminate()
}
