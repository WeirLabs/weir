import { createBlackboardStorage } from '../../src/blackboard/storage.js'
import { createDurableBlackboard } from '../../src/blackboard/durable.js'
const [home, key, pause] = process.argv.slice(2)
const storage = createBlackboardStorage({ home, hook: async op => {
  if (pause === 'lock' && op === 'create') { process.stdout.write('LOCKED\n'); await new Promise(() => { setInterval(() => {}, 1000) }) }
} })
const board = createDurableBlackboard({ storage })
try {
  const result = await board.write('session-root', { holderId: 'session-root', key, entryType: 'map', summary: 'worker summary', content: key, ttlMs: 60000 })
  console.log(JSON.stringify({ ok: true, result }))
} catch (error) { console.log(JSON.stringify({ ok: false, error: String(error) })) }
