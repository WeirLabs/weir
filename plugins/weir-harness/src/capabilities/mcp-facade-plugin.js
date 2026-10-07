// Task 8.2 of the session-capability-manager change: the cordis plugin form
// of the proxy facade, imported by the loader INSIDE each server's isolated
// group (referenced by the package export name, never statically by the
// mount). The outer side hands host services and the admission closures
// through the module-level realm bridge below — both sides are the same
// bundle module instance, so the bridge never crosses a process boundary.
import { createMcpFacade } from './mcp-facade.js'

/**
 * The realm bridge: groupId → { host, identity, generation, admit,
 * isEnabledFor, onError }. Written by the outer mount BEFORE loader.create,
 * read by the facade plugin as it mounts inside the group, deleted when the
 * group is removed.
 */
const bridge = new Map()

export function registerMcpFacadeBridge(groupId, payload) {
  bridge.set(groupId, payload)
  return () => bridge.delete(groupId)
}

export function mcpFacadeBridgeFor(groupId) {
  return bridge.get(groupId) ?? null
}

export const name = 'weir-mcp-facade'

export function apply(ctx, config = {}) {
  const groupId = ctx.fiber?.entry?.parent?.data?.id ?? config.group ?? null
  const payload = (groupId && mcpFacadeBridgeFor(groupId)) || (config.identity ? config : null)
  if (!payload) {
    // Fail closed and visible: a facade without its bridge must not pass
    // anything through unfiltered.
    ctx.logger?.warn?.(`weir MCP facade mounted without a realm bridge (group ${groupId ?? 'unknown'}); this server stays unavailable`)
    return
  }
  const facade = createMcpFacade(payload)
  ctx.reflect.provide('tools', facade.tools)
  ctx.reflect.provide('systemPrompt', facade.systemPrompt)
  ctx.reflect.provide('mcpResources', facade.mcpResources)
}
