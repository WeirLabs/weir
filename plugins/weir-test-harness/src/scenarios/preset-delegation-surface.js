// Real production declarations, with no host-mounted Weir tool mirror.
import continuable from './continuable.js'
import { textChunks, toolCallChunks } from '../mock-kit.js'

const id = 'preset-delegation-surface'
const prompt = 'continuable-probe: verify the production delegation surface'
const REQUIRED = ['delegate', 'send_message', 'interrupt_agent', 'list_agents', 'resume_agent', 'terminate_agent', 'supervised_status']
const REMOVED = ['subagent', 'subagent_fork', 'list_subagent_models', 'workflow']

function decide(options, obs) {
  if (obs.transcript.includes('SURFACE_ONESHOT_CHILD') && !obs.transcript.includes('continuable-probe')) {
    return textChunks('SURFACE_ONESHOT_OK')
  }
  if (obs.transcript.includes('continuable-probe') && !obs.transcript.includes('SURFACE_ONESHOT_OK')) {
    return toolCallChunks('delegate', {
      category: 'quick',
      prompt: 'SURFACE_ONESHOT_CHILD\nTASK: return SURFACE_ONESHOT_OK\nDELIVERABLE: marker\nSCOPE: no files\nVERIFY: exact marker\nSTOP WHEN: marker returned',
    })
  }
  return continuable.decide(options, obs)
}

function observe(obs) {
  return {
    ...continuable.observe(obs),
    oneShotResultSeen: obs.transcript.includes('continuable-probe') && obs.transcript.includes('SURFACE_ONESHOT_OK'),
    retiredGuidance: /`(?:workflow|subagent|subagent_fork|list_subagent_models)`/.test(obs.system + obs.transcript),
  }
}

async function run(driver) {
  const first = await driver.runPresetDelegationSurface({ id, prompt }, 'weir')
  const second = await driver.runPresetDelegationSurface({ id, prompt }, 'weir-creative')
  return { ...first, trace2: second.trace, code: first.code === 0 && second.code === 0 ? 0 : 1,
    stdout: first.stdout + '\n' + second.stdout, stderr: first.stderr + '\n' + second.stderr }
}

function assert(run) {
  run.check('both isolated profile runs exited cleanly', run.code === 0, run.stderr.slice(-1200))
  for (const [preset, records] of [['weir', run.records], ['weir-creative', run.records2]]) {
    const requests = records.filter(record => Array.isArray(record.emitted) && record.purpose === 'main')
    const parents = requests.filter(record => record.sawContinuableProbe)
    run.check(`${preset}: production preset selected`, records.some(record => record.kind === 'production-preset-selected' && record.preset === preset))
    const selected = records.find(record => record.kind === 'production-preset-selected' && record.preset === preset)
    run.check(`${preset}: bare host cannot rescue delegation tools`, Array.isArray(selected?.hostTools) && [...REQUIRED, ...REMOVED].every(name => !selected.hostTools.includes(name)))
    run.check(`${preset}: parent model request observed`, parents.length > 0)
    for (const name of REQUIRED) run.check(`${preset}: exposes ${name}`, parents.length > 0 && parents.every(record => record.tools.includes(name)))
    for (const name of ['compact_context', 'stop_continuation']) run.check(`${preset}: coordinated realm exposes ${name}`, parents.length > 0 && parents.every(record => record.tools.includes(name)))
    for (const name of REMOVED) run.check(`${preset}: excludes ${name}`, parents.length > 0 && parents.every(record => !record.tools.includes(name)))
    run.check(`${preset}: no retired tool guidance`, parents.length > 0 && parents.every(record => !record.retiredGuidance))
    run.check(`${preset}: one-shot delegate returned its child result`, parents.some(record => record.oneShotResultSeen))
    run.check(`${preset}: continuable delegate dispatched`, parents.some(record => record.emittedNames.includes('delegate')) && requests.some(record => record.childFirstTurnSeen))
    run.check(`${preset}: parent sent follow-up`, parents.some(record => record.emittedNames.includes('send_message')))
    run.check(`${preset}: child follow-up retained original context`, requests.some(record => record.childFollowupSeen && record.childFirstTurnSeen))
    run.check(`${preset}: both results returned to parent`, parents.some(record => record.firstResultInParentContext && record.secondResultInParentContext))
    const messages = records.filter(record => record.kind === 'session-event' && record.type === 'user/message')
    const child = messages.find(record => record.text?.startsWith('CONTINUABLE_CHILD\n'))?.session
    run.check(`${preset}: follow-up delivered to the same child session`, !!child && messages.some(record => record.session === child && record.source === 'agent-message' && record.text?.includes('CONTINUABLE_FOLLOWUP')))
    run.check(`${preset}: both built-in settlements identify that child`, !!child && ['CONTINUABLE_FIRST_RESULT', 'CONTINUABLE_SECOND_RESULT'].every(marker => messages.some(record => record.session === selected?.session && record.source === 'subagent-settled' && record.text?.startsWith(`Background subagent ${child} finished`) && record.text.includes(marker))))
  }
}

export default { id, prompt, decide, observe, run, assert }
