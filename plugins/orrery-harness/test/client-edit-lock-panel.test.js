import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'
import { readFileSync } from 'node:fs'

/** client.edit-lock-panel.js: gated on the `edit-lock` command, every action is
 * an explicit /edit-lock run, and the dot colour follows the reported state. */
describe('client.edit-lock-panel chunk', () => {
  async function load() {
    const state = []
    let cursor = 0
    const reactStub = {
      begin() { cursor = 0 },
      useState(initial) {
        const at = cursor++
        if (!(at in state)) state[at] = [initial, (next) => { state[at][0] = next }]
        return state[at]
      },
      useEffect(fn) { const at = cursor++; if (!(at in state)) state[at] = { cleanup: fn() } },
    }
    const jsx = (type, props) => ({ __type: type, ...(props ?? {}) })
    const requireStub = (name) => {
      if (name === 'react') return reactStub
      if (name === 'react/jsx-runtime') return { jsx, jsxs: jsx }
      throw new Error(`unexpected require ${name}`)
    }
    const { definition, exports } = await loadClientChunk('lib/client.edit-lock-panel.js', requireStub)
    return { definition, exports, reactStub }
  }
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
  /** @param {any} node @param {(node: any) => boolean} match @returns {any} */
  function find(node, match) {
    if (!node || typeof node !== 'object') return undefined
    if (match(node)) return node
    for (const child of [].concat(node.children ?? [])) { const hit = find(child, match); if (hit) return hit }
    return undefined
  }

  it('stays hidden without the command, then runs status and actions through /edit-lock', async () => {
    const { definition, exports, reactStub } = await load()
    expect(definition.chunk).toBe('client.edit-lock-panel.js')
    const runs = []
    let catalog = []
    const props = {
      sessionId: 's1', t: (key) => key,
      commandsList: async () => catalog,
      runEditLock: async (verb) => { runs.push(verb); return { kind: 'success', text: `Edit Lock session s1: ${verb === 'stop' ? 'stopped' : 'active'}, epoch 1\n- /w/a [active] generation 1` } },
    }
    reactStub.begin(); expect(exports.EditLockPanel(props)).toBe(null)
    await flush(); reactStub.begin(); expect(exports.EditLockPanel(props)).toBe(null)

    catalog = [{ name: 'edit-lock' }]
    const { exports: fresh, reactStub: freshStub } = await load()
    freshStub.begin(); fresh.EditLockPanel(props); await flush()
    freshStub.begin()
    let tree = fresh.EditLockPanel(props)
    const button = find(tree, (node) => node['data-orrery-edit-lock'] === '')
    expect(button['aria-expanded']).toBe(false)
    button.onClick(); await flush()
    expect(runs).toEqual(['status'])
    freshStub.begin(); tree = fresh.EditLockPanel(props)
    expect(find(tree, (node) => node['data-orrery-edit-lock-panel'] === '')).toBeTruthy()
    expect(find(tree, (node) => node['data-orrery-edit-lock-state'] !== undefined)['data-orrery-edit-lock-state']).toBe('active')
    find(tree, (node) => node['data-orrery-edit-lock-action'] === 'stop').onClick(); await flush()
    expect(runs).toEqual(['status', 'stop'])
    freshStub.begin(); tree = fresh.EditLockPanel(props)
    expect(find(tree, (node) => node['data-orrery-edit-lock-state'] !== undefined)['data-orrery-edit-lock-state']).toBe('interrupted')
  })

  it('maps reported states to the dot colour classes', async () => {
    const { exports } = await load()
    expect(exports.stateOf('Edit Lock session s: recovering, epoch 2\n- /a [abnormal: provider-error] generation 1')).toBe('abnormal')
    expect(exports.stateOf('Edit Lock session s: active, epoch 2\n- /a [pending-confirmation] generation 1')).toBe('interrupted')
    expect(exports.stateOf('Edit Lock session s: active, epoch 2\n- no locks held')).toBe('active')
    expect(exports.stateOf(null)).toBe('unknown')
  })

  it('paints an opaque popover with theme-defined tokens only', () => {
    const source = readFileSync(new URL('../lib/client.edit-lock-panel.js', import.meta.url), 'utf8')
    // The theme's documented popover surface; an undefined token renders transparent.
    expect(source).toContain('background: "var(--dsw-alias-bg-overlay)"')
    // Tokens verified against dsh-client-ui-theme 0.2.0-rc.2 definitions.
    const DEFINED = new Set(['--dsw-alias-bg-overlay', '--dsw-alias-border-l2', '--dsw-alias-label-primary', '--dsw-alias-label-secondary',
      '--dsw-alias-label-tertiary', '--dsw-alias-state-business-primary', '--dsw-alias-state-error-primary', '--dsw-alias-state-warn-tertiary',
      '--dsw-font-markdown-code-block-font-family', '--dsw-radius-md', '--dsw-radius-sm'])
    for (const match of source.matchAll(/var\((--dsw-[a-z0-9-]+)/g)) expect(DEFINED.has(match[1]), `undefined theme token ${match[1]}`).toBe(true)
  })
})
