// Apply-transaction integration probe for the `apply-transaction` scenario
// (session-capability-manager task 4.7): mounts the real skill-selection
// plugin against fixture-only roots, then drives the group-4 Apply
// transaction surfaces in-process inside the headless session —
//   1. one draft-driven Apply through the real apply engine, proving the
//      post-Apply list/authority converge before the response (G2c) and a
//      record-less session stays empty (fail closed);
//   2. two concurrent Applies on one expected revision — exactly one wins,
//      the loser gets revision-conflict, no receipt, authority/drafts kept;
//   3. a "lost response" recovered by receipt query, an idempotent replay
//      returning the original receipt, and a changed-payload replay rejected;
//   4. stale references after a removal Apply denied by skill-admission,
//      including an in-flight body load revoked before publication.
// The full report lands in <ws>/apply-transaction.json (the traced tool
// result is truncated at 300 chars, so the file is the assertion surface);
// the tool result text is only the short marker the mock LLM advances on.
// Enabled only when WEIR_IT_APPLY_TX=1. Dev-only.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openCapabilityStore } from '../../weir-harness/src/capabilities/store/store.js'
import * as selectionPlugin from '../../weir-harness/src/capabilities/skill-selection-plugin.js'
import { createApplyEngine } from '../../weir-harness/src/capabilities/apply-engine.js'
import { createSkillAdmission } from '../../weir-harness/src/capabilities/skill-admission.js'
import { createSelectionDraft } from '../../weir-harness/src/capabilities/selection-draft.js'
import { IT_ROOT } from './mock-kit.js'

const name = 'weir-it-apply-transaction-probe'
const inject = ['tools', 'skills']

const FIXTURES = ['apply-fixture-a', 'apply-fixture-b']

/** @param {unknown} skills @returns {(string|null)[]} */
const namesOf = skills => (Array.isArray(skills) ? skills : []).map(identity => identity?.name ?? null)

/** @param {unknown} result */
function outcomeOf(result) {
  const value = result ?? {}
  return {
    status: value.status ?? null,
    reason: value.reason ?? null,
    revision: value.revision ?? null,
    hasReceipt: value.receipt != null,
    effectiveNames: namesOf(value.effective?.skills),
  }
}

/** @param {any} ctx @param {{ enabled?: boolean }} config */
function apply(ctx, config = {}) {
  if (config.enabled !== true) return
  // The static weir-skill-selection row is disabled for this scenario; the
  // probe mounts the real plugin against the fixture roots so inventory,
  // provider invalidation and ctx.skills.list are the production code paths.
  selectionPlugin.apply(ctx, {
    machineId: 'weir-it-machine',
    includeDefaultRoots: false,
    customSkillDirs: [join(IT_ROOT, 'ws', 'skill-roots')],
  })
  ctx.tools.register({
    name: 'apply_transaction_probe',
    description: 'Integration probe: drive the group-4 Apply transaction surfaces (convergence, concurrency, receipt recovery, removal denial) in-process.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: `APPLY_TX_PROBE ${value.completed ? 'done' : 'error'}` }],
    },
    async execute(_args, exec) {
      const report = { scenario: 'apply-transaction' }
      try {
        const root = join(IT_ROOT, 'ws', 'skill-roots')
        for (const skill of FIXTURES) {
          mkdirSync(join(root, skill), { recursive: true })
          writeFileSync(join(root, skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: Apply transaction fixture ${skill}\n---\nCONTENT_${skill}\n`)
        }
        const sessionId = exec.agent?.session?.id
        const cwd = exec.agent?.session?.header?.cwd ?? join(IT_ROOT, 'ws')
        if (typeof sessionId !== 'string') throw new Error('probe session unavailable')
        const authSession = { sessionId, cwd }
        const lookup = { cwd, scope: { session: { id: sessionId } } }
        const store = openCapabilityStore({ profileContext: ctx.get('profileContext') })
        const selection = selectionPlugin.skillSelectionFor(ctx)
        if (!selection) throw new Error('skill selection plugin not mounted')
        /** @type {string[]} */
        const traceEvents = []
        const engine = createApplyEngine({
          store,
          locateSession: async session => session,
          inventory: options => selection.inventory(options),
          provider: selection.provider,
          trace: event => traceEvents.push(event),
        })
        const admission = createSkillAdmission({ authority: engine.authority, fence: engine.fence })
        const readRecord = async () => {
          const record = await store.read({ kind: 'selection', sessionId })
          return record.kind === 'ok'
            ? { kind: record.kind, revision: record.revision, receipts: record.receipts.map(entry => entry.requestId), skillNames: namesOf(record.payload?.skills) }
            : { kind: record.kind }
        }
        const listedFixtureNames = async options => (await ctx.skills.list(options)).map(skill => skill.name).filter(skillName => FIXTURES.includes(skillName))

        // Inventory precondition: both fixtures discovered as parsed candidates.
        const inventory = await selection.inventory(lookup)
        const candidates = new Map(inventory.candidates.filter(candidate => FIXTURES.includes(candidate.name)).map(candidate => [candidate.name, candidate]))
        report.inventory = {
          complete: inventory.complete === true,
          fixtures: FIXTURES.map(skill => ({ name: skill, status: candidates.get(skill)?.status ?? null })),
        }
        const identityA = candidates.get('apply-fixture-a')?.identity
        const identityB = candidates.get('apply-fixture-b')?.identity
        if (!identityA || !identityB) throw new Error('fixture identities missing from inventory')

        // ---- 1. post-Apply convergence (G2c) + fail-closed empty session ----
        report.control = { listed: await listedFixtureNames({ cwd, scope: { session: { id: `${sessionId}-control` } } }) }
        const draft = createSelectionDraft({ baseRevision: 0, applied: { skills: [], mcpServers: [] } })
        draft.toggle(identityA, true)
        traceEvents.length = 0
        const first = await engine.apply(authSession, { requestId: 'apply-tx-1', ...draft.toApplyPayload() })
        const firstAuthority = engine.authority(sessionId)
        report.converge = {
          ...outcomeOf(first),
          order: traceEvents.slice(),
          listedAfter: await listedFixtureNames(lookup),
          authority: firstAuthority ? { revision: firstAuthority.revision, names: namesOf(firstAuthority.selection?.skills) } : null,
          providerError: selection.provider.status(lookup).error,
        }

        // ---- 2. concurrent Applies on one expected revision: exactly one wins ----
        const draftAdd = createSelectionDraft({ baseRevision: 1, applied: { skills: [identityA], mcpServers: [] } })
        draftAdd.toggle(identityB, true)
        const draftClear = createSelectionDraft({ baseRevision: 1, applied: { skills: [identityA], mcpServers: [] } })
        draftClear.toggle(identityA, false)
        const [racedAdd, racedClear] = await Promise.all([
          engine.apply(authSession, { requestId: 'apply-tx-2-add', ...draftAdd.toApplyPayload() }),
          engine.apply(authSession, { requestId: 'apply-tx-2-clear', ...draftClear.toApplyPayload() }),
        ])
        const secondAuthority = engine.authority(sessionId)
        const clearQuery = await engine.queryReceipt(authSession, 'apply-tx-2-clear')
        const addQuery = await engine.queryReceipt(authSession, 'apply-tx-2-add')
        report.concurrent = {
          add: { ...outcomeOf(racedAdd), intendedNames: namesOf(draftAdd.enabled.skills) },
          clear: { ...outcomeOf(racedClear), intendedNames: namesOf(draftClear.enabled.skills) },
          addReceiptQuery: addQuery.status,
          clearReceiptQuery: clearQuery.status,
          authority: secondAuthority ? { revision: secondAuthority.revision, names: namesOf(secondAuthority.selection?.skills) } : null,
          record: await readRecord(),
          drafts: {
            add: { baseSelectionRevision: draftAdd.baseSelectionRevision, enabledNames: namesOf(draftAdd.enabled.skills), appliedNames: namesOf(draftAdd.applied.skills) },
            clear: { baseSelectionRevision: draftClear.baseSelectionRevision, enabledNames: namesOf(draftClear.enabled.skills), appliedNames: namesOf(draftClear.applied.skills) },
          },
        }

        // ---- 3. lost response: receipt query recovers acceptance; replay semantics ----
        const third = await engine.apply(authSession, { requestId: 'apply-tx-3', expectedRevision: 2, selection: { skills: [identityB], mcpServers: [] } })
        // The response is "lost" here: the client keeps only the requestId and
        // enters result-pending-confirmation, querying instead of retrying blind.
        const queried = await engine.queryReceipt(authSession, 'apply-tx-3')
        const replayed = await engine.apply(authSession, { requestId: 'apply-tx-3', expectedRevision: 2, selection: { skills: [identityB], mcpServers: [] } })
        const conflicted = await engine.apply(authSession, { requestId: 'apply-tx-3', expectedRevision: 2, selection: { skills: [identityA, identityB], mcpServers: [] } })
        const thirdReceipt = third.receipt ?? {}
        const replayReceipt = replayed.receipt ?? {}
        report.lostResponse = {
          applied: outcomeOf(third),
          queried: queried.status === 'found'
            ? { status: queried.status, revision: queried.revision, requestId: queried.receipt?.requestId ?? null, appliedNames: namesOf(queried.applied?.skills) }
            : { status: queried.status },
          replay: { ...outcomeOf(replayed), originalReceipt: replayReceipt.requestId === thirdReceipt.requestId && replayReceipt.revision === thirdReceipt.revision },
          conflict: outcomeOf(conflicted),
          record: await readRecord(),
        }

        // ---- 4. stale references after a removal Apply are denied ----
        // An admitted (handed-off) body load is still in flight when the
        // removal commits: publication must be revoked before content returns.
        let releaseGate = () => {}
        const gate = new Promise(resolve => { releaseGate = resolve })
        let inFlightServed = false
        const inFlight = admission.loadBody(sessionId, identityB, async () => {
          await gate
          return 'CONTENT_apply-fixture-b'
        }).then(result => {
          inFlightServed = result.status === 'loaded'
          return result
        })
        const removal = await engine.apply(authSession, { requestId: 'apply-tx-4', expectedRevision: 3, selection: { skills: [], mcpServers: [] } })
        releaseGate()
        const inFlightResult = await inFlight
        // A not-handed-off load after removal: denied before the loader runs.
        let deniedLoaderCalled = false
        const deniedLoad = await admission.loadBody(sessionId, identityB, async () => {
          deniedLoaderCalled = true
          return 'CONTENT_apply-fixture-b'
        })
        const deniedAdmit = await admission.admit(sessionId, identityB)
        // While the admission fence is held, not-yet-handed-off calls are refused.
        const lease = engine.fence.enter(sessionId)
        const fenced = await admission.admit(sessionId, identityB)
        lease.release()
        let skillToolError = null
        try {
          const skillTool = ctx.tools.get('skill', exec.agent)
          await skillTool.execute({ name: 'apply-fixture-b' }, { ...exec, agent: exec.agent })
        } catch (error) {
          skillToolError = error instanceof Error ? error.message : String(error)
        }
        const lastAuthority = engine.authority(sessionId)
        report.removal = {
          applied: outcomeOf(removal),
          admit: { status: deniedAdmit.status, reason: deniedAdmit.reason ?? null, message: deniedAdmit.message ?? null },
          loadBody: { status: deniedLoad.status, reason: deniedLoad.reason ?? null, loaderCalled: deniedLoaderCalled },
          inFlight: { status: inFlightResult.status, reason: inFlightResult.reason ?? null, message: inFlightResult.message ?? null, contentServed: inFlightServed },
          fenced: { status: fenced.status, reason: fenced.reason ?? null },
          listedAfter: await listedFixtureNames(lookup),
          authority: lastAuthority ? { revision: lastAuthority.revision, names: namesOf(lastAuthority.selection?.skills) } : null,
          skillToolError,
        }
      } catch (error) {
        report.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
      }
      try {
        writeFileSync(join(IT_ROOT, 'ws', 'apply-transaction.json'), JSON.stringify(report, null, 2) + '\n')
      } catch {
        // the tool result still carries the marker; the scenario reports the missing file
      }
      return { completed: report.error === undefined }
    },
  })
}

export { name, inject, apply }
