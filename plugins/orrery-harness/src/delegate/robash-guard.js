// Read-only bash guard: fail-closed validation of bash commands for curated
// read-only children and readOnly categories. Pure functions, no ctx access —
// the mount layer (index.js) reads config and attaches the guard to the
// child's scope. pwsh executions dispatch to the independent PowerShell
// parsing path in robash-guard-pwsh.js.

import { checkPwshCommand } from './robash-guard-pwsh.js'

/** Tool names the guard inspects: bash and pwsh are each validated through
 * their own parser (dispatched by execution name). */
export const BASH_TOOL_NAMES = ['bash', 'pwsh']

/** Initial whitelist (conservative; iterate via readOnlyBash config). */
export const DEFAULT_ROBASH = {
  enabled: true,
  allow: [
    'ls', 'cat', 'head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'wc', 'sort', 'uniq', 'tr', 'cut',
    'fold', 'fmt', 'nl', 'rev', 'tac', 'comm', 'join', 'paste', 'diff', 'cmp', 'jq',
    'pwd', 'echo', 'printf', 'date', 'uname', 'whoami', 'id', 'printenv', 'which', 'type',
    'basename', 'dirname', 'readlink', 'realpath', 'stat', 'file', 'du', 'df',
    'md5', 'md5sum', 'shasum', 'cksum', 'sleep',
    'cd', 'pushd', 'popd', 'true', 'false', ':', 'test', '[',
    'find', 'git',
  ],
  gitAllow: [
    'status', 'log', 'show', 'diff', 'blame', 'grep', 'ls-files', 'ls-tree',
    'rev-parse', 'describe', 'shortlog',
  ],
  deny: [
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
}

/** Per-command dangerous ARGUMENTS: flags (exact or prefix form) that turn an
 * allow-listed read-only binary into a write or an arbitrary-execution
 * primitive, and commands whose second positional argument names an output
 * file. The corresponding verdicts are pinned in the guard tests. */
const DANGEROUS_FLAGS = {
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
}

/** git global flags accepted before the subcommand. */
const GIT_GLOBAL_FLAGS = new Set([
  '-p', '-P', '--paginate', '--no-pager', '--no-optional-locks', '--bare',
  '--literal-pathspecs', '--glob-pathspecs', '--noglob-pathspecs', '--icase-pathspecs', '--no-replace-objects',
  '--html-path', '--man-path', '--info-path', '--version', '--help',
])
/** Value-taking git global flags (consume the next arg, or use =). */
const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])

/**
 * Validate one bash command line against the read-only lists.
 * @param {string} command
 * @param {{ allow: Iterable<string>, gitAllow: Iterable<string>, deny: Iterable<string> }} lists
 * @returns {string | undefined} denial reason (English template), or undefined when allowed
 */
export function checkBashCommand(command, lists) {
  const sets = {
    allow: new Set(lists.allow),
    gitAllow: new Set(lists.gitAllow),
    deny: new Set(lists.deny),
  }
  return analyze(command, sets, 0)
}

/** Attach the guard to one read-only child's scope. Dispatches on the tool
 * name: bash commands validate against the bash lists, pwsh commands against
 * the pwsh lists (gitAllow is shared). */
export function attachReadOnlyBashGuard(agent, lists) {
  return agent.ctx.tools.guard((execution) => {
    if (execution.name === 'pwsh') {
      const command = execution.arguments?.command
      if (typeof command !== 'string') {
        return 'read-only agent: pwsh call without a command string is not allowed'
      }
      return checkPwshCommand(command, lists.pwsh)
    }
    if (execution.name !== 'bash') return undefined
    const command = execution.arguments?.command
    if (typeof command !== 'string') {
      return 'read-only agent: bash call without a command string is not allowed'
    }
    return checkBashCommand(command, lists.bash)
  })
}

// ---------------------------------------------------------------------------
// Layer 1: scan the command line — validate command substitutions recursively,
// split top-level segments (pipes/sequences/newlines), then check each segment.
// ---------------------------------------------------------------------------

function analyze(command, sets, depth) {
  if (depth > 8) return 'read-only agent: command substitution is nested too deeply'
  if (typeof command !== 'string' || command.trim().length === 0) return undefined
  const text = command.replace(/\r\n/g, '\n').replace(/\\\n/g, '')

  const segments = []
  let current = ''
  let quote = null // null | "'" | '"'
  let i = 0

  const flushSegment = () => {
    segments.push(current)
    current = ''
  }

  while (i < text.length) {
    const ch = text[i]

    if (quote === "'") {
      if (ch === "'") quote = null
      current += ch
      i++
      continue
    }
    if (ch === '\\') {
      if (i + 1 >= text.length) return 'read-only agent: command could not be proven read-only (trailing backslash)'
      current += ch + text[i + 1]
      i += 2
      continue
    }
    if (quote === '"') {
      if (ch === '"') {
        quote = null
        current += ch
        i++
        continue
      }
      // inside double quotes: no structural separators; substitutions still live
    } else {
      if (ch === "'") {
        quote = "'"
        current += ch
        i++
        continue
      }
      if (ch === '"') {
        quote = '"'
        current += ch
        i++
        continue
      }
      // structural separators, top level only
      if (ch === ';' || ch === '\n') {
        flushSegment()
        i++
        continue
      }
      if (ch === '|') {
        if (current.endsWith('>')) {
          // `>|` (noclobber override) is one redirection operator
          current += ch
          i++
          continue
        }
        if (text[i + 1] === '|') i++
        flushSegment()
        i++
        continue
      }
      if (ch === '&') {
        const prev = current[current.length - 1]
        const next = text[i + 1]
        if (prev === '>' || next === '>') {
          // &> / >& / &>> redirection operators: keep verbatim
          current += ch
          i++
          continue
        }
        if (next === '&') i++
        flushSegment()
        i++
        continue
      }
      if (ch === '(' || ch === ')') {
        return 'read-only agent: command could not be proven read-only (subshell grouping)'
      }
      if ((ch === '<' || ch === '>') && text[i + 1] === '(') {
        return 'read-only agent: process substitution is not allowed'
      }
    }

    // command substitutions $( ... ) — live in normal and double-quoted mode
    if (ch === '$' && text[i + 1] === '(') {
      const arithmetic = text[i + 2] === '('
      const inner = readParen(text, arithmetic ? i + 2 : i + 1)
      if (inner === null) return 'read-only agent: command could not be proven read-only (unbalanced command substitution)'
      // arithmetic content is expressions, not commands — scan it only for
      // nested substitutions (array subscripts etc.); command substitutions
      // get the full per-segment validation.
      const nested = arithmetic ? scanExpansions(inner.body, sets, depth + 1) : analyze(inner.body, sets, depth + 1)
      if (nested) return nested
      if (arithmetic) {
        // consume the second closing paren of $(( ... ))
        if (text[inner.end] !== ')') return 'read-only agent: command could not be proven read-only (unbalanced arithmetic expansion)'
        current += '\x00'
        i = inner.end + 1
      } else {
        current += '\x00'
        i = inner.end
      }
      continue
    }
    // backtick substitution — live in normal and double-quoted mode
    if (ch === '`') {
      const close = text.indexOf('`', i + 1)
      if (close === -1) return 'read-only agent: command could not be proven read-only (unbalanced backtick substitution)'
      const nested = analyze(text.slice(i + 1, close), sets, depth + 1)
      if (nested) return nested
      current += '\x00'
      i = close + 1
      continue
    }

    current += ch
    i++
  }
  if (quote !== null) return 'read-only agent: command could not be proven read-only (unbalanced quotes)'
  flushSegment()

  for (const segment of segments) {
    const reason = checkSegment(segment, sets)
    if (reason) return reason
  }
  return undefined
}

/** Scan expansions (arithmetic bodies etc.): validate only nested substitutions. */
function scanExpansions(text, sets, depth) {
  if (depth > 8) return 'read-only agent: command substitution is nested too deeply'
  let quote = null
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      i++
      continue
    }
    if (ch === '\\') {
      i += 2
      continue
    }
    if (ch === "'" && quote === null) {
      quote = "'"
      i++
      continue
    }
    if (ch === '"') {
      quote = quote === '"' ? null : '"'
      i++
      continue
    }
    if (ch === '$' && text[i + 1] === '(') {
      const arithmetic = text[i + 2] === '('
      const inner = readParen(text, arithmetic ? i + 2 : i + 1)
      if (inner === null) return 'read-only agent: command could not be proven read-only (unbalanced command substitution)'
      const nested = arithmetic ? scanExpansions(inner.body, sets, depth + 1) : analyze(inner.body, sets, depth + 1)
      if (nested) return nested
      if (arithmetic) {
        if (text[inner.end] !== ')') return 'read-only agent: command could not be proven read-only (unbalanced arithmetic expansion)'
        i = inner.end + 1
      } else {
        i = inner.end
      }
      continue
    }
    if (ch === '`') {
      const close = text.indexOf('`', i + 1)
      if (close === -1) return 'read-only agent: command could not be proven read-only (unbalanced backtick substitution)'
      const nested = analyze(text.slice(i + 1, close), sets, depth + 1)
      if (nested) return nested
      i = close + 1
      continue
    }
    i++
  }
  if (quote !== null) return 'read-only agent: command could not be proven read-only (unbalanced quotes)'
  return undefined
}

/** Read a balanced (...) group starting at the opening paren index. */function readParen(text, openIndex) {
  let depth = 0
  let quote = null
  let i = openIndex
  while (i < text.length) {
    const ch = text[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      i++
      continue
    }
    if (ch === '\\') {
      i += 2
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      i++
      continue
    }
    if (ch === "'") {
      quote = "'"
      i++
      continue
    }
    if (ch === '"') {
      quote = '"'
      i++
      continue
    }
    if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) {
        return { body: text.slice(openIndex + 1, i), end: i + 1 }
      }
    }
    i++
  }
  return null
}

// ---------------------------------------------------------------------------
// Layer 2: per-segment checks — words, redirections, the command itself.
// ---------------------------------------------------------------------------

function checkSegment(segment, sets) {
  const tokens = tokenizeSegment(segment)
  if (tokens === null) return 'read-only agent: command could not be proven read-only (unparseable segment)'

  const words = []
  for (let t = 0; t < tokens.length; t++) {
    const redirect = parseRedirect(tokens[t])
    if (redirect) {
      if (redirect.kind === 'heredoc') return 'read-only agent: here-documents are not allowed'
      if (redirect.kind === 'write') {
        const target = unquote(tokens[t + 1] ?? '')
        if (target === '/dev/null' || /^\d+$/.test(target) || target === '-') {
          t++ // /dev/null sink, fd duplication (>&1), fd close (>&-): no writes
          continue
        }
        return `read-only agent: write redirection to '${target}' is not allowed`
      }
      // read redirection: consume its target word
      t++
      continue
    }
    words.push(tokens[t])
  }

  // Strip leading environment assignments (FOO=bar, quoted or substituted values).
  // GIT_CONFIG_* names smuggle `-c`-equivalent git config (pager included)
  // through the environment — refuse them outright.
  let cursor = 0
  while (cursor < words.length) {
    const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=/.exec(words[cursor])
    if (assignment === null) break
    if (/^GIT_CONFIG_/.test(assignment[1])) {
      return 'read-only agent: GIT_CONFIG_* environment assignments are not allowed'
    }
    cursor++
  }
  if (cursor >= words.length) return undefined // assignments only: no command runs

  const commandWord = unquote(words[cursor]).replace(/^\\+/, '')
  const command = basenameOf(commandWord)
  const args = words.slice(cursor + 1).map(unquote)

  if (sets.deny.has(command)) return `read-only agent: '${command}' is explicitly denied`
  if (!sets.allow.has(command)) return `read-only agent: '${command}' is not on the read-only allow list`

  if (command === 'git') return checkGitArgs(args, sets.gitAllow)

  // Positional arguments are the non-flag words; only the FIRST is ever an
  // input for the commands below (a guarded child gets no usable stdin).
  const positionalArgs = args.filter((arg) => !arg.startsWith('-'))

  // Per-command dangerous flags. The allow list gate decides WHICH binary runs;
  // this table decides which of its ARGUMENTS turn a read-only command into a
  // write or an arbitrary-execution primitive. Keep it declarative: a new
  // binary joins by adding one row, not one more `if`.
  const spec = DANGEROUS_FLAGS[command]
  if (spec !== undefined) {
    for (const flag of args) {
      const hit =
        spec.flags?.find((name) => name === flag) ??
        spec.flagPrefixes?.find((prefix) => flag.startsWith(prefix)) ??
        spec.shortAttached?.find((prefix) => flag.startsWith(prefix) && flag.length > prefix.length)
      if (hit !== undefined) {
        return `read-only agent: ${command} flag '${hit}' writes a file or executes a command and is not allowed`
      }
    }
    // Commands whose trailing positional arguments name output files rather
    // than inputs: one is a read, two or more means the last one is written.
    if (spec.positionalWrite === true && positionalArgs.length > 1) {
      return `read-only agent: ${command} with more than one file argument writes a file and is not allowed`
    }
  }

  return undefined
}

/** Split a segment into shell words; substitution spans are \x00 placeholders. */
function tokenizeSegment(segment) {
  const tokens = []
  let current = ''
  let quote = null
  let i = 0
  const flush = () => {
    if (current.length > 0) {
      tokens.push(current)
      current = ''
    }
  }
  while (i < segment.length) {
    const ch = segment[i]
    if (quote === "'") {
      if (ch === "'") quote = null
      else current += ch
      i++
      continue
    }
    if (ch === '\\') {
      if (i + 1 >= segment.length) return null
      current += ch + segment[i + 1]
      i += 2
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      else current += ch
      i++
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      i++
      continue
    }
    if (/\s/.test(ch)) {
      flush()
      i++
      continue
    }
    if (ch === '<' || ch === '>' || (ch === '&' && (segment[i + 1] === '>' || segment[i + 1] === '<'))) {
      // fold a pending fd number ('2' in '2>') into the operator token
      let op = ''
      if (/^\d+$/.test(current)) {
        op = current
        current = ''
      } else {
        flush()
      }
      // greedy operator read: < << <<< <<- <> <& > >> >| >& &> &>> <>
      while (i < segment.length && /[<>&|-]/.test(segment[i]) && op.replace(/^\d+/, '').length < 3) {
        op += segment[i]
        i++
      }
      tokens.push(op)
      continue
    }
    current += ch
    i++
  }
  if (quote !== null) return null
  flush()
  return tokens
}

/** Classify one operator token; returns null when it is not a redirection. */
function parseRedirect(token) {
  if (!/^(\d*)(<<<|<<-?|<>|<&|<|&>>?|&<|>>?|>\||>&)/.test(token ?? '')) return null
  const op = token.replace(/^\d+/, '')
  if (op === '<<' || op === '<<-') return { kind: 'heredoc' }
  if (op === '<<<' || op === '<' || op === '<&' || op === '&<') return { kind: 'read' }
  return { kind: 'write' } // > >> >| >& <> &> &>>
}

/** git: skip known global flags, then gate the subcommand. Shared with the
 * pwsh guard (the gitAllow list is merged once, on the bash side). */
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

function basenameOf(word) {
  const normalized = word.replace(/\\(.)/g, '$1')
  const parts = normalized.split('/')
  return parts[parts.length - 1]
}

/** Remove backslash escapes and substitution placeholders from one word. */
function unquote(word) {
  return word.replace(/\x00/g, '').replace(/\\(.)/g, '$1')
}
