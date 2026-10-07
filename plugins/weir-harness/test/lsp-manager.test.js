// Direct unit tests for the LSP lifecycle manager (createLspManager) over its
// named-operations interface — no apply() gate. The fakeSubprocess below is a
// deliberate minimal copy IN PLACE of the lsp.test.js pattern (change
// lsp-manager-operations, D5): lsp.test.js is a must-survive file and keeps
// its own copy untouched.
import { describe, expect, it } from './helpers.js'
import { PassThrough } from 'node:stream'
import { createLspManager } from '../src/lsp/manager.js'

const DEFAULT_TEXT = 'const alphaFn = () => 1\n'

/** Scripted fake LSP server over PassThrough pipes (auto-handshakes). */
function fakeSubprocess(options = {}) {
  const spawns = []
  let spawnCount = 0
  const subprocess = {
    spawns,
    resolveExecutable: async (command) => (command === 'missing-server' ? undefined : `/resolved/${command}`),
    spawn(spec) {
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      let terminated = 0
      const handle = {
        stdin,
        stdout,
        done: new Promise(() => {}),
        terminate: () => {
          terminated++
        },
        get terminated() {
          return terminated
        },
        spec,
        received: [], // every decoded client→server message, in arrival order
      }
      // failFirstInitialize makes the FIRST spawned server fail the handshake
      const spawnIndex = spawnCount++
      const spawnOptions = options.failFirstInitialize && spawnIndex === 0
        ? { ...options, failInitialize: true }
        : options
      let buffer = Buffer.alloc(0)
      stdin.on('data', (chunk) => {
        buffer = Buffer.concat([buffer, chunk])
        for (;;) {
          const headerEnd = buffer.indexOf('\r\n\r\n')
          if (headerEnd === -1) return
          const match = /Content-Length:[ \t]*(\d+)/i.exec(buffer.slice(0, headerEnd).toString('utf8'))
          const length = Number.parseInt(match?.[1] ?? '0', 10)
          if (buffer.length < headerEnd + 4 + length) return
          const body = buffer.slice(headerEnd + 4, headerEnd + 4 + length)
          buffer = buffer.slice(headerEnd + 4 + length)
          const message = JSON.parse(body.toString('utf8'))
          handle.received.push(message)
          answer(message, stdout, spawnOptions)
        }
      })
      spawns.push(handle)
      return handle
    },
  }
  return subprocess
}

function answer(message, stdout, serverOptions = {}) {
  const reply = (response) => {
    const body = JSON.stringify(response)
    stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
  }
  if (message.method === 'initialize') {
    if (serverOptions.failInitialize) {
      reply({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: 'boom: no tsserver' } })
      return
    }
    reply({ jsonrpc: '2.0', id: message.id, result: { capabilities: serverOptions.capabilities ?? {} } })
    return
  }
  if (message.method === 'shutdown') {
    reply({ jsonrpc: '2.0', id: message.id, result: null })
    return
  }
  if (message.method === 'textDocument/didOpen' && typeof serverOptions.publishDelayMs === 'number') {
    setTimeout(() => {
      reply({
        jsonrpc: '2.0',
        method: 'textDocument/publishDiagnostics',
        params: {
          uri: message.params.textDocument.uri,
          diagnostics: [
            { range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, severity: 1, message: 'fake error here', source: 'fake-lsp' },
          ],
        },
      })
    }, serverOptions.publishDelayMs)
    return
  }
  if (message.method === 'textDocument/definition') {
    reply({
      jsonrpc: '2.0',
      id: message.id,
      result: [{ uri: message.params.textDocument.uri, range: { start: { line: 4, character: 1 }, end: { line: 4, character: 9 } } }],
    })
    return
  }
  if (message.id !== undefined) reply({ jsonrpc: '2.0', id: message.id, result: null })
}

/** Fake fs: readText resolves text by processPath ?? displayPath. */
function fakeFs(files = {}) {
  return {
    readText: async (target) => files[target.processPath ?? target.displayPath] ?? DEFAULT_TEXT,
  }
}

const REGISTRY = {
  typescript: { command: 'fake-ts-server', args: ['--stdio'] },
  python: { command: 'fake-py-server', args: [] },
}

const target = (path) => ({ displayPath: path, processPath: path })
const definitionParams = (uri) => ({ textDocument: { uri }, position: { line: 0, character: 0 } })
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Rejects when the promise does not settle within ms (no-wait assertions). */
async function within(ms, promise) {
  let timer
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`did not settle within ${ms}ms`)), ms)
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, guard])
  } finally {
    clearTimeout(timer)
  }
}

function createManager(subprocess, files, options) {
  return createLspManager({ subprocess, fs: fakeFs(files), registry: { ...REGISTRY }, options })
}

const DEFINITION_RESULT = [{ uri: 'file:///ws/a.ts', range: { start: { line: 4, character: 1 }, end: { line: 4, character: 9 } } }]

describe('lsp manager operations', () => {
  it('starts lazily and reuses the server for the same (cwd, family) key', async () => {
    const subprocess = fakeSubprocess()
    const manager = createManager(subprocess)
    expect(subprocess.spawns).toHaveLength(0)
    const result = await manager.requestOn('typescript', '/ws', target('/ws/a.ts'), 's1', 'textDocument/definition', definitionParams, undefined)
    expect(subprocess.spawns).toHaveLength(1)
    expect(result).toEqual(DEFINITION_RESULT)
    // same key → reuse
    await manager.requestOn('typescript', '/ws', target('/ws/a.ts'), 's1', 'textDocument/definition', definitionParams, undefined)
    expect(subprocess.spawns).toHaveLength(1)
    // same family reached through another languageId → reuse
    await manager.requestOn('javascript', '/ws', target('/ws/b.js'), 's1', 'textDocument/definition', definitionParams, undefined)
    expect(subprocess.spawns).toHaveLength(1)
    // another family → a second server
    await manager.requestOn('python', '/ws', target('/ws/c.py'), 's1', 'textDocument/definition', definitionParams, undefined)
    expect(subprocess.spawns).toHaveLength(2)
    // unknown language family fails before any spawn
    await expect(async () => manager.requestOn('cobol', '/ws', target('/ws/x.cobol'), 's1', 'textDocument/definition', definitionParams, undefined)).rejects.toThrow(/no language server family/)
    expect(subprocess.spawns).toHaveLength(2)
  })

  it('a failed handshake terminates the process, drops the record, and the next operation spawns fresh', async () => {
    const subprocess = fakeSubprocess({ failFirstInitialize: true })
    const manager = createManager(subprocess)
    await expect(async () => manager.requestOn('typescript', '/ws', target('/ws/a.ts'), 's1', 'textDocument/definition', definitionParams, undefined)).rejects.toThrow(/boom/)
    expect(subprocess.spawns).toHaveLength(1)
    expect(subprocess.spawns[0].terminated).toBe(1)
    // the (cwd, family) key is not poisoned: the next operation spawns fresh
    const result = await manager.requestOn('typescript', '/ws', target('/ws/a.ts'), 's1', 'textDocument/definition', definitionParams, undefined)
    expect(subprocess.spawns).toHaveLength(2)
    expect(result).toEqual(DEFINITION_RESULT)
  })

  it('holder refcount: the server shuts down only when the last session releases', async () => {
    const subprocess = fakeSubprocess()
    const manager = createManager(subprocess)
    await manager.requestOn('typescript', '/ws', target('/ws/a.ts'), 'session-a', 'textDocument/definition', definitionParams, undefined)
    await manager.requestOn('typescript', '/ws', target('/ws/a.ts'), 'session-b', 'textDocument/definition', definitionParams, undefined)
    expect(subprocess.spawns).toHaveLength(1)
    await manager.releaseSession('stranger') // unknown session: no-op
    expect(subprocess.spawns[0].terminated).toBe(0)
    await manager.releaseSession('session-a')
    expect(subprocess.spawns[0].terminated).toBe(0)
    await manager.releaseSession('session-b')
    expect(subprocess.spawns[0].terminated).toBe(1)
  })

  it('idle shutdown closes an untouched server and the next operation respawns', async () => {
    const subprocess = fakeSubprocess()
    const manager = createManager(subprocess, {}, { idleMs: 50 })
    await manager.requestOn('typescript', '/ws', target('/ws/a.ts'), 's1', 'textDocument/definition', definitionParams, undefined)
    expect(subprocess.spawns).toHaveLength(1)
    await sleep(250)
    expect(subprocess.spawns[0].terminated).toBe(1)
    await manager.requestOn('typescript', '/ws', target('/ws/a.ts'), 's1', 'textDocument/definition', definitionParams, undefined)
    expect(subprocess.spawns).toHaveLength(2)
  })

  it('syncs before the request: didOpen with version 1, didChange with version 2 on re-sync', async () => {
    const subprocess = fakeSubprocess()
    const manager = createManager(subprocess)
    await manager.requestOn('typescript', '/ws', target('/ws/a.ts'), 's1', 'textDocument/definition', definitionParams, undefined)
    await manager.requestOn('typescript', '/ws', target('/ws/a.ts'), 's1', 'textDocument/references', definitionParams, undefined)
    const received = subprocess.spawns[0].received
    expect(received.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'textDocument/didOpen',
      'textDocument/definition',
      'textDocument/didChange',
      'textDocument/references',
    ])
    expect(received[2].params.textDocument.uri).toBe('file:///ws/a.ts')
    expect(received[2].params.textDocument.languageId).toBe('typescript')
    expect(received[2].params.textDocument.version).toBe(1)
    expect(received[2].params.textDocument.text).toBe(DEFAULT_TEXT)
    expect(received[4].params.textDocument.version).toBe(2)
  })

  it('didOpen carries the languageId of the operation that opened the document', async () => {
    const subprocess = fakeSubprocess()
    const manager = createManager(subprocess)
    await manager.requestOn('typescript', '/ws', target('/ws/a.ts'), 's1', 'textDocument/definition', definitionParams, undefined)
    // same family, other languageId, NEW document: served by the same server
    await manager.requestOn('javascript', '/ws', target('/ws/b.js'), 's1', 'textDocument/definition', definitionParams, undefined)
    expect(subprocess.spawns).toHaveLength(1)
    const didOpens = subprocess.spawns[0].received.filter((message) => message.method === 'textDocument/didOpen')
    expect(didOpens.map((message) => message.params.textDocument.languageId)).toEqual(['typescript', 'javascript'])
  })

  it('capabilitiesOf returns the handshake capabilities without any document sync', async () => {
    const subprocess = fakeSubprocess({ capabilities: { renameProvider: true } })
    const manager = createManager(subprocess)
    const capabilities = await manager.capabilitiesOf('typescript', '/ws', 's1', undefined)
    expect(capabilities).toEqual({ renameProvider: true })
    expect(subprocess.spawns[0].received.map((message) => message.method)).toEqual(['initialize', 'initialized'])
    // a following requestOn syncs as usual
    await manager.requestOn('typescript', '/ws', target('/ws/a.ts'), 's1', 'textDocument/definition', definitionParams, undefined)
    expect(subprocess.spawns[0].received.map((message) => message.method)).toEqual([
      'initialize',
      'initialized',
      'textDocument/didOpen',
      'textDocument/definition',
    ])
  })

  it('dispose terminates every server', async () => {
    const subprocess = fakeSubprocess()
    const manager = createManager(subprocess)
    await manager.requestOn('typescript', '/ws', target('/ws/a.ts'), 's1', 'textDocument/definition', definitionParams, undefined)
    await manager.requestOn('python', '/ws', target('/ws/c.py'), 's1', 'textDocument/definition', definitionParams, undefined)
    expect(subprocess.spawns).toHaveLength(2)
    await manager.dispose()
    expect(subprocess.spawns[0].terminated).toBe(1)
    expect(subprocess.spawns[1].terminated).toBe(1)
  })

  it('setOptions applies new tuning values to later operations', async () => {
    const subprocess = fakeSubprocess()
    const manager = createManager(subprocess) // default idleMs 600_000
    await manager.requestOn('typescript', '/ws', target('/ws/a.ts'), 's1', 'textDocument/definition', definitionParams, undefined)
    manager.setOptions({ idleMs: 50 })
    // the next operation touches the record under the new idle window
    await manager.requestOn('typescript', '/ws', target('/ws/a.ts'), 's1', 'textDocument/definition', definitionParams, undefined)
    expect(subprocess.spawns).toHaveLength(1)
    await sleep(250)
    expect(subprocess.spawns[0].terminated).toBe(1)
  })

  it('setRegistry makes later operations resolve from the new registry', async () => {
    const subprocess = fakeSubprocess()
    const manager = createLspManager({ subprocess, fs: fakeFs(), registry: { typescript: REGISTRY.typescript } })
    await expect(async () => manager.requestOn('python', '/ws', target('/ws/c.py'), 's1', 'textDocument/definition', definitionParams, undefined)).rejects.toThrow(/no language server registered/)
    expect(subprocess.spawns).toHaveLength(0)
    manager.setRegistry({ ...REGISTRY })
    await manager.requestOn('python', '/ws', target('/ws/c.py'), 's1', 'textDocument/definition', definitionParams, undefined)
    expect(subprocess.spawns).toHaveLength(1)
    expect(subprocess.spawns[0].spec.argv[0]).toBe('/resolved/fake-py-server')
  })
})

describe('diagnosticsFor wait-once policy', () => {
  it('returns already-published diagnostics without waiting', async () => {
    const subprocess = fakeSubprocess({ publishDelayMs: 10 })
    const manager = createManager(subprocess, {}, { diagnosticsWaitMs: 5_000 })
    await manager.requestOn('typescript', '/ws', target('/ws/a.ts'), 's1', 'textDocument/definition', definitionParams, undefined)
    await sleep(50) // let the publish notification land
    // a wrong "always wait" implementation would burn the 5s window here
    const result = await within(250, manager.diagnosticsFor('typescript', '/ws', target('/ws/a.ts'), 's1', undefined))
    expect(result.uri).toBe('file:///ws/a.ts')
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0].message).toBe('fake error here')
  })

  it('waits once and picks up diagnostics published inside the window', async () => {
    const subprocess = fakeSubprocess({ publishDelayMs: 20 })
    const manager = createManager(subprocess, {}, { diagnosticsWaitMs: 120 })
    const result = await manager.diagnosticsFor('typescript', '/ws', target('/ws/a.ts'), 's1', undefined)
    expect(result.uri).toBe('file:///ws/a.ts')
    expect(result.diagnostics).toHaveLength(1)
    expect(result.diagnostics[0].message).toBe('fake error here')
  })

  it('returns an empty array when nothing is ever published', async () => {
    const subprocess = fakeSubprocess() // no publishDelayMs → never publishes
    const manager = createManager(subprocess, {}, { diagnosticsWaitMs: 60 })
    const result = await manager.diagnosticsFor('typescript', '/ws', target('/ws/a.ts'), 's1', undefined)
    expect(result.uri).toBe('file:///ws/a.ts')
    expect(result.diagnostics).toEqual([])
  })
})
