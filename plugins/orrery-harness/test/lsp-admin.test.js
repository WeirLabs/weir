import { describe, expect, it } from './helpers.js'
import { PassThrough } from 'node:stream'
import { apply, errorResponse, jsonResponse, lspStatusFor, probeVersion, readJsonBody, runInstall } from '../src/lsp/admin.js'
import { DEFAULT_SERVERS, displayInstallCommand, installSpecFor } from '../src/lsp/registry.js'
import { augmentedPath, npmGlobalPrefix } from '../src/lsp/child-process.js'
import { spawnArgv } from '../src/lsp/child-process.js'

/**
 * What the double's resolver hands back. The launch shape is then the shipped
 * one (`spawnArgv`), so these assertions fail if a spawn site stops routing
 * through it — they do not reimplement the shape's own logic.
 */
const resolvedAs = (command) => `/resolved/${command}`

/** True when the spec's argv is exactly what the shipped launch shape produces. */
const launched = (spec, executable, args) => JSON.stringify(spec.argv) === JSON.stringify(spawnArgv(executable, args))

function fakeSubprocess({ present = ['npm'], versions = {} } = {}) {
  const spawns = []
  return {
    spawns,
    resolveExecutable: async (command) => {
      if (!present.includes(command)) throw new Error(`${command} not found`)
      return resolvedAs(command)
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
    const servers = await lspStatusFor(DEFAULT_SERVERS, subprocess, { probeTimeoutMs: 40, dirs: [] })
    expect(servers).toHaveLength(Object.keys(DEFAULT_SERVERS).length)
    const typescript = servers.find((server) => server.family === 'typescript')
    expect(typescript.installed).toBe(true)
    expect(typescript.installCommand).toBe('npm install -g typescript-language-server typescript')
    expect(typescript.languageIds).toContain('typescript')
    const lua = servers.find((server) => server.family === 'lua')
    expect(lua.installed).toBe(false)
    expect(lua.installCommand).toBe(displayInstallCommand(DEFAULT_SERVERS.lua, process.platform))
    expect(lua.installerAvailable).toBe(false)
    expect(typescript.installerAvailable).toBe(false) // npm not present in the fake
    // version probes consumed the spawned handles (any present command resolves)
    expect(subprocess.spawns.length).toBeGreaterThanOrEqual(2)
  })

  it('probeVersion returns the first plausible output line and null on garbage', async () => {
    const subprocess = fakeSubprocess()
    const pending = probeVersion(subprocess, '/resolved/npm', ['--version'])
    subprocess.spawns[0].finish(0, ['10.2.3', 'extra'])
    expect(await pending).toBe('10.2.3')
    const empty = probeVersion(subprocess, '/resolved/npm', ['--version'])
    subprocess.spawns[1].finish(0, [])
    expect(await empty).toBe(null)
    // stack traces from servers without --version support are not versions
    const garbage = probeVersion(subprocess, '/resolved/npm', ['--version'])
    subprocess.spawns[2].stderr.write('/Users/x/.npm-global/lib/node_modules/vscode-langservers-extracted/node_modules/vscode-languageserver/lib/node/main.js:214\n')
    subprocess.spawns[2].finish(0, ['  throw new Error(\'Connection input stream is not set\')'])
    expect(await garbage).toBe(null)
    // gopls-style module paths with a version are still accepted
    const gopls = probeVersion(subprocess, '/resolved/gopls', ['version'])
    subprocess.spawns[3].finish(0, ['golang.org/x/tools/gopls v0.16.2'])
    expect(await gopls).toBe('golang.org/x/tools/gopls v0.16.2')
    // empty versionArgs skip the probe entirely
    expect(await probeVersion(subprocess, '/resolved/x', [])).toBe(null)
  })

  it('runInstall validates families and installer availability', async () => {
    const subprocess = fakeSubprocess()
    await expect(async () => runInstall(DEFAULT_SERVERS, subprocess, 'bogus', undefined, [])).rejects.toThrow(/unknown language family/)
    // a family whose entry carries no install spec for this platform
    const custom = { command: 'custom-ls', installHint: 'see the docs' }
    await expect(async () => runInstall({ custom }, subprocess, 'custom', undefined, [])).rejects.toThrow(/no installer/)
    // the installer that IS selected for a family is the host platform's: win32
    // resolves via npm/pipx/go on the PATH, macOS/Linux via brew or apt
    const cpp = installSpecFor(DEFAULT_SERVERS.cpp)
    if (cpp) {
      await expect(async () => runInstall(DEFAULT_SERVERS, subprocess, 'cpp', undefined, [])).rejects.toThrow(`installer '${cpp.command}' not found`)
    }
  })

  it('runInstall captures output and normalizes the exit code', async () => {
    const subprocess = fakeSubprocess({ present: ['npm'] })
    const pending = runInstall(DEFAULT_SERVERS, subprocess, 'typescript', 5_000, [])
    await new Promise((resolve) => setImmediate(resolve))
    const handle = subprocess.spawns[0]
    // npm installs pin a user-writable prefix (root-owned /usr/local → EACCES)
    const installer = resolvedAs('npm')
    const installArgs = ['--prefix', npmGlobalPrefix(), 'install', '-g', 'typescript-language-server', 'typescript']
    // the installer goes through the shipped launch shape (on win32 that means
    // the resolved .cmd is unwrapped or wrapped — never handed to CreateProcess raw)
    expect(launched(handle.spec, installer, installArgs)).toBe(true)
    expect(handle.spec.argv).toContain('--prefix')
    expect(handle.spec.argv).toContain(npmGlobalPrefix())
    expect(handle.spec.argv.slice(-4)).toEqual(['install', '-g', 'typescript-language-server', 'typescript'])
    // the child env carries the augmented PATH so `env node` scripts resolve
    expect(handle.spec.env.PATH).toBe(augmentedPath())
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
    const pending = runInstall(DEFAULT_SERVERS, subprocess, 'typescript', 30, [])
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
    apply(ctx, { dirs: [] })
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

  it('serves a live custom registry through the provider and installs custom families', async () => {
    const endpoints = []
    const subprocess = fakeSubprocess({ present: ['npm'] })
    const ctx = {
      get: (name) => (name === 'connection' ? { fetch: { register: (definition) => {
        endpoints.push(definition)
        return () => {}
      } } } : name === 'subprocess' ? subprocess : undefined),
    }
    let custom = {
      zig: { command: 'zls', args: [], installHint: 'npm install -g zls', install: { command: 'npm', args: ['install', '-g', 'zls'] } },
    }
    apply(ctx, { dirs: [], registry: () => ({ ...DEFAULT_SERVERS, ...custom }) })

    // the custom family appears in status with its install command
    const statusBody = JSON.parse(await (await endpoints[0].fetch(fakeRequest({}))).text())
    const zig = statusBody.value.servers.find((server) => server.family === 'zig')
    expect(zig).toBeTruthy()
    expect(zig.installed).toBe(false)
    expect(zig.installCommand).toBe('npm install -g zls')
    expect(zig.installerAvailable).toBe(true)

    // installing the custom family runs its own install spec
    const installPending = endpoints[1].fetch(fakeRequest({ family: 'zig' }))
    await new Promise((resolve) => setImmediate(resolve))
    subprocess.spawns[0].finish(0, ['zls added'])
    const installBody = JSON.parse(await (await installPending).text())
    expect(installBody.ok).toBe(true)
    expect(installBody.value.output).toContain('zls added')

    // dropping the custom entry removes it from the live catalog
    custom = {}
    const statusBody2 = JSON.parse(await (await endpoints[0].fetch(fakeRequest({}))).text())
    expect(statusBody2.value.servers.some((server) => server.family === 'zig')).toBe(false)
  })
})

describe('wireLspAdmin', () => {
  it('wires the endpoints through the inject tuple when connection/subprocess exist', async () => {
    const { wireLspAdmin } = await import('../src/lsp/admin.js')
    const endpoints = []
    let injectCallback
    const ctx = {
      inject: (dependencies, callback) => {
        injectCallback = { dependencies, callback }
        // simulate the injection resolving: the scope carries direct props
        const scope = {
          connection: { fetch: { register: (definition) => {
            endpoints.push(definition)
            return () => {}
          } } },
          subprocess: { spawns: [] },
        }
        callback(scope)
        return () => {}
      },
    }
    const dispose = wireLspAdmin(ctx, () => undefined)
    expect(injectCallback.dependencies).toEqual(['connection', 'subprocess'])
    expect(endpoints.map((definition) => definition.path)).toEqual(['/api/orrery-lsp/status', '/api/orrery-lsp/install'])
    expect(typeof dispose).toBe('function')
    dispose()
    dispose() // idempotent
  })

  it('registers nothing and disposes harmlessly when inject is absent', async () => {
    const { wireLspAdmin } = await import('../src/lsp/admin.js')
    const dispose = wireLspAdmin({}, () => undefined)
    expect(typeof dispose).toBe('function')
    dispose() // no throw
  })
})
