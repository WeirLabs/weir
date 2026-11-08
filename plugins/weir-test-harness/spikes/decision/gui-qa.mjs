// Real isolated Desktop QA for Decision P1. Only the spawned child PIDs are
// signalled; this script never addresses the user's App or the old P0 instance.
import { spawn, execFileSync } from 'node:child_process'
import { createWriteStream, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { connectCdp, waitFor } from './cdp.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const LANE = resolve(HERE, '../../../..')
const QA = join(LANE, '.weir', 'decision-qa')
const FIXTURE = join(HERE, 'gui-fixture')
const WEIR = join(LANE, 'plugins', 'weir-harness')
const BINARY = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'
const PNPM = process.env.WEIR_DECISION_PNPM ?? '/Users/young/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs'
const PHASES = { a: 9462, b: 9463, c: 9464 }

function writeJson(path, value) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'))
}

function guardedRemove(target, expected) {
  const resolved = resolve(target)
  if (resolved !== resolve(expected) || !resolved.startsWith(`${resolve(QA)}${sep}`)) {
    throw new Error(`Refusing QA cleanup outside the checked Decision QA root: ${resolved}`)
  }
  rmSync(resolved, { recursive: true, force: true })
}

function prepareProfile(root, port) {
  const home = join(root, 'home')
  const profile = join(home, 'profiles', 'desktop')
  const electronData = join(root, 'electron-data')
  mkdirSync(profile, { recursive: true })
  mkdirSync(electronData, { recursive: true })
  writeJson(join(profile, 'package.json'), {
    name: `dsh-profile-decision-gui-${port}`,
    private: true,
    dependencies: {
      'weir-harness': `link:${WEIR}`,
      'weir-decision-gui-fixture': `link:${FIXTURE}`,
    },
    dsh: { profile: { bundles: [
      '@deepseek-ai/dsh-base',
      '@deepseek-ai/dsh-web-app',
      'weir-harness',
      'weir-decision-gui-fixture',
    ] } },
  })
  writeFileSync(join(profile, 'pnpm-workspace.yaml'), 'packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n')
  writeFileSync(join(profile, 'cordis.patch.yml'), '[]\n')
  execFileSync(process.execPath, [PNPM, 'install', '--reporter', 'silent'], { cwd: profile, stdio: 'inherit' })
  return { home, profile, electronData }
}

function appEnvironment(paths, out, enabled) {
  const env = {
    PATH: process.env.PATH ?? '/usr/bin:/bin:/usr/sbin:/sbin',
    HOME: process.env.HOME ?? paths.home,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    TMPDIR: process.env.TMPDIR,
    DSH_HOME: paths.home,
    DSH_AGENTS_HOME: join(paths.home, 'agents-home'),
    WEIR_IT_SCENARIO: 'decision-gui',
    WEIR_IT_DECISION_GUI: '1',
    WEIR_IT_ROOT: join(out, 'it-root'),
    WEIR_IT_TRACE: join(out, 'mock-trace.jsonl'),
    WEIR_DECISION_GUI_OUT: out,
    WEIR_DECISION_GUI_ENABLED: enabled ? '1' : '0',
  }
  for (const key of Object.keys(env)) if (env[key] === undefined) delete env[key]
  return env
}

async function stopInstance(instance, receiptPath) {
  if (!instance) return null
  const { app, cdp, paths, out, port } = instance
  let host = null
  if (cdp) {
    host = await cdp.evaluate('window.__decisionQA?.fixture("hostState", {})').catch(() => null)
  }
  if (!host && existsSync(join(out, 'host.json'))) host = readJson(join(out, 'host.json'))
  const identity = {
    spawnedPid: app.pid,
    hostPid: host?.pid,
    hostParentPid: host?.parentPid,
    expectedHome: paths.home,
    hostHome: host?.profile?.home,
    hostProfile: host?.profile?.name,
    port,
  }
  const hostOwnedByApp = host && (host.pid === app.pid || host.parentPid === app.pid)
  if (host && (!hostOwnedByApp || host.profile?.home !== paths.home || host.profile?.name !== 'desktop')) {
    throw new Error(`Refusing to stop an unverified Desktop process: ${JSON.stringify(identity)}`)
  }
  if (!host && app.exitCode === null && app.signalCode === null) {
    const processArgs = execFileSync('ps', ['-p', String(app.pid), '-o', 'args='], { encoding: 'utf8' })
    identity.processArgs = processArgs.trim()
    if (!processArgs.includes(BINARY) || !processArgs.includes(`--user-data-dir=${paths.electronData}`) || !processArgs.includes(`--remote-debugging-port=${port}`)) {
      throw new Error(`Refusing to stop a process without Host or argv ownership evidence: ${JSON.stringify(identity)}`)
    }
  }
  const stopped = new Promise(resolveExit => {
    if (app.exitCode !== null || app.signalCode !== null) return resolveExit()
    app.once('exit', () => resolveExit())
    app.kill('SIGTERM')
    const timer = setTimeout(() => {
      if (app.exitCode === null && app.signalCode === null) app.kill('SIGKILL')
    }, 8000)
    timer.unref()
  })
  await stopped
  cdp?.close()
  instance.log.end()
  const receipt = { ...identity, exitCode: app.exitCode, signalCode: app.signalCode, stopped: true }
  writeJson(receiptPath, receipt)
  return receipt
}

async function startInstance({ root, out, port, enabled }) {
  const paths = {
    home: join(root, 'home'),
    profile: join(root, 'home', 'profiles', 'desktop'),
    electronData: join(root, 'electron-data'),
  }
  mkdirSync(out, { recursive: true })
  const log = createWriteStream(join(out, `desktop-${enabled ? 'enabled' : 'disabled'}.log`), { flags: 'a' })
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
    `--user-data-dir=${paths.electronData}`,
  ]
  const app = spawn(BINARY, args, {
    cwd: LANE,
    env: appEnvironment(paths, out, enabled),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  app.stdout.pipe(log)
  app.stderr.pipe(log)
  const instance = { app, log, paths, out, port, cdp: null, args }
  writeJson(join(out, 'instance.json'), { mainPid: app.pid, port, home: paths.home, profile: paths.profile, electronData: paths.electronData, args })
  try {
    await waitFor(() => {
      if (!existsSync(join(out, 'host.json'))) return null
      const host = readJson(join(out, 'host.json'))
      return (host.pid === app.pid || host.parentPid === app.pid) && host.profile?.home === paths.home ? host : null
    }, 90_000)
    const cdp = await waitFor(async () => {
      try { return await connectCdp(port) } catch { return null }
    }, 90_000)
    instance.cdp = cdp
    await waitFor(() => cdp.evaluate('Boolean(window.__decisionQA)'), 90_000)
    const workspaceSelection = await cdp.chooseDefaultWorkspace()
    writeJson(join(out, 'workspace-selection.json'), workspaceSelection)
    return instance
  } catch (error) {
    await cdpScreenshot(instance, join(out, 'startup-failure.png')).catch(() => {})
    await stopInstance(instance, join(out, 'startup-cleanup.json')).catch(() => {})
    throw error
  }
}

async function cdpScreenshot(instance, path) {
  if (instance?.cdp) await instance.cdp.screenshot(path)
}

async function decision(instance, sessionId, method, args = {}) {
  const transport = await instance.cdp.evaluate(`window.__decisionQA.decision(${JSON.stringify(method)}, ${JSON.stringify({ sessionId, ...args })})`)
  const service = transport?.value
  if (!transport || transport.ok !== true || service?.ok === false) throw new Error(`Decision ${method} failed: ${JSON.stringify(service?.error ?? transport?.error ?? transport)}`)
  return service?.ok === true ? service.value : service
}

function composerVisible(instance) {
  return instance.cdp.evaluate(`Boolean([...document.querySelectorAll('textarea,[contenteditable="true"]')].find(el => el.offsetParent !== null))`)
}

async function createSession(instance, cwd = LANE) {
  const created = await instance.cdp.evaluate(`window.__decisionQA.createSession(${JSON.stringify({ cwd, prompt: 'GUI_SESSION_BOOTSTRAP' })})`)
  if (!created?.sessionId) throw new Error(`Session creation failed: ${JSON.stringify(created)}`)
  await waitFor(() => composerVisible(instance), 60_000)
  await waitFor(() => instance.cdp.evaluate('Boolean(document.querySelector("select[data-weir-decision-selector]"))'), 60_000)
  return created
}

async function openSession(instance, sessionId) {
  await waitFor(async () => {
    try {
      await instance.cdp.evaluate(`window.__decisionQA.openSession(${JSON.stringify(sessionId)})`)
      return true
    } catch { return null }
  }, 60_000)
  await waitFor(() => composerVisible(instance), 60_000)
  await waitFor(() => instance.cdp.evaluate('Boolean(document.querySelector("select[data-weir-decision-selector]"))'), 60_000)
}

async function setInput(instance, selector, value) {
  const result = await instance.cdp.evaluate(`(() => {
    const el = document.querySelector(${JSON.stringify(selector)})
    if (!el) return false
    const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return true
  })()`)
  if (!result) throw new Error(`Input not found: ${selector}`)
}

async function click(instance, selector) {
  const result = await instance.cdp.evaluate(`(() => { const el=document.querySelector(${JSON.stringify(selector)}); if(!el)return false; el.click(); return true })()`)
  if (!result) throw new Error(`Click target not found: ${selector}`)
}

async function clickButton(instance, labels, scope = 'main') {
  const result = await instance.cdp.evaluate(`(() => {
    const labels=${JSON.stringify(labels)}
    const root=document.querySelector(${JSON.stringify(scope)}) ?? document
    const el=[...root.querySelectorAll('button')].find(button=>button.offsetParent!==null&&labels.includes(button.textContent.trim()))
    if(!el)return null
    el.click()
    return el.textContent.trim()
  })()`)
  if (!result) throw new Error(`Button not found: ${labels.join('/')} in ${scope}`)
  return result
}

async function selectDecisionTab(instance, index) {
  await instance.cdp.evaluate('window.__decisionQA.selectDecisions()')
  await waitFor(() => instance.cdp.evaluate('document.querySelectorAll("main nav button").length === 4'), 30_000)
  await instance.cdp.evaluate(`document.querySelectorAll("main nav button")[${index}].click()`)
}

async function createAgent(instance, sessionId, name, description) {
  await selectDecisionTab(instance, 0)
  await setInput(instance, 'input[aria-label="Agent name"]', name)
  await setInput(instance, 'textarea[aria-label="User description"]', description)
  await clickButton(instance, ['Save', '保存'])
  const agents = await waitFor(async () => {
    const value = await decision(instance, sessionId, 'agents')
    return value.some(agent => agent.name === name) ? value : null
  }, 30_000)
  return agents.find(agent => agent.name === name)
}

async function setSelector(instance, sessionId, mode, agentId) {
  const value = mode === 'off' ? 'off' : agentId
  const changed = await instance.cdp.evaluate(`(() => {
    const el=document.querySelector('select[data-weir-decision-selector]')
    if(!el)return false
    const proto=HTMLSelectElement.prototype
    Object.getOwnPropertyDescriptor(proto,'value').set.call(el,${JSON.stringify(value)})
    el.dispatchEvent(new Event('change',{bubbles:true}))
    return true
  })()`)
  if (!changed) throw new Error('Decision selector is not rendered')
  return waitFor(async () => {
    const current = await decision(instance, sessionId, 'overview')
    return current.selector?.mode === mode && (mode === 'off' || current.selector?.agentId === agentId) ? current.selector : null
  }, 30_000)
}

async function selectorState(instance) {
  return instance.cdp.evaluate(`(() => {
    const el=document.querySelector('select[data-weir-decision-selector]')
    return el ? {value:el.value,disabled:el.disabled,options:[...el.options].map(option=>({value:option.value,label:option.textContent}))} : null
  })()`)
}

async function submitMarker(instance, marker) {
  await instance.cdp.submit(marker)
}

async function records(instance, sessionId, filter) {
  return decision(instance, sessionId, 'records', filter ? { filter } : {})
}

async function findCase(instance, sessionId, marker) {
  const page = await records(instance, sessionId)
  return page.records.find(item => item.request?.questions?.some(question => question.id === marker || String(question.question).includes(marker)))
}

async function waitCase(instance, sessionId, marker, predicate = () => true) {
  return waitFor(async () => {
    const current = await findCase(instance, sessionId, marker)
    return current && predicate(current) ? current : null
  }, 90_000)
}

async function exportRecord(instance, sessionId, caseId, path) {
  const detail = await decision(instance, sessionId, 'record', { caseId })
  if (!detail?.case) throw new Error(`No authoritative record for ${caseId}`)
  writeJson(path, detail)
  return detail
}

async function cardState(instance, caseId) {
  return instance.cdp.evaluate(`(() => {
    const card=document.querySelector('[data-weir-decision-card=${JSON.stringify(caseId)}]')
    const visible=el=>Boolean(el&&el.offsetParent!==null)
    const nativeControls=[...document.querySelectorAll('button,[role="button"],[role="radio"],input[type="radio"]')]
      .filter(visible).filter(el=>/submit|next|提交|下一题/i.test(el.textContent||el.getAttribute('aria-label')||''))
      .map(el=>({tag:el.tagName,text:el.textContent,aria:el.getAttribute('aria-label')}))
    const pendingNative=Boolean([...document.querySelectorAll('[data-question-key]')].find(visible))
    return card ? {visible:visible(card),text:card.innerText,nativeControls,pendingNative} : {visible:false,nativeControls,pendingNative,bodyText:document.body.innerText.slice(-12000)}
  })()`)
}

function runtimeProblems(instance) {
  return instance.cdp.events.filter(event => event.method === 'Runtime.exceptionThrown')
}

async function runA() {
  const root = join(QA, 'desktop-a')
  const out = join(QA, 'gui-a')
  guardedRemove(root, join(QA, 'desktop-a'))
  guardedRemove(out, join(QA, 'gui-a'))
  mkdirSync(out, { recursive: true })
  prepareProfile(root, PHASES.a)
  let instance = await startInstance({ root, out, port: PHASES.a, enabled: true })
  const checks = {}
  try {
    const session = await createSession(instance)
    const sessionId = session.sessionId
    writeJson(join(out, 'session.json'), session)
    const slots = await instance.cdp.evaluate('window.__decisionQA.getState()')
    writeJson(join(out, 'slots.json'), slots)
    checks.slotSurfaces = slots.sidebar.includes('weir-decisions') && slots.main.includes('weir-decisions') && slots.composer.includes('weir-decision-selector') && slots.toolviews.includes('ask_user_question') && slots.toolviews.includes('decision_consult')

    const agent = await createAgent(instance, sessionId, 'GUI-A Concise', 'For GUI title questions in this workspace, choose Concise when it is an offered option. This is a user-authored P1 profile, not generated memory.')
    writeJson(join(out, 'agent.json'), agent)
    await openSession(instance, sessionId)
    const off = await setSelector(instance, sessionId, 'off')
    checks.offImmediate = off.mode === 'off'
    await cdpScreenshot(instance, join(out, 'selector-off.png'))
    const pinned = await setSelector(instance, sessionId, 'agent', agent.agentId)
    checks.agentImmediate = pinned.agentId === agent.agentId
    const options = await selectorState(instance)
    writeJson(join(out, 'selector-options.json'), options)
    checks.onlyOffAndAgent = options.options.length === 2 && options.options.some(option => option.value === 'off') && options.options.some(option => option.value === agent.agentId) && !options.options.some(option => /auto/i.test(option.label) || /auto/i.test(option.value))
    await cdpScreenshot(instance, join(out, 'selector-agent.png'))

    await submitMarker(instance, 'GUI_A_ANSWER')
    const answered = await waitCase(instance, sessionId, 'gui-a-answer', current => current.state === 'closed')
    checks.answered = answered.closing === 'answered' && answered.decision?.answers?.[0]?.selected?.[0] === 'Concise'
    const detail = await exportRecord(instance, sessionId, answered.caseId, join(out, 'record-gui-a-answer.json'))
    checks.answerHasEvidence = detail.attempts.some(attempt => attempt.outcome === 'answer' && attempt.evidence.length > 0 && attempt.gates && ['g1','g2','g3','g4','g5','g6','g7'].every(gate => attempt.gates[gate] === true))
    const cardLookup = await decision(instance, sessionId, 'caseForCall', { questions: detail.case.request.questions })
    writeJson(join(out, 'case-for-call.json'), cardLookup)
    checks.caseForCall = cardLookup?.case?.caseId === answered.caseId
    const card = await waitFor(async () => {
      const value = await cardState(instance, answered.caseId)
      return value.visible ? value : null
    }, 30_000)
    writeJson(join(out, 'card-state.json'), card)
    checks.decisionCard = card.text.includes(agent.name) && /answered/.test(card.text) && /Evidence|证据/.test(card.text) && /Revision|记录版本/.test(card.text) && /Upvote|赞/.test(card.text) && /Downvote|踩/.test(card.text) && /Comment|评论/.test(card.text) && /Correct|纠正/.test(card.text)
    checks.noNativePendingComposer = !card.pendingNative && card.nativeControls.length === 0
    await cdpScreenshot(instance, join(out, 'answered-card.png'))
    await instance.cdp.evaluate(`(() => { const card=document.querySelector('[data-weir-decision-card=${JSON.stringify(answered.caseId)}] details'); if(card){card.open=true;card.dispatchEvent(new Event('toggle'))} })()`)
    await cdpScreenshot(instance, join(out, 'answered-evidence.png'))

    const firstPid = instance.app.pid
    const firstCleanup = await stopInstance(instance, join(out, 'restart-1-cleanup.json'))
    instance = null
    checks.firstProcessStopped = firstCleanup.stopped === true
    instance = await startInstance({ root, out, port: PHASES.a, enabled: true })
    checks.restartNewPid = instance.app.pid !== firstPid
    await openSession(instance, sessionId)
    const restored = await waitFor(async () => {
      const value = await selectorState(instance)
      return value?.value === agent.agentId ? value : null
    }, 30_000)
    checks.selectorRestored = restored.value === agent.agentId
    await cdpScreenshot(instance, join(out, 'selector-restarted.png'))
    const recovered = await exportRecord(instance, sessionId, answered.caseId, join(out, 'record-after-restart.json'))
    checks.recordRecovered = recovered.case.caseId === answered.caseId && recovered.case.closing === 'answered'
    const scan = await instance.cdp.evaluate(`window.__decisionQA.fixture('scanSession', ${JSON.stringify({ sessionId })})`)
    writeJson(join(out, 'session-scan.json'), scan)
    checks.noCommandOrCustomEvents = scan.commandEvents.length === 0 && scan.customDecisionEvents.length === 0
    const logText = readFileSync(join(out, 'desktop-enabled.log'), 'utf8')
    checks.newExportsActivated = !/failed to import weir-harness\/decision/.test(logText)
    checks.noRuntimeExceptions = runtimeProblems(instance).length === 0
    writeJson(join(out, 'runtime-events.json'), instance.cdp.events)
    const pass = Object.values(checks).every(Boolean)
    writeJson(join(out, 'result.json'), { phase: 'GUI-A', pass, checks, sessionId, caseId: answered.caseId, agentId: agent.agentId })
    console.log(JSON.stringify({ phase: 'GUI-A', pass, checks }, null, 2))
    if (!pass) process.exitCode = 1
  } catch (error) {
    writeJson(join(out, 'driver-error.json'), { message: error?.message ?? String(error), stack: error?.stack ?? null, checks })
    if (instance?.cdp) {
      await cdpScreenshot(instance, join(out, 'failure.png')).catch(() => {})
      writeJson(join(out, 'failure-dom.json'), await instance.cdp.evaluate('({text:document.body.innerText,html:document.body.innerHTML})').catch(() => null))
      writeJson(join(out, 'runtime-events.json'), instance.cdp.events)
    }
    console.error(error)
    process.exitCode = 1
  } finally {
    if (instance) await stopInstance(instance, join(out, 'final-cleanup.json'))
  }
}

export {
  LANE, QA, PHASES, writeJson, readJson, guardedRemove, prepareProfile,
  startInstance, stopInstance, cdpScreenshot, decision, createSession, openSession,
  setInput, click, clickButton, selectDecisionTab, createAgent, setSelector,
  selectorState, submitMarker, records, findCase, waitCase, exportRecord, cardState,
  runtimeProblems, composerVisible,
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const phase = process.argv[2]
  if (phase !== 'a') {
    console.error('Usage: node gui-qa.mjs a')
    process.exitCode = 2
  } else {
    await runA()
  }
}
