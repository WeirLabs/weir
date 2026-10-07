// pkgmgr: derived setup resolution — system first, DSH bundled runtime
// second, explicit diagnostics when neither offers the tool, and every path
// quoted (spaces in DSH home, executable dirs). Plus a gated REAL execution
// check against this machine's bundled runtime when it exists.
import { describe, expect, it } from './helpers.js'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BUNDLED_REL, quoteSh, resolveDerivedSetup, setupMissingReason } from '../src/worktree/pkgmgr.js'
import { createSetupResolver } from '../src/worktree/runner.js'

const NO_SYSTEM = () => undefined
const NO_DIRS = () => []

/** Fake DSH home with one bundled runtime. */
function fakeHome(root, { pnpm = true, npm = false, node = true } = {}) {
  const files = new Set()
  if (node) files.add(`${root}/dsh-runtimes/dsh-primary-runtime/${BUNDLED_REL.node}`)
  if (pnpm) files.add(`${root}/dsh-runtimes/dsh-primary-runtime/${BUNDLED_REL.pnpm}`)
  if (npm) files.add(`${root}/dsh-runtimes/dsh-primary-runtime/${BUNDLED_REL.npm}`)
  return {
    dshHome: root,
    listDirs: (dir) => (dir === `${root}/dsh-runtimes` ? ['dsh-primary-runtime'] : []),
    isFile: (path) => files.has(path),
  }
}

describe('quoteSh', () => {
  it('passes safe words through and quotes everything else', () => {
    expect(quoteSh('/usr/bin/node')).toBe('/usr/bin/node')
    expect(quoteSh('/Users/A B/.dsh/node')).toBe(`'/Users/A B/.dsh/node'`)
    expect(quoteSh(`it's`)).toBe(`'it'\\''s'`)
  })
})

describe('resolveDerivedSetup', () => {
  it("prefers the system tool and injects the resolved NODE directory first, then the manager's", () => {
    const resolution = resolveDerivedSetup('pnpm', {
      foundOnPath: (name) => (name === 'node' ? '/opt/homebrew/bin/node' : '/Users/me/.npm-global/bin/pnpm'),
      listDirs: NO_DIRS, isFile: () => false, dshHome: undefined,
    })
    expect(resolution.ok).toBe(true)
    expect(resolution.source).toBe('system')
    expect(resolution.display).toBe('pnpm install --frozen-lockfile')
    expect(resolution.command).toBe(`export PATH=/opt/homebrew/bin:/Users/me/.npm-global/bin:"$PATH"; exec /Users/me/.npm-global/bin/pnpm install --frozen-lockfile`)
  })

  it('a system manager whose node is not on PATH falls through to the bundled offer', () => {
    const home = fakeHome('/d')
    const resolution = resolveDerivedSetup('pnpm', {
      foundOnPath: (name) => (name === 'node' ? undefined : '/Users/me/.npm-global/bin/pnpm'),
      ...home,
    })
    expect(resolution.ok).toBe(true)
    expect(resolution.source).toBe('bundled')
    expect(resolution.command).toContain('/d/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node')
  })

  it('falls back to the bundled runtime, running pnpm.mjs through the bundled node', () => {
    const home = fakeHome('/ds h')
    const resolution = resolveDerivedSetup('pnpm', { foundOnPath: NO_SYSTEM, ...home })
    expect(resolution.ok).toBe(true)
    expect(resolution.source).toBe('bundled')
    const node = '/ds h/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node'
    const pm = '/ds h/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs'
    expect(resolution.command).toBe(`export PATH='/ds h/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin':"$PATH"; exec '${node}' '${pm}' install --frozen-lockfile`)
    expect(resolution.display).toBe(`node ${pm} install --frozen-lockfile`)
  })

  it('bundled npm only exists when the bundled node directory contains npm', () => {
    const withNpm = resolveDerivedSetup('npm', { foundOnPath: NO_SYSTEM, ...fakeHome('/d', { npm: true, pnpm: false }) })
    expect(withNpm.ok).toBe(true)
    expect(withNpm.command).toContain('dependencies/node/bin/npm')
    expect(withNpm.command).toContain(' ci')
    const withoutNpm = resolveDerivedSetup('npm', { foundOnPath: NO_SYSTEM, ...fakeHome('/d', { npm: false }) })
    expect(withoutNpm.ok).toBe(false)
  })

  it('yarn and bun have no bundled offer', () => {
    for (const manager of ['yarn', 'bun']) {
      expect(resolveDerivedSetup(manager, { foundOnPath: NO_SYSTEM, ...fakeHome('/d') }).ok).toBe(false)
    }
  })

  it('reports nothing found when both layers miss, with an actionable reason', () => {
    const resolution = resolveDerivedSetup('pnpm', { foundOnPath: NO_SYSTEM, listDirs: NO_DIRS, isFile: () => false, dshHome: '/empty' })
    expect(resolution).toEqual({ ok: false, manager: 'pnpm' })
    const reason = setupMissingReason('pnpm')
    expect(reason).toContain('setup needs pnpm')
    expect(reason).toContain('.weir/worktrees/.config.json')
    expect(reason).toContain('/worktree setup <lane> --skip')
  })

  it('uses <home>/.dsh when dshHome is unset and tolerates a missing runtimes dir', () => {
    const seen = []
    const resolution = resolveDerivedSetup('pnpm', {
      foundOnPath: NO_SYSTEM,
      dshHome: undefined,
      home: '/u',
      listDirs: (dir) => {
        seen.push(dir)
        return []
      },
      isFile: () => false,
    })
    expect(resolution.ok).toBe(false)
    expect(seen).toEqual(['/u/.dsh/dsh-runtimes'])
  })

  it('keeps frozen-lockfile semantics for every manager', () => {
    for (const manager of ['pnpm', 'yarn', 'bun']) {
      const resolution = resolveDerivedSetup(manager, { foundOnPath: () => `/sys/${manager === 'node' ? undefined : manager}`, listDirs: NO_DIRS, isFile: () => false })
      expect(resolution.command).toContain('install --frozen-lockfile')
    }
    const nodeAndNpm = (name) => `/sys/${name}`
    expect(resolveDerivedSetup('npm', { foundOnPath: nodeAndNpm, listDirs: NO_DIRS, isFile: () => false }).command).toContain(' ci')
  })
})

describe('createSetupResolver adapter', () => {
  const find = (paths) => async (name) => paths[name]

  it('injects the node directory AND the manager directory when they differ', async () => {
    const resolve = createSetupResolver({
      subprocess: undefined,
      findExecutable: find({ pnpm: '/Users/me/.npm-global/bin/pnpm', node: '/opt/homebrew/bin/node' }),
      env: {},
      home: '/no-bundled-here',
    })
    const resolution = await resolve('pnpm')
    expect(resolution.ok).toBe(true)
    expect(resolution.source).toBe('system')
    expect(resolution.command).toBe(`export PATH=/opt/homebrew/bin:/Users/me/.npm-global/bin:"$PATH"; exec /Users/me/.npm-global/bin/pnpm install --frozen-lockfile`)
  })

  it('falls through to the bundled offer when the manager resolves but node does not', async () => {
    // The adapter wires REAL filesystem seams, so the bundled runtime must
    // exist on disk: a manager found while node is not must fall through.
    const home = mkdtempSync(join(tmpdir(), 'weir-dsh-'))
    try {
      mkdirSync(join(home, 'dsh-runtimes/dsh-primary-runtime/dependencies/node/bin'), { recursive: true })
      mkdirSync(join(home, 'dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin'), { recursive: true })
      writeFileSync(join(home, `dsh-runtimes/dsh-primary-runtime/${BUNDLED_REL.node}`), '')
      writeFileSync(join(home, `dsh-runtimes/dsh-primary-runtime/${BUNDLED_REL.pnpm}`), '')
      const resolve = createSetupResolver({
        subprocess: undefined,
        findExecutable: find({ pnpm: '/Users/me/.npm-global/bin/pnpm', node: undefined }),
        env: { DSH_HOME: home },
      })
      const resolution = await resolve('pnpm')
      expect(resolution.ok).toBe(true)
      expect(resolution.source).toBe('bundled')
      expect(resolution.command).toContain(`${home}/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node`)
      expect(resolution.command).toContain('--frozen-lockfile')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })

  it('does not feed the manager back when the core asks for a third tool', async () => {
    const seen = []
    const resolve = createSetupResolver({
      subprocess: undefined,
      findExecutable: async (name) => { seen.push(name); return `/sys/${name}` },
      env: {},
    })
    await resolve('yarn')
    expect(seen).toEqual(['yarn', 'node'])
  })
})

describe('createSetupResolver against the real host', () => {
  const dshHome = process.env.DSH_HOME ?? `${process.env.HOME}/.dsh`
  const node = `${dshHome}/dsh-runtimes/dsh-primary-runtime/${BUNDLED_REL.node}`
  const pnpm = `${dshHome}/dsh-runtimes/dsh-primary-runtime/${BUNDLED_REL.pnpm}`
  const bundled = existsSync(node) && existsSync(pnpm)

  it('resolves pnpm to a working invocation (system or bundled)', async (t) => {
    // Host-contract test: the seam is created with subprocess undefined, so
    // the system-PATH probe is disabled by design and only the bundled DSH
    // runtime can satisfy the resolution. Machines without one (e.g. CI
    // runners) cannot meet the contract — skip like the sibling test.
    if (!bundled) {
      t.skip('no DSH bundled runtime on this machine')
      return
    }
    const resolve = createSetupResolver({ subprocess: undefined, env: { DSH_HOME: dshHome } })
    const resolution = await resolve('pnpm')
    expect(resolution.ok, JSON.stringify(resolution)).toBe(true)
    if (resolution.source === 'bundled') {
      expect(resolution.command).toContain(pnpm)
    }
  })

  it('the bundled invocation form actually runs (node + pnpm.mjs, PATH injected) — REAL execution', (t) => {
    if (!bundled) {
      t.skip('no DSH bundled runtime on this machine')
      return
    }
    const out = execFileSync('bash', ['-c', `export PATH="${dshHome}/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin":"$PATH"; exec "${node}" "${pnpm}" --version`], { encoding: 'utf8' })
    expect(out.trim()).toMatch(/^\d+\.\d+\.\d+$/)
    // The injected PATH is what lets pnpm spawn node for lifecycle scripts.
    const which = execFileSync('bash', ['-c', `export PATH="${dshHome}/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin":"$PATH"; command -v node`], { encoding: 'utf8' }).trim()
    expect(statSync(which).isFile()).toBe(true)
    expect(which).toBe(node)
  })
})
