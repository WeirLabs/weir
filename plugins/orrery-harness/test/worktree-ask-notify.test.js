// The ask funnel's notification side-emit (src/worktree/index.js createAsk):
// whitelisted decision cards (merge approval, abandon confirmation) emit
// `worktree/question` for orrery-notify; the cleanup card and any unknown id
// stay silent by default; a missing userQuestions service rejects NO_PROVIDER
// without emitting; a listener failure never breaks the ask itself.
import { describe, expect, it } from './helpers.js'
import { createAsk } from '../src/worktree/index.js'
import { createLaneService } from '../src/worktree/lanes.js'
import { createGit } from '../src/worktree/git.js'
import { makeRepo, nodeGitRun, sh } from './helpers/worktree-fixtures.js'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

  it('auto mode lands without raising any card, so the funnel emits no worktree/question', async () => {
    // The spec contract end-to-end at the funnel level: an auto-approve mode
    // bypasses deps.ask entirely, so createAsk never runs and the notify
    // side-emit never fires. Driven through the REAL lane service over a
    // disposable repository with the REAL ask funnel.
    const fixture = makeRepo()
    try {
      const emitted = []
      const asked = []
      const ctx = {
        get: (name) => (name === 'userQuestions' ? { ask: async (request) => { asked.push(request); return { answers: [] } } } : undefined),
        emit: (...args) => emitted.push(args),
        logger: { warn: () => {} },
      }
      const service = createLaneService({
        git: createGit(nodeGitRun),
        shellRun: null,
        settings: () => ({ enabled: true, root: '.orrery/worktrees', maxActive: 4, autoSetup: true }),
        ask: createAsk(ctx),
        notify: () => {},
        audit: () => {},
        modeOf: () => false,
        approveModeOf: () => 'auto-keep',
      })
      const session = { id: 's1', header: { cwd: fixture.repo } }
      const agent = { session }
      const opened = await service.open(session, { title: 'No question' })
      const bound = await service.prepareBind(session, opened.lane, { readOnly: false })
      await bound.commit('child-1')
      writeFileSync(join(opened.path, 'feature.txt'), 'feature\n')
      sh(opened.path, 'add', '.')
      sh(opened.path, 'commit', '-qm', 'work')
      await service.childSettled('child-1', session)
      const landed = await service.land(agent, opened.lane)
      expect(landed.cleanup.state).toBe('cleaned')
      expect(asked).toHaveLength(0)
      expect(emitted).toHaveLength(0)
      // the manual baseline for the SAME funnel: with manual mode the merge
      // card runs through createAsk and the emit fires exactly once
      const manualCtx = {
        get: (name) => (name === 'userQuestions' ? { ask: async (request) => {
          asked.push(request)
          return { answers: [{ id: 'merge', selected: [request.questions[0].options[0].label] }] }
        } } : undefined),
        emit: (...args) => emitted.push(args),
        logger: { warn: () => {} },
      }
      const manualService = createLaneService({
        git: createGit(nodeGitRun),
        shellRun: null,
        settings: () => ({ enabled: true, root: '.orrery/worktrees', maxActive: 4, autoSetup: true }),
        ask: createAsk(manualCtx),
        notify: () => {},
        audit: () => {},
        modeOf: () => false,
        approveModeOf: () => 'manual',
      })
      const second = await manualService.open(session, { title: 'Manual question' })
      const manualBound = await manualService.prepareBind(session, second.lane, { readOnly: false })
      await manualBound.commit('child-2')
      writeFileSync(join(second.path, 'manual.txt'), 'm\n')
      sh(second.path, 'add', '.')
      sh(second.path, 'commit', '-qm', 'work')
      await manualService.childSettled('child-2', session)
      await manualService.land(agent, second.lane)
      expect(asked).toHaveLength(1)
      expect(emitted).toHaveLength(1)
      expect(emitted[0][0]).toBe('worktree/question')
      expect(emitted[0][1]).toBe(session)
      expect(typeof emitted[0][2].question).toBe('string')
    } finally {
      fixture.cleanup()
    }
  })
})
