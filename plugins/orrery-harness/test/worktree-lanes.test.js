import { describe, expect, it } from './helpers.js'
import { exec } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGit } from '../src/worktree/git.js'
import { createLaneService } from '../src/worktree/lanes.js'
import { makeRepo, nodeGitRun, sh } from './helpers/worktree-fixtures.js'

/** Shell runner over child_process with the host runner's result shape. */
function nodeShellRun({ command, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output: `${stdout}${stderr}`, denied: false, timedOut: Boolean(error?.killed) })
    })
  })
}

function harness({ ask = null, shell = nodeShellRun, settings = {}, mode = false, locale } = {}) {
  const fixture = makeRepo()
  const notices = []
  const audits = []
  const asked = []
  const service = createLaneService({
    git: createGit(nodeGitRun),
    shellRun: shell,
    settings: () => ({ enabled: true, root: '.orrery/worktrees', maxActive: 4, autoSetup: true, ...settings }),
    ask: ask ? async (agent, questions) => { asked.push(questions); return ask(questions) } : null,
    notify: (sessionId, text) => notices.push({ sessionId, text }),
    audit: (type, data, root) => audits.push({ type, data, root }),
    modeOf: () => mode,
    localeOf: () => locale,
  })
  const session = { id: 'main-1', header: { cwd: fixture.repo } }
  const agent = { session }
  return { ...fixture, service, session, agent, notices, audits, asked }
}

async function until(predicate, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const value = await predicate()
    if (value) return value
    if (Date.now() > deadline) throw new Error('timed out waiting')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

const laneOf = async (h, id) => (await h.service.repoFor(h.repo)).ledger.read().lanes.find((lane) => lane.id === id)

/** Open a lane, bind a fake writer, commit work in it, settle. */
async function workedLane(h, title = 'Add feature', file = 'feature.txt', content = 'feature\n') {
  const opened = await h.service.open(h.session, { title })
  const bound = await h.service.prepareBind(h.session, opened.lane, { readOnly: false })
  await bound.commit('child-1')
  writeFileSync(join(opened.path, file), content)
  sh(opened.path, 'add', '.')
  sh(opened.path, 'commit', '-qm', `work on ${title}`)
  await h.service.childSettled('child-1', h.session)
  return opened.lane
}

describe('worktree lane service: open', () => {
  it('opens a lane on a derived branch, writes the local exclude, and is ready without setup', async () => {
    const h = harness()
    try {
      const opened = await h.service.open(h.session, { title: 'Fix login redirect' })
      expect(opened.lane).toBe('fix-login-redirect-001')
      expect(opened.branch).toBe('orrery/fix-login-redirect-001')
      expect(opened.state).toBe('ready')
      expect(opened.next).toEqual({ tool: 'delegate', args: { worktree: 'fix-login-redirect-001' }, hint: 'delegate the lane work with worktree set to this lane' })
      expect(existsSync(join(opened.path, 'a.txt'))).toBe(true)
      expect(sh(h.repo, 'status', '--porcelain')).toBe('')
      expect(readFileSync(join(h.repo, '.git', 'info', 'exclude'), 'utf8')).toContain('/.orrery/\n')
      expect(h.audits.map((entry) => entry.type)).toContain('open')
      expect(h.audits.every((entry) => entry.root === h.repo)).toBe(true)
    } finally {
      h.cleanup()
    }
  })

  it('refuses detached HEAD, overlapping scopes, and the active limit', async () => {
    const h = harness({ settings: { maxActive: 2 } })
    try {
      await h.service.open(h.session, { title: 'auth', scope: ['src/auth/**'] })
      await h.service.open(h.session, { title: 'billing', scope: ['src/billing/**'] }).then(() => {})
      await h.service.open(h.session, { title: 'third' }).then(
        () => expect('opened').toBe('refused'),
        (error) => expect(error.code).toBe('MAX_ACTIVE'),
      )
      const h2 = harness()
      try {
        await h2.service.open(h2.session, { title: 'auth', scope: ['src/auth/**'] })
        await h2.service.open(h2.session, { title: 'all src', scope: ['src/**'] }).then(
          () => expect('opened').toBe('refused'),
          (error) => expect(error.code).toBe('SCOPE_OVERLAP'),
        )
        sh(h2.repo, 'checkout', '-q', '--detach')
        await h2.service.open(h2.session, { title: 'x' }).then(
          () => expect('opened').toBe('refused'),
          (error) => expect(error.code).toBe('DETACHED_HEAD'),
        )
      } finally {
        h2.cleanup()
      }
    } finally {
      h.cleanup()
    }
  })

  it('refuses outside a repository and with the capability off', async () => {
    const h = harness()
    try {
      const outside = { id: 's', header: { cwd: h.root } }
      await h.service.open(outside, { title: 'x' }).then(() => expect(1).toBe(0), (error) => expect(error.code).toBe('NOT_A_REPO'))
      const off = harness({ settings: { enabled: false } })
      try {
        await off.service.open(off.session, { title: 'x' }).then(() => expect(1).toBe(0), (error) => expect(error.code).toBe('WORKTREE_DISABLED'))
      } finally {
        off.cleanup()
      }
    } finally {
      h.cleanup()
    }
  })

  it('runs lockfile-derived setup in the background and reports setup failure', async () => {
    const h = harness({ shell: async ({ command }) => ({ code: command.startsWith('pnpm') ? 3 : 0, output: 'boom', denied: false, timedOut: false }) })
    try {
      writeFileSync(join(h.repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
      sh(h.repo, 'add', '.')
      sh(h.repo, 'commit', '-qm', 'lock')
      const opened = await h.service.open(h.session, { title: 'with deps' })
      expect(opened.state).toBe('preparing')
      expect(opened.next.waitFor).toBe('lane-ready')
      const failed = await until(async () => {
        const lane = await laneOf(h, opened.lane)
        return lane.state === 'setup-failed' ? lane : null
      })
      expect(failed.reason).toBe('setup exited 3')
      expect(h.notices.at(-1).text).toContain('setup-failed')
      await h.service.prepareBind(h.session, opened.lane, { readOnly: false }).then(() => expect(1).toBe(0), (error) => expect(error.code).toBe('LANE_NOT_DISPATCHABLE'))
      const skipped = await h.service.setup(h.session, opened.lane, { skip: true })
      expect(skipped.state).toBe('ready')
    } finally {
      h.cleanup()
    }
  })

  it('reports a sandbox-denied setup with the recovery commands', async () => {
    const h = harness({ shell: async () => ({ code: 1, output: 'denied', denied: true, timedOut: false }) })
    try {
      writeFileSync(join(h.repo, 'package-lock.json'), '{}\n')
      sh(h.repo, 'add', '.')
      sh(h.repo, 'commit', '-qm', 'lock')
      const opened = await h.service.open(h.session, { title: 'denied' })
      const failed = await until(async () => {
        const lane = await laneOf(h, opened.lane)
        return lane.state === 'setup-failed' ? lane : null
      })
      expect(failed.reason).toContain('sandbox denied')
      expect(failed.reason).toContain(`/worktree setup ${opened.lane} --skip`)
    } finally {
      h.cleanup()
    }
  })

  it('skips setup entirely when autoSetup is off', async () => {
    const h = harness({ settings: { autoSetup: false } })
    try {
      writeFileSync(join(h.repo, 'pnpm-lock.yaml'), 'x\n')
      sh(h.repo, 'add', '.')
      sh(h.repo, 'commit', '-qm', 'lock')
      expect((await h.service.open(h.session, { title: 'no setup' })).state).toBe('ready')
    } finally {
      h.cleanup()
    }
  })
})

describe('worktree lane service: binding and settlement', () => {
  it('binds one writer at a time and rolls back an aborted spawn', async () => {
    const h = harness()
    try {
      const { lane } = await h.service.open(h.session, { title: 'busy' })
      const first = await h.service.prepareBind(h.session, lane, { readOnly: false })
      expect(first.lane.state).toBe('working')
      expect(first.contract).toContain(`workdir="${first.lane.path}"`)
      await h.service.prepareBind(h.session, lane, { readOnly: false }).then(() => expect(1).toBe(0), (error) => expect(error.code).toBe('LANE_BUSY'))
      const reader = await h.service.prepareBind(h.session, lane, { readOnly: true })
      expect(reader.lane.state).toBe('working')
      await first.rollback()
      expect((await laneOf(h, lane)).state).toBe('ready')
      expect((await laneOf(h, lane)).boundChild).toBeNull()
    } finally {
      h.cleanup()
    }
  })

  it('settles a writer into dirty, no-commits, and landable (verification disabled)', async () => {
    const h = harness()
    try {
      const { lane, path } = await h.service.open(h.session, { title: 'settle' })
      let bound = await h.service.prepareBind(h.session, lane, { readOnly: false })
      await bound.commit('c1')
      await h.service.childSettled('c1', h.session)
      expect((await laneOf(h, lane)).state).toBe('no-commits')
      bound = await h.service.prepareBind(h.session, lane, { readOnly: false })
      await bound.commit('c2')
      writeFileSync(join(path, 'x.txt'), 'x\n')
      await h.service.childSettled('c2', h.session)
      expect((await laneOf(h, lane)).state).toBe('dirty')
      expect(h.notices.at(-1).text).toContain('dirty')
      bound = await h.service.prepareBind(h.session, lane, { readOnly: false })
      await bound.commit('c3')
      sh(path, 'add', '.')
      sh(path, 'commit', '-qm', 'x')
      await h.service.childSettled('c3', h.session)
      const landable = await laneOf(h, lane)
      expect(landable.state).toBe('landable')
      expect(landable.landableTree).toBe(sh(path, 'rev-parse', 'HEAD^{tree}'))
      expect(landable.check).toEqual({ enabled: false, tree: landable.landableTree })
      expect(h.notices.at(-1).text).toContain(`next: worktree_land({"lane":"${lane}"})`)
    } finally {
      h.cleanup()
    }
  })

  it('a new commit voids the landable conclusion', async () => {
    const h = harness()
    try {
      const lane = await workedLane(h)
      const { path } = await laneOf(h, lane)
      writeFileSync(join(path, 'more.txt'), 'm\n')
      sh(path, 'add', '.')
      sh(path, 'commit', '-qm', 'more')
      await h.service.land(h.agent, lane).then(() => expect(1).toBe(0), (error) => expect(error.code).toBe('NOT_LANDABLE'))
      expect((await laneOf(h, lane)).state).toBe('working')
    } finally {
      h.cleanup()
    }
  })
})

describe('worktree lane service: verification', () => {
  const config = (h, check) => {
    mkdirSync(join(h.repo, '.orrery', 'worktrees'), { recursive: true })
    writeFileSync(join(h.repo, '.orrery', 'worktrees', '.config.json'), JSON.stringify({ check }))
  }

  it('runs configured commands in order and lands on pass', async () => {
    const h = harness()
    try {
      config(h, [{ name: 'one', run: 'echo one' }, { name: 'two', run: 'echo two' }])
      const lane = await workedLane(h)
      const passed = await until(async () => {
        const record = await laneOf(h, lane)
        return record.state === 'landable' ? record : null
      })
      expect(passed.check.results.map((entry) => [entry.name, entry.exit])).toEqual([['one', 0], ['two', 0]])
      expect(readFileSync(passed.check.results[0].log, 'utf8')).toContain('one')
    } finally {
      h.cleanup()
    }
  })

  it('stops at the first failure and blocks landing', async () => {
    const h = harness()
    try {
      config(h, [{ name: 'ok', run: 'true' }, { name: 'bad', run: 'echo nope; exit 4' }, { name: 'never', run: 'touch never-ran' }])
      const lane = await workedLane(h)
      const failed = await until(async () => {
        const record = await laneOf(h, lane)
        return record.state === 'check-failed' ? record : null
      })
      expect(failed.reason).toBe('bad exited 4')
      expect(failed.check.results.map((entry) => entry.name)).toEqual(['ok', 'bad'])
      expect(existsSync(join(failed.path, 'never-ran'))).toBe(false)
      expect(h.notices.at(-1).text).toContain('nope')
      await h.service.land(h.agent, lane).then(() => expect(1).toBe(0), (error) => expect(error.code).toBe('NOT_LANDABLE'))
    } finally {
      h.cleanup()
    }
  })

  it('treats a command that rewrites tracked files as a failure', async () => {
    const h = harness()
    try {
      config(h, [{ name: 'fmt', run: 'echo changed > feature.txt' }])
      const lane = await workedLane(h)
      const failed = await until(async () => {
        const record = await laneOf(h, lane)
        return record.state === 'check-failed' ? record : null
      })
      expect(failed.reason).toBe('verification modified lane content')
    } finally {
      h.cleanup()
    }
  })

  it('reports VERIFICATION_DISABLED for a verification-only check without config', async () => {
    const h = harness()
    try {
      const lane = await workedLane(h)
      await h.service.check(h.session, lane, { verificationOnly: true }).then(() => expect(1).toBe(0), (error) => expect(error.code).toBe('VERIFICATION_DISABLED'))
    } finally {
      h.cleanup()
    }
  })
})

describe('worktree lane service: landing', () => {
  const approve = (questions) => ({ answers: [{ id: questions[0].id, selected: [questions[0].options[0].label] }] })

  it('asks, merges --no-ff with the templated message, and records the merge', async () => {
    const h = harness({ ask: approve })
    try {
      const lane = await workedLane(h, 'Add feature')
      const landed = await h.service.land(h.agent, lane)
      expect(landed.state).toBe('landed')
      expect(sh(h.repo, 'log', '-1', '--format=%s')).toBe(`merge(lane): Add feature (${lane})`)
      expect(sh(h.repo, 'rev-list', '--count', '--merges', 'HEAD')).toBe('1')
      expect(h.asked[0][0].options.map((option) => option.label)).toEqual(['Merge into main (--no-ff)', 'Not now'])
      expect(h.asked[0][0].detail).toContain('Verification: not enabled for this repository')
      expect(landed.diff).toContain('feature.txt')
    } finally {
      h.cleanup()
    }
  })

  it('declines on "Not now", free text, dismissal, and a missing answerer', async () => {
    for (const [name, ask] of [
      ['not now', (questions) => ({ answers: [{ id: questions[0].id, selected: ['Not now'] }] })],
      ['free text', (questions) => ({ answers: [{ id: questions[0].id, selected: [], custom: 'wait for review' }] })],
      ['dismissed', () => { const error = new Error('cancelled'); error.code = 'ASK_CANCELLED'; throw error }],
      ['no answerer', null],
    ]) {
      const h = harness({ ask })
      try {
        const lane = await workedLane(h)
        const head = sh(h.repo, 'rev-parse', 'HEAD')
        const outcome = await h.service.land(h.agent, lane)
        expect(outcome.state, name).toBe('declined')
        expect(sh(h.repo, 'rev-parse', 'HEAD'), name).toBe(head)
        if (name === 'free text') expect(outcome.feedback).toBe('wait for review')
      } finally {
        h.cleanup()
      }
    }
  })

  it('conflicts are reported without asking and without touching main', async () => {
    const h = harness({ ask: approve })
    try {
      const lane = await workedLane(h, 'conflict', 'a.txt', 'lane\n')
      writeFileSync(join(h.repo, 'a.txt'), 'main\n')
      sh(h.repo, 'commit', '-qam', 'main change')
      const head = sh(h.repo, 'rev-parse', 'HEAD')
      const outcome = await h.service.land(h.agent, lane)
      expect(outcome.state).toBe('conflicted')
      expect(outcome.conflicts).toEqual(['a.txt'])
      expect(h.asked).toHaveLength(0)
      expect(sh(h.repo, 'rev-parse', 'HEAD')).toBe(head)
    } finally {
      h.cleanup()
    }
  })

  it('refuses a moved base, a staged index, and overlapping dirty files', async () => {
    const h = harness({ ask: approve })
    try {
      const lane = await workedLane(h, 'guards', 'feature.txt')
      sh(h.repo, 'checkout', '-q', '-b', 'other')
      await h.service.land(h.agent, lane).then(() => expect(1).toBe(0), (error) => expect(error.code).toBe('BASE_MOVED'))
      expect((await laneOf(h, lane)).baseMoved).toBe(true)
      sh(h.repo, 'checkout', '-q', 'main')
      writeFileSync(join(h.repo, 'staged.txt'), 's\n')
      sh(h.repo, 'add', 'staged.txt')
      await h.service.land(h.agent, lane).then(() => expect(1).toBe(0), (error) => expect(error.code).toBe('MAIN_STAGED'))
      sh(h.repo, 'reset', '-q')
      writeFileSync(join(h.repo, 'feature.txt'), 'local\n')
      await h.service.land(h.agent, lane).then(() => expect(1).toBe(0), (error) => expect(error.code).toBe('MAIN_DIRTY_OVERLAP'))
    } finally {
      h.cleanup()
    }
  })

  it('does not act on an approval when main moved while the card was open', async () => {
    let h
    h = harness({
      ask: (questions) => {
        writeFileSync(join(h.repo, 'late.txt'), 'late\n')
        sh(h.repo, 'add', '.')
        sh(h.repo, 'commit', '-qm', 'late')
        return approve(questions)
      },
    })
    try {
      const lane = await workedLane(h)
      await h.service.land(h.agent, lane).then(() => expect(1).toBe(0), (error) => expect(error.code).toBe('STALE_LANDABLE'))
      expect(sh(h.repo, 'log', '-1', '--format=%s')).toBe('late')
      expect((await laneOf(h, lane)).state).toBe('declined')
    } finally {
      h.cleanup()
    }
  })

  it('declines a lane whose approval card died with its process', async () => {
    const h = harness({ ask: approve })
    try {
      const lane = await workedLane(h)
      const repo = await h.service.repoFor(h.repo)
      await repo.ledger.update((ledger) => {
        const record = ledger.lanes.find((entry) => entry.id === lane)
        record.state = 'awaiting-approval'
        record.asking = { pid: 999999999, at: 1 }
        return { ledger }
      })
      const view = await h.service.view(h.session)
      expect(view.lanes[0].state).toBe('declined')
      expect(view.lanes[0].reason).toContain('approval card was closed')
    } finally {
      h.cleanup()
    }
  })

  it('writes the cards in the GUI language and still recognizes the answers', async () => {
    const pickFirst = (questions) => ({ answers: [{ id: questions[0].id, selected: [questions[0].options[0].label] }] })
    const h = harness({ ask: pickFirst, locale: 'zh' })
    try {
      const lane = await workedLane(h, 'Add feature')
      const landed = await h.service.land(h.agent, lane)
      expect(landed.state).toBe('landed')
      const card = h.asked[0][0]
      expect(card.header).toBe('Worktree 合并')
      expect(card.options.map((option) => option.label)).toEqual(['合并到 main（--no-ff）', '暂不合并'])
      expect(card.detail).toContain('验证：本仓库未启用')
      const cleaned = await h.service.askCleanup(h.agent, lane)
      expect(cleaned.state).toBe('kept')
      expect(h.asked[1][0].options.map((option) => option.label)).toEqual(['保留 worktree', '清理 worktree', '清理 worktree 和分支'])
      expect(h.asked[1][0].detail).toContain('.orrery/worktrees/')
      expect(h.asked[1][0].detail).not.toContain(h.repo)
    } finally {
      h.cleanup()
    }
  })

  it('a user-issued land needs no card', async () => {
    const h = harness({ ask: () => { throw new Error('must not ask') } })
    try {
      const lane = await workedLane(h)
      expect((await h.service.land(h.agent, lane, { userApproved: true })).state).toBe('landed')
    } finally {
      h.cleanup()
    }
  })
})

describe('worktree lane service: cleanup and abandon', () => {
  const pick = (label) => (questions) => ({ answers: [{ id: questions[0].id, selected: [label] }] })

  it('cleanup copies scratch, removes the worktree, and deletes the merged branch', async () => {
    const h = harness({ ask: pick('Merge into main (--no-ff)') })
    try {
      const lane = await workedLane(h)
      const { path } = await laneOf(h, lane)
      mkdirSync(join(path, '.orrery'), { recursive: true })
      writeFileSync(join(path, '.orrery', 'notes.md'), 'notes')
      writeFileSync(join(h.repo, '.git', 'info', 'exclude'), `${readFileSync(join(h.repo, '.git', 'info', 'exclude'), 'utf8')}\n/.orrery/\n`)
      await h.service.land(h.agent, lane)
      const cleaned = await h.service.cleanup(h.session, lane, 'all')
      expect(cleaned.state).toBe('cleaned')
      expect(existsSync(path)).toBe(false)
      expect(readFileSync(join(h.repo, '.orrery', 'lanes', lane, 'notes.md'), 'utf8')).toBe('notes')
      expect(sh(h.repo, 'branch', '--list', `orrery/${lane}`)).toBe('')
    } finally {
      h.cleanup()
    }
  })

  it('keep leaves everything and frees the active slot', async () => {
    const h = harness({ ask: pick('Merge into main (--no-ff)') })
    try {
      const lane = await workedLane(h)
      await h.service.land(h.agent, lane)
      const kept = await h.service.cleanup(h.session, lane, 'keep')
      expect(kept.state).toBe('kept')
      expect(existsSync(kept.path)).toBe(true)
    } finally {
      h.cleanup()
    }
  })

  it('a blocked removal is not forced and keeps the state', async () => {
    const h = harness({ ask: pick('Merge into main (--no-ff)') })
    try {
      const lane = await workedLane(h)
      await h.service.land(h.agent, lane)
      const { path } = await laneOf(h, lane)
      writeFileSync(join(path, 'stray.txt'), 'untracked')
      await h.service.cleanup(h.session, lane, 'worktree').then(() => expect(1).toBe(0), (error) => expect(error.code).toBe('REMOVE_BLOCKED'))
      expect((await laneOf(h, lane)).state).toBe('landed')
      expect(existsSync(path)).toBe(true)
    } finally {
      h.cleanup()
    }
  })

  it('abandon states the unmerged commits and force-deletes only on the user choice', async () => {
    const h = harness({ ask: pick('Remove worktree and branch') })
    try {
      const lane = await workedLane(h)
      const abandoned = await h.service.abandon(h.agent, lane)
      expect(abandoned.state).toBe('abandoned')
      expect(h.asked[0][0].detail).toContain('1 unmerged commit(s)')
      expect(sh(h.repo, 'branch', '--list', `orrery/${lane}`)).toBe('')
      const h2 = harness({ ask: pick('Cancel') })
      try {
        const lane2 = await workedLane(h2)
        expect((await h2.service.abandon(h2.agent, lane2)).state).toBe('landable')
      } finally {
        h2.cleanup()
      }
    } finally {
      h.cleanup()
    }
  })
})

describe('worktree lane service: reconciliation and views', () => {
  it('marks a hand-deleted lane missing and leaves unmanaged worktrees alone', async () => {
    const h = harness()
    try {
      const { lane, path } = await h.service.open(h.session, { title: 'gone' })
      sh(h.repo, 'worktree', 'remove', path)
      sh(h.repo, 'worktree', 'add', '-q', '-b', 'manual', join(h.repo, '.orrery', 'worktrees', 'manual'))
      const view = await h.service.view(h.session)
      expect(view.lanes.find((entry) => entry.id === lane).state).toBe('abandoned')
      expect(view.lanes.find((entry) => entry.id === lane).reason).toBe('missing')
      expect(view.unmanaged).toHaveLength(1)
      expect(existsSync(join(h.repo, '.orrery', 'worktrees', 'manual'))).toBe(true)
    } finally {
      h.cleanup()
    }
  })

  it('the view reports repo facts, counts, next steps, and legal actions', async () => {
    const h = harness()
    try {
      const lane = await workedLane(h)
      const view = await h.service.view(h.session)
      expect(view.available).toBe(true)
      expect(view.repo.branch).toBe('main')
      expect(view.repo.exclude).toBe(true)
      expect(view.repo.verification.enabled).toBe(false)
      const entry = view.lanes[0]
      expect(entry.id).toBe(lane)
      expect(entry.ahead).toBe(1)
      expect(entry.stat).toEqual({ files: 1, added: 1, removed: 0 })
      expect(entry.actions.land).toEqual({ enabled: true })
      expect(entry.actions.clean.enabled).toBe(false)
      expect(view.ownedBySession).toEqual([lane])
      expect(h.service.board(h.session)).toContain(`${lane} · landable`)
    } finally {
      h.cleanup()
    }
  })

  it('the view reports an unavailable repository instead of throwing', async () => {
    const h = harness()
    try {
      const view = await h.service.view({ id: 'x', header: { cwd: h.root } })
      expect(view.available).toBe(false)
      expect(view.error.code).toBe('NOT_A_REPO')
    } finally {
      h.cleanup()
    }
  })

  it('rebuilds a corrupt ledger only on explicit request', async () => {
    const h = harness()
    try {
      const { lane } = await h.service.open(h.session, { title: 'rebuild me' })
      writeFileSync(join(h.repo, '.orrery', 'worktrees', 'lanes.json'), 'garbage')
      await h.service.open(h.session, { title: 'x' }).then(() => expect(1).toBe(0), (error) => expect(error.code).toBe('LEDGER_CORRUPT'))
      const outcome = await h.service.reconcile(h.session, { rebuild: true })
      expect(outcome.rebuilt).toEqual([lane])
      expect((await laneOf(h, lane)).state).toBe('working')
    } finally {
      h.cleanup()
    }
  })

  it('suggests verification commands without writing them, and writes only on request', async () => {
    const h = harness()
    try {
      writeFileSync(join(h.repo, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
      const suggestions = await h.service.initSuggestions(h.session)
      expect(suggestions.suggested.check).toEqual([{ name: 'test', run: 'npm run test' }])
      expect(existsSync(suggestions.file)).toBe(false)
      const written = await h.service.writeConfig(h.session, { check: suggestions.suggested.check })
      expect(JSON.parse(readFileSync(written.file, 'utf8')).check[0].run).toBe('npm run test')
      expect(sh(h.repo, 'status', '--porcelain')).toBe('?? package.json')
    } finally {
      h.cleanup()
    }
  })
})
