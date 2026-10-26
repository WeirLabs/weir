import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import {
  parseVersion,
  finalizeChangelog,
  bumpManifestVersion,
  parseReleaseArgs,
  releaseCompletion,
  USAGE,
} from './release.mjs'

const RELEASE_SOURCE = readFileSync(new URL('./release.mjs', import.meta.url), 'utf8')

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

test('local release automation has no npm or pnpm publish execution branch', () => {
  const forbiddenCalls = [
    /runPnpm\(\s*\[[^\]]*['"]publish['"]/,
    /run\(\s*['"](?:npm|pnpm)['"]\s*,\s*\[[^\]]*['"]publish['"]/,
    /execFileSync\(\s*['"](?:npm|pnpm)['"]\s*,\s*\[[^\]]*['"]publish['"]/,
  ]
  for (const pattern of forbiddenCalls) {
    assert.equal(pattern.test(RELEASE_SOURCE), false, `local publish execution matches ${pattern}`)
  }
})

test('legacy --no-publish only warns and leaves release options unchanged', () => {
  const base = ['1.2.3', '--dry-run', '--skip-it']
  const plain = parseReleaseArgs(base)
  const legacy = parseReleaseArgs([...base, '--no-publish'])
  const { warnings: plainWarnings, ...plainOptions } = plain
  const { warnings: legacyWarnings, ...legacyOptions } = legacy

  assert.deepEqual(legacyOptions, plainOptions)
  assert.deepEqual(plainWarnings, [])
  assert.deepEqual(legacyWarnings, [
    '--no-publish is deprecated and has no effect; npm publication runs only through GitHub Actions.',
  ])
  assert.equal(USAGE, 'usage: node scripts/release.mjs <X.Y.Z> [--dry-run] [--skip-it]')
})

test('successful local preparation hands off to GitHub with both push commands', () => {
  const output = releaseCompletion('v1.2.3')
  assert.match(output, /release v1\.2\.3 prepared/)
  assert.ok(output.includes('git push origin main'))
  assert.ok(output.includes('git push origin v1.2.3'))
  assert.match(output, /GitHub Actions.*OIDC Trusted Publishing/)
  assert.doesNotMatch(output, /\b(?:npm|pnpm)\b[^\n]*\bpublish\b/)
  assert.doesNotMatch(output, /publish skipped|when ready/i)
})

test('dry-run completion previews only commit, tag and GitHub handoff', () => {
  const output = releaseCompletion('v1.2.3', { dryRun: true })

  assert.match(output, /^dry-run complete: all gates green\./)
  assert.ok(output.includes('No files were written and no commit or tag was created.'))
  assert.ok(output.includes('A real run would create the release commit and tag v1.2.3, then hand off to GitHub:'))
  assert.ok(output.includes('git push origin main'))
  assert.ok(output.includes('git push origin v1.2.3'))
  assert.doesNotMatch(output, /and publish|publish skipped|when ready/i)
  assert.doesNotMatch(output, /\b(?:npm|pnpm)\b[^\n]*\bpublish\b/)
})

test('release workflow validates tag and notes before OIDC publish', () => {
  const workflow = readFileSync(new URL('../.github/workflows/release.yml', import.meta.url), 'utf8')
  const anchors = [
    '- name: verify tag matches manifest version',
    '- name: prepare release notes',
    '- run: npm publish --provenance --access public',
    '- name: create GitHub Release',
  ]
  const [tagCheck, notesPrepare, publish, githubRelease] = anchors.map(anchor => {
    const index = workflow.indexOf(anchor)
    assert.notEqual(index, -1, `missing workflow anchor: ${anchor}`)
    return index
  })

  assert.ok(
    tagCheck < notesPrepare && notesPrepare < publish && publish < githubRelease,
    'tag check → notes preflight → OIDC publish → GitHub Release',
  )
  assert.match(workflow, /id-token: write/)
  assert.match(workflow, /registry-url: https:\/\/registry\.npmjs\.org/)

  const notesStep = workflow.slice(notesPrepare, publish)
  assert.ok(notesStep.includes('awk -v ver="## [${GITHUB_REF_NAME#v}]"'))
  assert.ok(notesStep.includes('CHANGELOG.md > /tmp/release-notes.md'))
  assert.ok(notesStep.includes('if [ ! -s /tmp/release-notes.md ]; then'))

  const releaseStep = workflow.slice(githubRelease)
  assert.ok(releaseStep.includes('gh release create "$GITHUB_REF_NAME" --title "$GITHUB_REF_NAME" --notes-file /tmp/release-notes.md'))
  assert.doesNotMatch(releaseStep, /\bawk\b|CHANGELOG\.md|! -s/)
})
