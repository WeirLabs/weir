import { readFileSync, readdirSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { runtimeBlackboard, resolveDurableRoot } from '../../weir-harness/src/blackboard/durable.js'
import { createBlackboardRemoteService } from '../../weir-harness/src/blackboard/remote.js'
import { createBlackboardStorage } from '../../weir-harness/src/blackboard/storage.js'

export function installBlackboardColdProbe(ctx, tap) {
  const phase = process.env.WEIR_IT_BB_PHASE
  if (!phase) return
  const seen = new Set()
  ctx.on('agent/pre-step', async ({ agent }, next) => {
    if (seen.has(agent.id)) return next()
    seen.add(agent.id)
    const home = ctx.get('profileContext').home
    const storage = createBlackboardStorage({ home })
    const where = await storage.locate(agent.id, agent.session.header.cwd)
    // Observe before any board tool is called: this must be created by product
    // agent/created/catch-up, not by the test's first blackboard access.
    const record = JSON.parse(readFileSync(where.file, 'utf8'))
    tap({ kind: 'blackboard-before-access', phase, id: agent.id, entries: record.entries })
    return next()
  })
  ctx.tools.register({
    name: 'blackboard_persistence_check',
    description: 'Isolated blackboard persistence acceptance probe.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: `BLACKBOARD_COLD_CHECK ${JSON.stringify(value)}` }] },
    async execute(_args, { agent }) {
      const runtime = runtimeBlackboard(ctx)
      const id = await resolveDurableRoot(ctx, agent, runtime)
      const remote = createBlackboardRemoteService()
      const result = { phase }
      const persistence = ctx.get('sessionPersistence')
      // A real host pending Session has no directory or sidecar until flush.
      const pendingId = `session-${randomUUID()}`
      const pending = await persistence.create({ ...agent.session.header, id: pendingId, createdAt: Date.now() })
      try {
        let rejected = false
        try { await runtime.storage.locate(pendingId) } catch { rejected = true }
        const home = ctx.get('profileContext').home
        result.unmaterializedNoSidecar = rejected && readdirSync(join(home, 'sessions')).every(workspace => !readdirSync(join(home, 'sessions', workspace)).includes(pendingId))
      } finally { await pending.close() }
      if (phase === 'seed') {
        await runtime.kernel.apply(id, { holderId: id, key: 'editable', ttlMs: 60000 })
        await runtime.kernel.apply(id, { holderId: 'probe-subscriber', key: 'editable', ttlMs: 60000 })
        result.seed = await remote.read(agent, { keys: ['knowledge', 'editable'] })
      } else {
        result.tokensEmpty = (await runtime.kernel.tokensOf(id)).length === 0
        result.subscriptionsEmpty = (await runtime.kernel.subscriptionsOf(id)).length === 0
        result.restored = await remote.read(agent, { keys: ['knowledge', 'editable'] })
        result.oldTokenRefused = (await remote.write(agent, { key: 'editable', entryType: 'map', summary: 'x', content: 'must not replace' })).ok === false
        result.promotedRefused = (await remote.remove(agent, { key: 'knowledge' })).ok === false
        const before = result.restored.entries.map(row => row.readCount)
        await remote.read(agent, { keys: ['knowledge', 'editable'] })
        result.auditDoesNotCount = JSON.stringify((await remote.read(agent, { keys: ['knowledge', 'editable'] })).entries.map(row => row.readCount)) === JSON.stringify(before)
        await remote.write(agent, { key: 'panel', entryType: 'map', summary: 'panel', content: 'panel body' })
        await remote.apply(agent, { key: 'panel' })
        result.panelRemove = (await remote.remove(agent, { key: 'panel' })).ok
        const parentId = `session-${randomUUID()}`
        const childId = `session-${randomUUID()}`
        for (const [child, parent, depth] of [[parentId, id, 1], [childId, parentId, 2]]) {
          const handle = await persistence.create({ ...agent.session.header, id: child, createdAt: Date.now(), parentSession: parent, delegationDepth: depth })
          await handle.flush(); await handle.close()
        }
        const header = (await runtime.storage.locate(childId)).header
        const root = await resolveDurableRoot(ctx, { id: childId, session: { header } }, runtime)
        result.nestedRoot = root === id && (await runtime.kernel.read(root, ['knowledge'], { count: false })).found[0]?.content === 'durable body'
        const archiveId = `session-${randomUUID()}`
        const archive = await persistence.create({ ...agent.session.header, id: archiveId, createdAt: Date.now() })
        await archive.flush(); await archive.close()
        runtime.kernel.bind(archiveId, agent.session.header.cwd)
        await runtime.kernel.write(archiveId, { holderId: archiveId, key: 'archive', entryType: 'map', summary: 'archive', content: 'preserved', ttlMs: 60000 })
        const archiveWhere = await runtime.storage.locate(archiveId)
        const archiveBefore = readFileSync(archiveWhere.file)
        const registry = ctx.get('workspaceRegistry')
        if (!registry) throw new Error('archive probe requires workspaceRegistry')
        await registry.archiveSession(archiveId)
        const archived = registry.archivedSessionIds.includes(archiveId)
        const archivedRows = await runtime.kernel.entriesOf(archiveId)
        await registry.unarchiveSession(archiveId)
        result.archivePreserved = archived && !registry.archivedSessionIds.includes(archiveId) && archivedRows[0]?.content === 'preserved' && readFileSync(archiveWhere.file).equals(archiveBefore)
        result.noChildSidecars = [parentId, childId].every(child => {
          const home = ctx.get('profileContext').home
          return readdirSync(join(home, 'sessions')).every(workspace => {
            try { return !readdirSync(join(home, 'sessions', workspace, child)).some(name => name.endsWith('_bb')) } catch { return true }
          })
        })
      }
      tap({ kind: 'blackboard-cold-check', ...result })
      return result
    },
  })
}
