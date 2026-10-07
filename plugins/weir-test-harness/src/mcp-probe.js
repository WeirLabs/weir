// MCP-gateway integration probe for the `mcp-gateway` scenario (task 8.2+):
// mounts the real skill-selection plugin against fixture-only roots and
// drives the group-8 surfaces in-process — accepted-selection seeding,
// managed tool invocation, manager listing/adopt, and the zero-RPC evidence
// file. Enabled only when WEIR_IT_MCP=1. Dev-only.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { openCapabilityStore } from '../../weir-harness/src/capabilities/store/store.js'
import * as selectionPlugin from '../../weir-harness/src/capabilities/skill-selection-plugin.js'
import { createApplyEngine } from '../../weir-harness/src/capabilities/apply-engine.js'
import { createSelectionDraft } from '../../weir-harness/src/capabilities/selection-draft.js'
import { createMcpRegistry } from '../../weir-harness/src/capabilities/mcp-registry.js'
import { IT_ROOT } from './mock-kit.js'

const FIXTURES = ['fixture-a']

const namesOf = skills => (Array.isArray(skills) ? skills : []).map(identity => identity?.name ?? null)

function apply(ctx, config = {}) {
  if (config.enabled !== true) return
  selectionPlugin.apply(ctx, {
    machineId: 'weir-it-machine',
    includeDefaultRoots: false,
    customSkillDirs: [join(IT_ROOT, 'ws', 'skill-roots')],
  })
  /** Op outcomes merged into the final report op. */
  const persisted = { adopt: null, listing: null, publicNames: null, startErrors: null }
  ctx.tools.register({
    name: 'mcp_probe',
    description: 'Integration probe: drive the group-8 MCP gateway surfaces (apply, managed call, listing, adopt).',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['apply', 'call', 'list', 'adopt', 'register', 'removeManaged', 'report'] },
        skills: { type: 'array', items: { type: 'string' } },
        mcpServers: { type: 'array', items: { type: 'string' } },
        name: { type: 'string' },
        text: { type: 'string' },
        identity: { type: 'string' },
        _marker: { type: 'string' },
      },
      required: ['op'],
    },
    output: {
      schema: { type: 'object' },
      render: (args, value) => [{ type: 'text', text: `MCP_PROBE ${value.completed ? `done ${args?._marker ?? value.op}${value.op === 'call' && value.result ? `:${String(value.result).slice(0, 140)}` : ''}` : `error:${String(value.error ?? 'unknown').slice(0, 200)}`}` }],
    },
    async execute(args, exec) {
      const report = { completed: false, op: args?.op ?? null }
      try {
        const root = join(IT_ROOT, 'ws', 'skill-roots')
        mkdirSync(join(root, 'fixture-a'), { recursive: true })
        writeFileSync(join(root, 'fixture-a', 'SKILL.md'), '---\nname: fixture-a\ndescription: MCP fixture\n---\nCONTENT_fixture-a\n')
        const sessionId = exec.agent?.session?.id
        const cwd = exec.agent?.session?.header?.cwd ?? join(IT_ROOT, 'ws')
        if (typeof sessionId !== 'string') throw new Error('probe session unavailable')
        const store = openCapabilityStore({ profileContext: ctx.get('profileContext') })
        const selection = selectionPlugin.skillSelectionFor(ctx)
        if (!selection) throw new Error('skill selection plugin not mounted')
        const manager = ctx.get('weirMcpManager')
        const logPath = join(IT_ROOT, 'ws', 'mcp-server-log.jsonl')
        const rpcCount = () => { try { return readFileSync(logPath, 'utf8').split('\n').filter(line => line.includes('"tools/call"')).length } catch { return 0 } }

        if (args.op === 'apply') {
          const engine = createApplyEngine({
            store,
            locateSession: async session => session,
            inventory: options => selection.inventory(options),
            provider: selection.provider,
          })
          const current = await store.read({ kind: 'selection', sessionId })
          const applied = current.kind === 'ok' ? (current.payload?.skills ?? []) : []
          const inventory = await selection.inventory({ cwd, scope: { session: { id: sessionId } } })
          const identities = new Map(inventory.candidates
            .filter(candidate => FIXTURES.includes(candidate.name) && candidate.status === 'parsed')
            .map(candidate => [candidate.name, candidate.identity]))
          const draft = createSelectionDraft({ baseRevision: current.kind === 'ok' ? current.revision : 0, applied: { skills: applied, mcpServers: current.kind === 'ok' ? (current.payload?.mcpServers ?? []) : [] } })
          for (const [name, identity] of identities) draft.toggle(identity, (args.skills ?? []).includes(name))
          const payload = draft.toApplyPayload()
          payload.selection.mcpServers = Array.isArray(args.mcpServers) ? args.mcpServers : []
          const outcome = await engine.apply({ sessionId, cwd }, { requestId: `mcp-${sessionId}-${Date.now()}`, ...payload })
          if (outcome.status === 'applied') {
            selection.lifecycle.publish(sessionId, { revision: outcome.revision, skills: structuredClone(payload.selection.skills), mcpServers: [...payload.selection.mcpServers] })
          }
          report.apply = { status: outcome.status, reason: outcome.reason ?? null, revision: outcome.revision ?? null }
          report.completed = outcome.status === 'applied'
          if (!report.completed) report.error = `engine apply rejected: ${outcome.status} ${outcome.reason ?? ''}`
          return report
        }
        if (args.op === 'call') {
          const before = rpcCount()
          let tool = ctx.tools.get(args.name)
          try {
            // The managed client connects asynchronously: poll briefly for
            // the freshly mounted tool before declaring it invisible.
            for (let attempt = 0; !tool && attempt < 20; attempt += 1) {
              await new Promise(resolve => setTimeout(resolve, 500))
              tool = ctx.tools.get(args.name)
            }
            report.agentView = ctx.tools.get(args.name, exec.agent) !== undefined
            if (!tool) throw new Error(`managed tool not visible: ${args.name}`)
            const result = await tool.execute({ text: args.text ?? '' }, exec)
            report.result = typeof result === 'string' ? result : JSON.stringify(result).slice(0, 200)
            report.rpcDelta = rpcCount() - before
            report.completed = true
            appendFileSync(join(IT_ROOT, 'ws', 'mcp-calls.jsonl'), JSON.stringify({ name: args.name, before, after: rpcCount(), outcome: 'ok' }) + '\n')
          } catch (cause) {
            const startErrors = manager?.startErrors ?? []
            appendFileSync(join(IT_ROOT, 'ws', 'mcp-calls.jsonl'), JSON.stringify({ name: args.name, before, after: rpcCount(), outcome: 'refused', error: cause instanceof Error ? cause.message : String(cause), startErrors, globalView: report.globalView ?? null, agentView: report.agentView ?? null, gammaControl: report.gammaControl ?? null }) + '\n')
            if (startErrors.length > 0) throw new Error(`${cause instanceof Error ? cause.message : String(cause)} | startErrors: ${JSON.stringify(startErrors)}`)
            throw cause
          }
          return report
        }
        if (args.op === 'list') {
          if (!manager) throw new Error('weirMcpManager not mounted')
          persisted.listing = manager.list()
          persisted.publicNames = [...manager.publicNames.entries()]
          persisted.startErrors = manager.startErrors ?? []
          report.listing = persisted.listing
          report.publicNames = persisted.publicNames
          report.startErrors = persisted.startErrors
          report.completed = true
          return report
        }
        if (args.op === 'register') {
          const registry = createMcpRegistry({ store })
          const current = await registry.read()
          const identity = args.identity
          const nodePath = process.execPath
          const outcome = await registry.register({
            identity,
            label: `IT server ${identity}`,
            owner: { kind: 'workspace', key: 'ws' },
            generation: 0,
            configuredAt: 0,
            transport: { kind: 'stdio', ref: `mock://${identity}` },
            client: { transport: 'stdio', serverName: identity, command: nodePath, args: [join(IT_ROOT, '..', 'plugins', 'weir-test-harness', 'src', 'mock-mcp-server.mjs'), identity], env: { WEIR_IT_MCP_LOG: logPath, WEIR_IT_MCP_ORIGIN: 'managed' }, reconnect: { enabled: true } },
          }, current.kind === 'ok' ? current.revision : 0)
          report.register = { status: outcome.status }
          report.completed = outcome.status === 'committed'
          return report
        }
        if (args.op === 'adopt') {
          if (!manager) throw new Error('weirMcpManager not mounted')
          const registry = createMcpRegistry({ store })
          const current = await registry.read()
          persisted.adopt = await manager.adopt((current.servers ?? {})[args.identity] ?? {
            identity: args.identity,
            label: `IT server ${args.identity}`,
            owner: { kind: 'workspace', key: 'ws' },
            transport: { kind: 'stdio', ref: `mock://${args.identity}`, serverName: args.identity },
          })
          report.completed = true
          return report
        }
        if (args.op === 'removeManaged') {
          if (!manager) throw new Error('weirMcpManager not mounted')
          report.remove = await manager.remove(args.identity)
          report.completed = true
          return report
        }
        if (args.op === 'report') {
          report.rpcCount = rpcCount()
          report.adopt = persisted.adopt
          report.listing = persisted.listing
          report.publicNames = persisted.publicNames
          report.startErrors = persisted.startErrors
          mkdirSync(join(IT_ROOT, 'ws'), { recursive: true })
          writeFileSync(join(IT_ROOT, 'ws', 'mcp-gateway-report.json'), JSON.stringify(report, null, 2) + '\n')
          report.completed = true
          return report
        }
        throw new Error(`unknown op: ${String(args.op)}`)
      } catch (cause) {
        report.error = cause instanceof Error ? cause.message : String(cause)
        if (args.op === 'call') report.refused = report.error
        return report
      }
    },
  })
}

export const name = 'weir-it-mcp-probe'
export const inject = ['tools', 'skills']
export { apply }
