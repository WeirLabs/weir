import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import scenario from '../src/scenarios/capability-remote-dual-preset.js'

test('dual-preset assertion rejects wrong-owner remote even if owner command succeeds', t => {
  const tmpParent = realpathSync.native(tmpdir())
  const ws = realpathSync.native(mkdtempSync(join(tmpParent, 'weir-dual-assert-')))
  t.after(() => {
    if (!ws.startsWith(`${tmpParent}/`) || realpathSync.native(ws) !== ws) throw new Error(`refusing to remove ${ws}`)
    rmSync(ws, { recursive: true, force: true })
  })
  // One synthetic owner report mirroring every field skill-composition-probe.js
  // writes: the owning command receipt, the same five direct Host reads, the
  // un-changed command lifecycle event tally and the live projection identity.
  const owner = id => {
    const receipt = { status: 'applied', revision: 1, effective: { skills: [`only-${id}`] }, warnings: [] }
    return { id, sessionId: `session-${id}`,
      commandAfterBoth: receipt, remoteAfterBoth: structuredClone(receipt),
      listAfterBoth: { skills: [{ name: `only-${id}`, selected: true }, { name: `shared-${id}`, selected: false }] },
      conditionsAfterBoth: { conditions: [{ id: 'skill-root', status: 'ok' }] },
      presetsAfterBoth: { presets: [{ name: id, revision: 1 }] },
      defaultAfterBoth: { status: 'present' },
      commandEventsAfter: ['command/run', 'command/done'], commandEventsFinal: ['command/run', 'command/done', 'command/run', 'command/done'],
      projectionLive: { source: 'live', headerPreset: id, projectedPreset: id } }
  }
  const selectedReceipt = { status: 'applied', revision: 1, effective: { skills: ['only-weir-creative'] }, warnings: [] }
  const report = { orders: [
    { order: ['weir', 'weir-creative'], owners: [owner('weir'), owner('weir-creative')] },
    { order: ['weir-creative', 'weir'], owners: [owner('weir'), owner('weir-creative')] },
  ], leasesReleased: 9, projection: {
    beforeSelect: { projectedPreset: 'weir' },
    afterSelect: { headerPreset: 'weir', projectedPreset: 'weir-creative' },
    remoteAfterSelect: structuredClone(selectedReceipt), coldRemote: structuredClone(selectedReceipt),
    liveLong: { eventCount: 2000 },
    coldLong: { eventCount: 2000, source: 'prepared', headerPreset: 'weir', projectedPreset: 'weir-creative' },
    coldRepeat: { source: 'prepared' } } }
  const checks = () => {
    writeFileSync(join(ws, 'capability-dual-preset.json'), JSON.stringify(report))
    const results = []
    scenario.assert({ ws, code: 0, stderr: '', check: (label, ok) => results.push({ label, ok }) })
    return results
  }
  assert.ok(checks().every(check => check.ok))
  report.orders[0].owners[1].remoteAfterBoth.effective.skills = []
  const red = checks().filter(check => !check.ok)
  assert.equal(red.length, 1)
  assert.match(red[0].label, /weir-creative all five direct Host reads retain exact owner/)
})
