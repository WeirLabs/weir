// Disposable P0-S3 driver: boot the actual dsh-desktop-host entry twice against
// a lane-local temporary profile; SIGKILL the first host with an open transaction.
import { spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANE = resolve(HERE, '../../../..')
const OUT = join(LANE, '.weir', 'decision-spikes', 'S3')
const HOME = join(OUT, 'home')
const PROFILE = join(HOME, 'profiles', 'desktop')
const PLUGIN = join(HERE, 'sqlite-host-plugin.js')
const BINARY = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
const RESOURCES = '/Applications/DeepSeek Harness.app/Contents/Resources'
const DSH = join(RESOURCES, 'app.asar', 'dsh')
const HOST = join(DSH, 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'index.js')
const RUNTIME = join(RESOURCES, 'runtime', 'primary-runtime')
const PNPM = join(RUNTIME, 'dependencies', 'pnpm', 'bin', 'pnpm.mjs')
const RUNTIME_BIN = join(RESOURCES, 'runtime', 'bin')

function writeJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n')
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function sleep(ms) {
  return new Promise(resolvePromise => setTimeout(resolvePromise, ms))
}

async function waitFor(path, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (existsSync(path)) return
    if (existsSync(join(OUT, 'fatal.json'))) throw new Error(readFileSync(join(OUT, 'fatal.json'), 'utf8'))
    if (child.exitCode !== null || child.signalCode !== null) throw new Error(`host exited before ${path}: code=${child.exitCode} signal=${child.signalCode}`)
    await sleep(50)
  }
  throw new Error(`timed out waiting for ${path}`)
}

function stop(child) {
  return new Promise(resolvePromise => {
    if (child.exitCode !== null || child.signalCode !== null) return resolvePromise()
    child.once('exit', () => resolvePromise())
    child.kill('SIGTERM')
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }, 3000).unref()
  })
}

function hostArgs() {
  return ['--expose-internals', HOST, DSH, PROFILE, RUNTIME, PNPM, RUNTIME_BIN]
}

async function boot(phase, logName) {
  const log = createWriteStream(join(OUT, logName))
  const args = hostArgs()
  const child = spawn(BINARY, args, {
    cwd: LANE,
    env: {
      ...process.env,
      DSH_HOME: HOME,
      DSH_CLIENT_VERSION: '0.2.2-rc.1',
      ELECTRON_RUN_AS_NODE: '1',
      WEIR_DECISION_SPIKE_ROOT: OUT,
      WEIR_DECISION_SPIKE_PHASE: phase,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  child.stdout.pipe(log)
  child.stderr.pipe(log)
  return { child, args, log }
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  for (const target of [HOME, join(OUT, 'profile-meta')]) {
    const resolved = resolve(target)
    if (resolved !== target || !resolved.startsWith(`${OUT}/`)) throw new Error(`refusing cleanup outside S3: ${resolved}`)
    rmSync(resolved, { recursive: true, force: true })
  }
  for (const name of ['env.json', 'busy.json', 'crash.json', 'migrate.json', 'timing.json', 'crash-ready.json', 'recovery-done.json', 'fatal.json']) {
    rmSync(join(OUT, name), { force: true })
  }
  mkdirSync(PROFILE, { recursive: true })
  writeJson(join(PROFILE, 'package.json'), {
    name: 'dsh-profile-decision-s3', private: true,
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } },
  })
  writeFileSync(join(PROFILE, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  writeFileSync(join(PROFILE, 'cordis.patch.yml'), `${JSON.stringify([
    { id: 'desktop-product-telemetry', disabled: true },
    { id: 'product-analytics', disabled: true },
    { insert: [{ id: 'weir-decision-s3', name: PLUGIN }] },
  ], null, 2)}\n`)

  const first = await boot('main', 'main-host.log')
  let firstExit
  try {
    await waitFor(join(OUT, 'crash-ready.json'), first.child)
    const ready = readJson(join(OUT, 'crash-ready.json'))
    if (ready.pid !== first.child.pid) throw new Error(`crash-ready pid ${ready.pid} != spawned host ${first.child.pid}`)
    first.child.kill('SIGKILL')
    firstExit = await new Promise(resolvePromise => first.child.once('exit', (code, signal) => resolvePromise({ code, signal })))
  } finally {
    first.log.end()
  }

  const second = await boot('recovery', 'recovery-host.log')
  try {
    await waitFor(join(OUT, 'recovery-done.json'), second.child)
  } finally {
    await stop(second.child)
    second.log.end()
  }

  const names = ['env.json', 'busy.json', 'crash.json', 'migrate.json', 'timing.json']
  const evidence = Object.fromEntries(names.map(name => [name, readJson(join(OUT, name))]))
  const crash = evidence['crash.json']
  crash.firstHostExit = firstExit
  crash.firstHostKilledWithSigkill = firstExit?.signal === 'SIGKILL'
  crash.pass = crash.pass === true && crash.firstHostKilledWithSigkill
  writeJson(join(OUT, 'crash.json'), crash)
  const pass = names.every(name => evidence[name].pass === true) && crash.pass === true
  const report = {
    spike: 'S3', pass,
    command: `${BINARY} ${hostArgs().join(' ')}`,
    environment: { DSH_HOME: HOME, WEIR_DECISION_SPIKE_PHASE: ['main', 'recovery'], ELECTRON_RUN_AS_NODE: '1 (required by the real dsh-desktop-host child entry; this is runProfile, not a standalone node script)' },
    profile: PROFILE,
    files: names,
    firstExit,
    secondHostExit: { code: second.child.exitCode, signal: second.child.signalCode },
  }
  writeJson(join(OUT, 'driver.json'), report)
  console.log(JSON.stringify(report, null, 2))
  if (!pass) process.exitCode = 1
}

main().catch(error => {
  writeJson(join(OUT, 'driver-error.json'), { message: error?.message ?? String(error), stack: error?.stack ?? null })
  console.error(error)
  process.exitCode = 1
})
