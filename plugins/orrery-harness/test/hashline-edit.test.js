import { describe, expect, it } from './helpers.js'
import { anchorFor, anchorIdFor, parseAnchor, validateAnchor } from '../src/hashline-edit/anchors.js'
import { applyOps, renderMismatch, validateOps } from '../src/hashline-edit/apply-ops.js'
import { unifiedDiff } from '../src/hashline-edit/diff.js'
import { anchorReadContent, HASH_EDIT_NAME } from '../src/hashline-edit/index.js'
import { apply } from '../src/hashline-edit/index.js'
import { xxh32 } from '../src/hashline-edit/xxhash32.js'

describe('xxh32', () => {
  it('matches the reference test vectors', () => {
    expect(xxh32('', 0)).toBe(0x02cc5d05)
    expect(xxh32('a', 0)).toBe(0x550d7456)
    expect(xxh32('abc', 0)).toBe(0x32d153ff)
  })

  it('is deterministic and seed-sensitive', () => {
    expect(xxh32('hello', 0)).toBe(xxh32('hello', 0))
    expect(xxh32('hello', 1)).not.toBe(xxh32('hello', 0))
  })
})

describe('anchors', () => {
  const lines = ['function hello() {', '  return 1', '}', '', 'const x = 2']

  it('produces N#XX anchors from the alphabet', () => {
    const anchor = anchorFor(1, 'function hello() {')
    expect(anchor).toMatch(/^1#[ZPMQVRWSNKTXJBYH]{2}$/)
  })

  it('anchors whitespace-only lines by line number', () => {
    const a = anchorIdFor(4, '')
    const b = anchorIdFor(5, '')
    expect(a).not.toBe(b)
  })

  it('round-trips parse and validate', () => {
    const anchor = anchorFor(2, lines[1])
    const parsed = parseAnchor(anchor)
    expect(parsed.line).toBe(2)
    expect(validateAnchor(parsed, lines).ok).toBe(true)
  })

  it('rejects malformed anchors', () => {
    expect(parseAnchor('2#zz')).toBeNull()
    expect(parseAnchor('x#VK')).toBeNull()
    expect(parseAnchor('2#VKA')).toBeNull()
  })

  it('detects stale anchors after content change', () => {
    const anchor = parseAnchor(anchorFor(1, lines[0]))
    const changed = ['function hello() { // edited', ...lines.slice(1)]
    const result = validateAnchor(anchor, changed)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('stale')
  })

  it('detects out-of-range anchors', () => {
    const result = validateAnchor({ line: 99, id: 'VK' }, lines)
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('out of range')
  })
})

describe('validateOps + applyOps', () => {
  const lines = ['a', 'b', 'c', 'd', 'e']
  const anchorAt = (n) => anchorFor(n, lines[n - 1])

  it('replaces a single line', () => {
    const ops = [{ op: 'replace', pos: anchorAt(2), lines: ['B'] }]
    expect(validateOps(ops, lines).ok).toBe(true)
    expect(applyOps(lines, ops)).toEqual(['a', 'B', 'c', 'd', 'e'])
  })

  it('replaces an inclusive range', () => {
    const ops = [{ op: 'replace', pos: anchorAt(2), end: anchorAt(4), lines: ['B', 'C'] }]
    expect(validateOps(ops, lines).ok).toBe(true)
    expect(applyOps(lines, ops)).toEqual(['a', 'B', 'C', 'e'])
  })

  it('appends after and prepends before', () => {
    const ops = [
      { op: 'append', pos: anchorAt(5), lines: ['f'] },
      { op: 'prepend', pos: anchorAt(1), lines: ['0'] },
    ]
    expect(validateOps(ops, lines).ok).toBe(true)
    expect(applyOps(lines, ops)).toEqual(['0', 'a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('applies multiple ops against original coordinates (bottom-up)', () => {
    const ops = [
      { op: 'replace', pos: anchorAt(2), lines: ['B', 'B2'] },
      { op: 'replace', pos: anchorAt(4), lines: ['D'] },
    ]
    expect(applyOps(lines, ops)).toEqual(['a', 'B', 'B2', 'c', 'D', 'e'])
  })

  it('rejects the whole call on one stale anchor', () => {
    const ops = [
      { op: 'replace', pos: anchorAt(1), lines: ['A'] },
      { op: 'replace', pos: anchorFor(3, 'CHANGED'), lines: ['C'] },
    ]
    const result = validateOps(ops, lines)
    expect(result.ok).toBe(false)
    expect(result.mismatches).toHaveLength(1)
    expect(result.mismatches[0]).toContain('edit 2')
  })

  it('rejects malformed and reversed anchors', () => {
    expect(validateOps([{ op: 'replace', pos: 'nope', lines: [] }], lines).ok).toBe(false)
    const reversed = [{ op: 'replace', pos: anchorAt(4), end: anchorAt(2), lines: ['x'] }]
    const result = validateOps(reversed, lines)
    expect(result.ok).toBe(false)
    expect(result.mismatches[0]).toContain('precedes')
  })

  it('rejects unknown ops', () => {
    expect(validateOps([{ op: 'delete', pos: anchorAt(1), lines: [] }], lines).ok).toBe(false)
  })

  it('renders the fail-closed mismatch report', () => {
    const report = renderMismatch(['edit 1 (replace): anchor 3#VK is stale'])
    expect(report).toContain('>>> mismatch')
    expect(report).toContain('NOT modified')
    expect(report).toContain('Re-read')
  })
})

describe('unifiedDiff', () => {
  it('renders hunks for changed regions', () => {
    const diff = unifiedDiff('a.js', 'line1\nline2\nline3', 'line1\nCHANGED\nline3')
    expect(diff).toContain('--- a/a.js')
    expect(diff).toContain('+++ b/a.js')
    expect(diff).toContain('-line2')
    expect(diff).toContain('+CHANGED')
    expect(diff).toContain('@@')
  })

  it('is empty for identical content', () => {
    expect(unifiedDiff('a.js', 'same', 'same')).toBe('')
  })
})

describe('anchorReadContent', () => {
  it('anchors numbered lines and preserves everything else', () => {
    const value = { lines: [{ number: 1, text: 'hello' }, { number: 2, text: 'world' }] }
    const content = [{ type: 'text', text: '1: hello\n2: world\n\n(End of file - total 2 lines)' }]
    const rewritten = anchorReadContent(value, content)
    expect(rewritten[0].text).toContain(`1#${anchorFor(1, 'hello').split('#')[1]}| hello`)
    expect(rewritten[0].text).toContain('(End of file')
  })

  it('leaves truncated (capped) lines anchor-free', () => {
    const value = { lines: [{ number: 1, text: 'a very long line indeed' }] }
    const content = [{ type: 'text', text: '1: a very long' }]
    const rewritten = anchorReadContent(value, content)
    expect(rewritten[0].text).toBe('1| a very long')
  })

  it('passes through when value is absent', () => {
    const content = [{ type: 'text', text: 'anything' }]
    expect(anchorReadContent(undefined, content)).toBe(content)
  })
})

describe('hash_edit tool', () => {
  function harness(fileContent) {
    const files = new Map([['/ws/a.js', fileContent]])
    const handlers = {}
    const registered = []
    const writes = []
    const injected = []
    const ctx = {
      tools: {
        register: (tool) => registered.push(tool),
        restrict: () => {},
      },
      fs: {
        resolve: async (path) => ({ targetKey: path, displayPath: path }),
        stat: async (target) => (files.has(target.targetKey) ? { version: 'v1', type: 'file' } : undefined),
        readText: async (target) => files.get(target.targetKey),
        writeText: async (target, content, expected, signal, policy) => {
          writes.push({ target, content, expected, signal, policy })
          files.set(target.targetKey, content)
          return { operation: 'update', version: 'v2', before: null, after: content }
        },
      },
      on: (event, handler) => {
        handlers[event] = handler
      },
      inject: (deps, cb) => {
        injected.push({ deps, cb })
      },
    }
    apply(ctx, {})
    const tool = registered.find((t) => t.name === HASH_EDIT_NAME)
    const exec = { agent: { session: { header: { cwd: '/ws' } } }, signal: new AbortController().signal }
    return { tool, files, exec, handlers, registered, writes, injected }
  }

  it('applies a valid edit and returns a diff', async () => {
    const { tool, files, exec } = harness('alpha\nbeta\ngamma')
    const anchor = anchorFor(2, 'beta')
    const result = await tool.execute(
      { file_path: '/ws/a.js', edits: [{ op: 'replace', pos: anchor, lines: ['BETA'] }] },
      exec,
    )
    expect(files.get('/ws/a.js')).toBe('alpha\nBETA\ngamma')
    expect(result.diff).toContain('-beta')
    expect(result.diff).toContain('+BETA')
    expect(result.ops).toBe(1)
  })

  it('passes the session-resolved sandbox policy to writeText (S23)', async () => {
    const { tool, files, exec, injected, writes } = harness('alpha\nbeta\ngamma')
    expect(injected).toHaveLength(1)
    expect(injected[0].deps).toEqual(['sandboxPolicy'])
    const fakePolicy = { mode: 'workspace-write', workspaceRoot: '/ws', sessionId: 's1' }
    let resolvedReq = null
    injected[0].cb({ sandboxPolicy: { resolve: (req) => {
      resolvedReq = req
      return fakePolicy
    } } })
    const anchor = anchorFor(2, 'beta')
    await tool.execute(
      { file_path: '/ws/a.js', edits: [{ op: 'replace', pos: anchor, lines: ['BETA'] }] },
      exec,
    )
    expect(resolvedReq).toEqual({ session: exec.agent.session })
    expect(writes).toHaveLength(1)
    expect(writes[0].policy).toBe(fakePolicy)
    expect(files.get('/ws/a.js')).toBe('alpha\nBETA\ngamma')
  })

  it('preserves the no-policy shape when the sandbox service is absent', async () => {
    const { tool, exec, writes } = harness('alpha')
    const anchor = anchorFor(1, 'alpha')
    await tool.execute(
      { file_path: '/ws/a.js', edits: [{ op: 'replace', pos: anchor, lines: ['A'] }] },
      exec,
    )
    expect(writes[0].policy).toBeUndefined()
  })

  it('fails closed on a stale anchor: zero writes', async () => {
    const { tool, files, exec } = harness('alpha\nbeta\ngamma')
    const stale = anchorFor(2, 'beta-OLD')
    await expect(async () =>
      tool.execute({ file_path: '/ws/a.js', edits: [{ op: 'replace', pos: stale, lines: ['BETA'] }] }, exec),
    ).rejects.toThrow(/>>> mismatch/)
    expect(files.get('/ws/a.js')).toBe('alpha\nbeta\ngamma')
  })

  it('rejects missing files and malformed anchors', async () => {
    const { tool, exec } = harness('x')
    await expect(async () => tool.execute({ file_path: '/ws/absent.js', edits: [{ op: 'replace', pos: '1#VK', lines: [] }] }, exec))
      .rejects.toThrow(/no regular file/)
    await expect(async () => tool.execute({ file_path: '/ws/a.js', edits: [{ op: 'replace', pos: 'bad', lines: [] }] }, exec))
      .rejects.toThrow(/malformed/)
  })

  it('registers a post-execute read enhancer', () => {
    const { handlers } = harness('x')
    expect(typeof handlers['tools/post-execute']).toBe('function')
  })

  it('hideStockEdit restricts the stock edit per created agent (uniform mechanism)', () => {
    const restrictedBy = []
    const listeners = {}
    const ctx = {
      tools: {
        register: () => {},
        get: (toolName, scope) => (toolName === 'edit' && scope ? { name: 'edit' } : undefined),
        restrict: (filter) => restrictedBy.push(['mount-time-should-not-happen', filter]),
      },
      fs: {},
      on: (event, listener) => {
        listeners[event] = listener
      },
    }
    apply(ctx, { hideStockEdit: true })
    // no mount-time restrict at any level (host-level would throw unscoped;
    // preset-scope would throw unknown-global — the per-agent path avoids both)
    expect(restrictedBy).toHaveLength(0)
    expect(typeof listeners['agent/created']).toBe('function')
    listeners['agent/created']({ agent: { ctx: { tools: { restrict: (filter) => restrictedBy.push(filter) } } } })
    expect(restrictedBy).toEqual([{ deny: ['edit'] }])
  })

  it('hideStockEdit skips agents whose view has no stock edit', () => {
    const listeners = {}
    let restricted = 0
    const ctx = {
      tools: {
        register: () => {},
        get: () => undefined,
        restrict: () => {
          throw new Error('should not be called')
        },
      },
      fs: {},
      on: (event, listener) => {
        listeners[event] = listener
      },
    }
    apply(ctx, { hideStockEdit: true })
    listeners['agent/created']({ agent: { ctx: { tools: { restrict: () => restricted++ } } } })
    expect(restricted).toBe(0)
  })

  it('hideStockEdit presence check uses the agent view (preset-layer edit counts)', () => {
    const restrictedBy = []
    const listeners = {}
    let getScope
    const ctx = {
      tools: {
        register: () => {},
        get: (toolName, scope) => {
          getScope = scope
          return { name: toolName }
        },
        restrict: () => {},
      },
      fs: {},
      on: (event, listener) => {
        listeners[event] = listener
      },
    }
    apply(ctx, { hideStockEdit: true })
    const agent = { ctx: { tools: { restrict: (filter) => restrictedBy.push(filter) } } }
    listeners['agent/created']({ agent })
    expect(getScope).toBe(agent)
    expect(restrictedBy).toEqual([{ deny: ['edit'] }])
  })
})
