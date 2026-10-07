// Scenario: apply-transaction — group-4 Apply transaction acceptance
// (session-capability-manager task 4.7). The in-session probe drives the real
// apply engine / skill-admission / selection-draft surfaces against the real
// capability store and selection provider; this module asserts on the probe
// report file <ws>/apply-transaction.json (the traced tool result is
// truncated at 300 chars, so the file is the assertion surface; replay-safe:
// recordRun whitelists it). Four acceptance points:
//   1. post-Apply convergence (G2c): invalidate precedes the response, the
//      new selection is visible immediately, a record-less session stays
//      empty (fail closed);
//   2. concurrent Applies on one expected revision: exactly one wins, the
//      loser gets revision-conflict, its receipt is never confirmed, and the
//      authority plus both manager-side drafts are preserved;
//   3. lost response: the original requestId query recovers the accepted
//      revision, an identical replay returns the original receipt
//      (duplicate), a changed payload under the same requestId is rejected;
//   4. after a removal Apply, stale skill references get explicit
//      unavailable from skill-admission, a not-handed-off body load never
//      runs its loader, and an in-flight load is revoked before publication.
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { lastOfRole, textChunks, toolCallChunks } from '../mock-kit.js'

const id = 'apply-transaction'
const prompt = 'apply-transaction-probe'

function decide(options) {
  const toolText = lastOfRole(options, 'tool')
  if (!toolText) return toolCallChunks('apply_transaction_probe', {})
  return textChunks('apply transaction done')
}

function observe(obs) {
  return { applyTxProbeSeen: obs.toolNames.includes('apply_transaction_probe') }
}

/** @param {unknown} value @returns {string} */
const json = value => JSON.stringify(value)

/** @param {unknown} a @param {unknown} b */
const sameNames = (a, b) => json([...(Array.isArray(a) ? a : [])].sort()) === json([...(Array.isArray(b) ? b : [])].sort())

function assert(run) {
  run.check('probe tool advertised', run.requests.some((r) => r.applyTxProbeSeen))
  const file = join(run.ws, 'apply-transaction.json')
  let report = null
  if (existsSync(file)) {
    try { report = JSON.parse(readFileSync(file, 'utf8')) } catch { /* reported below */ }
  }
  run.check('probe report written without probe error', report !== null && report.error === undefined, json(report?.error ?? 'missing or unparsable report'))
  if (report === null || report.error !== undefined) return

  // ---- 1. post-Apply convergence (G2c) + fail-closed empty session ----
  run.check('inventory complete with both fixtures parsed', report.inventory?.complete === true && report.inventory.fixtures.every((entry) => entry.status === 'parsed'), json(report.inventory))
  run.check('record-less session lists no fixture skills (fail closed)', Array.isArray(report.control?.listed) && report.control.listed.length === 0, json(report.control))
  run.check('first Apply accepted at revision 1 with fixture-a effective', report.converge?.status === 'applied' && report.converge.revision === 1 && sameNames(report.converge.effectiveNames, ['apply-fixture-a']), json(report.converge && { status: report.converge.status, revision: report.converge.revision, effectiveNames: report.converge.effectiveNames }))
  {
    const order = report.converge?.order ?? []
    const at = (event) => order.indexOf(event)
    run.check(
      'invalidate precedes fence release and the response (G2c ordering)',
      at('invalidate') !== -1 && at('invalidate') < at('fence-release') && at('fence-release') < at('response'),
      json(order),
    )
  }
  run.check('list immediately after Apply shows exactly the new selection', sameNames(report.converge?.listedAfter, ['apply-fixture-a']), json(report.converge?.listedAfter))
  run.check('authority snapshot converged to revision 1 with fixture-a', report.converge?.authority?.revision === 1 && sameNames(report.converge.authority.names, ['apply-fixture-a']), json(report.converge?.authority))
  run.check('provider reports no error after convergence', report.converge?.providerError === null, json(report.converge?.providerError))

  // ---- 2. concurrent Applies on one expected revision: exactly one wins ----
  {
    const outcomes = [report.concurrent?.add, report.concurrent?.clear]
    const winners = outcomes.filter((entry) => entry?.status === 'applied')
    const losers = outcomes.filter((entry) => entry?.status === 'rejected' && entry?.reason === 'revision-conflict')
    run.check('exactly one concurrent Apply won with applied at revision 2', winners.length === 1 && winners[0].revision === 2, json(outcomes))
    run.check('exactly one concurrent Apply lost with revision-conflict and no receipt', losers.length === 1 && losers[0].hasReceipt === false, json(outcomes))
    const winner = outcomes.find((entry) => entry === winners[0])
    run.check('winner receipt query found, loser receipt query not-found', winner === report.concurrent?.add ? report.concurrent.addReceiptQuery === 'found' && report.concurrent.clearReceiptQuery === 'not-found' : report.concurrent.clearReceiptQuery === 'found' && report.concurrent.addReceiptQuery === 'not-found', json({ add: report.concurrent?.addReceiptQuery, clear: report.concurrent?.clearReceiptQuery }))
    run.check('authority keeps the winning selection, untouched by the loser', report.concurrent?.authority?.revision === 2 && sameNames(report.concurrent.authority.names, winner?.intendedNames), json({ authority: report.concurrent?.authority, intended: winner?.intendedNames }))
    run.check('store record carries only the two accepted receipts', report.concurrent?.record?.revision === 2 && sameNames(report.concurrent.record.receipts, ['apply-tx-1', 'apply-tx-2-add', 'apply-tx-2-clear'].filter((requestId) => requestId !== (winner === report.concurrent?.add ? 'apply-tx-2-clear' : 'apply-tx-2-add'))), json(report.concurrent?.record))
    run.check('both manager-side drafts preserved (base revision and enabled sets)', report.concurrent?.drafts?.add?.baseSelectionRevision === 1 && sameNames(report.concurrent.drafts.add.enabledNames, ['apply-fixture-a', 'apply-fixture-b']) && sameNames(report.concurrent.drafts.add.appliedNames, ['apply-fixture-a']) && report.concurrent?.drafts?.clear?.baseSelectionRevision === 1 && sameNames(report.concurrent.drafts.clear.enabledNames, []) && sameNames(report.concurrent.drafts.clear.appliedNames, ['apply-fixture-a']), json(report.concurrent?.drafts))
  }

  // ---- 3. lost response: receipt query, idempotent replay, changed-payload rejection ----
  run.check('third Apply accepted at revision 3 (response then "lost")', report.lostResponse?.applied?.status === 'applied' && report.lostResponse.applied.revision === 3, json(report.lostResponse?.applied))
  run.check('receipt query by original requestId recovers the accepted revision and sets', report.lostResponse?.queried?.status === 'found' && report.lostResponse.queried.revision === 3 && report.lostResponse.queried.requestId === 'apply-tx-3' && sameNames(report.lostResponse.queried.appliedNames, ['apply-fixture-b']), json(report.lostResponse?.queried))
  run.check('same requestId + same payload replay returns the original receipt (duplicate)', report.lostResponse?.replay?.status === 'duplicate' && report.lostResponse.replay.originalReceipt === true && report.lostResponse.replay.hasReceipt === true, json(report.lostResponse?.replay))
  run.check('same requestId + changed payload rejected as request-conflict', report.lostResponse?.conflict?.status === 'rejected' && report.lostResponse.conflict.reason === 'request-conflict', json(report.lostResponse?.conflict))
  run.check('replay attempts left the record untouched (revision 3, three receipts)', report.lostResponse?.record?.revision === 3 && sameNames(report.lostResponse.record.receipts, ['apply-tx-1', 'apply-tx-2-add', 'apply-tx-3']) && sameNames(report.lostResponse.record.skillNames, ['apply-fixture-b']), json(report.lostResponse?.record))

  // ---- 4. stale references after a removal Apply are denied ----
  run.check('removal Apply accepted at revision 4 with empty selection', report.removal?.applied?.status === 'applied' && report.removal.applied.revision === 4 && sameNames(report.removal.applied.effectiveNames, []), json(report.removal?.applied))
  run.check('removed skill admission explicitly unavailable (skill-not-selected)', report.removal?.admit?.status === 'unavailable' && report.removal.admit.reason === 'skill-not-selected' && typeof report.removal.admit.message === 'string' && report.removal.admit.message.includes('apply-fixture-b') && report.removal.admit.message.includes('not selected'), json(report.removal?.admit))
  run.check('not-handed-off body load denied before the loader runs', report.removal?.loadBody?.status === 'unavailable' && report.removal.loadBody.loaderCalled === false, json(report.removal?.loadBody))
  run.check('in-flight body load revoked before publication (no content served)', report.removal?.inFlight?.status === 'revoked' && report.removal.inFlight.reason === 'selection-revoked' && report.removal.inFlight.contentServed === false, json(report.removal?.inFlight))
  run.check('not-handed-off call refused while the admission fence is held', report.removal?.fenced?.status === 'unavailable' && report.removal.fenced.reason === 'admission-fence-held', json(report.removal?.fenced))
  run.check('list after removal serves no fixture skills', Array.isArray(report.removal?.listedAfter) && report.removal.listedAfter.length === 0, json(report.removal?.listedAfter))
  run.check('authority after removal is revision 4 with empty selection', report.removal?.authority?.revision === 4 && sameNames(report.removal.authority.names, []), json(report.removal?.authority))
  run.check('host skill tool call for the removed skill fails explicitly unavailable', typeof report.removal?.skillToolError === 'string' && /no longer available|not available|unavailable/i.test(report.removal.skillToolError), json(report.removal?.skillToolError))

  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code}`)
}

export default { id, prompt, env: { WEIR_IT_APPLY_TX: '1' }, decide, observe, assert }
