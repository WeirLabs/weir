import { describe, expect, it } from './helpers.js'
import { PassThrough } from 'node:stream'
import { apply, errorResponse, jsonResponse, lspStatusFor, probeVersion, readJsonBody, runInstall } from '../src/lsp/admin.js'
import { DEFAULT_SERVERS } from '../src/lsp/registry.js'

function fakeSubprocess({ present = ['npm'], versions = {} } = {}) {
  const spawns = []
  return {
    spawns,
    resolveExecutable: async (command) => {
      if (!present.includes(command)) throw new Error(`${command} not found`)
      return `/resolved/${command}`
    },
    spawn(spec) {
      const stdin = new PassThrough()
      const stdout = new PassThrough()
      const stderr = new PassThrough()
      let terminated = 0
      let resolveDone
      const done = new Promise((resolve) => {
        resolveDone = resolve
      })
      const handle = {
        stdin,
        stdout,
        stderr,
        done,
        spec,
        terminate: () => {
          terminated++
          resolveDone({ exitCode: null })
        },
        get terminated() {
          return terminated
        },
        finish(exitCode = 0, lines = []) {
          for (const line of lines) stdout.write(line + '\n')
          resolveDone({ exitCode })
        },
      }
      spawns.push(handle)
      return handle
    },
  }
}

function fakeRequest(body) {
  return {
    json: async () => body,
  }
}

describe('lsp admin pure logic', () => {
  it('lspStatusFor reports installed/missing per family with versions', async () => {
    const subprocess = fakeSubprocess({ present: ['typescript-language-server', 'gopls'] })
    const servers = await lspStatusFor(DEFAULT_SERVERS, subprocess, { probeTimeoutMs: 40 })
    expect(servers).toHaveLength(Object.keys(DEFAULT_SERVERS).length)
    const typescript = servers.find((server) => server.family === 'typescript')
    expect(typescript.installed).toBe(true)
    expect(typescript.installCommand).toBe('npm install -g typescript-language-server typescript')
    expect(typescript.languageIds).toContain('typescript')
    const lua = servers.find((server) => server.family === 'lua')
    expect(lua.installed).toBe(false)
    expect(lua.installCommand).toBe('brew install lua-language-server')
    // version probes consumed the spawned handles (any present command resolves)
    expect(subprocess.spawns.length).toBeGreaterThanOrEqual(2)
  })

  it('probeVersion returns the first output line and null on empty output', async () => {
    const subprocess = fakeSubprocess()
    const pending = probeVersion(subprocess, '/resolved/npm', ['--version'])
    subprocess.spawns[0].finish(0, ['10.2.3', 'extra'])
    expect(await pending).toBe('10.2.3')
    const empty = probeVersion(subprocess, '/resolved/npm', ['--version'])
    subprocess.spawns[1].finish(0, [])
    expect(await empty).toBe(null)
  })

  it('runInstall validates families and installer availability', async () => {
    const subprocess = fakeSubprocess()
    await expect(async () => runInstall(DEFAULT_SERVERS, subprocess, 'bogus')).rejects.toThrow(/unknown language family/)
    // a family whose entry carries no install spec for this platform
    const custom = { command: 'custom-ls', installHint: 'see the docs' }
    await expect(async () => runInstall({ custom }, subprocess, 'custom')).rejects.toThrow(/no installer/)
    await expect(async () => runInstall(DEFAULT_SERVERS, subprocess, 'cpp')).rejects.toThrow(/installer 'brew' not found/)
  })

  it('runInstall captures output and normalizes the exit code', async () => {
    const subprocess = fakeSubprocess({ present: ['npm'] })
    const pending = runInstall(DEFAULT_SERVERS, subprocess, 'typescript')
    await new Promise((resolve) => setImmediate(resolve))
    const handle = subprocess.spawns[0]
    expect(handle.spec.argv).toEqual(['/resolved/npm', 'install', '-g', 'typescript-language-server', 'typescript'])
    handle.stderr.write('warning line\n')
    handle.finish(0, ['added 2 packages'])
    const result = await pending
    expect(result.exitCode).toBe(0)
    expect(result.timedOut).toBe(false)
    expect(result.output).toContain('warning line')
    expect(result.output).toContain('added 2 packages')
  })

  it('runInstall terminates on timeout', async () => {
    const subprocess = fakeSubprocess({ present: ['npm'] })
    const pending = runInstall(DEFAULT_SERVERS, subprocess, 'typescript', 30)
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setTimeout(resolve, 60))
    const result = await pending
    expect(result.timedOut).toBe(true)
    expect(result.exitCode).toBe(null)
    expect(subprocess.spawns[0].terminated).toBe(1)
  })

  it('readJsonBody parses json requests and rejects garbage', async () => {
    expect(await readJsonBody(fakeRequest({ family: 'lua' }))).toEqual({ family: 'lua' })
    expect(await readJsonBody(fakeRequest(null))).toBe(null)
  })

  it('jsonResponse and errorResponse carry the wire shape', () => {
    const ok = jsonResponse({ ok: true, value: { x: 1 } })
    expect(ok.status).toBe(200)
    expect(ok.headers.get('content-type')).toContain('application/json')
    const bad = errorResponse('nope')
    expect(bad.status).toBe(400)
  })
})

describe('lsp admin plugin', () => {
  it('mounts harmlessly without connection/subprocess', () => {
    const ctx = { get: () => undefined, logger: { warn: () => {} } }
    apply(ctx) // must not throw
  })

  it('registers status and install endpoints when services exist', async () => {
    const endpoints = []
    const subprocess = fakeSubprocess({ present: ['npm'] })
    const ctx = {
      get: (name) => (name === 'connection' ? { fetch: { register: (definition) => endpoints.push(definition) } } : name === 'subprocess' ? subprocess : undefined),
    }
    apply(ctx)
    expect(endpoints.map((definition) => definition.path)).toEqual(['/api/orrery-lsp/status', '/api/orrery-lsp/install'])

    // status endpoint returns the catalog
    const statusResponse = await endpoints[0].fetch(fakeRequest({}))
    const statusBody = JSON.parse(await statusResponse.text())
    expect(statusBody.ok).toBe(true)
    expect(statusBody.value.servers.some((server) => server.family === 'cpp')).toBe(true)

    // install endpoint: bad body → 400; bad family → 400
    const badBody = await endpoints[1].fetch(fakeRequest({}))
    expect(badBody.status).toBe(400)
    const badFamily = await endpoints[1].fetch(fakeRequest({ family: 'bogus' }))
    expect(badFamily.status).toBe(400)

    // install endpoint: valid family runs and reports output
    const pending = endpoints[1].fetch(fakeRequest({ family: 'typescript' }))
    await new Promise((resolve) => setImmediate(resolve))
    subprocess.spawns[0].finish(0, ['done'])
    const installResponse = await pending
    const installBody = JSON.parse(await installResponse.text())
    expect(installBody.ok).toBe(true)
    expect(installBody.value.exitCode).toBe(0)
    expect(installBody.value.output).toContain('done')
  })
})
