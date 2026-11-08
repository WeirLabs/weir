// Disposable real-Desktop decision spike host. Never included in a product profile.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { apply as applyMock } from '../../../src/mock-llm.js'

export const name = 'weir-decision-desktop-spike'
export const inject = ['llm', 'tools', 'cordisInspect']
const OUT = process.env.WEIR_DECISION_DESKTOP_OUT

function writeJson(file, value) {
  if (!OUT) throw new Error('WEIR_DECISION_DESKTOP_OUT is required')
  mkdirSync(OUT, { recursive: true })
  writeFileSync(join(OUT, file), JSON.stringify(value, null, 2) + '\n')
}

export function apply(ctx) {
  applyMock(ctx)
  writeJson('host-mounted.json', {
    pid: process.pid,
    execPath: process.execPath,
    electron: process.versions.electron,
    node: process.versions.node,
    profile: ctx.get('profileContext'),
  })
  const registry = ctx.get('workspaceRegistry')
  if (!registry) throw new Error('workspaceRegistry unavailable in disposable Desktop profile')
  ctx.tools.register({
    name: 'decision_slot_probe',
    description: 'Disposable read-only query through the real Client Slots inspect provider.',
    parameters: { type: 'object', properties: { phase: { type: 'string', enum: ['before', 'after'] } }, required: ['phase'] },
    output: {
      schema: { type: 'object' },
      render: (args, value) => [{ type: 'text', text: `DECISION_SLOT_PROBE ${JSON.stringify(value)}` }],
    },
    async execute(args, exec) {
      const roots = ['sidebar.panellist', 'main', 'conversation.input.right']
      const query = {}
      for (const root of roots) {
        query[root] = await ctx.cordisInspect.query('client', 'Slots', 'listSubTree', { root }, exec.agent, exec.signal)
      }
      const snapshot = { phase: args.phase, sessionId: exec.agent.id, roots: query }
      writeJson(`slot-tree-${args.phase}.json`, snapshot)
      if (args.phase === 'after') {
        const beforePath = join(OUT, 'slot-tree-before.json')
        const before = existsSync(beforePath) ? JSON.parse(readFileSync(beforePath, 'utf8')) : null
        writeJson('slot-tree.json', { before, after: snapshot, pass: before !== null })
      }
      return { completed: true, phase: args.phase, sessionId: exec.agent.id, roots }
    },
  })
}
