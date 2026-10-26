// MCP-specific use of the shared GUI executable/PATH adapter. Secret argv/env
// values are used only in memory; execution metadata is safe for confirmation.
import { resolveExecutable, spawnArgv, childEnvironment } from '../process/index.js'
import { McpLifecycleError } from './mcp-diagnostics.js'

export function createMcpProcessAdapter({
  subprocess,
  platform = process.platform,
  env = process.env,
  resolve = resolveExecutable,
  launchShape = spawnArgv,
  childEnv = childEnvironment,
} = {}) {
  async function prepare(client) {
    if (client?.transport !== 'stdio') return { client: structuredClone(client), execution: null }
    const requestedCommand = client.command
    const resolvedCommand = await resolve(subprocess, requestedCommand)
    if (!resolvedCommand) {
      throw new McpLifecycleError('executable-not-found', new Error(`MCP executable "${requestedCommand}" was not found on the GUI PATH or known install directories`), {
        status: 'validation-failed',
        action: 'fix-command',
      })
    }
    const originalArgs = [...(client.args ?? [])]
    const argv = launchShape(resolvedCommand, originalArgs, platform, { subject: 'mcp', setting: 'command' })
    const prepared = {
      ...structuredClone(client),
      command: argv[0],
      args: argv.slice(1),
      env: { ...childEnv(env, platform), ...(client.env ?? {}) },
    }
    return {
      client: prepared,
      execution: {
        requestedCommand,
        resolvedCommand,
        argumentCount: originalArgs.length,
        windowsShim: platform === 'win32' && argv[0] !== resolvedCommand,
      },
    }
  }
  return { prepare }
}
