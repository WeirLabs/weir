import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import scenario from '../src/scenarios/capability-remote-dual-preset.js'

test('dual-preset assertion rejects wrong-owner remote even if owner command succeeds', t => {
  const ws = mkdtempSync(join(tmpdir(), 'weir-dual-assert-'))
  t.after(() => rmSync(ws, { recursive: true, force: true }))
  const owner = id => ({ id, commandAfterBoth: { revision: 1, effective: { skills: [`only-${id}`] } },
    remoteAfterBoth: { revision: 1, effective: { skills: [`only-${id}`] } },
    commandEventsAfter: ['command/run', 'command/done'], commandEventsFinal: ['command/run', 'command/done', 'command/run', 'command/done'],
    projectionLive: { source: 'live', headerPreset: id, projectedPreset: id } })
  const report = { orders: [
    { order: ['weir', 'weir-creative'], owners: [owner('weir'), owner('weir-creative')] },
    { order: ['weir-creative', 'weir'], owners: [owner('weir'), owner('weir-creative')] },
  ], leasesReleased: 9, projection: { beforeSelect: { projectedPreset: 'weir' }, afterSelect: { headerPreset: 'weir', projectedPreset: 'weir-creative' }, liveLong: { eventCount: 2000 }, coldLong: { eventCount: 2000, source: 'prepared', headerPreset: 'weir', projectedPreset: 'weir-creative' }, coldRepeat: { source: 'prepared' } } }
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
  assert.match(red[0].label, /remote matches owning command/)
})
