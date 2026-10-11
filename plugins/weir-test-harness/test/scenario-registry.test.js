// Registry conformance (design D6): every member carries id/prompt/decide/
// assert of the right types; the id equals its module filename; the id set
// equals the historical 12-scenario list exactly (no scenario can be dropped
// silently); the order matches the former run.mjs SCENARIOS list.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SCENARIOS, byId } from '../src/scenarios/index.js'
import { baseName } from '../src/scenarios/editlock-lsp-rename.js'
import hashlineNegatives from '../src/scenarios/editlock-hashline-negatives.js'

const EXPECTED_ORDER = ['deepwork', 'delegate', 'hashline', 'pressure', 'robash', 'semantic', 'grouped', 'escalate', 'background', 'terminate', 'rehydrate', 'lsp', 'targets', 'editlock', 'worktree', 'capstore']
EXPECTED_ORDER.push('editlock-stop-predispatch', 'editlock-stop-staged', 'editlock-stop-publication', 'editlock-stop-update')
EXPECTED_ORDER.push('jobs-aware-todo')
EXPECTED_ORDER.push('editlock-auto-resume', 'editlock-auto-resume-off')
EXPECTED_ORDER.push('skill-composition-off', 'skill-composition-leak', 'skill-composition-host', 'skill-composition-office', 'skill-composition-migration')
EXPECTED_ORDER.push('apply-transaction')
EXPECTED_ORDER.push('cold-session')
EXPECTED_ORDER.push('lifecycle-inheritance')
EXPECTED_ORDER.push('delegate-preflight')
EXPECTED_ORDER.push('mcp-gateway')
EXPECTED_ORDER.push('preset-defaults')
EXPECTED_ORDER.push('capability-presets-surface')
EXPECTED_ORDER.push('resume-incarnation')
EXPECTED_ORDER.push('worktree-watch')
EXPECTED_ORDER.push('notify-worktree')
EXPECTED_ORDER.push('worktree-auto-approve')
EXPECTED_ORDER.push('child-prompt')
EXPECTED_ORDER.push('editlock-stale-sweep', 'editlock-stale-sweep-off')
EXPECTED_ORDER.push('capability-remote')
EXPECTED_ORDER.push('continuable')
EXPECTED_ORDER.push('editlock-crash-recovery')
EXPECTED_ORDER.push('editlock-cold-view')
EXPECTED_ORDER.push('zombie-lane')
EXPECTED_ORDER.push('lane-resumable')
EXPECTED_ORDER.push('blackboard')
EXPECTED_ORDER.push('blackboard-promotion')
EXPECTED_ORDER.push('editlock-recovery-ux')
EXPECTED_ORDER.push('editlock-binding-reclaim')
EXPECTED_ORDER.push('editlock-delegate-settle')
EXPECTED_ORDER.push('editlock-delegate-resume')
EXPECTED_ORDER.push('blackboard-persistence')
EXPECTED_ORDER.push('preset-delegation-surface')
EXPECTED_ORDER.push('planned-compaction')
EXPECTED_ORDER.push('planned-compaction-busy', 'planned-compaction-wake', 'planned-compaction-cancel', 'planned-compaction-noop', 'planned-compaction-hard')
EXPECTED_ORDER.push('editlock-lsp-rename')
EXPECTED_ORDER.push('editlock-lsp-uncertain')
EXPECTED_ORDER.push('editlock-hashline-negatives')
EXPECTED_ORDER.push('editlock-negotiation')

describe('scenario registry', () => {
  it('holds exactly the registered scenarios, in the historical order (append-only)', () => {
    assert.deepEqual(SCENARIOS.map((s) => s.id), EXPECTED_ORDER)
  })

  it('every member carries id/prompt/decide/assert of the right shape', () => {
    for (const scenario of SCENARIOS) {
      assert.equal(typeof scenario.id, 'string', `entry missing id`)
      assert.ok(scenario.id.length > 0, 'empty scenario id')
      assert.equal(typeof scenario.prompt, 'string', `${scenario.id}: missing prompt`)
      assert.ok(scenario.prompt.length > 0, `${scenario.id}: empty prompt`)
      assert.equal(typeof scenario.decide, 'function', `${scenario.id}: missing decide`)
      assert.equal(typeof scenario.assert, 'function', `${scenario.id}: missing assert`)
      if (scenario.observe !== undefined) assert.equal(typeof scenario.observe, 'function', `${scenario.id}: observe must be a function`)
      if (scenario.run !== undefined) assert.equal(typeof scenario.run, 'function', `${scenario.id}: run must be a function`)
    }
  })

  it('id === module filename for every scenario on disk', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url))
    const files = readdirSync(join(dir, '..', 'src', 'scenarios'))
      .filter((file) => file.endsWith('.js') && file !== 'index.js')
      .flatMap((file) => file === 'skill-composition.js' ? ['skill-composition-off', 'skill-composition-leak', 'skill-composition-host', 'skill-composition-office', 'skill-composition-migration'] : [file.slice(0, -3)])
      .sort()
    assert.deepEqual(files.sort(), SCENARIOS.map((s) => s.id).sort())
  })

  it('byId resolves every member and returns undefined for unknown ids', () => {
    for (const scenario of SCENARIOS) {
      assert.equal(byId(scenario.id), scenario)
    }
    assert.equal(byId('no-such-scenario'), undefined)
  })

  // Windows regression seam: the editlock-lsp-rename assert compares authority
  // resourceIds through this helper, because the authority stores native
  // absolute paths (CI run 38109746915: 'D:\\a\\_temp\\...\\probe.ts' failed
  // the former endsWith('/probe.ts') forms on windows-latest while
  // macOS/Ubuntu passed).
  it('editlock-lsp-rename compares resourceIds separator-portably, without suffix false matches', () => {
    const win = 'D:\\a\\_temp\\it-lsp-rename\\ws\\'
    assert.equal(baseName(`${win}probe.ts`), 'probe.ts')
    assert.equal(baseName(`${win}probe-other.ts`), 'probe-other.ts')
    assert.equal(baseName('/tmp/it-lsp-rename/ws/probe.ts'), 'probe.ts')
    // 'probe-other.ts' must never satisfy a probe.ts assertion (the bare-suffix
    // endsWith form would have matched it once the leading '/' was dropped).
    assert.notEqual(baseName(`${win}probe-other.ts`), 'probe.ts')
    assert.notEqual(baseName(`${win}probe.ts`), 'probe-other.ts')
    assert.equal(baseName(undefined), null)
    assert.equal(baseName(null), null)
  })

  // Scenarios whose preconditions need driver-side work: rehydrate boots twice
  // with one session id; worktree initializes a git repository in the workspace.
  const RUN_OVERRIDE = ['blackboard-persistence', 'rehydrate', 'worktree', 'editlock-stop-predispatch', 'editlock-stop-staged', 'editlock-stop-publication', 'editlock-stop-update', 'editlock-auto-resume', 'editlock-auto-resume-off', 'editlock-stale-sweep', 'editlock-stale-sweep-off', 'cold-session', 'lifecycle-inheritance', 'mcp-gateway', 'preset-defaults', 'capability-presets-surface', 'resume-incarnation', 'worktree-watch', 'notify-worktree', 'worktree-auto-approve', 'capability-remote', 'editlock-crash-recovery', 'editlock-cold-view', 'zombie-lane', 'lane-resumable', 'editlock-recovery-ux']
  RUN_OVERRIDE.push('preset-delegation-surface')
  RUN_OVERRIDE.push('editlock-lsp-rename', 'editlock-lsp-uncertain')

  it('exactly the declared scenarios carry a run override', () => {
    for (const scenario of SCENARIOS) {
      if (RUN_OVERRIDE.includes(scenario.id)) assert.equal(typeof scenario.run, 'function', `${scenario.id} must override run`)
      else assert.equal(scenario.run, undefined, `${scenario.id} unexpectedly overrides run`)
    }
  })
  it('lock-on sandbox case targets an in-domain file through the narrowed real session policy', () => {
    assert.deepEqual(hashlineNegatives.env, { WEIR_IT_EDIT_LOCK: '1', WEIR_IT_SANDBOX_NARROW: '1' })
    const prior = [hashlineNegatives.prompt, 'Created file: /ws/narrow/cas-target.txt', 'hash_edit applied',
      'Created file: /ws/narrow/mismatch.txt', 'hash_edit refused the call', 'Released',
      'no regular file', 'outside management domain'].join('\n')
    const emit = (history) => [...hashlineNegatives.decide({ messages: [] }, { transcript: history })]
    const first = emit(prior)
    const readCall = first.find((chunk) => chunk.type === 'block-end').block
    assert.equal(readCall.name, 'read')
    const target = JSON.parse(readCall.arguments).file_path
    assert.equal(basename(target), 'sandbox-target.txt')
    assert.equal(basename(dirname(target)), hashlineNegatives.id)
    const after = emit(prior + '\n[sandbox: file access denied under workspace-write mode]')
    assert.equal(after.find((chunk) => chunk.type === 'block-end').block.name, 'write')
    const driver = readFileSync(fileURLToPath(new URL('../run.mjs', import.meta.url)), 'utf8')
    assert.match(driver, /env\.WEIR_IT_LSP_UNCERTAIN === '1' \? join\(WS, 'editlock-lsp-uncertain'\) : \(env\.WEIR_IT_SANDBOX_NARROW === '1' \? join\(WS, 'editlock-hashline-negatives', 'narrow'\) : WS\)/)
    const patch = readFileSync(fileURLToPath(new URL('../cordis.patch.yml', import.meta.url)), 'utf8')
    assert.match(patch, /root: !!js "process\.env\.WEIR_IT_LSP_UNCERTAIN === '1' \? process\.env\.WEIR_IT_ROOT \+ '\/ws\/editlock-lsp-uncertain' : \(process\.env\.WEIR_IT_SANDBOX_NARROW === '1' \? process\.env\.WEIR_IT_ROOT \+ '\/ws\/editlock-hashline-negatives'/)
    assert.match(patch, /authorityDirectory: !!js "process\.env\.WEIR_IT_LSP_UNCERTAIN === '1' \? process\.env\.WEIR_IT_ROOT \+ '\/ws\/editlock-lsp-uncertain\/\.weir\/edit-lock' : \(process\.env\.WEIR_IT_SANDBOX_NARROW === '1' \? process\.env\.WEIR_IT_ROOT \+ '\/ws\/editlock-hashline-negatives\/\.weir\/edit-lock'/)
  })
})
