// Replay-fixture self-containment conformance (test-harness-fixture-selfcontainment,
// design D2/D3): a replay fixture must replay green from ANY checkout, so every
// file its replay consumes must be git-tracked — never present only on the
// recorder's disk. Three judgements per registered scenario's fixture:
//
//   1. RULES — the repo-root .gitignore must make the trackable state-file
//      kinds (TRACKABLE_ORRERY_STATE_KINDS) addable under EVERY fixture's
//      ws/.orrery/ via one wildcard ruleset, and keep everything else ignored.
//      Judged on probe paths with pure pattern semantics
//      (`git check-ignore --no-index`), independent of what is on disk.
//   2. FILES — every file under a fixture dir (fixture root run.json /
//      trace*.jsonl, ws top level, ws/.orrery/ recursive; wider on purpose)
//      must be git-tracked (`git ls-files`), and no untracked + ignored path
//      may exist (default `git check-ignore` reports exactly that class — it
//      consults the index, so tracked legacy files stay unreported).
//   3. ENUM — under ws/.orrery/, every on-disk file must be either an enum
//      kind or pattern-ignored; an out-of-enum file the rules no longer ignore
//      means someone widened .gitignore without extending the enum.
//
// TRACKABLE_ORRERY_STATE_KINDS is the single-point enum and maps 1:1 to the
// wildcard un-ignore chains in the repo-root .gitignore. Extending the kinds =
// extend the enum AND the rules together; this suite fails while they diverge.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCENARIOS } from '../src/scenarios/index.js'

const HERE = realpathSync(fileURLToPath(new URL('.', import.meta.url)))
const ROOT = realpathSync(spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: HERE, encoding: 'utf8' }).stdout.trim())
const FIXTURES = join(HERE, 'fixtures', 'traces')
const FIXTURES_REL = 'plugins/orrery-test-harness/test/fixtures/traces'

const TRACKABLE_ORRERY_STATE_KINDS = ['audit.jsonl', 'worktrees/lanes.json']

// Canary probes for the "everything else stays ignored" half: representative
// out-of-enum runtime state kinds that must never become addable from a
// fixture workspace. A probe list, not an enum.
const IGNORED_ORRERY_PROBES = ['sessions/canary.json', 'home/canary.json', 'worktrees/canary.json', 'edit-lock-canary/snapshot.json', 'canary.txt']

/** Repo-root-relative, forward-slashed path (what git prints and parses). */
function gitPath(absolute) {
  return relative(ROOT, absolute).split(sep).join('/')
}

/** git check-ignore over repo-relative paths; returns the reported set. */
function checkIgnore(paths, { noIndex = false } = {}) {
  const reported = new Set()
  if (paths.length === 0) return reported
  const args = ['check-ignore', '-z', '--stdin']
  if (noIndex) args.push('--no-index')
  const result = spawnSync('git', args, { cwd: ROOT, input: paths.join('\0') + '\0', encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw result.error
  assert.ok(result.status === 0 || result.status === 1, `git check-ignore failed (${result.status}): ${result.stderr}`)
  for (const entry of result.stdout.split('\0')) if (entry) reported.add(entry)
  return reported
}

/** Tracked (staged or committed) repo-relative paths under the fixtures tree. */
function trackedFixturePaths() {
  const result = spawnSync('git', ['ls-files', '-z', '--', FIXTURES_REL], { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `git ls-files failed: ${result.stderr}`)
  return new Set(result.stdout.split('\0').filter(Boolean))
}

/** Every file under dir, recursively (absolute paths). */
function listFiles(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) out.push(...listFiles(path))
    else out.push(path)
  }
  return out
}

describe('replay fixture self-containment', () => {
  it('the wildcard rules make exactly the enum kinds trackable under every fixture workspace', () => {
    const enumProbes = []
    const canaries = []
    for (const scenario of SCENARIOS) {
      const orreryDir = join(FIXTURES, scenario.id, 'ws', '.orrery')
      for (const kind of TRACKABLE_ORRERY_STATE_KINDS) enumProbes.push({ scenario: scenario.id, kind, path: gitPath(join(orreryDir, ...kind.split('/'))) })
      for (const probe of IGNORED_ORRERY_PROBES) canaries.push({ scenario: scenario.id, probe, path: gitPath(join(orreryDir, ...probe.split('/'))) })
    }
    const ignored = checkIgnore([...enumProbes, ...canaries].map((entry) => entry.path), { noIndex: true })
    assert.deepEqual(
      enumProbes.filter((entry) => ignored.has(entry.path)).map((entry) => `${entry.scenario}: ws/.orrery/${entry.kind}`),
      [],
      'enum state-file kinds must be un-ignored under EVERY fixture workspace (one wildcard ruleset, no per-fixture stanzas)',
    )
    assert.deepEqual(
      canaries.filter((entry) => !ignored.has(entry.path)).map((entry) => `${entry.scenario}: ws/.orrery/${entry.probe}`),
      [],
      'out-of-enum runtime state must stay ignored under fixture workspaces',
    )
  })

  it('every replay-consumed fixture file is git-tracked', () => {
    const files = []
    for (const scenario of SCENARIOS) {
      const dir = join(FIXTURES, scenario.id)
      assert.ok(existsSync(join(dir, 'run.json')), `${scenario.id}: missing fixture — re-record with \`pnpm run record\``)
      for (const absolute of listFiles(dir)) files.push({ scenario: scenario.id, rel: relative(dir, absolute).split(sep).join('/'), path: gitPath(absolute) })
    }
    const ignoredAndUntracked = checkIgnore(files.map((file) => file.path))
    const tracked = trackedFixturePaths()
    const silent = files.filter((file) => ignoredAndUntracked.has(file.path))
    const forgotten = files.filter((file) => !ignoredAndUntracked.has(file.path) && !tracked.has(file.path))
    assert.deepEqual(
      silent.map((file) => `${file.scenario}: ${file.rel}`),
      [],
      'fixture files ignored by git and untracked never ship in a fresh checkout — fix the .gitignore rules/enum, then add and commit them',
    )
    assert.deepEqual(
      forgotten.map((file) => `${file.scenario}: ${file.rel}`),
      [],
      'fixture files not git-tracked are missing from fresh checkouts — git add and commit them',
    )
  })

  it('no out-of-enum un-ignored file exists under any fixture ws/.orrery/', () => {
    const outOfEnum = []
    for (const scenario of SCENARIOS) {
      const orreryDir = join(FIXTURES, scenario.id, 'ws', '.orrery')
      if (!existsSync(orreryDir)) continue
      for (const absolute of listFiles(orreryDir)) {
        const kind = relative(orreryDir, absolute).split(sep).join('/')
        if (!TRACKABLE_ORRERY_STATE_KINDS.includes(kind)) outOfEnum.push({ scenario: scenario.id, kind, path: gitPath(absolute) })
      }
    }
    const ignored = checkIgnore(outOfEnum.map((entry) => entry.path), { noIndex: true })
    assert.deepEqual(
      outOfEnum.filter((entry) => !ignored.has(entry.path)).map((entry) => `${entry.scenario}: ws/.orrery/${entry.kind}`),
      [],
      `out-of-enum fixture state must stay ignored — extend TRACKABLE_ORRERY_STATE_KINDS and the .gitignore rules together, or drop the file`,
    )
  })
})
