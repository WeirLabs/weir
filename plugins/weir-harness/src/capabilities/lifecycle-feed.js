// Per-mount Capability Lifecycle Snapshot ownership. A live token authorizes a
// manager only when its lazy accessor returns that exact mutable manager face.
// No mount-order, process-face, preset-name, or sole-feed fallback is permitted.

/** @typedef {{ lifecycle: any, manager: (() => any) | null | undefined }} LifecycleFeedToken */
/**
 * Create an isolated registry for tests or an explicit in-process composition.
 * Registration returns an ownership-scoped, idempotent disposer.
 */
export function createLifecycleFeedRegistry() {
  /** @type {Set<LifecycleFeedToken>} */
  const tokens = new Set()
  return {
    register({ lifecycle, manager }) {
      const token = { lifecycle, manager }
      tokens.add(token)
      let live = true
      return () => {
        if (!live) return
        live = false
        tokens.delete(token)
      }
    },
    lifecycleFor(managerFace) {
      if (managerFace == null) return null
      /** @type {LifecycleFeedToken | null} */
      let owner = null
      for (const token of tokens) {
        let manager
        try {
          manager = typeof token.manager === 'function' ? token.manager() : null
        } catch {
          // A late, absent, or failing manager is denied on this adjudication.
          // Do not cache either the failure or a previous successful owner.
          continue
        }
        if (manager !== managerFace) continue
        if (owner) return null
        owner = token
      }
      return owner?.lifecycle ?? null
    },
  }
}

/** Internal module-local bridge shared by selection and manager rows. */
export const lifecycleFeedRegistry = createLifecycleFeedRegistry()
