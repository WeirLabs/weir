// Captures the actual Loader tree owned by each eager preset revision.
// This is dev-only evidence for the scoped MCP mount seam.
export const scopedPresetTreeCaptures = new Map()

export const name = 'scoped-preset-tree-capture'

export function apply(ctx, config = {}) {
  const entry = ctx.fiber?.entry ?? null
  const tree = entry?.parent?.tree ?? null
  const record = { ctx, entry, tree, directSubtree: entry?.subtree ?? null }
  const key = config.key ?? config.slot
  scopedPresetTreeCaptures.set(key, record)
  ctx.effect(() => () => {
    if (scopedPresetTreeCaptures.get(key) === record) scopedPresetTreeCaptures.delete(key)
  }, 'scoped-preset-tree-canary.capture')
}
