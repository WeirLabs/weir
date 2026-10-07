// Explicit fixture-only dependencies: never discover an enclosing real authority.
import { execFileSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, isAbsolute, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { after } from 'node:test'
import { managementRootFor, excludeFromGit } from '../../src/edit-lock/domains.js'

function fixtureGit(start, args) {
  const ceiling = realpathSync(tmpdir())
  const rel = relative(ceiling, realpathSync(start))
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error('Git cwd outside fixture ceiling')
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')))
  try {
    return execFileSync('git', args, { cwd: start, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
      env: { ...env, GIT_CEILING_DIRECTORIES: ceiling, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null' } }).trim() || undefined
  } catch { return undefined }
}
export function fixtureRoot(cwd) {
  return managementRootFor(cwd, { ceiling: realpathSync(tmpdir()), runGit: fixtureGit })
}
export function fixtureExclude(root) { return excludeFromGit(root, fixtureGit) }

// Unix socket names must fit sockaddr_un. Allocate a private short directory at
// the checkout root, not outside the lane; production endpoint identity is intact.
const checkout = realpathSync(fileURLToPath(new URL('../../../../', import.meta.url)))
const endpoints = new Map()
export function fixtureEndpoint(directory) {
  const key = realpathSync(directory)
  if (!endpoints.has(key)) {
    const root = realpathSync(mkdtempSync(join(checkout, '.s-')))
    const endpoint = join(root, 'p')
    if (Buffer.byteLength(endpoint) > 100) throw new Error('fixture socket needs a shorter authorized checkout')
    endpoints.set(key, { root, endpoint })
  }
  return endpoints.get(key).endpoint
}
after(() => {
  for (const { root } of endpoints.values()) {
    const rel = relative(checkout, root)
    if (isAbsolute(rel) || rel.startsWith(`..${sep}`) || !rel.startsWith('.s-') || realpathSync(root) !== root) throw new Error('fixture socket cleanup root changed')
    rmSync(root, { recursive: true, force: true })
  }
})
