// Fork-seeding acceptance probe (dev-only, gated on the blackboard-fork
// scenario): seeds the main session's durable board through the product
// kernel, forks the session through the real agents.create path with the
// exact meta shape DSH's session controller produces (depth stays 0,
// parentSession lands in the v4 log header), then asserts the fork's board
// opened as a one-time snapshot of the source root board — entries, counts
// and promotion markers cross; volatile tokens/subscriptions never do — and
// that the source board is left untouched.
import { existsSync, readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { runtimeBlackboard, resolveDurableRoot } from '../../weir-harness/src/blackboard/durable.js'

export function installBlackboardForkProbe(ctx, tap) {
  if (process.env.WEIR_IT_SCENARIO !== 'blackboard-fork') return
  ctx.tools.register({
    name: 'blackboard_fork_check',
    description: 'Isolated blackboard fork-seeding acceptance probe.',
    parameters: { type: 'object', properties: {}, required: [] },
    output: { schema: { type: 'object' }, render: (_args, value) => [{ type: 'text', text: `BLACKBOARD_FORK_CHECK ${JSON.stringify(value)}` }] },
    async execute(_args, { agent }) {
      const runtime = runtimeBlackboard(ctx)
      const id = await resolveDurableRoot(ctx, agent, runtime)
      const cwd = agent.session.header.cwd
      // Seed two entries through the durable kernel (the product path): a
      // contract entry with a read count and the promotion marker, and a map
      // entry with a subscription count.
      await runtime.kernel.write(id, { holderId: id, key: 'knowledge', entryType: 'contract', summary: 'fork probe contract entry', content: 'durable body', ttlMs: 60000 })
      await runtime.kernel.write(id, { holderId: id, key: 'editable', entryType: 'map', summary: 'fork probe map entry', content: 'editable body', ttlMs: 60000 })
      await runtime.kernel.read(id, ['knowledge'])
      await runtime.kernel.apply(id, { holderId: id, key: 'editable', ttlMs: 60000 })
      await runtime.kernel.apply(id, { holderId: 'probe-subscriber', key: 'editable', ttlMs: 60000 })
      await runtime.kernel.markPromoted(id, { key: 'knowledge', destination: 'runtime-map' })
      // Fork through the real product path: the exact shape DSH's session
      // controller produces for a fork (a seeded session requires an explicit
      // constructor seed + inherited prefix length; an empty seed with a zero
      // count is the minimal valid fork and lands the same header meta).
      const forkId = `session-${randomUUID()}`
      const fork = await ctx.agents.create({ sessionId: forkId, seed: [], inheritedEventCount: 0, meta: { cwd, parentSession: id, isSeeded: true } })
      try {
        // The product agent/created hook seeds and materializes the fork
        // board; wait for the canonical sidecar with a bounded deadline.
        const deadline = Date.now() + 10_000
        let where
        for (;;) {
          try {
            const located = await runtime.storage.locate(forkId, cwd)
            if (existsSync(located.file)) { where = located; break }
          } catch { /* the fork log is not materialized yet */ }
          if (Date.now() >= deadline) throw new Error('blackboard fork: seeded sidecar did not appear within 10s')
          await new Promise(resolve => setTimeout(resolve, 50))
        }
        const record = JSON.parse(readFileSync(where.file, 'utf8'))
        const knowledge = record.entries.find(row => row.key === 'knowledge')
        const editable = record.entries.find(row => row.key === 'editable')
        const sourceKeys = (await runtime.kernel.entriesOf(id)).map(row => row.key).sort()
        const forkRead = await runtime.kernel.read(forkId, ['knowledge'], { count: false })
        const report = {
          forkId,
          rootSessionId: record.rootSessionId,
          revision: record.revision,
          knowledge: knowledge ? { content: knowledge.content, readCount: knowledge.readCount, promoted: knowledge.promoted ?? null } : null,
          editable: editable ? { content: editable.content, subscribeCount: editable.subscribeCount } : null,
          forkTokensEmpty: (await runtime.kernel.tokensOf(forkId)).length === 0,
          forkSubscriptionsEmpty: (await runtime.kernel.subscriptionsOf(forkId)).length === 0,
          sourceKeys,
          forkReadContent: forkRead.found[0]?.content ?? null,
        }
        tap({ kind: 'blackboard-fork-check', ...report })
        return report
      } finally {
        await fork.dispose().catch(() => {})
      }
    },
  })
}
