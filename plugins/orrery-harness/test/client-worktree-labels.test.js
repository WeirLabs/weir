// Every label the worktree views ask for resolves in BOTH dictionaries once
// the composition root prefixes it (the locale service renders a missing key
// raw, so a gap would show "abandon" to the user).
import { describe, expect, it } from './helpers.js'
import { readFileSync } from 'node:fs'

const view = readFileSync(new URL('../lib/client.worktree-view.js', import.meta.url), 'utf8')
const client = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')
const prefixed = (key) => `worktree${key.charAt(0).toUpperCase()}${key.slice(1)}`.replace(/-/g, '_')
const STATES = ['preparing', 'setup-failed', 'ready', 'working', 'dirty', 'no-commits', 'branch-moved', 'checking', 'check-failed', 'landable', 'conflicted', 'awaiting-approval', 'declined', 'landed', 'kept', 'cleaned', 'abandoned']
const TOOLS = ['worktree_open', 'worktree_check', 'worktree_land', 'worktree_cleanup', 'worktree_abandon']
const NEXT_TOOLS = ['delegate', 'worktree_check', 'worktree_land', 'worktree_cleanup']
const WAITS = ['lane-ready', 'child-settle', 'check-complete', 'user']

describe('worktree view labels', () => {
  it('every literal and dynamic key exists exactly once per locale', () => {
    const literal = [...view.matchAll(/t\(\s*["']([A-Za-z_]+)["']/g)].map((match) => match[1])
    expect(literal.length).toBeGreaterThan(40)
    const keys = [...new Set([...literal, ...STATES.map((state) => `state_${state}`), ...TOOLS.map((tool) => `tool_${tool}`), ...NEXT_TOOLS.map((tool) => `next_${tool}`), ...WAITS.map((wait) => `wait_${wait}`)])]
    for (const key of keys) {
      const count = client.split(`\t\t\t${prefixed(key)}:`).length - 1
      expect(count, `${prefixed(key)} must be defined in en and zh`).toBe(2)
    }
  })
})
