// Executable resolution for LSP servers and installers. The desktop app is
// a GUI process launched by LaunchServices, so its PATH is the minimal
// `/usr/bin:/bin:/usr/sbin:/sbin` — Homebrew (/opt/homebrew, /usr/local),
// nvm, cargo, go, pipx and npm-global bins are all missing, and
// ctx.subprocess.resolveExecutable() fails for them (S21). This helper
// falls back to scanning well-known installation directories so servers and
// their installers resolve the same way they do in the user's shell.
import { accessSync, constants, existsSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** Well-known bin directories scanned when the service resolver fails. */
export function extraBinDirectories(env = process.env) {
  const home = env.HOME ?? homedir()
  const nvmBins = []
  const nvmBase = join(home, '.nvm', 'versions', 'node')
  try {
    for (const version of readdirSync(nvmBase)) {
      nvmBins.push(join(nvmBase, version, 'bin'))
    }
  } catch {
    // no nvm
  }
  return [
    '/opt/homebrew/bin',
    '/opt/homebrew/opt/llvm/bin',
    '/usr/local/bin',
    '/usr/local/opt/llvm/bin',
    '/opt/local/bin',
    join(home, '.npm-global', 'bin'),
    join(home, '.local', 'bin'),
    join(home, '.cargo', 'bin'),
    join(home, 'go', 'bin'),
    join(home, 'Library', 'pnpm'),
    ...nvmBins,
  ]
}

function isExecutableFile(path) {
  try {
    const stats = statSync(path)
    if (!stats.isFile()) return false
    accessSync(path, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve a command to an absolute executable path: the subprocess service
 * first, then the well-known directories. Returns undefined when the command
 * is nowhere to be found (callers turn that into their install hints).
 * @param subprocess - ctx.subprocess-like service (may be absent)
 * @param command - command name or absolute path
 */
export async function resolveExecutable(subprocess, command, dirs = extraBinDirectories()) {
  if (command.includes('/')) return isExecutableFile(command) ? command : undefined
  try {
    const resolved = await subprocess?.resolveExecutable(command)
    if (resolved) return resolved
  } catch {
    // fall through to the directory scan
  }
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    const candidate = join(dir, command)
    if (isExecutableFile(candidate)) return candidate
  }
  return undefined
}
