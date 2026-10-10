import { textChunks, toolCallChunks } from '../mock-kit.js'

export default {
  id: 'editlock-binding-reclaim',
  prompt: 'Run the isolated binding regression.',
  env: { WEIR_IT_BINDING_PROBE: '1', WEIR_IT_EDIT_LOCK: '1' },
  observe: obs => ({ bindingProbeSeen: obs.toolNames.includes('edit_lock_binding_probe') }),
  decide(options) {
    return options.messages?.some(message => message.role === 'tool')
      ? textChunks('Binding probe complete.')
      : toolCallChunks('edit_lock_binding_probe', {})
  },
  assert(run) {
    const report = run.records.find(record => record.kind === 'binding-probe')
    run.check('two real runtime incarnations', report?.distinctIncarnations === true, JSON.stringify(report))
    run.check('registry returns the resumed runtime identity at creation and after resume', report?.firstCreatedRegistryIsAgent === true && report?.secondCreatedRegistryIsAgent === true && report?.secondRegistryIsHandle === true && report?.secondRegistryIsSetup === true && report?.registryStillFirst === false, JSON.stringify(report))
    run.check('leaked in-process binding heals without restart', report?.healed === true, JSON.stringify(report))
    run.check('serving holder is never preempted', report?.servingRefused === true, JSON.stringify(report))
    run.check('reclaim preserves file ownership and generation', report?.locksRetained === true, JSON.stringify(report))
    run.check('managed publication works after trusted resume', report?.editingRestored === true, JSON.stringify(report))
    run.check('initial and unknown bindings refuse with read-only status', report?.initialRefused === true && report?.unknownRefused === true && report?.readOnlyFailure === true, JSON.stringify(report))
    run.check('retry preserves tool scope and starts interrupted without authority', report?.writerUnchanged === true && report?.secondState === 'interrupted' && report?.retryDidNotResume === true, JSON.stringify(report))
    run.check('publisher reservation and manager incarnation stay unchanged', report?.reservationUnchanged === true && report?.managerUnchanged === true, JSON.stringify(report))
    run.check('stale failure clears; late EOF and another session remain safe', report?.failureCleared === true && report?.continued === true && report?.otherSessionUsable === true, JSON.stringify(report))
  },
}
