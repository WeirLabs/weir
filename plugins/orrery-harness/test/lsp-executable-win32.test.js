import { describe, expect, it } from './helpers.js'
import { copyFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { augmentedPath, childEnvironment, extraBinDirectories, npmGlobalPrefix, resolveExecutable } from '../src/lsp/executable.js'

/**
 * Windows-portability corpus for executable resolution. Every case drives the
 * platform through the options seam (the repo's `installSpecFor(entry,
 * platform)` precedent) — no test mutates process.platform. Fixtures are real
 * files in a temp dir, so the win32 branch is exercised with genuine path
 * separators on any host.
 */
const tempDirs = []
function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'orrery-win-bin-'))
  tempDirs.push(dir)
  return dir
}

process.on('exit', () => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
})

const WIN_ENV = { HOME: 'C:\\Users\\tester', APPDATA: 'C:\\Users\\tester\\AppData\\Roaming', PATHEXT: '.COM;.EXE;.BAT;.CMD' }

describe('lsp executable resolution on Windows', () => {
  it('treats a win32 backslash path as an absolute path, not a command name', async () => {
    const dir = tempDir()
    const bin = join(dir, 'abs-ls.cmd')
    writeFileSync(bin, '')
    expect(await resolveExecutable({}, bin, [], { platform: 'win32' })).toBe(bin)
    expect(await resolveExecutable({}, join(dir, 'missing'), [], { platform: 'win32' })).toBe(undefined)
  })

  it('treats a drive-letter path with forward slashes as absolute too', async () => {
    const dir = tempDir()
    const bin = join(dir, 'fwd-ls.cmd')
    writeFileSync(bin, '')
    const forward = bin.replace(/\\/g, '/')
    expect(await resolveExecutable({}, forward, [], { platform: 'win32' })).toBe(forward)
  })

  it('does not treat a win32 path as a service-resolvable command name', async () => {
    const dir = tempDir()
    const bin = join(dir, 'svc-ls.cmd')
    writeFileSync(bin, '')
    let calls = 0
    const subprocess = { resolveExecutable: async () => {
      calls += 1
      return undefined
    } }
    await resolveExecutable(subprocess, bin, [], { platform: 'win32' })
    expect(calls).toBe(0)
  })

  it('scans the npm global prefix and the pinned npm-global prefix', () => {
    const dirs = extraBinDirectories(WIN_ENV, 'win32')
    // expected paths are built with the same host join the code uses: the seam
    // selects the layout, the host spells the separators of its own fixtures
    expect(dirs).toContain(join(WIN_ENV.APPDATA, 'npm'))
    expect(dirs).toContain(join(WIN_ENV.HOME, '.npm-global'))
    expect(dirs).toContain(join(WIN_ENV.HOME, '.npm-global', 'bin'))
  })

  it('never lists POSIX-only directories in the win32 scan', () => {
    const dirs = extraBinDirectories(WIN_ENV, 'win32')
    expect(dirs).not.toContain('/opt/homebrew/bin')
    expect(dirs).not.toContain('/usr/local/bin')
  })

  it('joins the child PATH with semicolons and keeps the existing entries', () => {
    const path = augmentedPath({ ...WIN_ENV, PATH: 'C:\\Windows;C:\\Windows\\System32' }, 'win32')
    const segments = path.split(';')
    expect(segments).toContain('C:\\Windows')
    expect(segments).toContain('C:\\Windows\\System32')
    expect(segments).toContain(join(WIN_ENV.HOME, '.npm-global'))
    expect(path).not.toContain('/opt/homebrew/bin')
    expect(new Set(segments).size).toBe(segments.length) // deduped
  })

  it('pins the npm install prefix to the Windows global prefix', () => {
    expect(npmGlobalPrefix(WIN_ENV, 'win32')).toBe(join(WIN_ENV.APPDATA, 'npm'))
  })


  it('probes PATHEXT when scanning a bare name', async () => {
    const dir = tempDir()
    const shim = join(dir, 'shimmed-ls.cmd')
    copyFileSync(process.execPath, shim)
    const subprocess = { resolveExecutable: async () => undefined }
    expect(await resolveExecutable(subprocess, 'shimmed-ls', [dir], { platform: 'win32' })).toBe(join(dir, 'shimmed-ls.cmd'))
  })

  it('rejects a same-named file without an executable extension', async () => {
    const dir = tempDir()
    // the extensionless POSIX twin npm leaves beside every shim: CreateProcess
    // would not run it, so resolution must not report it as installed
    writeFileSync(join(dir, 'twin-ls'), '#!/bin/sh\n')
    const subprocess = { resolveExecutable: async () => undefined }
    expect(await resolveExecutable(subprocess, 'twin-ls', [dir], { platform: 'win32' })).toBe(undefined)
    // and the .cmd beside it is the one that resolves
    writeFileSync(join(dir, 'twin-ls.cmd'), '@echo off\n')
    expect(await resolveExecutable(subprocess, 'twin-ls', [dir], { platform: 'win32' })).toBe(join(dir, 'twin-ls.cmd'))
  })

  it('carries SystemRoot and ComSpec so a cmd fallback can run', () => {
    const child = childEnvironment({ ...WIN_ENV, SystemRoot: 'C:\\windows', ComSpec: 'C:\\windows\\system32\\cmd.exe', PATH: 'C:\\Windows' }, 'win32')
    expect(child.SystemRoot).toBe('C:\\windows')
    expect(child.ComSpec).toBe('C:\\windows\\system32\\cmd.exe')
    expect(child.PATH).toContain('C:\\Windows')
  })

  it('adds no Windows variables on POSIX', () => {
    const child = childEnvironment({ HOME: '/Users/tester', PATH: '/usr/bin', SystemRoot: 'C:\\windows' }, 'darwin')
    expect(child.SystemRoot).toBe(undefined)
    expect(child.PATH).toContain('/usr/bin')
  })
})