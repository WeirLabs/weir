// Integration driver for orrery-harness: boots a real headless DSH runtime
// (bundled node + extracted dsh CLI) with a scripted mock LLM, runs one
// scenario per invocation, and asserts on the mock trace, the durable session
// log, and fixture files. Dev-only; writes everything under /tmp/orrery-it.
//
//   node run.mjs [scenario ...]     (default: all)
import { execFileSync, execFile } from 'node:child_process'
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const WS_ROOT = join(HERE, '..', '..')
const NODE = '/Users/young/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node'
const PNPM = '/Users/young/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs'
const DSH_BIN = '/tmp/dsh-src/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js'
// Relocated off /tmp: writableRoots(workspace-write) always contains /tmp and tmpdir(),
// so a sandbox-mirroring regression (S23) can only reproduce a denial when the
// test workspace lives OUTSIDE every unconditional writable root.
const IT_ROOT = '/Users/young/.orrery-it'
const HOME = join(IT_ROOT, 'home')
const PROFILE = join(HOME, 'profiles', 'orrery-it')
const WS = join(IT_ROOT, 'ws')

const SCENARIOS = ['deepwork', 'delegate', 'hashline', 'pressure', 'robash', 'semantic', 'grouped', 'rehydrate', 'lsp']

function setup() {
  rmSync(IT_ROOT, { recursive: true, force: true })
  mkdirSync(PROFILE, { recursive: true })
  mkdirSync(WS, { recursive: true })
  writeFileSync(
    join(PROFILE, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-orrery-it',
        private: true,
        dependencies: {
          'orrery-harness': `link:${join(WS_ROOT, 'plugins/orrery-harness')}`,
          'orrery-test-harness': `link:${join(WS_ROOT, 'plugins/orrery-test-harness')}`,
        },
        dsh: {
          profile: {
            bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'orrery-test-harness'],
          },
        },
      },
      null,
      2,
    ) + '\n',
  )
  writeFileSync(join(PROFILE, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(PROFILE, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  execFileSync(NODE, [PNPM, 'install', '--reporter', 'silent'], { cwd: PROFILE, stdio: 'inherit' })
  writeFileSync(join(WS, 'fixture.txt'), 'line one\nline two\nline three\n')
  // LSP scenario fixtures: a .ts target and the mock LSP server INSIDE the
  // workspace (spawned processes may only read inside the sandbox root).
  writeFileSync(join(WS, 'probe.ts'), 'export const fixtureSymbol = 1\n')
  writeFileSync(join(WS, 'mock-lsp-server.js'), readFileSync(join(HERE, 'src', 'mock-lsp-server.js'), 'utf8'))
}

function runScenario(scenario) {
  const prompt = {
    deepwork: '深度工作：注册计划然后停住',
    delegate: 'delegate-probe',
    hashline: 'hashline-probe',
    pressure: 'pressure-probe',
    robash: 'robash-probe',
    // no intent keywords: only the semantic classifier can arm deep-work here
    semantic: '把这个任务从头到尾彻底完成，每一步都要拿出证据',
    grouped: 'grouped-probe',
    rehydrate: 'rehydrate-probe',
    lsp: 'lsp-probe',
  }[scenario]
  const trace = join(IT_ROOT, `trace-${scenario}.jsonl`)
  const env = {
    ...process.env,
    DSH_HOME: HOME,
    ORRERY_IT_ROOT: IT_ROOT,
    ORRERY_IT_SCENARIO: scenario,
    ORRERY_IT_TRACE: trace,
    ORRERY_IT_FIXTURE: join(WS, 'fixture.txt'),
    ...(scenario === 'pressure' ? { ORRERY_IT_WINDOW: '2000' } : {}),
  }
  return new Promise((resolvePromise) => {
    execFile(
      NODE,
      [DSH_BIN, 'orrery-it', prompt],
      { cwd: WS, env, timeout: 240_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolvePromise({ scenario, trace, code: error?.code ?? 0, stdout, stderr })
      },
    )
  })
}

function readTrace(path) {
  try {
    return readFileSync(path, 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  } catch {
    return []
  }
}

/**
 * Two-phase restart simulation: phase 1 spawns the supervised group and exits
 * with a member still blocked; phase 2 adopts the SAME session in a fresh
 * process (empty coordinator registry) and resumes on the rebuilt state.
 */
async function runRehydrateScenario() {
  const trace1 = join(IT_ROOT, 'trace-rehydrate.jsonl')
  const trace2 = join(IT_ROOT, 'trace-rehydrate-phase2.jsonl')
  const baseEnv = {
    ...process.env,
    DSH_HOME: HOME,
    ORRERY_IT_ROOT: IT_ROOT,
    ORRERY_IT_SCENARIO: 'rehydrate',
    ORRERY_IT_FIXTURE: join(WS, 'fixture.txt'),
  }
  const phase1 = new Promise((resolvePromise) => {
    execFile(
      NODE,
      [DSH_BIN, 'orrery-it', '--json', 'rehydrate-probe'],
      { cwd: WS, env: { ...baseEnv, ORRERY_IT_TRACE: trace1 }, timeout: 240_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolvePromise({ code: error?.code ?? 0, stdout, stderr })
      },
    )
  })
  const p1 = await phase1
  const sessionLine = p1.stdout
    .trim()
    .split('\n')
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .find((entry) => entry?.type === 'session')
  const sessionId = sessionLine?.sessionId
  if (!sessionId) {
    return { scenario: 'rehydrate', trace: trace1, trace2, sessionId: null, code: p1.code, stdout: p1.stdout, stderr: p1.stderr, phase1: p1, phase2: null }
  }
  const phase2 = new Promise((resolvePromise) => {
    execFile(
      NODE,
      [DSH_BIN, 'orrery-it', '--session-id', sessionId, 'rehydrate-resume-probe'],
      { cwd: WS, env: { ...baseEnv, ORRERY_IT_TRACE: trace2 }, timeout: 240_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolvePromise({ code: error?.code ?? 0, stdout, stderr })
      },
    )
  })
  const p2 = await phase2
  return {
    scenario: 'rehydrate',
    trace: trace1,
    trace2,
    sessionId,
    code: p2.code,
    stdout: p2.stdout,
    stderr: p2.stderr,
    phase1: p1,
    phase2: p2,
  }
}

const results = []

function check(scenario, label, ok, detail = '') {
  results.push({ scenario, label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} [${scenario}] ${label}${ok ? '' : ` — ${detail}`}`)
}

function assertDeepwork(run) {
  const trace = readTrace(run.trace)
  const requests = trace.filter((r) => Array.isArray(r.emitted))
  const events = trace.filter((r) => r.kind === 'session-event')
  check('deepwork', 'intent-gate injected the deep-work directive', requests.some((r) => r.intentInjected), JSON.stringify(requests.map((r) => r.lastUser)))
  check('deepwork', 'orrery/intent-hit audit event in the durable log', events.some((e) => e.type === 'orrery/intent-hit'))
  check('deepwork', 'todo continuation message entered the session log', events.some((e) => e.type === 'user/message' && (e.text ?? '').includes('<todo_continuation>')), JSON.stringify(events.map((e) => [e.type, e.source, (e.text ?? '').slice(0, 40)])))
  check('deepwork', 'todo continuation reached the model', requests.some((r) => r.continuationSeen))
  check('deepwork', 'headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

function assertDelegate(run) {
  const trace = readTrace(run.trace)
  const requests = trace.filter((r) => Array.isArray(r.emitted))
  const created = trace.filter((r) => r.kind === 'agent-created')
  check('delegate', 'parent emitted a delegate tool call', requests.some((r) => r.emitted.includes('tool-call') && r.sawDelegateProbe))
  check('delegate', 'child session created as subagent at depth 1', created.some((r) => r.origin === 'subagent' && r.depth === 1), JSON.stringify(created))
  check('delegate', 'child session ran on the delegated prompt', requests.some((r) => r.sawChildMarker && !r.sawDelegateProbe))
  check('delegate', 'parent observed the child result', run.stdout.includes('parent observed child result'), run.stdout.slice(-400))
  check('delegate', 'headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

function assertHashline(run) {
  const trace = readTrace(run.trace)
  const requests = trace.filter((r) => Array.isArray(r.emitted))
  const fixture = readFileSync(join(WS, 'fixture.txt'), 'utf8')
  check('hashline', 'read result carried anchors to the model', requests.some((r) => r.anchoredReadSeen), JSON.stringify(requests.map((r) => r.emitted)))
  check('hashline', 'hash_edit rewrote line two', fixture.split('\n')[1] === 'CHANGED-BY-HASHLINE', fixture)
  check('hashline', 'stock edit hidden from the model tool catalog', requests.length > 0 && requests.every((r) => !r.tools.includes('edit')), JSON.stringify(requests.map((r) => r.tools)))
  check('hashline', 'hash_edit present in the model tool catalog', requests.some((r) => r.tools.includes('hash_edit')), JSON.stringify(requests.map((r) => r.tools)))
  check('hashline', 'headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

function assertPressure(run) {
  const trace = readTrace(run.trace)
  const requests = trace.filter((r) => Array.isArray(r.emitted))
  const events = trace.filter((r) => r.kind === 'session-event')
  const compacted = events.some((e) => typeof e.type === 'string' && e.type.startsWith('compaction/'))
  const inboxInserted = trace.filter((r) => r.kind === 'inbox-inserted')
  const resumed =
    requests.some((r) => (r.lastUser ?? '').includes('Resume the task from the compaction summary')) ||
    inboxInserted.some((r) => (r.text ?? '').includes('Resume the task from the compaction summary'))
  check('pressure', 'pressure advisory or forced compaction fired', requests.some((r) => r.pressureAdvisorySeen) || compacted, JSON.stringify(requests.map((r) => [r.purpose, r.pressureAdvisorySeen])))
  check('pressure', 'compaction ran at the boundary (durable compaction/* events)', compacted)
  check('pressure', 'summarizer model call was served', requests.some((r) => r.purpose === 'compaction'))
  check('pressure', 'post-compaction continuation resumed the task', resumed, JSON.stringify(requests.map((r) => r.lastUser)))
}

function assertRobash(run) {
  const trace = readTrace(run.trace)
  const requests = trace.filter((r) => Array.isArray(r.emitted))
  const created = trace.filter((r) => r.kind === 'agent-created')
  const fixture = readFileSync(join(WS, 'fixture.txt'), 'utf8')
  check('robash', 'parent delegated to a curated explore child', created.some((r) => r.origin === 'subagent' && r.depth === 1), JSON.stringify(created))
  check('robash', 'child ran an allowed bash command through the guard', requests.some((r) => r.sawRobashChild && r.roBashLsSeen), JSON.stringify(requests.map((r) => [r.sawRobashChild, r.roBashLsSeen])))
  check('robash', 'child write command was denied by the guard', requests.some((r) => r.sawRobashChild && r.roBashRmDenied), JSON.stringify(requests.map((r) => [r.sawRobashChild, r.roBashRmDenied])))
  check('robash', 'fixture survived the denied rm', fixture.split('\n')[0] === 'line one' && fixture.trim().split('\n').length === 3, fixture)
  check('robash', 'headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

function assertSemantic(run) {
  const trace = readTrace(run.trace)
  const requests = trace.filter((r) => Array.isArray(r.emitted))
  const events = trace.filter((r) => r.kind === 'session-event')
  check('semantic', 'classifier sidecar call was served', requests.some((r) => r.sawClassifyCall), JSON.stringify(requests.map((r) => [r.purpose, r.sawClassifyCall])))
  check('semantic', 'semantic hit injected the deep-work directive', requests.some((r) => r.intentInjected), JSON.stringify(requests.map((r) => r.lastUser)))
  check('semantic', 'orrery/intent-classify audit event names the hit', events.some((e) => e.type === 'orrery/intent-classify' && e.data?.hit === 'deep-work'), JSON.stringify(events.filter((e) => e.type.startsWith('orrery/')).map((e) => [e.type, e.data])))
  check('semantic', 'headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

function assertGrouped(run) {
  const trace = readTrace(run.trace)
  const requests = trace.filter((r) => Array.isArray(r.emitted))
  check('grouped', 'parent delegated a supervised group', requests.some((r) => r.emitted.includes('tool-call') && r.sawGroupProbe), JSON.stringify(requests.map((r) => r.emitted)))
  check('grouped', 'provider-error retry path exercised', requests.some((r) => r.groupRetrySeen), JSON.stringify(requests.map((r) => r.groupRetrySeen)))
  check('grouped', 'merged report carried both member reports', requests.some((r) => r.mergedAlphaSeen) && requests.some((r) => r.mergedBetaSeen), JSON.stringify(requests.map((r) => [r.mergedAlphaSeen, r.mergedBetaSeen])))
  check('grouped', 'parent observed the merged group report', run.stdout.includes('parent observed group merge'), run.stdout.slice(-400))
  check('grouped', 'headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

function assertLsp(run) {
  const trace = readTrace(run.trace)
  const requests = trace.filter((r) => Array.isArray(r.emitted))
  check('lsp', 'toggle enabled the LSP tool set', requests.some((r) => r.lspToggledOn), JSON.stringify(requests.map((r) => r.lspToggledOn)))
  check('lsp', 'diagnostics delivered through the mock LSP server', requests.some((r) => r.lspDiagSeen), JSON.stringify(requests.map((r) => r.lspDiagSeen)))
  check('lsp', 'definition, references, and symbols answered', requests.some((r) => r.lspDefSeen) && requests.some((r) => r.lspRefsSeen) && requests.some((r) => r.lspSymbolsSeen), JSON.stringify(requests.map((r) => [r.lspDefSeen, r.lspRefsSeen, r.lspSymbolsSeen])))
  check('lsp', 'tools unregistered after toggle off', requests.some((r) => r.lspUnknownAfterOff), JSON.stringify(requests.map((r) => r.lspUnknownAfterOff)))
  check('lsp', 'headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}
function assertRehydrate(run) {
  const trace1 = readTrace(run.trace)
  const trace2 = readTrace(run.trace2)
  const requests1 = trace1.filter((r) => Array.isArray(r.emitted))
  const requests2 = trace2.filter((r) => Array.isArray(r.emitted))
  check('rehydrate', 'phase 1 session id captured', typeof run.sessionId === 'string' && run.sessionId.length > 0, JSON.stringify(run.sessionId))
  check('rehydrate', 'parent delegated a supervised group in phase 1', requests1.some((r) => r.emitted.includes('tool-call') && r.sawRehydrateProbe), JSON.stringify(requests1.map((r) => [r.sawRehydrateProbe, r.emitted])))
  check('rehydrate', 'blocked notice reached the parent before the restart', requests1.some((r) => r.rehydrateBlockedNoticeSeen), JSON.stringify(requests1.map((r) => r.rehydrateBlockedNoticeSeen)))
  check('rehydrate', 'supervised members exclude send_message, the parent keeps it', requests1.some((r) => r.rehydrateChildASeen && r.tools.length > 0 && r.tools.includes('bash') && !r.tools.includes('send_message')) && requests1.some((r) => r.sawRehydrateProbe && r.tools.includes('send_message')), JSON.stringify(requests1.map((r) => [r.rehydrateChildASeen, r.tools.length, r.tools.includes('send_message')])))
  check('rehydrate', 'audit JSONL recorded supervision facts in phase 1', auditFactsSeen(run.sessionId), '')
  check('rehydrate', 'parent resumed the blocked child on the rebuilt registry', requests2.some((r) => r.emitted.includes('tool-call') && r.rehydrateResumeCallSeen), JSON.stringify(requests2.map((r) => [r.rehydrateResumeCallSeen, r.emitted])))
  check('rehydrate', 'resume context reached the child after the restart', requests2.some((r) => r.rehydrateResumeContextSeen), JSON.stringify(requests2.map((r) => r.rehydrateResumeContextSeen)))
  check('rehydrate', 'resumed child reported completion', requests2.some((r) => r.rehydrateResumedReportSeen), JSON.stringify(requests2.map((r) => r.rehydrateResumedReportSeen)))
  check('rehydrate', 'parent observed the merged group report after the restart', run.stdout.includes('parent observed post-restart group merge'), run.stdout.slice(-400))
  check('rehydrate', 'phase 2 exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

function auditFactsSeen(sessionId) {
  if (!sessionId) return false
  let lines = []
  try {
    lines = readFileSync(join(WS, '.orrery', 'audit.jsonl'), 'utf8').trim().split('\n')
  } catch {
    return false
  }
  const records = lines
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return null
      }
    })
    .filter((record) => record?.session === sessionId && typeof record?.type === 'string' && record.type.startsWith('orrery/supervision/'))
  const kinds = records.map((record) => record.data?.kind)
  return kinds.includes('spawn') && kinds.includes('seal') && kinds.includes('settle')
}

async function main() {
  const selected = process.argv.slice(2).length > 0 ? process.argv.slice(2) : SCENARIOS
  console.log(`[setup] profile at ${PROFILE}`)
  setup()
  for (const scenario of selected) {
    console.log(`[run] ${scenario}`)
    const run = scenario === 'rehydrate' ? await runRehydrateScenario() : await runScenario(scenario)
    if (run.stderr.trim().length > 0) {
      console.log(`[stderr:${scenario}] ${run.stderr.trim().split('\n').slice(-3).join('\n')}`)
    }
    if (scenario === 'deepwork') assertDeepwork(run)
    if (scenario === 'delegate') assertDelegate(run)
    if (scenario === 'hashline') assertHashline(run)
    if (scenario === 'pressure') assertPressure(run)
    if (scenario === 'robash') assertRobash(run)
    if (scenario === 'semantic') assertSemantic(run)
    if (scenario === 'grouped') assertGrouped(run)
    if (scenario === 'rehydrate') assertRehydrate(run)
    if (scenario === 'lsp') assertLsp(run)
  }
  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} integration checks passed`)
  process.exit(failed.length > 0 ? 1 : 0)
}

await main()
