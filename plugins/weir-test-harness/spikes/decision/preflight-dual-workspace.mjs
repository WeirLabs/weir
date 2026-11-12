// Dual-workspace preflight for the cross-workspace Decision Agent change.
//
// Boots the REAL headless DSH runtime twice inside ONE isolated profile root,
// with two different workspace directories as the session cwd, and proves the
// existing harness can persist both root sessions and both Decision selectors
// without touching the user's current App data.
//
//   node plugins/weir-test-harness/spikes/decision/preflight-dual-workspace.mjs
//
// Everything it creates lives under `<root>` (default: the lane's
// `.weir/decision-cross-workspace-memory/preflight/root`). A report with the
// actual root session ids, real workspace paths and profile database path is
// written to `<root>/../report.json`.
import { execFile, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { resolveDshLauncher } from '../../src/launcher.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const REPO = resolve(HERE, '../../../..')
const NODE = process.env.WEIR_IT_NODE ?? process.execPath
const PNPM = process.env.WEIR_IT_PNPM ?? join(homedir(), '.dsh', 'dsh-runtimes', 'dsh-primary-runtime', 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
const ROOT = process.env.WEIR_PREFLIGHT_ROOT ?? join(REPO, '.weir', 'decision-cross-workspace-memory', 'preflight', 'root')
const HOME = join(ROOT, 'home')
const PROFILE_NAME = 'weir-it'
const PROFILE = join(HOME, 'profiles', PROFILE_NAME)
const WORKSPACES = { one: join(ROOT, 'ws-one'), two: join(ROOT, 'ws-two') }
const CURRENT_APP_DATA = join(homedir(), 'Library', 'Application Support', 'DeepSeek Harness')

const problems = []
function check(label, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${detail === undefined ? '' : ` — ${typeof detail === 'string' ? detail : JSON.stringify(detail)}`}`)
  if (!ok) problems.push({ label, detail })
  return ok
}

function spawnBoot(label, cwd, trace) {
  const args = [PROFILE_NAME, 'Reply with the single word READY.']
  const [command, argv] = launcher.kind === 'exec' ? [launcher.path, args] : [NODE, [launcher.path, ...args]]
  return new Promise(resolveBoot => {
    execFile(command, argv, {
      cwd,
      timeout: 240_000,
      maxBuffer: 16 * 1024 * 1024,
      env: {
        ...process.env,
        DSH_HOME: HOME,
        WEIR_IT_ROOT: ROOT,
        WEIR_IT_SCENARIO: 'deepwork',
        WEIR_IT_TRACE: trace,
        // Default Auto for genuinely new root sessions: this is what makes the
        // Decision Broker persist one selector row per root session.
        WEIR_IT_DECISION_SELECTOR_DEFAULT: 'auto',
      },
    }, (error, stdout, stderr) => resolveBoot({ label, code: error?.code ?? 0, stdout, stderr }))
  })
}

/** Session directories encode the workspace path; the inner directory is the root session id. */
function sessionsFor(workspace) {
  const sessionsRoot = join(HOME, 'sessions')
  if (!existsSync(sessionsRoot)) return []
  const encoded = workspace.replaceAll('/', '-')
  return readdirSync(sessionsRoot)
    .filter(name => name.startsWith('--') && name.replaceAll('-', '').includes(encoded.replaceAll('-', '')))
    .flatMap(name => readdirSync(join(sessionsRoot, name)).map(id => ({ id, dir: join(sessionsRoot, name), encoded: name })))
}

function setup() {
  rmSync(ROOT, { recursive: true, force: true })
  mkdirSync(PROFILE, { recursive: true })
  mkdirSync(WORKSPACES.one, { recursive: true })
  mkdirSync(WORKSPACES.two, { recursive: true })
  writeFileSync(join(PROFILE, 'package.json'), `${JSON.stringify({
    name: 'dsh-profile-weir-preflight',
    private: true,
    dependencies: {
      'weir-harness': `link:${join(REPO, 'plugins/weir-harness')}`,
      'weir-test-harness': `link:${join(REPO, 'plugins/weir-test-harness')}`,
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'weir-test-harness'] } },
  }, null, 2)}\n`)
  writeFileSync(join(PROFILE, 'cordis.patch.yml'), '[]\n')
  writeFileSync(join(PROFILE, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  execFileSync(NODE, [PNPM, 'install', '--reporter', 'silent'], { cwd: PROFILE, stdio: 'inherit' })
}

let launcher
try {
  launcher = resolveDshLauncher()
} catch (error) {
  console.error(error?.message ?? String(error))
  process.exit(1)
}
console.log(`[setup] dsh launcher: ${launcher.source} -> ${launcher.path} (${launcher.kind})`)

setup()
check('the isolated root is outside the current App data directory', !resolve(ROOT).startsWith(resolve(CURRENT_APP_DATA)), ROOT)

const boots = [
  await spawnBoot('one', WORKSPACES.one, join(ROOT, 'trace-one.jsonl')),
  await spawnBoot('two', WORKSPACES.two, join(ROOT, 'trace-two.jsonl')),
]
for (const boot of boots) {
  check(`headless boot '${boot.label}' exits 0`, boot.code === 0, boot.stderr.trim().split('\n').slice(-4).join(' | ') || boot.code)
}

const sessions = { one: sessionsFor(WORKSPACES.one), two: sessionsFor(WORKSPACES.two) }
for (const key of ['one', 'two']) {
  check(`workspace '${key}' persisted exactly one root session`, sessions[key].length === 1, sessions[key].map(session => session.id))
}

// The profile-private Decision store: one authoritative database for the profile.
const storePath = join(HOME, 'weir', 'profiles', PROFILE_NAME, 'decisions', 'decision.db')
const storeExists = existsSync(storePath)
check('the profile Decision database was created', storeExists, storePath)
const selectors = []
let userVersion = null
if (storeExists) {
  const db = new DatabaseSync(storePath)
  userVersion = db.prepare('PRAGMA user_version').get().user_version
  selectors.push(...db.prepare('SELECT root_session_id,mode,agent_id FROM selectors ORDER BY root_session_id').all())
  db.close()
}
for (const key of ['one', 'two']) {
  const id = sessions[key][0]?.id
  const row = selectors.find(selector => selector.root_session_id === id)
  check(`workspace '${key}' root session persisted a selector`, row?.mode === 'auto', row ?? id)
}
check('both selectors live in the same profile database', selectors.length >= 2, selectors.map(row => row.root_session_id))

const report = {
  generatedAt: new Date().toISOString(),
  isolatedRoot: ROOT,
  dshHome: HOME,
  profile: PROFILE,
  profileName: PROFILE_NAME,
  dshLauncher: { kind: launcher.kind, path: launcher.path, source: launcher.source },
  workspaces: {
    one: { path: WORKSPACES.one, rootSessionId: sessions.one[0]?.id ?? null, sessionDir: sessions.one[0]?.dir ?? null },
    two: { path: WORKSPACES.two, rootSessionId: sessions.two[0]?.id ?? null, sessionDir: sessions.two[0]?.dir ?? null },
  },
  decisionDatabase: { path: storePath, userVersion, selectors },
  boots: boots.map(boot => ({ workspace: boot.label, exitCode: boot.code, stderr: boot.stderr.trim().split('\n').slice(-4) })),
  currentAppDataTouched: resolve(ROOT).startsWith(resolve(CURRENT_APP_DATA)) ? [CURRENT_APP_DATA] : [],
  problems,
}
writeFileSync(join(dirname(ROOT), 'report.json'), `${JSON.stringify(report, null, 2)}\n`)
console.log(`\nreport: ${join(dirname(ROOT), 'report.json')}`)
console.log(problems.length === 0 ? 'PREFLIGHT PASS' : `PREFLIGHT FAIL (${problems.length} problems)`)
process.exit(problems.length === 0 ? 0 : 1)
