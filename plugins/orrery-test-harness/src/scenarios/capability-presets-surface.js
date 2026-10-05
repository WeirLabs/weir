// Scenario: capability-presets-surface — capability-manager-ux tasks 5.1/6.5.
// Drives the SHIPPED /capabilities command surface through one boot: preset
// verbs round trip, name-conflict zero-write, defaults round trip, apply
// convergence, and the v2 package flow (export → renamed dry-run/confirmed
// import with file-landing evidence → collision cancel → collision replace).
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, lastOfRole, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'capability-presets-surface'
const prompt = 'capability-presets-surface-probe'

const WS = join(IT_ROOT, 'ws')
const HOME = join(IT_ROOT, 'home')
const PROJ_SKILL_2 = join(WS, '.dsh', 'skills', 'pack-proj-2', 'SKILL.md')
const USER_SKILL_2 = join(HOME, 'skills', 'pack-local-2', 'SKILL.md')
const PROJ_SKILL = join(WS, '.dsh', 'skills', 'pack-proj', 'SKILL.md')
const USER_SKILL = join(WS, 'skill-roots', 'pack-local', 'SKILL.md')


const cap = (line, marker) => toolCallChunks('surface_probe', { op: 'cap', line, _marker: marker })

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const lastTool = lastOfRole(options, 'tool')

  if (lastTool.includes('SURFACE_PROBE error')) return textChunks(`probe halted: ${lastTool.slice(0, 300)}`)
  if (!history.includes('done save-travel')) return toolCallChunks('surface_probe', { op: 'saveTravel', _marker: 'save-travel' })
  if (!history.includes('done list-1')) return toolCallChunks('surface_probe', { op: 'presetsSummary', _marker: 'list-1' })
  if (!history.includes('done load-travel')) return cap(`preset-load ${JSON.stringify({ scope: 'global', presetId: 'travel' })}`, 'load-travel')
  if (!history.includes('done save-conflict')) {
    return cap(`preset-save ${JSON.stringify({ scope: 'global', presetId: 'travel-b', name: 'Travel', from: 'draft', skills: [], mcpServers: [] })}`, 'save-conflict')
  }
  if (!history.includes('done list-2')) return toolCallChunks('surface_probe', { op: 'presetsSummary', _marker: 'list-2' })
  if (!history.includes('done def-save')) return cap(`default-save ${JSON.stringify({ from: 'draft', skills: [], mcpServers: [] })}`, 'def-save')
  if (!history.includes('done def-get')) return cap('default-get', 'def-get')
  if (!history.includes('done def-clear')) return cap(`default-clear ${JSON.stringify({})}`, 'def-clear')
  if (!history.includes('done def-get-2')) return cap('default-get', 'def-get-2')
  if (!history.includes('done receipt-1')) return toolCallChunks('surface_probe', { op: 'receiptSummary', _marker: 'receipt-1' })
  if (!history.includes('done apply-a')) {
    const revision = Number(/"revision":(\d+)/.exec(lastTool)?.[1] ?? 0)
    return cap(`apply ${JSON.stringify({ requestId: 'it-apply-1', expectedRevision: revision, skills: ['fixture-a'], mcpServers: [] })}`, 'apply-a')
  }
  if (!history.includes('done receipt-2')) return toolCallChunks('surface_probe', { op: 'receiptSummary', _marker: 'receipt-2' })
  if (!history.includes('done export-pack')) return toolCallChunks('surface_probe', { op: 'exportPack', scope: 'global', presetId: 'travel', out: 'travel-pack.json', _marker: 'export-pack' })
  if (!history.includes('done craft-2')) {
    return toolCallChunks('surface_probe', { op: 'craftRename', path: 'travel-pack.json', out: 'travel-pack-2.json', renames: { 'pack-proj': 'pack-proj-2', 'pack-local': 'pack-local-2' }, name: 'Travel 2', _marker: 'craft-2' })
  }
  if (!history.includes('done dry-2')) return toolCallChunks('surface_probe', { op: 'importPack', path: 'travel-pack-2.json', scope: 'global', presetId: 'travel-2', name: 'Travel 2', dryRun: true, _marker: 'dry-2' })
  if (!history.includes('done files-pre')) {
    return toolCallChunks('surface_probe', { op: 'fileState', checks: [{ key: 'proj2', path: PROJ_SKILL_2 }, { key: 'user2', path: USER_SKILL_2 }], _marker: 'files-pre' })
  }
  if (!history.includes('done import-2')) return toolCallChunks('surface_probe', { op: 'importPack', path: 'travel-pack-2.json', scope: 'global', presetId: 'travel-2', name: 'Travel 2', _marker: 'import-2' })
  if (!history.includes('done files-post')) {
    return toolCallChunks('surface_probe', { op: 'fileState', checks: [{ key: 'proj2', path: PROJ_SKILL_2, text: 'CONTENT_PROJ' }, { key: 'user2', path: USER_SKILL_2, text: 'CONTENT_LOCAL' }], _marker: 'files-post' })
  }
  if (!history.includes('done receipt-3')) return toolCallChunks('surface_probe', { op: 'receiptSummary', _marker: 'receipt-3' })
  if (!history.includes('done dry-orig')) return toolCallChunks('surface_probe', { op: 'importPack', path: 'travel-pack.json', scope: 'global', presetId: 'travel-copy', name: 'Travel Copy', dryRun: true, _marker: 'dry-orig' })
  if (!history.includes('done import-cancel')) return toolCallChunks('surface_probe', { op: 'importPack', path: 'travel-pack.json', scope: 'global', presetId: 'travel-copy', name: 'Travel Copy', _marker: 'import-cancel' })
  if (!history.includes('done files-orig')) {
    return toolCallChunks('surface_probe', { op: 'fileState', checks: [{ key: 'projOrig', path: PROJ_SKILL, text: 'CONTENT_PROJ' }, { key: 'localOrig', path: USER_SKILL, text: 'CONTENT_LOCAL' }], _marker: 'files-orig' })
  }
  if (!history.includes('done mutate-2')) return toolCallChunks('surface_probe', { op: 'mutateAppend', path: USER_SKILL_2, text: '\nLOCAL-EDIT\n', _marker: 'mutate-2' })
  if (!history.includes('done import-replace')) {
    return toolCallChunks('surface_probe', { op: 'importPack', path: 'travel-pack-2.json', scope: 'global', presetId: 'travel-3', name: 'Travel 3', onCollision: 'replace', _marker: 'import-replace' })
  }
  if (!history.includes('done files-replaced')) {
    return toolCallChunks('surface_probe', { op: 'fileState', checks: [{ key: 'edited', path: USER_SKILL_2, text: 'LOCAL-EDIT' }, { key: 'restored', path: USER_SKILL_2, text: 'CONTENT_LOCAL' }], _marker: 'files-replaced' })
  }
  return textChunks('capability presets surface done')
}

function observe(obs) {
  const history = obs?.transcript ?? ''
  return {
    saveCreated: history.includes('done save-travel:{"completed":true') && history.includes('"status":"created"'),
    list1: /done list-1:.*"global":1/.test(history),
    loadOk: /done load-travel:.*"status":"ok"/.test(history),
    nameConflict: /done save-conflict:.*"status":"name-conflict"/.test(history),
    list2StillOne: /done list-2:.*"global":1/.test(history),
    defSaved: /done def-save:.*"status":"saved"/.test(history),
    defGetOk: /done def-get:.*"status":"ok"/.test(history),
    defCleared: /done def-clear:.*"status":"cleared"/.test(history),
    defGone: /done def-get-2:.*"cleared":true/.test(history) || /done def-get-2:.*"status":"absent"/.test(history),
    applied: /done apply-a:.*"status":"applied"/.test(history),
    receiptHasA: /done receipt-2:.*"fixture-a"/.test(history),
    packV2: /done export-pack:.*"version":2/.test(history),
    packBundled: /done export-pack:.*project\/pack-proj/.test(history) && /done export-pack:.*user\/pack-local/.test(history),
    dry2: /done dry-2:.*"status":"dry-run"/.test(history),
    dry2NoCollision: /done dry-2:[^\n]*"collisions":\[\]/.test(history),
    preAbsent: /done files-pre:.*"proj2":{"exists":false/.test(history) && /done files-pre:.*"user2":{"exists":false/.test(history),
    import2Created: /done import-2:.*"status":"created"/.test(history),
    postPresent: /done files-post:.*"proj2":{"exists":true,"hasMarker":true}/.test(history) && /done files-post:.*"user2":{"exists":true,"hasMarker":true}/.test(history),
    receiptStable: /done receipt-3:.*"fixture-a"/.test(history) && !/done receipt-3:[^\n]*pack-/.test(history),
    dryOrigCollision: /done dry-orig:.*"collisions":\[{/.test(history),
    cancelReported: /done import-cancel:.*"collisions":\[{/.test(history),
    origIntact: /done files-orig:.*"projOrig":{"exists":true,"hasMarker":true}/.test(history) && /done files-orig:.*"localOrig":{"exists":true,"hasMarker":true}/.test(history),
    replaced: /done files-replaced:.*"edited":{"exists":true,"hasMarker":false}/.test(history) && /done files-replaced:.*"restored":{"exists":true,"hasMarker":true}/.test(history),
    halted: history.includes('probe halted'),
  }
}

/** Single-boot runner: clean capability state and pack fixtures, then drive. */
async function run(ctx) {
  const caps = join(ctx.IT_ROOT, 'home', 'orrery', 'profiles', 'orrery-it', 'capabilities')
  rmSync(join(caps, 'sessions'), { recursive: true, force: true })
  rmSync(join(caps, 'presets'), { recursive: true, force: true })
  rmSync(join(caps, 'workspaces'), { recursive: true, force: true })
  rmSync(join(ctx.IT_ROOT, 'ws', '.git'), { recursive: true, force: true })
  rmSync(join(ctx.IT_ROOT, 'ws', '.dsh'), { recursive: true, force: true })
  rmSync(join(ctx.IT_ROOT, 'ws', 'skill-roots', 'pack-local'), { recursive: true, force: true })
  rmSync(join(ctx.IT_ROOT, 'home', 'skills'), { recursive: true, force: true })
  rmSync(join(ctx.IT_ROOT, 'ws', 'travel-pack.json'), { force: true })
  rmSync(join(ctx.IT_ROOT, 'ws', 'travel-pack-2.json'), { force: true })
  // Fixtures must exist BEFORE the boot: the selection provider enumerates at
  // session start; anything written later is invisible to apply/pack.
  const writeSkill = (root, name, marker) => {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Surface fixture ${name}\n---\nCONTENT_${marker}\n`)
  }
  mkdirSync(join(ctx.IT_ROOT, 'ws', '.git'), { recursive: true })
  writeSkill(join(ctx.IT_ROOT, 'ws', '.dsh', 'skills'), 'pack-proj', 'PROJ')
  writeSkill(join(ctx.IT_ROOT, 'ws', 'skill-roots'), 'pack-local', 'LOCAL')
  writeSkill(join(ctx.IT_ROOT, 'ws', 'skill-roots'), 'fixture-a', 'A')
  const trace = join(ctx.IT_ROOT, `trace-${id}.jsonl`)
  const boot = await ctx.spawnHeadless(['orrery-it', prompt], ctx.scenarioEnv(id, trace, { ORRERY_IT_PRESET_SURFACE: '1', DSH_AGENTS_HOME: join(ctx.IT_ROOT, 'agents-home') }))
  // The .git marker is this scenario's project-root pin ONLY — leaving it
  // behind breaks the following scenarios' workspace-repo containment check.
  rmSync(join(ctx.IT_ROOT, 'ws', '.git'), { recursive: true, force: true })
  return { scenario: id, trace, code: boot.code, stdout: boot.stdout, stderr: boot.stderr }
}

function assert(run) {
  const final = run.requests.at(-1) ?? {}
  const any = flag => run.requests.some(r => r[flag])
  run.check('the flow completed (never halted)', run.stdout.includes('capability presets surface done') && !any('halted'), run.stdout.slice(-300))
  run.check('preset-save created the travel preset', any('saveCreated'), '')
  run.check('presets listed exactly the one global preset', any('list1'), '')
  run.check('preset-load returned the document', any('loadOk'), '')
  run.check('a colliding display name reported name-conflict', any('nameConflict'), '')
  run.check('the unconfirmed conflict wrote nothing (still one global preset)', any('list2StillOne'), '')
  run.check('workspace default saved/read/cleared round trip', any('defSaved') && any('defGetOk') && any('defCleared') && any('defGone'), '')
  run.check('apply of fixture-a converged into the receipt', any('applied') && any('receiptHasA'), '')
  run.check('export produced a v2 package with both bundled skills by origin', any('packV2') && any('packBundled'), '')
  run.check('dry-run import summarized with zero collisions for renamed skills', any('dry2') && any('dry2NoCollision'), '')
  run.check('dry-run wrote nothing to either target root', any('preAbsent'), '')
  run.check('confirmed import created the preset and installed both bundled skills', any('import2Created') && any('postPresent'), '')
  run.check('installed skills were never auto-enabled (receipt stable)', any('receiptStable'), JSON.stringify(final).slice(0, 200))
  run.check('the original-name import dry-run flagged both collisions', any('dryOrigCollision'), '')
  run.check('cancel without a collision decision wrote nothing (originals intact)', any('cancelReported') && any('origIntact'), '')
  run.check('replace with an explicit decision overwrote the local edit', any('replaced'), '')
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, run, assert, env: { ORRERY_IT_PRESET_SURFACE: '1' } }
