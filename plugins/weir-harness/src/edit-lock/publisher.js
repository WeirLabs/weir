import { lstatSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve as resolvePath } from 'node:path'
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
    /** Release observations are subtractive only; never publication authority.
     * @param {string} path @param {string} cwd */
    releaseResource(path, cwd) {
      assertExclusive()
      const observation = identity.resolve(path, { cwd })
      const resourceId = observation.kind === 'file' ? observation.resourceId : resolvePath(cwd, path)
      contained(resourceId)
      if (observation.kind === 'missing' &&
          (path.split(/[\\/]/).includes('..') || resourceId !== join(observation.ancestor, observation.suffix) || !missingTarget(resourceId))) {
        throw new Error('Edit Lock release refused: missing target is not proven')
      }
      return { resourceId, observation }
    },
    /** Explicit owner release: preserve ordinary admission, but recheck missing
     * evidence inside the manager FIFO rather than trusting a preflight scan.
     * @param {import('./state.js').Ownership} token
     * @param {ReturnType<typeof identity.resolve>} observation */
    async release(token, observation) {
      assertExclusive()
      token = { ...token }
      if (observation.kind === 'file') return manager.release(token)
      const status = manager.status()
      if (token.managerIncarnation !== status.managerIncarnation) throw new Error('stale incarnation')
      const lock = status.locks.find(item => item.resourceId === token.resourceId)
      if (!lock || lock.owner !== token.sessionId) throw new Error('lock not owned by this session')
      const result = await manager.releaseStale([{
        resourceId: token.resourceId, owner: token.sessionId, generation: token.generation,
        executionEpoch: token.executionEpoch, status: lock.status,
      }], resourceId => {
        assertExclusive()
        identity.revalidate(observation)
        return missingTarget(resourceId)
      })
      const refusal = [...result.skipped, ...result.failed]
      if (refusal.length || result.released.length !== 1) {
        throw new Error(`Edit Lock release refused: ${refusal.map(item => item.reason).join('; ') || 'release not confirmed'}`)
      }
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

/** ENOENT alone is insufficient through a symlink or non-directory ancestor.
 * Walk every surviving component without following links; all ambiguity refuses.
 * @param {string} resourceId */
function missingTarget(resourceId) {
  try { lstatSync(resourceId); return false } catch (error) {
    if (/** @type {any} */ (error)?.code !== 'ENOENT') throw error
  }
  for (let parent = dirname(resourceId); ; parent = dirname(parent)) {
    try {
      if (!lstatSync(parent).isDirectory()) return false
    } catch (error) {
      if (/** @type {any} */ (error)?.code !== 'ENOENT' || parent === dirname(parent)) throw error
    }
    if (parent === dirname(parent)) return true
  }
}
