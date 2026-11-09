import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { DecisionBroker } from '../../src/decision/broker.js'
import { registerDecisionConsultTool } from '../../src/decision/tool.js'
import { createDecisionRemoteService } from '../../src/decision/remote.js'
import * as preset from '../../src/decision/index.js'
import * as brokerPlugin from '../../src/decision/broker-plugin.js'
import * as remotePlugin from '../../src/decision/remote-plugin.js'

const root = fileURLToPath(new URL('../../src/decision/', import.meta.url))

test('Decision source has no session events, command channel, static host imports or polling', () => {
  const files = readdirSync(root, { recursive: true }).filter(file => file.endsWith('.js'))
  const timeoutFiles = []
  for (const file of files) {
    const source = readFileSync(join(root, file), 'utf8')
    assert.equal(source.includes('session.append'), false, file)
    assert.equal(source.includes('commands.execute'), false, file)
    assert.equal(source.includes('setInterval'), false, file)
    assert.equal(/(?:from\s*|import\s*\()\s*['"]@deepseek-ai\//.test(source), false, file)
    if (source.includes('setTimeout')) timeoutFiles.push(file)
  }
  assert.deepEqual(timeoutFiles, ['evaluator/sidecar.js']) // One hard deadline, never polling.
  assert.ok(files.length >= 15)
})

test('Auto Router depends only on pure contracts, pure scope, and the existing sidecar', () => {
  const source = readFileSync(join(root, 'router.js'), 'utf8')
  const imports = [...source.matchAll(/from '([^']+)'/g)].map(match => match[1]).sort()
  assert.deepEqual(imports, ['./contracts.js', './evaluator/sidecar.js', './scope.js'])
  assert.equal(source.includes('setTimeout'), false)
  for (const forbidden of ['evaluateCase', 'DecisionContextRetriever', 'createAttempt', 'attempts.']) {
    assert.equal(source.includes(forbidden), false)
  }
})

test('disabled Hook and tool fail while remote overview stays read-only without creating a decisions directory', async t => {
  const home = mkdtempSync(join(tmpdir(), 'weir-decision-guards-'))
  t.after(() => rmSync(home, { recursive: true, force: true }))
  const broker = new DecisionBroker({ profileContext: { home, name: 'test' }, config: () => ({ decisionAgentsEnabled: false }) })
  await broker.start()
  const agent = { id: 'root', session: { header: { id: 'root', cwd: home, delegationDepth: 0 } } }
  assert.deepEqual(await broker.hook({ agent, request: { questions: [{ id: 'q', question: 'Q' }] } }), { kind: 'pass', why: 'bypass' })

  const tool = registerDecisionConsultTool({ get: () => broker, tools: { register: definition => definition } })
  await assert.rejects(tool.execute({ question: 'Q' }, { agent, signal: new AbortController().signal }), /disabled/)
  const remote = createDecisionRemoteService({ broker: () => broker })
  const result = await remote.overview({ sessionId: 'root' })
  assert.deepEqual(result, {
    ok: true,
    value: { status: { available: false, enabled: false, reason: 'disabled' }, selector: { mode: 'off' }, agents: [] },
  })
  assert.equal(existsSync(join(home, 'weir', 'profiles', 'test', 'decisions')), false)
  await broker.flush()
})

test('three export entries have only the designed inject surface and preset apply is inert-safe', () => {
  assert.deepEqual(preset.inject, ['tools'])
  assert.deepEqual(brokerPlugin.inject, ['agents', 'llm', 'sessionQuery', 'fs']) // Audit, evaluation, delivery, lineage and fresh evidence.
  assert.deepEqual(remotePlugin.inject, ['typert'])
  const registrations = []
  const ctx = {
    on: () => {}, get: () => undefined,
    effect: fn => { registrations.push(fn()); return () => {} },
    tools: { register: definition => { registrations.push(definition); return () => {} } },
  }
  assert.doesNotThrow(() => preset.apply(ctx))
  assert.equal(registrations[0].name, 'decision_consult')
})
