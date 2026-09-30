import { describe, expect, it } from './helpers.js'
import { createResumeTool, createTerminateTool, withUntrackedHint } from '../src/delegate/supervision-tools.js'

const execAt = (depth) => ({ agent: { id: 'parent-1', session: { header: { delegationDepth: depth } } } })

// Duck coordinator + coordinatorFor: records calls, resolves to canned values.
function fakeCoordinatorFor({ coordinator: overrides = {}, parent } = {}) {
  const calls = []
  const coordinator = {
    resume: async (agent, context) => {
      calls.push(['resume', agent, context])
      return { name: agent, id: 'child-1', status: 'running' }
    },
    terminate: (agent, reason) => {
      calls.push(['terminate', agent, reason])
      return { name: agent, id: 'child-1', interrupted: false }
    },
    ...overrides,
  }
  const parents = []
  return {
    calls,
    parents,
    coordinator,
    coordinatorFor: async (agent) => {
      parents.push(agent)
      return coordinator
    },
  }
}

describe('resume_agent tool', () => {
  it('rejects at delegation depth >= 1', async () => {
    const { coordinatorFor } = fakeCoordinatorFor()
    const tool = createResumeTool({ coordinatorFor })
    await expect(async () => tool.execute({ agent: 'a', context: 'c' }, execAt(1))).rejects.toThrow(/only the main agent/)
  })

  it('validates agent and context arguments', async () => {
    const { coordinatorFor } = fakeCoordinatorFor()
    const tool = createResumeTool({ coordinatorFor })
    await expect(async () => tool.execute({ agent: '', context: 'c' }, execAt(0))).rejects.toThrow(/agent must be a non-empty string/)
    await expect(async () => tool.execute({ agent: 'a', context: '  ' }, execAt(0))).rejects.toThrow(/context must be a non-empty string/)
    await expect(async () => tool.execute({ agent: 'a' }, execAt(0))).rejects.toThrow(/context must be a non-empty string/)
  })

  it('passes through to coordinator.resume', async () => {
    const { coordinatorFor, calls, parents } = fakeCoordinatorFor()
    const tool = createResumeTool({ coordinatorFor })
    const exec = execAt(0)
    const value = await tool.execute({ agent: 'worker', context: 'unblocked' }, exec)
    expect(calls).toEqual([['resume', 'worker', 'unblocked']])
    expect(parents).toEqual([exec.agent])
    expect(value).toEqual({ name: 'worker', id: 'child-1', status: 'running' })
    expect(tool.output.render({}, value)[0].text).toContain('Resumed supervised child worker (child-1)')
  })

  it('decorates a rebuilt-registry miss with the untracked hint', async () => {
    const { coordinatorFor } = fakeCoordinatorFor({
      coordinator: {
        resume: async () => {
          throw new Error('no supervised child named "ghost"')
        },
        snapshot: () => ({ meta: { untracked: [{ id: 'u1' }, { id: 'u2' }] } }),
      },
    })
    const tool = createResumeTool({ coordinatorFor })
    await expect(async () => tool.execute({ agent: 'ghost', context: 'c' }, execAt(0))).rejects.toThrow(/2 untracked continuable child/)
  })
})

describe('terminate_agent tool', () => {
  it('rejects at delegation depth >= 1', async () => {
    const { coordinatorFor } = fakeCoordinatorFor()
    const tool = createTerminateTool({ coordinatorFor })
    await expect(async () => tool.execute({ agent: 'a' }, execAt(2))).rejects.toThrow(/only the main agent/)
  })

  it('validates the agent argument', async () => {
    const { coordinatorFor } = fakeCoordinatorFor()
    const tool = createTerminateTool({ coordinatorFor })
    await expect(async () => tool.execute({ agent: '' }, execAt(0))).rejects.toThrow(/agent must be a non-empty string/)
  })

  it('passes through to coordinator.terminate with the optional reason', async () => {
    const { coordinatorFor, calls } = fakeCoordinatorFor()
    const tool = createTerminateTool({ coordinatorFor })
    const value = await tool.execute({ agent: 'worker', reason: 'stale' }, execAt(0))
    expect(calls).toEqual([['terminate', 'worker', 'stale']])
    expect(tool.output.render({}, value)[0].text).toContain('terminated (state bookkeeping)')
    expect(tool.output.render({}, { ...value, interrupted: true })[0].text).toContain('(interrupted while running)')
  })
})

describe('withUntrackedHint', () => {
  const miss = () => new Error('no supervised child named "x"')

  it('returns the error unchanged when the registry has no untracked entries', () => {
    const error = miss()
    expect(withUntrackedHint(error, { snapshot: () => ({ meta: { untracked: [] } }) })).toBe(error)
    expect(withUntrackedHint(error, { snapshot: () => ({ meta: {} }) })).toBe(error)
  })

  it('returns the error unchanged when the message is not a missing-child miss', () => {
    const error = new Error('child "x" is not blocked')
    const coordinator = { snapshot: () => ({ meta: { untracked: [{ id: 'u' }] } }) }
    expect(withUntrackedHint(error, coordinator)).toBe(error)
  })

  it('appends the untracked count when a miss meets untracked catalog entries', () => {
    const coordinator = { snapshot: () => ({ meta: { untracked: [{ id: 'u1' }, { id: 'u2' }, { id: 'u3' }] } }) }
    const decorated = withUntrackedHint(miss(), coordinator)
    expect(decorated.message).toContain('no supervised child named "x"')
    expect(decorated.message).toContain('3 untracked continuable child(ren)')
    expect(decorated.message).toContain('partial confidence')
  })
})
