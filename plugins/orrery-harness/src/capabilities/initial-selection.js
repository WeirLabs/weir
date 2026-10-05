// Task 6.5 of the session-capability-manager change: what a root Orrery
// session with NO accepted selection record gets — the initialization
// priority, resolved per session, never persisted by this path.
//
// 1. A saved workspace-default snapshot (unit { kind: 'defaults', workspaceKey })
//    wins — an EXPLICIT EMPTY default is a real choice, not a missing one.
//    Unresolved refs recorded with the default are reported, never resolved
//    by guessing.
// 2. Otherwise the explicit builtin-Skills baseline plus the managed MCP
//    identities the composition already enables. A legacy Orrery session
//    without any policy lands here too: its configured MCP is kept (this
//    path never touches MCP) and its historical content grants NOTHING —
//    no inference from past calls or the global catalog.
// 3. The gate applies to the `orrery` preset only by composition: this
//    module is mounted by the preset's own selection row, so other presets
//    are untouched by construction.

/**
 * @param {{
 *   defaultsRecord: { kind: string, payload?: unknown },
 *   builtinIdentities?: unknown[],
 *   enabledMcpIdentities?: string[],
 * }} input
 * @returns {{ source: 'workspace-default' | 'builtin-baseline',
 *   selection: { skills: unknown[], mcpServers: string[] }, missing: unknown[] }}
 */
export function resolveInitialSelection({ defaultsRecord, builtinIdentities = [], enabledMcpIdentities = [] }) {
  if (defaultsRecord && defaultsRecord.kind !== 'absent') {
    // A saved default that cannot be read fails closed exactly like a
    // selection record — it is never silently treated as missing.
    if (defaultsRecord.kind !== 'ok') throw new Error(`Workspace default selection is ${defaultsRecord.kind}`)
    const payload = /** @type {Record<string, unknown>} */ (defaultsRecord.payload ?? {})
    return {
      source: 'workspace-default',
      selection: {
        skills: Array.isArray(payload.skills) ? structuredClone(payload.skills) : [],
        mcpServers: Array.isArray(payload.mcpServers) ? /** @type {string[]} */ (payload.mcpServers).slice() : [],
      },
      missing: Array.isArray(payload.unresolvedRefs) ? payload.unresolvedRefs.slice() : [],
    }
  }
  return {
    source: 'builtin-baseline',
    selection: { skills: builtinIdentities.slice(), mcpServers: enabledMcpIdentities.slice() },
    missing: [],
  }
}
