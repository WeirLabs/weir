import { describe, expect, it } from './helpers.js'
import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { augmentedPath, extraBinDirectories, resolveExecutable } from '../src/lsp/executable.js'

describe('lsp executable resolution', () => {
  it('prefers the subprocess service resolver', async () => {
    const subprocess = { resolveExecutable: async () => '/service/bin/thing' }
    expect(await resolveExecutable(subprocess, 'thing', [])).toBe('/service/bin/thing')
  })

  it('falls back to the extended directories when the service cannot resolve', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-bin-'))
    const bin = join(dir, 'custom-ls')
    writeFileSync(bin, '#!/bin/sh\n')
    chmodSync(bin, 0o755)
    const subprocess = { resolveExecutable: async () => {
      throw new Error('not found')
    } }
    expect(await resolveExecutable(subprocess, 'custom-ls', [dir])).toBe(bin)
    expect(await resolveExecutable(subprocess, 'absent-thing', [dir])).toBe(undefined)
  })

  it('passes absolute paths through when executable', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'orrery-bin-'))
    const bin = join(dir, 'abs-ls')
    writeFileSync(bin, '#!/bin/sh\n')
    chmodSync(bin, 0o755)
    expect(await resolveExecutable({}, bin, [])).toBe(bin)
    expect(await resolveExecutable({}, join(dir, 'missing'), [])).toBe(undefined)
  })

  it('lists the standard well-known directories with nvm versions', () => {
    const dirs = extraBinDirectories({ HOME: '/Users/tester' })
    expect(dirs).toContain('/opt/homebrew/bin')
    expect(dirs).toContain('/usr/local/bin')
    expect(dirs).toContain('/Users/tester/.npm-global/bin')
    expect(dirs).toContain('/Users/tester/.cargo/bin')
  })

  it('augmentedPath prepends the extra directories and keeps the existing PATH', () => {
    const path = augmentedPath({ HOME: '/Users/tester', PATH: '/usr/bin:/bin' })
    const segments = path.split(':')
    expect(segments[0]).toBe('/opt/homebrew/bin')
    expect(segments).toContain('/usr/bin')
    expect(segments).toContain('/bin')
    expect(new Set(segments).size).toBe(segments.length) // deduped
  })
})
