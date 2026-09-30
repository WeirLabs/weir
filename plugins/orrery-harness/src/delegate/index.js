// Orrery delegate plugin: category registry + curated agents + the delegate
// tool. Plain ESM, ctx-only.
import { openSync, readSync, closeSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { CURATED_AGENTS, readOnlyShellNote } from './agents.js'
import { DEFAULT_CATEGORIES } from './categories.js'
import { modelFamily, pickVariant } from './families.js'
import { createStatusTool } from './status-tool.js'
import { createGroupCoordinator } from './group-coordinator.js'
import { rehydrateSupervision, applyChildLogRecovery } from './rehydrate.js'
import { filterUnsupportedEffort, resolveCategory, snapshotProviders } from './resolver.js'
import { attachReadOnlyBashGuard } from './robash-guard.js'
import { DEFAULT_TABLES } from './robash-guard-core.js'
import { AUDIT_TYPES, createAudit } from '../shared/audit.js'
import { FALLBACK_TABLES } from '../shared/whitelist-defaults.js'
import { userTextMessage } from '../shared/user-message.js'
import { createDelegateTool } from './tool.js'

const name = 'orrery-delegate'
const inject = ['tools', 'subagents', 'llm', 'skills']

/** The shell tool a read-only child gets: pwsh on Windows (where the preset
 * disables bash and mounts pwsh), bash everywhere else. Pure — parameterized
 * on platform for tests. */
export function readOnlyShellName(platform) {
  return platform === 'win32' ? 'pwsh' : 'bash'
}

/**
 * The effective list for one guard table: the product defaults first, then every
 * addition, de-duplicated on first occurrence. Case is preserved — the pwsh path
 * lowercases at lookup time (its matching is case-insensitive) while the POSIX
 * path stays case-sensitive, so folding here would destroy that distinction.
 */
export function mergeWhitelist(defaults, additions) {
  const merged = []
  const seen = new Set()
  for (const entry of [...(defaults ?? []), ...(additions ?? [])]) {
    if (typeof entry !== 'string' || entry.length === 0) continue
    if (seen.has(entry)) continue
    seen.add(entry)
    merged.push(entry)
  }
  return merged
}

/** The settings section's ADDITION lists, per field name, as `[]` when absent. */
function additionsOf(section, fields) {
  const out = {}
  for (const field of fields) {
    const value = section?.[field]
    out[field] = Array.isArray(value) ? value : []
  }
  return out
}

function apply(ctx, config = {}) {
  const audit = createAudit(ctx)
  // Live settings overlay (absent service = no-op). Sections are re-resolved at
  // every consumption point instead of snapshotted here: the service recomputes
  // on each get() and broadcasts on commit, so reading late is what makes an
  // online edit take effect in this same process (no app restart). See
  // docs/features/category-delegation.md — "volatile config, 在线编辑即刻生效".
  const settings = ctx.get?.('orrerySettings')
  const robashOverrideNow = () => settings?.get('robash')
  const delegateOverrideNow = () => settings?.get('delegate')

  const baseCategories = () => ({ ...DEFAULT_CATEGORIES, ...(config.categories ?? {}) })
  const agents = { ...CURATED_AGENTS, ...(config.agents ?? {}) }

  // Settings category chains: wholesale chain replacement per named category.
  // Applied onto the base every time, so a commit is visible to the very next
  // delegation rather than to the next process.
  function categoriesNow() {
    const categories = baseCategories()
    const delegateOverride = delegateOverrideNow()
    if (delegateOverride?.categoryChains && typeof delegateOverride.categoryChains === 'object') {
      for (const [category, chain] of Object.entries(delegateOverride.categoryChains)) {
        if (!categories[category]) {
          ctx.logger?.warn?.(`orrery-settings: categoryChains names unknown category "${category}" — ignored`)
          continue
        }
        categories[category] = { ...categories[category], chain }
      }
    }
    return categories
  }

  // Supervision parameters the coordinator consumes. Resolved on demand (per
  // coordinator, and pushed into live coordinators on commit) so the settings
  // section stays authoritative without freezing into the row config.
  function supervisionNow() {
    const delegateOverride = delegateOverrideNow()
    const { supervisionMaxRetries, supervisionInitialBackoffMs, supervisionMaxBackoffMs } = delegateOverride ?? {}
    return {
      ...(config.supervision ?? {}),
      ...(supervisionMaxRetries !== undefined ? { maxRetries: supervisionMaxRetries } : {}),
      ...(supervisionInitialBackoffMs !== undefined ? { initialBackoffMs: supervisionInitialBackoffMs } : {}),
      ...(supervisionMaxBackoffMs !== undefined ? { maxBackoffMs: supervisionMaxBackoffMs } : {}),
    }
  }

  // Read-only shell guard: curated agents and readOnly categories get the
  // platform shell (bash, pwsh on win32) behind a fail-closed whitelist
  // guard when enabled.
  //
  // Layering contract (append semantics):
  //   default (from the product defaults file the plugin reads itself)
  //     ∪ row config additions (config.readOnlyBash / readOnlyPwsh)
  //     ∪ user additions (the settings section's list keys)
  //
  // The product defaults are NOT read from the settings row: a DSH patch row is
  // replaced wholesale rather than deep-merged, so a default that rides one can
  // be discarded by any profile that declares its own row — that is how a
  // whitelist addition once became unreachable for every profile that had ever
  // edited a list. The file is read by the plugin at its own path, which no
  // configuration layer can replace.
  //
  // Every layer only ADDS. Nothing here removes a default entry, and an empty
  // array adds nothing rather than clearing the list: appending to allow/gitAllow
  // widens what is permitted, appending to deny tightens it, and neither can
  // shrink the product defaults. The union is de-duplicated preserving first
  // occurrence, so the effective order is defaults first, additions after.
  function robashNow() {
    const robashOverride = robashOverrideNow()
    const defaults = robashOverride?.defaults ?? FALLBACK_TABLES
    const robashConfig = {
      enabled: true,
      allow: DEFAULT_TABLES.robashAllow,
      gitAllow: DEFAULT_TABLES.robashGitAllow,
      deny: DEFAULT_TABLES.robashDeny,
      ...(config.readOnlyBash ?? {}),
      ...(robashOverride ?? {}),
    }
    const pwshConfig = {
      allow: DEFAULT_TABLES.robashPwshAllow,
      deny: DEFAULT_TABLES.robashPwshDeny,
      ...(config.readOnlyPwsh ?? {}),
    }
    const bashAdditions = additionsOf(robashOverride, ['allow', 'gitAllow', 'deny'])
    const pwshAdditions = additionsOf(robashOverride, ['pwshAllow', 'pwshDeny'])
    const gitAdditions = [...(robashConfig.gitAllow ?? []), ...bashAdditions.gitAllow]
    return {
      // enablement is a plain switch and still takes the section's last word;
      // only the LISTS changed to append semantics below
      enabled: robashConfig.enabled !== false,
      lists: {
        bash: {
          allow: mergeWhitelist(defaults.robashAllow, [...(robashConfig.allow ?? []), ...bashAdditions.allow]),
          gitAllow: mergeWhitelist(defaults.robashGitAllow, gitAdditions),
          deny: mergeWhitelist(defaults.robashDeny, [...(robashConfig.deny ?? []), ...bashAdditions.deny]),
        },
        pwsh: {
          allow: mergeWhitelist(defaults.robashPwshAllow, [...(pwshConfig.allow ?? []), ...pwshAdditions.pwshAllow]),
          // gitAllow is merged once on the bash side and shared with the pwsh
          // git gate, so a pwsh-specific git list is not consulted here.
          gitAllow: mergeWhitelist(defaults.robashGitAllow, gitAdditions),
          deny: mergeWhitelist(defaults.robashPwshDeny, [...(pwshConfig.deny ?? []), ...pwshAdditions.pwshDeny]),
        },
      },
    }
  }
  const readOnlyTools = (base, resolved = robashNow()) => (resolved.enabled ? [...new Set([...base, readOnlyShellName(process.platform)])] : base)

  // Supervised group coordinators, one per parent session.
  /** @type {Map<string, { coordinator: object, parent: object }>} */
  const coordinators = new Map()
  async function coordinatorFor(parent) {
    let entry = coordinators.get(parent.id)
    if (!entry) {
      const coordinator = createGroupCoordinator(
        {
          sendTo: async (childId, text) => {
            await ctx.subagents.sendMessage(parent, childId, [{ type: 'text', text }], { signal: new AbortController().signal })
          },
          interruptChild: (childId) => {
            ctx.subagents.interrupt(childId, { kind: 'ancestor', agent: parent })
          },
          schedule: (delayMs, fn) => {
            const timer = setTimeout(fn, delayMs)
            timer.unref?.()
          },
          onAudit: (note) => {
            audit(parent.session, AUDIT_TYPES.supervision, { note })
          },
          onFact: (fact) => {
            audit(parent.session, `${AUDIT_TYPES.supervision}/${fact.kind}`, fact)
          },
          notifyParent: (text) => {
            // Reliable parent-facing delivery: timer-deferred, mirroring the
            // built-in settlement channel (sendWaking): steer into the current
            // turn when the parent is busy so the signal lands right after the
            // last member's settlement notice; followup wake when idle. Bounded
            // retry; the final failure is audited.
            const message = userTextMessage(text, 'orrery-delegate')
            const deliver = (attempt) => {
              const delay = attempt === 1 ? 0 : 200 * (attempt - 1)
              const timer = setTimeout(() => {
                let outcome
                try {
                  outcome = parent.status === 'idle' ? parent.followup(message) : parent.steer(message)
                } catch (error) {
                  outcome = Promise.reject(error)
                }
                Promise.resolve(outcome).catch((error) => {
                  ctx.logger?.warn?.(`orrery-delegate: group-settled signal delivery (attempt ${attempt}) failed: ${error?.message ?? error}`)
                  if (attempt < 3) deliver(attempt + 1)
                  else audit(parent.session, AUDIT_TYPES.supervision, { note: `group-settled signal delivery failed after ${attempt} attempts: ${String(error?.message ?? error)}` })
                })
              }, delay)
              timer.unref?.() // never hold the process for a pending signal delivery
            }
            deliver(1)
          },
        },
        supervisionNow(),
      )
      // Restart rebuild: replay durable facts, cross-check the DSH catalog.
      const state = await rehydrateForParent(parent)
      coordinator.hydrate(state)
      entry = { coordinator, parent }
      coordinators.set(parent.id, entry)
    }
    return entry.coordinator
  }

  /** Best-effort rehydration inputs for one parent: audit tail + catalog. */
  async function rehydrateForParent(parent) {
    const records = readAuditTail(auditFilePathOf(parent.session))
    let catalogChildren = []
    try {
      catalogChildren = await ctx.subagents.listChildren(parent.id) ?? []
    } catch {
      // catalog unavailable: partial-confidence rebuild still proceeds
    }
    const state = rehydrateSupervision({ parentId: parent.id, records, catalogChildren })
    const sessionQuery = ctx.get?.('sessionQuery')
    if (sessionQuery?.readSession) {
      return applyChildLogRecovery(state, (childId) => readChildFinalText(sessionQuery, childId))
    }
    return state
  }

  /** Find the entry owning a given child session id (event filter). */
  function entryOfChild(sessionId) {
    for (const entry of coordinators.values()) {
      if (entry.coordinator.ownsChild(sessionId)) return entry
    }
    return undefined
  }

  // Supervision feed: child assistant text + turn ends drive the state machine;
  // the parent's own log feeds the settlement-notice ordering gate. Parent-facing
  // signals are delivered through the coordinator's notifyParent effector
  // (timer-deferred dispatch), never synchronously from inside event dispatch.
  ctx.on('session/event', (session, event) => {
    const parentEntry = coordinators.get(session.id)
    if (parentEntry) {
      // Strict ordering: the group-settled signal must follow every member's
      // built-in settlement notice, so observe them as they land in the parent log.
      if (event?.type === 'user/message' && event.data?.source?.kind === 'subagent-settled') {
        const senderId = event.data?.source?.senderSessionId
        if (typeof senderId === 'string' && senderId.length > 0) {
          parentEntry.coordinator.noteSettlementNotice(senderId)
        }
      }
      return
    }
    const entry = entryOfChild(session.id)
    if (!entry) return
    if (event?.type === 'assistant/message') {
      const text = Array.isArray(event.data?.message?.content)
        ? event.data.message.content
            .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
            .map((block) => block.text)
            .join('\n')
        : ''
      entry.coordinator.noteAssistantText(session.id, text)
      return
    }
    if (event?.type === 'turn/end') {
      void driveTurnEnd(entry, session.id, event.data?.reason)
    }
  })

  async function driveTurnEnd(entry, childId, reason) {
    try {
      await entry.coordinator.onTurnEnd(childId, reason)
    } catch (error) {
      audit(entry.parent.session, AUDIT_TYPES.supervision, { note: `turn-end processing failed for child ${childId}: ${String(error?.message ?? error)}` })
    }
  }



  ctx.tools.register(
    createDelegateTool({
      resolveTarget,
      loadSkill,
      subagents: ctx.subagents,
      agents: ctx.get('agents'),
      jobs: ctx.get('jobs'),
      // A getter, not a snapshot: tool.js calls deps.robash() per delegation so
      // the guard reflects whatever the settings committed at that moment.
      robash: robashNow,
      coordinatorFor,
    }),
  )

  // Main-agent supervision tools (delegation depth 0 only).
  ctx.tools.register({
    name: 'resume_agent',
    description: `Resume a blocked supervised child of this session. Your resume context is delivered to the child, which resumes its agent loop; its status flips back to running. Use when the blocker is cleared and the task's direction is unchanged. When the direction changed substantially, terminate the blocked child with terminate_agent and delegate a fresh child instead.`,
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Name or id of the blocked supervised child.' },
        context: { type: 'string', description: 'Unblocking context delivered to the child (what changed, what to do next).' },
      },
      required: ['agent', 'context'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: `Resumed supervised child ${value.name} (${value.id}); status: ${value.status}. Its next terminal report will arrive as usual.` }],
    },
    async execute(args, exec) {
      const depth = exec.agent?.session?.header?.delegationDepth ?? 0
      if (depth >= 1) throw new Error('resume_agent: only the main agent may resume supervised children')
      if (typeof args.agent !== 'string' || args.agent.length === 0) throw new Error('resume_agent: agent must be a non-empty string')
      if (typeof args.context !== 'string' || args.context.trim().length === 0) throw new Error('resume_agent: context must be a non-empty string')
      const coordinator = await coordinatorFor(exec.agent)
      try {
        return await coordinator.resume(args.agent, args.context)
      } catch (error) {
        throw withUntrackedHint(error, coordinator)
      }
    },
  })

  ctx.tools.register({
    name: 'terminate_agent',
    description: `Terminate a supervised child of this session. A running child is interrupted for real; a non-running child (blocked or settled) is only marked terminated as state bookkeeping. Terminated members count toward their group's completion. Only the main agent may terminate: children have no say over a task's existence.`,
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'Name or id of the supervised child to terminate.' },
        reason: { type: 'string', description: 'Optional termination reason, recorded as the child\'s report.' },
      },
      required: ['agent'],
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: `Supervised child ${value.name} (${value.id}) is terminated${value.interrupted ? ' (interrupted while running)' : ' (state bookkeeping)'}.` }],
    },
    async execute(args, exec) {
      const depth = exec.agent?.session?.header?.delegationDepth ?? 0
      if (depth >= 1) throw new Error('terminate_agent: only the main agent may terminate supervised children')
      if (typeof args.agent !== 'string' || args.agent.length === 0) throw new Error('terminate_agent: agent must be a non-empty string')
      const coordinator = await coordinatorFor(exec.agent)
      try {
        return coordinator.terminate(args.agent, args.reason)
      } catch (error) {
        throw withUntrackedHint(error, coordinator)
      }
    },
  })

  ctx.tools.register(
    createStatusTool({
      coordinatorFor,
      listChildren: async (parentId) => {
        try {
          return await ctx.subagents.listChildren(parentId)
        } catch {
          return null
        }
      },
    }),
  )


  // Provider snapshot cache, invalidated on adapter topology changes.
  /** @type {Map<string, string[] | null> | null} */
  let snapshot = null
  const refresh = async () => {
    snapshot = await snapshotProviders(ctx.llm)
    return snapshot
  }
  const snapshotNow = async () => snapshot ?? (await refresh())
  ctx.on('llm/adapters-updated', () => {
    snapshot = null
  })

  /**
   * Resolve one delegation item to persona + agentOptions + toolFilter.
   * Throws explicit errors for unknown/disabled/unavailable targets.
   * parentRoute (when known) gates effort hints on inherited routes.
   */
  async function resolveTarget(item, parentRoute) {
    // Resolve the guard overlay once for this delegation, so every branch below
    // describes one committed snapshot (see the hot-reload contract in
    // docs/features/category-delegation.md).
    const robash = robashNow()
    if (item.agent) {
      const agent = agents[item.agent]
      if (!agent) {
        throw new Error(`delegate: unknown_target "${item.agent}" (available agents: ${Object.keys(agents).join(', ') || 'none'})`)
      }
      if (agent.disabled) throw new Error(`delegate: agent "${item.agent}" is disabled`)
      const label = item.name ?? item.task_summary ?? `${item.agent}: ${firstLine(item.prompt)}`
      // One resolution per delegation: the persona note, the tool surface and
      // the guard all describe the same committed settings snapshot.
      const robash = robashNow()
      return {
        persona: agent.prompt + (robash.enabled ? readOnlyShellNote(readOnlyShellName(process.platform)) : ''),
        toolFilter: { allow: readOnlyTools(agent.tools, robash) },
        label,
        readOnly: true,
      }
    }

    // Resolve once per delegation so the surface, the guard and the route all
    // agree on one snapshot of the settings overlay.
    const categories = categoriesNow()
    const category = categories[item.category]
    if (!category) {
      throw new Error(`delegate: unknown_target category "${item.category}" (available: ${Object.keys(categories).join(', ') || 'none'})`)
    }
    const providers = await snapshotNow()
    const hasUserConfig = Boolean(config.categories?.[item.category])
    let route = resolveCategory(category, providers, hasUserConfig)
    if (route.kind === 'unavailable') {
      throw new Error(`delegate: category "${item.category}" unavailable — ${route.reason}`)
    }
    if (route.kind === 'resolved') {
      route = await filterUnsupportedEffort(ctx.llm, route)
    }

    const family = modelFamily(route.kind === 'resolved' ? route.model : undefined)
    const persona = pickVariant(category.promptAppend, family)
    const label = item.name ?? item.task_summary ?? `${item.category}: ${firstLine(item.prompt)}`

    const agentOptions = {}
    if (route.kind === 'resolved') {
      agentOptions.provider = route.provider
      agentOptions.model = route.model
      if (route.reasoningEffort) agentOptions.reasoningEffort = route.reasoningEffort
    } else if (category.reasoningEffort && parentRoute?.provider && parentRoute?.model) {
      // Inherited route: keep the effort hint only when the parent's route
      // advertises it; drop silently otherwise.
      try {
        const info = await ctx.llm.resolveModelInfo(parentRoute.provider, parentRoute.model)
        const efforts = info?.reasoning?.efforts
        if (Array.isArray(efforts) && efforts.some((effort) => effort.id === category.reasoningEffort)) {
          agentOptions.reasoningEffort = category.reasoningEffort
        }
      } catch {
        // unknown route metadata: omit the hint rather than risk a rejection
      }
    }

    return {
      persona,
      ...(category.readOnly ? { toolFilter: { allow: readOnlyTools(['read', 'glob', 'grep'], robash) } } : {}),
      ...(Object.keys(agentOptions).length > 0 ? { agentOptions } : {}),
      label,
      categoryName: item.category,
      ...(category.readOnly ? { readOnly: true } : {}),
    }
  }

  async function loadSkill(skillName) {
    const skill = await ctx.skills.get(skillName)
    if (!skill) throw new Error(`delegate: unknown_skill "${skillName}" in load_skills`)
    return skill.content
  }

  // Volatile settings commits: read-time resolution already covers every new
  // delegation, but a coordinator is long-lived (one per parent session), so its
  // supervision parameters must be pushed into the live instances too. Mirrors
  // src/lsp/index.js: the same broadcast that re-registers the LSP surface
  // refreshes the supervision tuning here.
  const offSettings = settings?.onChange?.(() => {
    const supervision = supervisionNow()
    for (const entry of coordinators.values()) entry.coordinator.setSupervision?.(supervision)
  })

  return () => {
    offSettings?.()
  }
}

function firstLine(text) {
  return text.split('\n', 1)[0].slice(0, 80)
}

/** Audit JSONL location for one session (cold-safe channel; may not exist). */
export function auditFilePathOf(session) {
  const cwd = session?.header?.cwd
  if (typeof cwd !== 'string' || cwd.length === 0) return null
  return join(cwd, '.orrery', 'audit.jsonl')
}

/**
 * When a rebuilt registry cannot find a named child but the DSH catalog shows
 * continuable children, the error must say so — never claim no children exist.
 * @param {Error} error
 * @param {object} coordinator
 * @returns {Error}
 */
export function withUntrackedHint(error, coordinator) {
  const untracked = coordinator?.snapshot().meta?.untracked
  if (Array.isArray(untracked) && untracked.length > 0 && /no supervised child/.test(String(error?.message ?? ''))) {
    return new Error(`${error.message} Note: ${untracked.length} untracked continuable child(ren) exist in the DSH catalog — supervision state may have been rebuilt with partial confidence.`)
  }
  return error
}

/**
 * Tail-read the audit JSONL (best-effort): returns parsed records, or [] when
 * the file is missing/unreadable. A partial first line is dropped.
 * @param {string | null} filePath
 * @param {number} [maxBytes]
 * @returns {object[]}
 */
export function readAuditTail(filePath, maxBytes = 256 * 1024) {
  if (typeof filePath !== 'string' || filePath.length === 0) return []
  let size
  try {
    size = statSync(filePath).size
  } catch {
    return []
  }
  if (size === 0) return []
  const start = Math.max(0, size - maxBytes)
  const length = size - start
  let buffer
  try {
    buffer = Buffer.alloc(length)
    const fd = openSync(filePath, 'r')
    try {
      readSync(fd, buffer, 0, length, start)
    } finally {
      closeSync(fd)
    }
  } catch {
    return []
  }
  const lines = buffer.toString('utf8').split('\n')
  if (start > 0 && lines.length > 0) lines.shift()
  const records = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      // tolerate malformed lines (best-effort tail)
    }
  }
  return records
}

/**
 * L3 reader: last assistant text of a child session, or null when unreadable.
 * @param {object} sessionQuery - DSH sessionQuery service
 * @param {string} childId
 * @returns {Promise<string | null>}
 */
export async function readChildFinalText(sessionQuery, childId) {
  const read = await sessionQuery.readSession(childId)
  const events = read?.events ?? []
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i]
    if (event?.type !== 'assistant/message') continue
    const content = event?.data?.message?.content
    if (!Array.isArray(content)) continue
    const text = content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
    if (text.length > 0) return text
    return null
  }
  return null
}

export { name, inject, apply }
