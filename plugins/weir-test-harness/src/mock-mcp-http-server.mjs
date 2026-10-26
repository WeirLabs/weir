// Loopback Streamable HTTP MCP fixture (dev-only). Supports success, zero-tool,
// authorization failure and delayed responses without any package dependency.
import { createServer } from 'node:http'

export async function startMockMcpHttpServer({ tools = [{ name: 'echo', description: 'HTTP echo', inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }], delayMs = 0, status = 200, instructions = 'HTTP_MANAGED_INSTRUCTIONS' } = {}) {
  const requests = []
  const server = createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/mcp') {
      res.writeHead(404).end()
      return
    }
    let body = ''
    req.on('data', chunk => { body += chunk })
    req.on('end', () => {
      const respond = () => {
        let message = null
        try { message = JSON.parse(body || 'null') } catch { /* invalid fixture input */ }
        requests.push({ method: message?.method ?? null, authorization: req.headers.authorization ?? null })
        if (status !== 200) {
          res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ error: 'authorization failed' }))
          return
        }
        if (message?.id === undefined) {
          res.writeHead(202).end()
          return
        }
        const result = message.method === 'initialize'
          ? { protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: 'it-http-mcp', version: '0.0.0' }, instructions }
          : message.method === 'tools/list'
            ? { tools }
            : message.method === 'tools/call'
              ? { content: [{ type: 'text', text: `HTTP_RESULT ${message.params?.arguments?.text ?? ''}` }] }
              : message.method === 'ping' ? {} : { error: 'unsupported' }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: message.id, result }))
      }
      if (delayMs > 0) setTimeout(respond, delayMs)
      else respond()
    })
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  return {
    server,
    requests,
    url: `http://127.0.0.1:${address.port}/mcp`,
    async close() { await new Promise(resolve => server.close(resolve)) },
  }
}
