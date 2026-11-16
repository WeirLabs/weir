// Shared tolerant extraction of one JSON object from model text.
//
// The domain evaluator and the Auto Router share one failure taxonomy: a fenced
// or prose-wrapped object is fine, surrounding whitespace is fine, and a
// response that stops mid-object is a TRUNCATION rather than an invalid output
// (the caller retries a truncation with a wider budget). Whether extra fields
// are tolerated stays a per-contract decision: this module only extracts.
//

/**
 * Extract the single JSON object a model response carries, if any.
 * @param {unknown} text
 * @returns {{status:'parsed',value:any}|{status:'empty'}|{status:'invalid'}|{status:'truncated'}}
 */
export function extractJsonObject(text) {
  if (typeof text !== 'string') return { status: 'empty' }
  const cleaned = clean(text)
  if (!cleaned) return { status: 'empty' }
  try {
    return { status: 'parsed', value: JSON.parse(cleaned) }
  } catch (error) {
    if (looksTruncated(text, cleaned, error)) return { status: 'truncated' }
    return { status: 'invalid' }
  }
}

/** Strip code fences and any prose around the first JSON object. @param {string} text */
function clean(text) {
  let value = text.trim()
  if (value.startsWith('```')) value = value.replace(/^```(?:json)?\s*/i, '')
  if (value.endsWith('```')) value = value.slice(0, -3).trim()
  const start = value.indexOf('{')
  const end = value.lastIndexOf('}')
  if (start < 0) return ''
  return value.slice(start, end < start ? value.length : end + 1)
}

/** @param {string} original @param {string} cleaned @param {any} error */
function looksTruncated(original, cleaned, error) {
  return !original.includes('}') || !cleaned.endsWith('}') || /unexpected end|unterminated|end of (?:json )?(?:input|data)/i.test(error?.message ?? '')
}
