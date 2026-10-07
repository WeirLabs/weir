#!/usr/bin/env node
// Release orchestrator for weir-harness (AGENTS.md §4.4).
//
//   node scripts/release.mjs <X.Y.Z> [--dry-run] [--skip-it] [--no-publish]
//
// Sequence: clean-worktree check → CHANGELOG finalize → manifest bump →
// gates (check, unit tests, integration tests) → commit → tag → publish.
// --dry-run computes everything in memory, still runs the gates, and never
// writes files, commits, tags, or publishes.

import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const CHANGELOG = join(ROOT, 'CHANGELOG.md')
const MANIFEST = join(ROOT, 'plugins/weir-harness/package.json')

// ---------- pure logic (unit-tested) ----------

export function parseVersion(input) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(input ?? '').trim())
  if (!m) throw new Error(`invalid version "${input}": releases use exact X.Y.Z (no range, no prerelease)`)
  return { major: +m[1], minor: +m[2], patch: +m[3], text: `${+m[1]}.${+m[2]}.${+m[3]}` }
}

export function finalizeChangelog(text, version, date) {
  const head = /^## \[Unreleased\]\s*$/m.exec(text)
  if (!head) throw new Error('CHANGELOG has no "## [Unreleased]" section')
  const rest = text.slice(head.index + head[0].length)
  const next = /^## \[/m.exec(rest)
  const body = (next ? rest.slice(0, next.index) : rest).trim()
  if (!body) throw new Error('CHANGELOG Unreleased section is empty — nothing to release')
  const tail = next ? rest.slice(next.index) : ''
  return text.slice(0, head.index)
    + '## [Unreleased]\n\n'
    + `## [${version}] - ${date}\n\n`
    + body + '\n\n'
    + tail.replace(/^\n+/, '')
}

export function bumpManifestVersion(text, version) {
  if (!/"version"\s*:\s*"[^"]+"/.test(text)) throw new Error('manifest has no "version" field')
  return text.replace(/"version"\s*:\s*"[^"]+"/, `"version": "${version}"`)
}

export function today(date = new Date()) {
  const p = n => String(n).padStart(2, '0')
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`
}

// ---------- shell helpers ----------

function pnpmCommand() {
  if (process.env.WEIR_PNPM) return { cmd: process.execPath, base: [process.env.WEIR_PNPM] }
  const bundled = join(homedir(), '.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs')
  if (existsSync(bundled)) return { cmd: process.execPath, base: [bundled] }
  return { cmd: 'pnpm', base: [] }
}

function run(cmd, args, label) {
  console.log(`\n=== ${label}: ${cmd} ${args.join(' ')}`)
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit' })
}

function runPnpm(args, label) {
  const { cmd, base } = pnpmCommand()
  run(cmd, [...base, ...args], label)
}

function gitClean() {
  const out = execFileSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8' }).trim()
  return out === ''
}

// ---------- main ----------

export async function main(argv) {
  const args = argv.slice(2)
  const flags = new Set(args.filter(a => a.startsWith('--')))
  const versionArg = args.find(a => !a.startsWith('--'))
  if (!versionArg) {
    console.error('usage: node scripts/release.mjs <X.Y.Z> [--dry-run] [--skip-it] [--no-publish]')
    return 2
  }
  const version = parseVersion(versionArg).text
  const dryRun = flags.has('--dry-run')
  const tag = `v${version}`

  // 1. preconditions
  if (!gitClean()) throw new Error('worktree is not clean — commit or stash everything before releasing')
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', tag], { cwd: ROOT, stdio: 'pipe' })
    throw new Error(`tag ${tag} already exists`)
  } catch (e) {
    if (e.status !== 1) throw e // status 1 = tag absent, as required
  }

  // 2. compute transforms
  const changelog = finalizeChangelog(readFileSync(CHANGELOG, 'utf8'), version, today())
  const manifest = bumpManifestVersion(readFileSync(MANIFEST, 'utf8'), version)
  console.log(`release ${tag}: CHANGELOG finalized, manifest bumped to ${version}${dryRun ? ' (dry-run: not writing)' : ''}`)

  // 3. write (skipped in dry-run)
  if (!dryRun) {
    writeFileSync(CHANGELOG, changelog)
    writeFileSync(MANIFEST, manifest)
  }

  // 4. gates (always run, even in dry-run)
  runPnpm(['--filter', 'weir-harness', 'run', 'check'], 'gate: static check')
  runPnpm(['--filter', 'weir-harness', 'test'], 'gate: unit tests')
  if (flags.has('--skip-it')) console.log('\n=== gate: integration tests SKIPPED (--skip-it)')
  else runPnpm(['--filter', 'weir-test-harness', 'run', 'test:integration'], 'gate: integration tests')

  if (dryRun) {
    console.log(`\ndry-run complete: all gates green. Real run would commit, tag ${tag}, and publish.`)
    return 0
  }

  // 5. commit + tag (lightweight, matching existing tag convention)
  run('git', ['add', 'CHANGELOG.md', 'plugins/weir-harness/package.json'], 'stage release files')
  run('git', ['commit', '-m', `chore: release ${tag}`], 'release commit')
  run('git', ['tag', tag], 'tag')

  // 6. publish
  if (flags.has('--no-publish')) console.log('\npublish skipped (--no-publish); run `pnpm --filter weir-harness publish` when ready')
  else runPnpm(['--filter', 'weir-harness', 'publish'], 'npm publish')

  console.log(`\nrelease ${tag} complete`)
  return 0
}

const invokedAsScript = process.argv[1] && fileURLToPath(import.meta.url) === join(process.argv[1])
if (invokedAsScript) {
  main(process.argv).then(code => process.exit(code), err => { console.error(`\nrelease aborted: ${err.message}`); process.exit(1) })
}
