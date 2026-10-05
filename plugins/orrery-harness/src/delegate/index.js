// Orrery delegate plugin: category registry + curated agents + the delegate
// tool. Plain ESM, ctx-only. Composition root: all policy lives in the sibling
// modules (settings-overlay / target-resolver / supervision-tools /
// supervision-mount / audit-readers); apply() only constructs and wires them.
import { CURATED_AGENTS } from './agents.js'
import { createSettingsOverlay } from './settings-overlay.js'
import { createTargetResolver } from './target-resolver.js'
import { createStatusTool } from './status-tool.js'
import { createSkillConsumerView } from '../capabilities/consumer-view.js'
import { skillSelectionFor } from '../capabilities/skill-selection-plugin.js'
import { createResumeTool, createTerminateTool } from './supervision-tools.js'
import { mountSupervision } from './supervision-mount.js'
import { createAudit } from '../shared/audit.js'
import { FALLBACK_TABLES } from '../shared/whitelist-defaults.js'
import { createDelegateTool } from './tool.js'
import { attachWorktreeModeGuard } from './worktree-mode.js'
import { DOCTRINE_SECTION_ORDER } from '../core/doctrine.js'
import { isDelegatedChild } from '../shared/child-scope.js'
import {
  DELEGATE_TARGETS_SECTION_NAME,
  DELEGATE_TARGETS_SECTION_ORDER_OFFSET,
  DELEGATE_TARGETS_VARIABLE_NAME,
  renderDelegateTargetsSection,
} from './targets.js'

const name = 'orrery-delegate'
const inject = ['tools', 'subagents', 'llm', 'skills', 'systemPrompt']

// readOnlyShellName moved to settings-overlay.js; re-exported in place so
// existing imports keep working (test/delegate.test.js is the canary) — same
// precedent as tool.js re-exporting supervisedToolFilter.
export { readOnlyShellName } from './settings-overlay.js'

function apply(ctx, config = {}) {
  const audit = createAudit(ctx)
  // Live settings overlay (absent service = no-op). Sections are re-resolved at
  // every consumption point by the overlay module: the service recomputes on
  // each get() and broadcasts on commit, so reading late is what makes an
  // online edit take effect in this same process (no app restart). See
  // docs/features/category-delegation.md — "volatile config, 在线编辑即刻生效".
  const settings = ctx.get?.('orrerySettings')
  const overlay = createSettingsOverlay({
    settings,
    config,
    logger: ctx.logger,
    platform: process.platform,
    fallbackTables: FALLBACK_TABLES,
  })
  // Worktree lanes (optional preset service, same realm): read live so a
  // gate flip or a late mount is seen by the next delegation.
  const lanes = () => ctx.get?.('orreryWorktreeLanes')
  const mount = mountSupervision({
    ctx,
    audit,
    settings,
    supervisionNow: overlay.supervisionNow,
    onChildSettled: (childId, parent) => {
      void lanes()?.childSettled(childId, parent?.session)?.catch?.((error) => ctx.logger?.warn?.(`orrery-delegate: lane settlement failed: ${error?.message ?? error}`))
    },
  })
  const { coordinatorFor } = mount

  const agents = { ...CURATED_AGENTS, ...(config.agents ?? {}) }

  // Standing delegation-target guidance: the tool's usage contract plus the
  // live list of ENABLED targets, so the model knows how to call `delegate`
  // before its first attempt instead of learning the rules from a failure.
  // The section text is static; the list rides a prompt variable whose
  // provider DSH calls at EVERY prompt assembly (design D1). A settings commit
  // therefore changes what the model sees without re-registering the section
  // and without restarting the app — the same volatile contract the rest of
  // the overlay follows.
  // Static bare variable reference (same pattern as the doctrine section):
  // a function-valued section text proved fragile in this runtime, so the
  // child suppression rides the variable provider DSH calls at EVERY prompt
  // assembly (design D1). A settings commit therefore changes what the model
  // sees without re-registering the section and without restarting the app —
  // the same volatile contract the rest of the overlay follows. Main agents
  // render intro + live list byte-identically; a delegated child renders ''.
  ctx.systemPrompt.section({
    name: DELEGATE_TARGETS_SECTION_NAME,
    order: DOCTRINE_SECTION_ORDER + DELEGATE_TARGETS_SECTION_ORDER_OFFSET,
    text: `{{${DELEGATE_TARGETS_VARIABLE_NAME}}}`,
  })
  ctx.systemPrompt.variable(DELEGATE_TARGETS_VARIABLE_NAME, (context) =>
    isDelegatedChild(context)
      ? ''
      : renderDelegateTargetsSection({ categories: overlay.categoriesNow(), agents: overlay.agentsNow() }),
  )
  const targetResolver = createTargetResolver({
    agents,
    userCategories: config.categories,
    overlay,
    llm: ctx.llm,
    onAdaptersUpdated: (fn) => ctx.on('llm/adapters-updated', fn),
  })

  ctx.tools.register(
    createDelegateTool({
      resolveTarget: targetResolver.resolveTarget,
      loadSkill,
    preflightLoadSkills,
      subagents: ctx.subagents,
      agents: ctx.get('agents'),
      jobs: ctx.get('jobs'),
      // A getter, not a snapshot: tool.js calls deps.robash() per delegation so
      // the guard reflects whatever the settings committed at that moment.
      robash: overlay.robashNow,
      coordinatorFor,
      lanes,
      // Live resolver (read per spawn): the composition's restrictable tool
      // names, so the child deny list names only tools this composition
      // actually registers (tools.restrict() rejects unknown deny names).
      restrictableNames: () => ctx.tools.view?.(undefined)?.restrictableNames,
    }),
  )

  // Worktree mode on main agents: writes refused, shell read-only (the same
  // whitelist as read-only children), evaluated per call from the session's
  // projected mode.
  const offModeGuard = attachWorktreeModeGuard(ctx, { lanes, robash: overlay.robashNow })

  // Main-agent supervision tools (delegation depth 0 only).
  ctx.tools.register(createResumeTool({ coordinatorFor }))
  ctx.tools.register(createTerminateTool({ coordinatorFor }))

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

  async function loadSkill(skillName) {
    const skill = await ctx.skills.get(skillName)
    if (!skill) throw new Error(`delegate: unknown_skill "${skillName}" in load_skills`)
    return skill.content
  }

  // Task 7.1/7.2: the delegate side of the unified consumer view. load_skills
  // are preflighted as ONE batch against the preset-layer selection view
  // (parent session, model purpose) — any failure rejects the entire batch
  // with zero spawns, before any group record or child exists.
  const selection = skillSelectionFor(ctx)
  const consumerView = selection?.provider ? createSkillConsumerView({ provider: selection.provider }) : null
  async function preflightLoadSkills(items, exec) {
    const names = [...new Set(items.flatMap(item => item.load_skills ?? []))]
    if (names.length === 0 || !consumerView) return
    const options = { cwd: exec.agent?.session?.header?.cwd, scope: { session: { id: exec.agent?.id } } }
    const verdicts = await consumerView.conclusions(options, names, 'model')
    const failures = [...verdicts.values()].filter(verdict => !verdict.invocable)
    if (failures.length > 0) {
      throw new Error(`delegate: load_skills preflight rejected the whole batch (zero spawned): ${failures.map(failure => `"${failure.name}" ${failure.reason}`).join(', ')}`)
    }
  }

  return () => {
    offModeGuard()
    mount.dispose()
  }
}

export { name, inject, apply }
