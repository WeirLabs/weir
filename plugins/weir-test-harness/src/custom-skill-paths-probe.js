// Dev-only end-to-end probe for Profile-scoped custom Skill scan paths. The
// path reads/writes go through the shipped Typert gateway; Select/Apply and
// Skill loading use the real preset-mounted selection plugin and stock tool.
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { join, sep } from 'node:path'
import {
  CAPABILITY_MUTATION_NAMESPACE,
  CAPABILITY_READ_NAMESPACE,
} from '../../weir-harness/src/capabilities/capability-remote.js'
import { skillIdentityKey } from '../../weir-harness/src/capabilities/skill-identity.js'
import { skillSelectionFor } from '../../weir-harness/src/capabilities/skill-selection-plugin.js'
import { createSkillScanPathRegistry } from '../../weir-harness/src/capabilities/skill-scan-path-registry.js'
import { openCapabilityStore } from '../../weir-harness/src/capabilities/store/store.js'
import { IT_ROOT } from './mock-kit.js'
import { textOf } from './message-text.js'

const SKILL_NAME = 'custom-scan-path-fixture'
const SKILL_BODY = 'CUSTOM_SCAN_PATH_SKILL_BODY'
const REPORT_NAME = 'custom-skill-paths.json'

function messageReport(messages) {
  return messages.map(message => ({ source: message?.source?.kind ?? null, text: textOf(message) }))
}

async function loadReport(tool, agent, exec) {
  try {
    const value = await tool.execute({ name: SKILL_NAME }, { ...exec, agent })
    return {
      name: value?.name ?? null,
      content: typeof value?.content === 'string' ? value.content : null,
      error: typeof value?.error === 'string' ? value.error : null,
    }
  } catch (cause) {
    return { name: null, content: null, error: cause instanceof Error ? cause.message : String(cause) }
  }
}

function apply(ctx, config = {}) {
  if (config.enabled !== true) return
  ctx.tools.register({
    name: 'custom_skill_paths_probe',
    description: 'Integration probe: drive custom Skill scan paths through the real capability gateway, selection Apply engine, and Skill loader.',
    parameters: { type: 'object', properties: {}, additionalProperties: false },
    output: {
      schema: { type: 'object' },
      // Keep the real temporary path and all failure detail in the report, never
      // in this model-facing tool result.
      render: (_args, value) => [{ type: 'text', text: value?.completed ? 'CUSTOM_SKILL_PATHS done' : 'CUSTOM_SKILL_PATHS error' }],
    },
    async execute(_args, exec) {
      const report = { sessionId: null, canonicalPath: null, steps: {}, cleanup: { errors: [] } }
      let scanRoot
      let handle
      let unregister
      try {
        // A unique real directory, with a valid child Skill, owned entirely by
        // this scenario and removed in finally below.
        scanRoot = await mkdtemp(join(IT_ROOT, 'ws', 'custom-skill-paths-'))
        report.canonicalPath = await realpath(scanRoot)
        await mkdir(join(scanRoot, SKILL_NAME))
        await writeFile(join(scanRoot, SKILL_NAME, 'SKILL.md'), `---\nname: ${SKILL_NAME}\ndescription: Custom scan path integration fixture\n---\n${SKILL_BODY}\n`)

        const presets = ctx.get('agentPresets')
        const gateway = ctx.get('typertGateway')
        if (!presets || !gateway) throw new Error(`real agentPresets/typertGateway required (presets=${Boolean(presets)} gateway=${Boolean(gateway)})`)
        unregister = await presets.register({ id: 'weir', plugins: [
          {
            id: 'weir-skill-selection',
            name: 'weir-test-harness/skill-selection',
            config: {
              machineId: 'weir-it-machine',
              readPresetId: 'weir',
              includeDefaultRoots: false,
              customSkillDirs: [],
              // Keep the pre-Add applied set explicitly empty. Custom discovery
              // itself must never widen this baseline.
              baselineScopes: [],
              dshHome: join(IT_ROOT, 'home'),
              agentsHome: join(IT_ROOT, 'agents-home'),
            },
          },
          { id: 'tool-skill', name: '@deepseek-ai/dsh-tool-skill' },
        ] })
        const resolved = await presets.resolve('weir')
        if (resolved?.broken) throw new Error(`real preset failed to resolve: ${JSON.stringify(resolved.broken)}`)
        handle = await ctx.agents.create({
          sessionId: randomUUID(),
          meta: { cwd: join(IT_ROOT, 'ws'), agentPreset: 'weir' },
          setup: agentCtx => presets.mount(agentCtx, 'weir').then(() => undefined),
        })
        const agent = handle.agent
        report.sessionId = agent.id
        const selection = skillSelectionFor(agent.ctx) ?? skillSelectionFor(ctx)
        if (!selection) throw new Error('real preset selection face did not mount')
        const profileContext = ctx.get('profileContext')
        const selectionUnit = { kind: 'selection', sessionId: agent.id }
        const readSelectionRecord = () => openCapabilityStore({ profileContext }).read(selectionUnit)
        const readRegistryFresh = () => createSkillScanPathRegistry({
          store: openCapabilityStore({ profileContext }),
        }).read()

        const rpc = async (endpoint, args) => {
          const peer = { principal: { kind: 'owner' }, interactions: 'none', signal: exec.signal }
          const result = await gateway.dispatchRpc(endpoint, { args }, exec.signal, peer)
          if (result?.ok !== true) throw new Error(`${endpoint} failed: ${result?.error?.code ?? 'unknown'} ${result?.error?.message ?? ''}`)
          return result.value
        }
        const read = method => rpc(`${CAPABILITY_READ_NAMESPACE}/${method}`, { sessionId: agent.id })
        const modelBoundary = async () => {
          const messages = []
          const decision = await agent.ctx.waterfall(
            'agent/pre-step',
            { agent, messages, signal: exec.signal },
            async () => ({ kind: 'continue', messages }),
          )
          return messageReport(decision?.messages ?? messages)
        }
        const pathOperation = async (name, operation) => {
          const before = await agent.session.snapshotEvents()
          let value
          let error = null
          try { value = await operation() } catch (cause) { error = cause instanceof Error ? cause.message : String(cause) }
          const after = await agent.session.snapshotEvents()
          const modelNotifications = await modelBoundary()
          report.steps[name] = {
            value: value ?? null,
            error,
            eventPrefixIntact: before.every((event, index) => event?.seq === after[index]?.seq && event?.type === after[index]?.type),
            sessionEventDelta: after.slice(before.length).map(event => ({ seq: event?.seq ?? null, type: event?.type ?? null })),
            modelNotifications,
          }
          if (error !== null) throw new Error(`${name}: ${error}`)
          return value
        }
        const mutate = method => rpc(`${CAPABILITY_MUTATION_NAMESPACE}/${method}`, {
          sessionId: agent.id,
          request: method === 'skillPathAdd'
            ? { path: `${scanRoot}${sep}.${sep}`, expectedRevision: report.steps.initialPaths.value.revision }
            : { path: report.canonicalPath, expectedRevision: report.steps.add.value.revision },
        })

        report.initialReceipt = await read('receipt')
        report.initialListing = await read('list')
        report.initialSelectionRecord = await readSelectionRecord()
        await pathOperation('initialPaths', () => read('skillPaths'))

        await pathOperation('add', () => mutate('skillPathAdd'))
        await pathOperation('reread', () => read('skillPaths'))
        // A new store AND registry instance must see the committed canonical
        // directory, not merely the accepting service's in-memory response.
        report.registryReinstantiated = await readRegistryFresh()
        report.listingAfterAdd = await read('list')
        report.receiptAfterAdd = await read('receipt')
        report.candidate = report.listingAfterAdd?.skills?.find(row => row?.name === SKILL_NAME && row?.identity?.root === report.canonicalPath) ?? null
        if (!report.candidate?.identity) throw new Error('add did not expose the custom candidate through the production listing')
        report.identityKey = skillIdentityKey(report.candidate.identity)

        report.apply = await selection.applySelection(
          { sessionId: agent.id, cwd: agent.session.header.cwd, presetId: 'weir' },
          {
            requestId: randomUUID(),
            expectedRevision: report.initialReceipt.revision,
            selection: { skills: [report.candidate.identity], mcpServers: [] },
            unresolved: [],
          },
        )
        report.selectionRecordAfterApply = await readSelectionRecord()
        const tool = ctx.tools.get('skill', agent)
        if (!tool) throw new Error('stock Skill tool did not mount in the real preset')
        report.loadAfterApply = await loadReport(tool, agent, exec)

        // Drain the ordinary Apply notice before testing removal. This makes an
        // empty post-remove boundary a precise proof that path removal itself
        // queued no model-facing notification.
        report.applyNoticeBoundary = await modelBoundary()
        report.applyNoticePendingAfterDrain = selection.hasPendingNotification(agent.id)

        await pathOperation('remove', () => mutate('skillPathRemove'))
        await pathOperation('pathsAfterRemove', () => read('skillPaths'))
        report.registryAfterRemoveReinstantiated = await readRegistryFresh()
        report.listingAfterRemove = await read('list')
        report.loadAfterRemove = await loadReport(tool, agent, exec)
        report.receiptAfterRemove = await read('receipt')
        report.selectionRecordAfterRemove = await readSelectionRecord()

        // Existing fail-closed Apply behavior names the exact missing identity.
        // It must reject before writing, leaving the accepted record untouched.
        report.missingIdentityApply = await selection.applySelection(
          { sessionId: agent.id, cwd: agent.session.header.cwd, presetId: 'weir' },
          {
            requestId: randomUUID(),
            expectedRevision: report.apply?.revision ?? report.receiptAfterRemove?.revision ?? 0,
            selection: { skills: [report.candidate.identity], mcpServers: [] },
            unresolved: [],
          },
        )
        report.selectionRecordAfterMissingReport = await readSelectionRecord()
        report.finalModelBoundary = await modelBoundary()
      } catch (cause) {
        report.error = cause instanceof Error ? cause.stack ?? cause.message : String(cause)
      } finally {
        if (handle) {
          try { await handle.dispose(); report.cleanup.agentDisposed = true }
          catch (cause) { report.cleanup.errors.push(`agent dispose: ${cause instanceof Error ? cause.message : String(cause)}`) }
        }
        if (unregister) {
          try { await unregister(); report.cleanup.presetUnregistered = true }
          catch (cause) { report.cleanup.errors.push(`preset unregister: ${cause instanceof Error ? cause.message : String(cause)}`) }
        }
        if (scanRoot) {
          try { await rm(scanRoot, { recursive: true, force: true }) }
          catch (cause) { report.cleanup.errors.push(`temporary directory: ${cause instanceof Error ? cause.message : String(cause)}`) }
        }
        report.cleanup.temporaryDirectoryExists = scanRoot ? existsSync(scanRoot) : null
      }
      report.completed = report.error === undefined && report.cleanup.errors.length === 0
      await writeFile(join(IT_ROOT, 'ws', REPORT_NAME), JSON.stringify(report, null, 2) + '\n')
      return { completed: report.completed }
    },
  })
}

export const name = 'weir-it-custom-skill-paths-probe'
export const inject = ['tools', 'skills', 'agents', 'agentPresets']
export { apply }
