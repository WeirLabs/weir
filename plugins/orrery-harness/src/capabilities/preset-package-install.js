// capability-manager-ux task 6.3 (design D6): the confirmed (phase-two)
// install of a version-2 package's bundled Skills.
//
// Discipline:
// - Target roots come from the caller's skill-inventory root resolution
//   (project = the current workspace's project Skill root, user = the user
//   Skill root); this module never guesses a root. A needed scope without a
//   root fails BEFORE any write.
// - Collision policy is same-name-policy's installTargetFor: the default
//   'cancel' writes nothing for an occupied name and reports the collision;
//   'replace' overwrites only because it was explicitly confirmed; 'coexist'
//   installs under a derived distinguishable name (`<name>-2`, `-3`, …) and
//   rewrites the bundled SKILL.md frontmatter name so discovery sees a
//   genuinely distinct Skill.
// - Every file write is temp-name → rename inside the target directory. On
//   ANY file failure the files this install already wrote are rolled back
//   (removed) and the directories it created are pruned, so the caller
//   creates NO preset record over a half-installed tree. A confirmed
//   replace's prior content is not restorable — rollback removes what this
//   install wrote, which is exactly what the replace decision authorized.
// - The install outcome and every collision decision go to the injected
//   audit sink; an audit failure never changes the policy outcome.
// - Zero network, zero server starts, zero connection changes: the only
//   effects are files under the two resolved Skill roots.
import { mkdir, rename, rm, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { installTargetFor } from './same-name-policy.js'

const DEFAULT_FS = { mkdir, rename, rm, stat, unlink, writeFile }

/** @param {unknown} error */
const message = error => (error instanceof Error ? error.message : String(error))

/**
 * Rewrite the frontmatter `name:` scalar of a bundled SKILL.md so a coexist
 * install is a genuinely distinct Skill — discovery reads the name from
 * frontmatter, not from the directory name. Content without a recognizable
 * frontmatter name line is returned untouched.
 * @param {string} content @param {string} newName
 */
export function renameSkillContent(content, newName) {
  const match = /^(---\r?\n)([\s\S]*?)(\r?\n---)/.exec(content)
  if (!match) return content
  const [whole, open, block, close] = match
  if (!/^name:[^\n]*$/m.test(block)) return content
  const renamed = block.replace(/^name:[^\n]*$/m, `name: ${newName}`)
  return open + renamed + close + content.slice(whole.length)
}

/**
 * Install a validated package's bundled Skills into the resolved roots.
 * @param {Array<{ targetScope: 'project'|'user', name: string,
 *   files: Array<{ path: string, content: string }> }>} bundled
 * @param {{ roots: { project?: string | null, user?: string | null },
 *   onCollision?: 'cancel'|'replace'|'coexist' }} options
 * @param {{ fs?: Record<string, any>, audit?: (data: unknown) => void,
 *   token?: () => string }} [deps]
 * @returns {Promise<{ ok: true,
 *   installed: Array<{ targetScope: string, name: string, target: string, fileCount: number, status: string, collision?: true }>,
 *   collisions: Array<{ targetScope: string, name: string, decision: string }> }
 *   | { ok: false, reason: string, failedSkill: string | null, rolledBack: number }>}
 */
export async function installBundledSkills(bundled, options, deps = {}) {
  const fs = { ...DEFAULT_FS, ...(deps.fs ?? {}) }
  const token = deps.token ?? (() => `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`)
  const audit = typeof deps.audit === 'function' ? deps.audit : () => {}
  const onCollision = options.onCollision ?? 'cancel'
  const roots = options.roots ?? {}
  const entries = Array.isArray(bundled) ? bundled : []

  const exists = async path => { try { await fs.stat(path); return true } catch { return false } }
  const occupied = async (root, name) => (await exists(join(root, name))) || (await exists(join(root, `${name}.md`)))

  // Preflight: every needed scope root must be resolved before ANY write.
  for (const entry of entries) {
    const root = roots[entry.targetScope]
    if (typeof root !== 'string' || root.length === 0) {
      return { ok: false, reason: `no-target-root:${entry.targetScope}`, failedSkill: null, rolledBack: 0 }
    }
  }

  /** @type {string[]} final paths this install renamed into place */
  const written = []
  /** @type {string[]} directories this install created (pruned on rollback) */
  const createdDirs = []

  const ensureDir = async dir => {
    const missing = []
    let current = dir
    while (!(await exists(current))) {
      missing.push(current)
      const parent = dirname(current)
      if (parent === current) break
      current = parent
    }
    if (missing.length === 0) return
    await fs.mkdir(dir, { recursive: true })
    createdDirs.push(...missing)
  }

  /** Temp-name → rename inside the target directory; the temp never survives a failure. */
  const writeFileAtomic = async (targetPath, content) => {
    const temp = join(dirname(targetPath), `${basename(targetPath)}.${token()}.tmp`)
    try {
      await fs.writeFile(temp, content, { encoding: 'utf8', flag: 'wx' })
      await fs.rename(temp, targetPath)
    } catch (cause) {
      try { await fs.unlink(temp) } catch { /* the temp may never have existed */ }
      throw cause
    }
    written.push(targetPath)
  }

  const rollback = async () => {
    let removed = 0
    for (const path of [...written].reverse()) {
      try { await fs.unlink(path); removed += 1 } catch { /* best effort */ }
    }
    for (const dir of createdDirs) {
      try { await fs.rm(dir, { recursive: true, force: true }) } catch { /* best effort */ }
    }
    written.length = 0
    createdDirs.length = 0
    return removed
  }

  /** Audit is log-only: a sink failure must never roll back policy. */
  const emit = data => { try { audit(data) } catch { /* audit must never roll back policy */ } }

  const distinctNameFor = async (root, name) => {
    for (let suffix = 2; suffix <= 100; suffix += 1) {
      const candidate = `${name}-${suffix}`
      if (!(await occupied(root, candidate))) return candidate
    }
    return null
  }

  /** @type {Array<{ targetScope: string, name: string, target: string, fileCount: number, status: string, collision?: true }>} */
  const installed = []
  /** @type {Array<{ targetScope: string, name: string, decision: string }>} */
  const collisions = []
  let currentSkill = null
  try {
    for (const entry of entries) {
      currentSkill = entry.name
      const root = /** @type {string} */ (roots[entry.targetScope])
      const isOccupied = await occupied(root, entry.name)
      let targetName
      if (isOccupied && onCollision === 'coexist') {
        const distinct = await distinctNameFor(root, entry.name)
        if (distinct === null) {
          collisions.push({ targetScope: entry.targetScope, name: entry.name, decision: 'coexist-needs-distinct-name' })
          continue
        }
        targetName = distinct
      }
      const verdict = installTargetFor({ name: entry.name, occupied: isOccupied, decision: onCollision, targetName })
      if (!verdict.write) {
        // cancel (the default): zero writes for this Skill, reported.
        collisions.push({ targetScope: entry.targetScope, name: entry.name, decision: verdict.status })
        continue
      }
      const target = /** @type {string} */ (verdict.target)
      if (verdict.status === 'replace-confirmed') {
        await fs.rm(join(root, target), { recursive: true, force: true })
        await fs.rm(join(root, `${target}.md`), { force: true })
      }
      const skillDir = join(root, target)
      await ensureDir(skillDir)
      for (const file of entry.files) {
        const targetPath = join(skillDir, ...file.path.split('/'))
        await ensureDir(dirname(targetPath))
        const content = verdict.status === 'coexist-distinct' && file.path === 'SKILL.md'
          ? renameSkillContent(file.content, target)
          : file.content
        await writeFileAtomic(targetPath, content)
      }
      installed.push({
        targetScope: entry.targetScope,
        name: entry.name,
        target,
        fileCount: entry.files.length,
        status: verdict.status,
        ...(isOccupied ? { collision: true } : {}),
      })
    }
  } catch (cause) {
    const rolledBack = await rollback()
    const reason = message(cause)
    emit({ outcome: 'install-failed', reason, failedSkill: currentSkill, onCollision, installed, collisions, rolledBack })
    return { ok: false, reason, failedSkill: currentSkill, rolledBack }
  }
  emit({ outcome: 'installed', onCollision, installed, collisions })
  return { ok: true, installed, collisions }
}
