// Task 8.3 of the session-capability-manager change: the last-moment
// admission check. Weir registers WRAPPED tool definitions; the check sits
// at the very head of `execute`: it synchronously reads the calling agent's
// in-memory snapshot and the current registration generation, and only then
// invokes the stock client's callTool closure — with NO unchecked await
// between the check and the handoff (the host re-resolves the registered
// object by name, EXECUTED + CITED, so the wrapper itself is what runs).
// `tools/pre-execute` is only an additional early reject, never the only
// gate. Definitions of a stale generation are always rejected.

/**
 * @param {{ identity: string, generation: number,
 *   admit: (agent: unknown) => Promise<boolean>,
 *   drain?: { enter(agentId: string, server: string, label?: string): number|null, exit(agentId: string, server: string, token: number|null): void } }} config
 */
export function createMcpToolWrapper({ identity, generation, admit, drain, assertPermit }) {
  /**
   * Wrap one tool definition with the last-moment check.
   * @param {{ name?: unknown, execute?: unknown, [key: string]: unknown }} definition
   */
  function wrap(definition) {
    if (typeof definition?.execute !== 'function') return definition
    const inner = definition.execute
    return {
      ...definition,
      /**
       * The checked execute: admit FIRST, then hand off — the only await
       * between them is the admit read itself, which the caller drives to
       * completion before any SDK activity (no unchecked interleaving).
       * With a drain attached, the handoff enters the (agent, server)
       * in-flight count; a gate closed by an accepted removal rejects here,
       * however the call was generated (8.6).
       */
      async execute(args, exec) {
        const admitted = await admit(exec?.agent)
        if (!admitted || (assertPermit && !assertPermit(admitted))) {
          const error = new Error(`MCP server "${identity}" is not enabled for this agent (admission refused at generation ${generation})`)
          throw Object.assign(error, { code: 'mcp-admission-refused' })
        }
        const label = typeof definition.name === 'string' ? definition.name : 'call'
        const token = drain ? drain.enter(exec?.agent?.id ?? exec?.agent?.session?.id, identity, label) : null
        if (drain && token === null) {
          const error = new Error(`MCP server "${identity}" is draining for this agent after an accepted removal (8.6)`)
          throw Object.assign(error, { code: 'mcp-gate-closed' })
        }
        try {
          return await inner(args, exec)
        } finally {
          if (drain) drain.exit(exec?.agent?.id ?? exec?.agent?.session?.id, identity, token)
        }
      },
    }
  }

  return { wrap }
}
