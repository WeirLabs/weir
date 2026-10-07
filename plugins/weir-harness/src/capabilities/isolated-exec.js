// Tasks 10.4/10.5 of the session-capability-manager change: the pinned
// executor baseline and the isolated execution layer for managed external
// installs/updates.
//
// 10.4 — the managed external executable is `vercel-labs/skills` pinned at
// version 1.7.0 / commit 3694740352eeef5cdd689af694c485f1ff62eec3. It is
// never a bundle npm dependency; the source, artifact integrity and the
// ACTUAL version are recorded, the revision in use is reported in every
// diagnostic, and any deviation from the pin is reported and REFUSES the
// managed install/update until a compatibility test passes with explicit
// user authorization.
//
// 10.5 — isolation: a private staging HOME/XDG/cwd, explicit non-interactive
// argv (never shell-concatenated from source text), `shell: false`,
// telemetry off, isolated user git config, no Git hooks / external diff or
// filter drivers, no source scripts executed. One operation never exceeds
// 5 minutes or 4 MiB of stdout+stderr combined; breaching either terminates
// the whole process tree, redacts diagnostics and records the failure.

export const EXECUTOR_PIN = Object.freeze({
  repository: 'vercel-labs/skills',
  version: '1.7.0',
  commit: '3694740352eeef5cdd689af694c485f1ff62eec3',
})

export const EXEC_LIMITS = Object.freeze({ timeoutMs: 300_000, maxOutputBytes: 4_194_304 })

/**
 * The baseline verdict for one executor instance (10.4): exact pin match
 * runs; any deviation reports and refuses.
 * @param {{ version?: string, commit?: string }} actual
 * @returns {{ run: boolean, revision: string, deviation: string|null }}
 */
export function pinVerdict(actual) {
  const revision = actual?.commit ?? actual?.version ?? 'unknown'
  if (actual?.version !== EXECUTOR_PIN.version || actual?.commit !== EXECUTOR_PIN.commit) {
    return {
      run: false,
      revision,
      deviation: `executor baseline deviation: expected ${EXECUTOR_PIN.repository}@${EXECUTOR_PIN.version} (${EXECUTOR_PIN.commit}), got ${actual?.version ?? 'unknown'} (${actual?.commit ?? 'unknown'}); managed install/update is refused until a compatibility test passes with user authorization`,
    }
  }
  return { run: true, revision: EXECUTOR_PIN.commit, deviation: null }
}

/**
 * The non-interactive argv for one managed install (10.5). Arguments are
 * passed VERBATIM (paths and refs with spaces stay single array items);
 * nothing from source text is ever concatenated into a shell string.
 * @param {{ repository: string, skill: string, agent?: string, yes?: never }} input
 */
export function installArgv({ repository, skill, agent = 'universal' }) {
  for (const [label, value] of [['repository', repository], ['skill', skill], ['agent', agent]]) {
    if (typeof value !== 'string' || value.length === 0) throw new TypeError(`install argv needs a non-empty ${label}`)
  }
  return ['skills', 'add', repository, '--skill', skill, '--agent', agent, '--no-interactive']
}

/**
 * The isolated env for one managed invocation (10.5): private staging
 * HOME/XDG, telemetry off, git noise silenced.
 * @param {{ stagingHome: string }} input
 */
export function isolatedEnv({ stagingHome }) {
  if (typeof stagingHome !== 'string' || stagingHome.length === 0) throw new TypeError('a staging home is required')
  return {
    HOME: stagingHome,
    XDG_CONFIG_HOME: stagingHome,
    XDG_CACHE_HOME: stagingHome,
    XDG_DATA_HOME: stagingHome,
    XDG_STATE_HOME: stagingHome,
    TMPDIR: stagingHome,
    SKILLS_TELEMETRY: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0',
    GIT_HOOKS_PATH: '/dev/null',
    GIT_EXTERNAL_DIFF: '',
    GIT_DIFF_DRIVER: '',
    GIT_FILTER_BRANCH_COMMAND: '',
    CI: '1',
  }
}

/** The spawn options for one managed invocation (10.5). */
export function spawnOptionsFor({ stagingHome }) {
  return { argv0: 'skills', env: isolatedEnv({ stagingHome }), cwd: stagingHome, shell: false, timeout: EXEC_LIMITS.timeoutMs, maxBuffer: EXEC_LIMITS.maxOutputBytes }
}

/**
 * The diagnostics for one run (10.4/10.5): the revision in use is always
 * reported, and secrets are redacted from any echo.
 * @param {{ revision: string, argv: string[], code: number|null, stdout: string, stderr: string, timedOut?: boolean, overOutput?: boolean }} run
 */
export function runDiagnostics({ revision, argv, code, stdout, stderr, timedOut = false, overOutput = false }) {
  const redact = text => String(text).replace(/(token|secret|password|key)[=:]\s*\S+/gi, '$1=<redacted>')
  return {
    revision,
    argv: [...argv],
    code,
    timedOut,
    overOutput,
    stdout: redact(stdout).slice(0, 2000),
    stderr: redact(stderr).slice(0, 2000),
  }
}
