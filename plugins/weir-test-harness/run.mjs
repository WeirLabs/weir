// Integration driver for weir-harness: boots a real headless DSH runtime
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
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeRunView } from './src/run-view.js'
import { SCENARIOS, byId } from './src/scenarios/index.js'
import { defaultItRoot } from './src/it-root.js'
import { LOCK_NAME, acquireRunLock, releaseRunLock } from './src/run-lock.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const WS_ROOT = join(HERE, '..', '..')
// Toolchain + the booted CLI are env-overridable so the same driver runs on a
// POSIX dev box and on Windows. The POSIX values stay the defaults, so the
// macOS dev loop is byte-for-byte unchanged.
const IS_WINDOWS = process.platform === 'win32'
const NODE =
  process.env.WEIR_IT_NODE ??
  (IS_WINDOWS
    ? join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'node', 'bin', 'node.exe')
    : '/Users/young/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node')
const PNPM =
  process.env.WEIR_IT_PNPM ??
  (IS_WINDOWS
    ? join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
    : '/Users/young/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs')
// The extracted-DSH reference (/tmp/dsh-src) is POSIX-only. Windows uses the
// npm-global install of the same dsh version instead.
const DSH_BIN =
  process.env.WEIR_IT_DSH ??
  (IS_WINDOWS
    ? join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'npm', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
    : '/tmp/dsh-src/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js')
// Keep the default inside this repository/worktree, outside system temp roots
// so sandbox-mirroring regressions remain observable. Explicit overrides win.
const IT_ROOT = process.env.WEIR_IT_ROOT ?? defaultItRoot()
// Advisory lock (design D3): concurrent runs on the DEFAULT root must not
// share mutable runtime state. An explicit WEIR_IT_ROOT bypasses the lock
// entirely — the caller owns isolation. The decision happens before any path
// derives from the root, and the startup wipe only ever touches RUN_ROOT.
const RUN_LOCK = process.env.WEIR_IT_ROOT ? null : acquireRunLock(IT_ROOT)
const RUN_ROOT = RUN_LOCK?.root ?? IT_ROOT
if (RUN_LOCK?.lockPath) process.on('exit', () => releaseRunLock(RUN_LOCK))
const HOME = join(RUN_ROOT, 'home')
const PROFILE = join(HOME, 'profiles', 'weir-it')
const WS = join(RUN_ROOT, 'ws')

// When set, each scenario's run record + trace + post-run workspace fixtures
// are copied into this directory (assert-replay fixtures, task 4.2).
const RECORD_DIR = process.env.WEIR_IT_RECORD ?? null

function setup() {
  // Wipe only the root this run actually uses; when this run holds the
  // advisory lock, the lock file itself survives the wipe.
  if (RUN_LOCK?.lockPath) {
    mkdirSync(RUN_ROOT, { recursive: true })
    for (const entry of readdirSync(RUN_ROOT)) {
      if (entry === LOCK_NAME) continue
      rmSync(join(RUN_ROOT, entry), { recursive: true, force: true })
    }
  } else {
    rmSync(RUN_ROOT, { recursive: true, force: true })
  }
  mkdirSync(PROFILE, { recursive: true })
  mkdirSync(WS, { recursive: true })
  writeFileSync(
    join(PROFILE, 'package.json'),
    JSON.stringify(
      {
        name: 'dsh-profile-weir-it',
        private: true,
        dependencies: {
          // Raw absolute paths: pnpm `link:` takes a native path on every platform,
          // and file:// URL pathnames would mangle a Windows drive letter (/D:/…).
          'weir-harness': `link:${join(WS_ROOT, 'plugins/weir-harness')}`,
          'weir-test-harness': `link:${join(WS_ROOT, 'plugins/weir-test-harness')}`,
        },
        dsh: {
          profile: {
            bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'weir-test-harness'],
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
  // Independent management root and protocol server: earlier shared-root LSP
  // mutations and retained locks cannot contaminate the lost-ack scenario.
  const uncertain = join(WS, 'editlock-lsp-uncertain')
  mkdirSync(uncertain, { recursive: true })
  for (const name of ['probe.ts', 'probe-other.ts', 'mock-lsp-server.js']) copyFileSync(join(WS, name), join(uncertain, name))
}

// Generated ONLY for editlock-negotiation, under this invocation's disposable
// IT root. This is controlled Host delivery injection, NOT a network outage.
// Patch the exact live holder instance for one notice and restore both methods
// before the QA tool returns (and again on plugin dispose if a run aborts).
const NEGOTIATION_FIXTURE = String.raw`import { appendFileSync, existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
export const name = 'weir-it-controlled-host-delivery-injection'
export const inject = ['agents', 'tools']
export function apply(ctx) {
  const root = process.env.WEIR_IT_ROOT
  const file = join(root, 'ws', 'negotiation-target.txt')
  const snapshotFile = join(root, 'ws', '.weir', 'edit-lock', 'snapshot.json')
  const reservation = join(root, 'ws', '.weir', '.edit-lock.publisher-reservation')
  const trace = process.env.WEIR_IT_TRACE
  let restore = () => {}
  ctx.on('dispose', () => restore())
  ctx.tools.register({
    name: 'qa_editlock_negotiation',
    description: 'QA only: exercise real try_steal with one controlled Host delivery injection and its full timeout.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: { type: 'object' }, render: (_args, result) => [{ type: 'text', text: result.message }] },
    timeoutMs: 150000,
    async execute(_args, exec) {
      const holder = exec.agent
      const before = JSON.parse(readFileSync(snapshotFile, 'utf8')).payload.state
      const bytesBefore = readFileSync(file, 'utf8')
      const reservationBefore = existsSync(reservation)
      const descriptors = new Map(['inject', 'followup'].map(method => [method, Object.getOwnPropertyDescriptor(holder, method)]))
      const originals = new Map(['inject', 'followup'].map(method => [method, holder[method]]))
      let attempts = 0, triggerCount = 0, method = null, busyStatus = null, expiryNotice = null, replyDelivered = false
      let restored = false
      restore = () => {
        if (restored) return
        for (const [key, descriptor] of descriptors) {
          if (descriptor) Object.defineProperty(holder, key, descriptor)
          else delete holder[key]
        }
        restored = holder.inject === originals.get('inject') && holder.followup === originals.get('followup')
      }
      const onInbox = payload => {
        if (payload?.agent?.id === requester?.agent?.id) {
          const text = JSON.stringify(payload.message)
          if (text.includes('expired without a holder reply')) expiryNotice = text
        }
        if (payload?.agent === holder && JSON.stringify(payload.message).includes('Call edit_lock_reply')) replyDelivered = true
      }
      let requester
      const offInbox = ctx.on('agent/inbox/inserted', onInbox)
      try {
        for (const key of ['inject', 'followup']) {
          Object.defineProperty(holder, key, { configurable: true, writable: true, value: function (message, ...rest) {
            const text = JSON.stringify(message)
            if (text.includes('Edit Lock: session ') && text.includes('requests ownership of ') && text.includes('Call edit_lock_reply') && text.includes(file)) {
              attempts++
              method = key
              busyStatus = holder.status
              if (process.env.WEIR_IT_DELIVERY_FAULT !== 'off' && attempts === 1) {
                triggerCount++
                throw new Error('QA_CONTROLLED_HOST_DELIVERY_INJECTION')
              }
            }
            return originals.get(key).call(this, message, ...rest)
          } })
        }
        requester = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: holder.session.header.cwd } })
        const started = Date.now()
        const outcome = await ctx.tools.execute({ name: 'edit_lock_try_steal', callId: randomUUID(), arguments: { file_path: file }, agent: requester.agent, signal: new AbortController().signal })
        const pending = JSON.parse(readFileSync(snapshotFile, 'utf8')).payload.state
        const bytesPending = readFileSync(file, 'utf8')
        const reservationPending = existsSync(reservation)
        // The production timer is 120_000 ms; this independent referenced wait
        // merely keeps the headless Host alive until its real expiry notice lands.
        await new Promise(resolve => setTimeout(resolve, 123000))
        const after = JSON.parse(readFileSync(snapshotFile, 'utf8')).payload.state
        const report = { kind: 'qa-editlock-negotiation', requester: requester.agent.id,
          requestId: outcome.value?.requestId ?? null, toolError: outcome.isError ? outcome.error : null,
          holder: outcome.value?.holder ?? null, holderStatus: outcome.value?.holderStatus ?? null,
          attempts, triggerCount, method, busyStatus, expiryNotice, replyDelivered,
          elapsedMs: Date.now() - started, before, pending, after, bytesBefore, bytesPending,
          bytesAfter: readFileSync(file, 'utf8'), reservationBefore, reservationPending,
          reservationAfter: existsSync(reservation), holderStillLive: ctx.agents.get(holder.id) === holder }
        restore()
        report.restored = restored
        appendFileSync(trace, JSON.stringify(report) + '\n')
        return { message: 'QA_NEGOTIATION_FINISHED' }
      } finally {
        restore()
        offInbox()
        if (requester) await requester.dispose()
      }
    },
  })
}
`
// ---------- spawn skeleton ----------

/** Boot one headless run of the CLI; resolves with { code, stdout, stderr }. */
// WEIR_IT_DSH_EXEC: a self-contained CLI launcher (for example the desktop
// app's runtime/cli/bin/dsh) spawned directly instead of NODE + DSH_BIN.
const DSH_EXEC = process.env.WEIR_IT_DSH_EXEC ?? null

function spawnHeadless(args, env) {
  return new Promise((resolvePromise) => {
    execFile(
      DSH_EXEC ?? NODE,
      DSH_EXEC ? args : [DSH_BIN, ...args],
      { cwd: env.WEIR_IT_LSP_UNCERTAIN === '1' ? join(WS, 'editlock-lsp-uncertain') : (env.WEIR_IT_SANDBOX_NARROW === '1' ? join(WS, 'editlock-hashline-negatives', 'narrow') : WS), env, timeout: 240_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout, stderr) => {
        resolvePromise({ code: error?.code ?? 0, stdout, stderr })
      },
    )
  })
}

/** The WEIR_IT_* env one boot runs with; `extra` is the scenario overlay. */
function scenarioEnv(scenarioId, trace, extra = {}) {
  return {
    ...process.env,
    DSH_HOME: HOME,
    WEIR_IT_ROOT: RUN_ROOT,
    WEIR_IT_SCENARIO: scenarioId,
    WEIR_IT_TRACE: trace,
    WEIR_IT_FIXTURE: join(WS, 'fixture.txt'),
    ...extra,
  }
}

/** The generic one-boot scenario run: prompt + env come from the registry entry. */
function runScenario(scenario) {
  if (scenario.env?.WEIR_IT_SANDBOX_NARROW === '1') {
    // This scenario alone owns a fresh nested management root: earlier lock-on
    // scenarios in a full run may leave fenced locks in the shared <ws> root.
    const domain = join(WS, 'editlock-hashline-negatives')
    mkdirSync(join(domain, 'narrow'), { recursive: true })
    writeFileSync(join(domain, 'sandbox-target.txt'), 'sandbox one\nsandbox two\n')
  }
  const trace = join(RUN_ROOT, `trace-${scenario.id}.jsonl`)
  const hostControl = scenario.env?.WEIR_IT_SKILL_COMPOSITION === 'HOST'
  const negotiation = scenario.id === 'editlock-negotiation'
  if (negotiation) writeFileSync(join(RUN_ROOT, 'editlock-negotiation-fault.mjs'), NEGOTIATION_FIXTURE)
  writeFileSync(join(PROFILE, 'cordis.patch.yml'), hostControl
    ? `- id: skill-filesystem\n  disabled: false\n  config:\n    customSkillDirs:\n      - ${JSON.stringify(join(WS, 'skill-roots'))}\n- id: tool-skill\n  disabled: false\n- id: weir-it-tool-skill\n  disabled: true\n`
    : negotiation ? JSON.stringify([{ insert: [{ id: 'weir-it-controlled-host-delivery-injection', name: join(RUN_ROOT, 'editlock-negotiation-fault.mjs') }] }]) + '\n' : '[]\n')
  return spawnHeadless(['weir-it', scenario.prompt], scenarioEnv(scenario.id, trace, scenario.env)).then((outcome) => ({
    scenario: scenario.id,
    trace,
    ...outcome,
  }))
}

// A separate profile boots the actual product bundle, never the host-mounted
// test mirror. Disable host delegation rows as Web does, including controls so
// positive catalog assertions cannot be rescued by dsh-base registrations.
async function runPresetDelegationSurface(scenario, preset) {
  const profileName = `weir-it-${preset}`
  const profile = join(HOME, 'profiles', profileName)
  mkdirSync(profile, { recursive: true })
  const manifest = JSON.parse(readFileSync(join(PROFILE, 'package.json'), 'utf8'))
  manifest.name = `dsh-profile-${profileName}`
  manifest.dsh.profile.bundles = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'weir-harness']
  writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  const disabled = ['tool-subagent', 'tool-subagent-fork', 'workflow-ptc', 'tool-workflow', 'tool-subagent-control', 'tool-subagent-list-agents', 'weir-notify']
  const patch = disabled.map(id => ({ id, disabled: true }))
  patch.push({ id: 'agent-default-model', config: { provider: 'mock', model: 'mock-1' } })
  patch.push({ insert: [
    { id: 'cordis-host-runner', name: '@deepseek-ai/dsh-cordis-host-runner' },
    { id: 'cordis-inspect-providers', name: '@deepseek-ai/dsh-tool-cordis/host' },
    { id: 'weir-it-agent-presets', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: preset } },
    { id: 'weir-it-mock-llm', name: 'weir-test-harness/mock-llm' },
    { id: 'weir-it-event-tap', name: 'weir-test-harness/event-tap' },
    { id: 'weir-it-preset-delegation-surface-probe', name: join(HERE, 'src/preset-delegation-surface-probe.js') },
  ] })
  // JSON is a YAML subset; production !!js expressions remain in the product
  // bundle and are interpreted by Loader, not copied or evaluated by this test.
  writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify(patch, null, 2) + '\n')
  execFileSync(NODE, [PNPM, 'install', '--reporter', 'silent'], { cwd: profile, stdio: 'inherit' })
  const trace = join(RUN_ROOT, `trace-${scenario.id}-${preset}.jsonl`)
  const outcome = await spawnHeadless([profileName, scenario.prompt], scenarioEnv(scenario.id, trace, { WEIR_IT_DELEGATION_PRESET: preset }))
  return { scenario: scenario.id, trace, ...outcome }
}

/** The context handed to a scenario's optional run override (rehydrate). */
const driverCtx = { IT_ROOT: RUN_ROOT, spawnHeadless, scenarioEnv, runPresetDelegationSurface }

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
    // capstore-*.json: the capability-store probe reports (capstore scenario);
    // apply-transaction.json: the Apply-transaction probe report (task 4.7);
    // cold-session-*.json/txt: the cold-session probe reports and the captured
    // contender writer-held failure (task 5.5).
    for (const file of ['blackboard-orphan-owner.json', 'blackboard-orphan-observed.json', 'fixture.txt', 'probe.ts', 'probe-other.ts', 'locked.txt', 'capstore-host.json', 'capstore-realm.json', 'apply-transaction.json', 'cold-session-seed.json', 'cold-session-open.json', 'cold-session-held-error.txt', 'lifecycle-report.json', 'lifecycle-catalog.json', 'mcp-gateway-report.json', 'capability-remote-log.json', 'mcp-calls.jsonl', 'mcp-server-log.jsonl', 'preset-defaults-report.json', 'preset-boot2-outcome.json', 'auto-resume-target.txt', 'auto-resume-target-off.txt', 'docs/spikes.md', ...['off', 'leak', 'host', 'office', 'migration'].map(mode => `skill-composition-${mode}.json`)]) {
      const source = join(WS, file)
      if (existsSync(source)) {
        // The blackboard-promotion scenario lands a nested durable doc.
        mkdirSync(dirname(join(dir, 'ws', file)), { recursive: true })
        copyFileSync(source, join(dir, 'ws', file))
      }
    }
    // Worktree scenario facts the assertion reads back on replay (only that
    // scenario owns these paths; other scenarios' fixtures stay byte-identical).
    // git never tracks a path inside a `.git` directory, so the exclude file
    // is stored flattened as `git-info-exclude`.
    const extras = run.scenario === 'worktree'
      ? [[join('.weir', 'worktrees', 'lanes.json'), join('.weir', 'worktrees', 'lanes.json')], [join('.git', 'info', 'exclude'), 'git-info-exclude']]
      : run.scenario === 'worktree-watch'
        ? [[join('.weir', 'worktrees', 'lanes.json'), join('.weir', 'worktrees', 'lanes.json')]]
        : run.scenario === 'notify-worktree'
          ? [[join('.weir', 'worktrees', 'lanes.json'), join('.weir', 'worktrees', 'lanes.json')], ['notify-delivery.log', 'notify-delivery.log']]
        : run.scenario === 'worktree-auto-approve'
          ? [[join('.weir', 'worktrees', 'lanes.json'), join('.weir', 'worktrees', 'lanes.json')]]
        : run.scenario === 'zombie-lane' || run.scenario === 'lane-resumable'
          ? [[join('.weir', 'worktrees', 'lanes.json'), join('.weir', 'worktrees', 'lanes.json')]]
        : run.scenario.startsWith('editlock-stop-')
          ? (() => {
            const boundary = run.scenario.slice('editlock-stop-'.length)
            return [join('.weir', `edit-lock-${boundary}`, 'snapshot.json'), join(`stop-${boundary}`, 'stop-target.txt'), `unrelated-${boundary}.txt`].map(path => [path, path])
          })()
          : []
    for (const [relative, stored] of extras) {
      const source = join(WS, relative)
      if (!existsSync(source)) continue
      mkdirSync(dirname(join(dir, 'ws', stored)), { recursive: true })
      copyFileSync(source, join(dir, 'ws', stored))
    }
    const auditLog = join(WS, '.weir', 'audit.jsonl')
    if (existsSync(auditLog)) {
      mkdirSync(join(dir, 'ws', '.weir'), { recursive: true })
      copyFileSync(auditLog, join(dir, 'ws', '.weir', 'audit.jsonl'))
    }
    writeFileSync(
      join(dir, 'run.json'),
      JSON.stringify({ scenario: run.scenario, home: HOME, code: run.code, stdout: run.stdout, stderr: run.stderr, sessionId: run.sessionId ?? null }, null, 2) + '\n',
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
