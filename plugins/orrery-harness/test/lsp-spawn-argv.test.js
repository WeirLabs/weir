import { describe, expect, it } from './helpers.js'
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

const corepackShim = (target) => [
  '#!/bin/sh',
  'basedir=$(dirname "$(echo "$0" | sed -e \'s,\\\\,/,g\')")',
  '@ECHO off',
  'SETLOCAL',
  `"%~dp0\\node.exe"  "%~dp0\\${target}" %*`,
  '',
].join('\r\n')

const seams = (text, { localNode = false } = {}) => ({
  binaryPath: 'C:\\node\\node.exe',
  join: (base, rest) => `${base}\\${rest}`,
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
    const argv = spawnArgv(shim, ['--stdio'], 'win32', { ...seams('@echo off\r\nsome opaque thing %*\r\n') })
    expect(argv).toEqual(['cmd.exe', '/d', '/c', shim, '--stdio'])
    expect(argv).not.toContain('/s')
  })

  it('refuses an opaque shim whose path or argument cmd would re-parse', () => {
    const opaque = '@echo off\r\nsome opaque thing %*\r\n'
    // spaced shim path: cmd strips the quotes libuv adds (this is the shape that
    // failed with 'C:\Program' is not recognized)
    expect(() => spawnArgv('C:\\Program Files\\nodejs\\opaque.cmd', ['--stdio'], 'win32', { ...seams(opaque) }))
      .toThrow(/could not be unwrapped/)
    // metacharacter in an argument: cmd would read it as a command separator
    expect(() => spawnArgv('C:\\tools\\opaque.cmd', ['--prefix', 'C:\\a&b\\npm'], 'win32', { ...seams(opaque) }))
      .toThrow(/could not be unwrapped/)
    // and the safe case still goes through cmd rather than refusing
    expect(spawnArgv('C:\\tools\\opaque.cmd', ['--stdio'], 'win32', { ...seams(opaque) })[0]).toBe('cmd.exe')
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
