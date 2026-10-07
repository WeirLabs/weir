// Task 8.2 of the session-capability-manager change: name-ambiguity
// detection, isolated-group options, residue sweeping, readiness via
// loader.await() + fiber state, and unmount sibling isolation.
import { test, expect } from './helpers.js'
import assert from 'node:assert/strict'
import { detectMcpNameAmbiguity, mcpGroupOptions, createMcpMount, isMcpResidueId } from '../src/capabilities/mcp-mount.js'

test('ambiguity: a configured name that is another\'s "__" prefix is a conflict with a reason', () => {
  const verdict = detectMcpNameAmbiguity([{ identity: 'alpha' }, { identity: 'alpha__x' }])
  expect(verdict.kind).toBe('conflict')
  expect(verdict.conflicts[0].kind).toBe('prefix')
  expect(verdict.conflicts[0].reason).toContain('"alpha"')
})

test('ambiguity: one public name declared by two servers is a conflict; distinct names pass', () => {
  const verdict = detectMcpNameAmbiguity([
    { identity: 'a', publicNames: ['echo'] },
    { identity: 'b', publicNames: ['echo'] },
  ])
  expect(verdict.kind).toBe('conflict')
  expect(verdict.conflicts[0].kind).toBe('duplicate-public-name')
  expect(detectMcpNameAmbiguity([{ identity: 'a', publicNames: ['x'] }, { identity: 'b', publicNames: ['y'] }]).kind).toBe('ok')
})

test('group options isolate the three services and reference the stock client by package string', () => {
  const options = mcpGroupOptions({ identity: 'docs', generation: 3, client: { command: 'mock' } })
  expect(options.isolate).toEqual({ tools: true, systemPrompt: true, mcpResources: true })
  expect(options.config[1].name).toBe('@deepseek-ai/dsh-mcp-client')
  expect(options.config[0].name).toBe('weir-harness/mcp-facade-plugin')
  expect(options.config[0].config).toEqual({ identity: 'docs', generation: 3, group: 'weir-mcp-docs' })
  assert.throws(() => mcpGroupOptions({ identity: '../x', generation: 1, client: {} }), TypeError)
})

function loaderFixture() {
  const created = []
  const removed = []
  const calls = []
  return {
    created, removed, calls,
    loader: {
      async create(options) { created.push(options); calls.push('create') },
      async remove(id) { removed.push(id); calls.push('remove') },
      async await() { calls.push('await') },
    },
  }
}

test('readiness is judged after loader.await() by the fiber state, never at create() return', async () => {
  const { loader, calls } = loaderFixture()
  const mount = createMcpMount({ loader })
  await assert.rejects(
    mount.mount({ identity: 'docs', generation: 1, client: {}, fiberOf: () => null }),
    /no fiber after loader\.await/,
  )
  expect(calls).toEqual(['create', 'await'])
  const { loader: second } = loaderFixture()
  const ok = createMcpMount({ loader: second })
  const result = await ok.mount({ identity: 'docs', generation: 1, client: {}, fiberOf: () => ({ state: 'running' }) })
  expect(result.groupId).toBe('weir-mcp-docs')
})

test('residue sweep removes only weir-mcp-* group ids', async () => {
  const { loader, removed } = loaderFixture()
  const mount = createMcpMount({ loader })
  const swept = await mount.sweepResidue(['weir-mcp-docs', 'weir-mcp-docs-facade', 'include', 'other', 'weir-mcp-web'])
  expect(swept.sort()).toEqual(['weir-mcp-docs', 'weir-mcp-web'])
  expect(removed.sort()).toEqual(['weir-mcp-docs', 'weir-mcp-web'])
  expect(isMcpResidueId('weir-mcp-docs-facade')).toBe(false)
  expect(isMcpResidueId('include')).toBe(false)
})

test('unmount removes only the target and remounts a vanished sibling (1.14 S3 anomaly)', async () => {
  const { loader, removed } = loaderFixture()
  const remounted = []
  const mount = createMcpMount({ loader })
  await mount.mount({ identity: 'alpha', generation: 1, client: {}, fiberOf: () => ({ state: 'running' }) })
  await mount.mount({ identity: 'beta', generation: 1, client: {}, fiberOf: () => ({ state: 'running' }) })
  const result = await mount.unmount('alpha', {
    alive: () => [], // the anomaly: every sibling vanished
    remount: async identity => { remounted.push(identity) },
  })
  expect(result.removed).toBe(true)
  expect(removed).toEqual(['weir-mcp-alpha'])
  expect(remounted).toEqual(['beta'])
})
