// Orrery LSP integration: on-demand semantic tools via a self-built minimal
// LSP client. `lsp.enabled` is the capability MASTER SWITCH: off → no `lsp`
// tool, no `/lsp` command, no panel switch, nothing registered; on → the
// capability surface is available and every session starts with LSP OFF,
// toggleable per session at any time through the `/lsp` command (session
// panel) or the `lsp` tool (model). Per-session state folds durably through
// the `orreryLsp` session projection and restores on agent creation. Plain
// ESM, ctx-only.
import { createLspManager, LSP_DEFAULTS } from './manager.js'
import { buildRegistry } from './registry.js'
import { createLspTools } from './tools.js'

const name = 'orrery-lsp'
const inject = ['tools', 'subprocess', 'fs']

/** Projection key of the per-session durable LSP state. */
export const LSP_PROJECTION_KEY = 'orreryLsp'

/**
 * Hand-rolled stateSchema for the session projection. The registry's cold
 * read calls `stateSchema.parse(row.val)`; vendored schemastery schemas have
 * no `.parse` (only the ~standard interface), so provide a minimal shim.
 */
const lspStateSchema = {
  parse(value) {
    if (value === null || typeof value !== 'object' || typeof value.enabled !== 'boolean') {
      throw new Error('orreryLsp: bad projection state')
    }
    return value
  },
}

/**
 * Pure fold: the durable per-session LSP state is the last accepted toggle
 * recorded in the session log (tool calls by the model, command runs by the
 * user through the session panel). Unrelated events pass through; malformed
 * payloads are ignored.
 */
export function foldLspState(state, event) {
  if (event?.type === 'tool/call' && event.data?.name === 'lsp') {
    try {
      const args = JSON.parse(event.data.arguments ?? '{}')
      if (typeof args?.enabled === 'boolean') return { enabled: args.enabled }
    } catch {
      // malformed arguments JSON: ignore the event
    }
  }
  if (event?.type === 'command/run' && event.data?.name === 'lsp') {
    const arg = String(event.data.args ?? '').trim().toLowerCase()
    if (arg === 'on') return { enabled: true }
    if (arg === 'off') return { enabled: false }
  }
  return state
}

function apply(ctx, config = {}) {
  // Capability gate: settings overlay wins over the row config; the settings
  // service is re-resolved and read at every evaluation so volatile commits
  // propagate live (the service recomputes sections from the mutated config).
  const gate = () => {
    const settings = ctx.get?.('orrerySettings')
    const enabled = settings?.get('lsp')?.enabled ?? config.enabled
    return enabled === true
  }

  let manager = null
  /** Per-session enable state: agentId → { disposers: Function[] } */
  const enabled = new Map()
  /** Every agent this module has seen: agentId → agent (restore sync). */
  const seen = new Map()
  /** Capability surface disposers while the gate is on. */
  let surface = null

  function ensureManager() {
    if (manager) return manager
    manager = createLspManager({
      subprocess: ctx.subprocess,
      fs: ctx.fs,
      registry: buildRegistry(config.servers),
      options: {
        idleMs: config.idleMs ?? LSP_DEFAULTS.idleMs,
        requestTimeoutMs: config.requestTimeoutMs ?? LSP_DEFAULTS.requestTimeoutMs,
        diagnosticsWaitMs: config.diagnosticsWaitMs ?? LSP_DEFAULTS.diagnosticsWaitMs,
      },
    })
    return manager
  }

  function enableFor(agent) {
    if (enabled.has(agent.id)) return
    ensureManager()
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
    await manager?.releaseSession(agent.id)
  }

  /** Restore the session's folded state into this agent (cold resume sync). */
  function syncAgent(agent) {
    const projections = ctx.get?.('sessionProjections')
    const state = projections?.stateOf(agent.session, LSP_PROJECTION_KEY)
    if (state?.enabled === true) enableFor(agent)
  }

  /** Shared toggle for both control channels. Returns a result record. */
  async function toggleSession(agent, on) {
    if (on) {
      enableFor(agent)
    } else {
      await disableFor(agent)
    }
    return {
      kind: 'success',
      text: `LSP semantic tools ${on ? 'enabled' : 'disabled'} for this session${on ? ' (servers start lazily on first use)' : ''}.`,
    }
  }

  function setupSurface() {
    if (surface) return
    const disposers = []
    const projections = ctx.get?.('sessionProjections')
    if (projections) {
      disposers.push(
        projections.register({
          key: LSP_PROJECTION_KEY,
          stateVersion: 1,
          stateSchema: lspStateSchema,
          init: () => ({ enabled: false }),
          apply: foldLspState,
        }),
      )
    }
    disposers.push(
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
          if (args.enabled !== true && args.enabled !== false) throw new Error('lsp: enabled must be a boolean')
          await toggleSession(agent, args.enabled)
          return { enabled: args.enabled }
        },
      }),
    )
    const commands = ctx.get?.('commands')
    if (commands) {
      disposers.push(
        commands.register({
          name: 'lsp',
          description: 'Toggle LSP semantic tools for this session (on/off).',
          handler: async (invocation) => {
            const agent = invocation?.agent
            if (!agent) return { kind: 'error', text: 'lsp: requires an owning agent session' }
            const arg = String(invocation.rawInput ?? '').trim().toLowerCase()
            if (arg === 'on') return toggleSession(agent, true)
            if (arg === 'off') return toggleSession(agent, false)
            return { kind: 'error', text: 'Usage: /lsp on|off' }
          },
        }),
      )
    }
    surface = { dispose: () => disposers.forEach((dispose) => dispose?.()) }
  }

  async function teardownSurface() {
    // Snapshot everything first: a gate flip back on mid-teardown must not
    // dispose the fresh surface or its manager.
    const current = surface
    surface = null
    const previousManager = manager
    manager = null
    if (!current) return
    current.dispose()
    const agents = [...enabled.keys()].map((id) => seen.get(id)).filter(Boolean)
    for (const agent of agents) await disableFor(agent)
    await previousManager?.dispose()
  }

  /** Re-evaluate the gate and (de)register the surface accordingly. */
  function applyGate() {
    if (gate()) {
      setupSurface()
      for (const agent of seen.values()) syncAgent(agent)
    } else {
      void teardownSurface()
    }
  }

  ctx.on('agent/created', ({ agent }) => {
    seen.set(agent.id, agent)
    syncAgent(agent)
  })

  ctx.on('agent/disposed', ({ agent }) => {
    seen.delete(agent.id)
    void disableFor(agent)
  })

  // Live gate: volatile settings commits re-register the surface in place.
  const settings = ctx.get?.('orrerySettings')
  const offSettings = settings?.onChange?.(applyGate)
  applyGate()

  return () => {
    offSettings?.()
    void teardownSurface()
  }
}

export { name, inject, apply }
