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
    const summaryBox = findAll(tree, (node) => node['data-weir-import-summary'] !== undefined)
    expect(summaryBox).toHaveLength(1)
    expect(findAll(tree, (node) => node.children === 'Import summary — review before anything is written')).toHaveLength(1)
    expect(findAll(tree, (node) => node.__type === 'span' && node.children === 'alpha')).toHaveLength(1)
    expect(findAll(tree, (node) => node.__type === 'span' && node.children === 'beta')).toHaveLength(1)
    expect(findAll(tree, (node) => node.__type === 'span' && node.children === '3 file(s)')).toHaveLength(1)
    expect(findAll(tree, (node) => node.__type === 'span' && node.children === 'name collision')).toHaveLength(1)
    expect(findAll(tree, (node) => node.__type === 'span' && node.children === '/user/skills')).toHaveLength(1)
    expect(findAll(tree, (node) => node.children === 'Unresolved refs — not installed:')).toHaveLength(1)
    expect(findAll(tree, (node) => node.__type === 'div' && node.children === 'remote-x')).toHaveLength(1)
    const decision = findAll(tree, (node) => node['data-weir-import-decision'] !== undefined)
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
    expect(findAll(tree, (node) => node['data-weir-import-result'] !== undefined)).toHaveLength(1)
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
    expect(findAll(tree, (node) => node['data-weir-import-summary'] !== undefined)).toHaveLength(1)
    expect(findAll(tree, (node) => node['data-weir-import-decision'] !== undefined)).toHaveLength(0)

    findButton(tree, 'Confirm import').onClick()
    await flush()
    reactStub.begin()
    tree = view(props)
    expect(calls.presetImport[1]).toEqual({ document: V2_DOC, scope: 'workspace', onCollision: 'cancel' })
    expect(findAll(tree, (node) => node['data-weir-import-result'] !== undefined)).toHaveLength(1)
  })

  it('cancel after the summary writes nothing beyond the dry-run and returns to the input surface', async () => {
    const { view, reactStub } = await loadView()
    const dryRun = { status: 'dry-run', install: [{ targetScope: 'project', name: 'alpha', fileCount: 3, targetRoot: '/ws/skills' }], collisions: [], unresolved: [] }
    const { calls, props } = makeProps({ importResponses: [dryRun] })

    let tree = await submitDocument(view, reactStub, props, V2_DOC)
    const summaryBox = findAll(tree, (node) => node['data-weir-import-summary'] !== undefined)[0]
    findButton(summaryBox.children, 'Cancel').onClick()
    await flush()
    reactStub.begin()
    tree = view(props)
    expect(calls.presetImport).toHaveLength(1) // only the dry-run ever ran
    expect(findAll(tree, (node) => node['data-weir-import-summary'] !== undefined)).toHaveLength(0)
    // Back on the input surface with the pasted text kept for editing.
    expect(findAll(tree, (node) => node.__type === 'textarea' && node.value === JSON.stringify(V2_DOC))).toHaveLength(1)
  })

  it('create collision confirms the exact named ID and revision rather than creating a second ID', async () => {
    const { view, reactStub } = await loadView()
    const calls = []
    const { props } = makeProps({ presets: [{ scope: 'workspace', presetId: 'old-1', name: 'Shared', revision: 3, counts: {} }] })
    props.presetSave = async (sid, spec) => { calls.push(spec); return calls.length === 1 ? { status: 'name-conflict', with: 'old-1', withRevision: 3 } : { status: 'edited', presetId: 'old-1', revision: 4 } }
    reactStub.begin(); view(props); await flush()
    reactStub.begin(); let tree = view(props)
    findButton(tree, 'Save as preset…').onClick()
    reactStub.begin(); tree = view(props)
    findAll(tree, node => node.__type === 'input' && node.placeholder === 'Preset name')[0].onChange({ target: { value: 'Shared' } })
    reactStub.begin(); tree = view(props)
    findButton(tree, 'Save preset').onClick(); await flush()
    reactStub.begin(); tree = view(props)
    expect(findAll(tree, node => String(node.children).includes('old-1'))).toHaveLength(1)
    findButton(tree, 'Replace it').onClick(); await flush()
    expect(calls[1]).toEqual({ scope: 'workspace', name: 'Shared', from: 'draft', skills: [], mcpServers: [], unresolvedRefs: [], onNameConflict: 'replace', replaceTarget: { presetId: 'old-1', expectedRevision: 3, name: 'Shared' } })
  })

  it('pins Save-as applied create and exact replacement; blocks missing or warned proof while draft remains usable', async () => {
    const { view, reactStub } = await loadView()
    const digest = 'a'.repeat(64)
    const calls = []
    const { props } = makeProps()
    props.draft = props.model.draftFromReceipt({ status: 'applied', revision: 0, effective: { skillIdentities: [], mcpServers: [], digest }, warnings: [] })
    props.presetSave = async (sid, spec) => { calls.push(spec); return calls.length === 1 ? { status: 'name-conflict', with: 'old-1', withRevision: 3 } : { status: 'edited', presetId: 'old-1', revision: 4 } }
    reactStub.begin(); view(props); await flush()
    reactStub.begin(); let tree = view(props)
    findButton(tree, 'Save as preset…').onClick()
    reactStub.begin(); tree = view(props)
    findAll(tree, node => node.__type === 'input' && node.placeholder === 'Preset name')[0].onChange({ target: { value: 'Shared' } })
    reactStub.begin(); tree = view(props)
    findAll(tree, node => node.__type === 'select' && node.value === 'draft')[0].onChange({ target: { value: 'applied' } })
    reactStub.begin(); tree = view(props)
    findButton(tree, 'Save preset').onClick(); await flush()
    expect(calls[0]).toEqual({ scope: 'workspace', name: 'Shared', from: 'applied', expectedSelectionRevision: 0, expectedSelectionDigest: digest })
    reactStub.begin(); tree = view(props)
    findButton(tree, 'Replace it').onClick(); await flush()
    expect(calls[1]).toEqual({ scope: 'workspace', name: 'Shared', from: 'applied', expectedSelectionRevision: 0, expectedSelectionDigest: digest, onNameConflict: 'replace', replaceTarget: { presetId: 'old-1', expectedRevision: 3, name: 'Shared' } })
    // No receipt or warnings must prevent BOTH initial Save and replacement, even if invoked directly.
    for (const bad of [{ ...props.draft, appliedDigest: undefined, appliedSourceIssue: 'receipt' }, { ...props.draft, appliedSourceIssue: 'unavailable' }]) {
      reactStub.reset(); props.draft = bad; calls.length = 0
      reactStub.begin(); view(props); await flush()
      reactStub.begin(); tree = view(props); findButton(tree, 'Save as preset…').onClick()
      reactStub.begin(); tree = view(props)
      findAll(tree, node => node.__type === 'input' && node.placeholder === 'Preset name')[0].onChange({ target: { value: 'Shared' } })
      reactStub.begin(); tree = view(props)
      findAll(tree, node => node.__type === 'select' && node.value === 'draft')[0].onChange({ target: { value: 'applied' } })
      reactStub.begin(); tree = view(props)
      expect(findButton(tree, 'Save preset').disabled).toBe(true)
      findButton(tree, 'Save preset').onClick(); await flush()
      expect(calls).toHaveLength(0)
      reactStub.begin(); tree = view(props)
      expect(findAll(tree, node => node.role === 'alert')).toHaveLength(1)
      findAll(tree, node => node.__type === 'select' && node.value === 'applied')[0].onChange({ target: { value: 'draft' } })
      reactStub.begin(); tree = view(props)
      expect(findButton(tree, 'Save preset').disabled).toBe(false)
      findButton(tree, 'Cancel').onClick()
      reactStub.begin(); tree = view(props)
      expect(findButton(tree, 'Save as preset…')).toBeTruthy()
      expect(calls).toHaveLength(0)
    }
  })

  it('shows confirmed import publication failure with actual installed Skill and unconfirmed preset in English and Chinese', async () => {
    for (const chinese of [false, true]) {
      const { view, reactStub } = await loadView()
      const dryRun = { status: 'dry-run', install: [], collisions: [], unresolved: [] }
      const { props } = makeProps({ importResponses: [dryRun, { status: 'preset-unconfirmed', installed: [{ name: 'alpha', targetScope: 'project' }], presetStatus: 'unconfirmed' }] })
      if (chinese) props.t = key => ({ 'capability.presets.importPartial': '已安装的 Skill：{names}；预设状态未确认。检查已安装文件并刷新预设，再决定如何恢复。' })[key] ?? key
      let tree = await submitDocument(view, reactStub, props, V2_DOC)
      findButton(tree, 'Confirm import').onClick(); await flush()
      reactStub.begin(); tree = view(props)
      const alert = findAll(tree, node => node.role === 'alert').map(node => node.children).join(' ')
      expect(alert).toContain('alpha')
      expect(alert).toContain(chinese ? '未确认' : 'unconfirmed')
      expect(alert).toContain(chinese ? '检查' : 'Inspect')
      expect(findAll(tree, node => node.children === 'Imported: 1 Skill(s) installed, 0 MCP binding(s), 0 unresolved ref(s).')).toHaveLength(0)
    }
  })

  // Reads the string literal of `key` from both dictionary blocks of the
  // capability data face (the capability-model chunk carries them now).
  const clientDictionaryValues = (key) => {
    const source = readFileSync(new URL('../lib/client.capability-model.js', import.meta.url), 'utf8')
    return [...source.matchAll(new RegExp(`"${key}": "((?:[^"\\\\]|\\\\.)*)"`, 'g'))].map(match => match[1])
  }

  it('an unconfirmed preset with an empty installed list names no Skill in either locale', async () => {
    // Both locales spell out the no-Skill placeholder — the English template
    // must not leak into the Chinese UI when nothing was reported.
    const noneKnown = clientDictionaryValues('capability.presets.noneKnown')
    expect(noneKnown[0]).toBe('none reported')
    expect(noneKnown[1]).toBe('无已报告项')
    for (const chinese of [false, true]) {
      const { view, reactStub } = await loadView()
      const dryRun = { status: 'dry-run', install: [], collisions: [], unresolved: [] }
      const { props } = makeProps({ importResponses: [dryRun, { status: 'preset-unconfirmed', installed: [], presetStatus: 'unconfirmed' }] })
      // The component's own lookup runs over the registered dictionary: the key
      // is registered (pinned above), so the placeholder comes from it and only
      // the surrounding template falls back to the in-code English text.
      if (chinese) props.t = key => ({
        'capability.presets.importPartial': '已安装的技能：{names}。预设状态尚未确认。请检查已安装文件并刷新预设，再决定如何恢复。',
        'capability.presets.noneKnown': noneKnown[1],
      })[key]
      let tree = await submitDocument(view, reactStub, props, V2_DOC)
      findButton(tree, 'Confirm import').onClick(); await flush()
      reactStub.begin(); tree = view(props)
      const alerts = findAll(tree, node => node.role === 'alert')
      expect(alerts).toHaveLength(1)
      const alert = String(alerts[0].children)
      // The no-Skill wording is spelled out per locale — never the raw key and
      // never the English fallback under a Chinese UI.
      expect(alert).toBe(chinese
        ? '已安装的技能：无已报告项。预设状态尚未确认。请检查已安装文件并刷新预设，再决定如何恢复。'
        : 'Installed Skills: none reported. Preset status is unconfirmed. Inspect the installed files and refresh the preset before deciding how to recover.')
      expect(alert).not.toContain('noneKnown')
      // Under Chinese the alert must not fall back to the English template.
      if (chinese) expect(alert).not.toContain('none reported')
      // An unconfirmed preset is not a failure: the alert must never claim a
      // rollback, and the install-failed surface must not be reused.
      expect(alert).not.toContain('rolled back')
      expect(alert).not.toContain('no preset was created')
      expect(alert).not.toContain('已回滚')
    }
  })

  it('a name-conflict on confirm keeps the summary and retries with onNameConflict replace', async () => {
    const { view, reactStub } = await loadView()
    const dryRun = { status: 'dry-run', install: [{ targetScope: 'project', name: 'alpha', fileCount: 3, targetRoot: '/ws/skills' }], collisions: [], unresolved: [] }
    const nameConflict = { status: 'name-conflict', with: 'pack-legacy', withRevision: 7 }
    const edited = { status: 'edited', presetId: 'pack-legacy', bound: { mcpServers: 0, unresolvedRefs: 0 }, installed: [{ targetScope: 'project', name: 'alpha', target: 'alpha', fileCount: 3, status: 'installed' }], collisions: [], unresolved: [] }
    const { calls, props } = makeProps({ importResponses: [dryRun, nameConflict, edited] })

    let tree = await submitDocument(view, reactStub, props, V2_DOC)
    findButton(tree, 'Confirm import').onClick()
    await flush()
    reactStub.begin()
    tree = view(props)
    // The summary stays up and offers the name-conflict decision row.
    const summaryBox = findAll(tree, (node) => node['data-weir-import-summary'] !== undefined)[0]
    expect(summaryBox).toBeTruthy()
    expect(findAll(summaryBox.children, (node) => node.children === 'Replace preset ID pack-legacy at revision 7 in workspace?')).toHaveLength(1)

    findButton(summaryBox.children, 'Replace it').onClick()
    await flush()
    reactStub.begin()
    tree = view(props)
    expect(calls.presetImport).toHaveLength(3)
    expect(calls.presetImport[2]).toEqual({ document: V2_DOC, scope: 'workspace', onCollision: 'cancel', onNameConflict: 'replace', replaceTarget: { presetId: 'pack-legacy', expectedRevision: 7, name: 'Travel Pack!' } })
    expect(findAll(tree, (node) => node['data-weir-import-result'] !== undefined)).toHaveLength(1)
    expect(findAll(tree, node => node.children === 'Replaced the confirmed preset under ID pack-legacy; no second preset was created.')).toHaveLength(1)
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
    expect(findAll(tree, (node) => node['data-weir-import-result'] !== undefined)).toHaveLength(1)
    expect(findAll(tree, (node) => node.children === 'Installation failed: disk full — rolled back 2 file(s); no preset was created.')).toHaveLength(1)
    expect(calls.fetchPresets).toBe(1) // mount only — nothing was created
  })

  it('a rejected dry-run surfaces the reason in place (zero writes, single call)', async () => {
    const { view, reactStub } = await loadView()
    const { calls, props } = makeProps({ importResponses: [{ status: 'rejected', reason: 'package too large' }] })

    const tree = await submitDocument(view, reactStub, props, V2_DOC)
    expect(calls.presetImport).toHaveLength(1)
    expect(findAll(tree, (node) => node['data-weir-import-summary'] !== undefined)).toHaveLength(0)
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

  it('visual polish: preset rows render as cards with a namespace badge; the delete confirm is a warning strip', async () => {
    const { view, reactStub } = await loadView()
    const { props } = makeProps({
      presets: [
        { scope: 'workspace', presetId: 'pack-01', name: 'Travel Pack!', revision: 1, counts: { skills: 1, mcpServers: 0, unresolvedRefs: 0 } },
        { scope: 'global', presetId: 'g-1', name: 'Shared', revision: 3, counts: { skills: 2, mcpServers: 1, unresolvedRefs: 0 } },
      ],
    })

    reactStub.reset()
    reactStub.begin()
    view(props)
    await flush()
    reactStub.begin()
    let tree = view(props)

    // Preset rows are cards (border + radius-md surface) carrying a tonal
    // namespace badge; the inline actions keep their exact labels.
    const cards = findAll(tree, (node) => node.__type === 'div' && node.style && node.style.borderRadius === 'var(--dsw-radius-md, 8px)' && node.style.padding === '7px 10px')
    expect(cards).toHaveLength(2)
    expect(findAll(tree, (node) => node.__type === 'span' && node.children === 'workspace')).toHaveLength(1)
    expect(findAll(tree, (node) => node.__type === 'span' && node.children === 'global')).toHaveLength(1)
    expect(findButton(tree, 'Load')).toBeTruthy()
    expect(findButton(tree, 'Export')).toBeTruthy()
    const deleteButton = findButton(tree, 'Delete')
    expect(deleteButton).toBeTruthy()
    // The badge is a colored tonal tag (border + tinted background tokens).
    const badge = findAll(tree, (node) => node.__type === 'span' && node.children === 'workspace')[0]
    expect(badge.style.border).toContain('1px solid')
    expect(badge.style.background).toContain('color-mix')

    // The destructive confirm renders as a warning strip (2px left bar on a
    // warn tint), never a plain box.
    deleteButton.onClick()
    reactStub.begin()
    tree = view(props)
    const strips = findAll(tree, (node) => node.style && typeof node.style.borderLeft === 'string' && node.style.borderLeft.startsWith('2px solid var(--dsw-alias-state-warn-primary'))
    expect(strips).toHaveLength(1)
    expect(findAll(strips[0], (node) => node.children === 'Delete preset "Travel Pack!"? This cannot be undone.')).toHaveLength(1)
    expect(findButton(strips[0].children, 'Delete preset')).toBeTruthy()
    expect(findButton(strips[0].children, 'Cancel')).toBeTruthy()

    // The workspace-default section is its own labeled card.
    const defaultTitle = findAll(tree, (node) => node.children === 'Workspace default for new sessions')[0]
    expect(defaultTitle).toBeTruthy()
  })
})

// Public seam: rendered Presets row and the command verbs passed to the chunk.
describe('safe preset row edits', () => {
  const row = { scope: 'workspace', presetId: 'pack-01', name: 'Travel Pack!', revision: 4, counts: { skills: 2, mcpServers: 1, unresolvedRefs: 1 } }
  const flush = () => new Promise(resolve => setTimeout(resolve, 0))
  it('renames the saved row by identity without sending selection or touching the draft; cancel is inert', async () => {
    const reactStub = makeReactStub()
    const { exports } = await loadClientChunk('lib/client.capability-presets.js', requireStubFor(reactStub))
    const calls = []
    const props = { sessionId: 's1', model: loadModel(), draft: { skills: ['a'], mcpServers: ['docs'], applied: { skills: [], mcpServers: [] } },
      fetchPresets: async () => ({ workspaceKey: 'ws', presets: [row] }), defaultGet: async () => ({ status: 'absent' }),
      presetRename: async (sid, spec) => { calls.push({ sid, spec }); return { status: 'edited', presetId: row.presetId, revision: 5 } } }
    reactStub.begin(); exports.CapabilityPresetsView(props); await flush()
    reactStub.begin(); let tree = exports.CapabilityPresetsView(props)
    findButton(tree, 'Rename preset…').onClick()
    reactStub.begin(); tree = exports.CapabilityPresetsView(props)
    expect(findAll(tree, node => node.__type === 'input' && node.value === row.name && node['aria-label'] === 'New preset name')).toHaveLength(1)
    findButton(tree, 'Cancel').onClick()
    expect(calls).toHaveLength(0)
    reactStub.begin(); tree = exports.CapabilityPresetsView(props)
    findButton(tree, 'Rename preset…').onClick()
    reactStub.begin(); tree = exports.CapabilityPresetsView(props)
    findAll(tree, node => node.__type === 'input' && node['aria-label'] === 'New preset name')[0].onChange({ target: { value: 'Revised' } })
    reactStub.begin(); tree = exports.CapabilityPresetsView(props)
    findButton(tree, 'Save new name').onClick(); await flush()
    expect(calls).toEqual([{ sid: 's1', spec: { scope: 'workspace', presetId: 'pack-01', expectedRevision: 4, name: 'Revised' } }])
    expect(props.draft.skills).toEqual(['a'])
  })
  it('re-saves a complete draft snapshot or server-authoritative applied source after explicit confirmation', async () => {
    const reactStub = makeReactStub()
    const { exports } = await loadClientChunk('lib/client.capability-presets.js', requireStubFor(reactStub))
    const calls = []
    const digest = 'b'.repeat(64)
    const model = loadModel()
    const applied = model.draftFromReceipt({ status: 'applied', revision: 8, effective: { skillIdentities: [], mcpServers: [], digest }, warnings: [] })
    const props = { sessionId: 's1', model, draft: { ...applied, skills: ['draft-a', 'draft-b'], mcpServers: ['docs'], unresolvedRefs: ['lost'], applied: { skills: ['live'], mcpServers: [], unresolvedRefs: [] } },
      fetchPresets: async () => ({ workspaceKey: 'ws', presets: [row] }), defaultGet: async () => ({ status: 'absent' }),
      presetResave: async (sid, spec) => { calls.push({ sid, spec }); return { status: 'edited', presetId: 'pack-01', revision: 5 } } }
    reactStub.begin(); exports.CapabilityPresetsView(props); await flush()
    reactStub.begin(); let tree = exports.CapabilityPresetsView(props)
    findButton(tree, 'Re-save…').onClick()
    reactStub.begin(); tree = exports.CapabilityPresetsView(props)
    expect(findAll(tree, node => String(node.children).includes('2 Skills · 1 MCP · 1 unresolved'))).toHaveLength(1)
    expect(calls).toHaveLength(0)
    findButton(tree, 'Confirm re-save').onClick(); await flush()
    expect(calls).toEqual([{ sid: 's1', spec: { scope: 'workspace', presetId: 'pack-01', expectedRevision: 4, from: 'draft', skills: ['draft-a', 'draft-b'], mcpServers: ['docs'], unresolvedRefs: ['lost'] } }])
    reactStub.begin(); tree = exports.CapabilityPresetsView(props)
    findButton(tree, 'Re-save…').onClick()
    reactStub.begin(); tree = exports.CapabilityPresetsView(props)
    findAll(tree, node => node.__type === 'select' && node.value === 'draft')[0].onChange({ target: { value: 'applied' } })
    reactStub.begin(); tree = exports.CapabilityPresetsView(props)
    expect(findAll(tree, node => String(node.children).includes('1 Skills · 0 MCP · 0 unresolved'))).toHaveLength(1)
    findButton(tree, 'Confirm re-save').onClick(); await flush()
    expect(calls[1]).toEqual({ sid: 's1', spec: { scope: 'workspace', presetId: 'pack-01', expectedRevision: 4, from: 'applied', expectedSelectionRevision: 8, expectedSelectionDigest: digest } })
    expect(props.draft.skills).toEqual(['draft-a', 'draft-b'])
  })
  it('blocks unprovable applied source but forwards the receipt digest and revision exactly when available', async () => {
    const reactStub = makeReactStub()
    const { exports } = await loadClientChunk('lib/client.capability-presets.js', requireStubFor(reactStub))
    const calls = []
    const digest = 'a'.repeat(64)
    const props = { sessionId: 's1', model: loadModel(), draft: null,
      fetchPresets: async () => ({ workspaceKey: 'ws', presets: [row] }), defaultGet: async () => ({ status: 'absent' }),
      presetResave: async (sid, spec) => { calls.push({ sid, spec }); return { status: 'edited', presetId: row.presetId, revision: 5 } } }
    const receipt = (proof, warnings = []) => ({ status: 'applied', revision: 0, effective: { skillIdentities: [], mcpServers: [], ...(proof ? { digest: proof } : {}) }, warnings })
    props.draft = props.model.draftFromReceipt(receipt(null))
    reactStub.begin(); exports.CapabilityPresetsView(props); await flush()
    reactStub.begin(); let tree = exports.CapabilityPresetsView(props)
    findButton(tree, 'Re-save…').onClick()
    reactStub.begin(); tree = exports.CapabilityPresetsView(props)
    findAll(tree, node => node.__type === 'select' && node.value === 'draft')[0].onChange({ target: { value: 'applied' } })
    reactStub.begin(); tree = exports.CapabilityPresetsView(props)
    expect(findButton(tree, 'Confirm re-save').disabled).toBe(true)
    expect(findAll(tree, node => node.role === 'alert' && String(node.children).includes('receipt'))).toHaveLength(1)
    findButton(tree, 'Confirm re-save').onClick(); await flush()
    expect(calls).toHaveLength(0)
    props.draft = props.model.draftFromReceipt(receipt(digest, ['fixture-a-unavailable']))
    reactStub.begin(); tree = exports.CapabilityPresetsView(props)
    expect(findButton(tree, 'Confirm re-save').disabled).toBe(true)
    expect(findAll(tree, node => node.role === 'alert' && String(node.children).includes('unavailable'))).toHaveLength(1)
    findButton(tree, 'Confirm re-save').onClick(); await flush()
    expect(calls).toHaveLength(0)
    props.draft = props.model.draftFromReceipt(receipt(digest))
    reactStub.begin(); tree = exports.CapabilityPresetsView(props)
    expect(findButton(tree, 'Confirm re-save').disabled).toBe(false)
    findButton(tree, 'Confirm re-save').onClick(); await flush()
    expect(calls).toEqual([{ sid: 's1', spec: { scope: 'workspace', presetId: row.presetId, expectedRevision: 4, from: 'applied', expectedSelectionRevision: 0, expectedSelectionDigest: digest } }])
  })
  it('names an unavailable server source without claiming a successful save or retrying', async () => {
    const reactStub = makeReactStub()
    const { exports } = await loadClientChunk('lib/client.capability-presets.js', requireStubFor(reactStub))
    const calls = []
    const props = { sessionId: 's1', model: loadModel(), draft: loadModel().draftFromReceipt({ status: 'applied', revision: 0, effective: { skillIdentities: [], mcpServers: [], digest: 'd'.repeat(64) }, warnings: [] }),
      fetchPresets: async () => ({ workspaceKey: 'ws', presets: [row] }), defaultGet: async () => ({ status: 'absent' }),
      presetLoad: async () => ({ status: 'ok', revision: 4 }),
      presetResave: async (sid, spec) => { calls.push(spec); return { status: 'source-unavailable', missing: ['gone-skill'] } } }
    reactStub.begin(); exports.CapabilityPresetsView(props); await flush()
    reactStub.begin(); let tree = exports.CapabilityPresetsView(props)
    findButton(tree, 'Re-save…').onClick()
    reactStub.begin(); tree = exports.CapabilityPresetsView(props)
    findAll(tree, node => node.__type === 'select' && node.value === 'draft')[0].onChange({ target: { value: 'applied' } })
    reactStub.begin(); tree = exports.CapabilityPresetsView(props)
    findButton(tree, 'Confirm re-save').onClick(); await flush(); await flush()
    reactStub.begin(); tree = exports.CapabilityPresetsView(props)
    expect(calls).toHaveLength(1)
    expect(findAll(tree, node => node.role === 'status' && String(node.children).includes('gone-skill'))).toHaveLength(1)
    expect(findButton(tree, 'Confirm re-save').disabled).toBe(true)
    expect(findAll(tree, node => String(node.children).includes('Preset re-saved'))).toHaveLength(0)
  })
  it('locks a failed edit until re-opened and announces the exact recovery; tombstones never stage', async () => {
    const reactStub = makeReactStub()
    const { exports } = await loadClientChunk('lib/client.capability-presets.js', requireStubFor(reactStub))
    const calls = []
    const staged = []
    const props = { sessionId: 's1', model: loadModel(), draft: { skills: [], mcpServers: [], unresolvedRefs: [], applied: { skills: [], mcpServers: [] }, revision: 2 },
      fetchPresets: async () => ({ workspaceKey: 'ws', presets: [row] }), defaultGet: async () => ({ status: 'absent' }),
      presetRename: async () => { calls.push('rename'); return { status: 'locked' } },
      presetLoad: async () => ({ status: 'ok', document: { deleted: true, selection: { skills: [], mcpServers: [], unresolvedRefs: [] } } }), stagePreset: doc => staged.push(doc) }
    reactStub.begin(); exports.CapabilityPresetsView(props); await flush()
    reactStub.begin(); let tree = exports.CapabilityPresetsView(props)
    findButton(tree, 'Rename preset…').onClick()
    reactStub.begin(); tree = exports.CapabilityPresetsView(props)
    findButton(tree, 'Save new name').onClick(); await flush()
    reactStub.begin(); tree = exports.CapabilityPresetsView(props)
    expect(findButton(tree, 'Save new name').disabled).toBe(true)
    expect(findAll(tree, node => node.role === 'alert' && String(node.children).includes('busy'))).toHaveLength(1)
    findButton(tree, 'Save new name').onClick()
    expect(calls).toHaveLength(1)
    const input = findAll(tree, node => node['aria-label'] === 'New preset name')[0]
    input.onKeyDown({ key: 'Escape' })
    reactStub.begin(); tree = exports.CapabilityPresetsView(props)
    findButton(tree, 'Load').onClick(); await flush()
    expect(staged).toHaveLength(0)
  })
})
