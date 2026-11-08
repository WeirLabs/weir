// Start one persistent, lane-isolated Desktop evidence instance. This script has
// no stop/restart/kill path and never addresses the user's running DSH App.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANE = resolve(HERE, '../../../..')
const ROOT = join(LANE, '.weir', 'decision-test-instance')
const HOME = join(ROOT, 'home')
const PROFILE = join(HOME, 'profiles', 'desktop')
const ELECTRON_DATA = join(ROOT, 'electron-data')
const FIXTURE = join(HERE, 'current-profile-fixture')
const BINARY = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
const PNPM = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs'
const PORT = 9451

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

mkdirSync(PROFILE, { recursive: true })
mkdirSync(ELECTRON_DATA, { recursive: true })
writeJson(join(PROFILE, 'package.json'), {
  name: 'dsh-profile-decision-isolated',
  private: true,
  dependencies: { 'weir-decision-p0-current-profile': `link:${FIXTURE}` },
  dsh: {
    profile: {
      bundles: [
        '@deepseek-ai/dsh-base',
        '@deepseek-ai/dsh-web-app',
        'weir-decision-p0-current-profile',
      ],
    },
  },
})
writeFileSync(
  join(PROFILE, 'pnpm-workspace.yaml'),
  'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n',
)
writeFileSync(join(PROFILE, 'cordis.patch.yml'), '[]\n')

if (!existsSync(join(PROFILE, 'node_modules', 'weir-decision-p0-current-profile'))) {
  execFileSync(process.execPath, [PNPM, 'install', '--reporter', 'silent'], {
    cwd: PROFILE,
    stdio: 'inherit',
  })
}

const logPath = join(ROOT, 'desktop.log')
const logFd = openSync(logPath, 'a')
const args = [
  `--remote-debugging-port=${PORT}`,
  '--remote-debugging-address=127.0.0.1',
  `--user-data-dir=${ELECTRON_DATA}`,
]
const env = {
  ...process.env,
  DSH_HOME: HOME,
  DSH_AGENTS_HOME: join(ROOT, 'agents-home'),
  DSH_CLIENT_VERSION: '0.2.2-rc.1',
}
delete env.ELECTRON_RUN_AS_NODE
delete env.NODE_CHANNEL_FD

const app = spawn(BINARY, args, {
  cwd: LANE,
  env,
  detached: true,
  stdio: ['ignore', logFd, logFd],
})
app.unref()
writeJson(join(ROOT, 'instance.json'), {
  pid: app.pid,
  port: PORT,
  home: HOME,
  profile: PROFILE,
  electronData: ELECTRON_DATA,
  workspace: LANE,
  logPath,
  args,
  startedAt: new Date().toISOString(),
  lifecycle: 'external-test-process-only',
})
console.log(JSON.stringify({
  status: 'started',
  pid: app.pid,
  cdpPort: PORT,
  workspace: LANE,
  home: HOME,
  logPath,
}, null, 2))
