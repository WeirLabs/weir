// client.capability-presets.js chunk test (task 6.4/7.2): the version-2
// package export/import surface under the react-stub pattern.
//  - export offers the v2 package as a downloadable .json (Blob + anchor,
//    filename from the preset name) and keeps the read-only viewer/copy;
//  - import is two-phase for v2 packages: the client ALWAYS dry-runs first,
//    renders the summary (install rows, collisions, unresolved refs), and the
//    explicit confirm carries the collision decision — v1 documents keep the
//    single-step path;
//  - every verb payload is asserted exactly.
import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'
import vm from 'node:vm'
import { readFileSync } from 'node:fs'

function loadModel() {
  const source = readFileSync(new URL('../lib/client.capability-model.js', import.meta.url), 'utf8')
  const loaded = {}
  const sandbox = { __ModuleLoader__: { load: ({ factory }) => { loaded.exports = factory(() => { throw new Error('zero-dependency chunk') }) } } }
  sandbox.window = sandbox
  vm.createContext(sandbox)
  vm.runInContext(source, sandbox)
  return Object.fromEntries(Object.entries(loaded.exports).map(([key, fn]) => [key, (...args) => JSON.parse(JSON.stringify(fn(...args)))]))
}

// Hook-state-preserving react stub. The effect runs on the FIRST render only
// (mount semantics — the chunk's effect deps are the stable session id).
function makeReactStub() {
  const reactState = []
  let hookCursor = 0
  return {
    reset() { reactState.length = 0 },
    begin() { hookCursor = 0 },
    useState(initial) {
      const at = hookCursor++
      if (!(at in reactState)) reactState[at] = [initial, (next) => { reactState[at][0] = next }]
      return reactState[at]
    },
    useEffect(fn) {
      const at = hookCursor++
      if (!(at in reactState)) reactState[at] = { cleanup: fn() }
      return undefined
    },
    useCallback(fn) { return fn },
    useRef(initial) {
      const at = hookCursor++
      if (!(at in reactState)) reactState[at] = { current: initial }
      return reactState[at]
    },
  }
}

const requireStubFor = (reactStub) => (name) => {
  if (name === 'react') return reactStub
  if (name === 'react/jsx-runtime') return {
    jsx: (type, props) => ({ __type: type, ...(props ?? {}) }),
    jsxs: (type, props) => ({ __type: type, ...(props ?? {}) }),
    Fragment: 'Fragment',
  }
  throw new Error(`unexpected require ${name}`)
}

function findAll(node, pred, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) findAll(child, pred, out)
    return out
  }
  if (pred(node)) out.push(node)
  return findAll(node.children, pred, out)
}
const findButton = (tree, label) => findAll(tree, (node) => node.__type === 'button' && node.children === label)[0]

const V2_DOC = {
  version: 2,
  name: 'Travel Pack!',
  selection: { skills: [{ kind: 'skill', repository: 'org/repo', ref: 'main', name: 'remote-x', targetScope: 'user' }], mcpServers: [], unresolvedRefs: [] },
  builtin: [],
  bundled: [
    { targetScope: 'project', name: 'alpha', files: [{ path: 'SKILL.md', content: '# alpha' }] },
    { targetScope: 'user', name: 'beta', files: [{ path: 'SKILL.md', content: '# beta' }] },
  ],
  warnings: [],
}

describe('client.capability-presets chunk', () => {
  async function loadView() {
    const reactStub = makeReactStub()
    const { exports } = await loadClientChunk('lib/client.capability-presets.js', requireStubFor(reactStub))
    return { view: exports.CapabilityPresetsView, reactStub }
  }

  function makeProps({ importResponses = [], exportResponse = null, presets = [] } = {}) {
    const calls = { presetImport: [], presetExport: [], fetchPresets: 0 }
    const props = {
      sessionId: 's1',
      model: loadModel(),
      t: (key, fallback) => fallback,
      draft: { skills: [], mcpServers: [], applied: { skills: [], mcpServers: [] }, unresolvedRefs: [], revision: 0, dirty: false },
      stagePreset: () => {},
      fetchPresets: async () => { calls.fetchPresets += 1; return { workspaceKey: 'ws', presets } },
      defaultGet: async () => ({ status: 'absent', workspaceKey: 'ws' }),
      presetSave: async () => ({ status: 'created', presetId: 'x', revision: 1 }),
      presetLoad: async () => ({ status: 'ok', document: {} }),
      presetDelete: async () => ({ status: 'deleted', revision: 2 }),
      presetExport: async (sid, spec) => { calls.presetExport.push(spec); return exportResponse },
      presetImport: async (sid, spec) => { calls.presetImport.push(spec); return importResponses[calls.presetImport.length - 1] ?? null },
      defaultSave: async () => ({ status: 'saved', revision: 1 }),
      defaultClear: async () => ({ status: 'cleared', revision: 2 }),
    }
    return { calls, props }
  }

  const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

  // Mount, open the import box, paste the given document and submit it.
  // Returns the tree rendered after the first import response settled.
  async function submitDocument(view, reactStub, props, document) {
    reactStub.reset()
    reactStub.begin()
    view(props)
    await flush()
    reactStub.begin()
    let tree = view(props)
    findButton(tree, 'Import…').onClick()
    reactStub.begin()
    tree = view(props)
    const textarea = findAll(tree, (node) => node.__type === 'textarea' && typeof node.onChange === 'function')[0]
    textarea.onChange({ target: { value: typeof document === 'string' ? document : JSON.stringify(document) } })
    reactStub.begin()
    tree = view(props)
    const submit = findButton(tree, 'Import')
    expect(submit.disabled).toBe(false)
    submit.onClick()
    await flush()
    reactStub.begin()
    return view(props)
  }

  it('v2 import dry-runs FIRST with the exact payload, renders the summary, and the confirm carries the collision decision', async () => {
    const { view, reactStub } = await loadView()
    const dryRun = {
      status: 'dry-run',
      install: [
        { targetScope: 'project', name: 'alpha', fileCount: 3, targetRoot: '/ws/skills', collision: true },
        { targetScope: 'user', name: 'beta', fileCount: 1, targetRoot: '/user/skills' },
      ],
      collisions: [{ targetScope: 'project', name: 'alpha' }],
      unresolved: [{ kind: 'skill', ref: { name: 'remote-x' } }],
    }
    const created = {
      status: 'created',
      presetId: 'travel-pack',
      bound: { mcpServers: 1, unresolvedRefs: 1 },
      installed: [
        { targetScope: 'project', name: 'alpha', target: 'alpha', fileCount: 3, status: 'replace-confirmed' },
        { targetScope: 'user', name: 'beta', target: 'beta', fileCount: 1, status: 'installed' },
      ],
      collisions: [],
      unresolved: [{ kind: 'skill', ref: { name: 'remote-x' } }],
    }
    const { calls, props } = makeProps({ importResponses: [dryRun, created] })

    // Phase one: the dry-run call carries dryRun:true and NO collision decision.
    let tree = await submitDocument(view, reactStub, props, V2_DOC)
    expect(calls.presetImport).toHaveLength(1)
    expect(calls.presetImport[0]).toEqual({ document: V2_DOC, scope: 'workspace', dryRun: true })

    // The summary surface: install rows with scope badges, the collision row
    // highlighted, the unresolved refs section, and the decision control.
    const summaryBox = findAll(tree, (node) => node['data-orrery-import-summary'] !== undefined)
    expect(summaryBox).toHaveLength(1)
    expect(findAll(tree, (node) => node.children === 'Import summary — review before anything is written')).toHaveLength(1)
    expect(findAll(tree, (node) => node.__type === 'span' && node.children === 'alpha')).toHaveLength(1)
    expect(findAll(tree, (node) => node.__type === 'span' && node.children === 'beta')).toHaveLength(1)
    expect(findAll(tree, (node) => node.__type === 'span' && node.children === '3 file(s)')).toHaveLength(1)
    expect(findAll(tree, (node) => node.__type === 'span' && node.children === 'name collision')).toHaveLength(1)
    expect(findAll(tree, (node) => node.__type === 'span' && node.children === '/user/skills')).toHaveLength(1)
    expect(findAll(tree, (node) => node.children === 'Unresolved refs — not installed:')).toHaveLength(1)
    expect(findAll(tree, (node) => node.__type === 'div' && node.children === 'remote-x')).toHaveLength(1)
    const decision = findAll(tree, (node) => node['data-orrery-import-decision'] !== undefined)
    expect(decision).toHaveLength(1)
    expect(decision[0].value).toBe('cancel') // the default decision
    expect(decision[0].children.map((option) => option.value)).toEqual(['cancel', 'replace', 'coexist'])

    // Choose 'replace', then confirm: the exact payload carries onCollision
    // and NO dryRun flag.
    decision[0].onChange({ target: { value: 'replace' } })
    reactStub.begin()
    tree = view(props)
    const confirm = findButton(tree, 'Confirm import')
    expect(confirm.disabled).toBe(false)
    confirm.onClick()
    await flush()
    reactStub.begin()
    tree = view(props)
    expect(calls.presetImport).toHaveLength(2)
    expect(calls.presetImport[1]).toEqual({ document: V2_DOC, scope: 'workspace', onCollision: 'replace' })

    // The result surface: installed rows (final on-disk names + status), the
    // unselected note, and the preset list was refreshed.
    expect(findAll(tree, (node) => node['data-orrery-import-result'] !== undefined)).toHaveLength(1)
    expect(findAll(tree, (node) => node.children === 'Import result')).toHaveLength(1)
    expect(findAll(tree, (node) => node.__type === 'span' && node.children === '3 file(s) · replace-confirmed')).toHaveLength(1)
    expect(findAll(tree, (node) => node.children === 'Installed Skills stay unselected — pick them in the draft and Apply to activate.')).toHaveLength(1)
    expect(findAll(tree, (node) => node.children === 'Imported: 2 Skill(s) installed, 1 MCP binding(s), 1 unresolved ref(s).')).toHaveLength(1)
    expect(calls.fetchPresets).toBe(2) // mount + post-import refresh
  })

  it('shows the collision decision control only when collisions exist; the untouched default sends cancel', async () => {
    const { view, reactStub } = await loadView()
    const dryRun = {
      status: 'dry-run',
      install: [{ targetScope: 'user', name: 'beta', fileCount: 1, targetRoot: '/user/skills' }],
      collisions: [],
      unresolved: [],
    }
    const created = { status: 'created', presetId: 'p', bound: { mcpServers: 0, unresolvedRefs: 0 }, installed: [{ targetScope: 'user', name: 'beta', target: 'beta', fileCount: 1, status: 'installed' }], collisions: [], unresolved: [] }
    const { calls, props } = makeProps({ importResponses: [dryRun, created] })

    let tree = await submitDocument(view, reactStub, props, V2_DOC)
    expect(findAll(tree, (node) => node['data-orrery-import-summary'] !== undefined)).toHaveLength(1)
    expect(findAll(tree, (node) => node['data-orrery-import-decision'] !== undefined)).toHaveLength(0)

    findButton(tree, 'Confirm import').onClick()
    await flush()
    reactStub.begin()
    tree = view(props)
    expect(calls.presetImport[1]).toEqual({ document: V2_DOC, scope: 'workspace', onCollision: 'cancel' })
    expect(findAll(tree, (node) => node['data-orrery-import-result'] !== undefined)).toHaveLength(1)
  })

  it('cancel after the summary writes nothing beyond the dry-run and returns to the input surface', async () => {
    const { view, reactStub } = await loadView()
    const dryRun = { status: 'dry-run', install: [{ targetScope: 'project', name: 'alpha', fileCount: 3, targetRoot: '/ws/skills' }], collisions: [], unresolved: [] }
    const { calls, props } = makeProps({ importResponses: [dryRun] })

    let tree = await submitDocument(view, reactStub, props, V2_DOC)
    const summaryBox = findAll(tree, (node) => node['data-orrery-import-summary'] !== undefined)[0]
    findButton(summaryBox.children, 'Cancel').onClick()
    await flush()
    reactStub.begin()
    tree = view(props)
    expect(calls.presetImport).toHaveLength(1) // only the dry-run ever ran
    expect(findAll(tree, (node) => node['data-orrery-import-summary'] !== undefined)).toHaveLength(0)
    // Back on the input surface with the pasted text kept for editing.
    expect(findAll(tree, (node) => node.__type === 'textarea' && node.value === JSON.stringify(V2_DOC))).toHaveLength(1)
  })

  it('a name-conflict on confirm keeps the summary and retries with onNameConflict replace', async () => {
    const { view, reactStub } = await loadView()
    const dryRun = { status: 'dry-run', install: [{ targetScope: 'project', name: 'alpha', fileCount: 3, targetRoot: '/ws/skills' }], collisions: [], unresolved: [] }
    const nameConflict = { status: 'name-conflict', with: 'Travel Pack!' }
    const created = { status: 'created', presetId: 'travel-pack', bound: { mcpServers: 0, unresolvedRefs: 0 }, installed: [{ targetScope: 'project', name: 'alpha', target: 'alpha', fileCount: 3, status: 'installed' }], collisions: [], unresolved: [] }
    const { calls, props } = makeProps({ importResponses: [dryRun, nameConflict, created] })

    let tree = await submitDocument(view, reactStub, props, V2_DOC)
    findButton(tree, 'Confirm import').onClick()
    await flush()
    reactStub.begin()
    tree = view(props)
    // The summary stays up and offers the name-conflict decision row.
    const summaryBox = findAll(tree, (node) => node['data-orrery-import-summary'] !== undefined)[0]
    expect(summaryBox).toBeTruthy()
    expect(findAll(summaryBox.children, (node) => node.children === 'A preset with this name already exists here.')).toHaveLength(1)

    findButton(summaryBox.children, 'Replace it').onClick()
    await flush()
    reactStub.begin()
    tree = view(props)
    expect(calls.presetImport).toHaveLength(3)
    expect(calls.presetImport[2]).toEqual({ document: V2_DOC, scope: 'workspace', onCollision: 'cancel', onNameConflict: 'replace' })
    expect(findAll(tree, (node) => node['data-orrery-import-result'] !== undefined)).toHaveLength(1)
  })

  it('an install failure renders the rollback note and does not refresh the preset list', async () => {
    const { view, reactStub } = await loadView()
    const dryRun = { status: 'dry-run', install: [{ targetScope: 'project', name: 'alpha', fileCount: 3, targetRoot: '/ws/skills' }], collisions: [], unresolved: [] }
    const failed = { status: 'install-failed', reason: 'disk full', rolledBack: 2 }
    const { calls, props } = makeProps({ importResponses: [dryRun, failed] })

    let tree = await submitDocument(view, reactStub, props, V2_DOC)
    findButton(tree, 'Confirm import').onClick()
    await flush()
    reactStub.begin()
    tree = view(props)
    expect(findAll(tree, (node) => node['data-orrery-import-result'] !== undefined)).toHaveLength(1)
    expect(findAll(tree, (node) => node.children === 'Installation failed: disk full — rolled back 2 file(s); no preset was created.')).toHaveLength(1)
    expect(calls.fetchPresets).toBe(1) // mount only — nothing was created
  })

  it('a rejected dry-run surfaces the reason in place (zero writes, single call)', async () => {
    const { view, reactStub } = await loadView()
    const { calls, props } = makeProps({ importResponses: [{ status: 'rejected', reason: 'package too large' }] })

    const tree = await submitDocument(view, reactStub, props, V2_DOC)
    expect(calls.presetImport).toHaveLength(1)
    expect(findAll(tree, (node) => node['data-orrery-import-summary'] !== undefined)).toHaveLength(0)
    expect(findAll(tree, (node) => node.children === 'Rejected: package too large — nothing was written.')).toHaveLength(1)
  })

  it('v1 documents keep the single-step import: no dryRun field, categorized feedback', async () => {
    const { view, reactStub } = await loadView()
    const v1Doc = { version: 1, name: 'old-doc', selection: { skills: [], mcpServers: [], unresolvedRefs: [] } }
    const { calls, props } = makeProps({ importResponses: [{ status: 'created', presetId: 'old-doc', bound: { mcpServers: 1, unresolvedRefs: 0 } }] })

    const tree = await submitDocument(view, reactStub, props, v1Doc)
    expect(calls.presetImport).toHaveLength(1)
    expect(calls.presetImport[0]).toEqual({ document: v1Doc, scope: 'workspace' })
    // Created closes the box and reports the bound/unresolved counts.
    expect(findAll(tree, (node) => node.__type === 'textarea')).toHaveLength(0)
    expect(findAll(tree, (node) => node.children === 'Imported: 1 MCP binding(s), 0 unresolved ref(s).')).toHaveLength(1)
    expect(calls.fetchPresets).toBe(2)
  })

  it('export downloads the package as a .json file (Blob + anchor, filename from the preset name) and keeps viewer/copy', async () => {
    const { view, reactStub } = await loadView()
    const document = { version: 2, name: 'Travel Pack!', selection: { skills: [], mcpServers: [], unresolvedRefs: [] }, builtin: [], bundled: [], warnings: [] }
    const { calls, props } = makeProps({
      exportResponse: { status: 'ok', format: 'package', document },
      presets: [{ scope: 'workspace', presetId: 'pack-01', name: 'Travel Pack!', revision: 1, counts: { skills: 1, mcpServers: 0, unresolvedRefs: 0 } }],
    })

    reactStub.reset()
    reactStub.begin()
    view(props)
    await flush()
    reactStub.begin()
    let tree = view(props)

    // The default export payload is the package format (no format field sent).
    findButton(tree, 'Export').onClick()
    await flush()
    reactStub.begin()
    tree = view(props)
    expect(calls.presetExport).toEqual([{ scope: 'workspace', presetId: 'pack-01' }])

    // The read-only viewer still renders the pretty-printed package.
    const viewer = findAll(tree, (node) => node.__type === 'textarea' && node.readOnly === true)[0]
    expect(viewer.value).toBe(JSON.stringify(document, null, 2))

    // The download builds a Blob from that exact text and clicks an anchor
    // named after the preset.
    const blobs = []
    const anchors = []
    const revoked = []
    const saved = { Blob: globalThis.Blob, URL: globalThis.URL, document: globalThis.document }
    globalThis.Blob = class {
      constructor(parts, options) { this.parts = parts; this.options = options; blobs.push(this) }
    }
    globalThis.URL = { createObjectURL: () => 'blob:mock-1', revokeObjectURL: (href) => revoked.push(href) }
    globalThis.document = { createElement: (tag) => { const anchor = { tag, clicked: false, click() { this.clicked = true } }; anchors.push(anchor); return anchor } }
    try {
      findButton(tree, 'Download .json').onClick()
      expect(blobs).toHaveLength(1)
      expect(blobs[0].parts).toEqual([viewer.value])
      expect(blobs[0].options).toEqual({ type: 'application/json' })
      expect(anchors).toHaveLength(1)
      expect(anchors[0].tag).toBe('a')
      expect(anchors[0].href).toBe('blob:mock-1')
      expect(anchors[0].download).toBe('travel-pack.json')
      expect(anchors[0].clicked).toBe(true)
      expect(revoked).toEqual(['blob:mock-1'])
    } finally {
      globalThis.Blob = saved.Blob
      globalThis.URL = saved.URL
      globalThis.document = saved.document
    }

    // The viewer/copy path is intact: copy reports Copied even when the
    // clipboard API is absent (best-effort), the download button reports Done.
    reactStub.begin()
    tree = view(props)
    findButton(tree, 'Copy to clipboard').onClick()
    reactStub.begin()
    tree = view(props)
    expect(findButton(tree, 'Copied')).toBeTruthy()
    expect(findButton(tree, 'Downloaded')).toBeTruthy()
  })
})
