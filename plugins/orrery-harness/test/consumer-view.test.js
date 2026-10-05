// Tasks 7.1-7.3 of the session-capability-manager change: the unified skill
// consumer view, the delegate load_skills batch preflight, and the
// intent-gate pointer eligibility filter. All five consumers (model catalog,
// skill tool, slash, delegate, intent-gate) must conclude from ONE preset-
// layer view, intersected with the invocation flags by purpose.
import { test, expect } from './helpers.js'
import assert from 'node:assert/strict'
import { createSkillConsumerView, SKILL_VIEW_REASONS } from '../src/capabilities/consumer-view.js'

const candidate = (name, { provider = 'orrery-selected', modelInvocable = true, userInvocable = true } = {}) => ({
  name, provider, invocation: { modelInvocable, userInvocable },
})

const providerWith = candidates => ({
  lists: [],
  async list(options) {
    this.lists.push(options)
    return { candidates, complete: true }
  },
})

test('7.1 all five consumers conclude from one snapshot, intersected by purpose', async () => {
  const provider = providerWith([
    candidate('alpha'),
    candidate('beta', { modelInvocable: false, userInvocable: true }),
    candidate('shadow', { provider: 'dsh-skill-filesystem' }),
  ])
  const view = createSkillConsumerView({ provider })
  const options = { cwd: '/ws', scope: { session: { id: 's1' } } }
  const model = await view.conclusions(options, ['alpha', 'beta', 'shadow', 'missing'], 'model')
  const user = await view.conclusions(options, ['alpha', 'beta', 'shadow', 'missing'], 'user')

  // Model purpose: the model catalog, skill tool, delegate and intent-gate view.
  expect(model.get('alpha').invocable).toBe(true)
  expect(model.get('beta').invocable).toBe(false)
  expect(model.get('beta').reason).toBe(SKILL_VIEW_REASONS.notModelInvocable)
  // User purpose: the slash view — same snapshot, different flag intersection.
  expect(user.get('beta').invocable).toBe(true)
  // A same-name shadow from another provider never authorizes.
  expect(model.get('shadow').invocable).toBe(false)
  expect(model.get('shadow').reason).toBe(SKILL_VIEW_REASONS.notSelected)
  // Absent from the view: not selected, never a guessed grant.
  expect(model.get('missing').invocable).toBe(false)
  expect(model.get('missing').reason).toBe(SKILL_VIEW_REASONS.notSelected)
  // One list per conclusions() call — a batch never observes mixed revisions.
  expect(provider.lists).toHaveLength(2)
})

test('7.1 a candidate without an invocation face cannot authorize', async () => {
  const provider = providerWith([{ name: 'bare', provider: 'orrery-selected' }])
  const view = createSkillConsumerView({ provider })
  const verdict = await view.conclusion({}, 'bare', 'model')
  expect(verdict.selected).toBe(false)
  expect(verdict.invocable).toBe(false)
  expect(verdict.reason).toBe(SKILL_VIEW_REASONS.notSelected)
})
