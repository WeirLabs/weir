// Every label the worktree views ask for resolves in BOTH locales of the
// feature chunk's data face (lib/client.worktree-model.js's dictionaries,
// registered under "settings.weir.worktree" when the worktree batch arrives)
// once the composition root prefixes it (the locale service renders a missing
// key raw, so a gap would show "abandon" to the user).
import { describe, expect, it } from './helpers.js'
import { readFileSync } from 'node:fs'
import { loadClientChunk } from './helpers/load-client-chunk.js'

const view = readFileSync(new URL('../lib/client.worktree-view.js', import.meta.url), 'utf8')
const prefixed = (key) => `worktree${key.charAt(0).toUpperCase()}${key.slice(1)}`.replace(/-/g, '_')
const STATES = ['preparing', 'setup-failed', 'ready', 'working', 'dirty', 'no-commits', 'branch-moved', 'checking', 'check-failed', 'landable', 'conflicted', 'awaiting-approval', 'declined', 'landed', 'kept', 'cleaned', 'abandoned']
const TOOLS = ['worktree_open', 'worktree_check', 'worktree_land', 'worktree_cleanup', 'worktree_abandon', 'worktree_watch']
const NEXT_TOOLS = ['delegate', 'worktree_check', 'worktree_land', 'worktree_cleanup']
const WAITS = ['lane-ready', 'child-settle', 'check-complete', 'user']

describe('worktree view labels', () => {
  it('every literal and dynamic key exists exactly once per locale', async () => {
    const literal = [...view.matchAll(/t\(\s*["']([A-Za-z_]+)["']/g)].map((match) => match[1])
    expect(literal.length).toBeGreaterThan(40)
    const keys = [...new Set([...literal, ...STATES.map((state) => `state_${state}`), ...TOOLS.map((tool) => `tool_${tool}`), ...NEXT_TOOLS.map((tool) => `next_${tool}`), ...WAITS.map((wait) => `wait_${wait}`)])]
    // Sequential single load: loadClientChunk captures globalThis.window around
    // a cache-busted import, so it is not parallel-safe.
    const { exports: model } = await loadClientChunk('lib/client.worktree-model.js')
    const { en, zh } = model.dictionaries
    for (const key of keys) {
      const name = prefixed(key)
      expect(typeof en[name], `${name} must be defined in en`).toBe('string')
      expect(typeof zh[name], `${name} must be defined in zh`).toBe('string')
    }
  })
})
