// Dev-only probe for the editlock-stale-sweep[-off] scenarios. Two duties:
//   - both variants: tap the live editLock settings section the composition's
//     sweep gate reads (evidence the gate saw the intended value);
//   - the OFF variant: overlay editLock.staleSweep=false onto the settings
//     service read path. The headless patch row cannot pass that flat key
//     without a cordis.patch.yml edit (outside this lane's write surface), so
//     the probe wraps the provided service's get() once — sections are
//     recomputed per get() in src/settings/index.js, so one wrap covers every
//     later read. Armed per process via ORRERY_IT_STALE_SWEEP=on|off.
export function installStaleSweepProbe(ctx, tap) {
  const mode = process.env.ORRERY_IT_STALE_SWEEP
  if (mode !== 'on' && mode !== 'off') return
  ctx.on('agent/created', ({ agent: created }) => {
    if (created?.session?.header?.origin === 'subagent') return
    let section = null
    try { section = ctx.get?.('orrerySettings')?.get?.('editLock') ?? null } catch (error) { section = { error: String(error?.message ?? error) } }
    tap({ kind: 'stale-sweep-settings', session: created.id, mode, section })
  })
  if (mode !== 'off') return
  const settings = ctx.get?.('orrerySettings')
  const original = settings?.get
  if (typeof original !== 'function') throw new Error('stale-sweep probe requires the orrerySettings service')
  settings.get = (key) => {
    const value = original.call(settings, key)
    return key === 'editLock' ? { ...value, staleSweep: false } : value
  }
  tap({ kind: 'stale-sweep-gate-off', patched: true })
}
