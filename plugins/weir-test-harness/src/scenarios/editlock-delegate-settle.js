// A real one-shot child publishes through managed write and ends with ACTIVE
// ownership. A trusted dev-only stopping-boundary probe then holds that SAME
// ownership briefly; the parent's first tool after delegate acquires the file.
// Expiry is only a guard: no sleeps, retries, manual unlock, or child release.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, blockText, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'editlock-delegate-settle'
const prompt = `${id}-parent`
export const childPrompt = `${id}-child`
const childDone = 'DELEGATE_ACTIVE_LOCK_FINAL'
const failed = 'DELEGATE_LOCK_PROBE_STOPPED'
export const content = 'child managed write completed\n'
const target = join(IT_ROOT, 'ws', 'fixture.txt')
const authority = join(IT_ROOT, 'ws', '.weir', 'edit-lock', 'snapshot.json')

// Only local tool outputs count as results: the child prompt contains its final
// marker, and a delegate report must never count as the parent's acquire result.
function inspect(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const outputs = (obs?.messages ?? options.messages ?? [])
    .filter(message => message.role === 'tool').map(blockText)
  const role = history.includes(prompt) ? 'parent' : history.includes(childPrompt) ? 'child' : 'other'
  return {
    role,
    refused: outputs.some(text => /Edit Lock refused|already owned|owned by another|Error:/.test(text) || text.includes(failed)),
    childResultSeen: role === 'parent' && outputs.some(text => text.includes(childDone)),
    acquiredSeen: role === 'parent' && outputs.some(text => text.startsWith(`Acquired ${target}`)),
    releasedSeen: role === 'parent' && outputs.some(text => text.startsWith(`Released ${target}`)),
    readSeen: role === 'child' && outputs.some(text => /1#[A-Z]{2}\| line one/.test(text)),
    updatedSeen: role === 'child' && outputs.some(text => text.startsWith(`Updated file: ${target}`)),
    settleNoticeSeen: history.includes('Edit Lock: the turn ended while this session still held'),
  }
}

function decide(options, obs) {
  const state = inspect(options, obs)
  // Propagate failure to the parent and STOP: never re-delegate a failed child.
  if (state.refused || state.settleNoticeSeen) return textChunks(failed)
  if (state.role === 'parent') {
    if (!(obs?.messages ?? options.messages ?? []).some(message => message.role === 'tool')) return toolCallChunks('delegate', {
      category: 'quick',
      prompt: `TASK: ${childPrompt}: read existing fixture.txt, then replace it through managed write.\nDELIVERABLE: final marker ${childDone}\nSCOPE: fixture.txt only; never release its lock or use shell writes\nVERIFY: managed write succeeds\nSTOP WHEN: the final marker is sent; report ${failed} on any refusal`,
      task_summary: 'Settle child with active ownership',
    })
    if (!state.childResultSeen) return textChunks(failed)
    if (!state.acquiredSeen) return toolCallChunks('edit_lock_acquire', { file_path: target })
    if (!state.releasedSeen) return toolCallChunks('edit_lock_release', { file_path: target })
    return textChunks('parent acquired after child settlement')
  }
  if (state.role === 'child') {
    if (!state.readSeen) return toolCallChunks('read', { file_path: target })
    if (!state.updatedSeen) return toolCallChunks('write', { file_path: target, content })
    return textChunks(childDone)
  }
  return textChunks(failed)
}

function observe(obs) {
  const state = existsSync(authority) ? JSON.parse(readFileSync(authority, 'utf8'))?.payload?.state : null
  const lock = state?.locks?.find(row => row.resourceId === target) ?? null
  const { role, ...markers } = inspect({}, obs)
  return {
    lockRole: role, ...markers,
    observedAt: Date.now(),
    authorityLock: lock,
    authoritySession: state?.sessions?.find(row => row.sessionId === lock?.owner) ?? null,
    managerIncarnation: state?.managerIncarnation ?? null,
    targetContent: existsSync(target) ? readFileSync(target, 'utf8') : null,
  }
}

// A sidecar can inherit the child's prompt but has no editing tools; it must
// not enter the child tool sequence or stand in for the successful final text.
const mainRequest = (row, role, tool) => row.lockRole === role && row.purpose === 'main' && row.tools?.includes(tool)

function assert(run) {
  const child = run.created.find(row => row.origin === 'subagent' && row.depth === 1)
  const parent = run.created.find(row => row.origin !== 'subagent')
  const childRequests = run.requests.filter(row => mainRequest(row, 'child', 'write'))
  const parentRequests = run.requests.filter(row => mainRequest(row, 'parent', 'delegate'))
  const finalIndex = run.records.findIndex(row => mainRequest(row, 'child', 'write') && row.updatedSeen && !row.settleNoticeSeen && row.emittedNames?.join(',') === 'text')
  const final = run.records[finalIndex]
  const boundaryIndex = run.records.findIndex(row => row.kind === 'editlock-delegate-settle-boundary' && row.session === child?.session)
  const boundary = run.records[boundaryIndex]
  const childEnd = run.records.findIndex((row, index) => index > boundaryIndex && row.type === 'turn/end' && row.session === child?.session && row.reason === 'completed')
  const handoffIndex = run.records.findIndex((row, index) => index > childEnd && mainRequest(row, 'parent', 'delegate') && row.childResultSeen)
  const handoff = run.records[handoffIndex]
  const acquiredIndex = run.records.findIndex((row, index) => index > handoffIndex && mainRequest(row, 'parent', 'delegate') && row.acquiredSeen)
  const acquired = run.records[acquiredIndex]
  const tools = [...childRequests, ...parentRequests].flatMap(row => row.emittedNames)
  run.check('exactly one one-shot child was created and delegated', !!child && run.created.filter(row => row.origin === 'subagent').length === 1 && tools.filter(name => name === 'delegate').length === 1, JSON.stringify(run.created))
  run.check('child managed write changed the preexisting fixture', !!final && final.targetContent === content && childRequests.map(row => row.emittedNames.join(',')).join(',') === 'read,write,text', JSON.stringify(childRequests))
  run.check('child owns an active lock at its final request', !!final && final.authorityLock?.owner === child?.session && final.authorityLock?.status === 'active' && final.authoritySession?.interrupted === false, JSON.stringify(final))
  const activeAtBoundary = boundary?.error === null && boundary?.target === target && boundary?.lockBefore?.owner === child?.session && boundary.lockBefore.status === 'active' && boundary.lockBefore.generation === final?.authorityLock?.generation && boundary.lockAfter?.owner === child?.session && boundary.lockAfter.status === 'active' && boundary.lockAfter.generation === final?.authorityLock?.generation && boundary.stateAfter === 'active' && boundary.interruptedAfter === false
  const boundedHold = boundary?.holdAck?.sessionId === child?.session && boundary?.holdAck?.holding === true && boundary.holdAck.lockCount === 1 && boundary.holdAck.holdCumulativeMs === 600_000 && boundary.retention?.sessionId === child?.session && boundary.retention?.held === true && boundary.retention.expired === false && boundary.retention.remainingMs > 0 && boundary.holdAck.holdUntil === boundary.retention.holdUntil && boundary.holdAck.holdUntil > boundary.observedAt
  run.check('trusted stopping-boundary probe observed and held the same active owner', activeAtBoundary && boundedHold, JSON.stringify(boundary))
  run.check('the stopping probe ran once after final request and before completed turn', finalIndex >= 0 && boundaryIndex > finalIndex && final.observedAt <= boundary.observedAt && run.records.filter(row => row.kind === 'editlock-delegate-settle-boundary').length === 1 && childEnd > boundaryIndex && handoffIndex > childEnd && !run.records.slice(finalIndex + 1, boundaryIndex).some(row => row.type === 'turn/end' && row.session === child?.session), `final=${finalIndex} boundary=${boundaryIndex} childEnd=${childEnd} handoff=${handoffIndex}`)
  run.check('child never released or received a turn-end cleanup notice', childRequests.every(row => !row.settleNoticeSeen && !row.emittedNames.includes('edit_lock_release')) && !run.records.some(row => row.session === child?.session && /Edit Lock:.*(turn ended|released for other sessions|reservation ended)/.test(row.text ?? '')), JSON.stringify(childRequests.map(row => row.emittedNames)))
  run.check('parent first post-delegate tool acquires without a retry', handoff?.emittedNames?.join(',') === 'edit_lock_acquire' && handoff.authorityLock === null && parentRequests.filter(row => row.emittedNames.includes('edit_lock_acquire')).length === 1, JSON.stringify(handoff))
  run.check('parent obtains the next active generation before retention expiry', !!acquired && acquiredIndex > handoffIndex && acquired.acquiredSeen && !acquired.refused && acquired.observedAt < boundary?.holdAck?.holdUntil && acquired.authorityLock?.owner === parent?.session && acquired.authorityLock?.status === 'active' && acquired.authorityLock?.generation === final?.authorityLock?.generation + 1, JSON.stringify(acquired))
  run.check('handoff preserves file and authority incarnation', !!acquired && !!final && acquired.targetContent === content && acquired.managerIncarnation === final.managerIncarnation && typeof final.managerIncarnation === 'string', JSON.stringify({ final, acquired }))
  run.check('no manual unlock, wait, extra write or child owner tool was used or exposed', childRequests.every(row => ['edit_lock_acquire', 'edit_lock_hold', 'edit_lock_release'].every(name => !row.tools.includes(name))) && tools.filter(name => name === 'write').length === 1 && tools.filter(name => name === 'edit_lock_acquire').length === 1 && tools.filter(name => name === 'edit_lock_release').length === 1 && tools.every(name => ['delegate', 'read', 'write', 'edit_lock_acquire', 'edit_lock_release', 'text'].includes(name)), JSON.stringify(tools))
  run.check('parent cleaned up and reported success', run.stdout.includes('parent acquired after child settlement') && parentRequests.some(row => row.releasedSeen && row.authorityLock === null), run.stdout.slice(-500))
  run.check('headless run exited cleanly', run.code === 0, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, env: { WEIR_IT_EDIT_LOCK: '1' }, decide, observe, assert }
