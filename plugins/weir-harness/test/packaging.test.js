// npm-public-distribution group 1: the bundle manifest is publish-ready for the
// public npm registry — no `private` gate, a `files` whitelist that covers every
// runtime-required path, a DSH peer range for the compatibility gate, and a
// prepack hook that re-runs check/test/build before any pack.
import { test, expect } from './helpers.js'
import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))

const RUNTIME_REQUIRED = ['src', 'lib', 'skills', 'cordis.patch.yml', 'whitelist-defaults.json']

/**
 * Minimal npm semver-range validity gate (union of comparator sets; optional
 * operator; v-prefix, wildcards and prerelease tags allowed). The manifest is a
 * known value — this guards against typos that would silently break the DSH
 * compatibility gate, it is not a full semver implementation.
 */
const isValidSemverRange = (range) => {
  if (typeof range !== 'string' || range.trim() === '') return false
  const comparator = /^(?:>=|<=|>|<|=|~|\^)?\s*v?(?:\d+|x|\*)(?:\.(?:\d+|x|\*))?(?:\.(?:\d+|x|\*))?(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/
  return range.split('||').every(set => {
    const tokens = set.trim().split(/\s+/).filter(Boolean)
    return tokens.length > 0 && tokens.every(token => comparator.test(token))
  })
}

test('manifest parses and carries no `private` key', () => {
  expect(manifest.name).toBe('weir-harness')
  expect('private' in manifest).toBe(false)
})

test('the files whitelist covers every runtime-required path', () => {
  expect(Array.isArray(manifest.files)).toBe(true)
  for (const path of RUNTIME_REQUIRED) {
    expect(manifest.files, path).toContain(path)
  }
})

test('the DSH peer dependency is declared as a valid semver range', () => {
  const range = manifest.peerDependencies?.['@deepseek-ai/dsh']
  expect(typeof range).toBe('string')
  expect(isValidSemverRange(range), range).toBe(true)
})

test('the prepack hook re-runs check, test and build', () => {
  const prepack = manifest.scripts?.prepack
  expect(typeof prepack).toBe('string')
  expect(prepack).toContain('check')
  expect(prepack).toContain('test')
  expect(prepack).toContain('build')
})

test('every path listed in files exists on disk', () => {
  for (const path of manifest.files) {
    expect(existsSync(join(packageRoot, path)), path).toBe(true)
  }
})
