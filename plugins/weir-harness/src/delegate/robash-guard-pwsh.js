// Read-only pwsh guard: independent PowerShell parsing path for curated
// read-only children on Windows (where the preset disables bash and mounts
// pwsh instead). Mirrors the bash guard's three-layer shape (scan →
// tokenizeSegment → checkSegment) but with pwsh-native lexing: backtick is
// the escape char, `&` is the call operator, here-strings instead of
// here-docs, and all name lookups are case-insensitive. Scriptblock and
// hashtable literals ({ ... } / @{ ... }) are refused outright: PowerShell
// EXECUTES scriptblock bodies (Where-Object/Sort-Object/Format-* parameters),
// and the executable surface of expression syntax proved unenumerable, so a
// bare { or } outside quotes denies the whole call. Static member access (::)
// and method invocation (any spelling) are denied in the two remaining
// expression lanes: assignment right-hand sides and (...) expression groups.
// Fail-closed like the bash side: anything the parser cannot statically
// prove read-only is denied.

import { checkDepth, DEFAULT_TABLES, gateExecutable, isGitConfigEnvName, isRedirectSink, reasons } from './robash-guard-core.js'

/** Read-only built-in aliases, expanded before the table lookup (lowercase). */
const PWSH_ALIASES = {
  ls: 'get-childitem', dir: 'get-childitem', gci: 'get-childitem',
  gc: 'get-content', cat: 'get-content', type: 'get-content',
  pwd: 'get-location',
  ps: 'get-process', gps: 'get-process',
  sls: 'select-string',
  sort: 'sort-object', where: 'where-object', measure: 'measure-object',
  select: 'select-object', echo: 'write-output',
  // `sleep` is a built-in ReadOnly alias for Start-Sleep (verified against real
  // pwsh 7.6). Without this row, `sleep` hits the allow list under its own name
  // and is refused with "'sleep' is not on the read-only allow list" — while the
  // POSIX side allow-lists `sleep`, so the same wait was portable on macOS and
  // refused on Windows.
  sleep: 'start-sleep',
}

/** Initial pwsh whitelist (conservative; iterate via readOnlyPwsh config and
 * the robashPwshAllow/robashPwshDeny settings keys). Matching is
 * case-insensitive; the git subcommand gate is shared with the bash side.
 * The canonical entries live once in robash-guard-core.js (DEFAULT_TABLES);
 * this re-export keeps the pre-refactor shape for existing consumers. */
export const DEFAULT_ROBASH_PWSH = {
  allow: DEFAULT_TABLES.robashPwshAllow,
  deny: DEFAULT_TABLES.robashPwshDeny,
}

/**
 * Validate one pwsh command line against the read-only lists.
 * @param {string} command
 * @param {{ allow: Iterable<string>, gitAllow: Iterable<string>, deny: Iterable<string> }} lists
 * @returns {string | undefined} denial reason (English template), or undefined when allowed
 */
export function checkPwshCommand(command, lists) {
  const sets = {
    allow: new Set([...lists.allow].map((entry) => entry.toLowerCase())),
    gitAllow: new Set(lists.gitAllow),
    deny: new Set([...lists.deny].map((entry) => entry.toLowerCase())),
  }
  return analyze(command, sets, 0)
}

// ---------------------------------------------------------------------------
// Layer 1: scan the command line — recurse into $(...)/(...) groups and
// here-strings, refuse bare { } braces outright, split top-level segments
// (pipes/sequences/newlines), then check each segment with the mode's
// statement checker.
// ---------------------------------------------------------------------------

/**
 * Normalize scanner input. Two PowerShell lexical facts the scanner must see
 * through:
 * - backtick + newline is the documented line continuation — pwsh removes the
 *   pair BEFORE tokenization (inside double-quoted/interpolating strings it
 *   is an escaped newline; inside single quotes it is literal — in both
 *   string cases the join only alters inert content, never the verdict), so
 *   `$_.Kill`<backtick><LF>`()` tokenizes exactly like `$_.Kill()`;
 * - CR, LF, and CRLF are ALL statement terminators (about_Parsing new-line
 *   production), so lone CR must not merge two statements into one segment.
 */
function normalizeInput(text) {
  return text.replace(/`(\r\n|\r|\n)/g, '').replace(/\r\n?/g, '\n')
}

function analyze(command, sets, depth) {
  const depthExceeded = checkDepth(depth)
  if (depthExceeded) return depthExceeded
  if (typeof command !== 'string' || command.trim().length === 0) return undefined
  return scanStatements(normalizeInput(command), sets, depth, checkSegment)
}



/**
 * Validate the body of an expression-shaped (...) group statement-by-statement
 * (same separators, quoting, and substitution recursion as the top level; only
 * the statement dispatch differs — see checkGroupStatement). An empty or
 * whitespace-only body runs nothing and is allowed.
 */
function analyzeExpressionGroup(body, sets, depth) {
  const depthExceeded = checkDepth(depth)
  if (depthExceeded) return depthExceeded
  if (typeof body !== 'string' || body.trim().length === 0) return undefined
  return scanStatements(normalizeInput(body), sets, depth, checkGroupStatement)
}

/**
 * Shared char-level scanner: resolves quotes/backticks/comments, recurses
 * into substitutions and literals (replaced with \x00 placeholders once
 * validated), splits top-level statements, and checks each with
 * checkStatement(segment, sets).
 */
function scanStatements(text, sets, depth, checkStatement) {
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
      // '' is an escaped quote inside a single-quoted string
      if (ch === "'" && text[i + 1] === "'") {
        current += ch + text[i + 1]
        i += 2
        continue
      }
      if (ch === "'") quote = null
      current += ch
      i++
      continue
    }
    // backtick is the escape char — live outside quotes and inside double
    // quotes; the escaped char is kept verbatim for word-level resolution
    // (i`ex resolves to iex before the name lookup).
    if (ch === '`') {
      if (i + 1 >= text.length) return 'read-only agent: command could not be proven read-only (trailing backtick)'
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
      // inside double quotes only $( ) subexpressions stay live — handled by
      // the shared substitution check below; nothing else is structural.
      if (!(ch === '$' && text[i + 1] === '(')) {
        current += ch
        i++
        continue
      }
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
      // # comment: truncate to end of line
      if (ch === '#') {
        while (i < text.length && text[i] !== '\n') i++
        continue
      }
      // structural separators, top level only
      if (ch === ';' || ch === '\n') {
        flushSegment()
        i++
        continue
      }
      if (ch === '|') {
        if (text[i + 1] === '|') i++
        flushSegment()
        i++
        continue
      }
      // A lone `&` is a pipeline-chain operator in pwsh, exactly like `&&`
      // (verified on real pwsh 7.6: zero parse errors, a standalone Ampersand
      // token, and the tail statement really executes). Splitting only on `&&`
      // let any allow-listed command launder an arbitrary tail: `Get-Date &
      // Remove-Item x` was read as ONE segment whose first command decided the
      // verdict, so the denied cmdlet never reached the allow list.
      //
      // The `&` token has three roles, so three guards are needed:
      //   1. `>&` is an fd-duplication redirection (`2>&1`) — pass it through so
      //      the segment tokenizer can recognize it (it permits the form; it does
      //      not range-check the fd number, which is pre-existing behaviour).
      //   2. `&&` is a separator regardless of position (corpus-pinned).
      //   3. a LONE `&` at segment start is the `& <word>` call operator — left
      //      in place for the segment checker to unwrap, which is where dynamic
      //      invocation (`& $(Get-Date)`) is refused.
      // Anywhere else, a lone `&` backgrounds a tail we cannot prove read-only,
      // so it fails closed — including an allow-listed tail, because the
      // construct itself is what is unprovable.
      if (ch === '&' && text[i - 1] !== '>') {
        if (text[i + 1] === '&') {
          flushSegment()
          i += 2
          continue
        }
        if (current.trim().length === 0) {
          current += ch
          i++
          continue
        }
        return 'read-only agent: & background operator is not allowed (unprovable as read-only)'
      }
      // stop-parsing symbol: everything after it is unparseable by design
      if (ch === '-' && text[i + 1] === '-' && text[i + 2] === '%') {
        return 'read-only agent: --% stop-parsing is not allowed'
      }
      // here-strings: @'...'@ literal, @"..."@ interpolating (scan its $())
      if (ch === '@' && (text[i + 1] === "'" || text[i + 1] === '"')) {
        const delimiter = text[i + 1]
        const close = text.indexOf(delimiter + '@', i + 2)
        if (close === -1) return 'read-only agent: command could not be proven read-only (unterminated here-string)'
        if (delimiter === '"') {
          const nested = scanHereString(text.slice(i + 2, close), sets, depth + 1)
          if (nested) return nested
        }
        current += '\x00'
        i = close + 2
        continue
      }
      // Bare braces outside quotes: scriptblock and hashtable literals are
      // refused outright — PowerShell EXECUTES scriptblock bodies
      // (Where-Object/Select-Object/Sort-Object/Format-* parameters), and the
      // executable surface of expression syntax proved unenumerable. Applies at
      // every nesting level (this scanner is shared by $( ) recursion); braces
      // inside single/double quotes are literal content and never reach here.
      // ${var} braced-variable reads are refused along with them (declared
      // fail-closed over-denial).
      if (ch === '{' || ch === '}') {
        return 'read-only agent: scriptblock and hashtable literals ({ ... }) are not allowed'
      }
    }

    // $( ) subexpressions — live in normal and double-quoted mode; they run
    // real statements, so the body always validates in command mode.
    if (ch === '$' && text[i + 1] === '(') {
      const inner = readParen(text, i + 1)
      if (inner === null) return 'read-only agent: command could not be proven read-only (unbalanced subexpression)'
      const nested = analyze(inner.body, sets, depth + 1)
      if (nested) return nested
      current += '\x00'
      i = inner.end
      continue
    }
    // ( ) groupings — top level only. A group whose inner first statement is
    // expression-shaped (leading $, [, quote, or digit) is an expression, not a
    // command: it validates statement-by-statement with the two-rule
    // expression validator (see checkGroupStatement) so property reads like
    // ($_.Name) don't hit the command allow list while method invocations like
    // ($y.Kill()) are still refused. All other groups stay command-mode
    // recursion (a leading & or . keeps the dynamic-invocation/dot-source
    // denials).
    if (ch === '(' && quote === null) {
      const inner = readParen(text, i)
      if (inner === null) return 'read-only agent: command could not be proven read-only (unbalanced grouping)'
      const nested = isExpressionGroupBody(inner.body)
        ? analyzeExpressionGroup(inner.body, sets, depth + 1)
        : analyze(inner.body, sets, depth + 1)
      if (nested) return nested
      current += '\x00'
      i = inner.end
      continue
    }

    current += ch
    i++
  }
  if (quote !== null) return 'read-only agent: command could not be proven read-only (unbalanced quotes)'
  flushSegment()

  for (const segment of segments) {
    const reason = checkStatement(segment, sets)
    if (reason) return reason
  }
  return undefined
}

/** A (...) group's body reads as an expression when its first statement
 * starts with $, [, a quote, or a digit (e.g. ($_.Name), (1 + 2)). */
function isExpressionGroupBody(body) {
  const match = /\S/.exec(body)
  return match !== null && /[$\['"\d]/.test(match[0])
}

/** Scan an interpolating here-string body: validate only nested $( ). */
function scanHereString(body, sets, depth) {
  const depthExceeded = checkDepth(depth)
  if (depthExceeded) return depthExceeded
  // Backtick continuations and lone-CR lines are normalized here as well:
  // otherwise `$`<backtick><LF>`(...)` would hide a live subexpression from
  // the scan below (and a lone CR could shift its boundaries).
  const text = normalizeInput(body)
  let i = 0
  while (i < text.length) {
    const ch = text[i]
    if (ch === '`') {
      i += 2
      continue
    }
    if (ch === '$' && text[i + 1] === '(') {
      const inner = readParen(text, i + 1)
      if (inner === null) return 'read-only agent: command could not be proven read-only (unbalanced subexpression in here-string)'
      const nested = analyze(inner.body, sets, depth + 1)
      if (nested) return nested
      i = inner.end
      continue
    }
    i++
  }
  return undefined
}

/** Read a balanced (...) group starting at the opening paren index. */
function readParen(text, openIndex) {
  let depth = 0
  let quote = null
  let i = openIndex
  while (i < text.length) {
    const ch = text[i]
    if (quote === "'") {
      if (ch === "'" && text[i + 1] === "'") {
        i += 2
        continue
      }
      if (ch === "'") quote = null
      i++
      continue
    }
    if (ch === '`') {
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
// Layer 2: per-segment checks — redirections, assignments, the command itself.
// ---------------------------------------------------------------------------

function checkSegment(segment, sets) {
  const tokens = tokenizeSegment(segment)
  if (tokens === null) return 'read-only agent: command could not be proven read-only (unparseable segment)'
  return checkTokens(tokens, sets)
}

/**
 * Validate one statement of an expression-shaped (...) group body.
 * - Assignment and redirection shapes carry the same execution/write surface
 *   as commands ($x = Set-Content ... runs Set-Content; "x" > out.txt
 *   writes), so they take the full command path (which also validates the
 *   assignment right-hand side — see checkTokens).
 * - A leading bareword is a command statement → the normal segment path.
 * - Otherwise (leading $, (, quote, digit, or [) it is an expression
 *   statement → the two-rule expression validator.
 */
function checkGroupStatement(statement, sets) {
  const tokens = tokenizeSegment(statement)
  if (tokens === null) return 'read-only agent: command could not be proven read-only (unparseable segment)'
  if (tokens.length === 0) return undefined
  if (isAssignmentStatement(tokens) || tokens.some((token) => parseRedirect(token) !== null)) {
    return checkTokens(tokens, sets)
  }
  if (/^[$(\[\d'"]/.test(tokens[0])) return checkExpression(tokens)
  return checkTokens(tokens, sets)
}

const ASSIGNMENT_OPERATORS = new Set(['=', '+=', '-=', '*=', '/=', '%=', '??='])

/** An assignment statement's RHS can be a command invocation ($x =
 * Set-Content ... runs Set-Content) — detect every PowerShell assignment
 * shape (fused $x=5, spaced $x = 5, compound +=/??=/…) so it takes the
 * command path instead of the expression validator. Quoted first tokens are
 * string literals, never lvalues. */
function isAssignmentStatement(tokens) {
  const first = tokens[0]
  if (first.startsWith("'") || first.startsWith('"')) return false
  if (/[+\-*\/%]?=/.test(first)) return true
  const op = tokens[1] ?? ''
  return ASSIGNMENT_OPERATORS.has(op) || /^[+\-*\/%]=/.test(op) || /^=./.test(op)
}

/**
 * Expression validator for the two remaining expression lanes (assignment
 * right-hand sides and expression-shaped (...) groups). The complete denial
 * surface is exactly two rules:
 * 1. any `::` in the tokens → deny (static member access:
 *    [IO.File]::WriteAllText(...) is an arbitrary write; the [math]::pi
 *    over-denial is accepted);
 * 2. method invocation in any spelling → deny:
 *    - glued: a token containing `.` + non-space chars up to a validated
 *      group placeholder ($x.Kill\x00, dynamic $_.$m\x00, quoted $x.'Kill'\x00,
 *      chained \x00.Delete\x00);
 *    - spaced: a token ending in a member name whose NEXT token starts with
 *      a group placeholder ($x.Kill \x00, $x.'Kill' \x00, $x.Kill \x00.Bar);
 *    - dot-space: a token ending in a bare `.` whose member name lives in the
 *      next token ($_. Kill\x00, $_. Kill \x00).
 * Everything else (property reads $_.Name, comparisons, arithmetic, literals,
 * variable references) invokes nothing and passes.
 */
function checkExpression(tokens) {
  for (let t = 0; t < tokens.length; t++) {
    const token = tokens[t]
    if (token.includes('::')) {
      return 'read-only agent: static member access (::) is not allowed in expressions'
    }
    // glued call forms: $x.Kill\x00, $_.$m\x00, $x.'Kill'\x00, \x00.Delete\x00
    if (/\.\S*\x00/.test(token)) {
      return 'read-only agent: method invocation is not allowed in expressions'
    }
    const next = tokens[t + 1]
    // spaced call forms: $x.Kill \x00, $x.'Kill' \x00, $x.$m \x00 (chained
    // $x.Kill \x00.Bar is already caught here, at $x.Kill)
    if (next !== undefined && next.startsWith('\x00') && /\.\S+$/.test(token)) {
      return 'read-only agent: method invocation is not allowed in expressions'
    }
    // whitespace after the dot: $_. Kill\x00, $_. $m\x00, $_. Kill \x00
    if (next !== undefined && token.endsWith('.') && (next.includes('\x00') || (tokens[t + 2] ?? '').startsWith('\x00'))) {
      return 'read-only agent: method invocation is not allowed in expressions'
    }
  }
  return undefined
}

function checkTokens(tokens, sets) {
  const words = []
  for (let t = 0; t < tokens.length; t++) {
    const redirect = parseRedirect(tokens[t])
    if (redirect) {
      if (redirect.kind === 'read') return 'read-only agent: redirection is not allowed'
      if (redirect.kind === 'write') {
        const target = resolveWord(tokens[t + 1] ?? '').replace(/\x00/g, '')
        if (isRedirectSink('pwsh', target)) {
          t++ // $null sink: no file write
          continue
        }
        return reasons.writeRedirect(target)
      }
      continue // fd duplication (2>&1): no file write, no target word
    }
    words.push(tokens[t])
  }

  // Strip leading simple assignments ($x = <literal>, $env:X = <literal>).
  // A bare-word RHS is a command invocation in PowerShell ($x = iex ... runs
  // iex), so only quoted/numeric/variable/substituted values are consumed as
  // literals; a bare word is re-checked as the command word below.
  // A literal-shaped RHS is NOT automatically safe: $x = $_.Kill() invokes a
  // method and $x = [IO.File]::WriteAllText(...) a static one, so the RHS
  // (with the rest of the statement as lookahead for spaced call spellings)
  // must pass the two expression rules before being accepted as a literal.
  // GIT_CONFIG_* names smuggle `-c`-equivalent git config (pager included)
  // through the environment — refuse them outright.
  let cursor = 0
  while (cursor < words.length) {
    const assignment = assignmentAt(words, cursor)
    if (!assignment) break
    const nameMatch = /^\$(?:env:)?([A-Za-z_][A-Za-z0-9_]*)/i.exec(words[cursor])
    // pwsh matched case-insensitively here before the core extraction (:505)
    if (nameMatch && isGitConfigEnvName(nameMatch[1], { caseInsensitive: true })) {
      return reasons.gitConfigEnv()
    }
    if (isLiteralValue(assignment.value)) {
      const violation = checkExpression([assignment.value, ...words.slice(cursor + assignment.consumed)])
      if (violation) return violation
      cursor += assignment.consumed
      continue
    }
    words.splice(cursor, assignment.consumed, assignment.value)
    break
  }
  if (cursor >= words.length) return undefined // assignments only: no command runs

  // & call operator: unwrap & <word>; & <dynamic expression> is unprovable.
  let commandIndex = cursor
  if (resolveWord(words[commandIndex]) === '&') {
    commandIndex++
    if (commandIndex >= words.length) return 'read-only agent: command could not be proven read-only (& without a command word)'
    if (words[commandIndex].includes('\x00')) return 'read-only agent: dynamic invocation cannot be proven read-only'
  }
  // . dot-source operator: denied outright
  if (resolveWord(words[commandIndex]) === '.') return 'read-only agent: dot-sourcing is not allowed'

  const substituted = words[commandIndex].includes('\x00')
  const resolved = resolveWord(words[commandIndex]).replace(/\x00/g, '')
  if (resolved === '') {
    // a pure $( )/( ) span in command position: its content was validated
    // recursively during the scan, nothing else runs (braces never reach a
    // placeholder — they are refused outright during the scan)
    return substituted ? undefined : 'read-only agent: command could not be proven read-only (empty command word)'
  }
  if (substituted) return 'read-only agent: dynamic invocation cannot be proven read-only'

  // alias expansion → basename on both \ and / → case-insensitive lookup.
  // The deny list matches BOTH the raw (pre-expansion) and the expanded name
  // (deny precedence unchanged); the allow list checks the expanded name
  // only (the alias table holds read-only aliases exclusively).
  const rawName = resolved.toLowerCase()
  const expanded = PWSH_ALIASES[rawName] ?? resolved
  const parts = expanded.split(/[\\/]/)
  const name = parts[parts.length - 1].toLowerCase()
  const args = words.slice(commandIndex + 1).map((word) => resolveWord(word).replace(/\x00/g, ''))

  return gateExecutable({ name, rawName, args, sets, shell: 'pwsh' })
}

/** Split a segment into shell words; validated substitution spans are \x00
 * placeholders. Quote characters stay in the token (resolveWord strips them)
 * so literal-vs-command detection can tell quoted strings from bare words. */
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
      if (ch === "'" && segment[i + 1] === "'") {
        current += ch + segment[i + 1]
        i += 2
        continue
      }
      if (ch === "'") quote = null
      current += ch
      i++
      continue
    }
    if (ch === '`') {
      if (i + 1 >= segment.length) return null
      current += ch + segment[i + 1]
      i += 2
      continue
    }
    if (quote === '"') {
      if (ch === '"') quote = null
      current += ch
      i++
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      current += ch
      i++
      continue
    }
    if (/\s/.test(ch)) {
      flush()
      i++
      continue
    }
    if (ch === '<' || ch === '>') {
      // fold a pending stream number ('2' in '2>') or '*' into the operator
      let op = ''
      if (/^\d+$/.test(current) || current === '*') {
        op = current
        current = ''
      } else {
        flush()
      }
      op += ch
      i++
      if (ch === '>' && segment[i] === '>') {
        op += '>'
        i++
      }
      if (ch === '>' && segment[i] === '&') {
        op += '&'
        i++
        while (i < segment.length && /\d/.test(segment[i])) {
          op += segment[i]
          i++
        }
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
  if (!/^(\d+|\*)?(<|>(?:>|&\d+)?)$/.test(token ?? '')) return null
  if (token.includes('<')) return { kind: 'read' }
  if (/&\d+$/.test(token)) return { kind: 'dup' }
  return { kind: 'write' } // > >> *> *>> 2> 2>> ...
}

/** Parse a leading assignment at words[cursor]; returns { consumed, value }
 * (value raw, quotes intact) or null when the word is not an assignment. */
function assignmentAt(words, cursor) {
  const word = words[cursor]
  const attached = /^\$(?:env:)?[A-Za-z_][A-Za-z0-9_]*=(.*)$/i.exec(word)
  if (attached) {
    if (attached[1].length > 0) return { consumed: 1, value: attached[1] }
    if (cursor + 1 >= words.length) return null // dangling `$x=`: fall through to the command check
    return { consumed: 2, value: words[cursor + 1] }
  }
  if (!/^\$(?:env:)?[A-Za-z_][A-Za-z0-9_]*$/i.test(word)) return null
  const next = words[cursor + 1]
  if (next === undefined || !next.startsWith('=')) return null
  if (next.length > 1) return { consumed: 2, value: next.slice(1) }
  if (cursor + 2 >= words.length) return null // dangling `$x =`
  return { consumed: 3, value: words[cursor + 2] }
}

/** A literal assignment RHS carries no command invocation: quoted strings,
 * numbers, variable references, and already-validated substitution spans. */
function isLiteralValue(value) {
  if (value.includes('\x00')) return true
  if (/['"]/.test(value)) return true
  if (value.startsWith('$')) return true
  if (/^-?[\d.]+$/.test(value)) return true
  return false
}

/** Strip quotes and resolve backtick escapes in one word (kept verbatim by
 * the tokenizer). Escapes resolve BEFORE any name lookup: i`ex → iex. */
function resolveWord(word) {
  let out = ''
  let quote = null
  let i = 0
  while (i < word.length) {
    const ch = word[i]
    if (quote === "'") {
      if (ch === "'" && word[i + 1] === "'") {
        out += "'"
        i += 2
        continue
      }
      if (ch === "'") quote = null
      else out += ch
      i++
      continue
    }
    if (quote === '"') {
      if (ch === '`' && i + 1 < word.length) {
        out += word[i + 1]
        i += 2
        continue
      }
      if (ch === '"') quote = null
      else out += ch
      i++
      continue
    }
    if (ch === '`' && i + 1 < word.length) {
      out += word[i + 1]
      i += 2
      continue
    }
    if (ch === "'" || ch === '"') {
      quote = ch
      i++
      continue
    }
    out += ch
    i++
  }
  return out
}
