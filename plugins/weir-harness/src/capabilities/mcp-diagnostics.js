// Secret-free, bounded MCP diagnostics. Raw Error objects, stacks, URLs with
// credentials, and arbitrary cause chains never cross the operation boundary.
export const MCP_DIAGNOSTIC_LIMIT = 8192
const CAUSE_LIMIT = 6

const MESSAGE = value => value instanceof Error ? value.message : String(value ?? 'unknown error')

/** Replace every known secret before applying pattern-based redaction. */
export function sanitizeMcpText(value, secrets = []) {
  let text = String(value ?? '')
  const known = [...new Set(secrets.filter(secret => typeof secret === 'string' && secret.length > 0))]
    .sort((a, b) => b.length - a.length)
  for (const secret of known) text = text.split(secret).join('[redacted]')
  // Authorization lines and common secret-bearing key/value spellings.
  text = text.replace(/\b(?:proxy-)?authorization\s*:\s*[^\r\n,;}]+/gi, match => `${match.split(':')[0]}: [redacted]`)
  text = text.replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
  text = text.replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-jwt]')
  text = text.replace(/\b(?:api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|secret|client[-_]?secret)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;}]+)/gi, (_match, key, separator) => `${key}${separator}[redacted]`)
  // Shell/environment assignments. Values may be quoted; the key remains useful.
  text = text.replace(/\b[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|[^\s]+)/g, assignment => `${assignment.slice(0, assignment.indexOf('='))}=[redacted]`)
  // Any sensitive URL component makes the whole userinfo/query/fragment tail
  // sensitive. Preserve only scheme/host/path for actionable diagnostics.
  text = text.replace(/\b(?:https?|wss?):\/\/[^\s<>"']+/gi, candidate => {
    const trailing = candidate.match(/[.,;:!?)]*$/)?.[0] ?? ''
    const raw = trailing ? candidate.slice(0, -trailing.length) : candidate
    try {
      const url = new URL(raw)
      if (!url.username && !url.password && !url.search && !url.hash) return candidate
      return `${url.protocol}//${url.host}${url.pathname}[redacted-url]${trailing}`
    } catch {
      return '[redacted-url]'
    }
  })
  return text
}

export function sanitizeMcpPayload(value, secrets = []) {
  if (typeof value === 'string') return sanitizeMcpText(value, secrets)
  if (Array.isArray(value)) return value.map(item => sanitizeMcpPayload(item, secrets))
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, sanitizeMcpPayload(item, secrets)]))
  }
  return value
}

const RULES = [
  ['credential-missing', /credential[- ]missing|credential.*(?:not configured|empty|missing)|missing.*credential/i, 'Configure a non-empty credential reference, then retry.'],
  ['name-conflict', /serverName.*(?:already in use|conflict)|name[- ]conflict|namespace.*conflict/i, 'Choose a unique public server name or remove the conflicting registration.'],
  ['executable-not-found', /\bENOENT\b|executable.*(?:not found|unavailable)|command.*not found|cannot find.*(?:command|executable)/i, 'Check the command and its GUI PATH resolution, then retry.'],
  ['permission-denied', /\bEACCES\b|\bEPERM\b|permission denied|access denied/i, 'Check executable and credential/file permissions, then retry.'],
  ['connection-refused', /ECONNREFUSED|connection refused/i, 'Check that the server is listening and the endpoint is correct, then retry.'],
  ['http-unauthorized', /\bHTTP\s*40[13]\b|\b40[13]\b|unauthorized|forbidden/i, 'Check the HTTP credential reference and server authorization policy.'],
  ['timeout', /timeout|timed out|deadline exceeded/i, 'Inspect server startup and connectivity, then retry with a healthy server.'],
  ['invalid-config', /invalid config|validation|unsupported transport|unknown (?:option|field)|initialDelayMs|maxDelayMs/i, 'Correct the marked configuration field and preview again.'],
  ['cleanup-unknown', /cleanup-unknown|closure could not be confirmed|unconfirmed (?:transport )?clos/i, 'Inspect residue before retrying; an immediate same-name replacement is blocked.'],
  ['cleanup-failed', /cleanup-failed|dispose(?:d|al)?(?: rejection| failed)|remove rejection/i, 'Inspect the cleanup diagnostic and recover the remaining Loader entry before retrying.'],
  ['unsupported', /unsupported|ephemeral.*unavailable/i, 'Use a secret-free configuration or a Host with the required ephemeral Loader support.'],
  ['owner-changed', /owner-changed|preset.*changed|ownership.*changed/i, 'Return to the original session/preset and preview again.'],
]

export function classifyMcpError(error, secrets = []) {
  const evidence = []
  let current = error
  for (let depth = 0; current && depth < CAUSE_LIMIT; depth += 1) {
    evidence.push(`${current?.code ?? ''} ${MESSAGE(current)}`)
    current = current?.cause
  }
  const text = sanitizeMcpText(evidence.join('\n'), secrets)
  const match = RULES.find(([, pattern]) => pattern.test(text))
  if (!match) return { code: 'unknown-error', hint: 'Inspect the sanitized diagnostic and retry after correcting the cause.' }
  return { code: match[0], hint: match[2] }
}

function boundedMessage(text, max = 4096) {
  const clean = String(text)
  return Buffer.byteLength(clean) <= max ? clean : Buffer.from(clean).subarray(0, max - 1).toString().replace(/\uFFFD+$/g, '') + '…'
}

/**
 * Convert an Error/cause chain into one stable secret-free diagnostic. Both
 * individual strings and the complete JSON projection are bounded to 8 KiB.
 */
export function mcpDiagnostic(error, options = {}) {
  const secrets = options.secrets ?? []
  const classified = options.code ? { code: options.code, hint: options.hint } : classifyMcpError(error, secrets)
  const causes = []
  let current = error
  for (let depth = 0; current && depth < CAUSE_LIMIT; depth += 1) {
    causes.push(boundedMessage(sanitizeMcpText(MESSAGE(current), secrets), 1024))
    current = current?.cause
  }
  const first = causes[0] ?? boundedMessage(sanitizeMcpText(MESSAGE(error), secrets), 1024)
  let diagnostic = {
    code: classified.code ?? 'unknown-error',
    message: boundedMessage(sanitizeMcpText(options.message ?? first, secrets)),
    hint: boundedMessage(sanitizeMcpText(options.hint ?? classified.hint ?? 'Retry after correcting the cause.'), 1024),
    recovery: { action: options.action ?? 'retry' },
    causes,
  }
  while (Buffer.byteLength(JSON.stringify(diagnostic)) > MCP_DIAGNOSTIC_LIMIT && diagnostic.causes.length > 1) {
    diagnostic.causes.pop()
  }
  if (Buffer.byteLength(JSON.stringify(diagnostic)) > MCP_DIAGNOSTIC_LIMIT) {
    diagnostic.message = boundedMessage(diagnostic.message, 2048)
    diagnostic.hint = boundedMessage(diagnostic.hint, 512)
  }
  return diagnostic
}

export class McpLifecycleError extends Error {
  constructor(code, error, options = {}) {
    const diagnostic = mcpDiagnostic(error, { ...options, code, hint: options.hint })
    super(diagnostic.message, options.cause === undefined && error instanceof Error ? { cause: error } : {})
    this.name = 'McpLifecycleError'
    this.code = code
    this.status = options.status ?? code
    this.diagnostic = diagnostic
    this.cleanup = options.cleanup
  }
}
