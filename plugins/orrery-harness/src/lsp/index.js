// Orrery LSP integration: on-demand semantic tools via a self-built minimal
// LSP client. Default OFF (LSP can be semantic noise in some environments);
// the user toggles it per session at any time with the `lsp` tool. Plain ESM,
// ctx-only.
import { createLspManager, LSP_DEFAULTS } from './manager.js'
import { buildRegistry } from './registry.js'
import { createLspTools } from './tools.js'

const name = 'orrery-lsp'
const inject = ['tools', 'subprocess', 'fs']

function apply(ctx, config = {}) {
  // Settings overlay (absent service = no-op): lsp section wins over row config.
  const settingsOverride = ctx.get?.('orrerySettings')?.get('lsp')
  if (settingsOverride && typeof settingsOverride === 'object') {
    config = { ...config, ...settingsOverride }
  }
  const manager = createLspManager({
    subprocess: ctx.subprocess,
    fs: ctx.fs,
    registry: buildRegistry(config.servers),
    options: {
      idleMs: config.idleMs ?? LSP_DEFAULTS.idleMs,
      requestTimeoutMs: config.requestTimeoutMs ?? LSP_DEFAULTS.requestTimeoutMs,
      diagnosticsWaitMs: config.diagnosticsWaitMs ?? LSP_DEFAULTS.diagnosticsWaitMs,
    },
  })

  /** Per-session enable state: agentId → { disposers: Function[] } */
  const enabled = new Map()

  function enableFor(agent) {
    if (enabled.has(agent.id)) return
    const disposers = createLspTools({
      manager,
      ctx,
      agent,
      diagnosticsWaitMs: config.diagnosticsWaitMs ?? LSP_DEFAULTS.diagnosticsWaitMs,
    }).map((definition) => agent.ctx.tools.register(definition))
    enabled.set(agent.id, { disposers })
  }

  async function disableFor(agent) {
    const entry = enabled.get(agent.id)
    if (!entry) return
    enabled.delete(agent.id)
    for (const dispose of entry.disposers) dispose()
    await manager.releaseSession(agent.id)
  }

  // Config-driven auto-enable: lsp.enabled on means every new agent of this
  // composition gets the tools (still per-session, scoped registrations).
  if (config.enabled === true) {
    ctx.on('agent/created', ({ agent }) => {
      enableFor(agent)
    })
  }

  ctx.on('agent/disposed', ({ agent }) => {
    void disableFor(agent)
  })

  ctx.tools.register({
    name: 'lsp',
    description: `Toggle LSP semantic tools for THIS session (lsp_diagnostics, lsp_definition, lsp_references, lsp_symbols). Off by default — enable when you want language-server answers (definitions, references, symbols, diagnostics) for the current workspace; disable to remove the tools and shut the servers down. Language servers must be installed separately; a missing server reports an install hint on first use.`,
    parameters: {
      type: 'object',
      properties: {
        enabled: { type: 'boolean', description: 'true to enable the LSP tool set, false to disable it.' },
      },
      required: ['enabled'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: `LSP semantic tools ${value.enabled ? 'enabled' : 'disabled'} for this session${value.enabled ? ' (servers start lazily on first use)' : ''}.` }],
    },
    async execute(args, exec) {
      const agent = exec.agent
      if (!agent) throw new Error('lsp: requires an owning agent session')
      if (args.enabled === true) {
        enableFor(agent)
      } else if (args.enabled === false) {
        await disableFor(agent)
      } else {
        throw new Error('lsp: enabled must be a boolean')
      }
      return { enabled: args.enabled }
    },
  })

  return () => manager.dispose()
}

export { name, inject, apply }
