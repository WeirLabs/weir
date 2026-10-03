// Lane and Worktree-mode guard decisions. Pure: callers inject path
// resolution (realpath + platform normalization) and the read-only shell
// checker, and attach the returned decision function with tools.guard (which
// can only refuse, never rewrite — the refusal text tells the model the exact
// correction). Pure module (no ctx, no node: imports).
import { inScope } from './rules.js'

/** File-write tools whose target is `file_path`. */
export const PATH_WRITE_TOOLS = Object.freeze(['write', 'edit', 'hash_edit', 'str_replace_editor'])
/** Write tools whose effects cannot be bounded before they run. */
export const UNBOUNDED_WRITE_TOOLS = Object.freeze(['lsp_rename'])
export const SHELL_TOOLS = Object.freeze(['bash', 'pwsh'])

/** git subcommands that move, rename, or escape the lane branch. */
const FORBIDDEN_GIT = new Set(['checkout', 'switch', 'worktree', 'push', 'update-ref', 'symbolic-ref', 'filter-branch', 'replace'])
const FORBIDDEN_BRANCH_FLAGS = new Set(['-m', '-M', '-d', '-D', '-c', '-C', '-f', '--move', '--delete', '--copy', '--force', '--set-upstream-to', '-u'])
const GIT_PATH_FLAGS = new Set(['-C', '--git-dir', '--work-tree'])
const GIT_VALUE_FLAGS = new Set(['-c', '--namespace', '--exec-path', '--config-env'])
const SEPARATORS = new Set([';', '&&', '||', '|', '&', '\n', '(', ')', '$(', '`', '{', '}'])
/** Shell words after which the next word is a command again. */
const CONTROL_WORDS = new Set(['then', 'else', 'do', '!', 'if', 'while', 'until', 'elif'])
/** Commands that run their arguments as a command (the git gate looks through them). */
const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'time', 'nice', 'nohup', 'xargs', 'builtin'])

/**
 * Coarse shell tokenizer: whitespace-split words with separators as their own
 * tokens; quotes are stripped (a quoted separator stays inside its word).
 * @param {string} command
 */
export function tokenize(command) {
  /** @type {string[]} */
  const tokens = []
  let word = ''
  let quote = ''
  const flush = () => {
    if (word.length > 0) tokens.push(word)
    word = ''
  }
  for (let index = 0; index < command.length; index++) {
    const ch = command[index]
    if (quote) {
      if (ch === quote) quote = ''
      else word += ch
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    const two = command.slice(index, index + 2)
    if (two === '&&' || two === '||' || two === '$(') {
      flush()
      tokens.push(two)
      index++
      continue
    }
    if (SEPARATORS.has(ch)) {
      flush()
      tokens.push(ch === '\n' ? ';' : ch)
      continue
    }
    if (/\s/.test(ch)) {
      flush()
      continue
    }
    word += ch
  }
  flush()
  return tokens
}

const isHeadish = (/** @type {string} */ ref) => /^(HEAD|@)([~^]\d*)*$/.test(ref)

/**
 * The first lane-escaping git invocation in a shell command, or null.
 * @param {string} command
 * @returns {string | null} refusal reason
 */
export function laneGitViolation(command) {
  const tokens = tokenize(String(command ?? ''))
  let atCommand = true
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]
    if (SEPARATORS.has(token) || CONTROL_WORDS.has(token)) {
      atCommand = true
      continue
    }
    if (!atCommand) continue
    // Env assignments and wrapper commands keep the command position open.
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token) || WRAPPERS.has(token) || (token.startsWith('-') && index > 0 && WRAPPERS.has(tokens[index - 1]))) continue
    atCommand = false
    const base = token.split(/[\\/]/).pop()
    if (base !== 'git' && base !== 'git.exe') continue
    let cursor = index + 1
    while (cursor < tokens.length && tokens[cursor].startsWith('-') && !SEPARATORS.has(tokens[cursor])) {
      const flag = tokens[cursor].split('=')[0]
      if (GIT_PATH_FLAGS.has(flag)) return `git ${flag} points git at another repository or worktree`
      cursor += GIT_VALUE_FLAGS.has(flag) && !tokens[cursor].includes('=') ? 2 : 1
    }
    const sub = tokens[cursor]
    if (!sub || SEPARATORS.has(sub)) continue
    /** @type {string[]} */
    const rest = []
    for (let scan = cursor + 1; scan < tokens.length && !SEPARATORS.has(tokens[scan]); scan++) rest.push(tokens[scan])
    if (FORBIDDEN_GIT.has(sub)) return `git ${sub} would move or escape the lane branch`
    if (sub === 'branch' && rest.some((arg) => FORBIDDEN_BRANCH_FLAGS.has(arg.split('=')[0]))) return 'git branch may not rename, copy, or delete branches in a lane'
    if (sub === 'reset' && rest.some((arg) => !arg.startsWith('-') && !isHeadish(arg))) return 'git reset may only target HEAD-relative commits in a lane'
  }
  return null
}

/**
 * @typedef {object} LaneGuardSpec
 * @property {string} laneId
 * @property {string} lanePath - normalized absolute lane path
 * @property {string[] | null} scope
 * @property {boolean} readOnly
 * @property {(path: string) => string} resolve - absolute, realpath'd, normalized path for a tool argument
 */

/**
 * Decide one tool call of a lane-bound child.
 * @param {{ name: string, arguments?: any }} execution
 * @param {LaneGuardSpec} spec
 * @returns {string | undefined} refusal text, undefined to allow
 */
export function decideLaneCall(execution, spec) {
  const args = execution.arguments ?? {}
  const within = (/** @type {string} */ path) => path === spec.lanePath || path.startsWith(`${spec.lanePath}/`)
  const tag = `lane ${spec.laneId}`
  if (SHELL_TOOLS.includes(execution.name)) {
    if (typeof args.workdir !== 'string' || args.workdir.trim().length === 0) {
      return `${tag}: every ${execution.name} call must pass workdir set to the lane (${spec.lanePath}) or a directory inside it`
    }
    const workdir = spec.resolve(args.workdir)
    if (!within(workdir)) return `${tag}: workdir ${args.workdir} is outside the lane; use ${spec.lanePath}`
    const violation = typeof args.command === 'string' ? laneGitViolation(args.command) : null
    if (violation) return `${tag}: ${violation}; stay on the lane branch and commit there`
    return undefined
  }
  if (UNBOUNDED_WRITE_TOOLS.includes(execution.name)) {
    return spec.readOnly ? undefined : `${tag}: ${execution.name} can rewrite files outside the lane and is disabled for lane workers; edit the files directly`
  }
  if (PATH_WRITE_TOOLS.includes(execution.name)) {
    if (typeof args.file_path !== 'string' || args.file_path.length === 0) return undefined
    const target = spec.resolve(args.file_path)
    if (!within(target)) return `${tag}: ${args.file_path} is outside the lane; write under ${spec.lanePath} (absolute paths)`
    const relative = target.slice(spec.lanePath.length + 1)
    if (!inScope(relative, spec.scope)) return `${tag}: ${relative} is outside the lane scope (${(spec.scope ?? []).join(', ')})`
  }
  return undefined
}

/**
 * Attach a lane guard to a live child agent (tools.guard: refuse-only).
 * @param {any} agent - the child agent handle
 * @param {LaneGuardSpec} spec
 */
export function attachLaneGuard(agent, spec) {
  if (!agent?.ctx?.tools?.guard) throw new Error(`lane ${spec.laneId}: the child agent exposes no tool guard`)
  return agent.ctx.tools.guard((/** @type {any} */ execution) => decideLaneCall(execution, spec))
}

/**
 * Decide one tool call of a MAIN agent while its session is in Worktree mode.
 * @param {{ name: string, arguments?: any }} execution
 * @param {(command: string, shell: string) => string | undefined} checkReadOnlyShell - the read-only shell guard
 * @returns {string | undefined}
 */
export function decideModeCall(execution, checkReadOnlyShell) {
  if (PATH_WRITE_TOOLS.includes(execution.name) || UNBOUNDED_WRITE_TOOLS.includes(execution.name)) {
    return 'Worktree mode is on: the main agent does not edit files. Open a lane with worktree_open and delegate the change with delegate(worktree=<lane>)'
  }
  if (SHELL_TOOLS.includes(execution.name)) {
    const command = execution.arguments?.command
    if (typeof command !== 'string') return 'Worktree mode is on: shell calls need a command string'
    const refusal = checkReadOnlyShell(command, execution.name)
    return refusal ? `Worktree mode is on: the main agent's shell is read-only (${refusal}). Delegate changes to a lane` : undefined
  }
  return undefined
}
