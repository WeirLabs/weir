// Cold-session convergence integration probe for the `cold-session` scenario
// (session-capability-manager task 5.5). Two headless process generations
// reproduce the desktop "open a cold session" race (G2c OFF.openRace) with
// every Orrery-side code path real:
//
//   seed mode (first generation): mounts the real skill-selection plugin
//   against fixture-only roots, registers a real agent preset, creates a real
//   root preset session, and drives one real Apply through the group-4/5
//   engine. The 5.2 surfaces produce REAL bus emissions — the agent/created
//   re-emission and the applied-followup invalidation — which the probe
//   captures as gateway-wire frames ({ type: 'emit', event, args }, the exact
//   shape dsh-api-gateway's broadcastRemoteEvent forwards to remote clients).
//   A second, preset-less session is seeded with its own accepted selection
//   for the writer-held phase.
//
//   open mode (second generation, a genuinely cold process): re-registers the
//   preset so the standing preset key exists, then plays the client cache
//   both ways — prefetch-at-open on the standing key (fail-closed empty) and
//   wait-for-event — with the REAL frame captured in the seed generation
//   driving the invalidation refetch. The session-scoped refetch cold-reads
//   the durable record from the real capability store. Then the writer-held
//   acceptance: the real contender failure (a second process holding the
//   session log writer, captured by the driver) is pinned through the 5.3
//   noteFailure status face — menu/list stay empty (never a fallback list),
//   status carries reason + actionable hint, and clearFailure restores the
//   persisted selection.
//
// Full reports land in <ws>/cold-session-seed.json and
// <ws>/cold-session-open.json (the traced tool result is truncated at 300
// chars, so the files are the assertion surface; replay-safe: recordRun
// whitelists them). Enabled only when ORRERY_IT_COLD_SESSION=1. Dev-only.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { openCapabilityStore } from '../../orrery-harness/src/capabilities/store/store.js'
import * as selectionPlugin from '../../orrery-harness/src/capabilities/skill-selection-plugin.js'
import { createApplyEngine } from '../../orrery-harness/src/capabilities/apply-engine.js'
import { createSelectionDraft } from '../../orrery-harness/src/capabilities/selection-draft.js'
import { PRESET_SELECTED_EVENT, emitPresetSelected } from '../../orrery-harness/src/capabilities/preset-invalidation.js'
import { IT_ROOT } from './mock-kit.js'

const name = 'orrery-it-cold-session-probe'
const inject = ['tools', 'skills', 'agents']

const PRESET = 'orrery-it-cold'
const FIXTURES = ['cold-fixture-a', 'cold-fixture-b']
const [SELECTED, UNSELECTED] = FIXTURES
const WS = join(IT_ROOT, 'ws')
const ROOT = join(WS, 'skill-roots')
const SEED_REPORT = join(WS, 'cold-session-seed.json')
const OPEN_REPORT = join(WS, 'cold-session-open.json')
const HELD_ERROR = join(WS, 'cold-session-held-error.txt')

// Bus emissions captured in this process as gateway-wire frames. The seed
// report persists them so the cold generation can drive its simulated client
// cache with the REAL frame (never a fabricated one).
const frames = []
const createdAgents = []

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

/** @param {any} store @param {string} sessionId */
async function readRecord(store, sessionId) {
  const record = await store.read({ kind: 'selection', sessionId })
  return record.kind === 'ok'
    ? { kind: record.kind, revision: record.revision, receipts: record.receipts.map(entry => entry.requestId), skillNames: namesOf(record.payload?.skills) }
    : { kind: record.kind }
}

/** @param {any} ctx */
const warnOf = ctx => text => ctx.logger?.warn?.(text)

/**
 * Seed generation: real preset session + real Apply + real frames; plus the
 * preset-less held session for the writer-held phase.
 * @param {any} ctx @param {any} report
 */
async function seed(ctx, report) {
  for (const skill of FIXTURES) {
    mkdirSync(join(ROOT, skill), { recursive: true })
    writeFileSync(join(ROOT, skill, 'SKILL.md'), `---\nname: ${skill}\ndescription: Cold session fixture ${skill}\n---\nCONTENT_${skill}\n`)
  }
  const registry = ctx.get('agentPresets')
  if (!registry) throw new Error('agent preset registry unavailable')
  const store = openCapabilityStore({ profileContext: ctx.get('profileContext') })
  const selection = selectionPlugin.skillSelectionFor(ctx)
  if (!selection) throw new Error('skill selection plugin not mounted')
  const warn = warnOf(ctx)
  const unregister = await registry.register({ id: PRESET, plugins: [{ id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' }] })
  /** @type {Map<string, any>} */
  const agentsById = new Map()
  let lease, handleA, handleB
  try {
    lease = await registry.acquireScope(PRESET)
    const cwd = WS
    const listNames = async scope => (await ctx.skills.list({ cwd, scope })).map(skill => skill.name).filter(skillName => FIXTURES.includes(skillName))
    // The engine locates sessions through the REAL projection: the preset id
    // carried into the invalidation re-emission is the session's actual one,
    // and a preset-less session locates without one (no emission, 5.2).
    const locate = async session => {
      const id = session?.sessionId ?? session?.id
      const agent = agentsById.get(id)
      if (!agent) return null
      const presetId = ctx.get('sessionProjections')?.stateOf(agent.session, 'agentPreset')
      return { sessionId: id, cwd, ...(typeof presetId === 'string' && presetId.length ? { presetId } : {}) }
    }
    const traceEvents = []
    const engine = createApplyEngine({
      store,
      locateSession: locate,
      inventory: options => selection.inventory(options),
      provider: selection.provider,
      trace: event => traceEvents.push(event),
      invalidate: (sessionId, presetId) => emitPresetSelected((...args) => ctx.emit(...args), sessionId, presetId, warn),
      warn,
    })

    // ---- the cold session itself: a real root preset session + Apply ----
    handleA = await ctx.agents.create({
      sessionId: randomUUID(),
      meta: { cwd, agentPreset: PRESET },
      setup: agentCtx => registry.mount(agentCtx, PRESET).then(() => undefined),
    })
    const sessionId = handleA.agent.session.id
    agentsById.set(sessionId, handleA.agent)
    const lookup = { cwd, scope: { session: { id: sessionId } } }
    const inventory = await selection.inventory(lookup)
    const identity = inventory.candidates.find(candidate => candidate.name === SELECTED)?.identity
    if (!identity) throw new Error(`missing raw candidate ${SELECTED}`)
    const standingBefore = await listNames(lease.key)
    const draft = createSelectionDraft({ baseRevision: 0, applied: { skills: [], mcpServers: [] } })
    draft.toggle(identity, true)
    traceEvents.length = 0
    const framesBeforeApply = frames.length
    const applied = await engine.apply({ sessionId, cwd }, { requestId: 'cold-seed-1', ...draft.toApplyPayload() })
    // The applied followup (invalidation re-emission) rides a microtask.
    await new Promise(resolve => setImmediate(resolve))
    const framesAfterApply = frames.length
    report.preset = PRESET
    report.created = registry.composedPreset(handleA.agent.ctx)
    report.sessionId = sessionId
    report.cwd = cwd
    report.createdAgents = createdAgents.slice()
    report.frames = frames.slice()
    report.framesBeforeApply = framesBeforeApply
    report.framesAfterApply = framesAfterApply
    report.order = traceEvents.slice()
    report.apply = outcomeOf(applied)
    report.standingBefore = standingBefore
    report.standingAfter = await listNames(lease.key)
    report.sessionListed = await listNames({ session: { id: sessionId } })
    report.record = await readRecord(store, sessionId)
    report.unselectedPresent = inventory.candidates.some(candidate => candidate.name === UNSELECTED)

    // ---- the preset-less session a second process will hold ----
    handleB = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd } })
    const plainSessionId = handleB.agent.session.id
    agentsById.set(plainSessionId, handleB.agent)
    const heldDraft = createSelectionDraft({ baseRevision: 0, applied: { skills: [], mcpServers: [] } })
    heldDraft.toggle(identity, true)
    const framesBeforeHeld = frames.length
    const heldApplied = await engine.apply({ sessionId: plainSessionId, cwd }, { requestId: 'cold-seed-held-1', ...heldDraft.toApplyPayload() })
    await new Promise(resolve => setImmediate(resolve))
    report.plainSessionId = plainSessionId
    report.heldApply = outcomeOf(heldApplied)
    report.heldRecord = await readRecord(store, plainSessionId)
    report.framesAfterHeldApply = frames.length
    report.framesBeforeHeldApply = framesBeforeHeld
  } finally {
    await handleB?.dispose()
    await handleA?.dispose()
    await lease?.[Symbol.asyncDispose]()
    await unregister?.()
  }
}

/**
 * Cold generation: both prefetch timings of the simulated client cache, then
 * the writer-held status face.
 * @param {any} ctx @param {any} report
 */
async function open(ctx, report) {
  if (!existsSync(SEED_REPORT)) throw new Error('seed report missing — the seed generation must run first')
  const seeded = JSON.parse(readFileSync(SEED_REPORT, 'utf8'))
  if (seeded.error) throw new Error(`seed generation failed: ${seeded.error}`)
  if (!existsSync(HELD_ERROR)) throw new Error('held error capture missing — the contender boot must run first')
  const heldText = readFileSync(HELD_ERROR, 'utf8')
  const registry = ctx.get('agentPresets')
  if (!registry) throw new Error('agent preset registry unavailable')
  const store = openCapabilityStore({ profileContext: ctx.get('profileContext') })
  const selection = selectionPlugin.skillSelectionFor(ctx)
  if (!selection) throw new Error('skill selection plugin not mounted')
  const unregister = await registry.register({ id: PRESET, plugins: [{ id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' }] })
  let lease
  try {
    lease = await registry.acquireScope(PRESET)
    const cwd = seeded.cwd
    const sessionScope = { session: { id: seeded.sessionId } }
    const frame = (seeded.frames ?? []).find(entry => entry?.event === PRESET_SELECTED_EVENT && entry?.args?.[0] === seeded.sessionId)
    if (!frame) throw new Error('seed report carries no real invalidation frame for the cold session')
    const fetchNames = async scope => (await ctx.skills.list({ cwd, scope })).map(skill => skill.name).filter(skillName => FIXTURES.includes(skillName))

    // Simulated client cache (G2c OFF.openRace shape): the command directory
    // opens the cold session, the stock follow→promote resume emits the
    // forwarded agent-preset/selected frame, and the frame invalidates the
    // cache into a session-scoped refetch. Both prefetch timings must
    // converge to the accepted selection; an empty-then-converged shape is
    // allowed, listing an unselected skill never is.
    const runTiming = async timing => {
      const steps = []
      if (timing === 'prefetch-at-open') {
        // Before the resume lands the client only holds the standing preset
        // key: no session id, fail-closed empty.
        steps.push({ step: 'prefetch', scope: 'standing', names: await fetchNames(lease.key) })
      }
      steps.push({ step: timing === 'prefetch-at-open' ? 'refetch-on-frame' : 'fetch-on-frame', scope: 'session', frame, names: await fetchNames(sessionScope) })
      return { timing, steps, converged: steps.at(-1).names }
    }
    report.timings = [await runTiming('prefetch-at-open'), await runTiming('wait-for-event')]
    report.convergenceStatus = selection.status({ cwd, scope: sessionScope })

    // ---- writer-held: the real contender failure through the 5.3 face ----
    const heldLine = heldText.split('\n').map(line => line.trim()).find(line => line.includes('already owned by an active write handle')) ?? heldText.trim()
    const heldScope = { session: { id: seeded.plainSessionId } }
    // The desktop host surfaces this exact failure as RemoteError
    // 'session/writer-held' (dsh-api-session-controller rejectCreation maps
    // SessionAlreadyOwnedError onto it); the headless one-shot runner prints
    // the raw SessionAlreadyOwnedError instead. The probe therefore re-wraps
    // the REAL message with the REAL code the manager edge would receive.
    const failure = { code: 'session/writer-held', message: heldLine }
    selection.noteFailure({ cwd, scope: heldScope }, failure)
    report.held = {
      failure,
      statusUnderNote: selection.status({ cwd, scope: heldScope }),
      standingUnderNote: await fetchNames(lease.key),
      sessionUnderNote: await fetchNames(heldScope),
      // Proof the empty menu is the pinned note, never an absent record.
      rawRecord: await readRecord(store, seeded.plainSessionId),
    }
    selection.clearFailure({ cwd, scope: heldScope })
    report.held.sessionAfterClear = await fetchNames(heldScope)
    report.held.statusAfterClear = selection.status({ cwd, scope: heldScope })
  } finally {
    await lease?.[Symbol.asyncDispose]()
    await unregister?.()
  }
}

/** @param {any} ctx @param {{ enabled?: boolean }} config */
function apply(ctx, config = {}) {
  if (config.enabled !== true) return
  // The static orrery-skill-selection row is disabled for this scenario; the
  // probe mounts the real plugin against the fixture roots so inventory,
  // provider invalidation and ctx.skills.list are the production code paths
  // (same mounting pattern as the apply-transaction probe).
  selectionPlugin.apply(ctx, {
    machineId: 'orrery-it-machine',
    includeDefaultRoots: false,
    customSkillDirs: [ROOT],
  })
  ctx.on(PRESET_SELECTED_EVENT, (sessionId, presetId) => {
    frames.push({ type: 'emit', event: PRESET_SELECTED_EVENT, args: [sessionId, presetId], via: (new Error().stack ?? '').split('\n').slice(2, 9).map(line => line.trim()) })
  })
  ctx.on('agent/created', payload => {
    createdAgents.push({
      id: payload?.agent?.id ?? null,
      origin: payload?.agent?.session?.header?.origin ?? null,
      depth: payload?.agent?.session?.header?.delegationDepth ?? 0,
    })
  })
  ctx.tools.register({
    name: 'cold_session_probe',
    description: 'Integration probe: seed a real preset session with an accepted selection and real invalidation frames, then replay the cold-open convergence and writer-held status face in a cold process.',
    parameters: { type: 'object', properties: {} },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: `COLD_SESSION_PROBE ${value.completed ? 'done' : 'error'}` }],
    },
    async execute() {
      const mode = process.env.ORRERY_IT_COLD_MODE ?? 'seed'
      const report = { scenario: 'cold-session', mode }
      try {
        if (mode === 'seed') await seed(ctx, report)
        else if (mode === 'open') await open(ctx, report)
        else throw new Error(`unknown cold session probe mode '${mode}'`)
      } catch (error) {
        report.error = error instanceof Error ? (error.stack ?? error.message) : String(error)
      }
      // Only the seed/open generations own report files; a stray call in the
      // holder/contender boots must never overwrite the seed report.
      if (mode === 'seed' || mode === 'open') {
        try {
          writeFileSync(mode === 'open' ? OPEN_REPORT : SEED_REPORT, JSON.stringify(report, null, 2) + '\n')
        } catch {
          // the tool result still carries the marker; the scenario reports the missing file
        }
      }
      return { completed: report.error === undefined }
    },
  })
}

export { name, inject, apply }
