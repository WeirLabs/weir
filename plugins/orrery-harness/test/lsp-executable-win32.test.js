import { describe, expect, it } from './helpers.js'
import { copyFileSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { augmentedPath, extraBinDirectories, npmGlobalPrefix, resolveExecutable } from '../src/lsp/executable.js'

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
    // realpath: the temp dir resolves through its 8.3 short name (LINYAN~1),
    // and the resolver returns the path it was handed, not the long spelling
    expect(await resolveExecutable(subprocess, 'shimmed-ls', [dir], { platform: 'win32' })).toBe(realpathSync(shim))
  })
})