// Tasks 7.2/7.3 of the session-capability-manager change: the delegate
// load_skills batch preflight (zero spawn on any failure, group name never
// sealed by a rejected batch) and the intent-gate pointer eligibility filter
// (suppressed first hits stay unarmed, no replacement text, audit carries
// the reason, non-skill intents unchanged).
import { test, expect } from './helpers.js'
import assert from 'node:assert/strict'
import { createSkillConsumerView } from '../src/capabilities/consumer-view.js'
import { createDelegateTool } from '../src/delegate/tool.js'
import { createSkillSelectionPlugin, skillSelectionFor } from '../src/capabilities/skill-selection-plugin.js'
import { apply as applyIntentGate } from '../src/intent-gate/index.js'
import { createSkillIdentity } from '../src/capabilities/skill-identity.js'

// ---------- 7.2 delegate preflight ----------

const candidateOf = (name, flags = {}) => ({
  status: 'parsed', name, identity: createSkillIdentity({ scope: 'user', root: '/user', name, opaqueId: `user-${name}` }),
  path: `/user/${name}/SKILL.md`, digest: `d-${name}`, provider: 'weir-selected',
  invocation: { modelInvocable: true, userInvocable: true, ...flags },
})

function delegateDeps(overrides = {}) {
  const spawned = []
  return {
    spawned,
    resolveTarget: async () => ({ provider: 'category', label: 'quick', persona: 'persona', model: 'm', reasoningEffort: 'medium' }),
    subagents: {
      async start(provider, request) {
        spawned.push({ provider, request })
        return { id: 'child-1', result: Promise.resolve({ output: [{ type: 'text', text: 'done' }], stopReason: 'completed' }), dispose: async () => {} }
      },
      async listChildren() { return [] },
    },
    loadSkill: async name => `BODY_${name}`,
    ...overrides,
  }
}

const execOf = () => ({ agent: { id: 'parent-1', session: { header: { delegationDepth: 0, cwd: '/ws' } } } })

const preflightWith = candidates => {
  const provider = { async list() { return { candidates, complete: true } } }
  const view = createSkillConsumerView({ provider })
  return async (items, exec) => {
    const names = [...new Set(items.flatMap(item => item.load_skills ?? []))]
    if (!names.length) return
    const verdicts = await view.conclusions({ cwd: exec.agent?.session?.header?.cwd, scope: { session: { id: exec.agent?.id } } }, names, 'model')
    const failures = [...verdicts.values()].filter(verdict => !verdict.invocable)
    if (failures.length > 0) throw new Error(`delegate: load_skills preflight rejected the whole batch (zero spawned): ${failures.map(f => `"${f.name}" ${f.reason}`).join(', ')}`)
  }
}

test('7.2 any load_skills failure rejects the whole batch with zero spawns, group state never consulted', async () => {
  const consulted = []
  const deps = delegateDeps({
    preflightLoadSkills: preflightWith([candidateOf('alpha')]),
    coordinatorFor: async () => {
      consulted.push('coordinatorFor')
      return { assertGroupAvailable(name) { consulted.push(`assert:${name}`) } }
    },
  })
  const tool = createDelegateTool(deps)
  await assert.rejects(
    tool.execute({ group: 'probe-group', tasks: [
      { category: 'quick', prompt: 'x', load_skills: ['alpha'] },
      { category: 'quick', prompt: 'y', load_skills: ['missing-skill'] },
    ] }, execOf()),
    /zero spawned.*"missing-skill" not-selected/,
  )
  expect(deps.spawned).toHaveLength(0)
  // The rejected batch never reached the group lane: no group record, no
  // seal attempt, so the name stays reusable by construction.
  expect(consulted).toHaveLength(0)
})

test('7.2 one-shot, background and three-item batches each reject with zero spawns', async () => {
  const preflight = preflightWith([candidateOf('alpha')])
  await assert.rejects(createDelegateTool(delegateDeps({ preflightLoadSkills: preflight })).execute({ category: 'quick', prompt: 'x', load_skills: ['nope'] }, execOf()), /zero spawned/)
  const bg = delegateDeps({ preflightLoadSkills: preflight, jobs: { register: () => 'job-1' } })
  await assert.rejects(createDelegateTool(bg).execute({ category: 'quick', prompt: 'x', load_skills: ['nope'], run_in_background: true }, execOf()), /zero spawned/)
  expect(bg.spawned).toHaveLength(0)
  const batch = delegateDeps({ preflightLoadSkills: preflight })
  await assert.rejects(createDelegateTool(batch).execute({ tasks: [
    { category: 'quick', prompt: 'a', load_skills: ['alpha'] },
    { category: 'quick', prompt: 'b', load_skills: ['alpha'] },
    { category: 'quick', prompt: 'c', load_skills: ['rogue'] },
  ] }, execOf()), /zero spawned/)
  expect(batch.spawned).toHaveLength(0)
})

test('7.2 a passing preflight keeps the spawn contract (maxDepth 1, body prepended)', async () => {
  const deps = delegateDeps({ preflightLoadSkills: preflightWith([candidateOf('alpha')]) })
  const tool = createDelegateTool(deps)
  const result = await tool.execute({ category: 'quick', prompt: 'TASK: fix', load_skills: ['alpha'] }, execOf())
  expect(result.background).toBe(false)
  expect(deps.spawned[0].request.maxDepth).toBe(1)
  expect(JSON.stringify(deps.spawned[0].request.prompt)).toContain('BODY_alpha')
})

// ---------- 7.3 intent-gate eligibility ----------

const debugging = createSkillIdentity({ scope: 'user', root: '/user', name: 'debugging', opaqueId: 'user-debugging' })

function gateCtx({ selected, candidates }) {
  const handlers = {}
  const emitted = []
  let registered
  const ctx = {
    handlers,
    emitted,
    on(event, handler) { handlers[event] = handler },
    emit(type, record) { emitted.push({ type, record }) },
    skills: {
      registerProvider(create) { registered = create({ invalidate() {} }) },
      async list(options) { return (await registered.list(options)).candidates },
    },
    get() { return undefined },
  }
  createSkillSelectionPlugin({
    readSelection: async () => selected(),
    inventory: async () => ({ complete: true, candidates: candidates() }),
    office: async () => ({ complete: true, candidates: [] }),
    lifecycle: { agentCreated: () => undefined },
  })(ctx)
  applyIntentGate(ctx, {})
  return { ctx, emitted }
}

const gateAgent = appended => ({ id: 'session-1', session: { append: (type, data) => appended.push({ type, data }), header: { cwd: '/ws' } } })
const promptMessage = text => ({ id: 'm1', role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const debuggingCandidate = () => ({ status: 'parsed', name: 'debugging', identity: debugging, path: '/user/debugging/SKILL.md', digest: 'd', invocation: { modelInvocable: true, userInvocable: true } })

test('7.3 a suppressed first hit stays unarmed; once available the full pointer arrives', async () => {
  let selected = []
  const { ctx, emitted } = gateCtx({ selected: () => selected, candidates: () => [debuggingCandidate()] })
  const agent = gateAgent([])
  const preStep = (text, turn) => ctx.handlers['agent/pre-step']({ agent, messages: [promptMessage(text)], turn, step: 1 }, async () => ({ kind: 'enter', messages: [] }))

  // First hit while the skill is NOT selected: suppressed, no injection at all.
  const suppressed = await preStep('debug this crash', 1)
  expect(suppressed.messages).toHaveLength(0)
  // Audit says "not injected + reason", never a plain hit.
  expect(emitted.some(e => e.type === 'weir/intent-hit' && e.record?.data?.suppressed === 'not-selected')).toBe(true)

  // The skill becomes available: the ledger never armed, so the NEXT hit
  // injects the FULL initial pointer, not a reminder.
  selected = [debugging]
  skillSelectionFor(ctx).provider.sourceChanged()
  const armed = await preStep('debug this crash harder', 2)
  expect(armed.messages).toHaveLength(1)
  expect(armed.messages[0].content[0].text).toContain('skill(name="debugging")')
  expect(armed.messages[0].content[0].text).not.toContain('already armed')
})

test('7.3 a selected and model-invocable skill injects exactly as before', async () => {
  const { ctx } = gateCtx({ selected: () => [debugging], candidates: () => [debuggingCandidate()] })
  const agent = gateAgent([])
  const result = await ctx.handlers['agent/pre-step']({ agent, messages: [promptMessage('debug this')], turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  expect(result.messages).toHaveLength(1)
  expect(result.messages[0].content[0].text).toContain('skill(name="debugging")')
})

test('7.3 a selected but not-model-invocable skill is suppressed with its reason', async () => {
  const shadowed = () => [{ ...debuggingCandidate(), invocation: { modelInvocable: false, userInvocable: true } }]
  const { ctx, emitted } = gateCtx({ selected: () => [debugging], candidates: shadowed })
  const agent = gateAgent([])
  const result = await ctx.handlers['agent/pre-step']({ agent, messages: [promptMessage('debug this')], turn: 1, step: 1 }, async () => ({ kind: 'enter', messages: [] }))
  expect(result.messages).toHaveLength(0)
  expect(emitted.some(e => e.type === 'weir/intent-hit' && e.record?.data?.suppressed === 'not-model-invocable')).toBe(true)
})
