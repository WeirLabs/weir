// Task 8.2 of the session-capability-manager change: the per-server proxy
// facade. Each Orrery-managed MCP server runs the stock `dsh-mcp-client`
// inside its own isolated cordis:group; this facade plugin shares that group
// and provides the realm-local `tools` / `systemPrompt` / `mcpResources`
// services the stock client calls, so EVERY registration the client makes
// passes through Orrery code with a KNOWN configured identity:
//
// - tools.register(definition): the public name is bound to
//   { identity, generation } AT REGISTRATION TIME (the mapping is never
//   reverse-parsed from the name string, G3b), and the definition is
//   wrapped with the last-moment admission check (8.3) before it is
//   forwarded to the host-plane tools service captured outside the group.
// - systemPrompt.section: the `mcp:<server>` instruction block is filtered
//   PER AGENT at every prompt assembly — an agent without the server gets an
//   empty string (renderPrompt drops zero-length sections, CITED).
// - mcpResources.register(provider): resource operations are gated by the
//   target server at dispatch time (8.4).
//
// Fail closed: a host method the facade does not know (the host added a new
// call to one of these services) makes THIS server fail visibly instead of
// passing through unfiltered.
import { createMcpToolWrapper } from './mcp-admission.js'

const message = error => (error instanceof Error ? error.message : String(error))

/**
 * @param {{ host: { tools?: unknown, systemPrompt?: unknown, mcpResources?: unknown },
 *   identity: string, generation: number,
 *   admit: (agent: unknown) => Promise<boolean>,
 *   isEnabledFor: (agent: unknown) => boolean,
 *   onError?: (reason: string, cause?: unknown) => void }} config
 */
export function createMcpFacade({ host, identity, generation, admit, isEnabledFor, drain, onRegister, onError = () => {} }) {
  const wrapper = createMcpToolWrapper({ identity, generation, admit, drain })

  const unknown = (service, method) => {
    const reason = `facade-unknown-method:${service}.${method}`
    onError(reason)
    throw new Error(`Orrery MCP facade for "${identity}" does not know host method ${service}.${method}; this server fails closed`)
  }

  const tools = {
    register(definition) {
      // Bind the public name to this configured identity at registration
      // time, then wrap the definition with the last-moment admission check.
      const wrapped = wrapper.wrap(definition)
      const registration = /** @type {{ register(d: unknown): unknown }} */ (host.tools).register(wrapped)
      // Report the binding back to the manager (creation-time schema hiding
      // and the managed listing read this map).
      if (typeof wrapped?.name === 'string') onRegister?.(wrapped.name)
      return registration
    },
    get(...args) { return /** @type {{ get(...a: unknown[]): unknown }} */ (host.tools).get(...args) },
    list(...args) { return /** @type {{ list(...a: unknown[]): unknown }} */ (host.tools).list(...args) },
    restrict(...args) { return /** @type {{ restrict(...a: unknown[]): unknown }} */ (host.tools).restrict(...args) },
  }

  const systemPrompt = {
    section(definition) {
      const render = definition?.render
      const filtered = {
        ...definition,
        render: async (agent, ...rest) => {
          // Per-agent filter at every assembly (8.4): an agent without this
          // server gets an empty string — zero-length sections are dropped.
          if (!isEnabledFor(agent)) return ''
          return typeof render === 'function' ? render(agent, ...rest) : ''
        },
      }
      return /** @type {{ section(d: unknown): unknown }} */ (host.systemPrompt).section(filtered)
    },
    getSectionOrder(...args) { return /** @type {{ getSectionOrder(...a: unknown[]): unknown }} */ (host.systemPrompt).getSectionOrder(...args) },
  }

  const mcpResources = {
    /**
     * Host contract (CITED stock client registerServerContext):
     * mcpResources.register(server, provider) — the server argument is
     * preserved verbatim and the provider's request path is gated by THIS
     * facade's admission verdict (8.4①: resource operations are gated at
     * dispatch by the target server; shared resource tool schemas stay
     * visible, only execution is gated).
     */
    register(server, provider) {
      const request = provider?.request
      const gated = typeof request === 'function'
        ? { ...provider, async request(args, exec) {
            const admitted = await admit(exec?.agent)
            if (!admitted) {
              const error = new Error(`MCP server "${identity}" resources are not enabled for this agent`)
              throw Object.assign(error, { code: 'mcp-admission-refused' })
            }
            return request(args, exec)
          } }
        : provider
      return /** @type {{ register(s: unknown, p: unknown): unknown }} */ (host.mcpResources).register(server, gated)
    },
  }

  /** Reflect-style lookup the stock client performs on its group ctx. */
  function serviceFor(name) {
    if (name === 'tools') return tools
    if (name === 'systemPrompt') return systemPrompt
    if (name === 'mcpResources') return mcpResources
    return undefined
  }

  return { identity, generation, tools, systemPrompt, mcpResources, serviceFor, unknown, message }
}
