// The shipped guard whitelist defaults, and the guarantees around them.
//
// The defaults live in `whitelist-defaults.json` at the bundle root, read by
// the plugin itself rather than composed from a patch row, so no configuration
// layer can discard them (see src/shared/whitelist-defaults.js for the why).
//
// Two things this file must keep true:
//   1. the DATA FILE and the built-in constants agree — the file is the source,
//      the constants are the per-table fallback, and a silent divergence between
//      them would make a defective file quietly narrow the guard;
//   2. a defective file is per-table and never relaxes anything — a table that
//      cannot be read falls back, the well-formed tables still come from the
//      file, and activation never fails because of the file.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from './helpers.js'
import { DEFAULT_ROBASH } from '../src/delegate/robash-guard.js'
import { DEFAULT_ROBASH_PWSH } from '../src/delegate/robash-guard-pwsh.js'
import {
  DEFAULT_WHITELIST_PATH,
  FALLBACK_TABLES,
  WHITELIST_KEYS,
  createWhitelistDefaultsCache,
  readWhitelistDefaults,
  readWhitelistDefaultsAt,
} from '../src/shared/whitelist-defaults.js'

/** A reader seam that reports which path was asked for, so caching is observable. */
function countingReader(contentsByPath) {
  const reads = []
  return {
    reads,
    readFile: (filePath) => {
      const key = String(filePath)
      reads.push(key)
      const contents = contentsByPath[key]
      if (contents === undefined) throw new Error(`ENOENT: no such file or directory, open '${key}'`)
      return contents
    },
  }
}

/** A logger that records the warnings it was given. */
function recordingLogger() {
  const warnings = []
  return { warnings, warn: (message) => warnings.push(message) }
}

describe('whitelist defaults data file', () => {
  it('is the shipped source for all five tables, in the order the guard names them', () => {
    const parsed = JSON.parse(readFileSync(DEFAULT_WHITELIST_PATH, 'utf8'))
    expect(Object.keys(parsed)).toEqual([...WHITELIST_KEYS])
    for (const key of WHITELIST_KEYS) {
      expect(Array.isArray(parsed[key])).toBe(true)
      expect(parsed[key].every((entry) => typeof entry === 'string')).toBe(true)
    }
  })

  it('carries a copy of each module constant, entry for entry and in the same order', () => {
    const parsed = JSON.parse(readFileSync(DEFAULT_WHITELIST_PATH, 'utf8'))
    // `toEqual` on the whole array, not `toContain`: a subset would satisfy a
    // membership assertion while silently narrowing the guard.
    expect(parsed.robashAllow).toEqual([...DEFAULT_ROBASH.allow])
    expect(parsed.robashGitAllow).toEqual([...DEFAULT_ROBASH.gitAllow])
    expect(parsed.robashDeny).toEqual([...DEFAULT_ROBASH.deny])
    expect(parsed.robashPwshAllow).toEqual([...DEFAULT_ROBASH_PWSH.allow])
    expect(parsed.robashPwshDeny).toEqual([...DEFAULT_ROBASH_PWSH.deny])
  })

  it('exposes a fallback table for every key, so no table can go missing silently', () => {
    expect(Object.keys(FALLBACK_TABLES).sort()).toEqual([...WHITELIST_KEYS].sort())
    for (const key of WHITELIST_KEYS) {
      expect(FALLBACK_TABLES[key].length).toBeGreaterThan(0)
    }
  })
})

describe('readWhitelistDefaults', () => {
  it('reads every table from the shipped file and reports them as file-sourced', () => {
    const result = readWhitelistDefaults()
    expect(Object.keys(result.tables).sort()).toEqual([...WHITELIST_KEYS].sort())
    for (const key of WHITELIST_KEYS) expect(result.source[key]).toBe('file')
    expect(result.tables.robashPwshAllow).toContain('Start-Sleep')
  })

  it('falls back to every built-in constant when the file cannot be read, and reports it', () => {
    const logger = recordingLogger()
    const result = readWhitelistDefaults({
      readFile: () => {
        throw new Error('ENOENT')
      },
      logger,
    })
    for (const key of WHITELIST_KEYS) {
      expect(result.source[key]).toBe('fallback')
      expect(result.tables[key]).toEqual([...FALLBACK_TABLES[key]])
    }
    expect(logger.warnings).toHaveLength(1)
    expect(logger.warnings[0]).toContain('fall back to the built-in lists')
  })

  it('falls back when the file is not a JSON object of tables', () => {
    for (const contents of ['not json at all', '[]', 'null', '"a string"', '42']) {
      const logger = recordingLogger()
      const result = readWhitelistDefaults({ readFile: () => contents, logger })
      for (const key of WHITELIST_KEYS) expect(result.source[key]).toBe('fallback')
      expect(logger.warnings.length).toBeGreaterThan(0)
    }
  })

  it('falls back PER TABLE: a malformed table does not drag the well-formed ones down', () => {
    const logger = recordingLogger()
    const contents = JSON.stringify({
      robashAllow: ['ls'],
      robashGitAllow: 'not-an-array',
      robashDeny: ['rm'],
      robashPwshAllow: ['Get-Content', 42],
      robashPwshDeny: ['iex'],
    })
    const result = readWhitelistDefaults({ readFile: () => contents, logger })
    expect(result.source.robashAllow).toBe('file')
    expect(result.source.robashDeny).toBe('file')
    expect(result.source.robashPwshDeny).toBe('file')
    expect(result.source.robashGitAllow).toBe('fallback')
    expect(result.source.robashPwshAllow).toBe('fallback')
    // the well-formed tables keep the FILE's contents, not the fallback's
    expect(result.tables.robashAllow).toEqual(['ls'])
    expect(result.tables.robashDeny).toEqual(['rm'])
    // ...and the defective ones are the built-in constants
    expect(result.tables.robashGitAllow).toEqual([...FALLBACK_TABLES.robashGitAllow])
    expect(result.tables.robashPwshAllow).toEqual([...FALLBACK_TABLES.robashPwshAllow])
    expect(logger.warnings).toHaveLength(1)
    expect(logger.warnings[0]).toContain('robashGitAllow')
    expect(logger.warnings[0]).toContain('robashPwshAllow')
  })

  it('never fails activation because of a defective file', () => {
    for (const contents of [undefined, '{{{', '[]', JSON.stringify({ robashAllow: 5 })]) {
      const readFile = contents === undefined
        ? () => { throw new Error('ENOENT') }
        : () => contents
      const result = readWhitelistDefaults({ readFile, logger: recordingLogger() })
      // returns all five tables as arrays every time — nothing to throw on
      for (const key of WHITELIST_KEYS) {
        expect(Array.isArray(result.tables[key])).toBe(true)
      }
    }
  })

  it('does not mutate the fallback constants it hands out', () => {
    const first = readWhitelistDefaults({ readFile: () => { throw new Error('ENOENT') } })
    first.tables.robashAllow.push('injected-by-a-caller')
    const second = readWhitelistDefaults({ readFile: () => { throw new Error('ENOENT') } })
    expect(second.tables.robashAllow).not.toContain('injected-by-a-caller')
    expect(FALLBACK_TABLES.robashAllow).not.toContain('injected-by-a-caller')
  })
})

describe('readWhitelistDefaultsAt (path takeover)', () => {
  it('takes the tables from the taken-over file and does not merge the built-ins', () => {
    const narrow = JSON.stringify({
      robashAllow: ['ls'],
      robashGitAllow: ['status'],
      robashDeny: ['rm'],
      robashPwshAllow: ['Get-Content'],
      robashPwshDeny: ['iex'],
    })
    const result = readWhitelistDefaultsAt('/tmp/taken-over.json', { readFile: () => narrow })
    expect(result.tables.robashAllow).toEqual(['ls'])
    // `sleep` is in the shipped defaults; a takeover must NOT add it back
    expect(result.tables.robashAllow).not.toContain('sleep')
    expect(result.tables.robashDeny).toEqual(['rm'])
    expect(result.path).toBe('/tmp/taken-over.json')
  })

  it('still falls back per table when the taken-over file is defective', () => {
    const logger = recordingLogger()
    const result = readWhitelistDefaultsAt('/tmp/partial.json', {
      readFile: () => JSON.stringify({ robashAllow: ['ls'] }),
      logger,
    })
    expect(result.tables.robashAllow).toEqual(['ls'])
    expect(result.tables.robashDeny).toEqual([...FALLBACK_TABLES.robashDeny])
    expect(result.source.robashAllow).toBe('file')
    expect(result.source.robashDeny).toBe('fallback')
  })
})

describe('createWhitelistDefaultsCache', () => {
  it('reads the file once per process and serves later calls from the cache', () => {
    const reader = countingReader({ '/shipped.json': JSON.stringify({ robashAllow: ['ls'] }) })
    const cache = createWhitelistDefaultsCache({ readFile: reader.readFile })
    const first = cache.tables('/shipped.json')
    const second = cache.tables('/shipped.json')
    expect(reader.reads).toHaveLength(1)
    expect(second.tables.robashAllow).toEqual(first.tables.robashAllow)
  })

  it('re-reads only when the reload entry clears the cache', () => {
    let contents = JSON.stringify({ robashAllow: ['ls'] })
    const reads = []
    const cache = createWhitelistDefaultsCache({
      readFile: (filePath) => {
        reads.push(String(filePath))
        return contents
      },
    })
    expect(cache.tables('/shipped.json').tables.robashAllow).toEqual(['ls'])

    // editing the file alone changes nothing: the read is explicit, not mtime-driven
    contents = JSON.stringify({ robashAllow: ['ls', 'probe'] })
    expect(cache.tables('/shipped.json').tables.robashAllow).toEqual(['ls'])

    cache.reload()
    expect(cache.tables('/shipped.json').tables.robashAllow).toEqual(['ls', 'probe'])
    expect(reads).toHaveLength(2)
  })

  it('re-reads when the configured path changes, without an explicit reload', () => {
    const reader = countingReader({
      '/a.json': JSON.stringify({ robashAllow: ['from-a'] }),
      '/b.json': JSON.stringify({ robashAllow: ['from-b'] }),
    })
    const cache = createWhitelistDefaultsCache({ readFile: reader.readFile })
    expect(cache.tables('/a.json').tables.robashAllow).toEqual(['from-a'])
    expect(cache.tables('/b.json').tables.robashAllow).toEqual(['from-b'])
    expect(reader.reads).toEqual(['/a.json', '/b.json'])
  })
})
