// Invalidation re-emission of the session capability manager (task 5.2).
//
// SEMANTIC STRETCH (accepted, G2c): the host event `agent-preset/selected`
// originally means "this session submitted a different agent preset". The
// host command directory (dsh-client-ui-commands) and the skill catalog
// (dsh-client-ui-skill) both refetch their per-session lists when it fires.
// The capability manager reuses exactly that broadcast as its invalidation
// signal: after an Apply is accepted, and when a root orrery-preset session's
// agent is created, clients must re-pull the command/skill lists. No new
// event type is registered — this is the ONLY added emission.
//
// Hard contract:
// - every emission is wrapped in try/catch; a failed emission is a warning,
//   never a broken agent/created dispatch or a changed Apply result;
// - both arguments must be strings (non-strings are dropped, never emitted);
// - the second argument is the session's ACTUAL preset id (read from the
//   live session projection), never a constant;
// - NEVER session.append (cold-read red line) and NEVER a direct
//   agents.resume call — plugin-initiated resume is not needed here.

/** The one host event this change emits. */
export const PRESET_SELECTED_EVENT = 'agent-preset/selected'

const text = value => typeof value === 'string' && value.length > 0

/**
 * Emit the invalidation broadcast with validated arguments. Returns whether
 * the emission happened. Emission failures are caught and reported through
 * `warn`; they never propagate.
 * @param {(event: string, sessionId: string, presetId: string) => void} emit
 * @param {unknown} sessionId @param {unknown} presetId
 * @param {(message: string) => void} [warn]
 * @returns {boolean}
 */
export function emitPresetSelected(emit, sessionId, presetId, warn = () => {}) {
  if (!text(sessionId) || !text(presetId)) return false
  try {
    emit(PRESET_SELECTED_EVENT, sessionId, presetId)
    return true
  } catch (error) {
    warn(`preset invalidation emit failed: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
}

/**
 * Watch agent/created and re-emit the invalidation for ROOT sessions only
 * (delegationDepth 0 — the same root marker the worktree-mode guard uses;
 * G2c argues root sessions only, never any subagent). The plugin row lives
 * inside the orrery preset, so the listener exists only for orrery-preset
 * contexts. agent/created fires after the agent entered the registry.
 *
 * The listener is dispatched SERIALLY by the host and a rejection would
 * reject the agent's creation — the body is therefore fully guarded and
 * never throws.
 *
 * @param {{
 *   emit: (event: string, sessionId: string, presetId: string) => void,
 *   projections?: () => { stateOf(session: unknown, key: string) => unknown } | undefined,
 *   warn?: (message: string) => void,
 * }} options
 * @returns {{ agentCreated(payload: { agent?: unknown }): boolean }}
 */
export function createPresetInvalidation({ emit, projections = () => undefined, warn = () => {} }) {
  return {
    /** @param {{ agent?: any }} payload @returns {boolean} whether an emission happened */
    agentCreated(payload) {
      try {
        const agent = payload?.agent
        const session = agent?.session
        if (!session) return false
        // Root sessions only: subagents (delegationDepth > 0) never re-emit.
        if ((session.header?.delegationDepth ?? 0) !== 0) return false
        // The session's ACTUAL preset id from the live projection — never a constant.
        const presetId = projections()?.stateOf(session, 'agentPreset')
        return emitPresetSelected(emit, session.id, presetId, warn)
      } catch (error) {
        warn(`preset invalidation listener failed: ${error instanceof Error ? error.message : String(error)}`)
        return false
      }
    },
  }
}
