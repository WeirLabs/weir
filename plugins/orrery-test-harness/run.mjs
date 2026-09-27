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
const IT_ROOT = '/tmp/orrery-it'
const HOME = join(IT_ROOT, 'home')
const PROFILE = join(HOME, 'profiles', 'orrery-it')
const WS = join(IT_ROOT, 'ws')

const SCENARIOS = ['deepwork', 'delegate', 'hashline', 'pressure', 'robash', 'semantic']

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
  }[scenario]
  const trace = join(IT_ROOT, `trace-${scenario}.jsonl`)
  const env = {
    ...process.env,
    DSH_HOME: HOME,
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

async function main() {
  const selected = process.argv.slice(2).length > 0 ? process.argv.slice(2) : SCENARIOS
  console.log(`[setup] profile at ${PROFILE}`)
  setup()
  for (const scenario of selected) {
    console.log(`[run] ${scenario}`)
    const run = await runScenario(scenario)
    if (run.stderr.trim().length > 0) {
      console.log(`[stderr:${scenario}] ${run.stderr.trim().split('\n').slice(-3).join('\n')}`)
    }
    if (scenario === 'deepwork') assertDeepwork(run)
    if (scenario === 'delegate') assertDelegate(run)
    if (scenario === 'hashline') assertHashline(run)
    if (scenario === 'pressure') assertPressure(run)
    if (scenario === 'robash') assertRobash(run)
    if (scenario === 'semantic') assertSemantic(run)
  }
  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} integration checks passed`)
  process.exit(failed.length > 0 ? 1 : 0)
}

await main()
