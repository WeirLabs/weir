// Installed-runtime negotiation: one QA-controlled Host delivery throw, not a
// network outage. A second real Agent calls the real try_steal tool while the
// original owner is busy in the QA tool; the production 120s timer runs intact.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, blockText, textChunks, toolCallChunks } from '../mock-kit.js'

const id = 'editlock-negotiation'
const prompt = `${id}-owner`
const target = join(IT_ROOT, 'ws', 'negotiation-target.txt')
const content = 'controlled negotiation owner bytes\n'

function decide(options) {
  const outputs = (options.messages ?? []).filter(message => message.role === 'tool').map(blockText)
  if (!outputs.some(text => text.startsWith(`Created file: ${target}`))) {
    if (outputs.length) return textChunks('NEGOTIATION_OWNER_WRITE_FAILED')
    return toolCallChunks('write', { file_path: target, content })
  }
  if (!outputs.some(text => text.includes('QA_NEGOTIATION_FINISHED'))) return toolCallChunks('qa_editlock_negotiation', {})
  return textChunks('NEGOTIATION_OWNER_COMPLETE')
}

function observe(obs) {
  return { editLockToolsSeen: obs.toolNames.includes('edit_lock_try_steal') }
}
function assert(run) {
  const reports = run.records.filter(record => record.kind === 'qa-editlock-negotiation')
  const report = reports[0]
  const lock = state => state?.locks?.find(row => row.resourceId === target)
  const before = lock(report?.before)
  const pending = lock(report?.pending)
  const after = lock(report?.after)
  const owner = run.created.find(row => row.origin !== 'subagent')?.session
  const ownerSession = state => state?.sessions?.find(row => row.sessionId === owner)
  const requester = report?.requester
  const requestId = report?.requestId
  const detail = JSON.stringify({ requestId, requester, owner, toolError: report?.toolError, method: report?.method, busyStatus: report?.busyStatus, attempts: report?.attempts, triggerCount: report?.triggerCount, replyDelivered: report?.replyDelivered, elapsedMs: report?.elapsedMs, expiryNotice: report?.expiryNotice, before, pending, after, reservationBefore: report?.reservationBefore, reservationPending: report?.reservationPending, reservationAfter: report?.reservationAfter })
  run.check('QA fixture and real negotiation tool advertised', run.requests.some(row => row.editLockToolsSeen && row.tools?.includes('qa_editlock_negotiation')), '')
  run.check('one real requester and nonempty requestId from the try_steal tool', reports.length === 1 && !!requester && requester !== owner && /^steal-[0-9a-f-]{36}$/.test(requestId ?? '') && report?.toolError === null && report?.holder === owner && report?.holderStatus === 'active', detail)
  run.check('controlled Host delivery injection threw exactly once for the busy owner', report?.triggerCount === 1 && report?.attempts === 1 && report?.method === 'inject' && report?.busyStatus === 'running' && !report?.replyDelivered && report?.restored === true, detail)
  run.check('the real 120-second timeout expired without a holder reply', report?.elapsedMs >= 120_000 && report?.expiryNotice?.includes(requestId) && report?.expiryNotice?.includes('expired without a holder reply'), detail)
  run.check('original non-revoked holder, generation, incarnation and bytes survive request and expiry', !!before && before.owner === owner && before.status === 'active' && Number.isSafeInteger(before.generation) && JSON.stringify(before) === JSON.stringify(pending) && JSON.stringify(before) === JSON.stringify(after) && ownerSession(report?.before)?.interrupted === false && ownerSession(report?.pending)?.interrupted === false && ownerSession(report?.after)?.interrupted === false && ownerSession(report?.before)?.executionEpoch === ownerSession(report?.after)?.executionEpoch && report?.after?.locks?.every(row => row.owner !== requester) && report?.before?.managerIncarnation === report?.after?.managerIncarnation && report?.bytesBefore === content && report?.bytesPending === content && report?.bytesAfter === content && existsSync(join(run.ws, 'negotiation-target.txt')) && readFileSync(join(run.ws, 'negotiation-target.txt'), 'utf8') === content, detail)
  run.check('publisher reservation never deleted to simulate failed delivery', report?.reservationBefore === true && report?.reservationPending === true && report?.reservationAfter === true && report?.holderStillLive === true, detail)
  run.check('installed CLI completed the scoped QA run', run.code === 0 && run.stdout.includes('NEGOTIATION_OWNER_COMPLETE'), `code=${run.code} stderr=${run.stderr.slice(-500)}`)
}

export default { id, prompt, env: { WEIR_IT_EDIT_LOCK: '1' }, decide, observe, assert }
