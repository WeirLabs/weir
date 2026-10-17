// Generic HTTP JSON helpers for the host-side admin endpoints: Response
// shaping and request-body reading shared by the lsp, settings, and notify
// admin modules. Sunk verbatim out of src/lsp/admin.js
// (subsystem-seam-hygiene, D2); the LSP-specific error namespace
// (errorResponse) and endpoint assembly (wireLspAdmin) stay in src/lsp/.

export function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** Read the JSON body of a connection request (Request-like or stream). */
export async function readJsonBody(request) {
  try {
    if (typeof request?.json === 'function') return await request.json()
  } catch {
    return null
  }
  try {
    const chunks = []
    for await (const chunk of request?.body ?? []) chunks.push(Buffer.from(chunk))
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return null
  }
}
