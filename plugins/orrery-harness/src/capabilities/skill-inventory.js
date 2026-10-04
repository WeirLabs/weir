import * as nodeFs from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { createSkillIdentity } from './skill-identity.js'
import { parseSkillText } from './frontmatter.js'

export const SKILL_ROOT_RANKS = Object.freeze({ 'project-dsh': 100, 'project-agents': 200, custom: 300, 'user-dsh': 400, 'user-agents': 500, bundled: 600 })

/** Find the nearest .git ancestor, including worktree .git files; otherwise use cwd. */
export async function findProjectRoot(cwd, fs = nodeFs) {
  const initial = resolve(cwd)
  let current = initial
  while (true) {
    try { await fs.access(join(current, '.git')); return current } catch {}
    const parent = dirname(current)
    if (parent === current) return initial
    current = parent
  }
}

/** Homes are supplied by the host adapter, not inferred from the process profile. */
export async function resolveSkillRoots({ cwd, dshHome, agentsHome, customSkillDirs = [], bundledSkillDir, orreryBuiltinDir, includeDefaultRoots = true }, fs = nodeFs) {
  const roots = []
  const add = (path, source, scope, extra = {}) => roots.push({ path: resolve(path), source, scope, rank: SKILL_ROOT_RANKS[source], ...extra })
  if (includeDefaultRoots && cwd !== undefined) {
    const projectRoot = await findProjectRoot(cwd, fs)
    add(join(projectRoot, '.dsh/skills'), 'project-dsh', 'project', { projectRoot })
    add(join(projectRoot, '.agents/skills'), 'project-agents', 'project', { projectRoot })
  }
  for (const path of customSkillDirs) add(path, 'custom', 'custom')
  // Orrery's former customSkillDirs mount had rank 300, not host bundled rank 600.
  if (orreryBuiltinDir !== undefined) add(orreryBuiltinDir, 'custom', 'orrery-builtin', { trustedHost: true })
  if (includeDefaultRoots) {
    if (!dshHome || !agentsHome) throw new TypeError('Explicit dshHome and agentsHome are required')
    add(join(dshHome, 'skills'), 'user-dsh', 'user', { skipSystem: true })
    add(join(agentsHome, 'skills'), 'user-agents', 'user')
  }
  // Host bundles are not automatically Orrery-owned or selected.
  if (bundledSkillDir !== undefined) add(bundledSkillDir, 'bundled', 'custom', { trustedHost: true })
  return roots
}

const rootKey = root => JSON.stringify([resolve(root.path), root.source, root.scope, root.rank])
const message = error => error instanceof Error ? error.message : String(error)

/**
 * Observe every candidate without deduplication or authorization decisions.
 * Pass the previous snapshot to retain last-good roots on incomplete reads.
 * provenanceFor must use trusted installation records, never frontmatter claims.
 * machineId must be a persisted installation-local opaque namespace.
 */
export async function discoverSkillInventory({ roots, machineId, previous, provider = 'filesystem', provenanceFor = () => null, fs = nodeFs }) {
  if (typeof machineId !== 'string' || !machineId.length) throw new TypeError('A persistent machineId is required')
  const observations = []
  for (const root of roots) {
    const key = rootKey(root)
    const old = previous?.roots?.find(item => item.key === key)
    let entries
    let canonicalRoot
    try {
      entries = await fs.readdir(root.path, { withFileTypes: true, encoding: 'utf8' })
      canonicalRoot = await fs.realpath(root.path)
    } catch (error) {
      // Missing roots are empty on first discovery, but a vanished last-good root
      // is incomplete: absence must not silently erase accepted inventory facts.
      const absent = ['ENOENT', 'ENOTDIR'].includes(error?.code)
      const complete = absent && !old?.candidates?.length
      observations.push({ key, root: { ...root }, complete, stale: !complete, candidates: old?.candidates ?? [], ...(complete ? {} : { error: message(error) }) })
      continue
    }
    const candidates = []
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      if (root.skipSystem && entry.name === '.system') continue
      const entryPath = join(root.path, entry.name)
      let locator
      try {
        const info = entry.isSymbolicLink() ? await fs.stat(entryPath) : entry
        locator = info.isDirectory() ? { path: join(entryPath, 'SKILL.md'), directory: entryPath }
          : info.isFile() && entry.name.endsWith('.md') ? { path: entryPath, directory: root.path } : undefined
        if (!locator) continue
        const path = await fs.realpath(locator.path)
        const raw = await fs.readFile(path, 'utf8')
        const parsed = parseSkillText(raw)
        const provenance = await provenanceFor({ root, locator, path, name: parsed.name })
        const opaqueId = createHash('sha256').update(JSON.stringify([machineId, root.scope, canonicalRoot, parsed.name, path])).digest('hex')
        const identity = createSkillIdentity({ scope: root.scope, root: canonicalRoot, name: parsed.name, provenance, opaqueId })
        const { content, ...fields } = parsed
        candidates.push({ ...fields, provider, source: root.source, rank: root.rank, locator,
          resourceBase: { kind: 'directory', path: locator.directory }, path,
          status: 'parsed', identity, digest: createHash('sha256').update(raw).digest('hex'), root: { ...root },
        })
      } catch (error) {
        // Retain unreadable files, invalid metadata and broken symbolic links.
        candidates.push({ status: 'unparsed', entryName: entry.name, provider, source: root.source, rank: root.rank,
          root: { ...root }, locator: locator ?? { path: entryPath, directory: root.path }, error: message(error) })
      }
    }
    observations.push({ key, root: { ...root }, complete: true, stale: false, candidates })
  }
  return { complete: observations.every(root => root.complete), roots: observations, candidates: observations.flatMap(root => root.candidates) }
}
