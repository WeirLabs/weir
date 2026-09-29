import { describe, expect, it } from './helpers.js'
import { spawnArgv } from '../src/lsp/manager.js'

/**
 * Launch-shape corpus for Windows language servers. CreateProcess runs neither
 * batch files (Node's spawn rejects a `.cmd` with EINVAL) nor shebang scripts,
 * so the shapes npm and friends install need an interpreter in front — and the
 * interpreter is chosen without re-parsing a command line through a shell,
 * because the shim may live under a path containing a space.
 */
const shimText = (target) => [
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
  '  SET PATHEXT=%PATHEXT:;.JS;=;%',
  ')',
  '',
  `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
  '',
].join('\r\n')

const seams = {
  binaryPath: 'C:\\node\\node.exe',
  join: (base, rest) => `${base}\\${rest}`,
  existsFile: (path) => path.includes('node_modules'),
}

describe('lsp server launch shape', () => {
  it('unwraps an npm batch shim to node plus its target script', () => {
    const shim = 'C:\\Users\\tester\\AppData\\Roaming\\npm\\typescript-language-server.cmd'
    const argv = spawnArgv(shim, ['--stdio'], 'win32', {
      ...seams,
      readTextFile: () => shimText('node_modules\\typescript-language-server\\lib\\cli.mjs'),
    })
    expect(argv).toEqual([
      'C:\\node\\node.exe',
      'C:\\Users\\tester\\AppData\\Roaming\\npm\\node_modules\\typescript-language-server\\lib\\cli.mjs',
      '--stdio',
    ])
  })

  it('survives a shim path containing a space', () => {
    const shim = 'C:\\Program Files\\nodejs\\typescript-language-server.cmd'
    const argv = spawnArgv(shim, ['--stdio'], 'win32', {
      ...seams,
      join: (base, rest) => `${base}/${rest}`,
      readTextFile: () => shimText('node_modules\\typescript-language-server\\lib\\cli.mjs'),
    })
    // no shell in the argv at all: the spaced path is one ordinary argument
    expect(argv).toHaveLength(3)
    expect(argv[0]).toBe('C:\\node\\node.exe')
    expect(argv[1]).toContain('Program Files')
    expect(argv[2]).toBe('--stdio')
  })

  it('falls back to cmd (without /s) when the shim cannot be unwrapped', () => {
    const shim = 'C:\\tools\\opaque.cmd'
    const argv = spawnArgv(shim, ['--stdio'], 'win32', {
      ...seams,
      readTextFile: () => '@echo off\r\nsome opaque thing %*\r\n',
    })
    expect(argv).toEqual(['cmd.exe', '/d', '/c', shim, '--stdio'])
    // /s disables the quote preservation that keeps a spaced path working
    expect(argv).not.toContain('/s')
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
