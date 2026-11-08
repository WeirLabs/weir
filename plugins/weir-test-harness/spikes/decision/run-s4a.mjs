// P0-S4a real Desktop GUI driver: temporary profile + actual Electron App + CDP.
import { execFileSync, spawn } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectCdp, waitFor } from './cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANE = resolve(HERE, '../../../..')
const FIXTURE = join(HERE, 'desktop-fixture')
const OUT = join(LANE, '.weir', 'decision-spikes', 'S4a')
const HOME = join(OUT, 'home')
const PROFILE = join(HOME, 'profiles', 'desktop')
const ELECTRON_DATA = join(OUT, 'electron-data')
const BINARY = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
const PNPM = '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/primary-runtime/dependencies/pnpm/bin/pnpm.mjs'
const PORT = 9437

function writeJson(file, value) {
  writeFileSync(join(OUT, file), JSON.stringify(value, null, 2) + '\n')
}

function stop(app) {
  return new Promise(resolvePromise => {
    if (!app || app.exitCode !== null || app.signalCode !== null) return resolvePromise()
    app.once('exit', () => resolvePromise())
    app.kill('SIGTERM')
    setTimeout(() => {
      if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL')
    }, 5000).unref()
  })
}

async function main() {
  mkdirSync(OUT, { recursive: true })
  for (const target of [HOME, ELECTRON_DATA]) {
    const resolved = resolve(target)
    if (resolved !== target || !resolved.startsWith(`${OUT}/`)) throw new Error(`refusing cleanup outside S4a: ${resolved}`)
    rmSync(resolved, { recursive: true, force: true })
  }
  for (const file of ['slot-tree.json', 'slot-tree-before.json', 'slot-tree-after.json', 'remount.json', 'panel.png', 'driver-error.json', 'host-mounted.json', 'workspace-ready.json']) rmSync(join(OUT, file), { force: true })
  mkdirSync(PROFILE, { recursive: true })
  writeFileSync(join(PROFILE, 'package.json'), JSON.stringify({
    name: 'dsh-profile-decision-s4a', private: true,
    dependencies: { 'weir-decision-desktop-spike': `link:${FIXTURE}` },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'weir-decision-desktop-spike'] } },
  }, null, 2) + '\n')
  writeFileSync(join(PROFILE, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  writeFileSync(join(PROFILE, 'cordis.patch.yml'), '[]\n')
  execFileSync(process.execPath, [PNPM, 'install', '--reporter', 'silent'], { cwd: PROFILE, stdio: 'inherit' })

  const args = [`--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1', `--user-data-dir=${ELECTRON_DATA}`]
  const log = createWriteStream(join(OUT, 'desktop.log'))
  const appEnv = {
    ...process.env,
    DSH_HOME: HOME,
    DSH_AGENTS_HOME: join(OUT, 'agents-home'),
    DSH_CLIENT_VERSION: '0.2.2-rc.1',
    WEIR_IT_SCENARIO: 'decision-spike-slots',
    WEIR_IT_DECISION_SPIKES: '1',
    WEIR_IT_ROOT: join(OUT, 'it-root'),
    WEIR_IT_TRACE: join(OUT, 'trace.jsonl'),
    WEIR_DECISION_DESKTOP_OUT: OUT,
  }
  delete appEnv.ELECTRON_RUN_AS_NODE
  delete appEnv.NODE_CHANNEL_FD
  const app = spawn(BINARY, args, {
    cwd: LANE,
    env: appEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  app.stdout.pipe(log)
  app.stderr.pipe(log)
  let cdp = null
  try {
    await waitFor(() => existsSync(join(OUT, 'host-mounted.json')), 60_000)
    await waitFor(() => existsSync(join(HOME, 'storages', 'workspace.json')), 60_000)
    cdp = await waitFor(async () => {
      try { return await connectCdp(PORT) } catch { return null }
    }, 60_000)
    await waitFor(() => cdp.evaluate('Boolean(window.__decisionSpike)'), 60_000)
    const initial = await cdp.evaluate('window.__decisionSpike.getState()')
    const workspaceSelection = await cdp.chooseDefaultWorkspace()
    await waitFor(() => cdp.evaluate('Boolean([...document.querySelectorAll(\'textarea,[contenteditable="true"]\')].find(e=>e.offsetParent!==null))'), 10_000)
    await cdp.submit('decision-spike-slots-probe')
    await waitFor(() => existsSync(join(OUT, 'slot-tree-before.json')), 60_000)
    const beforeRemount = await cdp.evaluate('window.__decisionSpike.getState()')
    const afterRemount = await cdp.evaluate('window.__decisionSpike.remount()')
    const remountPass = afterRemount.mounts === beforeRemount.mounts + 1 && !afterRemount.lastError && afterRemount.sidebar.some(entry => entry.id === 'weir-decision-spike') && afterRemount.main.some(entry => entry.key === 'weir-decision-spike') && afterRemount.composer.some(entry => entry.id === 'weir-decision-spike-selector') && typeof afterRemount.lastComposerSessionId === 'string'
    writeJson('remount.json', {
      spike: 'S4a', initial, beforeRemount, afterRemount,
      workspaceSelection,
      selectPanelMechanism: 'ctx.layout.selectPanel',
      composerInjectReceivedSession: typeof afterRemount.lastComposerSessionId === 'string',
      pass: remountPass,
    })

    await cdp.submit('decision-spike-slots-probe-after')
    await waitFor(() => existsSync(join(OUT, 'slot-tree.json')), 60_000)
    const selected = await cdp.evaluate('(() => { window.__decisionSpike.selectPanel(); return window.__decisionSpike.getState() })()')
    await waitFor(() => cdp.evaluate('document.getElementById("decision-spike-page")?.textContent?.includes("Decision spike panel")'), 10_000)
    await cdp.screenshot(join(OUT, 'panel.png'))
    const slotTree = JSON.parse(readFileSync(join(OUT, 'slot-tree.json'), 'utf8'))
    const beforeText = JSON.stringify(slotTree.before)
    const afterText = JSON.stringify(slotTree.after)
    const slotsPass = ['weir-decision-spike', 'weir-decision-spike-selector'].every(id => beforeText.includes(id) && afterText.includes(id))
    const pass = remountPass && slotsPass && selected.activePanelId === 'weir-decision-spike' && existsSync(join(OUT, 'panel.png'))
    writeJson('driver.json', {
      spike: 'S4a', pass, command: `${BINARY} ${args.join(' ')}`,
      profile: PROFILE, cdpTarget: cdp.target, selected,
      slotInspectionPresentBeforeAfter: slotsPass,
      screenshot: 'panel.png', runtimeEvents: cdp.events.filter(event => ['Runtime.exceptionThrown', 'Runtime.consoleAPICalled'].includes(event.method)),
    })
    console.log(JSON.stringify({ spike: 'S4a', pass, files: ['slot-tree.json', 'remount.json', 'panel.png'] }, null, 2))
    if (!pass) process.exitCode = 1
  } catch (error) {
    writeJson('driver-error.json', { message: error?.message ?? String(error), stack: error?.stack ?? null })
    if (cdp) {
      await cdp.screenshot(join(OUT, 'failure.png')).catch(() => {})
      writeJson('cdp-state-on-error.json', { events: cdp.events.filter(event => ['Runtime.exceptionThrown', 'Runtime.consoleAPICalled'].includes(event.method)) })
    }
    console.error(error)
    process.exitCode = 1
  } finally {
    cdp?.close()
    await stop(app)
    log.end()
  }
}

main().catch(error => {
  console.error(error)
  process.exitCode = 1
})
