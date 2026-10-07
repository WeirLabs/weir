// Read-only bash guard: fail-closed validation of bash commands for curated
// read-only children and readOnly categories. Pure functions, no ctx access —
// the mount layer (index.js) reads config and attaches the guard to the
// child's scope. pwsh executions dispatch to the independent PowerShell
// parsing path in robash-guard-pwsh.js.

import { checkPwshCommand } from './robash-guard-pwsh.js'
import { checkDepth, DEFAULT_TABLES, gateExecutable, isGitConfigEnvName, isRedirectSink, reasons } from './robash-guard-core.js'

/** Tool names the guard inspects: bash and pwsh are each validated through
 * their own parser (dispatched by execution name). */
export const BASH_TOOL_NAMES = ['bash', 'pwsh']

/** Initial whitelist (conservative; iterate via readOnlyBash config). The
 * canonical entries live once in robash-guard-core.js (DEFAULT_TABLES); this
 * re-export keeps the pre-refactor shape for existing consumers. */
export const DEFAULT_ROBASH = {
  enabled: true,
  allow: DEFAULT_TABLES.robashAllow,
  gitAllow: DEFAULT_TABLES.robashGitAllow,
  deny: DEFAULT_TABLES.robashDeny,
}


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
  const depthExceeded = checkDepth(depth)
  if (depthExceeded) return depthExceeded
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
  const depthExceeded = checkDepth(depth)
  if (depthExceeded) return depthExceeded
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
        if (isRedirectSink('bash', target)) {
          t++ // /dev/null sink, fd duplication (>&1), fd close (>&-): no writes
          continue
        }
        return reasons.writeRedirect(target)
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
    // bash matched case-sensitively here before the core extraction (:394)
    if (isGitConfigEnvName(assignment[1])) {
      return reasons.gitConfigEnv()
    }
    cursor++
  }
  if (cursor >= words.length) return undefined // assignments only: no command runs

  const commandWord = unquote(words[cursor]).replace(/^\\+/, '')
  const command = basenameOf(commandWord)
  const args = words.slice(cursor + 1).map(unquote)

  return gateExecutable({ name: command, rawName: command, args, sets, shell: 'bash' })
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

function basenameOf(word) {
  const normalized = word.replace(/\\(.)/g, '$1')
  const parts = normalized.split('/')
  return parts[parts.length - 1]
}

/** Remove backslash escapes and substitution placeholders from one word. */
function unquote(word) {
  return word.replace(/\x00/g, '').replace(/\\(.)/g, '$1')
}
