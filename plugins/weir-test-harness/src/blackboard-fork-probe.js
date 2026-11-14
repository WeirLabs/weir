// Fork-seeding acceptance probe (dev-only, gated on the blackboard-fork
// scenario): seeds the main session's durable board through the product
// kernel, forks the session through the REAL host path — a `session/fork`
// Remote dispatched by the gateway into the Session Controller, which builds
// the seed and calls agents.create — and asserts the fork's board opened as a
// one-time snapshot of the source root board: entries, counts and promotion
// markers cross; volatile tokens/subscriptions never do; the source board is
// left untouched.
//
// The probe also pins the host's ACTUAL fork shape (no parentSession in the
// header, meta carrying only cwd/isSeeded), because the previous version of
// this file fabricated the old shape and stayed green through the host change
// that silently disabled seeding.
import { existsSync, readFileSync } from 'node:fs'
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
      // Fork through the real host path: the GUI asks the gateway for
      // `session/fork`, and the Session Controller resolves the source, builds
      // the seed and calls agents.create with meta { cwd, isSeeded } — no
      // parentSession, no replacement provenance field.
      const gateway = ctx.get?.('typertGateway')
      if (typeof gateway?.dispatchRpc !== 'function') throw new Error('blackboard fork: typertGateway is unavailable')
      const agents = ctx.get?.('agents')
      const originalCreate = agents.create
      const creates = []
      agents.create = async function (options, ...rest) {
        const out = await originalCreate.call(this, options, ...rest)
        creates.push({ sessionId: options?.sessionId, metaKeys: Object.keys(options?.meta ?? {}).sort(), inheritedEventCount: options?.inheritedEventCount ?? null })
        return out
      }
      let forked
      try {
        const peer = { principal: { kind: 'owner' }, interactions: 'none', signal: new AbortController().signal }
        const result = await gateway.dispatchRpc('session/fork', { args: { request: { sessionId: id, atSeq: 0 } } }, peer.signal, peer)
        if (result?.ok !== true) throw new Error(`blackboard fork: session/fork failed (${result?.error?.code ?? 'unknown'}: ${result?.error?.message ?? ''})`)
        forked = result.value?.sessionId
      } finally {
        if (agents.create !== originalCreate) agents.create = originalCreate
      }
      const forkId = forked
      if (typeof forkId !== 'string' || forkId.length === 0) throw new Error('blackboard fork: session/fork returned no child session id')
      const fork = ctx.get?.('agents')?.get?.(forkId)
      const childHeader = fork?.session?.header
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
          // The host shape this probe exists to pin.
          childHeader: childHeader ? { parentSession: childHeader.parentSession ?? null, isSeeded: childHeader.isSeeded ?? null } : null,
          forkMeta: creates.find(row => row.sessionId === forkId) ?? null,
        }
        tap({ kind: 'blackboard-fork-check', ...report })
        return report
      } finally {
        await fork?.dispose?.().catch?.(() => {})
      }
    },
  })
}
