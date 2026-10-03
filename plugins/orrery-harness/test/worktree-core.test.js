import { describe, expect, it } from './helpers.js'
import { existsSync, readFileSync, writeFileSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { WORKTREE_CODES, WorktreeError } from '../src/worktree/errors.js'
import { DISPATCHABLE, FINISHED, STATES, TRANSITIONS, isActive, nextFor, transition } from '../src/worktree/state.js'
import {
  branchFor, excludeRuleFor, gitAtLeast, globToRegExp, inScope, laneIdFor, normalizeRoot, parseGitVersion, parseMergeTree,
  parseRepoConfig, parseStatus, parseWorktreeList, scopesOverlap, setupCommandFor, slugify, staticPrefix, suggestChecks,
} from '../src/worktree/rules.js'
import { reconcile } from '../src/worktree/reconcile.js'
import { createLedger, emptyLedger, validateLedger } from '../src/worktree/ledger.js'
import { ensureExclude, hasExclude } from '../src/worktree/exclude.js'
import { createGit } from '../src/worktree/git.js'
import { makeRepo, nodeGitRun, sh } from './helpers/worktree-fixtures.js'

const lane = (state, extra = {}) => ({ id: 'a-001', state, path: '/r/.orrery/worktrees/a-001', branch: 'orrery/a-001', base: { branch: 'main', commit: 'c0' }, history: [], ...extra })

describe('worktree state machine', () => {
  it('every transition names only known states', () => {
    for (const [name, rule] of Object.entries(TRANSITIONS)) {
      for (const from of rule.from) expect(STATES.includes(from), `${name} from ${from}`).toBe(true)
      if (rule.to) expect(STATES.includes(rule.to), `${name} to ${rule.to}`).toBe(true)
      for (const target of rule.targets ?? []) expect(STATES.includes(target)).toBe(true)
    }
  })

  it('legal transitions return a new record with history and do not mutate the input', () => {
    const before = lane('ready')
    const after = transition(before, { type: 'bind', at: 5, patch: { boundChild: 'c1' } })
    expect(after.state).toBe('working')
    expect(after.boundChild).toBe('c1')
    expect(after.history).toEqual([{ from: 'ready', to: 'working', event: 'bind', at: 5, by: 'host' }])
    expect(before.state).toBe('ready')
    expect(before.history).toEqual([])
  })

  it('an illegal transition throws a stable code and carries the lane next step', () => {
    let error
    try {
      transition(lane('working', { boundChild: 'c1' }), { type: 'land', code: WORKTREE_CODES.NOT_LANDABLE })
    } catch (caught) {
      error = caught
    }
    expect(error).toBeInstanceOf(WorktreeError)
    expect(error.code).toBe('NOT_LANDABLE')
    expect(error.next).toEqual({ waitFor: 'child-settle', hint: 'the bound worker is running; the host checks the lane when it settles' })
  })

  it('unknown events and bad checked targets are refused', () => {
    expect(() => transition(lane('ready'), { type: 'teleport' })).toThrow(/ILLEGAL_TRANSITION/)
    expect(() => transition(lane('working'), { type: 'checked', to: 'landed' })).toThrow(/ILLEGAL_TRANSITION/)
    expect(transition(lane('working'), { type: 'checked', to: 'dirty' }).state).toBe('dirty')
  })

  it('a conclusion only survives into states that keep it', () => {
    const landable = transition(lane('working'), { type: 'checked', to: 'landable', patch: { landableTree: 't1' } })
    expect(landable.landableTree).toBe('t1')
    expect(transition(landable, { type: 'ask' }).landableTree).toBe('t1')
    expect(transition(landable, { type: 'invalidate' }).landableTree).toBeNull()
  })

  it('every non-finished state may be abandoned; finished states may not', () => {
    for (const state of STATES) {
      if (FINISHED.includes(state)) expect(() => transition(lane(state), { type: 'abandon' })).toThrow(/ILLEGAL_TRANSITION/)
      else expect(transition(lane(state), { type: 'abandon' }).state).toBe('abandoned')
    }
  })

  it('landing is reachable from landable, declined, conflicted, and awaiting-approval only', () => {
    for (const state of STATES) {
      const legal = ['landable', 'declined', 'conflicted', 'awaiting-approval'].includes(state)
      if (legal) expect(transition(lane(state), { type: 'land' }).state).toBe('landed')
      else expect(() => transition(lane(state), { type: 'land' })).toThrow(/ILLEGAL_TRANSITION/)
    }
  })

  it('isActive and DISPATCHABLE agree with the finished set', () => {
    for (const state of DISPATCHABLE) expect(isActive(lane(state))).toBe(true)
    for (const state of FINISHED) expect(isActive(lane(state))).toBe(false)
  })

  it('nextFor names one action per state', () => {
    expect(nextFor(lane('landable'))).toEqual({ tool: 'worktree_land', args: { lane: 'a-001' } })
    expect(nextFor(lane('preparing')).waitFor).toBe('lane-ready')
    expect(nextFor(lane('checking')).waitFor).toBe('check-complete')
    expect(nextFor(lane('ready')).tool).toBe('delegate')
    expect(nextFor(lane('ready')).args).toEqual({ worktree: 'a-001' })
    expect(nextFor(lane('working')).tool).toBe('worktree_check')
    expect(nextFor(lane('awaiting-approval')).waitFor).toBe('user')
    expect(nextFor(lane('cleaned'))).toBeNull()
  })
})

describe('worktree rules', () => {
  it('derives ids, branches and slugs', () => {
    expect(laneIdFor('Fix login redirect', 1)).toBe('fix-login-redirect-001')
    expect(branchFor('fix-login-redirect-001')).toBe('orrery/fix-login-redirect-001')
    expect(slugify('修复登录跳转')).toBe('lane')
    expect(slugify('Café  Über -- Ärger!')).toBe('cafe-uber-arger')
    expect(slugify('x'.repeat(50))).toHaveLength(32)
    expect(slugify('abc-'.repeat(10)).endsWith('-')).toBe(false)
  })

  it('normalizes the lane root and refuses roots outside the repository', () => {
    expect(normalizeRoot('.orrery/worktrees/')).toBe('.orrery/worktrees')
    expect(normalizeRoot('./lanes\\x')).toBe('lanes/x')
    for (const bad of ['../lanes', '/abs', 'C:/x', '', '.', 'a/../..', '.git/x']) {
      expect(() => normalizeRoot(bad)).toThrow(/ROOT_OUTSIDE_REPO/)
    }
    expect(excludeRuleFor('.orrery/worktrees')).toBe('/.orrery/worktrees/')
  })

  it('derives setup from lockfiles', () => {
    expect(setupCommandFor(['pnpm-lock.yaml', 'package.json'])).toBe('pnpm install --frozen-lockfile')
    expect(setupCommandFor(['package-lock.json'])).toBe('npm ci')
    expect(setupCommandFor(['yarn.lock'])).toBe('yarn install --frozen-lockfile')
    expect(setupCommandFor(['bun.lock'])).toBe('bun install --frozen-lockfile')
    expect(setupCommandFor(['README.md'])).toBeNull()
  })

  it('suggests (never decides) verification commands', () => {
    expect(suggestChecks({ packageJson: { scripts: { test: 'x', lint: 'y', build: 'z' } }, fileNames: ['pnpm-lock.yaml', 'go.mod'] })).toEqual([
      { name: 'lint', run: 'pnpm run lint' },
      { name: 'test', run: 'pnpm run test' },
      { name: 'go-test', run: 'go test ./...' },
    ])
    expect(suggestChecks({ fileNames: [] })).toEqual([])
  })

  it('validates the repository config strictly', () => {
    expect(parseRepoConfig(undefined)).toEqual({ setup: null, check: [] })
    expect(parseRepoConfig({ check: [{ name: 't', run: 'npm test' }] })).toEqual({ setup: null, check: [{ name: 't', run: 'npm test', timeoutSec: 600 }] })
    expect(() => parseRepoConfig({ check: {} })).toThrow(/array/)
    expect(() => parseRepoConfig({ check: [{ name: '', run: 'x' }] })).toThrow(/name/)
    expect(() => parseRepoConfig({ setup: 3 })).toThrow(/setup/)
    expect(() => parseRepoConfig([])).toThrow(/object/)
  })

  it('parses git versions and enforces the 2.38 floor', () => {
    expect(parseGitVersion('git version 2.39.5 (Apple Git-154)')).toEqual([2, 39, 5])
    expect(gitAtLeast([2, 38, 0])).toBe(true)
    expect(gitAtLeast([2, 37, 9])).toBe(false)
    expect(gitAtLeast([3, 0, 0])).toBe(true)
    expect(gitAtLeast(null)).toBe(false)
  })

  it('matches scopes and detects overlap conservatively', () => {
    expect(globToRegExp('src/**/*.js').test('src/a/b/c.js')).toBe(true)
    expect(globToRegExp('src/**/*.js').test('src/c.js')).toBe(true)
    expect(globToRegExp('src/*.js').test('src/a/c.js')).toBe(false)
    expect(inScope('src/auth/x.js', ['src/auth/**'])).toBe(true)
    expect(inScope('src/billing/x.js', ['src/auth/**'])).toBe(false)
    expect(inScope('src/auth/x.js', ['src/auth'])).toBe(true)
    expect(inScope('anything', [])).toBe(true)
    expect(staticPrefix('src/auth/**')).toBe('src/auth')
    expect(staticPrefix('src/a*')).toBe('src')
    expect(scopesOverlap(['src/auth/**'], ['src/billing/**'])).toBe(false)
    expect(scopesOverlap(['src/**'], ['src/billing/**'])).toBe(true)
    expect(scopesOverlap(['**/*.md'], ['docs/**'])).toBe(true)
    expect(scopesOverlap(['README.md'], ['README.md'])).toBe(true)
    expect(scopesOverlap([], ['src/**'])).toBe(false)
  })

  it('parses git porcelain outputs', () => {
    expect(parseWorktreeList('worktree /r\nHEAD abc\nbranch refs/heads/main\n\nworktree /r/.orrery/worktrees/x\nHEAD def\ndetached\n')).toEqual([
      { path: '/r', head: 'abc', branch: 'main', detached: false },
      { path: '/r/.orrery/worktrees/x', head: 'def', branch: null, detached: true },
    ])
    expect(parseMergeTree(0, 'abc\n')).toEqual({ clean: true, conflicts: [] })
    expect(parseMergeTree(1, 'abc\nf\ng\n\nAuto-merging f\nCONFLICT (content)\n')).toEqual({ clean: false, conflicts: ['f', 'g'] })
    expect(parseStatus(' M a.txt\nA  b.txt\n?? c.txt\nR  old -> new\n')).toEqual([
      { path: 'a.txt', staged: false, untracked: false },
      { path: 'b.txt', staged: true, untracked: false },
      { path: 'c.txt', staged: false, untracked: true },
      { path: 'new', staged: true, untracked: false },
    ])
  })
})

describe('worktree reconciliation', () => {
  const base = { rootPath: '/r/.orrery/worktrees', mainBranch: 'main', trees: new Map() }
  it('marks vanished lanes missing and reports unmanaged worktrees', () => {
    const result = reconcile({
      ...base,
      lanes: [lane('working'), { ...lane('ready'), id: 'b-002', path: '/r/.orrery/worktrees/b-002' }, { ...lane('cleaned'), id: 'c-003', path: '/r/.orrery/worktrees/c-003' }],
      worktrees: [{ path: '/r' }, { path: '/r/.orrery/worktrees/b-002' }, { path: '/r/.orrery/worktrees/hand-made' }],
    })
    expect(result.events).toEqual([{ id: 'a-001', type: 'missing', reason: 'missing' }])
    expect(result.unmanaged).toEqual(['/r/.orrery/worktrees/hand-made'])
    expect(result.baseMoved.get('b-002')).toBe(false)
  })

  it('invalidates a conclusion whose tree changed and flags a moved base', () => {
    const result = reconcile({
      ...base,
      mainBranch: 'feature',
      trees: new Map([['a-001', 't2']]),
      lanes: [lane('landable', { landableTree: 't1' })],
      worktrees: [{ path: '/r' }, { path: '/r/.orrery/worktrees/a-001' }],
    })
    expect(result.events).toEqual([{ id: 'a-001', type: 'invalidate', reason: 'lane content changed after its conclusion' }])
    expect(result.baseMoved.get('a-001')).toBe(true)
  })
})

describe('worktree ledger', () => {
  it('reads an empty ledger, updates atomically, and keeps the file valid', async () => {
    const { root, cleanup } = makeRepo()
    try {
      const ledger = createLedger(join(root, 'lanes'))
      expect(ledger.read()).toEqual(emptyLedger())
      await ledger.update((value) => ({ ledger: { ...value, seq: 1, lanes: [lane('ready')] } }))
      expect(ledger.read().lanes.map((entry) => entry.id)).toEqual(['a-001'])
      expect(existsSync(join(root, 'lanes', '.lock'))).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('a throwing mutation leaves the file byte-identical and releases the lock', async () => {
    const { root, cleanup } = makeRepo()
    try {
      const ledger = createLedger(join(root, 'lanes'))
      await ledger.update((value) => ({ ledger: { ...value, lanes: [lane('ready')] } }))
      const before = readFileSync(ledger.file, 'utf8')
      await ledger.update(() => {
        throw new Error('boom')
      }).catch(() => {})
      expect(readFileSync(ledger.file, 'utf8')).toBe(before)
      expect(existsSync(join(root, 'lanes', '.lock'))).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('serializes concurrent writers without losing updates', async () => {
    const { root, cleanup } = makeRepo()
    try {
      const one = createLedger(join(root, 'lanes'), { pid: 1 })
      const two = createLedger(join(root, 'lanes'), { pid: 2 })
      const add = (ledger, id) => ledger.update((value) => ({ ledger: { ...value, seq: value.seq + 1, lanes: [...value.lanes, { ...lane('ready'), id }] } }))
      await Promise.all([add(one, 'x-001'), add(two, 'y-002'), add(one, 'z-003'), add(two, 'w-004')])
      const final = one.read()
      expect(final.seq).toBe(4)
      expect(final.lanes.map((entry) => entry.id).sort()).toEqual(['w-004', 'x-001', 'y-002', 'z-003'])
    } finally {
      cleanup()
    }
  })

  it('steals a stale lock left by a crashed writer', async () => {
    const { root, cleanup } = makeRepo()
    try {
      const dir = join(root, 'lanes')
      const ledger = createLedger(dir)
      await ledger.update(() => ({}))
      writeFileSync(join(dir, '.lock'), '{"pid":99}')
      const old = (Date.now() - 60_000) / 1000
      utimesSync(join(dir, '.lock'), old, old)
      await ledger.update((value) => ({ ledger: { ...value, seq: 7 } }))
      expect(ledger.read().seq).toBe(7)
    } finally {
      cleanup()
    }
  })

  it('fails closed on corruption, keeps one backup, and never rebuilds silently', async () => {
    const { root, cleanup } = makeRepo()
    try {
      const dir = join(root, 'lanes')
      const ledger = createLedger(dir)
      await ledger.update(() => ({}))
      writeFileSync(ledger.file, '{ not json')
      expect(() => ledger.read()).toThrow(/LEDGER_CORRUPT/)
      expect(() => ledger.read()).toThrow(/LEDGER_CORRUPT/)
      await ledger.update(() => ({ ledger: emptyLedger() })).catch((error) => expect(error.code).toBe('LEDGER_CORRUPT'))
      expect(readFileSync(ledger.file, 'utf8')).toBe('{ not json')
      const { readdirSync } = await import('node:fs')
      expect(readdirSync(dir).filter((name) => name.includes('.corrupt-'))).toHaveLength(1)
      expect(validateLedger({ schemaVersion: 1, seq: 0, lanes: [{ id: 'x', state: 'bogus', path: 'p', branch: 'b' }] })).toMatch(/unknown state/)
    } finally {
      cleanup()
    }
  })
})

describe('worktree local exclude (real git)', () => {
  it('appends one marked rule to the common exclude, idempotently, without touching .gitignore', () => {
    const { repo, cleanup } = makeRepo()
    try {
      const commonDir = join(repo, '.git')
      expect(ensureExclude(commonDir, '.orrery/worktrees')).toEqual({ file: join(commonDir, 'info', 'exclude'), written: true })
      expect(ensureExclude(commonDir, '.orrery/worktrees').written).toBe(false)
      const text = readFileSync(join(commonDir, 'info', 'exclude'), 'utf8')
      expect(text.split('/.orrery/worktrees/').length - 1).toBe(1)
      expect(text).toContain('# orrery-harness: git-worktree lanes (local only)')
      expect(hasExclude(commonDir, '.orrery/worktrees')).toBe(true)
      sh(repo, 'worktree', 'add', '-q', '-b', 'orrery/t-001', '.orrery/worktrees/t-001')
      expect(sh(repo, 'status', '--porcelain')).toBe('')
      expect(existsSync(join(repo, '.gitignore'))).toBe(false)
    } finally {
      cleanup()
    }
  })
})

describe('worktree git wrapper', () => {
  it('never forces worktree removal and only uses -D on an explicit force', async () => {
    const calls = []
    const git = createGit(async (argv) => {
      calls.push(argv.join(' '))
      return { code: 0, stdout: '', stderr: '' }
    })
    await git.worktreeRemove('/r', '/r/x')
    await git.branchDelete('/r', 'orrery/x')
    await git.branchDelete('/r', 'orrery/y', { force: true })
    expect(calls.some((call) => call.includes('--force'))).toBe(false)
    expect(calls).toContain('git branch -d orrery/x')
    expect(calls).toContain('git branch -D orrery/y')
  })

  it('reports a blocked removal as REMOVE_BLOCKED', async () => {
    const git = createGit(async () => ({ code: 128, stdout: '', stderr: 'contains modified or untracked files' }))
    await git.worktreeRemove('/r', '/r/x').then(
      () => expect('resolved').toBe('rejected'),
      (error) => expect(error.code).toBe('REMOVE_BLOCKED'),
    )
  })

  it('drives a real repository: add, inspect, precheck, merge, remove', async () => {
    const { repo, cleanup } = makeRepo()
    try {
      const git = createGit(nodeGitRun)
      const version = await git.version()
      expect(git.supported(version)).toBe(true)
      const info = await git.repoOf(repo)
      expect(info.mainRoot).toBe(repo)
      expect(await git.currentBranch(repo)).toBe('main')
      const path = join(repo, '.orrery', 'worktrees', 'x-001')
      ensureExclude(info.commonDir, '.orrery/worktrees')
      await git.worktreeAdd(repo, path, 'orrery/x-001', 'main')
      expect(await git.branchExists(repo, 'orrery/x-001')).toBe(true)
      writeFileSync(join(path, 'b.txt'), 'b\n')
      expect((await git.status(path)).map((entry) => entry.path)).toEqual(['b.txt'])
      sh(path, 'add', '.')
      sh(path, 'commit', '-qm', 'lane work')
      expect(await git.aheadBehind(repo, 'main', 'orrery/x-001')).toEqual({ ahead: 1, behind: 0 })
      expect(await git.diffStat(repo, 'main', 'orrery/x-001')).toEqual({ files: 1, added: 1, removed: 0 })
      expect((await git.commits(repo, 'main', 'orrery/x-001'))[0].subject).toBe('lane work')
      expect(await git.mergeTreeCheck(repo, 'main', 'orrery/x-001')).toEqual({ clean: true, conflicts: [] })
      const merged = await git.mergeNoFf(repo, 'orrery/x-001', 'merge(lane): X (x-001)')
      expect(merged.ok).toBe(true)
      expect(sh(repo, 'log', '-1', '--format=%s')).toBe('merge(lane): X (x-001)')
      expect(sh(repo, 'rev-list', '--count', '--merges', 'HEAD')).toBe('1')
      await git.worktreeRemove(repo, path)
      await git.branchDelete(repo, 'orrery/x-001')
      expect(await git.branchExists(repo, 'orrery/x-001')).toBe(false)
    } finally {
      cleanup()
    }
  })

  it('reports conflicts without touching the main worktree', async () => {
    const { repo, cleanup } = makeRepo()
    try {
      const git = createGit(nodeGitRun)
      const path = join(repo, '.orrery', 'worktrees', 'c-001')
      await git.worktreeAdd(repo, path, 'orrery/c-001', 'main')
      writeFileSync(join(path, 'a.txt'), 'lane\n')
      sh(path, 'commit', '-qam', 'lane')
      writeFileSync(join(repo, 'a.txt'), 'main\n')
      sh(repo, 'commit', '-qam', 'main')
      const head = sh(repo, 'rev-parse', 'HEAD')
      expect(await git.mergeTreeCheck(repo, 'main', 'orrery/c-001')).toEqual({ clean: false, conflicts: ['a.txt'] })
      const merged = await git.mergeNoFf(repo, 'orrery/c-001', 'm')
      expect(merged.ok).toBe(false)
      expect(sh(repo, 'rev-parse', 'HEAD')).toBe(head)
      expect(sh(repo, 'status', '--porcelain', '--untracked-files=no')).toBe('')
    } finally {
      cleanup()
    }
  })
})
