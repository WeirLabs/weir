// Host-lifetime registry of per-agent managed write scopes (change
// edit-lock-binding-self-heal, design D3).
//
// installEditLockWriteScope registers the managed write tool into the agent's
// OWN scope layer, and that layer survives a preset rebind: recompose only
// rebinds the agent's scope parent chain, it never disposes own-layer
// registrations (dsh-tools view semantics). A later setup — after a preset
// switch, a bundle re-apply, or a lazy re-bind at the write guard — must
// therefore dispose the previous generation's registration BEFORE registering,
// or the scope registry throws duplicate-registration and the re-bind dies in
// the setup catch (this is what made even a manual re-bind fail). The disposer
// cannot live in the mount closure: a preset switch orphans the whole mount
// generation while the agent and its own layer live on. Like the settings
// evidence store, the container is keyed by host root and never disposed with
// a mount; entries are keyed by agent and released at agent/disposed.

/**
 * @typedef {{ owner: object, dispose: () => void }} WriteScopeEntry
 *   `owner` is the installing mount's service object, so a reader can tell a
 *   stale foreign-generation layer apart from its own.
 */

/** @type {WeakMap<object, WeakMap<object, WriteScopeEntry>>} */
const scopesByHost = new WeakMap()

/** The host's entry store, created on first use. Weak keys isolate hosts and
 * release stopped ones; weak agent keys release disposed agents.
 * @param {object} host @returns {WeakMap<object, WriteScopeEntry>} */
export function writeScopesFor(host) {
  let scopes = scopesByHost.get(host)
  if (!scopes) {
    scopes = new WeakMap()
    scopesByHost.set(host, scopes)
  }
  return scopes
}

/** Dispose and forget the agent's previous registration, whatever generation
 * installed it: even a same-generation re-entry (a retry after a
 * half-finished setup) must not double-register. A stale layer must never
 * block re-installation, so disposal failures are swallowed.
 * @param {WeakMap<object, WriteScopeEntry>} scopes @param {object} agent */
export function disposeWriteScope(scopes, agent) {
  const entry = scopes.get(agent)
  if (!entry) return
  scopes.delete(agent)
  try { entry.dispose() } catch { /* disposal is best-effort */ }
}
