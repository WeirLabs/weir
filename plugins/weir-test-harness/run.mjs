// Integration driver for weir-harness: boots a real headless DSH runtime
// (bundled node + a discovered dsh CLI) with a scripted mock LLM, runs one
// scenario per invocation, and asserts on the mock trace, the durable session
// log, and fixture files. Dev-only; writes everything under the IT_ROOT below.
//
// Scenarios come from the registry (src/scenarios/index.js): this driver is
// generic — it enumerates the registry, injects each scenario's prompt, runs
// its optional run override, and replays its assert on a pre-parsed run view.
//
//   node run.mjs [scenario ...]     (default: all)
//
// Runtime override (the mechanism for verifying a DSH version OTHER than the
// installed app — e.g. the 0.2.1 npm tree while the desktop app stays on
// 0.2.0):
//   WEIR_IT_NODE      node binary used for pnpm + the headless boot
//   WEIR_IT_DSH       the dsh CLI entry (lib/bin.js) of the tree under test
//   WEIR_IT_DSH_EXEC  a self-contained CLI launcher (desktop runtime/cli/bin/dsh),
//                     spawned directly instead of NODE + WEIR_IT_DSH
//   WEIR_IT_PNPM      pnpm entry used to install the profile
// Each defaults to the installed app's bundled toolchain, so the normal dev
// loop is unchanged and no version-specific path is ever hardcoded here.
// With neither dsh variable set the launcher is AUTO-DISCOVERED by
// src/launcher.js (the extracted /tmp/dsh-src reference first, then the desktop
// app's CLI), so a machine with the app installed needs no override at all.
// When no candidate exists the run exits up front listing every path it tried —
// never one `node <missing bin.js>` → MODULE_NOT_FOUND per scenario.
// Native-addon caveat: a TeamID-signed bundled node cannot dlopen npm native
// addons, so a foreign npm tree is normally verified with a plain nvm node
// (WEIR_IT_NODE) while the CLI resolves its own packages from WEIR_IT_DSH.
import { execFileSync, execFile } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { makeRunView } from './src/run-view.js'
import { SCENARIOS, byId } from './src/scenarios/index.js'
import { defaultItRoot } from './src/it-root.js'
import { resolveDshLauncher } from './src/launcher.js'
import { LOCK_NAME, acquireRunLock, releaseRunLock } from './src/run-lock.js'
import { makeVerdicts } from './src/run-verdict.js'

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
// The dsh launcher is resolved once, in main(), by src/launcher.js: explicit
// env overrides first, then platform discovery. No volatile path is hardcoded
// here — /tmp/dsh-src is one candidate among several, not a requirement.
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
// The lease broker's endpoint for this run (edit-lock-rebuild 3.8): the daemon
// reads WEIR_EDITLOCKD_SOCKET and the client half honours the same variable, so
// BOTH sides move to this run-private socket. Without it a headless boot would
// dial (and possibly spawn against) the machine-level arbiter in os.tmpdir(),
// i.e. the test would arbitrate against a real user's sessions.
//
// The path is deliberately NOT under RUN_ROOT: a unix socket address is limited
// to the platform's `sun_path` (~104 bytes on macOS), and a lane/worktree root
// already spends most of that budget (the bind then fails with EINVAL). A short
// digest of RUN_ROOT keeps every run on its own endpoint while staying
// universally addressable.
const LEASE_SOCKET = process.platform === 'win32'
  ? `\\\\.\\pipe\\weir-it-lease-${createHash('sha256').update(RUN_ROOT).digest('hex').slice(0, 12)}`
  : join(tmpdir(), `weir-it-lease-${createHash('sha256').update(RUN_ROOT).digest('hex').slice(0, 12)}.sock`)
process.env.WEIR_EDITLOCKD_SOCKET = LEASE_SOCKET

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
  // Unlink any residual socket file: the address is outside RUN_ROOT, so the
  // wipe above cannot have removed it, and a daemon left over from an
  // interrupted run must never answer for this one.
  rmSync(LEASE_SOCKET, { force: true })
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
  // The eight-boot rename case owns a separate management domain. Seed from
  // literals and source, never from shared /ws fixtures mutated by earlier LSP.
  const rename = join(WS, 'editlock-lsp-rename')
  mkdirSync(rename, { recursive: true })
  writeFileSync(join(rename, 'probe.ts'), 'export const fixtureSymbol = 1\n')
  writeFileSync(join(rename, 'probe-other.ts'), 'import { fixtureSymbol } from "./probe"\r\nexport const useIt = fixtureSymbol + 1\r\n')
  copyFileSync(join(HERE, 'src', 'mock-lsp-server.js'), join(rename, 'mock-lsp-server.js'))
}

// ---------- spawn skeleton ----------

/** Boot one headless run of the CLI; resolves with { code, stdout, stderr }. */
// Resolved once, in main(), by src/launcher.js — before any scenario starts, so
// a missing CLI is one actionable error instead of a MODULE_NOT_FOUND per run.
// `kind: 'exec'` spawns the launcher itself (self-contained, no node prefix);
// `kind: 'node'` boots NODE on the CLI entry (the WEIR_IT_DSH semantics).
let launcher = null

function spawnHeadless(args, env) {
  if (launcher === null) throw new Error('spawnHeadless: the dsh launcher has not been resolved yet')
  const [command, argv] = launcher.kind === 'exec' ? [launcher.path, args] : [NODE, [launcher.path, ...args]]
  return new Promise((resolvePromise) => {
    execFile(
      command,
      argv,
      { cwd: env.WEIR_IT_LSP_RENAME === '1' ? join(WS, 'editlock-lsp-rename') : (env.WEIR_IT_LSP_UNCERTAIN === '1' ? join(WS, 'editlock-lsp-uncertain') : (env.WEIR_IT_SANDBOX_NARROW === '1' ? join(WS, 'editlock-hashline-negatives', 'narrow') : WS)), env, timeout: 240_000, maxBuffer: 16 * 1024 * 1024 },
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
    // Run-private lease endpoint (both halves read it): no scenario may ever
    // arbitrate against the machine-level socket in os.tmpdir().
    WEIR_EDITLOCKD_SOCKET: LEASE_SOCKET,
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
  writeFileSync(join(PROFILE, 'cordis.patch.yml'), hostControl
    ? `- id: skill-filesystem\n  disabled: false\n  config:\n    customSkillDirs:\n      - ${JSON.stringify(join(WS, 'skill-roots'))}\n- id: tool-skill\n  disabled: false\n- id: weir-it-tool-skill\n  disabled: true\n`
    : '[]\n')
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

/** The context handed to a scenario's optional run override (rehydrate, filelease-*). */
const driverCtx = { IT_ROOT: RUN_ROOT, WS_ROOT, spawnHeadless, scenarioEnv, runPresetDelegationSurface }

// ---------- assertion collection ----------

// PASS/FAIL/SKIP verdict vocabulary (design D1): SKIP reports an absent
// OPTIONAL environment capability with evidence — counted and displayed, never
// failing the suite; only FAIL decides a non-zero exit code.
const { check, skip, summarize } = makeVerdicts()

// The dual-preset replay needs only request shapes and assert-consumed Host facts.
// In particular, do not freeze runtime-context messages or the full skills
// catalog (which may include unrelated private skill descriptions).
function minimalDualReport(report) {
  const receipt = value => ({ status: value.status, revision: value.revision, effective: { skills: value.effective.skills }, warnings: value.warnings })
  const owner = value => ({
    id: value.id, commandAfterBoth: receipt(value.commandAfterBoth), remoteAfterBoth: receipt(value.remoteAfterBoth),
    listAfterBoth: { skills: value.listAfterBoth.skills.map(skill => ({ name: skill.name, selected: skill.selected }))
      .filter(skill => skill.selected || skill.name === `only-${value.id === 'weir' ? 'weir-creative' : 'weir'}`) },
    conditionsAfterBoth: value.conditionsAfterBoth, presetsAfterBoth: value.presetsAfterBoth, defaultAfterBoth: value.defaultAfterBoth,
    commandEventsAfter: value.commandEventsAfter, commandEventsFinal: value.commandEventsFinal,
    projectionLive: { source: value.projectionLive.source, headerPreset: value.projectionLive.headerPreset, projectedPreset: value.projectionLive.projectedPreset },
  })
  const p = report.projection
  return {
    orders: report.orders.map(order => ({ order: order.order, owners: order.owners.map(owner) })),
    projection: {
      beforeSelect: { projectedPreset: p.beforeSelect.projectedPreset },
      afterSelect: { headerPreset: p.afterSelect.headerPreset, projectedPreset: p.afterSelect.projectedPreset },
      remoteAfterSelect: { status: p.remoteAfterSelect.status, effective: { skills: p.remoteAfterSelect.effective.skills } },
      coldRemote: { status: p.coldRemote.status, effective: { skills: p.coldRemote.effective.skills } },
      liveLong: { eventCount: p.liveLong.eventCount },
      coldLong: { eventCount: p.coldLong.eventCount, source: p.coldLong.source, headerPreset: p.coldLong.headerPreset, projectedPreset: p.coldLong.projectedPreset },
      coldRepeat: { source: p.coldRepeat.source },
    },
    leasesReleased: report.leasesReleased,
  }
}
/** Copy one scenario's replay fixture (trace + run meta + post-run ws files). */
function recordRun(run) {
  if (!RECORD_DIR) return
  try {
    const dir = join(RECORD_DIR, run.scenario)
    mkdirSync(join(dir, 'ws'), { recursive: true })
    if (existsSync(run.trace)) {
      if (run.scenario === 'capability-remote-dual-preset') {
        const requests = readFileSync(run.trace, 'utf8').trim().split('\n').map(line => JSON.parse(line)).filter(row => Array.isArray(row.emitted))
        writeFileSync(join(dir, 'trace.jsonl'), requests.map(row => JSON.stringify(row)).join('\n') + '\n')
      } else copyFileSync(run.trace, join(dir, 'trace.jsonl'))
    }
    if (run.trace2 && existsSync(run.trace2)) copyFileSync(run.trace2, join(dir, 'trace2.jsonl'))
    // capstore-*.json: the capability-store probe reports (capstore scenario);
    // apply-transaction.json: the Apply-transaction probe report (task 4.7);
    // cold-session-*.json/txt: the cold-session probe reports and the captured
    // contender writer-held failure (task 5.5).
    for (const file of run.scenario === 'capability-remote-dual-preset'
      ? ['capability-dual-preset.json']
      : ['blackboard-orphan-owner.json', 'blackboard-orphan-observed.json', 'fixture.txt', 'probe.ts', 'probe-other.ts', 'locked.txt', 'capstore-host.json', 'capstore-realm.json', 'apply-transaction.json', 'cold-session-seed.json', 'cold-session-open.json', 'cold-session-held-error.txt', 'lifecycle-report.json', 'lifecycle-catalog.json', 'capability-fork-report.json', 'mcp-gateway-report.json', 'mcp-management-report.json', 'capability-remote-log.json', 'mcp-calls.jsonl', 'mcp-server-log.jsonl', 'preset-defaults-report.json', 'preset-boot2-outcome.json', 'docs/spikes.md', ...['off', 'leak', 'host', 'office', 'migration'].map(mode => `skill-composition-${mode}.json`)]) {
      const source = join(WS, file)
      if (existsSync(source)) {
        // The blackboard-promotion scenario lands a nested durable doc.
        mkdirSync(dirname(join(dir, 'ws', file)), { recursive: true })
        if (run.scenario === 'capability-remote-dual-preset') {
          writeFileSync(join(dir, 'ws', file), JSON.stringify(minimalDualReport(JSON.parse(readFileSync(source, 'utf8'))), null, 2) + '\n')
        } else copyFileSync(source, join(dir, 'ws', file))
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
          : []
    for (const [relative, stored] of extras) {
      const source = join(WS, relative)
      if (!existsSync(source)) continue
      mkdirSync(dirname(join(dir, 'ws', stored)), { recursive: true })
      copyFileSync(source, join(dir, 'ws', stored))
    }
    const auditLog = join(WS, '.weir', 'audit.jsonl')
    if (run.scenario !== 'capability-remote-dual-preset' && existsSync(auditLog)) {
      mkdirSync(join(dir, 'ws', '.weir'), { recursive: true })
      copyFileSync(auditLog, join(dir, 'ws', '.weir', 'audit.jsonl'))
    }
    writeFileSync(
      join(dir, 'run.json'),
      JSON.stringify({ scenario: run.scenario, home: run.scenario === 'capability-remote-dual-preset' ? null : HOME, code: run.code, stdout: run.stdout, stderr: run.stderr, sessionId: run.sessionId ?? null }, null, 2) + '\n',
    )
  } catch (error) {
    console.log(`[record:${run.scenario}] ${String(error?.message ?? error)}`)
  }
}

async function main() {
  // Resolve the dsh launcher FIRST: with a volatile candidate path, a missing
  // CLI used to surface as one MODULE_NOT_FOUND per scenario with an empty
  // requireStack. Now it is a single actionable message, before setup() wipes
  // the IT root and long before any scenario boots.
  try {
    launcher = resolveDshLauncher()
  } catch (error) {
    console.error(error?.message ?? String(error))
    process.exit(1)
  }
  console.log(`[setup] dsh launcher: ${launcher.source} -> ${launcher.path} (${launcher.kind})`)
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
    scenario.assert(makeRunView(run, { ws: WS, check: (label, ok, detail) => check(scenario.id, label, ok, detail), skip: (label, detail) => skip(scenario.id, label, detail) }))
  }
  process.exit(summarize().exitCode)
}

await main()
