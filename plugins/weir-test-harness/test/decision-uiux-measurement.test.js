import test from 'node:test'
import assert from 'node:assert/strict'
import {
  browserZoomProblems,
  coldRevealProblems,
  masterDetailProblems,
  nativeModalProblems,
  scrollLockProblems,
  viewportMeasurementProblems,
} from '../spikes/decision/gui-product-lib.mjs'
import { createUiuxFixture } from '../spikes/decision/gui-fixture/uiux.js'

function rect(left = 16, top = 20, width = 64, height = 32) {
  return { x: left, y: top, left, top, width, height, right: left + width, bottom: top + height }
}

function viewport(width = 360, scale = 1) {
  return {
    innerWidth: width,
    innerHeight: 900,
    devicePixelRatio: 1,
    visualViewport: { width: width / scale, height: 900 / scale, scale, offsetLeft: 0, offsetTop: 0 },
    rects: { reference: rect() },
  }
}

test('UIUX fixture provides independent bilingual long status names and cold content', () => {
  const fixture = createUiuxFixture()
  assert.equal(fixture.agents.length, 3)
  assert.equal(new Set(fixture.agents.map(agent => agent.id)).size, 3)
  for (const agent of fixture.agents) {
    assert.ok(agent.name.zh.length > 24)
    assert.ok(agent.name.en.length > 40)
    assert.ok(agent.status.zh.length > 80)
    assert.ok(agent.status.en.length > 120)
    assert.notEqual(agent.status.zh, agent.status.en)
  }
  assert.ok(fixture.coldContent.zh.length >= 12)
  assert.ok(fixture.coldContent.en.length >= 12)
  assert.notDeepEqual(fixture.coldContent.zh, fixture.coldContent.en)
  const second = createUiuxFixture()
  assert.notEqual(fixture, second)
  assert.notEqual(fixture.agents, second.agents)
})

test('native modal guard requires genuine showModal top-layer semantics in the composer', () => {
  const genuine = {
    implementation: 'native-dialog', tagName: 'DIALOG', open: true, modal: true,
    ariaModal: 'true', showModalCalls: 1, showModalError: null,
    composerContainsDialog: true, focusInside: true, rect: rect(20, 30, 320, 240),
  }
  assert.deepEqual(nativeModalProblems(genuine), [])
  assert.match(nativeModalProblems({ ...genuine, modal: false }).join('\n'), /:modal/)
  assert.match(nativeModalProblems({ ...genuine, implementation: 'absolute-fallback' }).join('\n'), /native <dialog>/)
  assert.match(nativeModalProblems({ ...genuine, showModalCalls: 0, showModalError: 'unsupported' }).join('\n'), /showModal/)
  assert.match(nativeModalProblems({ ...genuine, composerContainsDialog: false }).join('\n'), /composer/)
  assert.match(nativeModalProblems({ ...genuine, rect: { ...genuine.rect, width: 0 } }).join('\n'), /rect/)
})

test('real 200 percent zoom requires the browser operation and joint viewport and CSS rect evidence', () => {
  const before = viewport(360, 1)
  const after = viewport(360, 2)
  const evidence = {
    before, after,
    operation: { method: 'Emulation.setPageScaleFactor', pageScaleFactor: 2 },
    metricsOperation: { method: 'Emulation.setDeviceMetricsOverride', width: 360, height: 900, deviceScaleFactor: 1, mobile: true },
  }
  assert.deepEqual(viewportMeasurementProblems(after, { innerWidth: 360, scale: 2, withinVisualViewport: ['reference'] }), [])
  assert.deepEqual(browserZoomProblems(evidence, 2), [])
  const scrollbarBefore = { ...before, visualViewport: { ...before.visualViewport, width: 355 } }
  const scrollbarAfter = { ...after, visualViewport: { ...after.visualViewport, width: 177.5 } }
  assert.deepEqual(viewportMeasurementProblems(scrollbarBefore, { innerWidth: 360, scale: 1 }), [], 'a real 5 CSS px scrollbar is not a zoom mismatch')
  assert.deepEqual(browserZoomProblems({ ...evidence, before: scrollbarBefore, after: scrollbarAfter }, 2), [], 'visual width still halves under real zoom when the same scrollbar is present')
  const dprOnly = { ...evidence, after: { ...after, devicePixelRatio: 2, visualViewport: before.visualViewport }, operation: { method: 'Emulation.setDeviceMetricsOverride', deviceScaleFactor: 2 } }
  assert.match(browserZoomProblems(dprOnly, 2).join('\n'), /pageScaleFactor|visualViewport\.scale/)
  assert.match(browserZoomProblems({ ...evidence, after: { ...after, rects: {} } }, 2).join('\n'), /CSS rect/)
  assert.match(browserZoomProblems({ ...evidence, after: { ...after, devicePixelRatio: null } }, 2).join('\n'), /devicePixelRatio/)
  assert.match(browserZoomProblems({ ...evidence, metricsOperation: { ...evidence.metricsOperation, mobile: false } }, 2).join('\n'), /mobile/)
})

test('scroll lock guard covers root body and nested scrollers with exact restoration', () => {
  const names = ['root', 'body', 'decisionPage', 'composer', 'session']
  const before = Object.fromEntries(names.map((name, index) => [name, {
    scrollTop: index * 11, scrollLeft: index,
    inline: { overflow: index % 2 ? 'auto' : '', overscrollBehavior: 'contain', paddingRight: '' },
  }]))
  const during = Object.fromEntries(names.map(name => [name, {
    ...before[name], inline: { overflow: 'hidden', overscrollBehavior: 'none', paddingRight: '12px' },
  }]))
  const after = Object.fromEntries(names.map(name => [name, structuredClone(before[name])]))
  assert.deepEqual(scrollLockProblems({ before, during, after }, names), [])
  assert.match(scrollLockProblems({ before, during: { ...during, session: { ...during.session, scrollTop: 999 } }, after }, names).join('\n'), /session.*moved/)
  assert.match(scrollLockProblems({ before, during, after: { ...after, composer: { ...after.composer, inline: { ...after.composer.inline, overflow: 'hidden' } } } }, names).join('\n'), /composer.*inline/)
  assert.match(scrollLockProblems({ before, during: { ...during, root: { ...during.root, inline: { ...during.root.inline, overflow: 'auto' } } }, after }, names).join('\n'), /root.*overflow/)
})

test('cold reveal guard accepts one ready or error end reveal and rejects loading focus theft or repeats', () => {
  for (const status of ['ready', 'error']) {
    const loading = { status: 'loading', revealCount: 0, targetBottom: 100, scrollerBottom: 500, scrollTop: 0, active: 'draft', draft: 'keep me' }
    const ready = { ...loading, status, revealCount: 1, targetBottom: 498, scrollerBottom: 500, scrollTop: 400, behavior: 'instant', block: 'end' }
    const refreshed = { ...ready, revealCount: 1 }
    assert.deepEqual(coldRevealProblems({ loading, ready, refreshed }), [])
    assert.match(coldRevealProblems({ loading: { ...loading, revealCount: 1 }, ready, refreshed }).join('\n'), /loading/)
    assert.match(coldRevealProblems({ loading, ready: { ...ready, revealCount: 2 }, refreshed }).join('\n'), /exactly once/)
    assert.match(coldRevealProblems({ loading, ready: { ...ready, active: 'body' }, refreshed }).join('\n'), /focus/)
    assert.match(coldRevealProblems({ loading, ready, refreshed: { ...refreshed, scrollTop: 200 } }).join('\n'), /refresh/)
    assert.match(coldRevealProblems({ loading, ready: { ...ready, behavior: 'smooth' }, refreshed }).join('\n'), /instant/)
  }
})

test('master-detail guard preserves narrow drill-in context and same-target restoration', () => {
  const context = { selectedAgentId: 'agent-long', draft: { name: '未保存 bilingual draft' }, learning: { run: 'lr-1', snapshot: 'ms-1' }, readCount: 4 }
  const desktop = { listVisible: true, detailVisible: true, independentRegions: true, horizontalOverflow: false, listRect: rect(0, 0, 280, 600), detailRect: rect(300, 0, 600, 600) }
  const narrowList = { listVisible: true, detailVisible: false, horizontalOverflow: false }
  const drillIn = { listVisible: false, detailVisible: true, horizontalOverflow: false, ...context }
  const returned = { listVisible: true, detailVisible: false, horizontalOverflow: false, ...context }
  const restored = { listVisible: false, detailVisible: true, horizontalOverflow: false, ...context }
  assert.deepEqual(masterDetailProblems({ desktop, narrowList, drillIn, returned, restored }), [])
  assert.match(masterDetailProblems({ desktop: { ...desktop, listVisible: false }, narrowList, drillIn, returned, restored }).join('\n'), /desktop.*list/)
  assert.match(masterDetailProblems({ desktop, narrowList, drillIn, returned, restored: { ...restored, draft: { name: 'lost' } } }).join('\n'), /draft/)
  assert.match(masterDetailProblems({ desktop, narrowList, drillIn, returned, restored: { ...restored, readCount: 5 } }).join('\n'), /reread/)
})
