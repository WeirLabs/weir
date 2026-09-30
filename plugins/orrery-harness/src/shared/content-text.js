// Content-block text extraction: the single helper for turning an assistant
// message's content blocks into plain text. The delegate subsystem carried
// three verbatim copies of this logic (tool.js withEscalation, index.js
// supervision feed, index.js readChildFinalText); they converge here so the
// semantics — which blocks count, how they join — have exactly one site.
//
// Deliberately NOT a universal message scanner: callers that must keep
// scanning past a non-array content (readChildFinalText) keep their own guard
// and call this only for the array case.
/**
 * Extract plain text from content blocks.
 * @param {unknown} blocks
 * @returns {string} '' for a non-array; the text blocks joined by '\n'
 */
export function contentText(blocks) {
  if (!Array.isArray(blocks)) return ''
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}
