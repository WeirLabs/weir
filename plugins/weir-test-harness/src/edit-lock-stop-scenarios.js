import { existsSync, readFileSync, mkdirSync, appendFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, textChunks, toolCallChunks } from './mock-kit.js'

export const stopScenarios = ['predispatch', 'staged', 'publication', 'update'].map(boundary => {
  const id = `editlock-stop-${boundary}`
  return {
    id, prompt: `${id}-parent`,
    env: { WEIR_IT_EDIT_LOCK: '1', WEIR_IT_STOP_BOUNDARY: boundary },
    observe(obs) { return { editLockToolsSeen: obs.toolNames.includes('edit_lock_status') } },
    async run({ IT_ROOT: root, spawnHeadless, scenarioEnv }) {
      mkdirSync(join(root, 'ws', `stop-${boundary}`), { recursive: true })
      if (boundary === 'update') {
        writeFileSync(join(root, 'ws', `stop-${boundary}`, 'stop-target.txt'), 'before\n')
        writeFileSync(join(root, 'ws', `unrelated-${boundary}.txt`), 'unrelated-before\n')
      }
      const trace = join(root, `trace-${id}.jsonl`)
      const first = await spawnHeadless(['weir-it', `${id}-parent`], scenarioEnv(id, trace, this.env))
      const target = join(root, 'ws', `stop-${boundary}`, 'stop-target.txt')
      appendFileSync(trace, JSON.stringify({ kind: 'stop-publication-fact', content: existsSync(target) ? readFileSync(target, 'utf8') : null }) + '\n')
      const trace2 = join(root, `trace-${id}-continue.jsonl`)
      const second = await spawnHeadless(['weir-it', `${id}-continue`], scenarioEnv(id, trace2, this.env))
      appendFileSync(trace, JSON.stringify({ kind: 'stop-continuation-exit', code: second.code }) + '\n')
      return { scenario: id, trace, trace2, ...first, stderr: first.stderr + second.stderr }
    },
    decide(options, obs) {
      if (obs.transcript.includes(`${id}-continue`)) {
        const count = options.messages.filter(message => message.role === 'tool').length
        if (count === 0) return toolCallChunks('write', { file_path: join(IT_ROOT, 'ws', `unrelated-${boundary}.txt`), content: 'unrelated-write-done\n' })
        if (count === 1) return toolCallChunks('write', { file_path: join(IT_ROOT, 'ws', `stop-${boundary}`, 'stop-target.txt'), content: 'continued\n' })
        return textChunks('continuation finished')
      }
      const toolResults = options.messages.filter(message => message.role === 'tool').length
      if (obs.transcript.includes(`STOP_CHILD_${boundary}`)) {
        const file_path = join(IT_ROOT, 'ws', `stop-${boundary}`, 'stop-target.txt')
        if (boundary === 'update' && toolResults === 0) return toolCallChunks('read', { file_path })
        if (toolResults === (boundary === 'update' ? 1 : 0)) return toolCallChunks('write', { file_path, content: 'published\n' })
        return textChunks('stop probe finished')
      }
      if (toolResults > 0) return textChunks('stop probe finished')
      if (obs.transcript.includes(`${id}-parent`)) return toolCallChunks('delegate', {
        category: 'quick', prompt: `TASK: Write the marker STOP_CHILD_${boundary}\nDELIVERABLE: file\nSCOPE: one test file\nVERIFY: write result\nSTOP WHEN: written`,
      })
      return textChunks('stop probe idle')
    },
    assert(run) {
      const stop = run.records.find(r => r.kind === 'stop-probe')
      run.check('parent and child active at stop', !!stop && stop.parentStatus === 'running' && stop.childStatus === 'running' && stop.abortedBefore === false && stop.parentAbortedBefore === false, JSON.stringify(stop))
      run.check('parent stop synchronously aborts both original signals', run.records.some(r => r.kind === 'stop-cascade' && r.aborted && r.parentAborted))
      const publication = run.records.find(r => r.kind === 'stop-publication-fact')
      run.check('actual publication before cold continuation', !!publication && publication.content === (boundary === 'predispatch' ? null : 'published\n'))
      const ends = run.records.filter(r => r.kind === 'stop-turn-end')
      run.check('parent turn ends aborted user', ends.some(r => r.session === stop?.parent && r.reason?.kind === 'aborted' && r.reason.reason?.kind === 'user'), JSON.stringify(ends))
      run.check('child turn ends aborted parent', ends.some(r => r.session === stop?.child && r.reason?.kind === 'aborted' && r.reason.reason?.kind === 'parent'), JSON.stringify(ends))
      const file = join(run.ws, `stop-${boundary}`, 'stop-target.txt')
      const unrelated = join(run.ws, `unrelated-${boundary}.txt`)
      const results = run.requests2.filter(r => r.purpose === 'main' && r.lastTool).map(r => r.lastTool)
      run.check('cold continuation process exits successfully', run.records.some(r => r.kind === 'stop-continuation-exit' && r.code === 0))
      run.check('cold new session unrelated admission characterized', boundary === 'update'
        ? results[0]?.includes('existing resource requires original version guard') && readFileSync(unrelated, 'utf8') === 'unrelated-before\n'
        : existsSync(unrelated) && readFileSync(unrelated, 'utf8') === 'unrelated-write-done\n', JSON.stringify(results))
      run.check('target continuation distinguishes version guard from fence', boundary !== 'predispatch'
        ? existsSync(file) && readFileSync(file, 'utf8') === 'published\n' && results[1]?.includes('existing resource requires original version guard')
        : existsSync(file) && readFileSync(file, 'utf8') === 'continued\n', JSON.stringify(results))
      const path = join(run.ws, '.weir', `edit-lock-${boundary}`, 'snapshot.json')
      const image = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null
      const operations = image?.payload?.state?.operations ?? []
      const own = operations.filter(o => o.sessionId === stop?.child)
      run.check('operation phase matches backend outcome', boundary === 'predispatch' ? own.length === 0 : own.length === 1 && own[0].phase === (boundary === 'update' ? 'updated' : 'created'), JSON.stringify(image).slice(-2500))
      run.check('backend dispatch is exactly once or absent before dispatch', run.records.filter(r => r.kind === 'stop-backend-call').length === (boundary === 'predispatch' ? 0 : 1))
      if (boundary !== 'predispatch') {
        run.check('commit signal stays live through successful backend result', run.records.some(r => r.kind === 'stop-backend-result' && r.commitAborted === false))
        run.check('child ownership remains interrupted', image.payload.state.locks.some(lock => lock.owner === stop.child && lock.status === 'user-interrupted'))
      }
      if (boundary === 'update') run.check('update uses real observed version guard', run.records.some(r => r.kind === 'stop-backend-call' && r.expected?.kind === 'replaceIfVersion' && typeof r.expected.version === 'string'))
      run.check('headless reports aborted turn', run.code === 1, `code=${run.code} ${run.stderr.slice(-500)}`)
    },
  }
})
