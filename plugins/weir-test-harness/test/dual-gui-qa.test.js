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
import { runInNewContext } from 'node:vm'
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
  renameFixtureSources,
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
  GuiInstance,
  assertEndpoint,
  assertPhaseExceptions,
  verifyPanelShots,
  verifyOptOutShots,
  assertFreshRestart,
  writeReport,
  assertRefusalDelta,
  waitGuiCommand,
} from '../src/dual-gui-qa.mjs'
import { managementRootFor } from '../../weir-harness/src/edit-lock/domains.js'

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
  it('selects the opt-out matrix only when explicitly requested', () => {
    const config = resolveConfig({ argv: ['--opt-out'], env, fileExists })
    tmpdirs.push(config.root)
    assert.equal(config.matrix, 'opt-out')
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

describe('dispatched refusal evidence', () => {
  it('rejects a domain/pre-dispatch denial or changed bytes as a false positive', () => {
    const cwd = mkTmp(), target = path.join(cwd, 'target.ts'), sessionId = 'session-1'
    fs.writeFileSync(target, 'stable\n')
    const beforeBytes = fs.readFileSync(target)
    const before = { locks: [], operations: [{ phase: 'created' }] }
    const lock = { resourceId: target, owner: sessionId, generation: 1 }
    const op = { phase: 'unknown', sessionId, binding: { cwd }, fence: { kind: 'resource', resourceId: target } }
    const input = { before, after: { locks: [lock], operations: [...before.operations, op] }, target, sessionId, cwd, beforeBytes }
    assert.deepEqual(assertRefusalDelta(input), { generation: 1 })
    assert.throws(() => assertRefusalDelta({ ...input, after: { ...input.after, operations: [...before.operations, { ...op, phase: 'not-published' }] } }), /dispatched unknown/)
    assert.throws(() => assertRefusalDelta({ ...input, after: { ...input.after, operations: [...before.operations, { ...op, fence: null }] } }), /resource fence/)
    assert.throws(() => assertRefusalDelta({ ...input, after: { ...input.after, locks: [] } }), /retain ownership/)
    fs.writeFileSync(target, 'changed\n')
    assert.throws(() => assertRefusalDelta(input), /changed target bytes/)
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
  it('carries the pause and midbatch-rename verbs plus the armed writeText fault', () => {
    const sources = fixtureSources({ workspace: '/qa/root/ws', homes: [] })
    const index = sources['index.js']
    assert.ok(index.includes('edit_lock_pause'), 'pause verb')
    assert.ok(index.includes('rename-midbatch'), 'rename-midbatch verb')
    assert.ok(index.includes('lsp_rename'), 'real lsp_rename tool call')
    assert.ok(index.includes('lsp_symbols'), 'document outline precedes the rename')
    assert.ok(index.includes('MIDBATCH_FILES'), 'midbatch fault targets baked in')
    assert.ok(index.includes('ctx.fs.writeText'), 'wraps the real host writeText')
    assert.ok(index.includes("inject = ['agents', 'commands', 'tools', 'fs']"), 'fs service injected')
    // The verb splitter regex must survive template escaping (\s, not s).
    assert.ok(index.includes('split(/\\s+/)'), 'whitespace split survived codegen')
    assert.ok(index.includes('QA midbatch fault'), 'deterministic second-file fault')
  })
  it('arms a single post-write acknowledgement loss on a separate unknown fixture', () => {
    const source = fixtureSources({ workspace: '/qa/root/ws', homes: [] })['index.js']
    assert.ok(source.includes('write-unknown'))
    assert.ok(source.includes('await writeText.call(this, target, ...rest)'))
    assert.ok(source.includes('QA publisher acknowledgement lost AFTER the write'))
    assert.ok(source.includes(`const UNKNOWN_FILE = ${JSON.stringify(path.join('/qa/root/ws', 'qa-unknown.ts'))}`))
    assert.equal(renameFixtureSources()['qa-unknown.ts'], 'export const unknown = 1\n')
  })
  it('rejects non-bare file arguments inside the fixture', () => {
    const index = fixtureSources({ workspace: '/qa/root/ws', homes: [] })['index.js']
    assert.ok(index.includes('Only bare fixture file names are allowed'))
    const literal = index.match(/\^\[A-Za-z0-9\].*?\*\$/)?.[0]
    assert.ok(literal, 'the fixture name gate must be anchored')
    const bare = new RegExp(literal)
    assert.equal(bare.test('cas-target.ts'), true)
    assert.equal(bare.test('..'), false)
    assert.equal(bare.test('../escape'), false)
  })
  it('passes through raw backend refusal without inventing a stock-tool marker', () => {
    const fixture = fixtureSources({ workspace: '/qa/root/ws', homes: [] })['index.js']
    assert.ok(fixture.includes("result.error?.message ?? 'unknown'"))
    assert.ok(!fixture.includes('[sandbox: file access denied under workspace-write mode]'))
    const driver = fs.readFileSync(fileURLToPath(new URL('../src/dual-gui-qa.mjs', import.meta.url)), 'utf8')
    assert.ok(driver.includes('refused.text.includes(\'[sandbox:\')'))
    assert.ok(driver.includes('outside management domain'))
    assert.ok(driver.includes('file access denied under workspace-write mode$'))
  })
})

describe('settingsPatchSource', () => {
  it('enables edit lock and disables auto-resume for the manual-Continue matrix', () => {
    const patch = settingsPatchSource()
    assert.ok(patch.includes('editLockEnabled: true'))
    assert.ok(patch.includes('editLockAutoResume: false'))
  })
  it('points the typescript family at the workspace mock LSP server when given one', () => {
    const patch = settingsPatchSource({ workspace: '/qa/root/ws' })
    assert.ok(patch.includes('lspEnabled: true'), 'capability gate on')
    assert.ok(patch.includes('lspServers: !!js'), 'server map evaluated in the server process')
    assert.ok(patch.includes(JSON.stringify(path.join('/qa/root/ws', 'mock-lsp-server.js'))), 'native mock server path baked in')
    assert.ok(patch.includes('process.execPath'), 'runtime node launches the mock')
  })
  it('escapes a Windows mock-server path into a valid loader JavaScript expression', () => {
    const winPath = 'C:\\qa\\root\\ws'
    const expected = path.win32.join(winPath, 'mock-lsp-server.js')
    const patch = settingsPatchSource({ workspace: winPath, platform: 'win32' })
    assert.ok(patch.includes(JSON.stringify(expected)), 'literal path must survive JS string parsing on win32')
    assert.equal(JSON.parse(Function(`return JSON.stringify(${patch.match(/JSON.stringify\((.*)\)/)?.[1]})`)()).typescript.args[0], expected)
  })
  it('keeps the LSP overlay out when no workspace is given', () => {
    const patch = settingsPatchSource()
    assert.ok(!patch.includes('lspServers'))
  })
  it('keeps the settings namespace writable for the opt-out matrix', () => {
    const patch = settingsPatchSource({ workspace: '/qa/ws', editable: true })
    assert.ok(!patch.includes('id: weir-settings'))
    assert.ok(patch.includes('ui-settings-general'))
  })
})

describe('saved-off acceptance contract', () => {
  it('requires actual shutdown and fresh PID rather than treating recomposition as restart', () => {
    assert.throws(() => assertFreshRestart({ previousPid: 101, nextPid: 101, exitCode: null, signalCode: null }), /different process/)
    assert.throws(() => assertFreshRestart({ previousPid: 101, nextPid: 102, exitCode: null, signalCode: null }), /exit/)
    assert.doesNotThrow(() => assertFreshRestart({ previousPid: 101, nextPid: 102, exitCode: 0, signalCode: null }))
  })
})

describe('PAGE_HELPERS_SOURCE', () => {
  it('exposes the rpc/view/panel helpers and carries no credential material', () => {
    for (const name of ['rpc', 'view', 'panelState', 'openPanel', 'clickPrimary', 'openSessionRow']) {
      assert.ok(PAGE_HELPERS_SOURCE.includes(name), name)
    }
    assert.ok(!PAGE_HELPERS_SOURCE.includes('token='))
  })
  it('exposes the theme and panel-marker helpers for the panel-states phases', () => {
    for (const name of ['theme', 'panelMarkers', 'pausedClockMatches', 'data-weir-edit-lock-paused-until', 'data-weir-edit-lock-cleanup', 'data-weir-edit-lock-ownership-hint']) {
      assert.ok(PAGE_HELPERS_SOURCE.includes(name), name)
    }
  })
  it('requires switch warning, maintenance state and screenshot framing helpers', () => {
    for (const name of ['settingsStep', 'frameOptOut', 'data-group="editing"', 'role="alert"', 'scrollIntoView']) {
      assert.ok(PAGE_HELPERS_SOURCE.includes(name), name)
    }
  })
  it('requires selected nested session and a visible real command error node', async () => {
    const text = 'QA sandbox-hash-edit refused:\ncannot write "target": file access denied under workspace-write mode'
    let selected = false, visible = true, error = true, expanded = false, scrolls = 0
    const detail = {
      textContent: text,
      getBoundingClientRect() { return { width: 400, height: 60, top: visible ? 200 : -100, bottom: visible ? 260 : -40 } },
    }
    const node = {
      textContent: `qa-edit ${text}`,
      scrollIntoView() { scrolls += 1 },
      querySelector(selector) {
        if (selector === '[data-state="error"]') return error ? {} : null
        if (selector === '[aria-expanded="false"]') return expanded ? null : { click() { expanded = true } }
        return selector === 'pre' && expanded ? detail : null
      },
    }
    const document = {
      querySelector(selector) { return selector === '[data-row-key="session:nested"]' ? { getAttribute: () => selected ? 'true' : 'false' } : null },
      querySelectorAll(selector) { return selector === '[data-chat-flow-kind="command"]' ? [node] : [] },
    }
    const window = {}
    runInNewContext(PAGE_HELPERS_SOURCE, { window, document, innerHeight: 900, getComputedStyle: () => ({ visibility: 'visible' }) })
    const probe = (value = text) => window.__dualGuiQa.commandEvidence('nested', value, true)
    assert.equal(probe().selected, false)
    selected = true
    assert.equal(probe('a different result').matched, false)
    visible = false
    assert.equal(probe().visible, false)
    visible = true; error = false
    assert.equal(probe().error, false)
    error = true
    assert.equal(probe().matched && probe().visible && probe().detail && probe().error, true)
    assert.ok(scrolls > 0)
    const instance = { name: 'b', cdp: { evaluate: async () => probe() } }
    assert.equal((await waitGuiCommand(instance, 'nested', text, { phaseMs: 50 })).selected, true)
    selected = false
    await assert.rejects(waitGuiCommand(instance, 'nested', text, { phaseMs: 1 }), /last DOM evidence=.*selected.*false/)
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

describe('renameFixtureSources', () => {
  it('pins the editlock-lsp-rename fixture bytes and workspace manifests', () => {
    const files = renameFixtureSources()
    assert.equal(files['probe.ts'], 'export const fixtureSymbol = 1\n')
    assert.equal(files['probe-other.ts'], 'import { fixtureSymbol } from "./probe"\r\nexport const useIt = fixtureSymbol + 1\r\n')
    assert.ok('package.json' in files && 'tsconfig.json' in files, 'typescript family manifests')
    assert.ok('qa-attention.ts' in files, 'attention fixture file')
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
  it('nested session retains the shared domain while its sandbox root is narrower', () => {
    const root = mkTmp()
    const paths = prepareQaRoot({ root })
    fs.mkdirSync(path.join(paths.ws, '.weir', 'edit-lock'), { recursive: true })
    assert.equal(managementRootFor(paths.narrow), paths.ws)
    assert.equal(path.dirname(paths.sandboxFile), paths.ws)
    assert.equal(path.dirname(paths.casFile), paths.narrow)
    const source = fs.readFileSync(path.join(paths.fixture, 'index.js'), 'utf8')
    assert.match(source, /QA command requires an exact live agent/)
    assert.match(source, /cas-hash-edit/)
    assert.match(source, /cas-write/)
    assert.match(source, /sandbox-hash-edit/)
    assert.match(source, /realpathSync\.native\(agent\.session\?\.header\?\.cwd\)/)
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

describe('auditable GUI evidence', () => {
  it('refuses missing, empty and invalid PNG screenshots rather than returning a path', async () => {
    const root = mkTmp()
    const instance = new GuiInstance('a', { paths: { shots: root } })
    instance.cdp = { evaluate: async () => 0, screenshot: async (file) => fs.writeFileSync(file, '') }
    await assert.rejects(instance.shot('panel-attention-dark'), /screenshot|PNG/i)
    instance.cdp.screenshot = async (file) => fs.writeFileSync(file, 'not a png')
    await assert.rejects(instance.shot('panel-attention-dark'), /screenshot|PNG/i)
    instance.cdp.screenshot = async () => {}
    await assert.rejects(instance.shot('panel-absent'), /screenshot|PNG/i)
  })
  it('checks Windows pipe versus short POSIX socket at the actual endpoint', () => {
    const root = mkTmp()
    const authority = path.join(root, '.weir', 'edit-lock')
    fs.mkdirSync(authority, { recursive: true })
    assert.match(assertEndpoint(authority, 'win32'), /^\\\\\.\\pipe\\weir-edit-lock-[a-f0-9]{24}$/)
    const socket = assertEndpoint(authority, process.platform === 'win32' ? 'win32' : process.platform)
    if (process.platform !== 'win32') {
      assert.ok(Buffer.byteLength(socket) <= 100)
      assert.match(socket, /weir-edit-lock-[a-f0-9]{24}\.sock$/)
    }
    assert.throws(() => assertEndpoint(authority, 'win32', () => '/tmp/not-a-pipe'), /named pipe/)
    assert.throws(() => assertEndpoint(authority, 'linux', () => '\\\\.\\pipe\\wrong'), /Unix socket/)
  })
  it('reports actual process exits and per-phase counts without secrets', () => {
    const root = mkTmp()
    const matrix = createMatrix()
    matrix.record('role-detection', 'PASS', 'token=SENSITIVE')
    matrix.record('panel-attention-abnormal', 'SKIP', 'heavy only')
    const file = writeReport({ matrix: 'core', platform: 'darwin', dsh: { description: '/dsh' }, runner: { image: 'macos-15', version: '20261010.1' } }, { root, ws: path.join(root, 'ws') }, matrix, {
      processes: [{ name: 'a server', pid: 42, exitCode: null, signalCode: 'SIGKILL' }],
      sha: 'f'.repeat(64), secrets: ['SENSITIVE'],
    })
    const text = fs.readFileSync(file, 'utf8')
    assert.match(text, /runner image: macos-15/)
    assert.match(text, /runner version: 20261010\.1/)
    assert.match(text, /a server.*pid=42.*exit=null.*signal=SIGKILL/)
    assert.match(text, /sha256: f{64}/)
    assert.match(text, /phase counts: 1 PASS, 0 FAIL, 1 SKIP/)
    assert.ok(!text.includes('SENSITIVE'))
  })
  it('retains full refusal command and authority delta in the report', () => {
    const root = mkTmp(), matrix = createMatrix()
    const detail = `pid=7; root=/qa/ws; generation=1; command=QA sandbox-hash-edit refused:\n${'x'.repeat(390)}; bytes unchanged; authority operations +1 unknown/resource fence, locks retained`
    matrix.record('sandbox-backend-refusal', 'PASS', detail)
    const file = writeReport({ matrix: 'heavy' }, { root, ws: path.join(root, 'ws') }, matrix)
    assert.ok(fs.readFileSync(file, 'utf8').includes(detail.replaceAll('\n', '<br>')))
  })
  it('keeps every launch token redacted after a publisher restart', () => {
    const instance = new GuiInstance('a', {})
    instance.setToken('first-token')
    instance.setToken('second-token')
    assert.equal(sanitizeText('first-token second-token', instance.secrets), 'REDACTED_TOKEN REDACTED_TOKEN')
  })
  it('gates exceptions in either browser, not only the publisher', () => {
    const browsers = [{ name: 'a', exceptions: 0, eventsFile: 'a.jsonl' }, { name: 'b', exceptions: 0, eventsFile: 'b.jsonl' }]
    const baseline = [0, 0]
    assert.doesNotThrow(() => assertPhaseExceptions(browsers, baseline, 'measured'))
    browsers[1].exceptions = 1
    assert.throws(() => assertPhaseExceptions(browsers, baseline, 'measured'), /b.*Runtime\.exceptionThrown/)
    browsers[1].exceptions = 0
    browsers[0].exceptions = 1
    assert.throws(() => assertPhaseExceptions(browsers, baseline, 'measured'), /a.*Runtime\.exceptionThrown/)
  })
  it('requires every one of the eight named nonempty PNGs', () => {
    const root = mkTmp()
    const names = ['attention', 'recovering', 'paused', 'partial-write'].flatMap((state) => ['dark', 'light'].map((theme) => `panel-${state}-${theme}`))
    assert.throws(() => verifyPanelShots(root), /panel-attention-dark/)
    for (const name of names) fs.writeFileSync(path.join(root, `${name}.png`), Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]))
    assert.equal(verifyPanelShots(root).length, 8)
    fs.writeFileSync(path.join(root, 'panel-partial-write-light.png'), '')
    assert.throws(() => verifyPanelShots(root), /panel-partial-write-light/)
  })
  it('requires both real refusal screenshots, independently of panel images', () => {
    const root = mkTmp()
    const names = ['version-cas-refused', 'sandbox-backend-refused']
    assert.throws(() => verifyPanelShots(root, names), /version-cas-refused/)
    fs.writeFileSync(path.join(root, `${names[0]}.png`), Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]))
    assert.throws(() => verifyPanelShots(root, names), /sandbox-backend-refused/)
    fs.writeFileSync(path.join(root, `${names[1]}.png`), Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]))
    assert.equal(verifyPanelShots(root, names).length, 2)
  })
  it('requires saved-off and effective-off screenshots in BOTH themes', () => {
    const root = mkTmp()
    const names = ['saved-off', 'effective-off'].flatMap((state) => ['dark', 'light'].map((theme) => `opt-out-${state}-${theme}`))
    assert.throws(() => verifyOptOutShots(root), /opt-out-saved-off-dark/)
    for (const name of names) fs.writeFileSync(path.join(root, `${name}.png`), Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(32)]))
    assert.equal(verifyOptOutShots(root).length, 4)
    fs.writeFileSync(path.join(root, 'opt-out-effective-off-light.png'), '')
    assert.throws(() => verifyOptOutShots(root), /opt-out-effective-off-light/)
  })
})
