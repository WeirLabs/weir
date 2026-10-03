import { existsSync, readFileSync, mkdirSync, appendFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, textChunks, toolCallChunks } from './mock-kit.js'

export const stopScenarios = ['predispatch', 'staged', 'publication'].map(boundary => {
  const id = `editlock-stop-${boundary}`
  return {
    id, prompt: `${id}-parent`,
    env: { ORRERY_IT_EDIT_LOCK: '1', ORRERY_IT_STOP_BOUNDARY: boundary },
    observe(obs) { return { editLockToolsSeen: obs.toolNames.includes('edit_lock_status') } },
    async run({ IT_ROOT: root, spawnHeadless, scenarioEnv }) {
      mkdirSync(join(root, 'ws', `stop-${boundary}`), { recursive: true })
      const trace = join(root, `trace-${id}.jsonl`)
      const first = await spawnHeadless(['orrery-it', `${id}-parent`], scenarioEnv(id, trace, this.env))
      const target = join(root, 'ws', `stop-${boundary}`, 'stop-target.txt')
      appendFileSync(trace, JSON.stringify({ kind: 'stop-publication-fact', content: existsSync(target) ? readFileSync(target, 'utf8') : null }) + '\n')
      const trace2 = join(root, `trace-${id}-continue.jsonl`)
      const second = await spawnHeadless(['orrery-it', `${id}-continue`], scenarioEnv(id, trace2, this.env))
      return { scenario: id, trace, trace2, ...first, stderr: first.stderr + second.stderr }
    },
    decide(options, obs) {
      if (obs.transcript.includes(`${id}-continue`)) {
        const count = options.messages.filter(message => message.role === 'tool').length
        if (count === 0) return toolCallChunks('write', { file_path: join(IT_ROOT, 'ws', `unrelated-${boundary}.txt`), content: 'unrelated-write-done\n' })
        if (count === 1) return toolCallChunks('write', { file_path: join(IT_ROOT, 'ws', `stop-${boundary}`, 'stop-target.txt'), content: 'continued\n' })
        return textChunks('continuation finished')
      }
      if (options.messages?.at(-1)?.role === 'tool') return textChunks('stop probe finished')
      if (obs.transcript.includes(`${id}-parent`)) return toolCallChunks('delegate', {
        category: 'quick', prompt: `TASK: Write the marker STOP_CHILD_${boundary}\nDELIVERABLE: file\nSCOPE: one test file\nVERIFY: write result\nSTOP WHEN: written`,
      })
      if (obs.transcript.includes(`STOP_CHILD_${boundary}`)) return toolCallChunks('write', {
        file_path: join(IT_ROOT, 'ws', `stop-${boundary}`, 'stop-target.txt'), content: 'published\n',
      })
      return textChunks('stop probe idle')
    },
    assert(run) {
      const stop = run.records.find(r => r.kind === 'stop-probe')
      run.check('parent and child active at stop', !!stop && stop.parentStatus === 'running' && stop.childStatus === 'running' && stop.abortedBefore === false, JSON.stringify(stop))
      run.check('parent stop synchronously cascades child signal', run.records.some(r => r.kind === 'stop-cascade' && r.aborted))
      const publication = run.records.find(r => r.kind === 'stop-publication-fact')
      run.check('actual publication before cold continuation', !!publication && publication.content === (boundary === 'publication' ? 'published\n' : null))
      const ends = run.records.filter(r => r.kind === 'stop-turn-end')
      run.check('parent turn ends aborted user', ends.some(r => r.session === stop?.parent && r.reason?.kind === 'aborted' && r.reason.reason?.kind === 'user'), JSON.stringify(ends))
      run.check('child turn ends aborted parent', ends.some(r => r.session === stop?.child && r.reason?.kind === 'aborted' && r.reason.reason?.kind === 'parent'), JSON.stringify(ends))
      const file = join(run.ws, `stop-${boundary}`, 'stop-target.txt')
      const unrelated = join(run.ws, `unrelated-${boundary}.txt`)
      const results = run.requests2.filter(r => r.purpose === 'main' && r.lastTool).map(r => r.lastTool)
      run.check('cold new session unrelated admission characterized', boundary === 'staged' ? !existsSync(unrelated) && results[0]?.includes('scope-continuity-unproved') : existsSync(unrelated) && readFileSync(unrelated, 'utf8') === 'unrelated-write-done\n', JSON.stringify(results))
      run.check('target continuation distinguishes fence from version guard', boundary === 'staged'
        ? !existsSync(file) && results[1]?.includes('scope-continuity-unproved')
        : boundary === 'publication'
          ? existsSync(file) && readFileSync(file, 'utf8') === 'published\n' && results[1]?.includes('existing resource requires original version guard')
          : existsSync(file) && readFileSync(file, 'utf8') === 'continued\n', JSON.stringify(results))
      const path = join(run.ws, '.orrery', `edit-lock-${boundary}`, 'snapshot.json')
      const image = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
      const operations = image?.payload?.state?.operations ?? []
      const own = operations.filter(o => o.sessionId === stop?.child)
      run.check('operation phase matches backend outcome', boundary === 'predispatch' ? own.length === 0 : own.length === 1 && own[0].phase === (boundary === 'staged' ? 'unknown' : 'created'), JSON.stringify(image).slice(-2500))
      run.check('headless reports aborted turn', run.code === 1, `code=${run.code} ${run.stderr.slice(-500)}`)
    },
  }
})
