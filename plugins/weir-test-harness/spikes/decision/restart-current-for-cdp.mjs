// Authorized current-Desktop restart: preserve the CURRENT profile/authentication,
// add only CDP transport, and write proof when the real fixture responds.
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { connectCdp, waitFor } from './cdp.mjs'

const HERE = import.meta.dirname
const LANE = resolve(HERE, '../../../..')
const OUT = join(LANE, '.weir', 'decision-spikes', 'current-desktop')
const BINARY = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
const PORT = 9442
mkdirSync(OUT, { recursive: true })
const write = (file, value) => writeFileSync(join(OUT, file), JSON.stringify(value, null, 2) + '\n')
const sleep = ms => new Promise(resolvePromise => setTimeout(resolvePromise, ms))
const running = () => execFileSync('ps', ['-axo', 'pid,command'], { encoding: 'utf8' }).split('\n')
  .filter(line => line.includes(BINARY))
  .map(line => ({ pid: Number(line.trim().split(/\s+/)[0]), command: line.trim().slice(String(line.trim().split(/\s+/)[0]).length).trim() }))

async function main() {
  const before = running()
  const primary = before.find(item => item.command === BINARY)
  write('restart-request.json', { before, primaryPid: primary?.pid ?? null, authorizedCurrentProfile: true })
  if (primary) {
    execFileSync('osascript', ['-e', 'tell application id "com.deepseek.dsh" to quit'])
    await sleep(500)
    // The authorized restart has a native active-work confirmation. Click the
    // exact Quit button once through macOS Accessibility, never repeatedly.
    execFileSync('osascript', ['-e', 'tell application "System Events" to tell process "DeepSeek Harness" to click button "退出" of window 1'])
    await waitFor(() => !running().some(item => item.pid === primary.pid), 30_000)
  }
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.NODE_CHANNEL_FD
  const logFd = openSync(join(OUT, 'app-cdp.log'), 'a')
  const args = [`--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1']
  const app = spawn(BINARY, args, { cwd: LANE, env, detached: true, stdio: ['ignore', logFd, logFd] })
  app.unref()
  write('cdp-launch.json', { pid: app.pid, args, before, launchedAt: Date.now() })
  const cdp = await waitFor(async () => {
    try { return await connectCdp(PORT) } catch { return null }
  }, 60_000)
  await waitFor(() => cdp.evaluate('Boolean(window.__decisionP0)'), 90_000)
  const state = await cdp.evaluate('window.__decisionP0.getState()')
  write('cdp-ready.json', { pid: app.pid, port: PORT, target: cdp.target, state, currentProfile: 'desktop', pass: true })
  cdp.close()
}

main().catch(error => {
  write('cdp-error.json', { message: error?.message ?? String(error), stack: error?.stack ?? null, running: running() })
  process.exitCode = 1
})
