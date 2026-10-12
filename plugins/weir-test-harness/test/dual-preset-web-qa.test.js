import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { checkFreshRoot, compare, methods } from '../src/dual-preset-web-qa.mjs'

test('refuses an existing QA root (including an unknown file)', t => {
  const parent = mkdtempSync(join(process.cwd(), 'dual-web-root-check-'))
  t.after(() => { assert.equal(realpathSync.native(parent), parent); rmSync(parent, { recursive: true }) })
  const fresh = join(parent, 'fresh')
  assert.equal(checkFreshRoot(fresh), fresh)
  writeFileSync(fresh, 'do not wipe')
  assert.throws(() => checkFreshRoot(fresh), /already exists/)
  assert.throws(() => checkFreshRoot('/tmp/foreign-root'), /lane-local/)
})

test('every actual HTTP method must match its owning command and stay log-silent in both orders', () => {
  const report = { orders: [['weir', 'weir-creative'], ['weir-creative', 'weir']].map(order => ({
    order, owners: Object.fromEntries(order.map(id => {
      const payload = { status: 'applied', revision: 1, effective: { skills: [`only-${id}`] }, warnings: [] }
      const commands = Object.fromEntries(methods.map(method => [method, payload]))
      const http = Object.fromEntries(methods.map(method => [method, { status: 200, ok: true, value: payload }]))
      return [id, { commands, http, headerPreset: id, projectedPreset: id, eventsBefore: ['command/run'], eventsAfter: ['command/run'] }]
    })), authDenied: { status: 401 },
    rejected: Object.fromEntries(['missing', 'foreign'].map(kind => [kind, Object.fromEntries(methods.map(method => [method, { status: 200, ok: false, error: { code: 'gateway/internal', message: 'capability read: owner unavailable' } }]))])),
    cold: { source: 'prepared', headerPreset: 'weir', projectedPreset: 'weir',
      http: { status: 200, ok: true, value: { status: 'applied', revision: 1, effective: { skills: ['only-weir'] }, warnings: [] } },
      commandEvents: ['command/run'], eventsAfter: ['command/run'] }
  })) }
  assert.deepEqual(compare(report), [])
  report.orders[0].owners.weir.http.receipt.value = { status: 'applied', revision: 1, effective: { skills: [] }, warnings: ['selection-unavailable'] }
  assert.match(compare(report).join('\n'), /weir>weir-creative\/weir\/receipt: remote differs/)
  report.orders[0].owners.weir.eventsAfter.push('command/run')
  assert.match(compare(report).join('\n'), /read-created command events/)
  report.orders[0].owners.weir.http.list.status = 401
  assert.match(compare(report).join('\n'), /list: HTTP gateway failed/)
})
