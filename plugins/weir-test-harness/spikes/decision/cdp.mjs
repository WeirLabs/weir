// Minimal CDP driver for a real Electron Desktop page. No mock DOM or renderer.
import { writeFileSync } from 'node:fs'

export async function connectCdp(port) {
  const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()
  const target = targets.find(item => item.type === 'page')
  if (!target) throw new Error(`no CDP page target: ${JSON.stringify(targets)}`)
  const ws = new WebSocket(target.webSocketDebuggerUrl)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', reject, { once: true })
  })
  let nextId = 1
  const pending = new Map()
  const events = []
  ws.addEventListener('message', event => {
    const message = JSON.parse(String(event.data))
    if (message.id) {
      const entry = pending.get(message.id)
      if (!entry) return
      pending.delete(message.id)
      if (message.error) entry.reject(new Error(JSON.stringify(message.error)))
      else entry.resolve(message.result)
    } else {
      events.push(message)
    }
  })
  const request = (method, params = {}) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  await request('Runtime.enable')
  await request('Page.enable')
  return {
    target, events, request,
    async evaluate(expression) {
      const result = await request('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails))
      return result.result?.value
    },
    async screenshot(path) {
      const result = await request('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
      writeFileSync(path, Buffer.from(result.data, 'base64'))
    },
    async chooseDefaultWorkspace() {
      return this.evaluate(`(() => { const labels=['默认工作区','default-workspace']; const items=[...document.querySelectorAll('button,[role="button"],[role="menuitem"]')].filter(e=>e.offsetParent!==null&&labels.includes(e.textContent.trim())); const el=items.at(-1); if(!el)return null; el.click(); return {tag:el.tagName,text:el.textContent.trim()} })()`)
    },
    async submit(text) {
      const focused = await this.evaluate(`(() => { const items=[...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(e=>e.offsetParent!==null); const el=items.at(-1); if(!el)return false; el.focus(); return true })()`)
      if (!focused) throw new Error('no visible composer input')
      await request('Input.insertText', { text })
      await request('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
      await request('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    },
    close() { ws.close() },
  }
}

export async function waitFor(check, timeoutMs = 60_000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  let lastError = null
  while (Date.now() < deadline) {
    try {
      const value = await check()
      if (value) return value
    } catch (error) {
      lastError = error
    }
    await new Promise(resolve => setTimeout(resolve, intervalMs))
  }
  if (lastError) throw new Error(`waitFor timed out: ${lastError.message}`)
  throw new Error('waitFor timed out')
}
