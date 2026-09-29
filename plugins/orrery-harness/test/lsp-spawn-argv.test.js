import { describe, expect, it } from './helpers.js'
import { spawnArgv } from '../src/lsp/manager.js'

/**
 * Launch-shape corpus for Windows language servers. Node cannot exec a `.cmd`
 * shim at all (spawnSync → EINVAL: CreateProcess does not run batch files), and
 * the declared child env is `{ PATH: augmentedPath() }`, which npm's shim reads
 * as `SET "_prog=node"` — so the shim must be run by cmd.exe, not by Node.
 */
describe('lsp server launch shape', () => {
  it('wraps a win32 batch shim in cmd.exe', () => {
    const shim = 'C:\\Users\\tester\\AppData\\Roaming\\npm\\typescript-language-server.cmd'
    expect(spawnArgv(shim, ['--stdio'], 'win32')).toEqual(['cmd.exe', '/d', '/s', '/c', shim, '--stdio'])
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
