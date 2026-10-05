// The ask funnel's notification side-emit (src/worktree/index.js createAsk):
// whitelisted decision cards (merge approval, abandon confirmation) emit
// `worktree/question` for orrery-notify; the cleanup card and any unknown id
// stay silent by default; a missing userQuestions service rejects NO_PROVIDER
// without emitting; a listener failure never breaks the ask itself.
import { describe, expect, it } from './helpers.js'
import { createAsk } from '../src/worktree/index.js'

function harness({ noService = false, emitThrows = false } = {}) {
  const emitted = []
  const warnings = []
  const asked = []
  const ctx = {
    get: (name) => {
      if (name !== 'userQuestions' || noService) return undefined
      return { ask: async (request) => { asked.push(request); return { answers: [] } } }
    },
    emit: (...args) => {
      if (emitThrows) throw new Error('listener boom')
      emitted.push(args)
    },
    logger: { warn: (message) => warnings.push(message) },
  }
  return { ask: createAsk(ctx), emitted, warnings, asked }
}

const session = { id: 's1', header: { cwd: '/r' } }
const agent = { session }

describe('worktree ask funnel notification emit', () => {
  it('emits worktree/question with the session and question for the merge card, then asks', async () => {
    const h = harness()
    await h.ask(agent, [{ id: 'merge', question: 'Merge lane "Fix login" into main?' }])
    expect(h.emitted).toEqual([['worktree/question', session, { question: 'Merge lane "Fix login" into main?' }]])
    expect(h.asked).toHaveLength(1)
    expect(h.asked[0].agent).toBe(agent)
    expect(h.warnings).toHaveLength(0)
  })

  it('emits for the abandon-confirmation card', async () => {
    const h = harness()
    await h.ask(agent, [{ id: 'abandon', question: 'Abandon lane "Fix login"?' }])
    expect(h.emitted).toEqual([['worktree/question', session, { question: 'Abandon lane "Fix login"?' }]])
  })

  it('passes the abort signal through to the service', async () => {
    const h = harness()
    const controller = new AbortController()
    await h.ask(agent, [{ id: 'merge', question: 'q' }], controller.signal)
    expect(h.asked[0].signal).toBe(controller.signal)
  })

  it('stays silent for the cleanup card, unknown ids and empty questions', async () => {
    const h = harness()
    await h.ask(agent, [{ id: 'cleanup', question: 'q' }])
    await h.ask(agent, [{ id: 'future-card', question: 'q' }])
    await h.ask(agent, [{}])
    await h.ask(agent, [])
    expect(h.emitted).toHaveLength(0)
    expect(h.asked).toHaveLength(4)
  })

  it('rejects NO_PROVIDER and does not emit when no userQuestions service is available', async () => {
    const h = harness({ noService: true })
    const error = await h.ask(agent, [{ id: 'merge', question: 'q' }]).then(() => null, (/** @type {any} */ failure) => failure)
    expect(error?.code).toBe('NO_PROVIDER')
    expect(h.emitted).toHaveLength(0)
  })

  it('a throwing emit listener only warns and never breaks the ask', async () => {
    const h = harness({ emitThrows: true })
    await h.ask(agent, [{ id: 'merge', question: 'q' }])
    expect(h.asked).toHaveLength(1)
    expect(h.warnings).toHaveLength(1)
    expect(h.warnings[0]).toContain('listener boom')
  })
})
