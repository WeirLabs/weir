// Non-restart current-Desktop P0 driver. NEVER terminates or restarts the App.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { connectCdp, waitFor } from './cdp.mjs'

const HERE = import.meta.dirname
const LANE = resolve(HERE, '../../../..')
const OUT = join(LANE, '.weir', 'decision-spikes', 'current-desktop')
mkdirSync(OUT, { recursive: true })
const write = (file, value) => writeFileSync(join(OUT, file), JSON.stringify(value, null, 2) + '\n')

async function main() {
  const phase = process.argv[2] ?? 'smoke'
  const cdp = await connectCdp(Number(process.env.DECISION_CDP_PORT ?? 9442))
  const click = id => cdp.evaluate(`(() => { const el=document.getElementById(${JSON.stringify(id)}); if(!el)return false; el.click(); return true })()`)
  const state = () => cdp.evaluate('window.__decisionP0.getState()')
  await waitFor(() => cdp.evaluate('Boolean(window.__decisionP0)'), 30_000)
  if (phase === 'smoke') {
    await cdp.evaluate('window.__decisionP0.selectPanel()')
    await waitFor(() => cdp.evaluate('document.getElementById("decision-p0-page") !== null'), 10_000)
    await cdp.screenshot(join(OUT, 'panel-smoke.png'))
    if (!await click('decision-p0-create-answered')) throw new Error('create-answered control missing')
    await waitFor(async () => (await state()).created.answered, 30_000)
    const current = await state()
    write('smoke.json', { phase, state: current, pass: typeof current.created.answered === 'string' })
    console.log(JSON.stringify(current, null, 2))
  } else if (phase === 'state') {
    console.log(JSON.stringify(await state(), null, 2))
  } else if (phase === 'inspect-dom') {
    const id = process.argv[3]
    const result = await cdp.evaluate(`(() => { const id=${JSON.stringify(id)}; return [...document.querySelectorAll('*')].filter(el=>el.id===id||[...el.attributes].some(a=>a.value.includes(id))||(el.children.length===0&&el.textContent.includes(id))).map(el=>({tag:el.tagName,id:el.id,attrs:Object.fromEntries([...el.attributes].map(a=>[a.name,a.value])),text:el.textContent.slice(0,200)})).slice(0,30) })()`)
    console.log(JSON.stringify(result, null, 2))
  } else {
    throw new Error(`unknown non-restart phase ${phase}`)
  }
  cdp.close()
}

main().catch(error => {
  write('nonrestart-driver-error.json', { message: error?.message ?? String(error), stack: error?.stack ?? null })
  console.error(error)
  process.exitCode = 1
})
