// Scenario: custom-skill-paths — OpenSpec add-custom-skill-scan-paths task 4.1.
// Live-only: the oracle is a real temporary Skill, real gateway mutations,
// accepted capability records, stock Skill loading, and the durable session log.
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import zlib from 'node:zlib'
import { skillIdentityKey } from '../../../weir-harness/src/capabilities/skill-identity.js'
import { lastOfRole, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'custom-skill-paths'
const prompt = 'custom-skill-paths-probe'
const SKILL_NAME = 'custom-scan-path-fixture'
const SKILL_BODY = 'CUSTOM_SCAN_PATH_SKILL_BODY'
const PATH_STEPS = ['initialPaths', 'add', 'reread', 'remove', 'pathsAfterRemove']

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const lastTool = lastOfRole(options, 'tool')
  if (lastTool.startsWith('CUSTOM_SKILL_PATHS error') || (lastTool && !lastTool.startsWith('CUSTOM_SKILL_PATHS done'))) return textChunks('custom skill paths failed')
  if (!history.includes('CUSTOM_SKILL_PATHS done')) return toolCallChunks('custom_skill_paths_probe', {})
  return textChunks('custom skill paths complete')
}

function observe(obs) {
  return { customSkillPathsServed: obs.toolNames.includes('custom_skill_paths_probe') || obs.transcript.includes('CUSTOM_SKILL_PATHS done') }
}

function sessionLogs(root) {
  const found = []
  const walk = dir => {
    let entries
    try { entries = readdirSync(dir) } catch { return }
    for (const entry of entries) {
      const path = join(dir, entry)
      let stat
      try { stat = statSync(path) } catch { continue }
      if (stat.isDirectory()) walk(path)
      else if (entry === 'session.v4.jsonl.zstd') found.push(path)
    }
  }
  walk(root)
  return found
}

// Multi-frame zstd decode, matching the repository's session-log reader.
function decodeLog(file) {
  const buffer = readFileSync(file)
  const magic = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
  const offsets = []
  for (let index = 0; index + 4 <= buffer.length; index++) {
    if (buffer[index] === magic[0] && buffer[index + 1] === magic[1] && buffer[index + 2] === magic[2] && buffer[index + 3] === magic[3]) offsets.push(index)
  }
  const parts = []
  for (const offset of offsets) {
    try { parts.push(zlib.zstdDecompressSync(buffer.subarray(offset)).toString('utf8')) } catch { /* ignore a trailing partial frame */ }
  }
  return { frames: offsets.length, decoded: parts.length, text: parts.join('') }
}

function durableLogReport(home, sessionId, canonicalPath) {
  const logs = typeof sessionId === 'string'
    ? sessionLogs(join(home, 'sessions')).filter(file => basename(dirname(file)) === sessionId)
    : []
  const events = []
  let frames = 0
  let decoded = 0
  let pathPresent = false
  for (const file of logs) {
    const log = decodeLog(file)
    frames += log.frames
    decoded += log.decoded
    pathPresent ||= typeof canonicalPath === 'string' && canonicalPath.length > 0 && log.text.includes(canonicalPath)
    for (const line of log.text.split('\n')) {
      if (!line.trim()) continue
      try {
        const event = JSON.parse(line)
        events.push({ seq: event?.seq ?? null, type: event?.type ?? null })
      } catch { /* decode counts above make malformed payload visible */ }
    }
  }
  return { sessionId: sessionId ?? null, logs: logs.length, frames, decoded, pathPresent, events }
}

async function run(ctx) {
  const trace = join(ctx.IT_ROOT, `trace-${id}.jsonl`)
  const boot = await ctx.spawnHeadless(['weir-it', prompt], ctx.scenarioEnv(id, trace, {
    WEIR_IT_CUSTOM_SKILL_PATHS: '1',
    DSH_AGENTS_HOME: join(ctx.IT_ROOT, 'agents-home'),
  }))
  let probe = null
  try { probe = JSON.parse(readFileSync(join(ctx.IT_ROOT, 'ws', `${id}.json`), 'utf8')) } catch { /* assertion below reports the missing report */ }
  const log = durableLogReport(join(ctx.IT_ROOT, 'home'), probe?.sessionId, probe?.canonicalPath)
  writeFileSync(join(ctx.IT_ROOT, 'ws', `${id}-log.json`), JSON.stringify(log, null, 2) + '\n')
  return { scenario: id, trace, code: boot.code, stdout: boot.stdout, stderr: boot.stderr }
}

function readReport(run, name) {
  try { return JSON.parse(readFileSync(join(run.ws, `${id}${name}.json`), 'utf8')) } catch { return null }
}

function assert(run) {
  const report = readReport(run, '')
  const log = readReport(run, '-log')
  const json = value => JSON.stringify(value)?.slice(0, 1600) ?? 'undefined'
  run.check('probe wrote its diagnostic report', report !== null, `${run.stdout.slice(-500)}\n${run.stderr.slice(-1000)}`)
  run.check('durable log report was written', log !== null, json(log))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-800)}`)
  if (!report || !log) return

  const step = name => report.steps?.[name]
  const value = name => step(name)?.value
  // The Host prepends standing agent instructions and maintains its own Skill
  // catalog on manual pre-step passes. Those host-owned baselines are not path
  // mutation notices; every other message is forbidden, and ALL messages are
  // still scanned for the canonical path (including the excluded baselines).
  const nonHostBaseline = messages => (Array.isArray(messages) ? messages : []).filter(message => !['agent-instructions', 'skill-catalog'].includes(message?.source))
  const pathFree = messages => Array.isArray(messages) && messages.every(message => !String(message?.text ?? '').includes(report.canonicalPath))
  run.check('flow completed without probe or cleanup errors', report.completed === true && report.error === undefined && report.cleanup?.errors?.length === 0, json({ error: report.error, cleanup: report.cleanup }))
  run.check('the real temporary Skill was removed by normal cleanup', report.cleanup?.agentDisposed === true && report.cleanup?.presetUnregistered === true && report.cleanup?.temporaryDirectoryExists === false, json(report.cleanup))
  run.check('registry starts as absent/empty revision zero', value('initialPaths')?.status === 'ok' && value('initialPaths')?.revision === 0 && Array.isArray(value('initialPaths')?.paths) && value('initialPaths').paths.length === 0, json(value('initialPaths')))
  run.check('the fixture is absent before Add and the initial applied set is empty', report.initialListing?.skills?.some(row => row?.name === SKILL_NAME) === false && report.initialReceipt?.revision === 0 && report.initialReceipt?.effective?.skills?.length === 0 && report.initialSelectionRecord?.kind === 'absent', json({ listing: report.initialListing?.skills?.filter(row => row?.name === SKILL_NAME), receipt: report.initialReceipt, record: report.initialSelectionRecord }))

  run.check('Add commits exactly the canonical real directory at revision one', value('add')?.status === 'saved' && value('add')?.saved === true && value('add')?.revision === 1 && JSON.stringify(value('add')?.paths) === JSON.stringify([report.canonicalPath]), json({ add: value('add'), canonicalPath: report.canonicalPath }))
  run.check('gateway reread and a new store/registry instance prove persistence', value('reread')?.revision === 1 && JSON.stringify(value('reread')?.paths) === JSON.stringify([report.canonicalPath]) && JSON.stringify(report.registryReinstantiated) === JSON.stringify(value('reread')), json({ reread: value('reread'), reinstantiated: report.registryReinstantiated }))
  run.check('listing discovers an unselected parsed custom candidate', report.candidate?.name === SKILL_NAME && report.candidate?.scope === 'custom' && report.candidate?.status === 'parsed' && report.candidate?.selected === false && report.candidate?.identity?.root === report.canonicalPath, json(report.candidate))
  run.check('Add leaves the applied receipt byte-identical', JSON.stringify(report.receiptAfterAdd) === JSON.stringify(report.initialReceipt), json({ before: report.initialReceipt, after: report.receiptAfterAdd }))

  run.check('explicit Select/Apply accepts exactly the discovered identity', report.apply?.status === 'applied' && report.apply?.revision === 1 && report.apply?.effective?.skills?.length === 1 && skillIdentityKey(report.apply.effective.skills[0]) === report.identityKey, json(report.apply))
  run.check('Apply durably records the same identity at selection revision one', report.selectionRecordAfterApply?.kind === 'ok' && report.selectionRecordAfterApply?.revision === 1 && report.selectionRecordAfterApply?.payload?.skills?.length === 1 && skillIdentityKey(report.selectionRecordAfterApply.payload.skills[0]) === report.identityKey, json(report.selectionRecordAfterApply))
  run.check('the stock Skill tool loads the real SKILL.md body after Apply', report.loadAfterApply?.error === null && report.loadAfterApply?.name === SKILL_NAME && report.loadAfterApply?.content?.includes(SKILL_BODY) === true, json(report.loadAfterApply))
  const applyNotices = report.applyNoticeBoundary?.filter(message => message?.source === 'weir-selection-notify') ?? []
  run.check('the ordinary Apply notice is drained and contains no scan path', applyNotices.length === 1 && applyNotices[0]?.text?.includes(`Added: ${SKILL_NAME}`) === true && pathFree(report.applyNoticeBoundary) && report.applyNoticePendingAfterDrain === false, json({ messages: report.applyNoticeBoundary, pending: report.applyNoticePendingAfterDrain }))

  run.check('Remove commits the empty registry at revision two', value('remove')?.status === 'removed' && value('remove')?.saved === true && value('remove')?.revision === 2 && value('remove')?.paths?.length === 0, json(value('remove')))
  run.check('post-remove gateway read and reinstantiation stay empty and persistent', value('pathsAfterRemove')?.status === 'ok' && value('pathsAfterRemove')?.revision === 2 && value('pathsAfterRemove')?.paths?.length === 0 && JSON.stringify(report.registryAfterRemoveReinstantiated) === JSON.stringify(value('pathsAfterRemove')), json({ read: value('pathsAfterRemove'), reinstantiated: report.registryAfterRemoveReinstantiated }))
  run.check('removed discovery root no longer lists the custom candidate', report.listingAfterRemove?.skills?.some(row => row?.name === SKILL_NAME && row?.identity?.root === report.canonicalPath) === false, json(report.listingAfterRemove?.skills?.filter(row => row?.name === SKILL_NAME)))
  run.check('subsequent stock Skill load is denied after removal', report.loadAfterRemove?.content === null && report.loadAfterRemove?.error?.includes('unknown or no longer available') === true, json(report.loadAfterRemove))
  run.check('existing receipt behavior reports the now-unavailable accepted selection without advancing it', report.receiptAfterRemove?.revision === report.apply?.revision && report.receiptAfterRemove?.effective?.skills?.includes(SKILL_NAME) === false && report.receiptAfterRemove?.warnings?.includes('selection-unavailable') === true, json(report.receiptAfterRemove))
  run.check('existing Apply behavior reports the exact missing identity', report.missingIdentityApply?.status === 'rejected' && report.missingIdentityApply?.reason === 'selected-identity-missing' && JSON.stringify(report.missingIdentityApply?.missing) === JSON.stringify([report.identityKey]), json(report.missingIdentityApply))
  run.check('the accepted selection record remains byte-identical after Remove and missing reporting', JSON.stringify(report.selectionRecordAfterRemove) === JSON.stringify(report.selectionRecordAfterApply) && JSON.stringify(report.selectionRecordAfterMissingReport) === JSON.stringify(report.selectionRecordAfterApply), json({ applied: report.selectionRecordAfterApply, removed: report.selectionRecordAfterRemove, missingReport: report.selectionRecordAfterMissingReport }))

  for (const name of PATH_STEPS) {
    run.check(`${name}: no native session event, command lifecycle event, or custom event was appended`, step(name)?.error === null && step(name)?.eventPrefixIntact === true && step(name)?.sessionEventDelta?.length === 0, json(step(name)))
    run.check(`${name}: no model-facing path notification was injected`, nonHostBaseline(step(name)?.modelNotifications).length === 0 && pathFree(step(name)?.modelNotifications), json(step(name)?.modelNotifications))
  }
  run.check('no later model boundary injects a removal/path notice', nonHostBaseline(report.finalModelBoundary).length === 0 && pathFree(report.finalModelBoundary), json(report.finalModelBoundary))
  const modelTrace = JSON.stringify(run.requests.map(request => ({ lastUser: request.lastUser, lastTool: request.lastTool })))
  run.check('the model request trace never carries the temporary scan path', !modelTrace.includes(report.canonicalPath), modelTrace.slice(-1000))

  run.check('the owned durable session log exists and decodes at least one frame', log.sessionId === report.sessionId && log.logs === 1 && log.frames > 0 && log.decoded > 0, json(log))
  run.check('durable log has no command/run, command/done, or custom Weir session event', log.events?.every(event => !['command/run', 'command/done'].includes(event.type) && !String(event.type).startsWith('weir/')) === true, json(log.events))
  run.check('durable session log never carries the custom scan path', log.pathPresent === false, json({ pathPresent: log.pathPresent, events: log.events }))
  run.check('the probe was actually advertised and served', run.requests.some(request => request.customSkillPathsServed === true), json(run.requests.map(request => ({ emittedNames: request.emittedNames, served: request.customSkillPathsServed }))))
  run.check('the scripted flow reached its final marker', run.stdout.includes('custom skill paths complete'), run.stdout.slice(-500))
}

export default { id, prompt, decide, observe, run, assert, env: { WEIR_IT_CUSTOM_SKILL_PATHS: '1' } }
