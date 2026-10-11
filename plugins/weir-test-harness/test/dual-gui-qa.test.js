// Self-check and teardown contract tests for the dual-GUI QA driver.
//
// These never boot a DSH server or a browser: they pin the pure decision
// surfaces (CLI/Chrome resolution, arg vectors, sanitization, reservation
// parsing, matrix recording) and exercise process/port teardown against real
// throwaway node children on loopback only. No network access, no leftover
// processes: every spawned child is killed inside its test's finally.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  allocateFreePorts,
  buildChromeArgs,
  buildPluginAddArgs,
  buildProfileInitArgs,
  buildServerArgs,
  createMatrix,
  fixtureSources,
  generationOf,
  createTokenGate,
  isPortListening,
  parseLaunchUrl,
  prepareQaRoot,
  readReservationOwner,
  resolveConfig,
  resolveChromePath,
  resolveDshInvocation,
  resolveNodeBinary,
  sanitizeText,
  settingsPatchSource,
  sha256File,
  stopChild,
  teardown,
  waitForPortClosed,
  PAGE_HELPERS_SOURCE,
} from '../src/dual-gui-qa.mjs'

const tmpdirs = []
function mkTmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dual-gui-qa-test-'))
  tmpdirs.push(dir)
  return fs.realpathSync.native(dir)
}
process.on('exit', () => {
  for (const dir of tmpdirs) fs.rmSync(dir, { recursive: true, force: true })
})

describe('sanitizeText', () => {
  it('redacts every occurrence of every secret', () => {
    assert.equal(sanitizeText('url ?token=abc then abc again', ['abc']), 'url ?token=REDACTED_TOKEN then REDACTED_TOKEN again')
  })
  it('renders objects and still redacts inside them', () => {
    const out = sanitizeText({ url: 'http://x/?token=sekret' }, ['sekret'])
    assert.ok(!out.includes('sekret'))
    assert.ok(out.includes('REDACTED_TOKEN'))
  })
  it('ignores empty secrets instead of exploding the text', () => {
    assert.equal(sanitizeText('plain', ['']), 'plain')
  })
})

describe('parseLaunchUrl', () => {
  it('extracts url and token from the readiness line', () => {
    const { url, token } = parseLaunchUrl('noise\ndsh web: http://127.0.0.1:31990/?token=TOK123\nmore')
    assert.equal(url, 'http://127.0.0.1:31990/?token=TOK123')
    assert.equal(token, 'TOK123')
  })
  it('throws without leaking anything when the line is absent', () => {
    assert.throws(() => parseLaunchUrl('token=hidden but no line'), /launch URL not found/)
    try { parseLaunchUrl('nope') } catch (error) { assert.ok(!error.message.includes('hidden')) }
  })
})

describe('generationOf', () => {
  it('parses compact JSON tool results', () => {
    assert.equal(generationOf('QA acquire succeeded: {"generation":2,"status":"active"}'), 2)
  })
  it('parses bare spellings', () => {
    assert.equal(generationOf('generation: 3'), 3)
    assert.equal(generationOf('generation=4'), 4)
  })
  it('returns null instead of guessing', () => {
    assert.equal(generationOf('no generation here'.replace('generation', 'gen')), null)
    assert.equal(generationOf(undefined), null)
  })
})

describe('resolveDshInvocation', () => {
  const node = '/fake/node'
  const envWithNode = { DUAL_GUI_NODE: node }
  it('honors DUAL_GUI_DSH_EXEC for a self-contained launcher', () => {
    const out = resolveDshInvocation({ env: { DUAL_GUI_DSH_EXEC: '/app/runtime/cli/bin/dsh' }, platform: 'darwin', fileExists: () => true })
    assert.deepEqual(out, { command: '/app/runtime/cli/bin/dsh', prefixArgs: [], description: '/app/runtime/cli/bin/dsh' })
  })
  it('runs a .js exec through node (the Windows/CI route, never a .cmd shim)', () => {
    const out = resolveDshInvocation({ env: { ...envWithNode, DUAL_GUI_DSH_EXEC: '/pkg/lib/bin.js' }, platform: 'win32', fileExists: () => true })
    assert.deepEqual(out, { command: node, prefixArgs: ['/pkg/lib/bin.js'], description: 'node /pkg/lib/bin.js' })
  })
  it('honors DUAL_GUI_DSH_BIN through node', () => {
    const out = resolveDshInvocation({ env: { ...envWithNode, DUAL_GUI_DSH_BIN: '/npm/lib/bin.js' }, platform: 'linux', fileExists: () => true })
    assert.deepEqual(out.prefixArgs, ['/npm/lib/bin.js'])
  })
  it('prefers the macOS app launcher by default on darwin', () => {
    const out = resolveDshInvocation({ env: {}, platform: 'darwin', fileExists: (p) => p.startsWith('/Applications/') })
    assert.equal(out.command, '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh')
  })
  it('prefers the npm-global lib/bin.js by default on win32', () => {
    const out = resolveDshInvocation({ env: { APPDATA: 'C:\\Users\\qa\\AppData\\Roaming' }, platform: 'win32', fileExists: () => true })
    assert.equal(out.prefixArgs[0], 'C:\\Users\\qa\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js')
  })
  it('fails loudly when nothing exists and the exec override is missing', () => {
    assert.throws(() => resolveDshInvocation({ env: {}, platform: 'linux', fileExists: () => false }), /no DSH CLI found/)
    assert.throws(() => resolveDshInvocation({ env: { DUAL_GUI_DSH_EXEC: '/gone' }, platform: 'linux', fileExists: () => false }), /DUAL_GUI_DSH_EXEC not found/)
  })
})

describe('resolveNodeBinary', () => {
  it('uses the env override when it exists', () => {
    assert.equal(resolveNodeBinary({ env: { DUAL_GUI_NODE: '/custom/node' }, fileExists: () => true }), '/custom/node')
  })
  it('falls back to process.execPath when nothing bundled exists', () => {
    assert.equal(resolveNodeBinary({ env: {}, fileExists: () => false }), process.execPath)
  })
})

describe('resolveChromePath', () => {
  it('honors DUAL_GUI_CHROME', () => {
    assert.equal(resolveChromePath({ env: { DUAL_GUI_CHROME: '/opt/chrome' }, fileExists: () => true }), '/opt/chrome')
  })
  it('picks the macOS app by default', () => {
    const out = resolveChromePath({ env: {}, platform: 'darwin', fileExists: (p) => p.includes('Google Chrome.app') })
    assert.equal(out, '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  })
  it('checks the linux candidates in order', () => {
    const out = resolveChromePath({ env: {}, platform: 'linux', fileExists: (p) => p === '/usr/bin/chromium' })
    assert.equal(out, '/usr/bin/chromium')
  })
  it('fails loudly with the tried list', () => {
    assert.throws(() => resolveChromePath({ env: {}, platform: 'linux', fileExists: () => false }), /no Chrome\/Chromium found/)
  })
})

describe('argument vectors', () => {
  it('buildServerArgs pins profile, patches, host, port and --no-open', () => {
    const args = buildServerArgs({ profile: 'dual-gui-a', patches: ['/qa/patch.yml'], port: 31990, prefixArgs: ['/cli/bin.js'] })
    // No 'web' positional: the profile (initialized from the web template) IS
    // the app; a positional is rejected with "too many arguments".
    assert.deepEqual(args, ['/cli/bin.js', '--profile', 'dual-gui-a', '--patch', '/qa/patch.yml', '--host', '127.0.0.1', '--port', '31990', '--no-open'])
  })
  it('buildChromeArgs isolates the profile dir and CDP port', () => {
    const args = buildChromeArgs({ cdpPort: 19226, userDataDir: '/qa/chrome-a' })
    assert.ok(args.includes('--remote-debugging-port=19226'))
    assert.ok(args.includes('--user-data-dir=/qa/chrome-a'))
    assert.ok(args.includes('--headless=new'))
    assert.equal(args.at(-1), 'about:blank')
  })
  it('buildPluginAddArgs matches the dsh plugin CLI grammar', () => {
    assert.deepEqual(buildPluginAddArgs({ profile: 'p', packageDir: '/bundle' }), ['plugin', '--profile', 'p', 'add', '/bundle'])
  })
  it('buildProfileInitArgs initializes from the shipped web template', () => {
    assert.deepEqual(buildProfileInitArgs({ profile: 'p' }), ['--profile', 'p', '--from-default-profile', 'web', '--dump-config'])
  })
})

describe('resolveConfig', () => {
  const env = { DUAL_GUI_DSH_EXEC: '/cli/dsh', DUAL_GUI_CHROME: '/bin/chrome', DUAL_GUI_NODE: '/bin/node' }
  const fileExists = () => true
  it('defaults to the core matrix under a fresh temp root', () => {
    const config = resolveConfig({ argv: [], env, fileExists })
    assert.equal(config.matrix, 'core')
    assert.ok(fs.existsSync(config.root))
    tmpdirs.push(config.root)
  })
  it('switches to heavy via flag or env', () => {
    const byFlag = resolveConfig({ argv: ['--heavy'], env, fileExists })
    const byEnv = resolveConfig({ argv: [], env: { ...env, DUAL_GUI_MATRIX: 'heavy' }, fileExists })
    tmpdirs.push(byFlag.root, byEnv.root)
    assert.equal(byFlag.matrix, 'heavy')
    assert.equal(byEnv.matrix, 'heavy')
  })
  it('rejects a missing weir-harness bundle', () => {
    // The stub must recognize the missing bundle under EITHER path separator:
    // on a win32 host path.join turns '/missing-weir-bundle' into
    // '\\missing-weir-bundle\\cordis.patch.yml', and a startsWith('/...')
    // predicate would silently report it present (run 38104930194).
    assert.throws(() => resolveConfig({ argv: [], env: { ...env, DUAL_GUI_WEIR: '/missing-weir-bundle' }, fileExists: (p) => !p.includes('missing-weir-bundle') }), /weir-harness bundle not found/)
  })
})

describe('ports', () => {
  it('allocateFreePorts returns distinct ports that are immediately bindable', async () => {
    const ports = await allocateFreePorts(4)
    assert.equal(new Set(ports).size, 4)
    for (const port of ports) {
      const server = net.createServer()
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve) })
      await new Promise((resolve) => server.close(() => resolve()))
    }
  })
  it('isPortListening and waitForPortClosed track a real loopback server', async () => {
    const server = net.createServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const port = server.address().port
    assert.equal(await isPortListening(port), true)
    server.close()
    assert.equal(await waitForPortClosed(port, { timeoutMs: 5000, intervalMs: 50 }), true)
  })
  it('waitForPortClosed times out on a live port', async () => {
    const server = net.createServer()
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      assert.equal(await waitForPortClosed(server.address().port, { timeoutMs: 300, intervalMs: 50 }), false)
    } finally {
      await new Promise((resolve) => server.close(() => resolve()))
    }
  })
})

describe('readReservationOwner', () => {
  it('returns null when no reservation exists', () => {
    assert.equal(readReservationOwner(mkTmp()), null)
  })
  it('returns null when the reservation dir has no owner.json yet', () => {
    const root = mkTmp()
    fs.mkdirSync(path.join(root, '.weir', '.edit-lock.publisher-reservation'), { recursive: true })
    assert.equal(readReservationOwner(root), null)
  })
  it('parses a valid owner document', () => {
    const root = mkTmp()
    const dir = path.join(root, '.weir', '.edit-lock.publisher-reservation')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'owner.json'), JSON.stringify({ schemaVersion: 1, pid: 25219, host: 'qa', acquiredAt: 1, leaseUntil: 2, ownerToken: 'tok', startIdentity: {} }))
    assert.equal(readReservationOwner(root).pid, 25219)
  })
  it('throws on a corrupt owner document instead of reading it as absent', () => {
    const root = mkTmp()
    const dir = path.join(root, '.weir', '.edit-lock.publisher-reservation')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'owner.json'), '{torn')
    assert.throws(() => readReservationOwner(root), /corrupt/)
    fs.writeFileSync(path.join(dir, 'owner.json'), '{"pid":"not-a-number"}')
    assert.throws(() => readReservationOwner(root), /pid/)
  })
})

describe('sha256File', () => {
  it('pins the known sha256 of the fixture content', () => {
    const file = path.join(mkTmp(), 'qa-shared.ts')
    fs.writeFileSync(file, 'export const shared = 1\n')
    // The proven manual dual-GUI run pinned this exact hash for the fixture's
    // initial content; the driver compares every phase against it.
    assert.equal(sha256File(file), 'd2a488b15c7ec1401666a191c9f765646bc30a3004b38ae5bd5d385cc5892cff')
    assert.match(sha256File(file), /^[0-9a-f]{64}$/)
  })
})

describe('fixtureSources', () => {
  it('bakes the workspace and homes in as literals and self-refuses elsewhere', () => {
    const sources = fixtureSources({ workspace: '/qa/root/ws', homes: ['/qa/root/home-a', '/qa/root/home-b'] })
    assert.ok(sources['index.js'].includes('const ROOT = "/qa/root/ws"'))
    assert.ok(sources['index.js'].includes('"/qa/root/home-a"'))
    assert.ok(sources['index.js'].includes("WEIR_QA_FIXTURE !== '1'"))
    assert.ok(sources['index.js'].includes('edit_lock_acquire'))
    assert.ok(sources['cordis.patch.yml'].includes('qa-edit-lock-operations'))
    const manifest = JSON.parse(sources['package.json'])
    assert.equal(manifest.private, true)
    // The generated fixture must be a syntactically valid ESM module.
    const dir = mkTmp()
    const file = path.join(dir, 'index.js')
    fs.writeFileSync(file, sources['index.js'])
    execFileSync(process.execPath, ['--check', file])
  })
})

describe('settingsPatchSource', () => {
  it('enables edit lock and disables auto-resume for the manual-Continue matrix', () => {
    const patch = settingsPatchSource()
    assert.ok(patch.includes('editLockEnabled: true'))
    assert.ok(patch.includes('editLockAutoResume: false'))
  })
})

describe('PAGE_HELPERS_SOURCE', () => {
  it('exposes the rpc/view/panel helpers and carries no credential material', () => {
    for (const name of ['rpc', 'view', 'panelState', 'openPanel', 'clickPrimary', 'openSessionRow']) {
      assert.ok(PAGE_HELPERS_SOURCE.includes(name), name)
    }
    assert.ok(!PAGE_HELPERS_SOURCE.includes('token='))
  })
})

describe('createMatrix', () => {
  it('records rows and splits PASS/FAIL', () => {
    const matrix = createMatrix()
    matrix.record('a', 'PASS', 'ok')
    matrix.record('b', 'FAIL', 'bad')
    matrix.record('c', 'SKIP', 'core matrix')
    assert.equal(matrix.passed.length, 1)
    assert.equal(matrix.failed.length, 1)
    assert.equal(matrix.rows.length, 3)
  })
})

describe('createTokenGate', () => {
  it('holds pre-arm chunks in memory so a token line never reaches the log', () => {
    const written = []
    const secrets = []
    // Mirrors the driver: write() sanitizes with the CURRENT secret list, and
    // arm() happens only after the token has been registered.
    const gate = createTokenGate((text) => written.push(sanitizeText(text, secrets)))
    gate.push('boot noise\n')
    gate.push('dsh web: http://127.0.0.1:1/?token=EARLYBIRD\n')
    assert.deepEqual(written, [])
    secrets.push('EARLYBIRD')
    gate.arm()
    gate.push('later line mentioning EARLYBIRD\n')
    assert.equal(written.length, 3)
    for (const line of written) assert.ok(!line.includes('EARLYBIRD'), line)
    assert.ok(written[1].includes('REDACTED_TOKEN'))
    assert.ok(written[2].includes('REDACTED_TOKEN'))
  })
  it('streams immediately once armed and arm is idempotent', () => {
    const written = []
    const gate = createTokenGate((text) => written.push(text))
    gate.arm()
    gate.arm()
    gate.push('x')
    assert.deepEqual(written, ['x'])
  })
})

describe('prepareQaRoot', () => {
  it('materializes the workspace, fixture and patch, and accepts an isolated root', () => {
    const root = mkTmp()
    const paths = prepareQaRoot({ root })
    assert.ok(fs.existsSync(paths.sharedFile))
    assert.ok(fs.existsSync(path.join(paths.fixture, 'index.js')))
    assert.ok(fs.existsSync(paths.settingsPatch))
    assert.equal(fs.readFileSync(paths.sharedFile, 'utf8'), 'export const shared = 1\n')
  })
  it('refuses a workspace whose management root escapes the disposable dir', () => {
    // A git checkout above the workspace turns managementRootFor(ws) into the
    // repo top: the driver must refuse rather than bind the live repository.
    const root = mkTmp()
    execFileSync('git', ['init', '-q', root])
    const paths = { root }
    assert.throws(() => prepareQaRoot(paths), /management root escapes/)
  })
})

/** Spawn a node child that listens on a fresh port; kill helper for tests. */
async function spawnListener() {
  const portProbe = net.createServer()
  await new Promise((resolve) => portProbe.listen(0, '127.0.0.1', resolve))
  const port = portProbe.address().port
  await new Promise((resolve) => portProbe.close(() => resolve()))
  const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${port}, '127.0.0.1')`], { stdio: 'ignore' })
  await new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000
    const poll = async () => {
      if (await isPortListening(port)) return resolve()
      if (child.exitCode !== null) return reject(new Error('listener child exited'))
      if (Date.now() > deadline) return reject(new Error('listener child did not bind'))
      setTimeout(poll, 50)
    }
    poll()
  })
  return { child, port }
}

describe('stopChild', () => {
  it('stops a cooperative child gracefully (SIGINT on POSIX, TerminateProcess on win32)', async () => {
    const { child } = await spawnListener()
    const sent = []
    try {
      const result = await stopChild(child, { graceMs: 5000, kill: (c, s) => { sent.push(s); c.kill(s) } })
      if (process.platform === 'win32') {
        // No POSIX signals exist on win32: SIGTERM maps to TerminateProcess,
        // which is an immediate kill, so the stop is reported non-graceful.
        assert.deepEqual(sent, ['SIGTERM'])
        assert.equal(result.graceful, false)
      } else {
        assert.deepEqual(sent, ['SIGINT'])
        assert.equal(result.graceful, true)
      }
      assert.equal(child.exitCode !== null || child.signalCode !== null, true)
    } finally {
      child.kill('SIGKILL')
    }
  })
  it('reports an already-exited child without signalling it', async () => {
    const { child } = await spawnListener()
    try {
      child.kill('SIGKILL')
      await new Promise((resolve) => child.once('exit', resolve))
      const result = await stopChild(child)
      assert.equal(result.alreadyExited, true)
    } finally {
      child.kill('SIGKILL')
    }
  })
  it('never sends SIGINT on win32 and reports non-graceful termination', async () => {
    const { child } = await spawnListener()
    const sent = []
    try {
      const result = await stopChild(child, { platform: 'win32', graceMs: 5000, kill: (c, s) => { sent.push(s); c.kill(s) } })
      assert.deepEqual(sent, ['SIGTERM'])
      assert.equal(result.graceful, false)
    } finally {
      child.kill('SIGKILL')
    }
  })
  it('escalates to SIGKILL when a child ignores graceful signals', { skip: process.platform === 'win32' ? 'TerminateProcess cannot be ignored on win32; the win32 escalation branch is covered deterministically below' : false }, async () => {
    const portProbe = net.createServer()
    await new Promise((resolve) => portProbe.listen(0, '127.0.0.1', resolve))
    const port = portProbe.address().port
    await new Promise((resolve) => portProbe.close(() => resolve()))
    const child = spawn(process.execPath, ['-e', `process.on('SIGINT', () => {}); process.on('SIGTERM', () => {}); require('net').createServer().listen(${port}, '127.0.0.1')`], { stdio: 'ignore' })
    // Wait until the child has installed its signal handlers and bound the
    // port, otherwise the first SIGINT races the handler registration.
    const deadline = Date.now() + 5000
    while (!(await isPortListening(port)) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))
    try {
      const result = await stopChild(child, { graceMs: 300 })
      assert.equal(result.forced, true)
      assert.equal(result.graceful, false)
      // stopChild already observed the exit; awaiting the one-shot event again
      // would hang if it fired inside the escalation wait.
      if (child.exitCode === null && child.signalCode === null) await new Promise((resolve) => child.once('exit', resolve))
    } finally {
      child.kill('SIGKILL')
    }
  })
  // Escalation timing without a real process: a fake child that never exits
  // makes the kill sequence deterministic on every host (a win32 child cannot
  // ignore TerminateProcess, so a real-process win32 variant cannot exist).
  const neverExits = () => ({ exitCode: null, signalCode: null, once() { return this } })
  it('escalates SIGINT -> SIGTERM -> SIGKILL for a stuck child on POSIX', async () => {
    const sent = []
    const result = await stopChild(neverExits(), { platform: 'linux', graceMs: 50, kill: (c, s) => { sent.push(s) } })
    assert.deepEqual(sent, ['SIGINT', 'SIGTERM', 'SIGKILL'])
    assert.equal(result.forced, true)
    assert.equal(result.graceful, false)
  })
  it('escalates SIGTERM -> SIGKILL for a stuck child on win32 (never SIGINT)', async () => {
    const sent = []
    const result = await stopChild(neverExits(), { platform: 'win32', graceMs: 50, kill: (c, s) => { sent.push(s) } })
    assert.deepEqual(sent, ['SIGTERM', 'SIGKILL'])
    assert.equal(result.forced, true)
    assert.equal(result.graceful, false)
  })
})

describe('teardown', () => {
  const fakePaths = (root) => ({ ws: path.join(root, 'ws') })

  it('stops every child and verifies every port closes', async () => {
    const root = mkTmp()
    fs.mkdirSync(fakePaths(root).ws, { recursive: true })
    const one = await spawnListener()
    const two = await spawnListener()
    const matrix = createMatrix()
    const instances = [
      { name: 'a', ports: { web: one.port, cdp: two.port }, stop: () => stopChild(one.child, { graceMs: 5000 }) },
      { name: 'b', ports: { web: two.port, cdp: one.port }, stop: () => stopChild(two.child, { graceMs: 5000 }) },
    ]
    try {
      const problems = await teardown(instances, { portTimeoutMs: 2000 }, fakePaths(root), matrix)
      assert.deepEqual(problems, [])
      assert.equal(matrix.rows.at(-1).status, 'PASS')
      assert.equal(await isPortListening(one.port), false)
      assert.equal(await isPortListening(two.port), false)
    } finally {
      one.child.kill('SIGKILL')
      two.child.kill('SIGKILL')
    }
  })

  it('fails on a leftover reservation and NEVER deletes it', async () => {
    const root = mkTmp()
    const reservation = path.join(fakePaths(root).ws, '.weir', '.edit-lock.publisher-reservation')
    fs.mkdirSync(reservation, { recursive: true })
    fs.writeFileSync(path.join(reservation, 'owner.json'), JSON.stringify({ pid: 424242 }))
    const one = await spawnListener()
    const matrix = createMatrix()
    // Gracefulness is an injected seam here, not a host signal property: the
    // child is really stopped (ports must close), but the reported result is
    // pinned graceful so the reservation-absence assertion runs on EVERY
    // host. On win32 a real stopChild reports graceful:false (TerminateProcess
    // cannot drain), which would silently skip the red leftover verdict.
    const instances = [
      { name: 'a', ports: { web: one.port, cdp: one.port }, stop: async () => { await stopChild(one.child, { graceMs: 5000 }); return { graceful: true } } },
    ]
    try {
      const problems = await teardown(instances, { portTimeoutMs: 2000 }, fakePaths(root), matrix)
      assert.equal(problems.length, 1)
      assert.match(problems[0], /reservation still present/)
      assert.equal(matrix.rows.at(-1).status, 'FAIL')
      // The hard invariant: teardown observed the leftover, it did not remove it.
      assert.ok(fs.existsSync(path.join(reservation, 'owner.json')))
    } finally {
      one.child.kill('SIGKILL')
    }
  })

  it('never deletes a leftover reservation after a forced stop (win32 contract)', async () => {
    const root = mkTmp()
    const reservation = path.join(fakePaths(root).ws, '.weir', '.edit-lock.publisher-reservation')
    fs.mkdirSync(reservation, { recursive: true })
    fs.writeFileSync(path.join(reservation, 'owner.json'), JSON.stringify({ pid: 424242 }))
    const one = await spawnListener()
    const matrix = createMatrix()
    // The forced-stop contract: TerminateProcess (win32) or an escalated
    // SIGKILL (POSIX) legitimately strands the reservation, so the absence
    // assertion is reported not-applicable — but the leftover is STILL never
    // deleted, on any platform.
    const instances = [
      { name: 'a', ports: { web: one.port, cdp: one.port }, stop: async () => { await stopChild(one.child, { graceMs: 5000 }); return { graceful: false } } },
    ]
    try {
      const problems = await teardown(instances, { portTimeoutMs: 2000, platform: 'win32' }, fakePaths(root), matrix)
      assert.deepEqual(problems, [])
      assert.equal(matrix.rows.at(-1).status, 'PASS')
      assert.match(matrix.rows.at(-1).detail, /forced stop \(win32\)/)
      assert.match(matrix.rows.at(-1).detail, /never deleted/)
      assert.ok(fs.existsSync(path.join(reservation, 'owner.json')))
    } finally {
      one.child.kill('SIGKILL')
    }
  })

  it('reports a port that refuses to close', async () => {
    const root = mkTmp()
    fs.mkdirSync(fakePaths(root).ws, { recursive: true })
    const one = await spawnListener()
    const matrix = createMatrix()
    // The instance claims to stop but the port stays bound (stop is a no-op).
    const instances = [
      { name: 'a', ports: { web: one.port, cdp: one.port }, stop: async () => ({ graceful: true }) },
    ]
    try {
      const problems = await teardown(instances, { portTimeoutMs: 400 }, fakePaths(root), matrix)
      assert.ok(problems.some((problem) => problem.includes('still listening')))
      assert.equal(matrix.rows.at(-1).status, 'FAIL')
    } finally {
      one.child.kill('SIGKILL')
    }
  })
})
