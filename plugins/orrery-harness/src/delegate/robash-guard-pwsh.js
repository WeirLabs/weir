// Read-only pwsh guard: independent PowerShell parsing path for curated
// read-only children on Windows (where the preset disables bash and mounts
// pwsh instead). Mirrors the bash guard's three-layer shape (scan →
// tokenizeSegment → checkSegment) but with pwsh-native lexing: backtick is
// the escape char, `&` is the call operator, here-strings instead of
// here-docs, and all name lookups are case-insensitive. Fail-closed like the
// bash side: anything the parser cannot statically prove read-only is denied.

import { checkGitArgs } from './robash-guard.js'

/** Read-only built-in aliases, expanded before the table lookup (lowercase). */
const PWSH_ALIASES = {
  ls: 'get-childitem', dir: 'get-childitem', gci: 'get-childitem',
  gc: 'get-content', cat: 'get-content', type: 'get-content',
  pwd: 'get-location',
  ps: 'get-process', gps: 'get-process',
  sls: 'select-string',
  sort: 'sort-object', where: 'where-object', measure: 'measure-object',
  select: 'select-object', echo: 'write-output',
}

/** Initial pwsh whitelist (conservative; iterate via readOnlyPwsh config and
 * the robashPwshAllow/robashPwshDeny settings keys). Matching is
 * case-insensitive; the git subcommand gate is shared with the bash side. */
export const DEFAULT_ROBASH_PWSH = {
  allow: [
    'Get-Content', 'Get-ChildItem', 'Get-Item', 'Get-Location', 'Get-Date', 'Get-Process',
    'Test-Path', 'Select-String', 'Select-Object', 'Sort-Object', 'Where-Object', 'Measure-Object',
    'Group-Object', 'Compare-Object', 'Format-Table', 'Format-List', 'Format-Wide', 'Out-String',
    'Write-Output', 'ConvertTo-Json', 'git',
  ],
  deny: [
    'iex', 'Invoke-Expression', 'Invoke-Command', 'Start-Process', 'powershell', 'pwsh',
    'cmd', 'cscript', 'wscript', 'reg', 'icacls', 'Get-Credential',
    'Invoke-WebRequest', 'Invoke-RestMethod',
    'Set-Content', 'Out-File', 'Add-Content', 'Clear-Content',
    'New-Item', 'Remove-Item', 'Move-Item', 'Copy-Item', 'Rename-Item', 'Set-Item',
    'Set-ExecutionPolicy',
  ],
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
// Layer 1: scan the command line — recurse into $(...)/(...) and here-strings,
// split top-level segments (pipes/sequences/newlines), then check each segment.
// ---------------------------------------------------------------------------

function analyze(command, sets, depth) {
  if (depth > 8) return 'read-only agent: command substitution is nested too deeply'
  if (typeof command !== 'string' || command.trim().length === 0) return undefined
  const text = command.replace(/\r\n/g, '\n')

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
      if (ch === '&' && text[i + 1] === '&') {
        i += 2
        flushSegment()
        continue
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
    }

    // $( ) subexpressions — live in normal and double-quoted mode
    if (ch === '$' && text[i + 1] === '(') {
      const inner = readParen(text, i + 1)
      if (inner === null) return 'read-only agent: command could not be proven read-only (unbalanced subexpression)'
      const nested = analyze(inner.body, sets, depth + 1)
      if (nested) return nested
      current += '\x00'
      i = inner.end
      continue
    }
    // ( ) groupings — top level only; recurse like subexpressions
    if (ch === '(' && quote === null) {
      const inner = readParen(text, i)
      if (inner === null) return 'read-only agent: command could not be proven read-only (unbalanced grouping)'
      const nested = analyze(inner.body, sets, depth + 1)
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
    const reason = checkSegment(segment, sets)
    if (reason) return reason
  }
  return undefined
}

/** Scan an interpolating here-string body: validate only nested $( ). */
function scanHereString(body, sets, depth) {
  if (depth > 8) return 'read-only agent: command substitution is nested too deeply'
  let i = 0
  while (i < body.length) {
    const ch = body[i]
    if (ch === '`') {
      i += 2
      continue
    }
    if (ch === '$' && body[i + 1] === '(') {
      const inner = readParen(body, i + 1)
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

  const words = []
  for (let t = 0; t < tokens.length; t++) {
    const redirect = parseRedirect(tokens[t])
    if (redirect) {
      if (redirect.kind === 'read') return 'read-only agent: redirection is not allowed'
      if (redirect.kind === 'write') {
        const target = resolveWord(tokens[t + 1] ?? '').replace(/\x00/g, '')
        if (target.toLowerCase() === '$null') {
          t++ // $null sink: no file write
          continue
        }
        return `read-only agent: write redirection to '${target}' is not allowed`
      }
      continue // fd duplication (2>&1): no file write, no target word
    }
    words.push(tokens[t])
  }

  // Strip leading simple assignments ($x = <literal>, $env:X = <literal>).
  // A bare-word RHS is a command invocation in PowerShell ($x = iex ... runs
  // iex), so only quoted/numeric/variable/substituted values are consumed as
  // literals; a bare word is re-checked as the command word below.
  let cursor = 0
  while (cursor < words.length) {
    const assignment = assignmentAt(words, cursor)
    if (!assignment) break
    if (isLiteralValue(assignment.value)) {
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
    // recursively during the scan, nothing else runs
    return substituted ? undefined : 'read-only agent: command could not be proven read-only (empty command word)'
  }
  if (substituted) return 'read-only agent: dynamic invocation cannot be proven read-only'

  // alias expansion → basename on both \ and / → case-insensitive lookup
  const expanded = PWSH_ALIASES[resolved.toLowerCase()] ?? resolved
  const parts = expanded.split(/[\\/]/)
  const name = parts[parts.length - 1].toLowerCase()
  const args = words.slice(commandIndex + 1).map((word) => resolveWord(word).replace(/\x00/g, ''))

  if (sets.deny.has(name)) return `read-only agent: '${name}' is explicitly denied`
  if (!sets.allow.has(name)) return `read-only agent: '${name}' is not on the read-only allow list`

  if (name === 'git') return checkGitArgs(args, sets.gitAllow)
  return undefined
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
