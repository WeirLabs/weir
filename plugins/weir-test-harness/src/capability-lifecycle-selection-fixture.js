import { createSkillSelectionPlugin, skillSelectionFor } from '../../weir-harness/src/capabilities/skill-selection-plugin.js'
import { orderState, record, snapshotSummary } from './capability-lifecycle-dual-state.js'

export const name = 'capability-lifecycle-selection-fixture'
export const inject = ['skills']

export function apply(ctx, config = {}) {
  const { orderId, presetId, root, baselineScopes } = config
  const state = orderState(orderId)
  const selection = createSkillSelectionPlugin()
  selection(ctx, {
    machineId: 'capability-lifecycle-dual-machine',
    readPresetId: presetId,
    includeDefaultRoots: false,
    customSkillDirs: [root],
    ...(baselineScopes ? { baselineScopes } : presetId === 'weir-creative' ? { baselineScopes: ['weir-builtin', 'custom'] } : {}),
  })
  const face = skillSelectionFor(ctx)
  if (!face?.lifecycle) throw new Error(`real selection lifecycle did not mount for ${presetId}`)
  const lifecycleTag = `${orderId}:${presetId}`
  state.selections.set(presetId, face)
  state.lifecycleTags.set(presetId, lifecycleTag)

  const lifecycle = face.lifecycle
  const publish = lifecycle.publish
  lifecycle.publish = function (sessionId, next) {
    const result = publish.call(this, sessionId, next)
    record(orderId, 'lifecycle-publish', { lifecycleTag, presetId, sessionId, snapshot: snapshotSummary(result) })
    return result
  }
  const snapshotFor = lifecycle.snapshotFor
  lifecycle.snapshotFor = function (sessionId) {
    try {
      const result = snapshotFor.call(this, sessionId)
      record(orderId, 'lifecycle-resolve', { lifecycleTag, presetId, sessionId, snapshot: snapshotSummary(result) })
      return result
    } catch (error) {
      record(orderId, 'lifecycle-resolve-error', { lifecycleTag, presetId, sessionId, error: String(error?.message ?? error) })
      throw error
    }
  }
  const applySelection = face.applySelection
  face.applySelection = (...args) => {
    state.applySelectionCalls += 1
    record(orderId, 'apply-selection', { presetId })
    return applySelection(...args)
  }
  record(orderId, 'selection-mounted', { presetId, lifecycleTag })
}
