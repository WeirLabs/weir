import { describe, expect, it } from './helpers.js'
import { exec } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createGit } from '../src/worktree/git.js'
import { createLaneService } from '../src/worktree/lanes.js'
import { makeRepo, nodeGitRun, sh } from './helpers/worktree-fixtures.js'
import { openEditLockStore } from '../src/edit-lock/store.js'
import { createEditLockManager } from '../src/edit-lock/manager.js'
import { createWorktreeTools } from '../src/worktree/tools.js'

/** Shell runner over child_process with the host runner's result shape. */
function nodeShellRun({ command, cwd, timeoutMs }) {
  return new Promise((resolve) => {
    exec(command, { cwd, timeout: timeoutMs }, (error, stdout, stderr) => {
      resolve({ code: error ? (typeof error.code === 'number' ? error.code : 1) : 0, output: `${stdout}${stderr}`, denied: false, timedOut: Boolean(error?.killed) })
    })
  })
}

function fakeClock(start = 1_760_000_000_000) {
  return {
    value: start,
    timers: new Map(),
    seq: 0,
    set(handler, delayMs) { const id = ++this.seq; this.timers.set(id, { handler, at: this.value + delayMs }); return id },
    clear(id) { this.timers.delete(id) },
    /** Fire every timer due at `value` (all of them when `all`). Handlers run their async work detached. */
    fire(all = false) {
      for (const [id, timer] of [...this.timers]) {
        if (all || timer.at <= this.value) { this.timers.delete(id); timer.handler() }
      }
    },
  }
}

function harness({ ask = null, shell = nodeShellRun, settings = {}, mode = false, locale, resolveSetup, clock, authorityResidue, approveMode = 'manual', approveModeSource = 'global', bindingLiveness } = {}) {
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
    approveModeOf: () => approveMode,
    approveModeSourceOf: () => approveModeSource,
    ...(bindingLiveness !== undefined ? { bindingLiveness } : {}),
    localeOf: () => locale,
    ...(resolveSetup !== undefined ? { resolveSetup } : {}),
    ...(authorityResidue !== undefined ? { authorityResidue } : {}),
    ...(clock ? { now: () => clock.value, setTimer: (handler, delayMs) => clock.set(handler, delayMs), clearTimer: (id) => clock.clear(id) } : {}),
  })
  const session = { id: 'main-1', header: { cwd: fixture.repo } }
  const agent = { session }
  return { ...fixture, service, session, agent, notices, audits, asked }
}

/** A second lane-service instance over the SAME fixture repository (the
 * multi-instance race: two host processes sharing one ledger). */
function secondInstance(h, { clock, pid } = {}) {
  const notices = []
  const audits = []
  const service = createLaneService({
    git: createGit(nodeGitRun),
    shellRun: null,
    settings: () => ({ enabled: true, root: '.orrery/worktrees', maxActive: 4, autoSetup: true }),
    ask: null,
    notify: (sessionId, text) => notices.push({ sessionId, text }),
    audit: (type, data, root) => audits.push({ type, data, root }),
    modeOf: () => false,
    ...(clock ? { now: () => clock.value, setTimer: (handler, delayMs) => clock.set(handler, delayMs), clearTimer: (id) => clock.clear(id) } : {}),
    ...(pid ? { pid } : {}),
  })
  return { service, notices, audits }
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

  it('derived setup runs through the resolver: bundled node + pnpm.mjs + PATH injection, frozen lockfile intact', async () => {
    const calls = []
    const bundledNode = '/ds h/dsh-runtimes/rt/dependencies/node/bin/node'
    const bundledPnpm = '/ds h/dsh-runtimes/rt/dependencies/pnpm/bin/pnpm.mjs'
    const h = harness({
      resolveSetup: async (manager) => {
        calls.push(manager)
        return {
          ok: true, source: 'bundled', display: `node ${bundledPnpm} install --frozen-lockfile`,
          command: `export PATH='${bundledNode.slice(0, bundledNode.lastIndexOf('/'))}':"$PATH"; exec '${bundledNode}' '${bundledPnpm}' install --frozen-lockfile`,
        }
      },
      shell: async ({ command }) => ({ code: 0, output: `ran: ${command}`, denied: false, timedOut: false }),
    })
    try {
      writeFileSync(join(h.repo, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
      sh(h.repo, 'add', '.')
      sh(h.repo, 'commit', '-qm', 'lock')
      const opened = await h.service.open(h.session, { title: 'bundled' })
      expect(calls).toEqual(['pnpm'])
      expect(opened.summary).toContain('node /ds h/')
      const ready = await until(async () => {
        const lane = await laneOf(h, opened.lane)
        return lane.state === 'ready' ? lane : null
      })
      const log = readFileSync(ready.setup.log, 'utf8')
      expect(log).toContain(`exec '${bundledNode}' '${bundledPnpm}' install --frozen-lockfile`)
      expect(log).toContain('export PATH=')
      expect(log).toContain('--frozen-lockfile')
      // Provenance, not the executable string, is what the ledger keeps.
      expect(ready.setup.provenance).toEqual({ kind: 'derived', manager: 'pnpm' })
      expect(ready.setup.display).toBe(`node ${bundledPnpm} install --frozen-lockfile`)
    } finally {
      h.cleanup()
    }
  })

  it('a configured setup string is executed verbatim, never rewritten', async () => {
    let resolved = 0
    const h = harness({
      resolveSetup: async () => { resolved++; return { ok: true, source: 'system', command: 'SHOULD_NOT_BE_USED', display: 'x' } },
      shell: async ({ command }) => ({ code: 0, output: command, denied: false, timedOut: false }),
    })
    try {
      mkdirSync(join(h.repo, '.orrery', 'worktrees'), { recursive: true })
      writeFileSync(join(h.repo, '.orrery', 'worktrees', '.config.json'), JSON.stringify({ setup: 'echo my-custom-setup' }))
      writeFileSync(join(h.repo, 'pnpm-lock.yaml'), 'x\n')
      sh(h.repo, 'add', '.')
      sh(h.repo, 'commit', '-qm', 'lock')
      await h.service.open(h.session, { title: 'configured' })
      const ready = await until(async () => {
        const lanes = (await h.service.repoFor(h.repo)).ledger.read().lanes
        return lanes[0]?.state === 'ready' ? lanes[0] : null
      })
      expect(resolved).toBe(0)
      expect(readFileSync(ready.setup.log, 'utf8')).toContain('echo my-custom-setup')
      expect(readFileSync(ready.setup.log, 'utf8')).not.toContain('SHOULD_NOT_BE_USED')
    } finally {
      h.cleanup()
    }
  })

  it('a manager that resolves nowhere fails with the three remedies, before any shell call', async () => {
    let shellCalls = 0
    const h = harness({
      resolveSetup: async () => ({ ok: false, manager: 'pnpm' }),
      shell: async () => { shellCalls++; return { code: 0, output: '', denied: false, timedOut: false } },
    })
    try {
      writeFileSync(join(h.repo, 'pnpm-lock.yaml'), 'x\n')
      sh(h.repo, 'add', '.')
      sh(h.repo, 'commit', '-qm', 'lock')
      const opened = await h.service.open(h.session, { title: 'missing tool' })
      expect(opened.state).toBe('setup-failed')
      expect(shellCalls).toBe(0)
      expect(opened.summary).toContain('setup needs pnpm')
      expect(opened.summary).toContain('/worktree setup <lane> --skip'.replace('<lane>', opened.lane))
      expect(opened.summary).toContain('.config.json')
      // Retrying while the tool is still missing keeps the legal state and
      // refreshes the diagnosis — no transition error, still no shell call.
      const retried = await h.service.setup(h.session, opened.lane)
      expect(shellCalls).toBe(0)
      expect(retried.state).toBe('setup-failed')
      expect(retried.summary).toContain('setup needs pnpm')
    } finally {
      h.cleanup()
    }
  })

  it('a retry after a real setup failure re-resolves instead of replaying the display string', async () => {
    const runs = []
    let attempts = 0
    const h = harness({
      resolveSetup: async (manager) => ({
        ok: true, source: 'bundled', display: `node /bundled/pnpm.mjs install --frozen-lockfile`,
        command: `export PATH='/bundled node/bin':"$PATH"; exec '/bundled node/bin/node' /bundled/pnpm.mjs install --frozen-lockfile`,
      }),
      shell: async ({ command }) => {
        attempts++
        runs.push(command)
        return { code: attempts === 1 ? 1 : 0, output: attempts === 1 ? 'lockfile out of date' : 'ok', denied: false, timedOut: false }
      },
    })
    try {
      writeFileSync(join(h.repo, 'pnpm-lock.yaml'), 'x\n')
      sh(h.repo, 'add', '.')
      sh(h.repo, 'commit', '-qm', 'lock')
      const opened = await h.service.open(h.session, { title: 'retry' })
      await until(async () => {
        const lane = await laneOf(h, opened.lane)
        return lane.state === 'setup-failed' ? lane : null
      })
      await h.service.setup(h.session, opened.lane)
      await until(async () => {
        const lane = await laneOf(h, opened.lane)
        return lane.state === 'ready' ? lane : null
      })
      expect(attempts).toBe(2)
      // BOTH attempts executed the resolved invocation — never the display.
      for (const command of runs) {
        expect(command).toContain(`exec '/bundled node/bin/node'`)
        expect(command).not.toBe('node /bundled/pnpm.mjs install --frozen-lockfile')
      }
    } finally {
      h.cleanup()
    }
  })

  it('without a resolver the legacy bare command still runs', async () => {
    const h = harness({ shell: async ({ command }) => ({ code: 0, output: command, denied: false, timedOut: false }) })
    try {
      writeFileSync(join(h.repo, 'pnpm-lock.yaml'), 'x\n')
      sh(h.repo, 'add', '.')
      sh(h.repo, 'commit', '-qm', 'lock')
      await h.service.open(h.session, { title: 'legacy' })
      const ready = await until(async () => {
        const lanes = (await h.service.repoFor(h.repo)).ledger.read().lanes
        return lanes[0]?.state === 'ready' ? lanes[0] : null
      })
      expect(readFileSync(ready.setup.log, 'utf8')).toContain('pnpm install --frozen-lockfile')
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

describe('worktree lane service: authority-residue warning', () => {
  const pickFirst = (questions) => ({ answers: [{ id: questions[0].id, selected: [questions[0].options[0].label] }] })
  const pick = (label) => (questions) => ({ answers: [{ id: questions[0].id, selected: [label] }] })
  const residue = { operations: 1, locks: 1 }

  it('warns on the cleanup card when the probe finds residue, silently passes without it', async () => {
    const h = harness({ ask: pickFirst, authorityResidue: () => residue })
    try {
      const lane = await workedLane(h)
      await h.service.land(h.agent, lane)
      const cleaned = await h.service.askCleanup(h.agent, lane)
      expect(cleaned.state).toBe('kept') // pickFirst chose 'Keep worktree': warning never blocks
      const card = h.asked.at(-1)[0]
      expect(card.header).toBe('Worktree cleanup')
      expect(card.detail).toContain('⚠️ **Edit Lock residue**')
      expect(card.detail).toContain('maintenance panel')
      expect(card.detail).toContain('stale-lock')
      const h2 = harness({ ask: pickFirst, authorityResidue: () => null })
      try {
        const lane2 = await workedLane(h2)
        await h2.service.land(h2.agent, lane2)
        await h2.service.askCleanup(h2.agent, lane2)
        expect(h2.asked.at(-1)[0].detail).not.toContain('⚠️')
      } finally {
        h2.cleanup()
      }
    } finally {
      h.cleanup()
    }
  })

  it('warns on the abandon card and in the removal summary, never blocking the transition', async () => {
    const h = harness({ ask: pick('Remove worktree and branch'), authorityResidue: () => residue })
    try {
      const lane = await workedLane(h)
      const abandoned = await h.service.abandon(h.agent, lane)
      expect(abandoned.state).toBe('abandoned')
      expect(h.asked[0][0].detail).toContain('⚠️ **Edit Lock residue**')
      expect(abandoned.summary).toContain('warning:')
      expect(abandoned.summary).toContain('stale-lock sweep')
      expect(existsSync(abandoned.path)).toBe(false)
      expect(sh(h.repo, 'branch', '--list', `orrery/${lane}`)).toBe('')
    } finally {
      h.cleanup()
    }
  })

  it('adds the warning to the direct cleanup summary and a throwing probe never blocks', async () => {
    const h = harness({ ask: pick('Merge into main (--no-ff)'), authorityResidue: () => residue })
    try {
      const lane = await workedLane(h)
      await h.service.land(h.agent, lane)
      const cleaned = await h.service.cleanup(h.session, lane, 'all')
      expect(cleaned.state).toBe('cleaned')
      expect(cleaned.summary).toContain('warning:')
      expect(cleaned.summary).toContain('1 unresolved Edit Lock operation(s)')
      expect(cleaned.summary).toContain('1 Edit Lock lock(s)')
      const h2 = harness({ ask: pick('Merge into main (--no-ff)'), authorityResidue: () => { throw new Error('authority exploded') } })
      try {
        const lane2 = await workedLane(h2)
        await h2.service.land(h2.agent, lane2)
        const cleaned2 = await h2.service.cleanup(h2.session, lane2, 'all')
        expect(cleaned2.state).toBe('cleaned')
        expect(cleaned2.summary).not.toContain('warning:')
      } finally {
        h2.cleanup()
      }
    } finally {
      h.cleanup()
    }
  })

  it('the default probe reads the real authority under the main root (no injection)', async () => {
    const h = harness({ ask: pick('Merge into main (--no-ff)') })
    try {
      const lane = await workedLane(h)
      // A real authority in the fixture's main root whose owner session is
      // the lane's ownerSession ('main-1'), left with an unknown publication
      // and its retained lock.
      const directory = join(h.repo, '.orrery', 'edit-lock')
      mkdirSync(directory, { recursive: true })
      const store = await openEditLockStore({ directory, domainId: h.repo, mode: 'create' })
      const manager = createEditLockManager({ store, managerIncarnation: 'm' })
      const child = await manager.openSession('main-1')
      const token = await manager.acquire(child, '/w/child.txt')
      const publisher = { validate() {}, publish: async () => { throw new Error('invoked failure') }, identify: () => token.resourceId }
      const ready = await manager.prepare(child, {
        operationId: 'interrupted', tool: 'write', filePath: '/w/child.txt', cwd: '/w', args: {}, content: 'new',
        effectivePolicy: { mode: 'workspace-write' },
        target: { kind: 'update', resourceId: token.resourceId, generation: token.generation, policy: { kind: 'replaceIfVersion', version: 'old' } },
      }, publisher)
      await manager.commit(ready.submission).then(() => expect(1).toBe(0), () => {})
      await store.close()
      const before = readFileSync(join(directory, 'snapshot.json'))
      await h.service.land(h.agent, lane)
      const cleaned = await h.service.cleanup(h.session, lane, 'all')
      expect(cleaned.state).toBe('cleaned')
      expect(cleaned.summary).toContain('warning:')
      expect(cleaned.summary).toContain('1 unresolved Edit Lock operation(s)')
      // The probe is read-only: the authority bytes are untouched.
      expect(readFileSync(join(directory, 'snapshot.json')).equals(before)).toBe(true)
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

describe('worktree lane service: watches', () => {
  const hitNotices = (h) => h.notices.filter((entry) => entry.text.includes('[worktree] watch hit'))
  const expiredNotices = (list) => list.filter((entry) => entry.text.includes('[worktree] watch expired'))
  const watchesOf = async (h, lane) => (await h.service.repoFor(h.repo)).ledger.read().watches.filter((entry) => entry.laneId === lane)

  it('subscribes, hits exactly once on the first target state, and never notifies again', async () => {
    const clock = fakeClock()
    const h = harness({ clock })
    try {
      const opened = await h.service.open(h.session, { title: 'Watch target' })
      const bound = await h.service.prepareBind(h.session, opened.lane, { readOnly: false })
      await bound.commit('child-1')
      const subscribed = await h.service.watch(h.session, { lane: opened.lane, states: ['no-commits', 'landable'] })
      expect(subscribed.state).toBe('working')
      expect(subscribed.watch.lane).toBe(opened.lane)
      expect(subscribed.watch.states).toEqual(['no-commits', 'landable'])
      // expiresAt is frozen at subscribe time from the default 360-minute timeout.
      expect(subscribed.watch.expiresAt).toBe(clock.value + 360 * 60_000)
      expect(subscribed.summary).toContain('watching for no-commits, landable')
      expect(await watchesOf(h, opened.lane)).toHaveLength(1)
      expect(clock.timers.size).toBe(1)

      // The settle lands on no-commits: the watch hits and is consumed.
      await h.service.childSettled('child-1', h.session)
      expect(hitNotices(h)).toHaveLength(1)
      expect(hitNotices(h)[0].sessionId).toBe('main-1')
      expect(hitNotices(h)[0].text).toContain(`lane ${opened.lane} reached no-commits`)
      expect(hitNotices(h)[0].text).toContain('next:')
      expect(await watchesOf(h, opened.lane)).toHaveLength(0)
      expect(clock.timers.size).toBe(0)

      // A later transition into ANOTHER target state (landable) notifies nobody.
      const bound2 = await h.service.prepareBind(h.session, opened.lane, { readOnly: false })
      await bound2.commit('child-2')
      writeFileSync(join(opened.path, 'feature.txt'), 'feature\n')
      sh(opened.path, 'add', '.')
      sh(opened.path, 'commit', '-qm', 'work')
      await h.service.childSettled('child-2', h.session)
      expect((await laneOf(h, opened.lane)).state).toBe('landable')
      expect(hitNotices(h)).toHaveLength(1)
    } finally {
      h.cleanup()
    }
  })

  it('delivers the hit to the SUBSCRIBING session, not the lane owner', async () => {
    const h = harness()
    try {
      const opened = await h.service.open(h.session, { title: 'Cross session' })
      const bound = await h.service.prepareBind(h.session, opened.lane, { readOnly: false })
      await bound.commit('child-1')
      const subscriber = { id: 'sub-2', header: { cwd: h.repo } }
      await h.service.watch(subscriber, { lane: opened.lane, states: ['no-commits'] })
      await h.service.childSettled('child-1', h.session)
      expect(hitNotices(h)).toHaveLength(1)
      expect(hitNotices(h)[0].sessionId).toBe('sub-2')
    } finally {
      h.cleanup()
    }
  })

  it('hits immediately when the lane already sits in a target state, storing nothing', async () => {
    const h = harness()
    try {
      const opened = await h.service.open(h.session, { title: 'Already ready' })
      const result = await h.service.watch(h.session, { lane: opened.lane, states: ['ready', 'landable'] })
      expect(result.hit).toBe('ready')
      expect(result.watch).toBeUndefined()
      expect(result.summary).toContain('already ready')
      expect(hitNotices(h)).toHaveLength(1)
      expect(hitNotices(h)[0].sessionId).toBe('main-1')
      expect(await watchesOf(h, opened.lane)).toHaveLength(0)
      expect(h.audits.find((entry) => entry.type === 'watch')?.data.outcome).toBe('hit-immediate')
    } finally {
      h.cleanup()
    }
  })

  it('refuses empty and transient target states with UNWATCHABLE_STATE and creates nothing', async () => {
    const h = harness()
    try {
      const opened = await h.service.open(h.session, { title: 'No transient' })
      await h.service.watch(h.session, { lane: opened.lane, states: ['working'] }).then(
        () => expect('accepted').toBe('refused'),
        (error) => {
          expect(error.code).toBe('UNWATCHABLE_STATE')
          expect(error.data.watchable).toContain('landable')
          expect(error.data.watchable).not.toContain('working')
        },
      )
      await h.service.watch(h.session, { lane: opened.lane, states: [] }).then(
        () => expect('accepted').toBe('refused'),
        (error) => expect(error.code).toBe('UNWATCHABLE_STATE'),
      )
      await h.service.watch(h.session, { lane: 'nope', states: ['landable'] }).then(
        () => expect('accepted').toBe('refused'),
        (error) => expect(error.code).toBe('UNKNOWN_LANE'),
      )
      expect(await watchesOf(h, opened.lane)).toHaveLength(0)
    } finally {
      h.cleanup()
    }
  })

  it('a repeated subscribe replaces the old watch (states and deadline follow the new one)', async () => {
    const clock = fakeClock()
    const h = harness({ clock })
    try {
      const opened = await h.service.open(h.session, { title: 'Replace me' })
      const first = await h.service.watch(h.session, { lane: opened.lane, states: ['landable'] })
      clock.value += 60_000
      const second = await h.service.watch(h.session, { lane: opened.lane, states: ['abandoned'] })
      const watches = await watchesOf(h, opened.lane)
      expect(watches).toHaveLength(1)
      expect(watches[0].states).toEqual(['abandoned'])
      expect(watches[0].expiresAt).toBe(second.watch.expiresAt)
      expect(watches[0].expiresAt).toBeGreaterThan(first.watch.expiresAt)
      // the old timer was disarmed; exactly one timer survives
      expect(clock.timers.size).toBe(1)
      const subscribeAudits = h.audits.filter((entry) => entry.type === 'watch' && entry.data.outcome === 'subscribed')
      expect(subscribeAudits).toHaveLength(2)
      expect(subscribeAudits[0].data.replaced).toBe(null)
      expect(typeof subscribeAudits[1].data.replaced).toBe('string')
    } finally {
      h.cleanup()
    }
  })

  it('expires with exactly one notice (the watch single delivery) and audits the removal', async () => {
    const clock = fakeClock()
    const h = harness({ clock })
    try {
      const opened = await h.service.open(h.session, { title: 'Slow lane' })
      const subscribed = await h.service.watch(h.session, { lane: opened.lane, states: ['landable'] })
      clock.value = subscribed.watch.expiresAt
      clock.fire()
      await until(() => expiredNotices(h.notices).length === 1)
      const notice = expiredNotices(h.notices)[0]
      expect(notice.sessionId).toBe('main-1')
      expect(notice.text).toContain(`lane ${opened.lane}`)
      expect(notice.text).toContain('landable')
      expect(await watchesOf(h, opened.lane)).toHaveLength(0)
      const audit = h.audits.find((entry) => entry.type === 'watch' && entry.data.outcome === 'expired')
      expect(audit?.data.lane).toBe(opened.lane)
      // nothing else arrives afterwards
      clock.fire(true)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(expiredNotices(h.notices)).toHaveLength(1)
    } finally {
      h.cleanup()
    }
  })

  it('two service instances racing one expiry deliver exactly once', async () => {
    const clock = fakeClock()
    const h = harness({ clock })
    try {
      const opened = await h.service.open(h.session, { title: 'Raced expiry' })
      const subscribed = await h.service.watch(h.session, { lane: opened.lane, states: ['landable'] })
      // A second host instance sharing this repository learns the watch and
      // arms its own timer for it.
      const other = secondInstance(h, { clock, pid: 4242 })
      await other.service.refresh(await other.service.repoFor(h.repo))
      expect(clock.timers.size).toBe(2)
      clock.value = subscribed.watch.expiresAt
      clock.fire(true)
      await until(() => expiredNotices(h.notices).length + expiredNotices(other.notices).length >= 1)
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(expiredNotices(h.notices).length + expiredNotices(other.notices).length).toBe(1)
      expect(await watchesOf(h, opened.lane)).toHaveLength(0)
    } finally {
      h.cleanup()
    }
  })

  it('prunes watches expired during downtime silently + audited on the next load (no delivery, no hit)', async () => {
    const clock = fakeClock()
    const h = harness({ clock })
    try {
      const opened = await h.service.open(h.session, { title: 'Downtime' })
      const subscribed = await h.service.watch(h.session, { lane: opened.lane, states: ['landable'] })
      // The host goes down before the immediate-hit-less watch matures; its
      // timers never fire. The deadline passes during the downtime.
      clock.value = subscribed.watch.expiresAt + 1
      // A fresh instance (fresh timer registry) loads the repository.
      const revived = secondInstance(h, { clock })
      await revived.service.refresh(await revived.service.repoFor(h.repo))
      expect(await watchesOf(h, opened.lane)).toHaveLength(0)
      expect(expiredNotices(revived.notices)).toHaveLength(0)
      expect(hitNotices(h)).toHaveLength(0)
      const pruned = revived.audits.filter((entry) => entry.type === 'watch' && entry.data.outcome === 'pruned')
      expect(pruned).toHaveLength(1)
      expect(pruned[0].data.lane).toBe(opened.lane)
      // the pruned watch does not hit on later transitions either
      const lane = await laneOf(h, opened.lane)
      expect(lane.state).toBe('ready')
      expect(await watchesOf(h, opened.lane)).toHaveLength(0)
    } finally {
      h.cleanup()
    }
  })

  it('exposes the watch count on the board and in the view', async () => {
    const h = harness()
    try {
      const opened = await h.service.open(h.session, { title: 'Counted' })
      expect(h.service.board(h.session)).not.toContain('watching')
      await h.service.watch(h.session, { lane: opened.lane, states: ['landable', 'abandoned'] })
      const subscriber = { id: 'sub-2', header: { cwd: h.repo } }
      await h.service.watch(subscriber, { lane: opened.lane, states: ['landed'] })
      expect(h.service.board(h.session)).toContain(`${opened.lane} · ready · 2 watching`)
      const view = await h.service.view(h.session)
      const entry = view.lanes.find((lane) => lane.id === opened.lane)
      expect(entry.watchCount).toBe(2)
      expect(entry.watchStates).toEqual(['landable', 'abandoned', 'landed'])
    } finally {
      h.cleanup()
    }
  })
})

describe('worktree lane service: auto-approve modes', () => {
  const approve = (questions) => ({ answers: [{ id: questions[0].id, selected: [questions[0].options[0].label] }] })
  const mustNotAsk = () => { throw new Error('must not ask in auto mode') }
  const auditOf = (h, type) => h.audits.filter((entry) => entry.type === type)

  it('auto-clean land merges with no card, cleans with mode all, and audits the auto marker', async () => {
    const h = harness({ approveMode: 'auto-clean', approveModeSource: 'session', ask: mustNotAsk })
    try {
      const lane = await workedLane(h, 'Auto clean')
      const landed = await h.service.land(h.agent, lane)
      expect(landed.state).toBe('landed')
      expect(landed.cleanup.state).toBe('cleaned')
      expect(landed.cleanup.summary).toContain('removed')
      expect(landed.cleanup.summary).toContain(`deleted orrery/${lane}`)
      expect(h.asked).toHaveLength(0)
      const record = await laneOf(h, lane)
      expect(record.state).toBe('cleaned')
      expect(existsSync(landed.path)).toBe(false)
      expect(sh(h.repo, 'branch', '--list', `orrery/${lane}`)).toBe('')
      expect(sh(h.repo, 'log', '-1', '--format=%s')).toBe(`merge(lane): Auto clean (${lane})`)
      const landAudit = auditOf(h, 'land').at(-1)
      expect(landAudit.data.auto).toBe(true)
      expect(landAudit.data.approveMode).toBe('auto-clean')
      expect(landAudit.data.by).toBe('host')
      const cleanupAudit = auditOf(h, 'cleanup').at(-1)
      expect(cleanupAudit.data.by).toBe('host')
      expect(cleanupAudit.data.auto).toBe(true)
      expect(cleanupAudit.data.approveMode).toBe('auto-clean')
      expect(cleanupAudit.data.mode).toBe('all')
    } finally {
      h.cleanup()
    }
  })

  it('auto-keep land removes the worktree but keeps the merged branch', async () => {
    const h = harness({ approveMode: 'auto-keep', approveModeSource: 'session', ask: mustNotAsk })
    try {
      const lane = await workedLane(h, 'Auto keep')
      const landed = await h.service.land(h.agent, lane)
      expect(landed.state).toBe('landed')
      expect(landed.cleanup.state).toBe('cleaned')
      expect(h.asked).toHaveLength(0)
      expect((await laneOf(h, lane)).state).toBe('cleaned')
      expect(existsSync(landed.path)).toBe(false)
      expect(sh(h.repo, 'branch', '--list', `orrery/${lane}`)).toContain(`orrery/${lane}`)
      const cleanupAudit = auditOf(h, 'cleanup').at(-1)
      expect(cleanupAudit.data.mode).toBe('worktree')
      expect(cleanupAudit.data.auto).toBe(true)
      expect(cleanupAudit.data.approveMode).toBe('auto-keep')
    } finally {
      h.cleanup()
    }
  })

  it('the conflict precheck still wins in auto mode: no merge, no card, main untouched', async () => {
    const h = harness({ approveMode: 'auto-clean', ask: mustNotAsk })
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
      expect((await laneOf(h, lane)).state).toBe('conflicted')
    } finally {
      h.cleanup()
    }
  })

  it('a blocked auto cleanup stays landed and reports the blocking path instead of a false success', async () => {
    const h = harness({ approveMode: 'auto-clean', ask: mustNotAsk })
    try {
      const lane = await workedLane(h, 'Blocked cleanup')
      const { path } = await laneOf(h, lane)
      writeFileSync(join(path, 'stray.txt'), 'untracked')
      const landed = await h.service.land(h.agent, lane)
      expect(landed.state).toBe('landed')
      expect(landed.cleanup.error).toContain('REMOVE_BLOCKED')
      expect((await laneOf(h, lane)).state).toBe('landed')
      expect(existsSync(path)).toBe(true)
      expect(sh(h.repo, 'branch', '--list', `orrery/${lane}`)).toContain(`orrery/${lane}`)
    } finally {
      h.cleanup()
    }
  })

  it('auto-mode land through the tool surface returns the result shape the tool wrapper needs', async () => {
    const h = harness({ approveMode: 'auto-clean', approveModeSource: 'session', ask: mustNotAsk })
    try {
      const lane = await workedLane(h, 'Tool surface')
      const tool = createWorktreeTools(h.service).find((entry) => entry.name === 'worktree_land')
      const value = await tool.execute({ lane }, { agent: h.agent, signal: new AbortController().signal })
      expect(value.lane).toBe(lane)
      expect(value.state).toBe('landed')
      expect(typeof value.summary).toBe('string')
      expect(value.summary).toContain('merged')
      expect(value.summary).toContain(value.merge.commit.slice(0, 7))
      expect(value.summary).toContain('cleanup')
      expect(value.cleanup.state).toBe('cleaned')
      expect(value.cleanup.summary).toContain('removed')
      expect(value.next).toBeNull()
      // the runtime persists presentationMeta as JSON: an undefined value is dropped
      const meta = tool.output.presentationMeta({}, value)
      expect(JSON.parse(JSON.stringify(meta))).toEqual(meta)
      expect(meta.worktree.lane).toBe(lane)
      expect(meta.worktree.summary).toBe(value.summary)
      expect(meta.worktree.cleanup).toEqual(value.cleanup)
    } finally {
      h.cleanup()
    }
  })

  it('a blocked auto cleanup through the tool surface reports the blocking path in result shape', async () => {
    const h = harness({ approveMode: 'auto-clean', ask: mustNotAsk })
    try {
      const lane = await workedLane(h, 'Blocked surface')
      const { path } = await laneOf(h, lane)
      writeFileSync(join(path, 'stray.txt'), 'untracked')
      const tool = createWorktreeTools(h.service).find((entry) => entry.name === 'worktree_land')
      const value = await tool.execute({ lane }, { agent: h.agent, signal: new AbortController().signal })
      expect(value.lane).toBe(lane)
      expect(value.state).toBe('landed')
      expect(value.summary).toContain('merged')
      expect(value.summary).toContain('blocked')
      expect(value.cleanup.error).toContain('REMOVE_BLOCKED')
      expect((await laneOf(h, lane)).state).toBe('landed')
      expect(existsSync(path)).toBe(true)
      const meta = tool.output.presentationMeta({}, value)
      expect(JSON.parse(JSON.stringify(meta))).toEqual(meta)
      expect(meta.worktree.lane).toBe(lane)
    } finally {
      h.cleanup()
    }
  })

  it('auto-mode abandon through the tool surface is result-shaped too (sibling contract)', async () => {
    const h = harness({ approveMode: 'auto-keep', ask: mustNotAsk })
    try {
      const lane = await workedLane(h, 'Abandon surface')
      const tool = createWorktreeTools(h.service).find((entry) => entry.name === 'worktree_abandon')
      const value = await tool.execute({ lane }, { agent: h.agent, signal: new AbortController().signal })
      expect(value.lane).toBe(lane)
      expect(value.state).toBe('abandoned')
      expect(typeof value.summary).toBe('string')
      expect(value.summary).toContain('removed')
      const meta = tool.output.presentationMeta({}, value)
      expect(JSON.parse(JSON.stringify(meta))).toEqual(meta)
      expect(meta.worktree.lane).toBe(lane)
    } finally {
      h.cleanup()
    }
  })

  it('auto-clean abandon discards unmerged commits with no card and states the count', async () => {
    const h = harness({ approveMode: 'auto-clean', approveModeSource: 'session', ask: mustNotAsk })
    try {
      const opened = await h.service.open(h.session, { title: 'Three commits' })
      const bound = await h.service.prepareBind(h.session, opened.lane, { readOnly: false })
      await bound.commit('child-1')
      for (const file of ['one.txt', 'two.txt', 'three.txt']) {
        writeFileSync(join(opened.path, file), `${file}\n`)
        sh(opened.path, 'add', '.')
        sh(opened.path, 'commit', '-qm', file)
      }
      await h.service.childSettled('child-1', h.session)
      const abandoned = await h.service.abandon(h.agent, opened.lane)
      expect(abandoned.state).toBe('abandoned')
      expect(abandoned.summary).toContain('3 unmerged commit(s) discarded')
      expect(abandoned.summary).toContain('removed')
      expect(h.asked).toHaveLength(0)
      expect(existsSync(abandoned.path)).toBe(false)
      expect(sh(h.repo, 'branch', '--list', `orrery/${opened.lane}`)).toBe('')
      const abandonAudit = auditOf(h, 'abandon').at(-1)
      expect(abandonAudit.data.auto).toBe(true)
      expect(abandonAudit.data.approveMode).toBe('auto-clean')
      expect(abandonAudit.data.by).toBe('host')
    } finally {
      h.cleanup()
    }
  })

  it('auto-keep abandon removes the worktree and keeps the branch', async () => {
    const h = harness({ approveMode: 'auto-keep', ask: mustNotAsk })
    try {
      const lane = await workedLane(h, 'Keep branch')
      const abandoned = await h.service.abandon(h.agent, lane)
      expect(abandoned.state).toBe('abandoned')
      expect(abandoned.summary).toContain('removed')
      expect(h.asked).toHaveLength(0)
      expect(existsSync(abandoned.path)).toBe(false)
      expect(sh(h.repo, 'branch', '--list', `orrery/${lane}`)).toContain(`orrery/${lane}`)
    } finally {
      h.cleanup()
    }
  })

  it('a disputed binding falls back to the force-reclaim card even in auto mode', async () => {
    const h = harness({
      approveMode: 'auto-clean',
      bindingLiveness: async () => ({ childAlive: false, ownerAlive: false, terminalEvidence: null }),
      ask: (questions) => ({ answers: [{ id: questions[0].id, selected: ['Cancel'] }] }),
    })
    try {
      const opened = await h.service.open(h.session, { title: 'Disputed' })
      const bound = await h.service.prepareBind(h.session, opened.lane, { readOnly: false })
      await bound.commit('child-1')
      const outcome = await h.service.abandon(h.agent, opened.lane)
      expect(outcome.state).toBe('working')
      expect(outcome.summary).toContain('not abandoned: the user cancelled')
      expect(h.asked).toHaveLength(1)
      const card = h.asked[0][0]
      expect(card.id).toBe('abandon')
      expect(card.options.map((option) => option.label)).toEqual(['Force-reclaim the binding', 'Cancel'])
      expect(card.detail).toContain('child-1')
      expect(card.detail).toContain('no terminal evidence')
      expect(existsSync(opened.path)).toBe(true)
      expect(sh(h.repo, 'branch', '--list', `orrery/${opened.lane}`)).toContain(`orrery/${opened.lane}`)
    } finally {
      h.cleanup()
    }
  })

  it('manual mode keeps the card path byte-identical: ask, land, then the cleanup card', async () => {
    const h = harness({ approveMode: 'manual', ask: approve })
    try {
      const lane = await workedLane(h, 'Manual still manual')
      const landed = await h.service.land(h.agent, lane)
      expect(landed.state).toBe('landed')
      expect(landed.cleanup).toBeUndefined()
      expect(h.asked).toHaveLength(1)
      expect(h.asked[0][0].id).toBe('merge')
      expect((await laneOf(h, lane)).state).toBe('landed')
      const cleaned = await h.service.askCleanup(h.agent, lane)
      expect(cleaned.state).toBe('kept')
      const landAudit = auditOf(h, 'land').at(-1)
      expect(landAudit.data.auto).toBeUndefined()
    } finally {
      h.cleanup()
    }
  })

  it('the view reports the effective approve mode and its source', async () => {
    const auto = harness({ approveMode: 'auto-keep', approveModeSource: 'session' })
    try {
      const view = await auto.service.view(auto.session)
      expect(view.approveMode).toBe('auto-keep')
      expect(view.approveModeSource).toBe('session')
    } finally {
      auto.cleanup()
    }
    const plain = harness()
    try {
      const view = await plain.service.view(plain.session)
      expect(view.approveMode).toBe('manual')
      expect(view.approveModeSource).toBe('global')
    } finally {
      plain.cleanup()
    }
  })
})
