// Read-only shell guard core: the single canonical home of every cross-shell
// policy the bash and pwsh adapters share — the whitelist tables (one
// representation, consumed by the guard adapters, delegate/index.js, and
// shared/whitelist-defaults.js), the git gate, the GIT_CONFIG_* environment
// smuggle refusal, the recursion budget, the redirect sink policy, and the
// per-executable verdict tail. Pure functions, no ctx access.
//
// Shell LEXING stays in the adapters (robash-guard.js / robash-guard-pwsh.js):
// bash and pwsh tokenization differ for real (expression groups, here-strings,
// the three & roles, alias expansion), so the scanners are not merged.

/** Canonical whitelist tables, organized by the five published keys so
 * shared/whitelist-defaults.js derives FALLBACK_TABLES with zero translation.
 * Entries moved verbatim from the former DEFAULT_ROBASH (robash-guard.js) and
 * DEFAULT_ROBASH_PWSH (robash-guard-pwsh.js); pwsh entries keep their original
 * casing (the pwsh adapter lowercases at lookup) so the shipped
 * whitelist-defaults.json stays byte-comparable. */
export const DEFAULT_TABLES = {
  robashAllow: [
    'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'sort', 'uniq', 'tr', 'cut',
    'fold', 'fmt', 'nl', 'rev', 'tac', 'comm', 'join', 'paste', 'diff', 'cmp', 'jq',
    'pwd', 'echo', 'printf', 'date', 'uname', 'whoami', 'id', 'printenv', 'which', 'type',
    'basename', 'dirname', 'readlink', 'realpath', 'stat', 'file', 'du', 'df',
    'md5', 'md5sum', 'shasum', 'cksum', 'sleep',
    'cd', 'pushd', 'popd', 'true', 'false', ':', 'test', '[',
    'find', 'git',
  ],
  robashGitAllow: [
    'status', 'log', 'show', 'diff', 'blame', 'grep', 'ls-files', 'ls-tree',
    'rev-parse', 'describe', 'shortlog',
  ],
  robashDeny: [
    'rm', 'mv', 'cp', 'chmod', 'chown', 'chgrp', 'mkdir', 'rmdir', 'touch', 'ln', 'dd',
    'mkfifo', 'mktemp', 'tee', 'tar', 'zip', 'unzip', 'gzip', 'gunzip', 'bzip2', 'xz',
    'install', 'rsync', 'scp', 'ssh', 'sftp', 'curl', 'wget',
    'sudo', 'su', 'doas', 'kill', 'pkill', 'killall', 'shutdown', 'reboot', 'halt', 'poweroff',
    'launchctl', 'systemctl', 'service', 'crontab', 'at', 'batch',
    'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'csh', 'tcsh',
    'eval', 'exec', 'source', '.', 'xargs', 'parallel', 'env',
    'node', 'python', 'python3', 'ruby', 'perl', 'php', 'lua', 'julia',
    'npm', 'pnpm', 'yarn', 'bun', 'deno', 'pip', 'pip3', 'conda',
    'brew', 'apt', 'apt-get', 'yum', 'dnf', 'pacman',
    'cargo', 'go', 'rustc', 'make', 'cmake', 'gcc', 'cc', 'g++', 'clang',
    'java', 'javac', 'dotnet', 'mono', 'swift', 'gem', 'rake', 'gradle', 'mvn',
    'docker', 'podman', 'kubectl', 'helm', 'terraform', 'ansible',
    'vim', 'nano', 'emacs', 'code', 'open', 'pbcopy',
  ],
  robashPwshAllow: [
    'Get-Content', 'Get-ChildItem', 'Get-Item', 'Get-Location', 'Get-Date', 'Get-Process',
    'Test-Path', 'Select-String', 'Select-Object', 'Sort-Object', 'Where-Object', 'Measure-Object',
    'Group-Object', 'Compare-Object', 'Format-Table', 'Format-List', 'Format-Wide', 'Out-String',
    'Write-Output', 'ConvertTo-Json', 'git', 'Start-Sleep',
  ],
  robashPwshDeny: [
    'iex', 'Invoke-Expression', 'Invoke-Command', 'Start-Process', 'powershell', 'pwsh',
    'cmd', 'cscript', 'wscript', 'reg', 'icacls', 'Get-Credential',
    'Invoke-WebRequest', 'Invoke-RestMethod',
    'Set-Content', 'Out-File', 'Add-Content', 'Clear-Content',
    'New-Item', 'Remove-Item', 'Move-Item', 'Copy-Item', 'Rename-Item', 'Set-Item',
    'Set-ExecutionPolicy',
  ],
}

/** Verdict reason templates for the policies both shells share — one
 * production point, so the two adapters emit byte-identical strings. */
export const reasons = {
  gitConfigEnv: () => 'read-only agent: GIT_CONFIG_* environment assignments are not allowed',
  nestedTooDeeply: () => 'read-only agent: command substitution is nested too deeply',
  explicitlyDenied: (name) => `read-only agent: '${name}' is explicitly denied`,
  notOnAllowList: (name) => `read-only agent: '${name}' is not on the read-only allow list`,
  writeRedirect: (target) => `read-only agent: write redirection to '${target}' is not allowed`,
}

/** git global flags accepted before the subcommand. */
export const GIT_GLOBAL_FLAGS = new Set([
  '-p', '-P', '--paginate', '--no-pager', '--no-optional-locks', '--bare',
  '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-replace-objects',
  '--html-path', '--man-path', '--info-path', '--version', '--help',
])
/** Value-taking git global flags (consume the next arg, or use =). */
export const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])

/** git: skip known global flags, then gate the subcommand. Shared by both
 * shell adapters (the gitAllow list is merged once, on the bash side). */
export function checkGitArgs(args, gitAllow) {
  // `git --version` / `git --help` are complete read-only invocations.
  if (args.length > 0 && args.every((arg) => arg === '--version' || arg === '--help')) return undefined
  let i = 0
  while (i < args.length) {
    const arg = args[i]
    if (!arg.startsWith('-')) break
    const flagName = arg.split('=', 1)[0]
    if (GIT_GLOBAL_FLAGS.has(flagName)) {
      i++
      continue
    }
    if (GIT_GLOBAL_VALUE_FLAGS.has(flagName)) {
      // -c <name>=<value>: alias.* keys redefine subcommands, and core.pager
      // /pager.* keys run an arbitrary pager executable — all smuggle
      // executables (git -c alias.log=!rm log, git -p -c core.pager=cat log)
      // — always denied (case-insensitive).
      const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[i + 1]
      if (flagName === '-c' && typeof value === 'string' && /^(alias\.|core\.pager($|=)|pager\.)/i.test(value)) {
        return `read-only agent: git config key '${value.split('=', 1)[0]}' is not allowed`
      }
      i += arg.includes('=') ? 1 : 2
      continue
    }
    return `read-only agent: git flag '${arg}' is not recognized`
  }
  const subcommand = args[i]
  if (subcommand === undefined) return 'read-only agent: git without a subcommand is not allowed'
  if (!gitAllow.has(subcommand)) {
    return `read-only agent: git subcommand '${subcommand}' is not on the read-only allow list`
  }
  return undefined
}

/** GIT_CONFIG_* environment names smuggle `-c`-equivalent git config (pager
 * included) through the environment, so both shells refuse the assignment
 * outright. The case difference between the shells is explicit: the bash side
 * matched case-sensitively (formerly robash-guard.js:394), the pwsh side
 * case-insensitively (formerly robash-guard-pwsh.js:505). */
export function isGitConfigEnvName(name, { caseInsensitive = false } = {}) {
  return caseInsensitive ? /^GIT_CONFIG_/i.test(name) : /^GIT_CONFIG_/.test(name)
}

/** Recursion budget for nested command substitutions, shared by both
 * scanners (replaces the former `depth > 8` literals: robash-guard.js:128,265
 * and robash-guard-pwsh.js:93,107,311). */
export const MAX_SUBSTITUTION_DEPTH = 8

/** Deny when the recursion budget is exceeded; undefined otherwise. */
export function checkDepth(depth) {
  if (depth > MAX_SUBSTITUTION_DEPTH) return reasons.nestedTooDeeply()
  return undefined
}

/** Write-redirection targets that are sinks, not files, per shell. bash:
 * `/dev/null`, an fd number (>&1), or `-` (fd close >&-); pwsh: `$null`
 * (matched case-insensitively, formerly pwsh:479). pwsh fd duplication
 * (2>&1) stays classified by the adapter's tokenizer (kind 'dup') and never
 * reaches this check — see design.md Open Questions. */
export function isRedirectSink(shell, target) {
  if (shell === 'pwsh') return target.toLowerCase() === '$null'
  return target === '/dev/null' || /^\d+$/.test(target) || target === '-'
}

/** Per-command dangerous ARGUMENTS, keyed by shell: flags (exact or prefix
 * form) that turn an allow-listed read-only binary into a write or an
 * arbitrary-execution primitive, and commands whose second positional
 * argument names an output file. The bash rows moved verbatim from
 * robash-guard.js. The pwsh table is explicitly EMPTY: the pwsh argument
 * surface is not enumerated — that side relies on the deny list plus
 * fail-closed parsing (declared asymmetry, not an omission; design.md D2).
 * The corresponding verdicts are pinned in the guard tests. */
export const DANGEROUS_FLAGS = {
  bash: {
    find: {
      flags: ['-delete', '-exec', '-execdir', '-ok', '-okdir', '-fprintf', '-fprint', '-fprint0', '-fls'],
    },
    sort: {
      flags: ['-o', '--output'],
      flagPrefixes: ['--output'],
      shortAttached: ['-o'],
    },
    rg: {
      // --pre/--pre-glob/--hostname-bin run an arbitrary command or an arbitrary
      // ripgrep build per file; --sort-files/--sort materialize a temp index.
      flags: ['--sort-files', '--sort'],
      flagPrefixes: ['--pre', '--hostname-bin', '--sort'],
    },
    // uniq FILE1 FILE2 writes its output to FILE2 (a guarded child gets no usable
    // stdin, so a lone argument is a read and a second argument is a write).
    uniq: {
      positionalWrite: true,
    },
    date: {
      flags: ['-s', '--set', '-f', '--file'],
      flagPrefixes: ['--set', '--file'],
    },
  },
  // Not enumerated for pwsh: the deny list and the fail-closed scanner carry
  // that side (see the table docstring above).
  pwsh: {},
}

/**
 * The shared per-executable verdict tail: deny takes precedence over allow,
 * the allow list decides WHICH binary runs, git dispatches to the git gate,
 * and DANGEROUS_FLAGS decides which ARGUMENTS turn a read-only command into
 * a write or an arbitrary-execution primitive (unifies robash-guard.js:405-434
 * with robash-guard-pwsh.js:549-554).
 * @param {object} input
 * @param {string} input.name the lookup name (pwsh: alias-expanded basename,
 *   lowercased; bash: the unquoted basename)
 * @param {string} input.rawName the pre-expansion name (the pwsh deny list
 *   matches it too; bash passes rawName === name)
 * @param {string[]} input.args resolved argument words
 * @param {{ allow: Set<string>, gitAllow: Set<string>, deny: Set<string> }} input.sets
 * @param {'bash' | 'pwsh'} input.shell
 * @returns {string | undefined} denial reason, or undefined when allowed
 */
export function gateExecutable({ name, rawName, args, sets, shell }) {
  if (sets.deny.has(rawName)) return reasons.explicitlyDenied(rawName)
  if (sets.deny.has(name)) return reasons.explicitlyDenied(name)
  if (!sets.allow.has(name)) return reasons.notOnAllowList(name)

  if (name === 'git') return checkGitArgs(args, sets.gitAllow)

  // Positional arguments are the non-flag words; only the FIRST is ever an
  // input for the commands below (a guarded child gets no usable stdin).
  const positionalArgs = args.filter((arg) => !arg.startsWith('-'))

  // Per-command dangerous flags. The allow list gate decided WHICH binary
  // runs; this table decides which of its ARGUMENTS turn a read-only command
  // into a write or an arbitrary-execution primitive. Keep it declarative: a
  // new binary joins by adding one row, not one more `if`.
  const spec = DANGEROUS_FLAGS[shell]?.[name]
  if (spec !== undefined) {
    for (const flag of args) {
      const hit =
        spec.flags?.find((entry) => entry === flag) ??
        spec.flagPrefixes?.find((prefix) => flag.startsWith(prefix)) ??
        spec.shortAttached?.find((prefix) => flag.startsWith(prefix) && flag.length > prefix.length)
      if (hit !== undefined) {
        return `read-only agent: ${name} flag '${hit}' writes a file or executes a command and is not allowed`
      }
    }
    // Commands whose trailing positional arguments name output files rather
    // than inputs: one is a read, two or more means the last one is written.
    if (spec.positionalWrite === true && positionalArgs.length > 1) {
      return `read-only agent: ${name} with more than one file argument writes a file and is not allowed`
    }
  }

  return undefined
}
