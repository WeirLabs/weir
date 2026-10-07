// Shared helpers for building proper UserMessage objects for
// steer/followup/inject (the inbox admits raw objects verbatim, so every
// injected message must carry id/role/content/source — a bare ContentBlock[]
// crashes downstream listeners that read message.source.kind).

/**
 * @param {string} text
 * @param {string} sourceKind - producer tag, e.g. 'weir-todo-driver'
 * @returns {object} a UserMessage-shaped object
 */
export function userTextMessage(text, sourceKind) {
  return {
    id: crypto.randomUUID(),
    role: 'user',
    content: [{ type: 'text', text }],
    source: { kind: sourceKind },
  }
}
