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

export function createCommandMcpManager({ status = 'mounted' } = {}) {
  const calls = { mount: 0, probe: 0, remove: 0, begin: 0 }
  return {
    calls,
    support: () => ({ credentials: true, ephemeral: true }),
    serverNameConflict: () => null,
    beginOperation(identity, phase) { calls.begin += 1; return { identity, phase, operationId: `op-${calls.begin}`, previous: null } },
    abortOperation: () => true,
    async reconcileOne(identity, entry) {
      calls.mount += 1
      return { status, identity, generation: entry.generation, incarnation: entry.incarnation ?? null, saved: true, succeeded: status === 'mounted', mount: { state: status === 'mounted' ? 'mounted' : 'degraded', observedGeneration: entry.generation }, discovery: { toolCount: 0, toolNamesPreview: [], truncated: false } }
    },
    async probe(identity) { calls.probe += 1; return { status: 'mounted', identity, discovery: { toolCount: 0, toolNamesPreview: [], truncated: false }, cleanup: { status: 'cleaned' } } },
    async removeRuntime(identity) { calls.remove += 1; return { status: 'removed', identity, removed: true } },
  }
}
