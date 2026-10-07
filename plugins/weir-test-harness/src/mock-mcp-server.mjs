// Minimal stdio MCP server for the mcp-gateway scenario (dev-only).
// argv: <serverName> ; env WEIR_IT_MCP_LOG (shared JSONL the scenario reads
// to prove zero-RPC-after-refusal), WEIR_IT_MCP_ORIGIN (host|managed).
import { appendFileSync } from 'node:fs'
import { createInterface } from 'node:readline'
const label = process.argv[2] ?? 'srv'
const origin = process.env.WEIR_IT_MCP_ORIGIN ?? 'unknown'
const log = (kind, data) => { try { appendFileSync(process.env.WEIR_IT_MCP_LOG, JSON.stringify({ src: 'mcp-server', t: Date.now(), pid: process.pid, kind, server: label, origin, ...data }) + '\n') } catch {} }
const send = msg => process.stdout.write(JSON.stringify(msg) + '\n')
log('mcp-server-start', {})
process.on('exit', code => log('mcp-server-exit', { code }))
process.stdin.on('end', () => { log('mcp-server-stdin-end', {}); process.exit(0) })
for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, () => { log('mcp-server-signal', { sig }); process.exit(0) })
const tools = [{ name: 'echo', description: `echo from ${label} (${origin})`, inputSchema: { type: 'object', properties: { text: { type: 'string' } } } }]
createInterface({ input: process.stdin }).on('line', line => {
  let m; try { m = JSON.parse(line) } catch { return }
  if (m.method) log('mcp-server-rpc', { method: m.method, params: m.method === 'tools/call' ? m.params : undefined })
  const ok = result => send({ jsonrpc: '2.0', id: m.id, result })
  switch (m.method) {
    case 'initialize': return ok({ protocolVersion: m.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: true } }, serverInfo: { name: `it-mcp-${label}`, version: '0.0.0' }, instructions: `${label.toUpperCase()}_${origin.toUpperCase()}_INSTRUCTIONS` })
    case 'tools/list': return ok({ tools })
    case 'tools/call': return ok({ content: [{ type: 'text', text: `RESULT server=${label} origin=${origin} pid=${process.pid} text=${m.params?.arguments?.text ?? ''}` }] })
    case 'ping': return ok({})
    default: if (m.id !== undefined) send({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: 'method not found' } })
  }
})
