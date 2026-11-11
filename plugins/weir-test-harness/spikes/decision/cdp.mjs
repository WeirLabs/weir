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
  const inputPackets = []
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
    if (method.startsWith('Input.')) inputPackets.push({ id, at: Date.now(), method, params })
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
  await request('Runtime.enable')
  await request('Page.enable')
  return {
    target, events, inputPackets, request,
    async evaluate(expression) {
      const result = await request('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true })
      if (result.exceptionDetails) throw new Error(JSON.stringify({ expression, exceptionDetails: result.exceptionDetails }))
      return result.result?.value
    },
    async screenshot(path) {
      const result = await request('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
      writeFileSync(path, Buffer.from(result.data, 'base64'))
    },
    async chooseDefaultWorkspace(onCredit = null) {
      const activate = async labels => {
        const target = await this.evaluate(`(() => { const labels=${JSON.stringify(labels)}; const items=[...document.querySelectorAll('button,[role="button"],[role="menuitem"]')].filter(e=>e.offsetParent!==null&&labels.includes(e.textContent.trim())); const el=items.at(-1); if(!el)return null; const rect=el.getBoundingClientRect(); return {tag:el.tagName,text:el.textContent.trim(),x:rect.left+rect.width/2,y:rect.top+rect.height/2} })()`)
        if (!target) return null
        await request('Input.dispatchMouseEvent', { type: 'mouseMoved', x: target.x, y: target.y })
        await request('Input.dispatchMouseEvent', { type: 'mousePressed', x: target.x, y: target.y, button: 'left', buttons: 1, clickCount: 1 })
        await request('Input.dispatchMouseEvent', { type: 'mouseReleased', x: target.x, y: target.y, button: 'left', buttons: 0, clickCount: 1 })
        return target
      }
      const onboarding = await this.evaluate(`Boolean(document.querySelector('[data-desktop-onboarding]'))`)
      if (!onboarding) return { onboarding: false, selection: await activate(['默认工作区', 'default-workspace']) }
      const start = await activate(['开始设置', 'Start setup', 'Get started'])
      let selection = null
      let creditDismissed = false
      await waitFor(async () => {
        const credit = await this.evaluate(`Boolean(document.querySelector('[data-desktop-onboarding="credit"]'))`)
        if (credit) {
          if (!onCredit) return null
          await onCredit()
          creditDismissed = true
        } else if (!selection) {
          selection = await activate(['默认工作区', 'default-workspace'])
        }
        const remaining = await this.evaluate(`Boolean(document.querySelector('[data-desktop-onboarding]'))`)
        return !remaining && (selection || creditDismissed) ? true : null
      }, 30_000)
      return { onboarding: true, start, selection, creditDismissed, dismissed: true }
    },
    async submit(text) {
      const focused = await this.evaluate(`(() => { const items=[...document.querySelectorAll('textarea,[contenteditable="true"]')].filter(e=>e.offsetParent!==null); const el=items.at(-1); if(!el)return false; el.focus(); return true })()`)
      if (!focused) throw new Error('no visible composer input')
      await request('Input.insertText', { text })
      await request('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
      await request('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 })
    },
    async measureViewport(rectSelectors = {}) {
      return this.evaluate(`(() => {
        const selectors=${JSON.stringify(rectSelectors)}
        const toRect=el=>{if(!el)return null;const value=el.getBoundingClientRect();return {x:value.x,y:value.y,left:value.left,top:value.top,width:value.width,height:value.height,right:value.right,bottom:value.bottom}}
        return {
          innerWidth,innerHeight,devicePixelRatio,
          visualViewport:visualViewport?{width:visualViewport.width,height:visualViewport.height,scale:visualViewport.scale,offsetLeft:visualViewport.offsetLeft,offsetTop:visualViewport.offsetTop}:{width:innerWidth,height:innerHeight,scale:1,offsetLeft:0,offsetTop:0},
          rects:Object.fromEntries(Object.entries(selectors).map(([name,selector])=>[name,toRect(document.querySelector(selector))])),
        }
      })()`)
    },
    async setViewport(width, height = 900, mobile = false) {
      const acknowledgment = await request('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile })
      return { method: 'Emulation.setDeviceMetricsOverride', width, height, deviceScaleFactor: 1, mobile, acknowledgment }
    },
    async setPageZoom(scale = 1) {
      const acknowledgment = await request('Emulation.setPageScaleFactor', { pageScaleFactor: scale })
      await waitFor(() => this.evaluate(`Math.abs((visualViewport?.scale ?? 1) - ${JSON.stringify(scale)}) < 0.01`), 10_000)
      return { method: 'Emulation.setPageScaleFactor', pageScaleFactor: scale, acknowledgment }
    },
    async setColorScheme(scheme) {
      if (!['light', 'dark'].includes(scheme)) throw new Error(`unsupported color scheme: ${scheme}`)
      await request('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] })
      await waitFor(() => this.evaluate(`matchMedia('(prefers-color-scheme: ${scheme})').matches`), 10_000)
    },
    async key(key, modifiers = 0) {
      const codes = { Enter: 13, Escape: 27, Tab: 9, Space: 32, ArrowDown: 40, ArrowUp: 38, PageDown: 34, PageUp: 33, Home: 36, End: 35 }
      const letter = /^[a-z]$/i.test(key)
      const virtualKey = codes[key] ?? (letter ? key.toUpperCase().charCodeAt(0) : key.charCodeAt(0))
      const code = key === 'Space' ? 'Space' : letter ? `Key${key.toUpperCase()}` : key
      const selectAll = letter && key.toLowerCase() === 'a' && modifiers === 4
      const type = selectAll || key === 'Tab' || key === 'Escape' || key.startsWith('Arrow') || /^Page(?:Down|Up)$/.test(key) || key === 'Home' || key === 'End' ? 'rawKeyDown' : 'keyDown'
      const event = { key: key === 'Space' ? ' ' : key, code, windowsVirtualKeyCode: virtualKey, nativeVirtualKeyCode: virtualKey, modifiers }
      const text = { Enter: '\r', Space: ' ' }[key]
      await request('Input.dispatchKeyEvent', { type, ...event, ...(selectAll ? { commands: ['SelectAll'] } : {}), ...(text ? { text, unmodifiedText: text } : {}) })
      await request('Input.dispatchKeyEvent', { type: 'keyUp', ...event })
    },
    async accessibility(selector) {
      const { root } = await request('DOM.getDocument', { depth: 0 })
      const { nodeId } = await request('DOM.querySelector', { nodeId: root.nodeId, selector })
      if (!nodeId) throw new Error(`Accessibility target not found: ${selector}`)
      const { node } = await request('DOM.describeNode', { nodeId })
      const { nodes } = await request('Accessibility.getFullAXTree')
      const byId = new Map(nodes.map(item => [item.nodeId, item]))
      const target = nodes.find(item => item.backendDOMNodeId === node.backendNodeId)
      if (!target) throw new Error(`Accessibility target has no full-tree node: ${selector} backendDOMNodeId=${node.backendNodeId}`)
      const subtree = []
      const visit = id => {
        const item = byId.get(id)
        if (!item) throw new Error(`Accessibility subtree child is missing: ${selector} nodeId=${id}`)
        subtree.push(item)
        for (const childId of item.childIds ?? []) visit(childId)
      }
      visit(target.nodeId)
      return subtree.map(item => ({ nodeId: item.nodeId, backendDOMNodeId: item.backendDOMNodeId ?? null, role: item.role?.value ?? null, name: item.name?.value ?? null, ignored: item.ignored === true, properties: Object.fromEntries((item.properties ?? []).map(property => [property.name, property.value?.value])) }))
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
