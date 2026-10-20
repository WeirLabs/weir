// Discover the dsh CLI the integration harness boots.
//
// The previous default was one hardcoded path into /tmp/dsh-src — the extracted
// DSH reference that AGENTS §2 registers as volatile. Once that extraction was
// cleaned away, every caller that had not set an override (including
// scripts/release.mjs, which runs the integration gate bare) booted
// `node <missing bin.js>` and every scenario died as MODULE_NOT_FOUND with an
// empty requireStack: an error that names nothing about the real cause.
//
// Discovery is therefore explicit and ordered. First hit wins:
//   1. WEIR_IT_DSH_EXEC — a self-contained launcher (for example the desktop
//      app's runtime/cli/bin/dsh), spawned as-is. Existence is NOT checked:
//      an explicit override is the caller's responsibility.
//   2. WEIR_IT_DSH      — the CLI entry (lib/bin.js) of the tree under test,
//      booted with WEIR_IT_NODE.
//   3. platform candidates — adopted only when the path exists:
//      POSIX — extracted reference (/tmp/dsh-src), then the desktop app,
//              system-wide before per-user;
//      win32 — the npm-global install, then the desktop app's app.asar tree.
//   4. nothing found    — throw an error that lists every path tried plus the
//      two overrides that fix it, so the failure names its own remedy.
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { posix, win32 } from 'node:path'

/** Join with the separator convention of `platform`, not of the host running this. */
function joinerFor(platform) {
  return platform === 'win32' ? win32.join : posix.join
}

/** A non-empty trimmed environment value, or null when unset/blank. */
function explicit(value) {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

/** The ordered platform candidates; each carries the label reported as `source`. */
function platformCandidates({ env, platform, home }) {
  const join = joinerFor(platform)
  // `@deepseek-ai/dsh/lib/bin.js` inside an installation root.
  const entryIn = (root) => join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const appCliIn = (appDir) => join(appDir, 'Contents', 'Resources', 'runtime', 'cli', 'bin', 'dsh')

  if (platform === 'win32') {
    // npm-global CLI: a plain `dsh` entry, booted with the node binary.
    const npmRoot = join(env.APPDATA ?? join(home, 'AppData', 'Roaming'), 'npm')
    // Desktop app: its own dsh tree inside app.asar, same node-booted shape.
    const appRoot = join(env.ProgramFiles ?? 'C:\\Program Files', 'DeepSeek Harness', 'resources', 'app.asar', 'dsh')
    return [
      { kind: 'node', path: entryIn(npmRoot), source: `candidate:${npmRoot}` },
      { kind: 'node', path: entryIn(appRoot), source: `candidate:${appRoot}` },
    ]
  }

  const extracted = '/tmp/dsh-src/dsh'
  const systemApp = '/Applications/DeepSeek Harness.app'
  const userApp = join(home, 'Applications', 'DeepSeek Harness.app')
  return [
    { kind: 'node', path: entryIn(extracted), source: 'candidate:/tmp/dsh-src' },
    { kind: 'exec', path: appCliIn(systemApp), source: `candidate:${systemApp}` },
    { kind: 'exec', path: appCliIn(userApp), source: `candidate:${userApp}` },
  ]
}

/** The all-candidates-missed error: what to set, and every path that was tried. */
function noLauncherError(platform, attempts) {
  return new Error([
    'no dsh launcher found: cannot locate a dsh CLI to boot the headless integration profile.',
    '',
    'Set one explicitly:',
    '  WEIR_IT_DSH_EXEC  a self-contained CLI launcher (spawned as-is), e.g. the desktop app:',
    '    WEIR_IT_DSH_EXEC="/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh"',
    '  WEIR_IT_DSH       the dsh CLI entry (lib/bin.js), booted with WEIR_IT_NODE',
    '',
    `Candidate paths tried on platform "${platform}" (none exists):`,
    ...attempts.map((attempt) => `  ${attempt.source}: ${attempt.path}`),
    '',
    'Install the desktop app (its CLI is the launcher shown above), re-extract DSH to /tmp/dsh-src,',
    'or point WEIR_IT_DSH_EXEC at an existing launcher.',
  ].join('\n'))
}

/**
 * Resolve how to launch dsh for one integration run.
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   platform?: string,
 *   exists?: (path: string) => boolean,
 *   home?: string,
 * }} [options] - injectable seams; tests pass all four and never spawn
 * @returns {{kind: 'exec'|'node', path: string, source: string}} the launcher:
 *   `exec` spawns `path` itself, `node` spawns `NODE path ...args`
 * @throws {Error} when no explicit override is set and no candidate exists
 */
function resolveDshLauncher({ env = process.env, platform = process.platform, exists = existsSync, home = homedir() } = {}) {
  const exec = explicit(env.WEIR_IT_DSH_EXEC)
  if (exec) return { kind: 'exec', path: exec, source: 'env:WEIR_IT_DSH_EXEC' }

  const entry = explicit(env.WEIR_IT_DSH)
  if (entry) return { kind: 'node', path: entry, source: 'env:WEIR_IT_DSH' }

  const attempts = platformCandidates({ env, platform, home })
  for (const attempt of attempts) {
    if (exists(attempt.path)) return { kind: attempt.kind, path: attempt.path, source: attempt.source }
  }
  throw noLauncherError(platform, attempts)
}

export { resolveDshLauncher }
