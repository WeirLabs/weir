import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseVersion, finalizeChangelog, bumpManifestVersion } from './release.mjs'

test('parseVersion accepts exact X.Y.Z and normalizes leading zeros', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, text: '1.2.3' })
  assert.equal(parseVersion(' 01.02.003 ').text, '1.2.3')
})

test('parseVersion rejects ranges, prereleases and partial versions', () => {
  for (const bad of ['^1.2.3', '1.2', '1.2.3-rc.1', 'v1.2.3', '', undefined, '1.2.3.4'])
    assert.throws(() => parseVersion(bad), /invalid version/)
})

const SAMPLE = `# Changelog

## [Unreleased]

### Added

- something new

## [1.0.0] - 2026-10-08

### Changed

- old stuff
`

test('finalizeChangelog freezes Unreleased into a dated version section', () => {
  const out = finalizeChangelog(SAMPLE, '1.1.0', '2026-10-09')
  const unreleased = out.indexOf('## [Unreleased]')
  const released = out.indexOf('## [1.1.0] - 2026-10-09')
  const older = out.indexOf('## [1.0.0] - 2026-10-08')
  assert.ok(unreleased !== -1 && released !== -1 && older !== -1)
  assert.ok(unreleased < released && released < older, 'section order: Unreleased, new version, history')
  assert.ok(out.includes('- something new'), 'entries preserved under the new version')
  assert.ok(out.slice(unreleased, released).trim() === '## [Unreleased]', 'fresh Unreleased section is empty')
})

test('finalizeChangelog rejects an empty Unreleased section', () => {
  assert.throws(() => finalizeChangelog('# C\n\n## [Unreleased]\n\n## [1.0.0] - 2026-10-08\n', '1.1.0', '2026-10-09'), /empty/)
})

test('finalizeChangelog rejects a changelog without Unreleased', () => {
  assert.throws(() => finalizeChangelog('# C\n\n## [1.0.0] - 2026-10-08\n', '1.1.0', '2026-10-09'), /Unreleased/)
})

test('bumpManifestVersion rewrites only the version field', () => {
  const out = bumpManifestVersion('{\n  "name": "weir-harness",\n  "version": "0.7.0",\n  "type": "module"\n}\n', '1.1.0')
  assert.ok(out.includes('"version": "1.1.0"'))
  assert.ok(out.includes('"name": "weir-harness"'))
  assert.throws(() => bumpManifestVersion('{ "name": "x" }', '1.1.0'), /version/)
})
