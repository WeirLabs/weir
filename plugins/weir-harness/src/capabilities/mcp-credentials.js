// Attempt-scoped DSH credential allocation, materialization and conservative
// compensation. Only random Weir-owned refs are ever unset; unknown registry
// outcomes retain credentials and report indeterminate rather than guessing.
import { createHash, randomUUID } from 'node:crypto'
import { McpLifecycleError } from './mcp-diagnostics.js'
import { validateCredentialRef } from './mcp-config.js'

const hash = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 12)
const clone = value => value == null ? value : structuredClone(value)
const kinds = ['env', 'headers', 'args']

export function collectMcpCredentialRefs(entry) {
  const refs = new Set()
  for (const kind of kinds) for (const value of Object.values(entry?.secretRefs?.[kind] ?? {})) if (value?.ref) refs.add(value.ref)
  if (entry?.secretRefs?.url?.ref) refs.add(entry.secretRefs.url.ref)
  return [...refs]
}

function usedRefs(registryRecord) {
  const used = new Set()
  if (registryRecord?.kind !== 'ok') return used
  for (const entry of Object.values(registryRecord.servers ?? {})) for (const ref of collectMcpCredentialRefs(entry)) used.add(ref)
  return used
}

function credentialName(identity, generation, attemptId, field) {
  return `WEIR_MCP_${hash(identity)}_G${generation}_${attemptId.replaceAll('-', '').slice(0, 16)}_${hash(field)}`
}

/** Allocate unique refs without writing them. A fresh attempt never shares a compensation target. */
export function allocateMcpCredentialAttempt({ identity, generation, attemptId = randomUUID().replaceAll('-', '') }) {
  if (!/^[a-f0-9-]{8,64}$/i.test(attemptId)) throw new TypeError('invalid MCP credential attempt id')
  const ownedRefs = new Set()
  return {
    id: attemptId,
    ownedRefs,
    refFor(field) {
      const ref = credentialName(identity, generation, attemptId, field)
      ownedRefs.add(ref)
      return ref
    },
  }
}

async function resolveValue(credentials, reference) {
  if (!validateCredentialRef(reference)) throw new McpLifecycleError('credential-missing', new Error('invalid credential reference'), { status: 'validation-failed', action: 'configure-credential' })
  let resolved
  try { resolved = await credentials?.resolve?.(reference) } catch (cause) {
    throw new McpLifecycleError('credential-missing', new Error(`credential ${reference} could not be resolved`, { cause }), { status: 'validation-failed', action: 'configure-credential' })
  }
  const value = typeof resolved === 'string' ? resolved : resolved?.value
  if (typeof value !== 'string' || value.length === 0) throw new McpLifecycleError('credential-missing', new Error(`credential ${reference} is missing or empty`), { status: 'validation-failed', action: 'configure-credential' })
  return value
}

/** Resolve refs on every probe/mount/restart; values remain in Host memory only. */
export async function materializeMcpClientConfig(entry, credentials) {
  const client = clone(entry?.client ?? {})
  const resolvedSecrets = []
  const resolve = async reference => {
    const value = await resolveValue(credentials, reference)
    resolvedSecrets.push(value)
    return value
  }
  for (const [key, item] of Object.entries(entry?.secretRefs?.env ?? {})) {
    client.env ??= {}
    client.env[key] = `${item.prefix ?? ''}${await resolve(item.ref)}`
  }
  for (const [key, item] of Object.entries(entry?.secretRefs?.headers ?? {})) {
    client.headers ??= {}
    client.headers[key] = `${item.prefix ?? ''}${await resolve(item.ref)}`
  }
  for (const [key, item] of Object.entries(entry?.secretRefs?.args ?? {})) {
    const index = Number(key)
    if (!Number.isInteger(index) || index < 0 || index >= (client.args?.length ?? 0)) throw new McpLifecycleError('invalid-config', new Error(`secret argument ${key} is out of range`), { status: 'validation-failed' })
    client.args[index] = `${item.prefix ?? ''}${await resolve(item.ref)}`
  }
  if (entry?.secretRefs?.url?.ref) client.url = await resolve(entry.secretRefs.url.ref)
  client.failOnStartupError = true
  delete client.secretRefs
  return { client, resolvedSecrets }
}

/**
 * Apply keep/replace/remove secret actions and stage newly allocated refs.
 * The returned entry contains no transient values. On a partial set failure the
 * function compensates only after a registry reread proves each ref unused.
 */
export async function stageMcpCredentials({ entry, secretValues = {}, credentials, registry, generation, attemptId }) {
  const next = clone(entry)
  next.secretRefs ??= {}
  const attempt = allocateMcpCredentialAttempt({ identity: next.identity, generation, attemptId })
  const writes = []
  const ensureWritable = () => {
    if (typeof credentials?.set !== 'function') throw new McpLifecycleError('unsupported', new Error('DSH credentials are unavailable for new secret values'), { status: 'unsupported', action: 'use-credential-refs' })
  }
  const actionsFor = (kind, key) => {
    const value = secretValues?.[kind]?.[key]
    return typeof value === 'string' ? (value === '' ? { action: 'keep' } : { action: 'replace', value }) : value
  }
  for (const kind of kinds) {
    const keys = new Set([...Object.keys(secretValues?.[kind] ?? {})])
    for (const key of keys) {
      const action = actionsFor(kind, key)
      if (!action || action.action === 'keep') continue
      if (action.action === 'remove') {
        delete next.secretRefs?.[kind]?.[key]
        if (kind === 'env' && next.client?.env) delete next.client.env[key]
        if (kind === 'headers' && next.client?.headers) delete next.client.headers[key]
        if (kind === 'args' && next.client?.args?.[key] !== undefined) next.client.args[key] = ''
        continue
      }
      if (action.action !== 'replace') throw new McpLifecycleError('invalid-config', new Error(`unknown secret action for ${kind}.${key}`), { status: 'validation-failed' })
      ensureWritable()
      const reference = attempt.refFor(`${kind}.${key}`)
      const prefix = Object.hasOwn(action, 'prefix') ? action.prefix : next.secretRefs?.[kind]?.[key]?.prefix
      next.secretRefs[kind] ??= {}
      next.secretRefs[kind][key] = { ref: reference, ...(prefix ? { prefix } : {}) }
      if (kind === 'env' && next.client?.env) delete next.client.env[key]
      if (kind === 'headers' && next.client?.headers) delete next.client.headers[key]
      if (kind === 'args' && next.client?.args?.[key] !== undefined) next.client.args[key] = ''
      writes.push({ ref: reference, value: action.value })
    }
  }
  const urlAction = typeof secretValues.url === 'string' ? { action: 'replace', value: secretValues.url } : secretValues.url
  if (urlAction && urlAction.action !== 'keep') {
    if (urlAction.action === 'remove') {
      delete next.secretRefs.url
      delete next.client.url
    } else if (urlAction.action === 'replace') {
      ensureWritable()
      const reference = attempt.refFor('url')
      next.secretRefs.url = { ref: reference }
      delete next.client.url
      writes.push({ ref: reference, value: urlAction.value })
    } else throw new McpLifecycleError('invalid-config', new Error('unknown secret action for url'), { status: 'validation-failed' })
  }
  for (const kind of kinds) if (next.secretRefs?.[kind] && Object.keys(next.secretRefs[kind]).length === 0) delete next.secretRefs[kind]
  if (next.secretRefs && Object.keys(next.secretRefs).length === 0) delete next.secretRefs
  try {
    for (const write of writes) await credentials.set(write.ref, write.value)
    Object.defineProperty(attempt, 'secrets', { value: Object.freeze(writes.map(write => write.value)), enumerable: false })
    return { status: 'staged', entry: next, attempt }
  } catch (cause) {
    const cleanup = await compensateMcpCredentialAttempt({ attempt, registry, credentials, provenUncommitted: true })
    throw new McpLifecycleError(cleanup.status === 'cleaned' ? 'credential-write-failed' : cleanup.status, cause, {
      status: cleanup.status === 'cleaned' ? 'validation-failed' : cleanup.status,
      cleanup,
      action: cleanup.status === 'cleaned' ? 'retry' : 'inspect-credentials',
      secrets: writes.map(write => write.value),
    })
  }
}

/** Conservative compensation; never deletes user refs or performs orphan GC. */
export async function compensateMcpCredentialAttempt({ attempt, registry, credentials, provenUncommitted }) {
  if (!attempt || attempt.ownedRefs.size === 0) return { status: 'cleaned', unset: [] }
  if (!provenUncommitted) return { status: 'indeterminate', retained: [...attempt.ownedRefs], reason: 'registry-outcome-unknown' }
  let current
  try { current = await registry.read() } catch (cause) {
    return { status: 'indeterminate', retained: [...attempt.ownedRefs], reason: 'registry-reread-failed', diagnostic: String(cause?.message ?? cause) }
  }
  if (!['ok', 'absent'].includes(current?.kind)) return { status: 'indeterminate', retained: [...attempt.ownedRefs], reason: `registry-${current?.kind ?? 'unknown'}` }
  const used = usedRefs(current)
  const unset = []
  const retained = []
  const failures = []
  for (const reference of attempt.ownedRefs) {
    if (used.has(reference)) { retained.push(reference); continue }
    try {
      await credentials.unset(reference)
      unset.push(reference)
    } catch (cause) {
      retained.push(reference)
      failures.push({ ref: reference, message: String(cause?.message ?? cause).slice(0, 512) })
    }
  }
  if (failures.length) return { status: 'cleanup-failed', unset, retained, failures }
  return { status: 'cleaned', unset, retained }
}
