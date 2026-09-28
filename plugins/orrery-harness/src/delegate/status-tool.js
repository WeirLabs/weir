// supervised_status: render the supervision registry (children/groups/untracked
// catalog entries) for the main agent. Depth-0 only, like resume_agent and
// terminate_agent. Pure-object ToolDefinition (no @deepseek-ai imports).

/** Digest a report body for compact rendering. */
export function digestReport(report, max = 200) {
  const text = typeof report === 'string' ? report : ''
  const oneLine = text.replace(/\s+/g, ' ').trim()
  if (oneLine.length <= max) return oneLine
  return `${oneLine.slice(0, max)}…`
}

/**
 * Build the supervised_status tool definition.
 * @param {object} deps
 * @param {(parent: object) => object} deps.coordinatorFor - coordinator registry for one parent agent
 * @param {(parentId: string) => Promise<object[] | null>} deps.listChildren - DSH catalog cross-check (null when unavailable)
 */
export function createStatusTool(deps) {
  return {
    name: 'supervised_status',
    description: `Render the supervised-child registry of this session: per child the id, name, group, status (running/blocked/completed/terminated), retries, and a truncated report digest; per group the member count and sealed/settled state; plus continuable children in the DSH subagent catalog that this coordinator does not track (flagged untracked). Main agent only.`,
    parameters: {
      type: 'object',
      properties: {},
    },
    output: {
      schema: { type: 'object' },
      render: (_args, value) => [{ type: 'text', text: renderStatus(value) }],
    },
    async execute(_args, exec) {
      const depth = exec.agent?.session?.header?.delegationDepth ?? 0
      if (depth >= 1) throw new Error('supervised_status: only the main agent may inspect supervised children')
      const coordinator = await deps.coordinatorFor(exec.agent)
      const value = collectStatus(coordinator)
      value.untracked = await catalogUntracked(coordinator, exec.agent.id, deps.listChildren)
      return value
    },
  }
}

/** Gather registry state from one coordinator into a plain, renderable value. */
export function collectStatus(coordinator) {
  const children = []
  for (const child of coordinator._children.values()) {
    children.push({
      id: child.id,
      name: child.name,
      group: child.group,
      status: child.status,
      retries: child.retries,
      report: digestReport(child.report),
    })
  }
  const groups = []
  for (const group of coordinator._groups.values()) {
    groups.push({
      name: group.name,
      memberCount: group.memberIds.length,
      sealed: group.sealed === true,
      settled: group.settled === true,
    })
  }
  return { children, groups, untracked: null, meta: coordinator.meta ?? {} }
}

/**
 * Cross-check the DSH catalog: continuable children not tracked by the
 * coordinator are supervision orphans and must be surfaced, never hidden.
 * @returns {Promise<object[] | null>} untracked rows, or null when the catalog is unavailable
 */
export async function catalogUntracked(coordinator, parentId, listChildren) {
  let catalog
  try {
    catalog = await listChildren(parentId)
  } catch {
    return null
  }
  if (!Array.isArray(catalog)) return null
  const untracked = []
  for (const entry of catalog) {
    if (!entry || typeof entry !== 'object') continue
    if (entry.mode !== undefined && entry.mode !== 'continuable') continue
    if (coordinator._children.has(entry.id)) continue
    untracked.push({ id: entry.id, label: entry.label ?? '', mode: entry.mode ?? 'continuable' })
  }
  return untracked
}

/** Model-facing text rendering of the registry value. */
export function renderStatus(value) {
  const lines = []
  const confidence = value.meta?.confidence
  lines.push(`Supervised registry of this session${confidence ? ` (rehydration confidence: ${confidence})` : ''}:`)
  lines.push('')

  if (value.children.length === 0) {
    lines.push('No supervised children in this registry.')
  } else {
    for (const child of value.children) {
      lines.push(`- ${child.name} (${child.id}) — ${child.status} — group "${child.group}" — retries ${child.retries}`)
      if (child.report) lines.push(`  report: ${child.report}`)
    }
  }
  lines.push('')

  if (value.groups.length === 0) {
    lines.push('No supervised groups in this registry.')
  } else {
    for (const group of value.groups) {
      const state = group.settled ? 'settled' : group.sealed ? 'sealed, not settled' : 'not sealed'
      lines.push(`- group "${group.name}" — ${group.memberCount} member(s) — ${state}`)
    }
  }
  lines.push('')

  if (value.untracked === null) {
    lines.push('Untracked-catalog cross-check unavailable (DSH catalog read failed).')
  } else if (value.untracked.length === 0) {
    lines.push('No untracked continuable children in the DSH catalog.')
  } else {
    lines.push('Untracked continuable children in the DSH catalog (not supervised by this registry):')
    for (const entry of value.untracked) {
      lines.push(`- ${entry.id} — label "${entry.label}" — mode ${entry.mode}`)
    }
  }
  return lines.join('\n')
}
