// Process runners for the worktree service.
//
// - gitRunner: argv-only execution of git through ctx.subprocess (no shell,
//   no interpolation). The executable resolves through the LSP module's
//   extended resolver because a LaunchServices-started desktop host has a
//   minimal PATH (S21). Output is collected per stream with a deadline.
// - shellRunner: user-configured setup / verification commands (shell
//   strings) through ctx.shell with the calling session's per-call sandbox
//   policy — the same boundary the bash tool enforces (S23 / S26 S-G).
import { existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { childEnvironment, extraBinDirectories, resolveExecutable } from '../lsp/child-process.js'
import { resolveDerivedSetup } from './pkgmgr.js'

/** Vendor git install locations, probed when PATH resolution fails. */
function wellKnownGit(platform = process.platform) {
  const candidates = platform === 'win32'
    ? ['C:\\Program Files\\Git\\cmd\\git.exe', 'C:\\Program Files (x86)\\Git\\cmd\\git.exe']
    : ['/usr/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git']
  return candidates.filter((path) => {
    try {
      return statSync(path).isFile()
    } catch {
      return false
    }
  })
}

/**
 * Resolve git: the service resolver, then vendored locations, then the LSP
 * module's directory scan. The desktop host runs with a minimal PATH (S21),
 * and headless CLI runs pass a scrubbed environment to children, so neither
 * alone is enough.
 */
export async function resolveGit(subprocess, env = process.env) {
  const fromService = await resolveExecutable(subprocess, 'git')
  if (fromService) return fromService
  for (const path of wellKnownGit()) return path
  for (const dir of extraBinDirectories(env)) {
    const candidate = `${dir}/git${process.platform === 'win32' ? '.exe' : ''}`
    if (existsSync(candidate)) return candidate
  }
  return undefined
}

const DEFAULT_GIT_TIMEOUT_MS = 120_000

/**
 * @param {any} subprocess - ctx.subprocess
 * @returns {(argv: string[], options: { cwd: string, timeoutMs?: number }) => Promise<{ code: number, stdout: string, stderr: string }>}
 */
export function createGitRunner(subprocess) {
  /** @type {Promise<string | undefined> | null} */
  let gitPath = null
  return async (argv, { cwd, timeoutMs = DEFAULT_GIT_TIMEOUT_MS }) => {
    gitPath ??= resolveGit(subprocess)
    const executable = await gitPath
    if (!executable) return { code: 127, stdout: '', stderr: 'git executable not found' }
    const [, ...args] = argv
    const handle = subprocess.spawn({
      argv: [executable, '-c', 'core.quotepath=off', ...args],
      cwd,
      stdio: { stdin: 'ignore', stdout: 'pipe', stderr: 'pipe' },
      graceMs: 2_000,
      env: { ...childEnvironment(), GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
    })
    let stdout = ''
    let stderr = ''
    handle.stdout?.on('data', (chunk) => {
      stdout += chunk.toString()
    })
    handle.stderr?.on('data', (chunk) => {
      stderr += chunk.toString()
    })
    let timer
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => {
        try {
          handle.terminate?.()
        } catch {
          // best-effort
        }
        resolve({ exitCode: 124, timedOut: true })
      }, timeoutMs)
      timer.unref?.()
    })
    try {
      const outcome = /** @type {any} */ (await Promise.race([handle.done.catch((error) => ({ exitCode: 127, error })), deadline]))
      if (outcome?.timedOut) return { code: 124, stdout, stderr: `${stderr}\ngit timed out after ${timeoutMs}ms` }
      if (outcome?.error) return { code: 127, stdout, stderr: String(outcome.error?.message ?? outcome.error) }
      // Let the stream tails drain before reading them.
      await new Promise((resolve) => setImmediate(resolve))
      return { code: typeof outcome?.exitCode === 'number' ? outcome.exitCode : 1, stdout, stderr }
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Resolve DERIVED setup commands against the real host: system package
 * manager first (the LSP module's extended resolver — S21), then the DSH
 * bundled runtime under the deployment's DSH home. Pure decision in
 * pkgmgr.js; this is only the seam wiring.
 * @param {{ subprocess: any, env?: Record<string, string | undefined>, home?: string, findExecutable?: (name: string) => Promise<string | undefined> }} options - `findExecutable` exists so tests can pin the lookup without fighting the host's real PATH scan
 * @returns {(manager: string) => Promise<ReturnType<typeof resolveDerivedSetup>>}
 */
export function createSetupResolver({ subprocess, env = process.env, home = homedir(), findExecutable }) {
  const find = findExecutable ?? ((name) => resolveExecutable(subprocess, name).catch(() => undefined))
  return async (manager) => {
    // Manager and node are resolved INDEPENDENTLY: the core asks the seam
    // for 'node' too, and feeding it the manager's path would inject the
    // manager's directory where a node directory belongs (B2 review).
    const [foundManager, foundNode] = await Promise.all([find(manager), find('node')])
    return resolveDerivedSetup(manager, {
      foundOnPath: (name) => (name === 'node' ? foundNode : name === manager ? foundManager : undefined),
      listDirs: (dir) => {
        try {
          return readdirSync(dir)
        } catch {
          return []
        }
      },
      isFile: (path) => {
        try {
          return statSync(path).isFile()
        } catch {
          return false
        }
      },
      dshHome: env.DSH_HOME,
      home,
    })
  }
}

/**
 * @param {any} shell - ctx.shell (absent on compositions without a bash executor)
 * @param {any} sandboxPolicy - ctx.sandboxPolicy (optional)
 * @returns {null | ((request: { command: string, cwd: string, timeoutMs: number, session?: any }) => Promise<{ code: number, output: string, denied: boolean, timedOut: boolean }>)}
 */
export function createShellRunner(shell, sandboxPolicy) {
  if (!shell?.resolve || !shell?.execute) return null
  return async ({ command, cwd, timeoutMs, session }) => {
    const policy = sandboxPolicy?.resolve?.(session ? { session } : {})
    const spec = shell.resolve({
      command,
      workdir: cwd,
      timeoutMs,
      ...(policy ? { sandboxPolicy: policy } : {}),
    })
    const result = await (await shell.execute(spec)).result()
    const output = [result.stdout?.text ?? '', result.stderr?.text ?? ''].filter(Boolean).join('\n')
    return {
      code: typeof result.exitCode === 'number' ? result.exitCode : 1,
      output,
      denied: result.sandbox?.denied === true,
      timedOut: result.timedOut === true,
    }
  }
}
