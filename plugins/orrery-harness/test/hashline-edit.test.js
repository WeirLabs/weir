import { describe, expect, it } from './helpers.js'
import { anchorFor, anchorIdFor, parseAnchor, validateAnchor } from '../src/hashline-edit/anchors.js'
import { applyOps, renderMismatch, splitText, validateOps } from '../src/hashline-edit/apply-ops.js'
import { diffFragments, unifiedDiff } from '../src/hashline-edit/diff.js'
import { anchorReadContent, HASH_EDIT_DESCRIPTION, HASH_EDIT_NAME } from '../src/hashline-edit/index.js'
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
    const ops = [{ op: 'replace', pos: anchorAt(2), text: 'B' }]
    expect(validateOps(ops, lines).ok).toBe(true)
    expect(applyOps(lines, ops)).toEqual(['a', 'B', 'c', 'd', 'e'])
  })

  it('replaces an inclusive range', () => {
    const ops = [{ op: 'replace', pos: anchorAt(2), end: anchorAt(4), text: 'B\nC' }]
    expect(validateOps(ops, lines).ok).toBe(true)
    expect(applyOps(lines, ops)).toEqual(['a', 'B', 'C', 'e'])
  })

  it('appends after and prepends before', () => {
    const ops = [
      { op: 'append', pos: anchorAt(5), text: 'f' },
      { op: 'prepend', pos: anchorAt(1), text: '0' },
    ]
    expect(validateOps(ops, lines).ok).toBe(true)
    expect(applyOps(lines, ops)).toEqual(['0', 'a', 'b', 'c', 'd', 'e', 'f'])
  })

  it('applies multiple ops against original coordinates (bottom-up)', () => {
    const ops = [
      { op: 'replace', pos: anchorAt(2), text: 'B\nB2' },
      { op: 'replace', pos: anchorAt(4), text: 'D' },
    ]
    expect(applyOps(lines, ops)).toEqual(['a', 'B', 'B2', 'c', 'D', 'e'])
  })

  it('rejects the whole call on one stale anchor', () => {
    const ops = [
      { op: 'replace', pos: anchorAt(1), text: 'A' },
      { op: 'replace', pos: anchorFor(3, 'CHANGED'), text: 'C' },
    ]
    const result = validateOps(ops, lines)
    expect(result.ok).toBe(false)
    expect(result.mismatches).toHaveLength(1)
    expect(result.mismatches[0]).toContain('edit 2')
  })

  it('rejects malformed and reversed anchors', () => {
    expect(validateOps([{ op: 'replace', pos: 'nope', text: '' }], lines).ok).toBe(false)
    const reversed = [{ op: 'replace', pos: anchorAt(4), end: anchorAt(2), text: 'x' }]
    const result = validateOps(reversed, lines)
    expect(result.ok).toBe(false)
    expect(result.mismatches[0]).toContain('precedes')
  })

  it('rejects unknown ops', () => {
    expect(validateOps([{ op: 'delete', pos: anchorAt(1), text: '' }], lines).ok).toBe(false)
  })

  it('splits text at \\n dropping at most one trailing empty element', () => {
    expect(splitText('a\nb\n')).toEqual(['a', 'b'])
    expect(splitText('a\n\nb')).toEqual(['a', '', 'b'])
    expect(splitText('a')).toEqual(['a'])
    expect(splitText('')).toEqual([])
  })

  it('reports a missing text before any anchor validation', () => {
    const stale = anchorFor(3, 'CHANGED')
    const result = validateOps([{ op: 'append', pos: stale }], lines)
    expect(result.ok).toBe(false)
    expect(result.mismatches).toHaveLength(1)
    expect(result.mismatches[0]).toContain('edit 1 (append): text must be a string')
    expect(result.mismatches[0]).toContain('call again with the corrected shape')
  })

  it('rejects a non-string text with the corrected-shape hint', () => {
    const result = validateOps([{ op: 'replace', pos: anchorAt(1), text: ['A'] }], lines)
    expect(result.ok).toBe(false)
    expect(result.mismatches[0]).toContain('text must be a string')
    expect(result.mismatches[0]).toContain('call again with the corrected shape')
  })

  it('deletes the anchored range on empty text (replace) and no-ops on append/prepend', () => {
    const del = [{ op: 'replace', pos: anchorAt(2), end: anchorAt(4), text: '' }]
    expect(validateOps(del, lines).ok).toBe(true)
    expect(applyOps(lines, del).join('\n')).toBe('a\ne')
    const noop = [
      { op: 'append', pos: anchorAt(5), text: '' },
      { op: 'prepend', pos: anchorAt(1), text: '' },
    ]
    expect(applyOps(lines, noop).join('\n')).toBe('a\nb\nc\nd\ne')
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

describe('diffFragments', () => {
  it('yields one fragment per hunk in file order with context on both sides', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line${i + 1}`).join('\n')
    const after = before.replace('line2', 'TWO').replace('line18', 'EIGHTEEN')
    const fragments = diffFragments('a.js', before, after)
    expect(fragments).toHaveLength(2)
    expect(fragments[0].path).toBe('a.js')
    expect(fragments[0].oldText).toContain('line2')
    expect(fragments[0].newText).toContain('TWO')
    expect(fragments[0].oldText).toContain('line1') // leading context
    expect(fragments[0].newText).toContain('line1')
    expect(fragments[1].oldText).toContain('line18')
    expect(fragments[1].newText).toContain('EIGHTEEN')
    expect(fragments[0].oldText).not.toContain('line18') // hunks stay separate
  })

  it('carries a context-only oldText for a mid-file insertion', () => {
    const before = 'alpha\nbeta\ngamma\ndelta'
    const after = 'alpha\nbeta\nINSERTED\ngamma\ndelta'
    const fragments = diffFragments('a.js', before, after)
    expect(fragments).toHaveLength(1)
    const [fragment] = fragments
    expect(fragment.oldText).not.toContain('INSERTED')
    expect(fragment.oldText.length > 0).toBe(true)
    for (const line of fragment.oldText.split('\n')) expect(before.split('\n')).toContain(line)
    expect(fragment.newText).toContain('INSERTED')
    expect(fragment.newText).toContain('beta') // context on the new side too
  })

  it('is empty for identical content', () => {
    expect(diffFragments('a.js', 'same', 'same')).toEqual([])
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
  function harness(fileContent, opts = {}) {
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
          if (opts.denyError) {
            const error = new Error(opts.denyError.message ?? '[sandbox: file access denied under workspace-write mode]')
            if (opts.denyError.code) error.code = opts.denyError.code
            throw error
          }
          files.set(target.targetKey, content)
          return { operation: 'update', version: 'v2', before: null, after: content }
        },
        ...(opts.sandboxMode !== undefined ? { sandboxMode: opts.sandboxMode } : {}),
      },
      get: (name) => opts.services?.[name],
      on: (event, handler) => {
        handlers[event] = handler
      },
      inject: (deps, cb) => {
        injected.push({ deps, cb })
      },
    }
    apply(ctx, {})
    const tool = registered.find((t) => t.name === HASH_EDIT_NAME)
    const exec = { agent: { session: { header: { cwd: '/ws' } } }, callId: 'call-1', signal: new AbortController().signal }
    return { tool, files, exec, handlers, registered, writes, injected }
  }

  it('uses the captured lock publisher and never falls back after its rejection', async () => {
    const calls = []
    const services = { orreryEditLock: { publish: async (exec, request) => {
      calls.push({ exec, request })
      throw new Error('lock conflict')
    } } }
    const { tool, exec, writes } = harness('alpha', { services })
    delete services.orreryEditLock
    let failure
    try { await tool.execute({ file_path: '/ws/a.js', edits: [{ op: 'replace', pos: anchorFor(1, 'alpha'), text: 'beta' }] }, exec) }
    catch (error) { failure = error }
    expect(failure.message).toBe('lock conflict')
    expect(writes.length).toBe(0)
    expect(calls.length).toBe(1)
    expect(calls[0].exec).toBe(exec)
    expect(calls[0].request.content).toBe('beta')
    expect(calls[0].request.expected.version).toBe('v1')
  })
  it('applies a valid edit and returns a diff', async () => {
    const { tool, files, exec } = harness('alpha\nbeta\ngamma')
    const anchor = anchorFor(2, 'beta')
    const result = await tool.execute(
      { file_path: '/ws/a.js', edits: [{ op: 'replace', pos: anchor, text: 'BETA' }] },
      exec,
    )
    expect(files.get('/ws/a.js')).toBe('alpha\nBETA\ngamma')
    expect(result.diff).toContain('-beta')
    expect(result.diff).toContain('+BETA')
    expect(result.ops).toBe(1)
  })

  it('persists structured diff fragments via presentationMeta', async () => {
    const { tool, exec } = harness('alpha\nbeta\ngamma')
    const anchor = anchorFor(2, 'beta')
    const args = { file_path: '/ws/a.js', edits: [{ op: 'replace', pos: anchor, text: 'BETA' }] }
    const result = await tool.execute(args, exec)
    expect(Array.isArray(result.fragments)).toBe(true)
    expect(result.fragments).toHaveLength(1)
    expect(result.fragments[0].path).toBe('/ws/a.js')
    expect(result.fragments[0].oldText).toContain('beta')
    expect(result.fragments[0].newText).toContain('BETA')
    // The presentation meta channel mirrors the same comparison.
    const meta = tool.output.presentationMeta(args, result)
    expect(meta.diffs).toEqual(result.fragments)
    // The model-facing rendered text is unchanged in shape.
    const rendered = tool.output.render(args, result)
    expect(rendered[0].text).toContain('hash_edit applied 1 op(s) to /ws/a.js:')
    expect(rendered[0].text).toContain('-beta')
    expect(rendered[0].text).toContain('+BETA')
  })

  it('persists no diff metadata for a rejected call', async () => {
    const { tool, exec } = harness('alpha\nbeta\ngamma')
    let thrown
    try {
      await tool.execute({ file_path: '/ws/a.js', edits: [{ op: 'replace', pos: '2#ZZ', text: 'BETA' }] }, exec)
    } catch (error) {
      thrown = error
    }
    expect(thrown !== undefined).toBe(true)
    expect(String(thrown.message)).toContain('>>> mismatch')
    // presentationMeta is only invoked by the runtime on success; a
    // fragments-less value narrows to an empty diff list defensively.
    expect(tool.output.presentationMeta({}, {})).toEqual({ diffs: [] })
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
      { file_path: '/ws/a.js', edits: [{ op: 'replace', pos: anchor, text: 'BETA' }] },
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
      { file_path: '/ws/a.js', edits: [{ op: 'replace', pos: anchor, text: 'A' }] },
      exec,
    )
    expect(writes[0].policy).toBeUndefined()
  })

  it('fails closed on a stale anchor: zero writes', async () => {
    const { tool, files, exec } = harness('alpha\nbeta\ngamma')
    const stale = anchorFor(2, 'beta-OLD')
    await expect(async () =>
      tool.execute({ file_path: '/ws/a.js', edits: [{ op: 'replace', pos: stale, text: 'BETA' }] }, exec),
    ).rejects.toThrow(/>>> mismatch/)
    expect(files.get('/ws/a.js')).toBe('alpha\nbeta\ngamma')
  })

  it('rejects missing files and malformed anchors', async () => {
    const { tool, exec } = harness('x')
    await expect(async () => tool.execute({ file_path: '/ws/absent.js', edits: [{ op: 'replace', pos: '1#VK', text: '' }] }, exec))
      .rejects.toThrow(/no regular file/)
    await expect(async () => tool.execute({ file_path: '/ws/a.js', edits: [{ op: 'replace', pos: 'bad', text: '' }] }, exec))
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
  it('advertises the escalation fields only under a confining backend', () => {
    const plain = harness('x')
    expect(plain.tool.parameters.properties.sandbox_permissions).toBeUndefined()
    expect(plain.tool.parameters.properties.justification).toBeUndefined()
    const confined = harness('x', { sandboxMode: 'workspace-write' })
    expect(confined.tool.parameters.properties.sandbox_permissions).toEqual({
      type: 'string',
      enum: ['workspace-write', 'danger-full-access'],
      description: 'The narrowest wider sandbox mode for a one-shot retry of the exact operation the sandbox just denied; the retry asks the user for approval.',
    })
    expect(confined.tool.parameters.properties.justification.type).toBe('string')
    expect(confined.tool.parameters.required).toEqual(['file_path', 'edits'])
  })

  it('grants a strictly wider one-shot policy through the approval service', async () => {
    const { tool, exec, injected, writes, files } = harness('alpha\nbeta\ngamma', {
      sandboxMode: 'workspace-write',
      services: { approval: { request: async (req) => { return req.callId === 'call-1' ? 'allowed-once' : 'rejected' } } },
    })
    const standing = { mode: 'workspace-write', workspaceRoot: '/ws', sessionId: 's1' }
    injected[0].cb({ sandboxPolicy: { resolve: () => standing } })
    const anchor = anchorFor(2, 'beta')
    await tool.execute(
      {
        file_path: '/ws/a.js',
        edits: [{ op: 'replace', pos: anchor, text: 'BETA' }],
        sandbox_permissions: 'danger-full-access',
        justification: 'the report must land outside the workspace',
      },
      exec,
    )
    expect(writes).toHaveLength(1)
    expect(writes[0].policy).toEqual({ mode: 'danger-full-access', workspaceRoot: '/ws', sessionId: 's1' })
    expect(files.get('/ws/a.js')).toBe('alpha\nBETA\ngamma')
  })

  it('rejects a malformed escalation pairing before any filesystem work', async () => {
    const { tool, exec, writes } = harness('alpha', { sandboxMode: 'workspace-write' })
    await expect(async () =>
      tool.execute(
        { file_path: '/ws/a.js', edits: [{ op: 'replace', pos: '1#VK', text: 'A' }], sandbox_permissions: 'danger-full-access' },
        exec,
      ),
    ).rejects.toThrow(/sandbox_permissions requires a justification/)
    expect(writes).toHaveLength(0)
  })

  it('fails closed when escalation is requested without a sandbox backend', async () => {
    const { tool, exec } = harness('alpha')
    await expect(async () =>
      tool.execute(
        {
          file_path: '/ws/a.js',
          edits: [{ op: 'replace', pos: '1#VK', text: 'A' }],
          sandbox_permissions: 'workspace-write',
          justification: 'needs it',
        },
        exec,
      ),
    ).rejects.toThrow(/no sandboxing filesystem to escalate/)
  })

  it('maps a sandbox denial to the shared marker plus the escalation hint', async () => {
    const { tool, exec, files } = harness('alpha', {
      sandboxMode: 'workspace-write',
      denyError: { code: 'FS_SANDBOX_DENIED' },
    })
    await expect(async () =>
      tool.execute({ file_path: '/ws/a.js', edits: [{ op: 'replace', pos: anchorFor(1, 'alpha'), text: 'A' }] }, exec),
    ).rejects.toThrow(/\[sandbox: file access denied under unknown mode\]\n\[sandbox: escalation available/)
    expect(files.get('/ws/a.js')).toBe('alpha')
  })

  it('detects the denial by marker text when the code channel is absent', async () => {
    const { tool, exec } = harness('alpha', {
      sandboxMode: 'workspace-write',
      denyError: { message: 'writeText failed: [sandbox: file access denied under workspace-write mode]' },
    })
    await expect(async () =>
      tool.execute({ file_path: '/ws/a.js', edits: [{ op: 'replace', pos: anchorFor(1, 'alpha'), text: 'A' }] }, exec),
    ).rejects.toThrow(/\[sandbox: escalation available/)
  })

  it('passes non-denial write errors through untouched', async () => {
    const { tool, exec } = harness('alpha', {
      sandboxMode: 'workspace-write',
      denyError: { code: 'FS_STALE_VERSION' },
    })
    await expect(async () =>
      tool.execute({ file_path: '/ws/a.js', edits: [{ op: 'replace', pos: anchorFor(1, 'alpha'), text: 'A' }] }, exec),
    ).rejects.toThrow(/file changed on disk/)
  })

  it('registers the single-channel text schema', () => {
    const { tool } = harness('x')
    const items = tool.parameters.properties.edits.items
    expect(items.required).toEqual(['op', 'pos', 'text'])
    expect(items.properties.text.type).toBe('string')
    expect(items.properties.lines).toBeUndefined()
    expect(JSON.stringify(tool.parameters)).not.toContain('oneOf')
  })

  it('teaches exactly one content channel in the description', () => {
    expect(HASH_EDIT_DESCRIPTION).toContain('e.g. "a\\nb"')
    expect(HASH_EDIT_DESCRIPTION).toContain('Invalid-JSON arguments fail the ENTIRE turn')
    expect(HASH_EDIT_DESCRIPTION).toContain("text:'' deletes the range")
    expect(HASH_EDIT_DESCRIPTION).toContain('On a mismatch report, re-read the file and copy the current anchors verbatim before retrying.')
    expect(HASH_EDIT_DESCRIPTION).not.toContain('`lines`')
    expect(HASH_EDIT_DESCRIPTION).not.toContain('lines:[')
    // Pre-change length: 818; cap is 120% (two spec-mandated additions).
    expect(HASH_EDIT_DESCRIPTION.length <= 981).toBe(true)
  })

  it('names the fix on shape errors and keeps the re-read advice on anchor mismatch', async () => {
    const { tool, exec } = harness('alpha')
    await expect(async () =>
      tool.execute({ file_path: '/ws/a.js', edits: [{ op: 'append', pos: anchorFor(1, 'alpha'), text: ['A'] }] }, exec),
    ).rejects.toThrow(/text must be a string.*call again with the corrected shape/)
    await expect(async () =>
      tool.execute({ file_path: '/ws/a.js', edits: { op: 'append', pos: '1#VK', text: 'A' } }, exec),
    ).rejects.toThrow(/edits must be a non-empty array.*call again with the corrected shape/)
    await expect(async () =>
      tool.execute({ file_path: '/ws/a.js', edits: [{ op: 'replace', pos: anchorFor(1, 'alpha-OLD'), text: 'A' }] }, exec),
    ).rejects.toThrow(/Re-read the file and copy the current anchors/)
  })
})
