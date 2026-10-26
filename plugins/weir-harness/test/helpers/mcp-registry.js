import { createMcpRegistry } from '../../src/capabilities/mcp-registry.js'
import { openCapabilityStore } from '../../src/capabilities/store/store.js'

/** Seed real managed registrations for command/Apply tests (no mock registry). */
export async function seedMcpRegistrations(root, identities = ['docs']) {
  const registry = createMcpRegistry({ store: openCapabilityStore({ profileContext: { home: root, name: 'it' }, platform: 'darwin' }) })
  let revision = 0
  for (const identity of identities) {
    const result = await registry.register({
      identity,
      label: identity,
      owner: { kind: 'global', key: 'installation' },
      generation: 0,
      configuredAt: 0,
      transport: { kind: 'stdio', ref: 'cmd:node' },
      client: { transport: 'stdio', serverName: identity, command: process.execPath, args: [], env: {} },
    }, revision)
    if (result.status !== 'committed') throw new Error(`failed to seed MCP registration ${identity}: ${result.status}`)
    revision = result.revision
  }
  return registry
}
