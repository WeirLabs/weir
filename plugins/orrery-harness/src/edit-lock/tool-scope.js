import { createManagedWriteTool } from './write-tool.js'

/** Install before an agent is published. The composition must already have
 * mounted hash_edit/LSP with THIS service captured; late replacement is unsafe.
 * Only inherited stock tools are supported. Own-scope stock definitions must be
 * disposed by their owning composition before calling this function.
 * @param {any} agent
 * @param {any} ctx
 * @param {any} service
 * @param {any} sandboxPolicy */
export function installEditLockWriteScope(agent, ctx, service, sandboxPolicy) {
  if (!agent?.ctx?.tools || !service?.publish || !service?.publishBatch) throw new Error('edit lock tool scope requires managed service')
  // Restrictions remain on teardown: unmount must never expose stock writers.
  agent.ctx.tools.restrict({deny:['write','edit']})
  const definition = createManagedWriteTool(ctx, service, sandboxPolicy)
  const dispose = agent.ctx.tools.register(definition)
  if (ctx.tools.get('edit',agent) || ctx.tools.get('write',agent) !== definition) {
    dispose()
    throw new Error('edit lock scope did not exclusively replace stock writers')
  }
  let closed = false
  return () => {
    if (closed) return
    closed = true
    dispose()
  }
}
