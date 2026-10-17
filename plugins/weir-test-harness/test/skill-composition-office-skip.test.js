// Environment-capability skip (openspec test-harness-env-capability-skip,
// design D1–D3): the skill-composition-office scenario probes an OPTIONAL
// environment capability. When the Office candidates are absent from the
// observed inventory the probe records an officeUnavailable marker (D2), the
// scenario assert emits exactly one SKIP with evidence and no checks (D3),
// and the runner counts SKIP in the summary without failing the suite (D1).
// The recorded success fixture must still replay the full assertion matrix
// with zero skips — SKIP only ever happens on a live Office-less run.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OFFICE_CANDIDATES, officeUnavailable } from '../src/office-availability.js'
import { makeVerdicts } from '../src/run-verdict.js'
import { makeRunView } from '../src/run-view.js'
import { byId } from '../src/scenarios/index.js'

const FIXTURES = fileURLToPath(new URL('./fixtures/traces', import.meta.url))
const office = byId('skill-composition-office')

const candidate = (name, provider = 'filesystem') => ({ name, provider, source: 'custom', rank: 300 })

describe('office availability gate (probe branch, D2)', () => {
  it('returns null when every Office candidate is present', () => {
    const inventory = { candidates: [candidate('selected-fixture'), ...OFFICE_CANDIDATES.map((name) => candidate(name, 'dsh-office'))] }
    assert.equal(officeUnavailable(inventory), null)
  })

  it('reports the missing names and the observed provider ids when some are absent', () => {
    const inventory = { candidates: [candidate('selected-fixture'), candidate('office-docx', 'dsh-office')] }
    assert.deepEqual(officeUnavailable(inventory), { missing: ['office-pptx', 'office-xlsx'], providers: ['filesystem', 'dsh-office'] })
  })

  it('reports all three missing with only the actually observed providers when none are present', () => {
    const inventory = { candidates: [candidate('selected-fixture'), candidate('unselected-fixture')] }
    assert.deepEqual(officeUnavailable(inventory), { missing: ['office-docx', 'office-pptx', 'office-xlsx'], providers: ['filesystem'] })
  })

  it('tolerates nameless candidates and dedupes providers in first-seen order', () => {
    const inventory = { candidates: [{ provider: 'filesystem' }, candidate('a', 'filesystem'), candidate('b', 'other'), candidate('c', 'filesystem')] }
    assert.deepEqual(officeUnavailable(inventory), { missing: OFFICE_CANDIDATES, providers: ['filesystem', 'other'] })
  })
})

describe('OFFICE assert with an officeUnavailable report (D3)', () => {
  it('emits exactly one skip carrying the missing/providers evidence, and zero checks', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weir-office-skip-'))
    try {
      const report = {
        mode: 'OFFICE',
        roster: { id: 'weir-it-selection' },
        created: 'weir-it-selection',
        inventory: [candidate('selected-fixture')],
        builtinMigration: { ok: true },
        officeUnavailable: { missing: ['office-docx', 'office-pptx', 'office-xlsx'], providers: ['filesystem'] },
      }
      writeFileSync(join(dir, 'skill-composition-office.json'), JSON.stringify(report, null, 2))
      const checks = []
      const skips = []
      office.assert({ ws: dir, code: 0, stdout: '', stderr: '', check: (label, ok, detail) => checks.push({ label, ok, detail }), skip: (label, detail) => skips.push({ label, detail }) })
      assert.equal(skips.length, 1, 'exactly one SKIP for the scenario')
      assert.equal(checks.length, 0, 'no assertion matrix runs on an unavailable report')
      assert.match(skips[0].detail, /office-docx/)
      assert.match(skips[0].detail, /office-pptx/)
      assert.match(skips[0].detail, /office-xlsx/)
      assert.match(skips[0].detail, /filesystem/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('non-OFFICE modes never take the skip branch, even with a marker present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'weir-office-skip-'))
    try {
      // An OFF report carrying the marker is nonsense; the guard is OFFICE-only
      // so the normal matrix still runs (and fails on the nonsense data).
      writeFileSync(join(dir, 'skill-composition-off.json'), JSON.stringify({ mode: 'OFF', officeUnavailable: { missing: [], providers: [] } }))
      const checks = []
      const skips = []
      byId('skill-composition-off').assert({ ws: dir, code: 0, stdout: '', stderr: '', check: (label, ok, detail) => checks.push({ label, ok, detail }), skip: (label, detail) => skips.push({ label, detail }) })
      assert.equal(skips.length, 0)
      assert.ok(checks.length > 0, 'OFF mode ran its assertion matrix')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('OFFICE success replay fixture (spec: 能力存在时断言矩阵逐字一致)', () => {
  it('replays the full 23-check assertion matrix with zero skips, all green', () => {
    const dir = join(FIXTURES, 'skill-composition-office')
    const meta = JSON.parse(readFileSync(join(dir, 'run.json'), 'utf8'))
    const run = { scenario: 'skill-composition-office', trace: join(dir, 'trace.jsonl'), code: meta.code, stdout: meta.stdout, stderr: meta.stderr, sessionId: meta.sessionId ?? null }
    const checks = []
    const skips = []
    const view = makeRunView(run, { ws: join(dir, 'ws'), check: (label, ok, detail) => checks.push({ label, ok, detail }), skip: (label, detail) => skips.push({ label, detail }) })
    office.assert(view)
    assert.equal(skips.length, 0, 'a recorded success run must never replay as SKIP')
    assert.deepEqual(checks.map((entry) => entry.label), [
      'real preset agents.create succeeds',
      'first-run builtin migration check passes on the real bundle',
      'all 10 builtin skills keep the pre-migration name/source/rank labels',
      'model: selected is visible',
      'empty model: unselected is denied',
      'live model: unselected is denied',
      'cold model: unselected is denied',
      'revoked model: unselected is denied',
      'slash: selected is visible',
      'empty slash: unselected is denied',
      'live slash: unselected is denied',
      'cold slash: unselected is denied',
      'revoked slash: unselected is denied',
      'selected loader succeeds',
      'unselected loader matches composition',
      'real pre-step slash consumer respects selection',
      'host-only filesystem visibility matches control',
      'catalog excludes unselected in OFF composition',
      'all raw host Office candidates are bundled inventory entries',
      'unselected Office shadow denies both invocation paths',
      'selected Office definition loads its validated body',
      'no invalid preset diagnostic',
      'headless exits cleanly',
    ], 'the assertion matrix drifted — the capability-present contract is verbatim')
    assert.deepEqual(checks.filter((entry) => !entry.ok), [], 'recorded green conclusion must stay green')
  })
})

describe('runner verdict vocabulary (D1)', () => {
  it('skip records { scenario, label, skip: true, detail } and prints SKIP with evidence', () => {
    const lines = []
    const verdicts = makeVerdicts({ log: (line) => lines.push(line) })
    verdicts.skip('skill-composition-office', 'optional Office capability unavailable', 'missing=["office-docx"] providers=["filesystem"]')
    assert.deepEqual(verdicts.results, [{ scenario: 'skill-composition-office', label: 'optional Office capability unavailable', skip: true, detail: 'missing=["office-docx"] providers=["filesystem"]' }])
    assert.equal(lines.length, 1)
    assert.match(lines[0], /^SKIP \[skill-composition-office\] optional Office capability unavailable — missing=\["office-docx"\] providers=\["filesystem"\]$/)
  })

  it('check keeps the PASS/FAIL vocabulary and FAIL detail printing', () => {
    const lines = []
    const verdicts = makeVerdicts({ log: (line) => lines.push(line) })
    verdicts.check('a', 'fine', true)
    verdicts.check('a', 'broken', false, 'why')
    assert.deepEqual(verdicts.results.map((entry) => entry.ok), [true, false])
    assert.deepEqual(lines, ['PASS [a] fine', 'FAIL [a] broken — why'])
  })

  it('a suite with skips but no failures exits 0 and displays passed/(total-skipped) plus the skipped note', () => {
    const lines = []
    const verdicts = makeVerdicts({ log: (line) => lines.push(line) })
    verdicts.check('a', 'fine', true)
    verdicts.skip('b', 'capability absent', 'evidence')
    const summary = verdicts.summarize()
    assert.equal(summary.exitCode, 0, 'skips never fail the suite')
    assert.deepEqual({ total: summary.total, passed: summary.passed, failed: summary.failed, skipped: summary.skipped }, { total: 2, passed: 1, failed: 0, skipped: 1 })
    assert.equal(lines.at(-1), '\n1/1 integration checks passed (skipped 1)')
  })

  it('failures still exit 1 and skips stay out of both the failure and the denominator', () => {
    const lines = []
    const verdicts = makeVerdicts({ log: (line) => lines.push(line) })
    verdicts.check('a', 'broken', false, 'why')
    verdicts.skip('b', 'capability absent', 'evidence')
    const summary = verdicts.summarize()
    assert.equal(summary.exitCode, 1, 'exit code semantics unchanged: any FAIL fails the run')
    assert.deepEqual({ total: summary.total, passed: summary.passed, failed: summary.failed, skipped: summary.skipped }, { total: 2, passed: 0, failed: 1, skipped: 1 })
    assert.equal(lines.at(-1), '\n0/1 integration checks passed (skipped 1)')
  })

  it('without skips the summary line keeps the legacy shape (no skipped note)', () => {
    const lines = []
    const verdicts = makeVerdicts({ log: (line) => lines.push(line) })
    verdicts.check('a', 'fine', true)
    verdicts.check('b', 'also fine', true)
    assert.equal(verdicts.summarize().exitCode, 0)
    assert.equal(lines.at(-1), '\n2/2 integration checks passed')
  })

  it('run.mjs wires the verdict module and the scenario-bound skip (source-pinned)', () => {
    const source = readFileSync(new URL('../run.mjs', import.meta.url), 'utf8')
    assert.match(source, /import \{ makeVerdicts \} from '\.\/src\/run-verdict\.js'/)
    assert.match(source, /const \{ check, skip, summarize \} = makeVerdicts\(\)/)
    assert.match(source, /skip: \(label, detail\) => skip\(scenario\.id, label, detail\)/)
    assert.match(source, /process\.exit\(summarize\(\)\.exitCode\)/)
  })
})
