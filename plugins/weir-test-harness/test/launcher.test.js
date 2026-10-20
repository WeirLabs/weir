// Unit suite for the dsh launcher discovery (src/launcher.js).
//
// The regression this pins: the harness used to boot a hardcoded path into
// /tmp/dsh-src, the extracted DSH reference AGENTS §2 registers as volatile.
// When that extraction vanished, every scenario died as `node <missing bin.js>`
// → MODULE_NOT_FOUND with an empty requireStack, and scripts/release.mjs (which
// runs the integration gate without overrides) inherited that failure wholesale.
//
// Every case injects env/platform/exists/home and asserts on the returned
// launcher or the thrown message — nothing is spawned, nothing is probed on the
// real filesystem. Expected paths are independent literals, not recomputed from
// the module under test, so the assertions can actually disagree with it.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolveDshLauncher } from '../src/launcher.js'

// POSIX candidates, spelled as a user would see them on disk.
const EXTRACTED = '/tmp/dsh-src/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
const SYSTEM_APP_CLI = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
const HOME = '/Users/it'
const USER_APP_CLI = '/Users/it/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'

// win32 candidates, under injected roots.
const WIN_HOME = 'C:\\Users\\it'
const WIN_APPDATA = 'C:\\Users\\it\\AppData\\Roaming'
const WIN_NPM_CLI = 'C:\\Users\\it\\AppData\\Roaming\\npm\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const WIN_PROGRAM_FILES = 'D:\\Apps'
const WIN_APP_CLI = 'D:\\Apps\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'
const WIN_DEFAULT_PROGRAM_FILES_CLI = 'C:\\Program Files\\DeepSeek Harness\\resources\\app.asar\\dsh\\node_modules\\@deepseek-ai\\dsh\\lib\\bin.js'

/** An `exists` seam answering true only for `present`, recording every probe. */
function existsOnlyAmong(present) {
  const probed = []
  const exists = (path) => {
    probed.push(path)
    return present.includes(path)
  }
  exists.probed = probed
  return exists
}

/** An `exists` seam that fails the test if any candidate is consulted at all. */
function existsForbidden() {
  return () => assert.fail('a candidate was probed although an explicit override should win')
}

describe('resolveDshLauncher explicit overrides', () => {
  it('prefers WEIR_IT_DSH_EXEC over WEIR_IT_DSH and over every candidate', () => {
    const resolved = resolveDshLauncher({
      env: { WEIR_IT_DSH_EXEC: '/opt/desktop/runtime/cli/bin/dsh', WEIR_IT_DSH: '/opt/tree/lib/bin.js' },
      platform: 'darwin',
      home: HOME,
      exists: existsForbidden(),
    })
    assert.deepEqual(resolved, {
      kind: 'exec',
      path: '/opt/desktop/runtime/cli/bin/dsh',
      source: 'env:WEIR_IT_DSH_EXEC',
    })
  })

  it('never checks that an explicit WEIR_IT_DSH_EXEC exists (the caller owns it)', () => {
    const resolved = resolveDshLauncher({
      env: { WEIR_IT_DSH_EXEC: '/gone/runtime/cli/bin/dsh' },
      platform: 'darwin',
      home: HOME,
      exists: existsForbidden(),
    })
    assert.equal(resolved.kind, 'exec')
    assert.equal(resolved.path, '/gone/runtime/cli/bin/dsh')
  })

  it('takes WEIR_IT_DSH as a node-booted CLI entry, unchecked', () => {
    const resolved = resolveDshLauncher({
      env: { WEIR_IT_DSH: '/opt/tree/lib/bin.js' },
      platform: 'darwin',
      home: HOME,
      exists: existsForbidden(),
    })
    assert.deepEqual(resolved, { kind: 'node', path: '/opt/tree/lib/bin.js', source: 'env:WEIR_IT_DSH' })
  })

  it('prefers an explicit WEIR_IT_DSH entry over a candidate that does exist', () => {
    const resolved = resolveDshLauncher({
      env: { WEIR_IT_DSH: '/opt/tree/lib/bin.js' },
      platform: 'darwin',
      home: HOME,
      exists: existsOnlyAmong([EXTRACTED, SYSTEM_APP_CLI]),
    })
    assert.equal(resolved.kind, 'node')
    assert.equal(resolved.path, '/opt/tree/lib/bin.js')
    assert.equal(resolved.source, 'env:WEIR_IT_DSH')
  })

  it('treats blank or empty overrides as unset and falls through to discovery', () => {
    const resolved = resolveDshLauncher({
      env: { WEIR_IT_DSH_EXEC: '   ', WEIR_IT_DSH: '' },
      platform: 'darwin',
      home: HOME,
      exists: existsOnlyAmong([SYSTEM_APP_CLI]),
    })
    assert.deepEqual(resolved, {
      kind: 'exec',
      path: SYSTEM_APP_CLI,
      source: 'candidate:/Applications/DeepSeek Harness.app',
    })
  })
})

describe('resolveDshLauncher POSIX candidates', () => {
  it('uses the desktop app CLI when the extracted reference is gone', () => {
    const resolved = resolveDshLauncher({ env: {}, platform: 'darwin', home: HOME, exists: existsOnlyAmong([SYSTEM_APP_CLI]) })
    assert.deepEqual(resolved, {
      kind: 'exec',
      path: SYSTEM_APP_CLI,
      source: 'candidate:/Applications/DeepSeek Harness.app',
    })
  })

  it('keeps the extracted reference ahead of the app when both exist (historical order)', () => {
    const resolved = resolveDshLauncher({
      env: {},
      platform: 'darwin',
      home: HOME,
      exists: existsOnlyAmong([EXTRACTED, SYSTEM_APP_CLI]),
    })
    assert.deepEqual(resolved, { kind: 'node', path: EXTRACTED, source: 'candidate:/tmp/dsh-src' })
  })

  it('falls through to the per-user desktop install', () => {
    const resolved = resolveDshLauncher({ env: {}, platform: 'darwin', home: HOME, exists: existsOnlyAmong([USER_APP_CLI]) })
    assert.deepEqual(resolved, {
      kind: 'exec',
      path: USER_APP_CLI,
      source: `candidate:${HOME}/Applications/DeepSeek Harness.app`,
    })
  })

  it('probes every candidate in the documented order before giving up', () => {
    const exists = existsOnlyAmong([])
    assert.throws(() => resolveDshLauncher({ env: {}, platform: 'darwin', home: HOME, exists }))
    assert.deepEqual(exists.probed, [EXTRACTED, SYSTEM_APP_CLI, USER_APP_CLI])
  })

  it('applies the same order on linux', () => {
    const resolved = resolveDshLauncher({ env: {}, platform: 'linux', home: '/home/it', exists: existsOnlyAmong([SYSTEM_APP_CLI]) })
    assert.equal(resolved.path, SYSTEM_APP_CLI)
    assert.equal(resolved.source, 'candidate:/Applications/DeepSeek Harness.app')
  })
})

describe('resolveDshLauncher win32 candidates', () => {
  it('uses the npm-global install under an injected APPDATA', () => {
    const resolved = resolveDshLauncher({
      env: { APPDATA: WIN_APPDATA },
      platform: 'win32',
      home: WIN_HOME,
      exists: existsOnlyAmong([WIN_NPM_CLI]),
    })
    assert.deepEqual(resolved, { kind: 'node', path: WIN_NPM_CLI, source: `candidate:${WIN_APPDATA}\\npm` })
  })

  it('derives APPDATA from home when the variable is absent', () => {
    const resolved = resolveDshLauncher({ env: {}, platform: 'win32', home: WIN_HOME, exists: existsOnlyAmong([WIN_NPM_CLI]) })
    assert.equal(resolved.path, WIN_NPM_CLI)
    assert.equal(resolved.source, `candidate:${WIN_APPDATA}\\npm`)
  })

  it("falls back to the desktop app's app.asar tree under an injected ProgramFiles", () => {
    const resolved = resolveDshLauncher({
      env: { ProgramFiles: WIN_PROGRAM_FILES },
      platform: 'win32',
      home: WIN_HOME,
      exists: existsOnlyAmong([WIN_APP_CLI]),
    })
    assert.deepEqual(resolved, {
      kind: 'node',
      path: WIN_APP_CLI,
      source: `candidate:${WIN_PROGRAM_FILES}\\DeepSeek Harness\\resources\\app.asar\\dsh`,
    })
  })

  it("defaults ProgramFiles to C:\\Program Files", () => {
    const resolved = resolveDshLauncher({ env: {}, platform: 'win32', home: WIN_HOME, exists: existsOnlyAmong([WIN_DEFAULT_PROGRAM_FILES_CLI]) })
    assert.equal(resolved.path, WIN_DEFAULT_PROGRAM_FILES_CLI)
    assert.equal(resolved.kind, 'node')
  })

  it('prefers the npm-global install over the desktop app tree', () => {
    const resolved = resolveDshLauncher({
      env: { APPDATA: WIN_APPDATA, ProgramFiles: WIN_PROGRAM_FILES },
      platform: 'win32',
      home: WIN_HOME,
      exists: existsOnlyAmong([WIN_NPM_CLI, WIN_APP_CLI]),
    })
    assert.equal(resolved.path, WIN_NPM_CLI)
  })

  it('never adopts a POSIX candidate on win32', () => {
    const exists = existsOnlyAmong([EXTRACTED, SYSTEM_APP_CLI, USER_APP_CLI])
    assert.throws(
      () => resolveDshLauncher({ env: {}, platform: 'win32', home: WIN_HOME, exists }),
      /no dsh launcher found/,
    )
    assert.deepEqual(exists.probed, [WIN_NPM_CLI, WIN_DEFAULT_PROGRAM_FILES_CLI])
  })
})

describe('resolveDshLauncher failure', () => {
  it('throws one actionable error naming both overrides and every path tried', () => {
    const exists = existsOnlyAmong([])
    let error = null
    try {
      resolveDshLauncher({ env: {}, platform: 'darwin', home: HOME, exists })
    } catch (thrown) {
      error = thrown
    }
    assert.ok(error instanceof Error, 'a real Error, not a bare string')
    const message = error.message
    assert.match(message, /no dsh launcher found/)
    assert.match(message, /WEIR_IT_DSH_EXEC/)
    assert.match(message, /WEIR_IT_DSH(?!_EXEC)/)
    assert.match(message, /WEIR_IT_NODE/)
    // The two strings a developer greps for when this fires.
    assert.match(message, /\/tmp\/dsh-src/)
    assert.match(message, /runtime\/cli\/bin\/dsh/)
    // Every path the run actually tried, verbatim.
    for (const path of [EXTRACTED, SYSTEM_APP_CLI, USER_APP_CLI]) assert.ok(message.includes(path), `message names ${path}`)
    // The platform it decided under, and a copy-pasteable macOS remedy.
    assert.match(message, /"darwin"/)
    assert.ok(
      message.includes('WEIR_IT_DSH_EXEC="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"'),
      'carries the copy-pasteable macOS example',
    )
  })

  it('reports the win32 candidates it tried for a win32 run', () => {
    let error = null
    try {
      resolveDshLauncher({ env: {}, platform: 'win32', home: WIN_HOME, exists: existsOnlyAmong([]) })
    } catch (thrown) {
      error = thrown
    }
    assert.ok(error instanceof Error)
    const message = error.message
    assert.match(message, /"win32"/)
    for (const path of [WIN_NPM_CLI, WIN_DEFAULT_PROGRAM_FILES_CLI]) assert.ok(message.includes(path), `message names ${path}`)
  })
})

describe('run.mjs launcher wiring (source-pinned, like run-lock.test.js)', () => {
  const source = readFileSync(new URL('../run.mjs', import.meta.url), 'utf8')

  it('imports the resolver instead of hardcoding a launcher', () => {
    assert.match(source, /import \{ resolveDshLauncher \} from '\.\/src\/launcher\.js'/)
    assert.doesNotMatch(source, /const DSH_BIN/, 'no hardcoded CLI entry constant')
    assert.doesNotMatch(source, /const DSH_EXEC/, 'no hoisted exec override constant')
  })

  it('resolves in main() and exits 1 with the message on stderr before any scenario', () => {
    const main = source.slice(source.indexOf('async function main()'))
    assert.match(main, /try \{\n {4}launcher = resolveDshLauncher\(\)\n/)
    assert.match(main, /console\.error\(error\?\.message \?\? String\(error\)\)\n {4}process\.exit\(1\)/)
    // Resolution is the first thing main() does: it must precede the setup()
    // wipe, the scenario loop, and the per-run spawn.
    const resolvedAt = main.indexOf('launcher = resolveDshLauncher()')
    assert.ok(resolvedAt > -1, 'main() resolves the launcher')
    // The call, not the prose above it: `\n  setup()` is the statement itself.
    assert.ok(resolvedAt < main.indexOf('\n  setup()'), 'resolved before the setup() call')
    assert.ok(resolvedAt < main.indexOf('for (const scenario of selected)'), 'resolved before the scenario loop')
  })

  it('spawns the launcher per kind: execFile(path) for exec, execFile(NODE, [path]) for node', () => {
    assert.match(
      source,
      /const \[command, argv\] = launcher\.kind === 'exec' \? \[launcher\.path, args\] : \[NODE, \[launcher\.path, \.\.\.args\]\]/,
    )
    assert.match(source, /execFile\(\n {6}command,\n {6}argv,/)
  })

  it('keeps WEIR_IT_NODE as the node binary for the node-booted launcher', () => {
    assert.match(source, /const NODE =\n {2}process\.env\.WEIR_IT_NODE \?\?/)
  })
})
