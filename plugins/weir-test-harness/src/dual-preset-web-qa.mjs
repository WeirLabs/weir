// Repro: bundled-node src/dual-preset-web-qa.mjs run --root <FRESH absolute
// lane-local directory>. Uses the installed dsh CLI, its shipped Web template,
// an isolated DSH_HOME per order, and a fresh loopback port (never 19387).
// The only product calls are authenticated POST /api/weirCapabilities/*.
import * as fs from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../../..')
const cli = process.env.WEIR_DUAL_WEB_DSH_EXEC ?? '/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh'
export const methods = ['receipt', 'list', 'conditions', 'presets', 'defaultGet']
export const orders = [['weir', 'weir-creative'], ['weir-creative', 'weir']]
export function checkFreshRoot(root) {
  if (!root || !isAbsolute(root) || root !== resolve(root) || !root.startsWith(`${repo}${sep}`)) throw new Error('QA root must be absolute and lane-local')
  // lstat (not existsSync) rejects even a broken symlink or preexisting file.
  try { fs.lstatSync(root); throw new Error('QA root already exists; never overwrite or delete it') }
  catch (error) { if (error?.code !== 'ENOENT') throw error }
  const parent = fs.realpathSync.native(dirname(root))
  const lane = fs.realpathSync.native(repo)
  if (parent !== lane && !parent.startsWith(`${lane}${sep}`)) throw new Error('QA root parent escapes lane')
  return root
}
export function compare(report) {
  const failures = []
  if (report.orders.length !== 2) failures.push('both mount orders must be observed')
  for (const entry of report.orders) {
    if (Object.keys(entry.owners ?? {}).sort().join(',') !== 'weir,weir-creative') failures.push(`${entry.order.join('>')}: two exact owners missing`)
    if (!entry.rejected?.missing || !entry.rejected?.foreign) failures.push(`${entry.order.join('>')}: missing and foreign owner requests not observed`)
    for (const [id, owner] of Object.entries(entry.owners)) {
      const target = `only-${id}`
      const command = owner.commands.receipt
      if (!(command?.status === 'applied' && command.revision === 1 && command.effective?.skills?.includes(target))) failures.push(`${entry.order.join('>')}/${id}: owning command did not select ${target}`)
      if (owner.headerPreset !== id || owner.projectedPreset !== id) failures.push(`${entry.order.join('>')}/${id}: preset projection not owner`)
      for (const method of methods) {
        const remote = owner.http?.[method]
        if (remote?.status !== 200 || !remote.ok) failures.push(`${entry.order.join('>')}/${id}/${method}: HTTP gateway failed (${remote?.status ?? 'missing'}, ${remote?.error?.code ?? 'unknown'})`)
        else if (JSON.stringify(remote.value) !== JSON.stringify(owner.commands[method])) failures.push(`${entry.order.join('>')}/${id}/${method}: remote differs from owning command`)
      }
      if (JSON.stringify(owner.eventsBefore) !== JSON.stringify(owner.eventsAfter)) failures.push(`${entry.order.join('>')}/${id}: read-created command events`)
    }
    if (entry.authDenied?.status !== 401) failures.push(`${entry.order.join('>')}: unauthenticated gateway request was not rejected`)
    for (const [kind, methodsResult] of Object.entries(entry.rejected ?? {})) {
      for (const method of methods) {
        const result = methodsResult[method]
        // Typert intentionally wraps ordinary service exceptions as
        // gateway/internal; assert its explicit owner failure MESSAGE, not a
        // nonexistent promise that CapabilityReadError.code crosses the wire.
        if (result?.status !== 200 || result.ok !== false || typeof result.error?.message !== 'string' || !/capability read|owner/i.test(result.error.message)) failures.push(`${entry.order.join('>')}/${kind}/${method}: missing owner refusal`)
      }
    }
    const coldOwner = entry.owners.weir
    if (entry.cold?.source !== 'prepared' || entry.cold.headerPreset !== 'weir' || entry.cold.projectedPreset !== 'weir') failures.push(`${entry.order.join('>')}: cold projection lost weir owner`)
    if (entry.cold?.http?.status !== 200 || entry.cold.http.ok !== true || JSON.stringify(entry.cold.http.value) !== JSON.stringify(coldOwner.commands.receipt)) failures.push(`${entry.order.join('>')}: cold gateway receipt differs from owning command`)
    if (JSON.stringify(entry.cold?.commandEvents) !== JSON.stringify(entry.cold?.eventsAfter) || JSON.stringify(entry.cold?.commandEvents) !== JSON.stringify(coldOwner.eventsBefore)) failures.push(`${entry.order.join('>')}: cold read-created command events`)
  }
  return failures
}
function execute(args, env) {
  const result = spawnSync(cli, args, { env, cwd: repo, encoding: 'utf8', timeout: 90000, maxBuffer: 16 * 1024 * 1024 })
  if (result.error || result.status !== 0) throw new Error(`installed CLI ${args.slice(0, 5).join(' ')} failed: ${String(result.stderr ?? result.error ?? '').slice(-600)}`)
  return result.stdout
}
async function freePort() {
  const server = createServer()
  await new Promise((yes, no) => server.once('error', no).listen(0, '127.0.0.1', yes))
  const port = server.address().port
  await new Promise(done => server.close(done))
  if (port === 19387) throw new Error('refusing primary GUI port')
  return port
}
function pause(ms) { return new Promise(done => setTimeout(done, ms)) }
async function stop(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return
  child.kill('SIGTERM')
  await Promise.race([new Promise(done => child.once('exit', done)), pause(10000)])
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL')
    await new Promise(done => child.once('exit', done))
  }
}
function unpack(body) {
  if (body?.type === 'server-response') {
    if (body.result?.ok === true) return { ok: true, value: body.result.value }
    return { ok: false, error: body.result?.error ?? { code: 'gateway-error' } }
  }
  if (body?.type === 'server-error') return { ok: false, error: body.result?.error ?? { code: 'gateway-error' } }
  if (body?.ok === true && 'value' in body) return { ok: true, value: body.value }
  if (body?.payload?.ok === true) return { ok: true, value: body.payload.value }
  return { ok: false, error: body?.error ?? { code: 'unexpected-envelope', shape: Object.keys(body ?? {}) } }
}
async function runOrder(root, order, index) {
  const home = join(root, `home-${index}`)
  fs.mkdirSync(home, { recursive: true })
  const profile = `weir-dual-web-qa-${index}`
  const env = { ...process.env, DSH_HOME: home, WEIR_DUAL_WEB_ROOT: root,
    WEIR_DUAL_WEB_SOURCE: here, WEIR_DUAL_WEB_ORDER: order.join(',') }
  execute(['--profile', profile, '--from-default-profile', 'web', '--dump-config'], env)
  execute(['plugin', '--profile', profile, 'add', join(repo, 'plugins/weir-harness')], env)
  const port = await freePort()
  const base = `http://127.0.0.1:${port}`
  const child = spawn(cli, ['--profile', profile, '--patch', join(here, 'dual-preset-web.patch.yml'),
    '--no-open', '--host', '127.0.0.1', '--port', String(port)], { env, cwd: root, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = '', secret = '', cookie = '', ready = false
  // Never persist raw stdout: the CLI launch URL contains a fresh token.
  const capture = chunk => { output = (output + chunk.toString()).slice(-60000) }
  child.stdout.on('data', capture)
  child.stderr.on('data', capture)
  try {
    const deadline = Date.now() + 60000
    while (Date.now() < deadline) {
      const match = /dsh web: (http:\/\/\S+)/.exec(output)
      if (match) {
        const launch = new URL(match[1])
        if (launch.origin !== base || !launch.searchParams.get('token')) throw new Error('server advertised wrong origin or no test token')
        secret = launch.searchParams.get('token')
        const response = await fetch(launch, { redirect: 'manual' })
        cookie = response.headers.get('set-cookie')?.split(';', 1)[0] ?? ''
        if (!cookie || response.status !== 303) throw new Error(`isolated Web login failed: ${response.status}`)
        ready = true
        break
      }
      if (child.exitCode !== null || child.signalCode !== null) throw new Error(`isolated Web exited before URL (code=${child.exitCode}, signal=${child.signalCode})`)
      await pause(200)
    }
    if (!ready) throw new Error('isolated Web readiness timeout; no launch URL')
    const headers = { cookie, origin: base, 'content-type': 'application/json' }
    const state = async (action = {}) => {
      const res = await fetch(`${base}/api/weir-dual-qa/state`, { method: 'POST', headers, body: JSON.stringify(action) })
      if (res.status !== 200) throw new Error(`QA observer HTTP ${res.status}`)
      return res.json()
    }
    let snapshot
    const deadline2 = Date.now() + 60000
    while (Date.now() < deadline2) {
      snapshot = await state()
      if (snapshot.phase === 'failed') throw new Error(`QA bootstrap failed: ${snapshot.error}`)
      if (snapshot.phase === 'ready') break
      await pause(250)
    }
    if (snapshot?.phase !== 'ready') throw new Error('QA bootstrap timed out')
    const gateway = async (method, sessionId, authorized = true) => {
      const endpoint = `weirCapabilities/${method}`
      const res = await fetch(`${base}/api/${endpoint}`, { method: 'POST', headers: authorized ? headers : { origin: base, 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method: endpoint, payload: { args: { sessionId } } }) })
      const text = await res.text()
      let body
      try { body = JSON.parse(text) } catch { body = { error: { code: 'non-json-body', prefix: text.slice(0, 100) } } }
      return { status: res.status, ...unpack(body) }
    }
    const authDenied = await gateway('receipt', snapshot.owners.weir.sessionId, false)
    for (const owner of Object.values(snapshot.owners)) {
      owner.http = {}
      for (const method of methods) owner.http[method] = await gateway(method, owner.sessionId)
    }
    const rejected = {}
    for (const [kind, sessionId] of Object.entries({ missing: randomUUID(), foreign: snapshot.foreignSessionId })) {
      rejected[kind] = {}
      for (const method of methods) rejected[kind][method] = await gateway(method, sessionId)
    }
    const after = await state()
    for (const [id, owner] of Object.entries(snapshot.owners)) owner.eventsAfter = after.owners[id]?.eventsAfter
    const cold = await state({ action: 'cold', owner: 'weir' })
    const coldReceipt = await gateway('receipt', snapshot.owners.weir.sessionId)
    const coldAfter = await state()
    return { order, profile, port, url: base, owners: snapshot.owners, rejected, authDenied,
      cold: { ...cold.cold, http: coldReceipt, eventsAfter: coldAfter.cold?.commandEvents } }
  } finally {
    // Persist only a redacted server diagnostic. Never write raw launch output.
    const sanitized = output.replace(/([?&]token=)[^&\s]+/g, '$1[redacted]').split(secret || '\0').join('[redacted]')
    // Teardown precedes even diagnostic I/O so a full disk cannot strand Web.
    output = ''; cookie = ''; secret = ''
    await stop(child)
    fs.writeFileSync(join(root, `server-${index}.log`), sanitized)
    // A killed launcher cannot be assumed to have closed its listening socket.
    const check = Date.now() + 10000
    while (Date.now() < check) {
      try { await fetch(base, { signal: AbortSignal.timeout(500) }) } catch { break }
      await pause(200)
    }
    try { await fetch(base, { signal: AbortSignal.timeout(500) }); throw new Error(`isolated Web port ${port} still listening`) }
    catch (error) { if (!/fetch failed|TimeoutError|timed out/i.test(String(error))) throw error }
  }
}
export async function run(root) {
  checkFreshRoot(root)
  assert.equal(fs.existsSync(cli), true, 'installed DSH CLI is missing')
  fs.mkdirSync(root)
  const report = { root, cli, orders: [], failures: [] }
  try {
    for (let i = 0; i < orders.length; i++) report.orders.push(await runOrder(root, orders[i], i))
    report.failures = compare(report)
  } catch (error) { report.failures.push(`BLOCKED fixture: ${String(error?.message ?? error)}`) }
  // No auth material is returned, printed or stored; only status/payloads and
  // session event types are retained under the checked disposable test root.
  fs.writeFileSync(join(root, 'report.json'), JSON.stringify(report, null, 2))
  for (const entry of report.orders) {
    console.log(`isolated Web ${entry.url} profile=${entry.profile} root=${root}`)
    for (const [id, owner] of Object.entries(entry.owners)) {
      const receipt = owner.http.receipt
      console.log(`${entry.order.join('>')} ${id}: command=${owner.commands.receipt.status}/${owner.commands.receipt.revision}/${owner.commands.receipt.effective?.skills?.length} HTTP=${receipt.status}/${receipt.value?.status ?? receipt.error?.code}/${receipt.value?.revision ?? '-'}/${receipt.value?.effective?.skills?.length ?? '-'} warnings=${JSON.stringify(receipt.value?.warnings ?? [])} commandEvents=${owner.eventsBefore.length}->${owner.eventsAfter?.length}`)
    }
  }
  for (const failure of report.failures) console.log(`RED ${failure}`)
  console.log(`report ${join(root, 'report.json')}; all isolated Web processes stopped`)
  return report
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] !== 'run' || process.argv[3] !== '--root' || !process.argv[4]) {
    console.error('usage: dual-preset-web-qa.mjs run --root <fresh absolute lane-local directory>')
    process.exitCode = 2
  } else run(process.argv[4]).then(report => { process.exitCode = report.failures.length ? 1 : 0 }, error => {
    console.error(`QA refused before creating root: ${error.message}`)
    process.exitCode = 2
  })
}
