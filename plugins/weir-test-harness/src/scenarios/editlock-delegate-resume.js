// R2 installed-CLI reproduction: supervised user interruption -> explicit resume.
// Self-contained: the child's first managed write CREATES a scenario-private file
// under the fresh per-invocation workspace, so this scenario never depends on (or
// mutates) a fixture another scenario already rewrote in the same invocation.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, blockText, lastOfRole, textChunks, toolCallChunks, transcript, waitForMarker } from '../mock-kit.js'
const id = 'editlock-delegate-resume'
const prompt = `${id}-parent`
export const childPrompt = `${id}-child`
export const target = join(IT_ROOT, 'ws', 'fixture.txt')
// Scenario-private target of the interrupted first managed write in epoch 1.
// Absent at every run start (setup() recreates the workspace), so the write is
// a genuine creation and no other scenario can pre-alter it.
export const firstTarget = join(IT_ROOT, 'ws', 'resumed-first.txt')
export const freshTarget = join(IT_ROOT, 'ws', 'resumed-new.txt')
export const firstContent = 'first child managed write\n'
const freshContent = 'same child resumed managed write\n'
const done = 'R2_RESUMED_WRITE_DONE'
const failed = 'R2_EDIT_REFUSED_STOP'
// A first managed write that never landed must fail loudly, never re-loop the child.
const missed = 'R2_FIRST_WRITE_MISSING'
const blocked = 'was stopped before it finished.'
// A write call for firstTarget that left no publication behind is the loud-stop
// signal. It must never re-trip after the interrupt: the interrupted epoch leaves
// the attempted call in history for the rest of this child's durable session.
function firstWriteTried(history) {
  return history.includes(JSON.stringify({ file_path: firstTarget, content: firstContent }))
}
// The write result text distinguishes a create from an update; the last tool
// message is the fallback when a caller hands us only the transcript.
function managedWriteText(options) {
  const messages = options?.messages ?? []
  const outputs = messages.filter(message => message.role === 'tool').map(blockText)
  return outputs.length > 0 ? outputs.join('\n') : lastOfRole(options ?? {}, 'tool')
}
function inspect(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const outputs = (obs?.messages ?? options.messages ?? []).filter(m => m.role === 'tool').map(blockText)
  const writes = managedWriteText(options)
  return { history, outputs, role: history.includes(prompt) ? 'parent' : history.includes(childPrompt) ? 'child' : 'other',
    refused: outputs.some(t => /Edit Lock refused|editing stopped|unmanaged file mutation refused|Error:/.test(t)),
    resumed: history.includes('Your parent cleared your blocker'),
    firstWritten: writes.includes(`Created file: ${firstTarget}`) || writes.includes(`Wrote file: ${firstTarget}`),
    firstTried: firstWriteTried(history),
    freshWritten: writes.includes(`Created file: ${freshTarget}`) || writes.includes(`Wrote file: ${freshTarget}`),
  }
}
function decide(options, obs) {
  const s = inspect(options, obs)
  if (s.refused || s.history.includes(failed)) return textChunks(`STATUS: blocked\nREPORT: ${failed}`)
  if (s.role === 'child') {
    if (s.resumed) {
      if (s.freshWritten) return textChunks(`STATUS: completed\nREPORT: ${done}`)
      if (s.firstTried && !s.firstWritten) return textChunks(`STATUS: blocked\nREPORT: ${missed}`)
      return toolCallChunks('write', { file_path: freshTarget, content: freshContent })
    }
    if (s.firstWritten) return textChunks(`STATUS: completed\nREPORT: ${done}`)
    if (s.firstTried && !s.firstWritten) return textChunks(`STATUS: blocked\nREPORT: ${missed}`)
    return toolCallChunks('write', { file_path: firstTarget, content: firstContent })
  }
  if (s.role !== 'parent') return textChunks(failed)
  if (!s.outputs.length) return toolCallChunks('delegate', {
    group: 'r2-resume', tasks: [{ category: 'quick', name: 'r2-child', prompt: `TASK: ${childPrompt}: create the new file resumed-first.txt through managed write; after explicit resume create resumed-new.txt. Never touch fixture.txt or any other scenario's file.\nDELIVERABLE: managed publication\nSCOPE: these two new files only; no shell mutation or owner tools\nVERIFY: both managed writes succeed\nSTOP WHEN: completed or first refusal` }],
  })
  if (s.history.includes(done)) return textChunks('parent observed R2 resumed completion')
  if (s.outputs.some(t => t.includes('Resumed supervised child'))) {
    const wait = waitForMarker(s.history, done)
    return wait.state === 'wait' ? wait.chunks : textChunks('R2 completion wait exhausted')
  }
  if (s.history.includes(blocked)) {
    if (!s.outputs.some(t => t.startsWith('Supervised registry') && t.includes('— blocked —'))) return toolCallChunks('supervised_status', {})
    return toolCallChunks('resume_agent', { agent: 'r2-child', context: 'R2 explicit continue: write the different new file now.' })
  }
  const wait = waitForMarker(s.history, blocked)
  return wait.state === 'wait' ? wait.chunks : textChunks('R2 blocked wait exhausted')
}
function observe(obs) {
  const s = inspect({}, obs)
  const file = join(IT_ROOT, 'ws/.weir/edit-lock/snapshot.json')
  const state = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).payload.state : null
  // The interrupted publication's content needs no extra observation key: the
  // probe taps `resume-interrupt-before` only after firstTarget reads back as
  // firstContent under the child's active ownership.
  return { lockRole: s.role, refused: s.refused, resumed: s.resumed,
    authorityLocks: state?.locks ?? [], authoritySessions: state?.sessions ?? [],
    freshContent: existsSync(freshTarget) ? readFileSync(freshTarget, 'utf8') : null }
}
function assert(run) {
  const records = run.records
  const before = records.find(r => r.kind === 'resume-interrupt-before')
  const child = before?.session
  const tools = records.filter(r => r.kind === 'resume-tool-result')
  const resume = tools.find(r => r.name === 'resume_agent')
  const fresh = tools.find(r => r.session === child && r.name === 'write' && r.args?.file_path === freshTarget)
  const requests = run.requests.filter(r => r.purpose === 'main')
  const interrupted = requests.find(r => r.authorityLocks?.some(l => l.owner === child && l.status === 'user-interrupted'))
  const renewed = requests.find(r => r.lockRole === 'child' && r.resumed && r.authoritySessions?.some(s => s.sessionId === child && s.executionEpoch > interrupted?.authoritySessions?.find(s => s.sessionId === child)?.executionEpoch && !s.interrupted))
  const resumeIndex = records.indexOf(resume)
  const precedesResume = predicate => records.some((row, index) => index < resumeIndex && predicate(row))
  run.check('one supervised child session and one designated user interrupt', !!child && new Set(run.created.filter(r => r.origin === 'subagent').map(r => r.session)).size === 1 && records.filter(r => r.kind === 'resume-interrupt-issued').length === 1, JSON.stringify(before))
  // The interrupted publication's content is already proven by the probe gate:
  // `resume-interrupt-before` is tapped only after firstTarget reads back as
  // firstContent under the child's active ownership.
  run.check('successful initial managed write owned active authority before interrupt', !!before && before.lock?.owner === child && before.lock.status === 'active' && before.lock.resourceId === firstTarget && before.authoritySession?.interrupted === false && before.continuationBlocked === false, JSON.stringify(before))
  run.check('child ended user-aborted and retained user-interrupted lock with advanced epoch', records.some(r => r.kind === 'resume-child-turn-end' && r.reason?.kind === 'aborted' && r.reason.reason?.kind === 'user') && !!interrupted && interrupted.authoritySessions.some(s => s.sessionId === child && s.executionEpoch > before?.authoritySession?.executionEpoch), JSON.stringify(interrupted))
  run.check('blocked supervision fact and built-in notice precede explicit resume', precedesResume(r => r.type === 'weir/supervision/settle' && r.data?.childId === child && r.data.status === 'blocked') && precedesResume(r => r.source === 'subagent-settled' && r.text?.includes(blocked)) && precedesResume(r => r.kind === 'resume-tool-result' && r.name === 'supervised_status' && r.text.includes('— blocked —')) && !!resume && !resume.isError, JSON.stringify(resume))
  run.check('resume tool fact exists without generic send or redelegation', records.some(r => r.type === 'weir/supervision/resume' && r.data?.childId === child) && tools.filter(r => r.name === 'delegate').length === 1 && !tools.some(r => r.name === 'send_message'), JSON.stringify(tools.map(r => r.name)))
  run.check('R2: same resumed child can managed-write a different NEW file', !!fresh && !fresh.isError && fresh.text.startsWith(`Created file: ${freshTarget}`) && records.indexOf(fresh) > records.indexOf(resume), JSON.stringify(fresh))
  const interruptedFirst = interrupted?.authorityLocks.find(l => l.owner === child && l.resourceId === firstTarget)
  const pendingFirst = renewed?.authorityLocks.find(l => l.owner === child && l.resourceId === firstTarget)
  run.check('resumed child receives a new epoch and old file remains pending confirmation', !!renewed && interruptedFirst?.status === 'user-interrupted' && pendingFirst?.status === 'pending-confirmation' && pendingFirst.generation >= interruptedFirst.generation, JSON.stringify(requests.filter(r => r.lockRole === 'child' && r.resumed)))
  run.check('child owner tools stay hidden', requests.filter(r => r.lockRole === 'child').every(r => !r.tools?.some(t => ['edit_lock_acquire', 'edit_lock_release', 'edit_lock_hold'].includes(t))), '')
  run.check('terminal completed report follows new publication', records.some((r, index) => index > records.indexOf(fresh) && r.type === 'weir/supervision/settle' && r.data?.childId === child && r.data.status === 'completed' && r.data.report.includes(done)) && requests.some(r => r.freshContent === freshContent) && run.stdout.includes('parent observed R2 resumed completion'), run.stdout.slice(-500))
  run.check('headless exits cleanly', run.code === 0, run.stderr.slice(-500))
}
export default { id, prompt, env: { WEIR_IT_EDIT_LOCK: '1' }, decide, observe, assert }
