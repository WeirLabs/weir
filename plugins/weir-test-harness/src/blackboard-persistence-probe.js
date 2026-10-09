// Isolated runtime contract gate. Never enabled outside its named IT scenario.
// The orphan experiment restores its log before the owner's created hook exits.
import { existsSync, readdirSync, readFileSync, realpathSync, unlinkSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import { zstdDecompressSync } from 'node:zlib'
import { createBlackboardStorage } from '../../weir-harness/src/blackboard/storage.js'

async function waitFor(file) {
  const deadline = Date.now() + 60_000
  while (!existsSync(file)) {
    if (Date.now() >= deadline) throw new Error(`probe rendezvous timed out: ${file}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}

export function installBlackboardPersistenceProbe(ctx, tap) {
  if (process.env.WEIR_IT_SCENARIO !== 'blackboard-persistence') return
  const sessions = ctx.get('sessions')
  const persistence = ctx.get('sessionPersistence')
  const home = ctx.get('profileContext')?.home
  const mode = process.env.WEIR_IT_BB_MODE
  const ws = join(process.env.WEIR_IT_ROOT, 'ws')
  ctx.on('agent/created', async ({ agent }) => {
    try {
      const participated = await sessions.flush(agent.session)
      const matches = []
      for (const workspace of readdirSync(join(home, 'sessions'))) {
        const dir = join(home, 'sessions', workspace, agent.id)
        let files
        try { files = readdirSync(dir) } catch { continue }
        for (const file of files.filter(name => /^session\.v\d+\.jsonl(?:\.zstd)?$/.test(name))) {
          const bytes = readFileSync(join(dir, file))
          const text = file.endsWith('.zstd') ? zstdDecompressSync(bytes).toString() : bytes.toString()
          matches.push({ file, dir, header: JSON.parse(text.split('\n')[0]) })
        }
      }
      tap({ kind: 'blackboard-flush', participated, home, id: agent.id, header: agent.session.header, matches })
      if (matches.length !== 1) throw new Error('Expected exactly one isolated canonical log')
      const match = matches[0]
      if (!process.env.WEIR_IT_BB_PHASE) writeFileSync(join(match.dir, match.file + '_bb'), '{}\n', { mode: 0o600 })
      const listed = await persistence.list()
      tap({ kind: 'blackboard-listing', id: agent.id, present: listed.some(row => row.header.id === agent.id) })
      if (mode === 'owner') {
        // Validate the absolute removal target against this throwaway home and
        // the runtime's own header; never operate on a user/desktop profile.
        const expectedHome = realpathSync(join(process.env.WEIR_IT_ROOT, 'home'))
        const actualHome = realpathSync(home)
        const target = realpathSync(join(match.dir, match.file))
        const rel = relative(actualHome, target)
        if (actualHome !== expectedHome || resolve(target) !== target || rel.startsWith('..') || rel.split(sep)[0] !== 'sessions' || match.header.id !== agent.id || match.header.cwd !== agent.session.header.cwd) throw new Error('Unsafe orphan fixture target')
        const bytes = readFileSync(target)
        const lock = join(match.dir, 'session.lock')
        const lockBefore = existsSync(lock) ? readFileSync(lock) : null
        try {
          unlinkSync(target)
          writeFileSync(join(ws, 'blackboard-orphan-ready.json'), JSON.stringify({ id: agent.id, pid: process.pid, target, live: sessions.get(agent.id) === agent.session }))
          await waitFor(join(ws, 'blackboard-orphan-observed.json'))
          const report = { kind: 'blackboard-orphan-owner', id: agent.id, liveAfterObservation: sessions.get(agent.id) === agent.session, lockUnchanged: lockBefore === null ? !existsSync(lock) : readFileSync(lock).equals(lockBefore) }
          writeFileSync(join(ws, 'blackboard-orphan-owner.json'), JSON.stringify(report))
          tap(report)
        } finally {
          writeFileSync(target, bytes, { mode: 0o600 })
        }
      } else if (mode === 'observer') {
        const owner = JSON.parse(readFileSync(join(ws, 'blackboard-orphan-ready.json'), 'utf8'))
        const first = await persistence.stat(owner.id)
        const listed = await persistence.list()
        let writeOpen
        try {
          const handle = await persistence.open(owner.id, 'write')
          await handle.close()
          writeOpen = 'opened'
        } catch (error) { writeOpen = error.name }
        const side = owner.target + '_bb'
        const before = readFileSync(side)
        let productRefused = false
        try { await createBlackboardStorage({ home }).transact(owner.id, undefined, () => { throw new Error('must not reach candidate') }) } catch (error) { productRefused = /log unavailable/.test(String(error)) }
        const sidecarPreserved = readFileSync(side).equals(before)
        const second = await persistence.stat(owner.id)
        let ownerProcessAlive = true
        try { process.kill(owner.pid, 0) } catch { ownerProcessAlive = false }
        const report = { productRefused, sidecarPreserved, owner, ownerProcessAlive, firstAbsent: first === undefined, secondAbsent: second === undefined, listed: listed.some(row => row.header.id === owner.id), writeOpen, localSessionAbsent: sessions.get(owner.id) === undefined }
        writeFileSync(join(ws, 'blackboard-orphan-observed.json'), JSON.stringify(report))
        tap({ kind: 'blackboard-orphan-observer', ...report })
      }
    } catch (error) {
      tap({ kind: 'blackboard-flush-error', error: String(error) })
    }
  })
}
