// Unified message-text extraction for the integration harness (design D3).
//
// Single source for "the text of a message": the mock LLM (transcript
// building), the event tap (event summaries) and the driver all share this
// implementation so the same message yields the same text in all three.
// Two input shapes are covered:
//   - a message object whose `content` is a ContentBlock array
//   - a bare ContentBlock array (followup/steer inputs before admission)
// `limit` truncates the joined text (event-tap uses 600); without a limit the
// full text is returned (mock transcript semantics).

/**
 * Extract the joined text blocks of a message or ContentBlock array.
 * @param {unknown} input - message object or bare ContentBlock array
 * @param {{ limit?: number }} [options] - optional truncation length
 * @returns {string} text blocks joined by '\n' ('' for unrecognized shapes)
 */
export function textOf(input, { limit } = {}) {
  const blocks = Array.isArray(input) ? input : Array.isArray(input?.content) ? input.content : null
  if (!blocks) return ''
  const text = blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
  return typeof limit === 'number' ? text.slice(0, limit) : text
}
