import test from 'node:test'
import assert from 'node:assert/strict'
import {
  browserZoomProblems,
  mainRegionProblems,
  confirmationFocusProblems,
  coldRevealProblems,
  masterDetailProblems,
  nativeModalProblems,
  scrollLockProblems,
  viewportMeasurementProblems,
  selectorLayoutProblems,
  selectorCopyProblems,
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

function visibleRegion(left, top, width, height, occlusions = []) {
  return { rect: rect(left, top, width, height), hitTestSamples: 12, occlusions }
}

function readableMainRegionAudit() {
  return {
    viewport: { width: 360, visualWidth: 360, scale: 1 },
    mainRegion: {
      regions: {
        page: visibleRegion(0, 0, 360, 900),
        inner: visibleRegion(0, 0, 360, 760),
        header: visibleRegion(12, 52, 336, 104),
        title: visibleRegion(12, 52, 312, 32),
        nav: visibleRegion(12, 172, 336, 44),
        view: visibleRegion(12, 232, 336, 300),
        cards: [visibleRegion(12, 232, 336, 120)],
      },
      navigationActions: ['inbox', 'records', 'agents'].map((name, index) => ({ name, ...visibleRegion(16 + index * 100, 176, 90, 36) })),
      primaryActions: [{ name: 'Submit decision', ...visibleRegion(20, 240, 120, 36) }],
      hostNavigation: { name: 'Open sidebar', ...visibleRegion(88, 11, 28, 28) },
    },
  }
}

test('main region oracle rejects screenshot-proven narrow compression and host occlusion', () => {
  const readable = readableMainRegionAudit()
  assert.deepEqual(mainRegionProblems(readable), [])
  const intrinsicTitle = readableMainRegionAudit()
  intrinsicTitle.viewport = { width: 1440, visualWidth: 1440, scale: 1 }
  intrinsicTitle.mainRegion.hostNavigation = null
  intrinsicTitle.mainRegion.regions.title = visibleRegion(24, 24, 96, 32)
  assert.deepEqual(mainRegionProblems(intrinsicTitle), [], 'the oracle measures title occlusion, not intrinsic text width')
  const scaled = readableMainRegionAudit()
  scaled.viewport = { width: 360, visualWidth: 180, scale: 2 }
  scaled.mainRegion.regions.page = visibleRegion(0, 0, 180, 450)
  scaled.mainRegion.regions.inner = visibleRegion(0, 0, 175, 450)
  for (const name of ['header', 'nav', 'view']) scaled.mainRegion.regions[name] = visibleRegion(12, 12, 151, 40)
  scaled.mainRegion.regions.title = visibleRegion(12, 12, 96, 32)
  scaled.mainRegion.regions.cards = [visibleRegion(12, 68, 151, 120)]
  scaled.mainRegion.hostNavigation.occlusions.push({ x: 96, y: 25, stack: [{ tag: 'MAIN', class: 'weir-da-page' }] })
  assert.deepEqual(mainRegionProblems(scaled), [], 'real zoom permits the measured scrollbar and keeps the approved fixed-page stacking contract')
  const expanded = structuredClone(readable)
  Object.assign(expanded.mainRegion.regions.page.rect, { x: 280.5, left: 280.5, width: 79.5, right: 360 })
  Object.assign(expanded.mainRegion.regions.inner.rect, { x: 280.5, left: 280.5, width: 79.5, right: 360 })
  for (const name of ['header', 'title', 'nav', 'view']) Object.assign(expanded.mainRegion.regions[name].rect, { x: 292.5, left: 292.5, width: 55.5, right: 348 })
  assert.match(mainRegionProblems(expanded).join('\n'), /readable width/)

  const occluded = readableMainRegionAudit()
  occluded.mainRegion.regions.title.occlusions.push({ x: 88, y: 28, stack: [{ tag: 'BUTTON', ariaLabel: '打开侧边栏' }] })
  assert.match(mainRegionProblems(occluded).join('\n'), /title.*occluded|title.*hit-test/)

  const noReturn = readableMainRegionAudit()
  noReturn.mainRegion.hostNavigation = null
  assert.match(mainRegionProblems(noReturn).join('\n'), /host.*navigation|host.*return|way back/)

  const blockedPrimary = readableMainRegionAudit()
  blockedPrimary.mainRegion.primaryActions[0].occlusions.push({ x: 40, y: 250, stack: [{ tag: 'DIV', class: 'host-overlay' }] })
  assert.match(mainRegionProblems(blockedPrimary).join('\n'), /primary.*occluded|primary.*hit-test/)

  const missingEvidence = readableMainRegionAudit()
  missingEvidence.mainRegion.regions.nav.hitTestSamples = 0
  assert.match(mainRegionProblems(missingEvidence).join('\n'), /nav.*hit-test/)
})

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

test('selector default copy accepts approved bilingual task language and rejects legacy jargon', () => {
  const emptyZh = '选择决策助手\n不启用助手\n自动选择助手\n尚未允许自动回答；新判断仍会询问你。\n选择对比未开启。'
  assert.deepEqual(selectorCopyProblems(emptyZh, { language: 'zh', emptyScope: true, shadow: false }), [])
  const allowedEn = 'Choose a decision assistant\nDo not use an assistant\nAutomatically choose an assistant\nAutomatic answers are currently allowed for 2 decision categories.\nSelection comparison is on; it never changes the actual result.'
  assert.deepEqual(selectorCopyProblems(allowedEn, { language: 'en', allowedCount: 2, shadow: true }), [])
  const unknownZh = '不启用助手\n自动选择助手\n自动回答状态未知；不会假定可以自动回答。\n选择对比状态未知。'
  assert.deepEqual(selectorCopyProblems(unknownZh, { language: 'zh', unknown: true }), [])
  for (const jargon of ['Off', 'Auto', 'Shadow', '白名单', 'whitelist', 'A/B/C', 'A, B, C']) {
    assert.ok(selectorCopyProblems(`${emptyZh}\n${jargon}`, { language: 'zh', emptyScope: true, shadow: false }).some(problem => problem.includes('forbidden')), jargon)
  }
  assert.match(selectorCopyProblems(emptyZh, { language: 'zh', allowedCount: 2, shadow: true }).join('\n'), /allowed two|allowedCount|选择对比/)
  assert.match(selectorCopyProblems(allowedEn, { language: 'en', emptyScope: true, shadow: false }).join('\n'), /empty|comparison/)
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
  assert.deepEqual(nativeModalProblems({ ...genuine, composerContainsDialog: false }, { requireComposer: false }), [], 'management-page confirmations use the same native guard without a composer-only mount assumption')
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

test('only confirmed content shrink restores an obsolete offset to the reduced legal boundary', () => {
  const names = ['root', 'decisionPage']
  const container = (scrollTop, scrollHeight, overflow = '') => ({
    scrollTop, scrollLeft: 0, scrollHeight, clientHeight: 900, scrollWidth: 900, clientWidth: 900,
    inline: { overflow, overflowX: '', overflowY: '', overscrollBehavior: overflow ? 'none' : 'contain', overscrollBehaviorX: '', overscrollBehaviorY: '', paddingRight: '' },
  })
  const before = { root: container(20, 900), decisionPage: container(372, 3580) }
  const during = { root: container(20, 900, 'hidden'), decisionPage: container(372, 3580, 'hidden') }
  const after = { root: container(20, 900), decisionPage: container(0, 900) }
  const contentMutation = {
    method: 'snapshotPublish', args: { sessionId: 'root', snapshotId: 'ms_1', expectedRevision: 1 }, rpcId: 'rpc-1', settled: true,
    response: { rpcId: 'rpc-1', result: { ok: true, value: { ok: true } } },
    authoritative: { confirmed: true, currentSnapshotId: 'ms_1', snapshotState: 'published', runOutcome: 'published' },
  }
  assert.deepEqual(scrollLockProblems({ before, during, after, contentMutation }, names), [], '372 clamps to 0 only after the verified 3580/900 → 900/900 range reduction')
  assert.match(scrollLockProblems({ before, during, after }, names).join('\n'), /authoritative mutation/, 'a shrunk range cannot be relabelled without a mutation receipt')
  assert.match(scrollLockProblems({ before, during, after, contentMutation: { ...contentMutation, settled: false } }, names).join('\n'), /authoritative mutation/)
  assert.match(scrollLockProblems({ before, during, after, contentMutation: { ...contentMutation, response: { rpcId: 'rpc-1', result: { ok: false } } } }, names).join('\n'), /authoritative mutation/)
  assert.match(scrollLockProblems({ before, during, after: { ...after, decisionPage: container(1, 900) }, contentMutation }, names).join('\n'), /clamp/)
  assert.match(scrollLockProblems({ before, during: { ...during, decisionPage: container(2606, 3580, 'hidden') }, after, contentMutation }, names).join('\n'), /background scroll moved while locked/, 'content shrink never excuses movement before confirmation')
  assert.match(scrollLockProblems({ before, during, after: { ...after, decisionPage: container(0, 3580) }, contentMutation }, names).join('\n'), /restored exactly/, 'a mutation receipt is not a blanket offset tolerance without a reduced range')
  assert.match(scrollLockProblems({ before, during, after: { ...after, root: container(21, 900) }, contentMutation }, names).join('\n'), /root: scroll position was not restored exactly/, 'one shrunk container cannot relax another container')

  const partial = { ...after, decisionPage: container(200, 1100) }
  assert.deepEqual(scrollLockProblems({ before, during, after: partial, contentMutation }, names), [], '372 clamps to the new nonzero maximum 1100 - 900 = 200')
  assert.match(scrollLockProblems({ before, during, after: { ...partial, decisionPage: container(0, 1100) }, contentMutation }, names).join('\n'), /clamp/)
  const legalBefore = { root: { ...container(20, 900), scrollWidth: 521, clientWidth: 353, scrollLeft: 0 } }
  const legalDuring = { root: { ...container(20, 900, 'hidden'), scrollWidth: 521, clientWidth: 353, scrollLeft: 0 } }
  const legalAfter = { root: { ...container(20, 900), scrollWidth: 469, clientWidth: 353, scrollLeft: 0 } }
  assert.deepEqual(scrollLockProblems({ before: legalBefore, during: legalDuring, after: legalAfter }, ['root']), [], 'an ordinary legal zero offset restores exactly even if unrelated Host content reduces horizontal range')
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

test('cold reveal refresh uses its explicit post-edit baseline and rejects unmounting', () => {
  const loading = { status: 'loading', revealCount: 0, targetBottom: 100, scrollerBottom: 500, scrollTop: 0, active: 'button', draft: 'original' }
  const ready = { ...loading, status: 'ready', revealCount: 1, targetBottom: 498, scrollerBottom: 500, scrollTop: 400, behavior: 'instant', block: 'end' }
  const refreshBaseline = { ...ready, active: 'textarea', draft: 'restored', scrollTop: 420 }
  const refreshed = { ...refreshBaseline, revealCount: 1 }
  assert.deepEqual(coldRevealProblems({ loading, ready, refreshBaseline, refreshed }), [])
  assert.match(coldRevealProblems({ loading, ready, refreshBaseline, refreshed: { ...refreshed, targetBottom: null } }).join('\n'), /unmounted/)
  assert.match(coldRevealProblems({ loading, ready, refreshBaseline, refreshed: { ...refreshed, active: 'body' } }).join('\n'), /refresh changed focus/)
})

test('master-detail guard preserves narrow drill-in context and same-target restoration with explicit focus', () => {
  const focus = selector => ({ selector, connected: true, visible: true, active: true, activeTag: 'input' })
  const context = { selectedAgentId: 'agent-long', draft: { name: '未保存 bilingual draft' }, learning: { run: 'lr-1', snapshot: 'ms-1' }, readCount: 4 }
  const desktop = { listVisible: true, detailVisible: true, independentRegions: true, horizontalOverflow: false, listRect: rect(0, 0, 280, 600), detailRect: rect(300, 0, 600, 600), focus: focus('[data-agent-detail]') }
  const narrowList = { listVisible: true, detailVisible: false, horizontalOverflow: false, focus: focus('[data-action="open-agent"]') }
  const drillIn = { listVisible: false, detailVisible: true, horizontalOverflow: false, ...context, focus: focus('[data-agent-field="name"]') }
  const returned = { listVisible: true, detailVisible: false, horizontalOverflow: false, ...context, focus: focus('[data-action="open-agent"]') }
  const restored = { listVisible: false, detailVisible: true, horizontalOverflow: false, ...context, focus: focus('[data-agent-field="name"]') }
  assert.deepEqual(masterDetailProblems({ desktop, narrowList, drillIn, returned, restored }), [])
  assert.match(masterDetailProblems({ desktop: { ...desktop, listVisible: false }, narrowList, drillIn, returned, restored }).join('\n'), /desktop.*list/)
  assert.match(masterDetailProblems({ desktop, narrowList, drillIn, returned, restored: { ...restored, draft: { name: 'lost' } } }).join('\n'), /draft/)
  assert.match(masterDetailProblems({ desktop, narrowList, drillIn, returned, restored: { ...restored, readCount: 5 } }).join('\n'), /reread/)
  assert.match(masterDetailProblems({ desktop, narrowList, drillIn, returned: { ...returned, readCount: 5 }, restored }).join('\n'), /Back.*reread/)
  assert.match(masterDetailProblems({ desktop, narrowList, drillIn, returned: { ...returned, focus: { ...returned.focus, active: false, activeTag: 'body' } }, restored }).join('\n'), /returned.*activeElement/)
  const missingFocus = { ...restored }
  delete missingFocus.focus
  assert.match(masterDetailProblems({ desktop, narrowList, drillIn, returned, restored: missingFocus }).join('\n'), /restored.*focus/)
})

test('selector layout guard requires visual-viewport containment fixed ends and independent body scrolling', () => {
  const native = { implementation: 'native-dialog', tagName: 'DIALOG', open: true, modal: true, ariaModal: 'true', showModalCalls: 1, showModalError: null, composerContainsDialog: true, focusInside: true, rect: rect(20, 20, 320, 400), backdropCoversVisualViewport: true, backgroundInert: true }
  const dialog = rect(20, 20, 320, 400)
  const header = rect(20, 20, 320, 60)
  const body = rect(20, 80, 320, 260)
  const footer = rect(20, 340, 320, 80)
  const measuredViewport = { ...viewport(360, 1), rects: { dialog, header, body, footer } }
  const evidence = { native, viewport: measuredViewport, panelOverflow: 'hidden', bodyOverflow: 'auto', bodyOverscroll: 'contain', bodyScrollHeight: 800, bodyClientHeight: 260, bodyScrollTopBefore: 0, bodyScrollTopAfter: 180, headerBefore: header, headerAfter: header, footerBefore: footer, footerAfter: footer, horizontalOverflow: false }
  assert.deepEqual(selectorLayoutProblems(evidence, { scale: 1, scrollable: true }), [])
  assert.match(selectorLayoutProblems({ ...evidence, footerAfter: { ...footer, top: 500 } }, { scale: 1, scrollable: true }).join('\n'), /footer/)
  assert.match(selectorLayoutProblems({ ...evidence, bodyScrollTopAfter: 0 }, { scale: 1, scrollable: true }).join('\n'), /body.*scroll/)
  assert.match(selectorLayoutProblems({ ...evidence, native: { ...native, backdropCoversVisualViewport: false } }, { scale: 1, scrollable: true }).join('\n'), /backdrop/)
  assert.match(selectorLayoutProblems({ ...evidence, native: { ...native, backgroundInert: false } }, { scale: 1, scrollable: true }).join('\n'), /inert/)
  const zoomedDialog = rect(8, 8, 164, 400)
  const zoomed = { ...evidence, native: { ...native, rect: zoomedDialog }, viewport: { ...viewport(360, 2), rects: { dialog: zoomedDialog, header: rect(8, 8, 164, 60), body: rect(8, 68, 164, 260), footer: rect(8, 328, 164, 80) } } }
  assert.deepEqual(selectorLayoutProblems(zoomed, { scale: 2, scrollable: true }), [])
  assert.match(selectorLayoutProblems({ ...zoomed, viewport: { ...zoomed.viewport, rects: { ...zoomed.viewport.rects, dialog } } }, { scale: 2, scrollable: true }).join('\n'), /visual viewport/)
  const few = { ...evidence, bodyScrollHeight: 180, bodyClientHeight: 180, bodyScrollTopAfter: 0, viewport: { ...measuredViewport, rects: { ...measuredViewport.rects, dialog: { ...dialog, height: 240, bottom: 260 } } } }
  assert.deepEqual(selectorLayoutProblems(few, { scale: 1, scrollable: false }), [])
  const longText = '暂时无法读取或保存决策助手选择。已有页面内容不会被清除。请保留当前页面并稍后重试；这次失败不会确认新的选择、启用自动回答或改变审批与权限边界。若需定位问题，可在高级诊断中查看原始错误。'
  const longStatus = { expected: longText, actual: longText, role: 'alert', whiteSpace: 'normal', overflowWrap: 'anywhere', clientWidth: 280, scrollWidth: 280, rectHeight: 90, lineHeight: 18, primaryAction: { accessibleName: '重试', visible: true, hitTest: true, keyboard: { reached: true } }, ax: [{ ignored: false, role: 'alert', name: '' }, { ignored: false, role: 'staticText', name: longText }] }
  const longOptions = { scale: 1, scrollable: true, longStatus: { text: longText, language: 'zh' } }
  assert.deepEqual(selectorLayoutProblems({ ...evidence, longStatus }, longOptions), [])
  assert.match(selectorLayoutProblems({ ...evidence, longStatus: { ...longStatus, actual: 'short' } }, longOptions).join('\n'), /exact long/)
  assert.match(selectorLayoutProblems({ ...evidence, longStatus: { ...longStatus, scrollWidth: 340 } }, longOptions).join('\n'), /wrapping|horizontal/)
  assert.match(selectorLayoutProblems({ ...evidence, longStatus: { ...longStatus, primaryAction: { ...longStatus.primaryAction, hitTest: false } } }, longOptions).join('\n'), /primary action/)
  assert.match(selectorLayoutProblems({ ...evidence, longStatus: { ...longStatus, primaryAction: { ...longStatus.primaryAction, keyboard: { reached: false } } } }, longOptions).join('\n'), /keyboard/)
  assert.match(selectorLayoutProblems({ ...evidence, longStatus: { ...longStatus, ax: [{ ignored: false, role: 'alert', name: '' }] } }, longOptions).join('\n'), /accessible.*long|long.*accessible/)
})

test('scroll guard requires real wheel touch and PageDown attempts when requested', () => {
  const names = ['root', 'body']
  const before = Object.fromEntries(names.map(name => [name, { scrollTop: 20, scrollLeft: 0, inline: { overflow: '', overflowX: '', overflowY: '', overscrollBehavior: '', overscrollBehaviorX: '', overscrollBehaviorY: '', paddingRight: '' } }]))
  const during = Object.fromEntries(names.map(name => [name, { ...before[name], inline: { ...before[name].inline, overflow: 'hidden', overscrollBehavior: 'none' } }]))
  const after = structuredClone(before)
  const attempts = [{ type: 'wheel', observed: true }, { type: 'touch', observed: true }, { type: 'PageDown', observed: true }]
  assert.deepEqual(scrollLockProblems({ before, during, after, attempts }, names, ['wheel', 'touch', 'PageDown']), [])
  assert.match(scrollLockProblems({ before, during, after, attempts: attempts.slice(1) }, names, ['wheel', 'touch', 'PageDown']).join('\n'), /wheel/)
})

test('session scroller audit requires real before during after evidence or a justified absence', async () => {
  const { sessionScrollerProblems } = await import('../spikes/decision/gui-product-lib.mjs')
  assert.equal(typeof sessionScrollerProblems, 'function')
  const composerIdentity = { tag: 'DIV', id: null, class: 'host_scrollBody' }
  const sharedProof = { required: true, originConnected: true, relation: 'same-element', sameElement: true, aliasOf: 'composer', onlyOneOverflowAncestor: true, composer: composerIdentity, session: composerIdentity, ancestorChain: [composerIdentity] }
  const sharedSession = { identity: composerIdentity, aliasOf: 'composer', sameElement: true }
  const shared = { sessionIdentity: sharedProof, before: { composer: { identity: composerIdentity }, session: sharedSession }, during: { composer: { identity: composerIdentity }, session: sharedSession }, after: { composer: { identity: composerIdentity }, session: sharedSession } }
  assert.deepEqual(sessionScrollerProblems(shared), [])
  assert.match(sessionScrollerProblems({ ...shared, before: { composer: { identity: composerIdentity } } }).join('\n'), /before.*session/)
  assert.match(sessionScrollerProblems({ ...shared, sessionIdentity: { ...sharedProof, sameElement: false } }).join('\n'), /same-element|alias/)
  const absent = { sessionIdentity: { required: false, originConnected: true, relation: 'not-present', ancestorChain: [] }, before: {}, during: {}, after: {} }
  assert.deepEqual(sessionScrollerProblems(absent), [])
  assert.match(sessionScrollerProblems({ ...absent, sessionIdentity: { ...absent.sessionIdentity, relation: 'assumed-absent' } }).join('\n'), /not-present|justif/)
  assert.match(sessionScrollerProblems({ before: {}, during: {}, after: {} }).join('\n'), /identity|justif/)
  const distinctIdentity = { tag: 'SECTION', id: 'real-session', class: 'conversation-scroll' }
  const distinctProof = { ...sharedProof, relation: 'distinct-element', sameElement: false, aliasOf: null, onlyOneOverflowAncestor: false, session: distinctIdentity, ancestorChain: [composerIdentity, distinctIdentity] }
  const distinctSession = { identity: distinctIdentity, aliasOf: null, sameElement: false }
  const distinct = { sessionIdentity: distinctProof, before: { composer: { identity: composerIdentity }, session: distinctSession }, during: { composer: { identity: composerIdentity }, session: distinctSession }, after: { composer: { identity: composerIdentity }, session: distinctSession } }
  assert.deepEqual(sessionScrollerProblems(distinct), [])
})

test('confirmation focus guard rejects restoration before the authoritative action promise settles', () => {
  const beforeSettle = { promiseSettled: false, targetFocused: false, fallbackFocused: false }
  const afterSettle = { promiseSettled: true, target: { connected: true, enabled: true, visible: true, focused: true }, fallback: { connected: true, enabled: true, visible: true, focused: false, logical: true } }
  assert.deepEqual(confirmationFocusProblems({ beforeSettle, afterSettle }), [])
  assert.match(confirmationFocusProblems({ beforeSettle: { ...beforeSettle, targetFocused: true }, afterSettle }).join('\n'), /before/)
  assert.match(confirmationFocusProblems({ beforeSettle, afterSettle: { ...afterSettle, target: { ...afterSettle.target, visible: false } } }).join('\n'), /valid target|logical fallback/)
  const fallback = { promiseSettled: true, target: { connected: false, enabled: false, visible: false, focused: false }, fallback: { connected: true, enabled: true, visible: true, focused: true, logical: true } }
  assert.deepEqual(confirmationFocusProblems({ beforeSettle, afterSettle: fallback }), [])
})

test('shutdown socket-closure stderr stays raw and separately scoped from runtime channels', async () => {
  const { shutdownSocketClosureEntries } = await import('../spikes/decision/gui-product-lib.mjs')
  assert.equal(typeof shutdownSocketClosureEntries, 'function')
  const entries = shutdownSocketClosureEntries({
    'desktop-enabled.log': 'ordinary startup\n[TypeError: fetch failed]\nSocketError: other side closed\nRuntime.exceptionThrown must not be relabelled',
    'desktop-disabled.log': 'no socket closure here',
  })
  assert.equal(entries.length, 2)
  assert.deepEqual(entries.map(entry => [entry.scope, entry.path, entry.line]), [
    ['desktop-shutdown-socket-closure-stderr', 'desktop-enabled.log', 2],
    ['desktop-shutdown-socket-closure-stderr', 'desktop-enabled.log', 3],
  ])
  assert.ok(entries.every(entry => entry.text && entry.countsAsRuntimeError === false && entry.countsAsImportFailure === false))
})
