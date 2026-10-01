import { isAbsolute, relative } from 'node:path'
import { createResourceIdentity } from './resource-identity.js'
import { canonicalRequestData } from './request-data.js'

/** Bind the original host filesystem once; never substitute a Node write fallback.
 * The trusted host owns policy provenance, execution authentication, exclusive
 * manager lifetime and exclusion of external topology writers.
 * @param {{manager: ReturnType<typeof import('./manager.js').createEditLockManager>,
 * fs: {resolve: (path: string, options: {cwd: string}) => Promise<any>, writeText: (...args: any[]) => Promise<{version: string}>}, root: string}} options */
export function createPublisher({ manager, fs, root }) {
  if (!isAbsolute(root)) throw new Error('absolute domain root required')
  const resolve = fs.resolve.bind(fs)
  const writeText = fs.writeText.bind(fs)
  const identity = createResourceIdentity()
  /** @type {WeakMap<object, () => void>} */
  const listeners = new WeakMap()
  /** @param {string} path */
  function contained(path) {
    const suffix = relative(root, path)
    if (suffix === '..' || suffix.startsWith('../') || isAbsolute(suffix)) throw new Error('outside management domain')
  }
  return Object.freeze({
    /** Trusted adapter only: content is the fully synthesized original tool payload.
     * @param {import('./state.js').Execution} execution
     * @param {{operationId: string, tool: 'write'|'hash_edit', filePath: string, cwd: string,
     * args: unknown, content: string, effectivePolicy: any,
     * expected: {kind: 'createIfAbsent'}|{kind: 'replaceIfVersion', version: string}}} request
     * @param {AbortSignal} signal */
    async prepare(execution, request, signal) {
      const data = JSON.parse(canonicalRequestData(request))
      execution = { ...execution }
      const historical = manager.history(execution.sessionId, data.operationId)
      if (historical) {
        if (canonicalRequestData(data.expected) !== canonicalRequestData(historical.binding.target.policy)) throw new Error('ID_REUSE: original guard differs')
        return manager.prepare(execution, { ...data, target: historical.binding.target }, {
          validate() { throw new Error('historical operation cannot dispatch') },
          publish() { throw new Error('historical operation cannot dispatch') },
          identify() { throw new Error('historical operation cannot dispatch') },
        })
      }
      const abort = () => {
        try { void manager.cancel(execution).catch(() => {}) } catch { /* stale execution cannot revoke a newer one */ }
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      const detach = () => signal.removeEventListener('abort', abort)
      try {
      if (signal.aborted) throw new Error('call aborted')
      if (!['workspace-write', 'danger-full-access'].includes(data.effectivePolicy?.mode)) throw new Error('writable effective policy required')
      const observation = identity.resolve(data.filePath, { cwd: data.cwd })
      contained(observation.kind === 'file' ? observation.resourceId : observation.ancestor)
      const target = await resolve(data.filePath, { cwd: data.cwd })
      let descriptor
      if (observation.kind === 'missing') {
        if (data.tool !== 'write' || data.expected.kind !== 'createIfAbsent') throw new Error('creation requires explicit write intent')
        descriptor = { kind: 'create', ancestor: observation.ancestor, suffix: observation.suffix, policy: data.expected }
      } else {
        if (data.expected.kind !== 'replaceIfVersion') throw new Error('existing resource requires original version guard')
        const { tokens: [ownership] } = await manager.acquireMany(execution, [observation.resourceId])
        descriptor = { kind: 'update', resourceId: observation.resourceId, generation: ownership.generation, policy: data.expected }
      }
      const validate = () => {
        if (signal.aborted) throw new Error('call aborted')
        if (data.effectivePolicy?.mode === 'read-only') throw new Error('read-only policy')
        identity.revalidate(observation)
      }
      const ready = await manager.prepare(execution, { ...data, target: descriptor }, {
        validate,
        publish: () => writeText(target, data.content, data.expected, signal, data.effectivePolicy),
        identify: () => {
          const current = identity.resolve(data.filePath, { cwd: data.cwd })
          if (current.kind !== 'file') throw new Error('published resource missing')
          contained(current.resourceId)
          if (observation.kind === 'missing') {
            const suffix = relative(observation.ancestor, current.resourceId)
            if (suffix === '..' || suffix.startsWith('../') || isAbsolute(suffix)) throw new Error('published resource escaped fence')
          }
          return current.resourceId
        },
      })
      if (ready.kind === 'ready' && ready.submission) listeners.set(ready.submission, detach)
      else detach()
      return ready
      } catch (error) { detach(); throw error }
    },
    /** @param {object} submission */
    async commit(submission) {
      try { return await manager.commit(submission) }
      finally { listeners.get(submission)?.(); listeners.delete(submission) }
    },
  })
}
