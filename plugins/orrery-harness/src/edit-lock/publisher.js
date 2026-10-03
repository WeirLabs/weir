import { isAbsolute, join, relative } from 'node:path'
import { createResourceIdentity } from './resource-identity.js'
import { canonicalRequestData } from './request-data.js'

/** Bind the original host filesystem once; never substitute a Node write fallback.
 * The trusted host owns policy provenance, execution authentication, exclusive
 * manager lifetime and exclusion of external topology writers.
 * @param {{manager: ReturnType<typeof import('./manager.js').createEditLockManager>,
 * fs: {resolve: (path: string, options: {cwd: string}) => Promise<any>, writeText: (...args: any[]) => Promise<{version: string}>}, root: string, excluded?: string[], assertExclusive?: () => void}} options */
export function createPublisher({ manager, fs, root, excluded = [], assertExclusive = () => {} }) {
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
    for (const protectedPath of excluded) {
      const inner = relative(protectedPath, path)
      if (inner === '' || (!inner.startsWith('..') && !isAbsolute(inner))) throw new Error('Edit Lock authority files are not editable')
    }
  }
  return Object.freeze({
    /** Canonical identity of one existing in-domain regular file; never a
     * creation key and never a permission. @param {string} path @param {string} cwd */
    resource(path, cwd) {
      assertExclusive()
      const observation = identity.resolve(path, { cwd })
      if (observation.kind !== 'file') throw new Error('lock target must be an existing regular file')
      contained(observation.resourceId)
      return observation.resourceId
    },
    /** Resolve the entire existing-file set before atomic ownership acquisition.
     * @param {import('./state.js').Execution} execution
     * @param {string[]} paths @param {string} cwd */
    acquireBatch(execution, paths, cwd) {
      assertExclusive()
      const observations = paths.map(path => {
        const observation = identity.resolve(path, { cwd })
        if (observation.kind !== 'file') throw new Error('rename requires existing regular files')
        contained(observation.resourceId)
        return observation
      })
      if (new Set(observations.map(item => item.resourceId)).size !== paths.length) throw new Error('duplicate canonical rename target')
      return manager.acquireMany(execution, observations.map(item => item.resourceId)).then(ownership => ({
        ...ownership, ordered: observations.map(item => ownership.tokens.find(/** @param {import('./state.js').Ownership} token */ token => token.resourceId === item.resourceId)),
      }))
    },
    /** Trusted adapter only: content is the fully synthesized original tool payload.
     * @param {import('./state.js').Execution} execution
     * @param {{operationId: string, tool: 'write'|'hash_edit'|'lsp_rename', filePath: string, cwd: string,
     * args: unknown, content: string, effectivePolicy: any,
     * batchOwnership?: import('./state.js').Ownership,
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
      // The lexical creation target too: a missing protected subtree is not an escape.
      if (observation.kind === 'missing') contained(join(observation.ancestor, observation.suffix))
      const target = await resolve(data.filePath, { cwd: data.cwd })
      let descriptor
      if (observation.kind === 'missing') {
        if (data.tool !== 'write' || data.expected.kind !== 'createIfAbsent') throw new Error('creation requires explicit write intent')
        descriptor = { kind: 'create', ancestor: observation.ancestor, suffix: observation.suffix, policy: data.expected }
      } else {
        if (data.expected.kind !== 'replaceIfVersion') throw new Error('existing resource requires original version guard')
        let ownership = data.batchOwnership
        if (data.tool === 'lsp_rename') {
          if (!ownership || ownership.resourceId !== observation.resourceId || ownership.sessionId !== execution.sessionId ||
              ownership.executionEpoch !== execution.executionEpoch || ownership.managerIncarnation !== execution.managerIncarnation) throw new Error('rename batch ownership changed')
          manager.checkWrite(ownership)
        } else {
          const acquired = await manager.acquireMany(execution, [observation.resourceId])
          ownership = acquired.tokens[0]
        }
        descriptor = { kind: 'update', resourceId: observation.resourceId, generation: ownership.generation, policy: data.expected }
      }
      const validate = () => {
        assertExclusive()
        if (signal.aborted) throw new Error('call aborted')
        if (data.effectivePolicy?.mode === 'read-only') throw new Error('read-only policy')
        identity.revalidate(observation)
      }
      const ready = await manager.prepare(execution, { ...data, target: descriptor }, {
        validate,
        // Admission still observes the turn signal. Once invoked, join the host
        // commit independently: Stop revokes future work, not this dispatched write.
        publish: () => writeText(target, data.content, data.expected, new AbortController().signal, data.effectivePolicy),
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
