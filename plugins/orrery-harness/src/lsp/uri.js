// file:// URI codec for the LSP integration: a zero-import pure leaf, so
// pure cores (rename synthesis) never import the lifecycle manager for it.
// Moved verbatim out of manager.js (lsp-child-process-module change, D4).

/** file:// URI for an absolute path. */
export function pathToUri(absolutePath) {
  const normalized = absolutePath.replace(/\\/g, '/')
  const withLeadingSlash = normalized.startsWith('/') ? normalized : `/${normalized}`
  return `file://${encodeURI(withLeadingSlash).replace(/#/g, '%23').replace(/\?/g, '%3F')}`
}

/** Absolute path back from a file:// URI. */
export function uriToPath(uri) {
  if (typeof uri !== 'string' || !uri.startsWith('file://')) return uri
  const decoded = decodeURIComponent(uri.slice('file://'.length))
  // file:///C:/ws/a.ts decodes to /C:/ws/a.ts — strip the leading slash on
  // drive-letter paths; POSIX paths (no drive-letter shape) keep theirs.
  return decoded.replace(/^\/([A-Za-z]:[\/])/, '$1')
}
