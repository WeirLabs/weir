// One MCP configuration parser/projection for forms, JSON paste, commands, AI,
// registry previews and stock-client materialization. Unknown fields fail before
// any operation side effect; secret values never appear in the returned plan.
import { createHash } from 'node:crypto'
import { isSegment } from './store/paths.js'
import { sanitizeMcpText } from './mcp-diagnostics.js'

export const MCP_LIMITS = Object.freeze({
  documentBytes: 1024 * 1024,
  batchEntries: 32,
  args: 128,
  env: 64,
  headers: 64,
  planBytes: 256 * 1024,
  toolNamesPreview: 20,
  diagnosticBytes: 8192,
})
const SERVER_NAME = /^[A-Za-z0-9_-]{1,32}$/
const CREDENTIAL_REF = /^[A-Za-z_][A-Za-z0-9_]*$/
const COMMON = new Set(['transport', 'type', 'serverName', 'toolCallTimeoutMs', 'maxInstructionBytes', 'reconnect', 'failOnStartupError'])
const ROOT = new Set(['identity', 'label', 'owner', 'incarnation', 'generation', 'configuredAt', 'client', 'transport', 'secretRefs', 'secretValues', ...COMMON, 'command', 'args', 'env', 'cwd', 'url', 'headers', 'secretArgs'])
const RECONNECT = new Set(['enabled', 'initialDelayMs', 'maxDelayMs', 'maxAttempts'])
const clone = value => value == null ? value : structuredClone(value)
const object = value => value && typeof value === 'object' && !Array.isArray(value)

export class McpConfigError extends TypeError {
  constructor(field, message) {
    super(`${field}: ${message}`)
    this.name = 'McpConfigError'
    this.code = 'invalid-config'
    this.field = field
  }
}
const fail = (field, message) => { throw new McpConfigError(field, message) }
const known = (value, allowed, path) => {
  for (const key of Object.keys(value)) if (!allowed.has(key)) fail(`${path}.${key}`, 'unknown field')
}
const positive = (value, field, integer = false) => {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || (integer && !Number.isSafeInteger(value))) fail(field, 'must be a positive finite number')
  return value
}
const ref = (value, field) => {
  if (!object(value) || typeof value.ref !== 'string' || !CREDENTIAL_REF.test(value.ref)) fail(field, 'must be a POSIX credential reference')
  known(value, new Set(['ref', 'prefix']), field)
  if (value.prefix !== undefined && typeof value.prefix !== 'string') fail(`${field}.prefix`, 'must be a string')
  return { ref: value.ref, ...(value.prefix ? { prefix: value.prefix } : {}) }
}
const sensitiveUrl = value => {
  try {
    const url = new URL(value)
    return Boolean(url.username || url.password || url.search || url.hash)
  } catch { return true }
}
const safeHttpUrl = (value, field) => {
  let url
  try { url = new URL(value) } catch { fail(field, 'must be an absolute URL') }
  if (!['http:', 'https:'].includes(url.protocol)) fail(field, 'only http/https URLs are supported')
  return url
}

function reconnectOf(value) {
  if (value === undefined) return undefined
  if (!object(value)) fail('reconnect', 'must be an object')
  known(value, RECONNECT, 'reconnect')
  const out = {}
  if (value.enabled !== undefined) {
    if (typeof value.enabled !== 'boolean') fail('reconnect.enabled', 'must be boolean')
    out.enabled = value.enabled
  }
  for (const key of ['initialDelayMs', 'maxDelayMs']) if (value[key] !== undefined) out[key] = positive(value[key], `reconnect.${key}`)
  if (value.maxAttempts !== undefined) out.maxAttempts = positive(value.maxAttempts, 'reconnect.maxAttempts', true)
  if ((out.initialDelayMs ?? 500) > (out.maxDelayMs ?? 30000)) fail('reconnect.initialDelayMs', 'must not exceed maxDelayMs')
  return out
}

function secretInput(value, field, surface) {
  if (!object(value)) {
    if (value === '') return { action: 'keep' }
    if (surface !== 'ui') fail(field, 'literal secrets are accepted only by the Host mutation channel; use a credential reference')
    if (typeof value !== 'string') fail(field, 'secret values must be strings')
    return { action: 'replace', value }
  }
  known(value, new Set(['action', 'value']), field)
  const action = value.action ?? 'replace'
  if (!['keep', 'replace', 'remove'].includes(action)) fail(`${field}.action`, 'must be keep, replace or remove')
  if (action === 'replace') {
    if (surface !== 'ui') fail(field, 'literal secrets are accepted only by the Host mutation channel; use a credential reference')
    if (typeof value.value !== 'string' || value.value.length === 0) fail(`${field}.value`, 'replacement secrets must be non-empty strings; blank means keep')
  }
  return { action, ...(action === 'replace' ? { value: value.value } : {}) }
}

function secretMap(input, field, limit, surface) {
  if (input === undefined) return { refs: {}, values: {}, literals: {}, legacy: {} }
  if (!object(input)) fail(field, 'must be an object')
  const entries = Object.entries(input)
  if (entries.length > limit) fail(field, `exceeds the ${limit}-entry limit`)
  const refs = {}, values = {}, literals = {}, legacy = {}
  for (const [key, value] of entries) {
    if (!key || Buffer.byteLength(key) > 256) fail(field, 'contains an invalid key')
    if (typeof value === 'string') {
      // New UI/JSON literal env/header values are staged credentials. The
      // registry adapter may explicitly preserve a legacy record instead.
      if (surface === 'legacy') legacy[key] = value
      else if (surface === 'refs' && value !== '') fail(`${field}.${key}`, 'literal secrets are not accepted; use a credential reference')
      else values[key] = value === '' ? { action: 'keep' } : { action: 'replace', value }
    } else if (object(value) && typeof value.ref === 'string') refs[key] = ref(value, `${field}.${key}`)
    else values[key] = secretInput(value, `${field}.${key}`, surface)
  }
  return { refs, values, literals, legacy }
}

function refsOf(input, field) {
  if (!object(input)) return {}
  known(input, new Set(['env', 'headers', 'args', 'url']), field)
  const out = {}
  for (const kind of ['env', 'headers', 'args']) {
    if (input[kind] === undefined) continue
    if (!object(input[kind])) fail(`${field}.${kind}`, 'must be an object')
    out[kind] = {}
    for (const [key, value] of Object.entries(input[kind])) out[kind][key] = ref(value, `${field}.${kind}.${key}`)
  }
  if (input.url !== undefined) out.url = ref(input.url, `${field}.url`)
  return out
}

function normalizeTransport(input, client) {
  const kind = client.transport ?? client.type ?? input.transport?.kind ?? (typeof client.command === 'string' ? 'stdio' : typeof client.url === 'string' || object(client.url) ? 'streamable-http' : undefined)
  if (kind === 'http') return 'streamable-http'
  if (kind !== 'stdio' && kind !== 'streamable-http') fail('transport', 'must be stdio or streamable-http')
  return kind
}

/** Normalize one server. surface=ui permits transient secretValues; refs-only surfaces never do. */
export function normalizeMcpServer(raw, options = {}) {
  if (!object(raw)) fail('server', 'must be an object')
  known(raw, ROOT, 'server')
  const surface = options.surface ?? 'ui'
  if (!['ui', 'refs', 'legacy'].includes(surface)) fail('surface', 'unknown input surface')
  const clientInput = raw.client ?? raw
  if (!object(clientInput)) fail('client', 'must be an object')
  const kind = normalizeTransport(raw, clientInput)
  const allowed = new Set(kind === 'stdio' ? ['command', 'args', 'env', 'cwd', 'secretArgs'] : ['url', 'headers'])
  known(clientInput, new Set([...COMMON, ...allowed, 'identity', 'label', 'owner', 'incarnation', 'generation', 'configuredAt', 'client', 'secretRefs', 'secretValues']), 'client')
  const identity = options.identity ?? raw.identity
  if (!isSegment(identity)) fail('identity', 'must be a stable identity segment')
  const label = raw.label ?? identity
  if (typeof label !== 'string' || !label.trim() || Buffer.byteLength(label) > 512) fail('label', 'must be a non-empty bounded string')
  const serverName = clientInput.serverName ?? identity
  if (typeof serverName !== 'string' || !SERVER_NAME.test(serverName)) fail('serverName', 'must match [A-Za-z0-9_-]{1,32}')
  const client = { transport: kind, serverName, failOnStartupError: true }
  for (const key of ['toolCallTimeoutMs', 'maxInstructionBytes']) if (clientInput[key] !== undefined) client[key] = positive(clientInput[key], key, key === 'maxInstructionBytes')
  const reconnect = reconnectOf(clientInput.reconnect)
  if (reconnect) client.reconnect = reconnect
  const secretRefs = { env: {}, headers: {}, args: {} }
  const secretValues = { env: {}, headers: {}, args: {} }
  const legacy = { env: {}, headers: {} }
  const existingRefs = refsOf(raw.secretRefs, 'secretRefs')
  Object.assign(secretRefs.env, existingRefs.env ?? {})
  Object.assign(secretRefs.headers, existingRefs.headers ?? {})
  Object.assign(secretRefs.args, existingRefs.args ?? {})
  if (existingRefs.url) secretRefs.url = existingRefs.url

  if (kind === 'stdio') {
    if (clientInput.url !== undefined || clientInput.headers !== undefined) fail('client', 'HTTP fields cannot be combined with stdio')
    if (typeof clientInput.command !== 'string' || !clientInput.command.trim()) fail('command', 'is required')
    client.command = clientInput.command
    const args = clientInput.args ?? []
    if (!Array.isArray(args) || args.length > MCP_LIMITS.args) fail('args', `must be an array of at most ${MCP_LIMITS.args} entries`)
    client.args = args.map((value, index) => {
      if (typeof value === 'string') return value
      if (object(value) && typeof value.ref === 'string') {
        secretRefs.args[index] = ref(value, `args.${index}`)
        return ''
      }
      fail(`args.${index}`, 'must be a string or credential reference')
    })
    if (clientInput.secretArgs !== undefined) {
      if (!object(clientInput.secretArgs)) fail('secretArgs', 'must be an object keyed by argument index')
      for (const [key, value] of Object.entries(clientInput.secretArgs)) {
        const index = Number(key)
        if (!Number.isInteger(index) || index < 0 || index >= client.args.length) fail(`secretArgs.${key}`, 'argument index is out of range')
        if (object(value) && typeof value.ref === 'string') secretRefs.args[index] = ref(value, `secretArgs.${key}`)
        else secretValues.args[index] = secretInput(value, `secretArgs.${key}`, surface)
      }
    }
    const env = secretMap(clientInput.env, 'env', MCP_LIMITS.env, surface)
    Object.assign(secretRefs.env, env.refs)
    Object.assign(secretValues.env, env.values)
    Object.assign(legacy.env, env.legacy)
    if (clientInput.cwd !== undefined) {
      if (typeof clientInput.cwd !== 'string') fail('cwd', 'must be a string')
      client.cwd = clientInput.cwd
    }
  } else {
    if (clientInput.command !== undefined || clientInput.args !== undefined || clientInput.env !== undefined || clientInput.cwd !== undefined || clientInput.secretArgs !== undefined) fail('client', 'stdio fields cannot be combined with streamable-http')
    if (object(clientInput.url) && typeof clientInput.url.ref === 'string') secretRefs.url = ref(clientInput.url, 'url')
    else if (typeof clientInput.url === 'string') {
      const url = safeHttpUrl(clientInput.url, 'url')
      if (sensitiveUrl(clientInput.url)) {
        if (surface !== 'ui') fail('url', 'sensitive URLs require a credential reference')
        secretValues.url = { action: 'replace', value: clientInput.url }
      } else client.url = url.toString()
    } else if (clientInput.url !== undefined) secretValues.url = secretInput(clientInput.url, 'url', surface)
    else if (!secretRefs.url) fail('url', 'is required')
    const headers = secretMap(clientInput.headers, 'headers', MCP_LIMITS.headers, surface)
    Object.assign(secretRefs.headers, headers.refs)
    Object.assign(secretValues.headers, headers.values)
    Object.assign(legacy.headers, headers.legacy)
  }
  if (raw.secretValues !== undefined) {
    if (!object(raw.secretValues)) fail('secretValues', 'must be an object')
    known(raw.secretValues, new Set(['env', 'headers', 'args', 'url']), 'secretValues')
    for (const [field, limit] of [['env', MCP_LIMITS.env], ['headers', MCP_LIMITS.headers], ['args', MCP_LIMITS.args]]) {
      const values = raw.secretValues[field]
      if (values === undefined) continue
      if (!object(values)) fail(`secretValues.${field}`, 'must be an object')
      if (Object.keys(values).length > limit) fail(`secretValues.${field}`, `exceeds the ${limit}-entry limit`)
      for (const [key, value] of Object.entries(values)) secretValues[field][key] = secretInput(value, `secretValues.${field}.${key}`, surface)
    }
    if (raw.secretValues.url !== undefined) secretValues.url = secretInput(raw.secretValues.url, 'secretValues.url', surface)
  }
  const hasRefs = Object.values(secretRefs).some(value => object(value) && Object.keys(value).length > 0)
  const hasLegacy = Object.keys(legacy.env).length > 0 || Object.keys(legacy.headers).length > 0
  const entry = {
    identity,
    label,
    owner: clone(raw.owner ?? options.owner ?? { kind: 'global', key: 'installation' }),
    ...(raw.incarnation !== undefined ? { incarnation: raw.incarnation } : {}),
    generation: raw.generation ?? 0,
    configuredAt: raw.configuredAt ?? 0,
    transport: { kind, ref: kind === 'stdio' ? `cmd:${client.command}` : client.url ? `http:${client.url}` : 'http:credential-ref' },
    client: { ...client, ...(kind === 'stdio' ? { env: legacy.env } : { headers: legacy.headers }) },
    secretRefs,
  }
  if (Object.keys(secretRefs.env).length === 0) delete entry.secretRefs.env
  if (Object.keys(secretRefs.headers).length === 0) delete entry.secretRefs.headers
  if (Object.keys(secretRefs.args).length === 0) delete entry.secretRefs.args
  if (Object.keys(entry.secretRefs).length === 0) delete entry.secretRefs
  const transient = Object.keys(secretValues.env).length || Object.keys(secretValues.headers).length || Object.keys(secretValues.args).length || secretValues.url
  return {
    entry,
    secretValues: transient ? secretValues : {},
    hasSecrets: Boolean(hasRefs || hasLegacy || transient),
    legacyLiteralSecrets: hasLegacy,
  }
}

export function parseMcpDocument(input, options = {}) {
  let document = input
  if (typeof input === 'string') {
    if (Buffer.byteLength(input) > MCP_LIMITS.documentBytes) fail('document', `exceeds the ${MCP_LIMITS.documentBytes}-byte limit`)
    try { document = JSON.parse(input) } catch { fail('document', 'must be valid JSON') }
  }
  if (!object(document)) fail('document', 'must be an object')
  const batch = Object.hasOwn(document, 'mcpServers')
  if (batch) {
    known(document, new Set(['mcpServers']), 'document')
    if (!object(document.mcpServers)) fail('mcpServers', 'must be an object')
  }
  const entries = batch ? Object.entries(document.mcpServers) : [[undefined, document]]
  if (entries.length < 1 || entries.length > MCP_LIMITS.batchEntries) fail('mcpServers', `must contain between 1 and ${MCP_LIMITS.batchEntries} servers`)
  const identities = new Set()
  const normalized = entries.map(([key, value], index) => {
    const identity = key ?? value?.identity
    if (identities.has(identity)) fail(`mcpServers.${identity}`, 'duplicate identity')
    identities.add(identity)
    try {
      return normalizeMcpServer(value, { ...options, identity: identity ?? options.identity })
    } catch (error) {
      if (error instanceof McpConfigError) throw new McpConfigError(batch ? `mcpServers.${key ?? index}.${error.field}` : error.field, error.message.slice(error.message.indexOf(': ') + 2))
      throw error
    }
  })
  const plan = normalized.map((item, index) => ({ index, identity: item.entry.identity, entry: redactMcpEntry(item.entry), fingerprint: fingerprintMcpEntry(item.entry) }))
  assertMcpPlanSize(plan)
  const result = { plan, digest: createHash('sha256').update(JSON.stringify(plan)).digest('hex') }
  // Execution-only normalized entries (including transient secretValues) stay
  // reachable to Host operations but can never leak into a serialized preview.
  Object.defineProperty(result, 'entries', { value: normalized, enumerable: false })
  return result
}

export function redactMcpEntry(entry, secrets = []) {
  const out = clone(entry)
  if (out?.client?.env) for (const key of Object.keys(out.client.env)) out.client.env[key] = '[redacted]'
  if (out?.client?.headers) for (const key of Object.keys(out.client.headers)) out.client.headers[key] = '[redacted]'
  for (const index of Object.keys(out?.secretRefs?.args ?? {})) if (out.client?.args?.[index] !== undefined) out.client.args[index] = '[redacted]'
  if (out?.client?.url && sensitiveUrl(out.client.url)) out.client.url = '[redacted-url]'
  delete out.secretValues
  return sanitizeMcpTextProjection(out, secrets)
}
function sanitizeMcpTextProjection(value, secrets) {
  if (typeof value === 'string') return sanitizeMcpText(value, secrets)
  if (Array.isArray(value)) return value.map(item => sanitizeMcpTextProjection(item, secrets))
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeMcpTextProjection(item, secrets)]))
  return value
}

/** Hash the full record (including legacy literals) without returning those literals. */
export function fingerprintMcpEntry(entry) {
  return createHash('sha256').update(JSON.stringify(entry ?? null)).digest('hex')
}
export function assertMcpPlanSize(plan) {
  const bytes = Buffer.byteLength(JSON.stringify(plan))
  if (bytes > MCP_LIMITS.planBytes) fail('plan', `exceeds the ${MCP_LIMITS.planBytes}-byte limit`)
  return bytes
}
export function hasMcpSecrets(entry) {
  if (entry?.secretRefs && Object.keys(entry.secretRefs).length > 0) return true
  if (Object.keys(entry?.client?.env ?? {}).length > 0 || Object.keys(entry?.client?.headers ?? {}).length > 0) return true
  return typeof entry?.client?.url === 'string' && sensitiveUrl(entry.client.url)
}
export function isSensitiveMcpUrl(value) { return sensitiveUrl(value) }
export function validateCredentialRef(value) { return typeof value === 'string' && CREDENTIAL_REF.test(value) }
