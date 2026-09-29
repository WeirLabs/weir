import { describe, expect, it } from './helpers.js'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, sep, win32 } from 'node:path'
import { spawnArgv } from '../src/lsp/manager.js'

/**
 * Launch-shape corpus for Windows language servers. CreateProcess runs neither
 * batch files (Node's spawn rejects a `.cmd` with EINVAL) nor shebang scripts,
 * so the shims npm and pnpm generate have to be unwrapped to their interpreter
 * plus script. Nothing goes through a shell: `cmd.exe /c` re-parses its command
 * line, so a spaced path plus a spaced argument (four quotes) or a metacharacter
 * inside the quoted text makes it strip the quotes — `'C:\Program' is not
 * recognized` — and lets an `&` be read as a command separator.
 *
 * The shim texts below are the real shapes these tools emit, including npm's
 * literal `\"` escaping and its `%NODE_EXE%` / `%NPM_CLI_JS%` variable chain.
 *
 * One case drives the REAL default existence predicate (`statSync().isFile()`),
 * because that predicate is the only gate on the unwrap: the positional rule
 * carries no positive signal of its own.
 */
const olderNpmShim = (target) => [
  '@ECHO off',
  'SETLOCAL',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  ')',
  `endLocal & "%_prog%"  "%dp0%\\${target}" %*`,
  '',
].join('\r\n')

/**
 * npm's bin linker emits an EXTENSIONLESS target whenever the package's bin
 * script is spelled that way — `…\node_modules\typescript\bin\tsc`,
 * `…\vscode-langservers-extracted\bin\vscode-json-language-server`. The target
 * is the token right before `%*`, not a token that looks like a script file.
 */
const extensionlessShim = (target) => [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%dp0%\\node.exe" (',
  '  SET "_prog=%dp0%\\node.exe"',
  ') ELSE (',
  '  SET "_prog=node"',
  ')',
  '',
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
  '',
].join('\r\n')

const npmOwnShim = [
  ':: Created by npm, please do not edit manually.',
  '@ECHO OFF',
  '',
  'SETLOCAL',
  '',
  'SET "NODE_EXE=%~dp0\\node.exe"',
  'IF NOT EXIST "%NODE_EXE%" (',
  '  SET "NODE_EXE=node"',
  ')',
  '',
  'SET "NPM_PREFIX_JS=%~dp0\\node_modules\\npm\\bin\\npm-prefix.js"',
  'SET "NPM_CLI_JS=%~dp0\\node_modules\\npm\\bin\\npm-cli.js"',
  'FOR /F "delims=" %%F IN (\'CALL "%NODE_EXE%" "%NPM_PREFIX_JS%"\') DO (',
  '  SET "NPM_PREFIX_NPM_CLI_JS=%%F\\node_modules\\npm\\bin\\npm-cli.js"',
  ')',
  'IF EXIST "%NPM_PREFIX_NPM_CLI_JS%" (',
  '  SET "NPM_CLI_JS=%NPM_PREFIX_NPM_CLI_JS%"',
  ')',
  '',
  '\"%NODE_EXE%\" \"%NPM_CLI_JS%\" %*',
  '',
].join('\r\n')

/**
 * corepack's `pnpm`/`yarn` shim. Both arms are modelled because the real file has
 * them and the ELSE arm is the one a machine without a beside-shim `node.exe`
 * actually takes (there the interpreter is the bare `node` on PATH).
 */
const corepackShim = (target) => [
  '@ECHO off',
  'GOTO start',
  ':find_dp0',
  'SET dp0=%~dp0',
  'EXIT /b',
  ':start',
  'SETLOCAL',
  'CALL :find_dp0',
  '',
  'IF EXIST "%~dp0\\node.exe" (',
  `  "%~dp0\\node.exe"  "%~dp0\\${target}" %*`,
  ') ELSE (',
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  `  node  "%~dp0\\${target}" %*`,
  ')',
  '',
].join('\r\n')

const seams = (text, { localNode = false } = {}) => ({
  binaryPath: 'C:\\node\\node.exe',
  // win32 path arithmetic, not the host's: a shim path is a Windows command
  // string whatever machine is reading it, so `dirname` rides beside `join`
  // and the corpus asserts the same argv on every host.
  join: (base, rest) => `${base}\\${rest}`,
  dirname: win32.dirname,
  // faithful to the real layout: npm only ships a node.exe beside a shim when
  // the prefix was created that way, and the target scripts exist
  existsFile: (path) => (localNode ? true : !/node\.exe$/i.test(path)),
  readTextFile: () => text,
})

describe('lsp server launch shape', () => {
  it('unwraps the older npm shim (%_prog% form)', () => {
    const shim = 'C:\\Users\\tester\\AppData\\Roaming\\npm\\typescript-language-server.cmd'
    const argv = spawnArgv(shim, ['--stdio'], 'win32', {
      ...seams(olderNpmShim('node_modules\\typescript-language-server\\lib\\cli.mjs')),
    })
    expect(argv).toEqual([
      'C:\\node\\node.exe',
      'C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\typescript-language-server\\lib\\cli.mjs',
      '--stdio',
    ])
  })

  it("unwraps npm's own shim (%NODE_EXE%/%NPM_CLI_JS% chain, literal backslash-quotes)", () => {
    const shim = 'C:\\Program Files\\nodejs\\npm.cmd'
    const argv = spawnArgv(shim, ['--version'], 'win32', { ...seams(npmOwnShim) })
    expect(argv).toEqual([
      'C:\\node\\node.exe',
      'C:\\Program Files\\nodejs\\node_modules\\npm\\bin\\npm-cli.js',
      '--version',
    ])
  })

  it('unwraps a corepack/pnpm shim (%~dp0 form)', () => {
    const shim = 'C:\\Program Files\\nodejs\\pnpm.CMD'
    const argv = spawnArgv(shim, ['--version'], 'win32', {
      ...seams(corepackShim('node_modules\\corepack\\dist\\pnpm.js')),
    })
    expect(argv).toEqual([
      'C:\\node\\node.exe',
      'C:\\Program Files\\nodejs\\node_modules\\corepack\\dist\\pnpm.js',
      '--version',
    ])
  })

  it('unwraps a shim whose target has NO extension', () => {
    // `~/.npm-global/vscode-json-language-server.cmd` and `tsc.cmd` on the
    // reviewed machine are exactly this shape; an extension-based target test
    // classified them as opaque and dropped them to the shell
    const shim = 'C:\\Users\\tester\\.npm-global\\vscode-json-language-server.cmd'
    const argv = spawnArgv(shim, ['--stdio'], 'win32', {
      ...seams(extensionlessShim('node_modules\\vscode-langservers-extracted\\bin\\vscode-json-language-server')),
    })
    expect(argv).toEqual([
      'C:\\node\\node.exe',
      'C:\\Users\\tester\\.npm-global\\node_modules\\vscode-langservers-extracted\\bin\\vscode-json-language-server',
      '--stdio',
    ])
  })

  it('uses the PATH node for a shim arm that spells a bare `node`', () => {
    // the real pnpm.CMD ELSE arm: `node "%~dp0\…" %*`. No beside-shim node.exe,
    // so the interpreter has to come from the runtime that is executing us.
    const shim = 'C:\\Program Files\\nodejs\\pnpm.CMD'
    const argv = spawnArgv(shim, ['--version'], 'win32', {
      ...seams(corepackShim('node_modules\\corepack\\dist\\pnpm.js')),
    })
    expect(argv).toEqual([
      'C:\\node\\node.exe',
      'C:\\Program Files\\nodejs\\node_modules\\corepack\\dist\\pnpm.js',
      '--version',
    ])
  })

  it('prefers a node.exe sitting beside the shim when there is one', () => {
    const shim = 'C:\\tools\\pnpm.CMD'
    const argv = spawnArgv(shim, ['--version'], 'win32', {
      ...seams(corepackShim('node_modules\\corepack\\dist\\pnpm.js'), { localNode: true }),
    })
    expect(argv[0]).toBe('C:\\tools\\node.exe')
  })

  it('survives a shim path containing a space', () => {
    const shim = 'C:\\Program Files\\nodejs\\typescript-language-server.cmd'
    const argv = spawnArgv(shim, ['--stdio'], 'win32', {
      ...seams(olderNpmShim('node_modules\\typescript-language-server\\lib\\cli.mjs')),
    })
    expect(argv).toHaveLength(3)
    expect(argv[0]).toBe('C:\\node\\node.exe')
    expect(argv[1]).toContain('Program Files')
  })

  it('falls back to cmd without /s only when nothing can be re-parsed', () => {
    const shim = 'C:\\tools\\opaque.cmd'
    // a shim with no interpreter forward at all: the shape cannot be unwrapped
    const argv = spawnArgv(shim, ['--stdio'], 'win32', { ...seams('@echo off\r\nREM nothing to forward\r\n') })
    expect(argv).toEqual(['cmd.exe', '/d', '/c', shim, '--stdio'])
    expect(argv).not.toContain('/s')
  })

  it('refuses an opaque shim whose path or argument cmd would re-parse', () => {
    const opaque = '@echo off\r\nREM nothing to forward\r\n'
    // spaced shim path: cmd strips the quotes libuv adds (this is the shape that
    // failed with 'C:\Program' is not recognized)
    expect(() => spawnArgv('C:\\Program Files\\nodejs\\opaque.cmd', ['--stdio'], 'win32', { ...seams(opaque) }))
      .toThrow(/could not be unwrapped/)
    // metacharacter in an argument: cmd would read it as a command separator
    expect(() => spawnArgv('C:\\tools\\opaque.cmd', ['--prefix', 'C:\\a&b\\npm'], 'win32', { ...seams(opaque) }))
      .toThrow(/could not be unwrapped/)
    // an empty argument would vanish: `cmd /c x ''` drops it without a word
    expect(() => spawnArgv('C:\\tools\\opaque.cmd', ['--prefix', ''], 'win32', { ...seams(opaque) }))
      .toThrow(/could not be unwrapped/)
    // and the safe case still goes through cmd rather than refusing
    expect(spawnArgv('C:\\tools\\opaque.cmd', ['--stdio'], 'win32', { ...seams(opaque) })[0]).toBe('cmd.exe')
  })

  it('falls back to cmd for a forward whose target does not exist', () => {
    const shim = 'C:\\tools\\missing-target.cmd'
    const text = '@echo off\r\n"%_prog%"  "%dp0%\\node_modules\\gone\\cli.mjs" %*\r\n'
    // the forward IS understood, but the script it names is not there: the shim
    // is not unwrapped, so it takes the shell path when that is provably safe
    const argv = spawnArgv(shim, ['--stdio'], 'win32', {
      ...seams(text),
      existsFile: () => false,
    })
    expect(argv).toEqual(['cmd.exe', '/d', '/c', shim, '--stdio'])
  })

  it('drives the shipped file predicate: a directory is not a target', () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-shim-'))
    try {
      // The launch SHAPE is win32 throughout, but the predicate under test is
      // the one `spawnArgv` ships, and it stats the real filesystem — so the
      // path the shim NAMES is spelled with this host's separator. `%~dp0` and
      // `%dp0%` expand to their directory plus the separator that follows them,
      // which is how every generator writes them, so this is still the real
      // shape while pointing at a path this filesystem can actually resolve.
      const shim = join(dir, 'real.cmd')
      const named = (name) => `%dp0%${sep}node_modules${sep}${name}`
      const hostPath = (name) => join(dir, 'node_modules', name)
      mkdirSync(join(dir, 'node_modules'), { recursive: true })
      // the target is a DIRECTORY here: `existsSync` would accept it and hand
      // node a folder, so the shipped predicate must reject the unwrap
      mkdirSync(hostPath('cli-dir.mjs'), { recursive: true })
      writeFileSync(shim, `@echo off\r\n"%_prog%"  "${named('cli-dir.mjs')}" %*\r\n`, 'utf8')
      const wired = { binaryPath: join(dir, 'node.exe'), join }
      const refused = spawnArgv(shim, ['--stdio'], 'win32', wired)
      expect(refused[0]).toBe('cmd.exe')
      expect(refused).not.toContain(hostPath('cli-dir.mjs'))
      // ...and a real FILE at the very same relative place does unwrap
      writeFileSync(hostPath('cli-file.mjs'), 'export {}\n', 'utf8')
      writeFileSync(shim, `@echo off\r\n"%_prog%"  "${named('cli-file.mjs')}" %*\r\n`, 'utf8')
      expect(spawnArgv(shim, ['--stdio'], 'win32', wired)).toEqual([
        join(dir, 'node.exe'),
        hostPath('cli-file.mjs'),
        '--stdio',
      ])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('runs a real win32 executable directly', () => {
    const exe = 'C:\\tools\\clangd.exe'
    expect(spawnArgv(exe, ['--stdio'], 'win32')).toEqual([exe, '--stdio'])
  })

  it('runs a powershell shim through powershell.exe', () => {
    const shim = 'C:\\tools\\server.ps1'
    expect(spawnArgv(shim, ['start'], 'win32')).toEqual([
      'powershell.exe', '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', shim, 'start',
    ])
  })

  it('leaves POSIX commands untouched', () => {
    const command = '/Users/tester/.npm-global/bin/typescript-language-server'
    expect(spawnArgv(command, ['--stdio'], 'darwin')).toEqual([command, '--stdio'])
  })
})
