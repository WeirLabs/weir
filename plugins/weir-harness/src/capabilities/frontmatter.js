// Deliberately reject YAML outside this subset rather than guess its meaning.
export class FrontmatterError extends SyntaxError {}

function scalar(text) {
  const value = text.trim()
  if (!value || value.startsWith('#')) return null
  if (value[0] === '"' || value[0] === "'") {
    const quote = value[0]
    let result = ''
    for (let i = 1; i < value.length; i++) {
      const char = value[i]
      if (char === quote) {
        if (quote === "'" && value[i + 1] === "'") { result += "'"; i++; continue }
        if (!/^\s*(?:#.*)?$/.test(value.slice(i + 1))) throw new FrontmatterError('Trailing quoted scalar content')
        return result
      }
      if (quote === '"' && char === '\\') {
        const escapes = { '0': '\0', a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', e: '\x1b', ' ': ' ', '"': '"', '/': '/', '\\': '\\', N: '\u0085', _: '\u00a0', L: '\u2028', P: '\u2029' }
        const escaped = value[++i]
        if (Object.hasOwn(escapes, escaped)) { result += escapes[escaped]; continue }
        const count = { x: 2, u: 4, U: 8 }[escaped]
        const hex = count && value.slice(i + 1, i + 1 + count)
        if (!count || !hex || hex.length !== count || !/^[\da-f]+$/i.test(hex)) throw new FrontmatterError('Invalid quoted escape')
        const code = parseInt(hex, 16)
        if (code > 0x10ffff) throw new FrontmatterError('Invalid Unicode escape')
        result += String.fromCodePoint(code); i += count
      } else result += char
    }
    throw new FrontmatterError('Unclosed quoted scalar')
  }
  const plain = value.replace(/\s+#.*$/, '').trimEnd()
  if (/^[\[\]{}&*!|>@`%,'"?#]/.test(plain) || /^[-:]\s/.test(plain) || /:\s|:$/.test(plain)) throw new FrontmatterError('Unsupported YAML scalar')
  if (/^(?:null|~)$/i.test(plain)) return null
  if (/^(?:true|false)$/i.test(plain)) return plain.toLowerCase() === 'true'
  if (/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(plain)) return Number(plain)
  // YAML numeric extensions are outside the supported subset.
  if (/^[+-]?(?:0[xob]|\.(?:inf|nan))/i.test(plain)) throw new FrontmatterError('Unsupported YAML number')
  return plain
}

/** Parse flat keys and a single metadata map; no aliases, sequences or multiline values. */
export function parseFrontmatter(raw) {
  if (typeof raw !== 'string') throw new TypeError('Skill text must be a string')
  const lines = raw.split('\n')
  if (lines[0].replace(/\r$/, '') !== '---') throw new FrontmatterError('Missing frontmatter')
  const end = lines.findIndex((line, i) => i > 0 && line.replace(/\r$/, '') === '---')
  if (end < 0) throw new FrontmatterError('Unclosed frontmatter')
  const data = Object.create(null)
  let metadataIndent = null
  let inMetadata = false
  for (const original of lines.slice(1, end)) {
    const line = original.replace(/\r$/, '')
    if (/^\s*(?:#.*)?$/.test(line)) continue
    if (/\t/.test(line.match(/^\s*/)[0])) throw new FrontmatterError('Tabs in indentation')
    const match = /^( *)([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*)|$)/.exec(line)
    if (!match || match[0].length !== line.length) throw new FrontmatterError('Unsupported YAML mapping')
    const [, indent, key, text = ''] = match
    let target = data
    if (indent.length) {
      if (!inMetadata || (metadataIndent !== null && metadataIndent !== indent.length)) throw new FrontmatterError('Unsupported nested mapping')
      metadataIndent = indent.length
      target = data.metadata
    } else {
      inMetadata = false
      metadataIndent = null
    }
    if (Object.hasOwn(target, key)) throw new FrontmatterError('Duplicate YAML key')
    if (!indent.length && key === 'metadata' && /^\s*(?:#.*)?$/.test(text)) {
      data.metadata = Object.create(null)
      inMetadata = true
    } else target[key] = scalar(text)
  }
  if (data.metadata && typeof data.metadata === 'object' && !Object.keys(data.metadata).length) throw new FrontmatterError('metadata requires a nested map')
  return { data, body: lines.slice(end + 1).join('\n').trim() }
}

/** Match the host's invocation field coercion, including quoted 1/0 and yes/no. */
export function frontmatterBoolean(data, key) {
  if (!Object.hasOwn(data, key)) return undefined
  const value = data[key]
  if (typeof value === 'boolean') return value
  if (value === 1 || value === '1') return true
  if (value === 0 || value === '0') return false
  if (typeof value === 'string') {
    if (['true', 'yes', 'on'].includes(value.toLowerCase())) return true
    if (['false', 'no', 'off'].includes(value.toLowerCase())) return false
  }
  throw new TypeError(`frontmatter field "${key}" must be a boolean`)
}

/** Return the host-shaped parsed fields (without a filesystem path). */
export function parseSkillText(raw) {
  const { data, body } = parseFrontmatter(raw)
  for (const key of ['name', 'description']) {
    if (typeof data[key] !== 'string' || !data[key].length) throw new FrontmatterError(`Missing string field: ${key}`)
  }
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(data.name)) throw new FrontmatterError('Invalid skill name')
  for (const key of ['disableModelInvocation', 'modelInvocable', 'userInvocable']) {
    if (Object.hasOwn(data, key)) throw new FrontmatterError(`Unsupported legacy field: ${key}`)
  }
  if (Object.hasOwn(data, 'metadata') && (data.metadata === null || typeof data.metadata !== 'object' || Array.isArray(data.metadata))) throw new FrontmatterError('metadata must be a map')
  return {
    name: data.name, description: data.description,
    ...(typeof data.whenToUse === 'string' && data.whenToUse.length ? { whenToUse: data.whenToUse } : {}),
    invocation: { modelInvocable: frontmatterBoolean(data, 'disable-model-invocation') !== true, userInvocable: frontmatterBoolean(data, 'user-invocable') !== false },
    ...(data.metadata ? { metadata: { ...data.metadata } } : {}),
    content: body,
  }
}
