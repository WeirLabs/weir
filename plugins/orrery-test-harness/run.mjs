// Integration driver for orrery-harness: boots a real headless DSH runtime
// (bundled node + extracted dsh CLI) with a scripted mock LLM, runs one
// scenario per invocation, and asserts on the mock trace, the durable session
// log, and fixture files. Dev-only; writes everything under the IT_ROOT below.
//
// Scenarios come from the registry (src/scenarios/index.js): this driver is
// generic — it enumerates the registry, injects each scenario's prompt, runs
// its optional run override, and replays its assert on a pre-parsed run view.
//
//   node run.mjs [scenario ...]     (default: all)
import { execFileSync, execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeRunView } from './src/run-view.js'
import { SCENARIOS, byId } from './src/scenarios/index.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const WS_ROOT = join(HERE, '..', '..')
// Toolchain + the booted CLI are env-overridable so the same driver runs on a
// POSIX dev box and on Windows. The POSIX values stay the defaults, so the
// macOS dev loop is byte-for-byte unchanged.
const IS_WINDOWS = process.platform === 'win32'
const NODE =
  process.env.ORRERY_IT_NODE ??
  (IS_WINDOWS
    ? join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')
    : '/Users/young/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node')
const PNPM =
  process.env.ORRERY_IT_PNPM ??
  (IS_WINDOWS
    ? join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
    : '/Users/young/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs')
// The extracted-DSH reference (/tmp/dsh-src) is POSIX-only. Windows uses the
// npm-global install of the same dsh version instead.
const DSH_BIN =
  process.env.ORRERY_IT_DSH ??
  (IS_WINDOWS
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    : '/tmp/dsh-src/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
// Relocated off /tmp: writableRoots(workspace-write) always contains /tmp and tmpdir(),
// so a sandbox-mirroring regression (S23) can only reproduce a denial when the
// test workspace lives OUTSIDE every unconditional writable root.
// ORRERY_IT_ROOT overrides the write root; a POSIX dev box keeps /Users/young.
// On Windows the ACLs, not the POSIX writable-root list, define the sandbox,
// so the root is an absolute path on a drive outside the session workspace.
const IT_ROOT = process.env.ORRERY_IT_ROOT ?? (IS_WINDOWS ? 'D:\\.orrery-it' : '/Users/young/.orrery-it')
const HOME = join(IT_ROOT, 'home')
const PROFILE = join(HOME, 'profiles', 'orrery-it')
const WS = join(IT_ROOT, 'ws')

// When set, each scenario's run record + trace + post-run workspace fixtures
// are copied into this directory (assert-replay fixtures, task 4.2).
const RECORD_DIR = process.env.ORRERY_IT_RECORD ?? null

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
          // Raw absolute paths: pnpm `link:` takes a native path on every platform,
          // and file:// URL pathnames would mangle a Windows drive letter (/D:/…).
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
  // Denial probe target: OUTSIDE the session workspace but readable — the
  // hashline scenario edits it to observe the sandbox denial marker + hint.
  writeFileSync(join(HOME, 'denied.txt'), 'outside one\noutside two\n')
  // LSP scenario fixtures: a .ts target and the mock LSP server INSIDE the
  // workspace (spawned processes may only read inside the sandbox root).
  // probe-other.ts is deliberately CRLF: the rename scenario asserts the
  // write-back preserves the original line-ending style end-to-end.
  writeFileSync(join(WS, 'probe.ts'), 'export const fixtureSymbol = 1\n')
  writeFileSync(join(WS, 'probe-other.ts'), 'import { fixtureSymbol } from "./probe"\r\nexport const useIt = fixtureSymbol + 1\r\n')
  writeFileSync(join(WS, 'mock-lsp-server.js'), readFileSync(join(HERE, 'src', 'mock-lsp-server.js'), 'utf8'))
}

// ---------- spawn skeleton ----------

/** Boot one headless run of the CLI; resolves with { code, stdout, stderr }. */
// ORRERY_IT_DSH_EXEC: a self-contained CLI launcher (for example the desktop
// app's runtime/cli/bin/dsh) spawned directly instead of NODE + DSH_BIN.
const DSH_EXEC = process.env.ORRERY_IT_DSH_EXEC ?? null

function spawnHeadless(args, env) {
  return new Promise((resolvePromise) => {
    execFile(
      DSH_EXEC ?? NODE,
      DSH_EXEC ? args : [DSH_BIN, ...args],
      { cwd: WS, env, timeout: 240_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolvePromise({ code: error?.code ?? 0, stdout, stderr })
      },
    )
  })
}

/** The ORRERY_IT_* env one boot runs with; `extra` is the scenario overlay. */
function scenarioEnv(scenarioId, trace, extra = {}) {
  return {
    ...process.env,
    DSH_HOME: HOME,
    ORRERY_IT_ROOT: IT_ROOT,
    ORRERY_IT_SCENARIO: scenarioId,
    ORRERY_IT_TRACE: trace,
    ORRERY_IT_FIXTURE: join(WS, 'fixture.txt'),
    ...extra,
  }
}

/** The generic one-boot scenario run: prompt + env come from the registry entry. */
function runScenario(scenario) {
  const trace = join(IT_ROOT, `trace-${scenario.id}.jsonl`)
  return spawnHeadless(['orrery-it', scenario.prompt], scenarioEnv(scenario.id, trace, scenario.env)).then((outcome) => ({
    scenario: scenario.id,
    trace,
    ...outcome,
  }))
}

/** The context handed to a scenario's optional run override (rehydrate). */
const driverCtx = { IT_ROOT, spawnHeadless, scenarioEnv }

// ---------- assertion collection ----------

const results = []

function check(scenario, label, ok, detail = '') {
  results.push({ scenario, label, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'} [${scenario}] ${label}${ok ? '' : ` — ${detail}`}`)
}

/** Copy one scenario's replay fixture (trace + run meta + post-run ws files). */
function recordRun(run) {
  if (!RECORD_DIR) return
  try {
    const dir = join(RECORD_DIR, run.scenario)
    mkdirSync(join(dir, 'ws'), { recursive: true })
    if (existsSync(run.trace)) copyFileSync(run.trace, join(dir, 'trace.jsonl'))
    if (run.trace2 && existsSync(run.trace2)) copyFileSync(run.trace2, join(dir, 'trace2.jsonl'))
    // capstore-*.json: the capability-store probe reports (capstore scenario).
    for (const file of ['fixture.txt', 'probe.ts', 'probe-other.ts', 'locked.txt', 'capstore-host.json', 'capstore-realm.json']) {
      const source = join(WS, file)
      if (existsSync(source)) copyFileSync(source, join(dir, 'ws', file))
    }
    // Worktree scenario facts the assertion reads back on replay (only that
    // scenario owns these paths; other scenarios' fixtures stay byte-identical).
    // git never tracks a path inside a `.git` directory, so the exclude file
    // is stored flattened as `git-info-exclude`.
    const extras = run.scenario === 'worktree'
      ? [[join('.orrery', 'worktrees', 'lanes.json'), join('.orrery', 'worktrees', 'lanes.json')], [join('.git', 'info', 'exclude'), 'git-info-exclude']]
      : run.scenario.startsWith('editlock-stop-')
        ? (() => {
          const boundary = run.scenario.slice('editlock-stop-'.length)
          return [join('.orrery', `edit-lock-${boundary}`, 'snapshot.json'), join(`stop-${boundary}`, 'stop-target.txt'), `unrelated-${boundary}.txt`].map(path => [path, path])
        })()
        : []
    for (const [relative, stored] of extras) {
      const source = join(WS, relative)
      if (!existsSync(source)) continue
      mkdirSync(dirname(join(dir, 'ws', stored)), { recursive: true })
      copyFileSync(source, join(dir, 'ws', stored))
    }
    const auditLog = join(WS, '.orrery', 'audit.jsonl')
    if (existsSync(auditLog)) {
      mkdirSync(join(dir, 'ws', '.orrery'), { recursive: true })
      copyFileSync(auditLog, join(dir, 'ws', '.orrery', 'audit.jsonl'))
    }
    writeFileSync(
      join(dir, 'run.json'),
      JSON.stringify({ scenario: run.scenario, code: run.code, stdout: run.stdout, stderr: run.stderr, sessionId: run.sessionId ?? null }, null, 2) + '\n',
    )
  } catch (error) {
    console.log(`[record:${run.scenario}] ${String(error?.message ?? error)}`)
  }
}

async function main() {
  const ids = process.argv.slice(2)
  // Unknown scenario ids fail loudly and cheaply — before setup() wipes and
  // reinstalls the IT root (spec: 未知场景显式失败).
  const unknown = ids.filter((id) => !byId(id))
  if (unknown.length > 0) {
    console.error(`unknown scenario id(s): ${unknown.join(', ')} (registry: ${SCENARIOS.map((scenario) => scenario.id).join(', ')})`)
    process.exit(1)
  }
  const selected = ids.length > 0 ? ids.map((id) => byId(id)) : SCENARIOS
  console.log(`[setup] profile at ${PROFILE}`)
  setup()
  for (const scenario of selected) {
    console.log(`[run] ${scenario.id}`)
    const run = await (scenario.run?.(driverCtx) ?? runScenario(scenario))
    if (run.stderr.trim().length > 0) {
      console.log(`[stderr:${scenario.id}] ${run.stderr.trim().split('\n').slice(-3).join('\n')}`)
    }
    recordRun(run)
    scenario.assert(makeRunView(run, { ws: WS, check: (label, ok, detail) => check(scenario.id, label, ok, detail) }))
  }
  const failed = results.filter((result) => !result.ok)
  console.log(`\n${results.length - failed.length}/${results.length} integration checks passed`)
  process.exit(failed.length > 0 ? 1 : 0)
}

await main()
