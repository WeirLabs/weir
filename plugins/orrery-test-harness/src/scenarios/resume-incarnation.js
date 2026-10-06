// Scenario: resume-incarnation — capability-resume-incarnation-recovery
// integration (task 3.1). A host resume/fork incarnation (delegationDepth 0
// + parentSession header) must capture the parent's accepted snapshot at
// creation; an unavailable parent snapshot must block ROOT-style (never
// throw, never reject the session) and heal through an explicit Apply; an
// incarnation with its own accepted record keeps it verbatim; a
// self-referencing parentSession is no parent. Drives the REAL mounted
// lifecycle/provider through synthetic incarnation payloads.
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, lastOfRole, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'resume-incarnation'
const prompt = 'resume-incarnation-probe'

const WS = join(IT_ROOT, 'ws')

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const lastTool = lastOfRole(options, 'tool')

  if (lastTool.includes('SURFACE_PROBE error')) return textChunks(`probe halted: ${lastTool.slice(0, 300)}`)
  if (!history.includes('done seed-parent')) return toolCallChunks('surface_probe', { op: 'seedParent', sessionId: 'parent-1', names: ['fixture-a'], _marker: 'seed-parent' })
  if (!history.includes('done inc-capture')) return toolCallChunks('surface_probe', { op: 'agentCreated', sessionId: 'inc-1', parentSession: 'parent-1', _marker: 'inc-capture' })
  if (!history.includes('done view-1')) return toolCallChunks('surface_probe', { op: 'incarnationView', sessionId: 'inc-1', parentSession: 'parent-1', _marker: 'view-1' })
  if (!history.includes('done corrupt-bad')) return toolCallChunks('surface_probe', { op: 'corruptRecord', sessionId: 'parent-bad', _marker: 'corrupt-bad' })
  if (!history.includes('done inc-blocked')) return toolCallChunks('surface_probe', { op: 'agentCreated', sessionId: 'inc-2', parentSession: 'parent-bad', _marker: 'inc-blocked' })
  if (!history.includes('done view-2')) return toolCallChunks('surface_probe', { op: 'incarnationView', sessionId: 'inc-2', parentSession: 'parent-bad', _marker: 'view-2' })
  if (!history.includes('done heal-2')) return toolCallChunks('surface_probe', { op: 'seedParent', sessionId: 'inc-2', names: ['fixture-a'], _marker: 'heal-2' })
  if (!history.includes('done view-3')) return toolCallChunks('surface_probe', { op: 'incarnationView', sessionId: 'inc-2', parentSession: 'parent-bad', _marker: 'view-3' })
  if (!history.includes('done seed-3')) return toolCallChunks('surface_probe', { op: 'seedParent', sessionId: 'inc-3', names: ['fixture-a'], _marker: 'seed-3' })
  if (!history.includes('done inc-own')) return toolCallChunks('surface_probe', { op: 'agentCreated', sessionId: 'inc-3', parentSession: 'parent-1', _marker: 'inc-own' })
  if (!history.includes('done inc-self')) return toolCallChunks('surface_probe', { op: 'agentCreated', sessionId: 'inc-4', parentSession: 'inc-4', _marker: 'inc-self' })
  return textChunks('resume incarnation done')
}

function observe(obs) {
  const history = obs?.transcript ?? ''
  return {
    parentApplied: /done seed-parent:.*"status":"committed"/.test(history),
    captured: /done inc-capture:.*"thrown":null/.test(history) && /done inc-capture:.*"inherited":{"kind":"ok","skills":\["fixture-a"\]/.test(history),
    view1Resolves: /done view-1:.*"error":false/.test(history) && /done view-1:.*"fixture-a"/.test(history),
    blockedNoThrow: /done inc-blocked:.*"thrown":null/.test(history) && /done inc-blocked:.*"blocked":true/.test(history),
    view2FailClosed: /done view-2:.*"error":true/.test(history),
    healed: /done heal-2:.*"status":"committed"/.test(history) && /done view-3:.*"error":false/.test(history) && /done view-3:.*"fixture-a"/.test(history),
    ownRecordKept: /done inc-own:.*"thrown":null/.test(history) && /done inc-own:.*"inherited":{"kind":"absent"/.test(history),
    selfRefSafe: /done inc-self:.*"thrown":null/.test(history) && /done inc-self:.*"inherited":{"kind":"absent"/.test(history),
    halted: history.includes('probe halted'),
  }
}

/** Single-boot runner: clean capability state, seed fixtures pre-boot. */
async function run(ctx) {
  const caps = join(ctx.IT_ROOT, 'home', 'orrery', 'profiles', 'orrery-it', 'capabilities')
  rmSync(join(caps, 'sessions'), { recursive: true, force: true })
  const writeSkill = (root, name, marker) => {
    mkdirSync(join(root, name), { recursive: true })
    writeFileSync(join(root, name, 'SKILL.md'), `---\nname: ${name}\ndescription: Incarnation fixture ${name}\n---\nCONTENT_${marker}\n`)
  }
  writeSkill(join(ctx.IT_ROOT, 'ws', 'skill-roots'), 'fixture-a', 'A')
  const trace = join(ctx.IT_ROOT, `trace-${id}.jsonl`)
  const boot = await ctx.spawnHeadless(['orrery-it', prompt], ctx.scenarioEnv(id, trace, { ORRERY_IT_PRESET_SURFACE: '1', DSH_AGENTS_HOME: join(ctx.IT_ROOT, 'agents-home') }))
  return { scenario: id, trace, code: boot.code, stdout: boot.stdout, stderr: boot.stderr }
}

function assert(run) {
  const any = flag => run.requests.some(r => r[flag])
  run.check('the flow completed (never halted)', run.stdout.includes('resume incarnation done') && !any('halted'), run.stdout.slice(-300))
  run.check('the parent accepted record was committed', any('parentApplied'), '')
  run.check('the incarnation captured the parent snapshot at creation (never threw)', any('captured'), '')
  run.check('the incarnation view resolves the inherited set', any('view1Resolves'), '')
  run.check('an unavailable parent snapshot blocks ROOT-style: no throw, session created, blocked', any('blockedNoThrow'), '')
  run.check('the blocked incarnation fails closed with a classified reason', any('view2FailClosed'), '')
  run.check('an accepted record heals the blocked incarnation (what the Apply transaction durably writes)', any('healed'), '')
  run.check('an incarnation with its own accepted record keeps it verbatim (no capture)', any('ownRecordKept'), '')
  run.check('a self-referencing parentSession is treated as no parent', any('selfRefSafe'), '')
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, run, assert, env: { ORRERY_IT_PRESET_SURFACE: '1' } }
