// Orrery delegate plugin: category registry + curated agents + the delegate
// tool. Plain ESM, ctx-only. Composition root: all policy lives in the sibling
// modules (settings-overlay / target-resolver / supervision-tools /
// supervision-mount / audit-readers); apply() only constructs and wires them.
import { CURATED_AGENTS } from './agents.js'
import { createSettingsOverlay } from './settings-overlay.js'
import { createTargetResolver } from './target-resolver.js'
import { createStatusTool } from './status-tool.js'
import { createResumeTool, createTerminateTool } from './supervision-tools.js'
import { mountSupervision } from './supervision-mount.js'
import { createAudit } from '../shared/audit.js'
import { FALLBACK_TABLES } from '../shared/whitelist-defaults.js'
import { createDelegateTool } from './tool.js'

const name = 'orrery-delegate'
const inject = ['tools', 'subagents', 'llm', 'skills']

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
  const mount = mountSupervision({ ctx, audit, settings, supervisionNow: overlay.supervisionNow })
  const { coordinatorFor } = mount

  const agents = { ...CURATED_AGENTS, ...(config.agents ?? {}) }
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
      subagents: ctx.subagents,
      agents: ctx.get('agents'),
      jobs: ctx.get('jobs'),
      // A getter, not a snapshot: tool.js calls deps.robash() per delegation so
      // the guard reflects whatever the settings committed at that moment.
      robash: overlay.robashNow,
      coordinatorFor,
    }),
  )

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

  return mount.dispose
}

export { name, inject, apply }
