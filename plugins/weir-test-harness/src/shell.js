// Platform shell abstraction for the integration harness.
//
// The headless profile mounts the weir modules at host level, so the
// read-only shell a curated agent receives is picked by platform: `pwsh` on
// win32, `bash` everywhere else (same convention as the product's
// `readOnlyShellName`). The scripted mock LLM therefore must not emit a
// hardcoded `bash` command line — it emits a NAMED OPERATION, and this module
// renders that operation in the platform's own shell.
//
// Deliberately NOT a general shell translator: only the verbs the scenarios
// actually need are defined, and every argument is validated against a strict
// grammar so a scenario string can never smuggle shell syntax. Adding a verb
// means adding a builder here plus a case in the contract test.

/** Unix: `rm` matches DEFAULT_ROBASH.deny. */
const POSIX_BUILDERS = {
  'echo-only': ({ text }) => `echo ${text}`,
  'echo-and-wait': ({ text, seconds }) => `echo ${text} && sleep ${seconds}`,
  wait: ({ seconds }) => `sleep ${seconds}`,
  'stay-busy': ({ seconds }) => `sleep ${seconds}`,
  'remove-file': ({ path }) => `rm -rf ${path}`,
}

/** Windows: `Remove-Item` matches DEFAULT_ROBASH_PWSH.deny. */
const WIN32_BUILDERS = {
  'echo-only': ({ text }) => `Write-Output "${text}"`,
  'echo-and-wait': ({ text, seconds }) => `Write-Output "${text}"; Start-Sleep -Seconds ${seconds}`,
  wait: ({ seconds }) => `Start-Sleep -Seconds ${seconds}`,
  'stay-busy': ({ seconds }) => `Start-Sleep -Seconds ${seconds}`,
  'remove-file': ({ path }) => `Remove-Item -Force -Recurse ${path}`,
}

const BUILDERS_BY_PLATFORM = { win32: WIN32_BUILDERS, posix: POSIX_BUILDERS }

/** The operation vocabulary, exported so tests can pin it. */
const SHELL_OPERATIONS = Object.freeze(Object.keys(POSIX_BUILDERS))

/** A bare word: file name or marker token. No separators, no metacharacters. */
const SAFE_TOKEN = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/

/**
 * The per-verb argument validators, exported so the contract test can pin that
 * every verb has exactly one on every platform. Keeping this table keyed by the
 * same verb names as the builder tables, and asserted symmetric by the contract
 * test, is what makes "a new verb without validation" structurally impossible.
 */
const ARG_VALIDATORS = {
  'echo-only': (args) => ({ text: requireSafeToken(args.text, 'text') }),
  'echo-and-wait': (args) => ({ text: requireSafeToken(args.text, 'text'), seconds: requireSeconds(args) }),
  wait: (args) => ({ seconds: requireSeconds(args) }),
  'stay-busy': (args) => ({ seconds: requireSeconds(args) }),
  'remove-file': (args) => ({ path: requireSafeToken(args.path, 'path') }),
}

/**
 * The read-only shell tool name a curated agent receives on this platform.
 * @param {string} [platform] - defaults to the host platform
 * @returns {'pwsh'|'bash'}
 */
function shellToolName(platform = process.platform) {
  return platform === 'win32' ? 'pwsh' : 'bash'
}

function buildersFor(platform) {
  if (platform === 'win32') return BUILDERS_BY_PLATFORM.win32
  if (platform === 'darwin' || platform === 'linux') return BUILDERS_BY_PLATFORM.posix
  throw new Error(`shellCommand: unknown platform '${platform}'`)
}

function requireSeconds(args) {
  const seconds = args.seconds
  if (!Number.isInteger(seconds) || seconds < 0) {
    throw new Error(`shellCommand: seconds must be a non-negative integer, got ${String(seconds)}`)
  }
  return seconds
}

function requireSafeToken(value, field) {
  if (typeof value !== 'string' || !SAFE_TOKEN.test(value)) {
    throw new Error(`shellCommand: ${field} must match ${String(SAFE_TOKEN)}, got ${JSON.stringify(value)}`)
  }
  return value
}


/**
 * Render one named shell operation for a platform.
 * @param {string} operation - a member of SHELL_OPERATIONS
 * @param {string} platform - 'win32' | 'darwin' | 'linux'
 * @param {{text?: string, path?: string, seconds?: number}} [args]
 * @returns {string} the command line to hand to the shell tool
 */
function shellCommand(operation, platform, args = {}) {
  const builders = buildersFor(platform)
  const build = builders[operation]
  if (typeof build !== 'function') {
    throw new Error(`shellCommand: unknown shell operation '${operation}' (known: ${SHELL_OPERATIONS.join(', ')})`)
  }
  // Args validators live in a table keyed by the same verb names as the builder
  // tables, so a new verb cannot be added without also declaring how its
  // arguments are validated (the contract test pins the three tables' key sets
  // to be identical).
  return build(ARG_VALIDATORS[operation](args))
}

export { ARG_VALIDATORS, SHELL_OPERATIONS, shellCommand, shellToolName }
