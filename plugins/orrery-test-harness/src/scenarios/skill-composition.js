import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lastOfRole, textChunks, toolCallChunks } from '../mock-kit.js'

export default ['OFF', 'LEAK', 'HOST', 'OFFICE'].map(mode => ({
  id: `skill-composition-${mode.toLowerCase()}`,
  prompt: 'Probe preset skill composition.',
  env: { ORRERY_IT_SKILL_COMPOSITION: mode },
  decide(options) { return lastOfRole(options, 'tool') ? textChunks('composition verified') : toolCallChunks('skill_composition_probe', {}) },
  observe(obs) { return { compositionProbeServed: obs.toolNames.includes('skill_composition_probe') } },
  assert(run) {
    let report
    try { report = JSON.parse(readFileSync(join(run.ws, `skill-composition-${mode.toLowerCase()}.json`), 'utf8')) } catch {}
    run.check('real preset agents.create succeeds', report?.created === 'orrery-it-selection' && !report?.roster?.broken && !report?.error, JSON.stringify(report))
    const selected = mode === 'OFFICE' ? 'office-docx' : 'selected-fixture'
    const unselected = mode === 'OFFICE' ? 'office-pptx' : 'unselected-fixture'
    const leaks = mode === 'LEAK' || mode === 'HOST'
    for (const surface of ['model', 'slash']) {
      run.check(`${surface}: selected is visible`, report?.live?.[surface]?.includes(selected), JSON.stringify(report?.live))
      for (const state of ['empty', 'live', 'cold', 'revoked']) run.check(`${state} ${surface}: unselected ${leaks ? 'leaks in control' : 'is denied'}`, report?.[state]?.[surface]?.includes(unselected) === leaks, JSON.stringify(report?.[state]))
    }
    run.check('selected loader succeeds', typeof report?.loads?.[selected]?.content === 'string', JSON.stringify(report?.loads))
    run.check('unselected loader matches composition', leaks ? typeof report?.loads?.[unselected]?.content === 'string' : report?.loads?.[unselected]?.error?.includes(mode === 'OFFICE' ? 'not available for model invocation' : 'unknown or no longer available'), JSON.stringify(report?.loads))
    run.check('real pre-step slash consumer respects selection', report?.consumer?.includes(selected) && report?.consumer?.includes(unselected) === leaks, JSON.stringify(report?.consumer))
    run.check('host-only filesystem visibility matches control', report?.global?.model?.includes('unselected-fixture') === (mode === 'HOST'), JSON.stringify(report?.global))
    run.check('catalog excludes unselected in OFF composition', leaks || (report?.catalog?.includes(selected) && !report.catalog.includes(unselected)), JSON.stringify(report?.catalog))
    if (mode === 'OFFICE') {
      run.check('all raw host Office candidates are bundled inventory entries', ['office-docx', 'office-pptx', 'office-xlsx'].every(name => report?.inventory?.some(c => c.name === name && c.provider === 'dsh-office' && c.source === 'bundled')))
      run.check('unselected Office shadow denies both invocation paths', ['office-pptx', 'office-xlsx'].every(name => report?.live?.all?.some(c => c.name === name && !c.invocation.modelInvocable && !c.invocation.userInvocable)))
      run.check('selected Office retains validated runtime suffix', /[Ll]ibre[Oo]ffice/.test(report?.loads?.[selected]?.content ?? ''))
    }
    run.check('no invalid preset diagnostic', !`${run.stdout} ${run.stderr}`.includes('agent-preset/invalid'))
    run.check('headless exits cleanly', run.code === 0 || run.code === null, `code=${run.code}`)
  },
}))
