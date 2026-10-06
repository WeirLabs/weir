// Dev-only probe for the editlock-cold-view scenario. The headless profile has
// no host connection service, so the read-only Edit Lock view endpoint never
// registers there; this probe provides a CAPTURING connection (registrations
// recorded, never served) and asks the endpoint about a session that is NOT
// live in this process — the exact cold-read path the GUI panel takes for a
// restored session. Armed via ORRERY_IT_EDIT_LOCK_COLD=1; the target session
// comes from ORRERY_IT_COLD_VIEW_SESSION (the cold-read boot only).
export function installColdViewProbe(ctx, tap) {
  if (process.env.ORRERY_IT_EDIT_LOCK_COLD !== '1') return
  /** @type {Map<string, any>} */
  const routes = new Map()
  ctx.reflect.provide('connection', {
    fetch: {
      register(/** @type {any} */ definition) {
        routes.set(definition.path, definition)
        return () => { if (routes.get(definition.path) === definition) routes.delete(definition.path) }
      },
    },
  })
  const target = process.env.ORRERY_IT_COLD_VIEW_SESSION
  if (!target) return
  let asked = false
  ctx.on('agent/created', (/** @type {any} */ { agent }) => {
    if (asked || agent?.session?.header?.origin === 'subagent') return
    asked = true
    const route = routes.get('/api/orrery-edit-lock/view')
    if (!route) {
      tap({ kind: 'cold-view', session: target, error: 'view route not registered' })
      return
    }
    void (async () => {
      try {
        const response = await route.fetch({ json: async () => ({ sessionId: target }) })
        tap({ kind: 'cold-view', session: target, status: response.status, view: await response.json() })
      } catch (error) {
        tap({ kind: 'cold-view', session: target, error: String(/** @type {any} */ (error)?.message ?? error) })
      }
    })()
  })
}
