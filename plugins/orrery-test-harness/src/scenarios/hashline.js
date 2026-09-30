// Scenario: hashline — anchored reads, hash_edit application, sandbox denial.
// Migrated from mock-llm.js decideHashline / run.mjs assertHashline (D1/D2).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, lastOfRole, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'hashline'
const prompt = 'hashline-probe'

const FIXTURE = process.env.ORRERY_IT_FIXTURE ?? join(IT_ROOT, 'ws', 'fixture.txt')
// Out-of-workspace file for the hashline denial probe: readable (reads are
// unfenced) but outside every writable root under workspace-write.
const DENIED = join(IT_ROOT, 'home', 'denied.txt')

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const messages = options.messages ?? []
  const lastRole = messages.at(-1)?.role
  if (lastRole === 'tool') {
    const toolText = lastOfRole(options, 'tool')
    // The denied edit's tool result carries the shared sandbox marker.
    if (history.includes('[sandbox: file access denied under')) {
      return textChunks('hashline escalation denial observed')
    }
    // Fixture edit done: read the out-of-workspace file for the denial probe.
    if (history.includes('hash_edit applied') && !history.includes('outside one')) {
      return toolCallChunks('read', { file_path: DENIED })
    }
    const deniedAnchor = /\n1#([ZPMQVRWSNKTXJBYH]{2})\|/.exec(`\n${toolText}`)
    if (deniedAnchor && history.includes('outside one')) {
      return toolCallChunks('hash_edit', {
        file_path: DENIED,
        edits: [{ op: 'replace', pos: `1#${deniedAnchor[1]}`, text: 'DENIED_EDIT_TRIED' }],
      })
    }
    const anchor = /\n2#([ZPMQVRWSNKTXJBYH]{2})\|/.exec(`\n${toolText}`)
    if (anchor && !history.includes('hash_edit applied')) {
      return toolCallChunks('hash_edit', {
        file_path: FIXTURE,
        edits: [
          { op: 'replace', pos: `2#${anchor[1]}`, text: 'CHANGED-BY-HASHLINE' },
          { op: 'append', pos: `2#${anchor[1]}`, text: 'bulk 一\nbulk 二\nbulk 三' },
        ],
      })
    }
    return textChunks('unhandled hashline tool turn')
  }
  if (history.includes('hashline-probe')) {
    return toolCallChunks('read', { file_path: FIXTURE })
  }
  return textChunks('unhandled hashline turn')
}

function observe(obs) {
  return {
    hashEditEscalationEnum: obs.toolDefs.find((tool) => tool.name === 'hash_edit')?.parameters?.properties?.sandbox_permissions?.enum ?? null,
    escalationDenialSeen: obs.transcript.includes('[sandbox: file access denied under'),
    escalationHintSeen: obs.transcript.includes('[sandbox: escalation available'),
    anchoredReadSeen: /#([ZPMQVRWSNKTXJBYH]{2})\|/.test(obs.transcript),
  }
}

function assert(run) {
  const requests = run.requests
  const fixture = readFileSync(join(run.ws, 'fixture.txt'), 'utf8')
  run.check('read result carried anchors to the model', requests.some((r) => r.anchoredReadSeen), JSON.stringify(requests.map((r) => r.emitted)))
  run.check('hash_edit rewrote line two', fixture.split('\n')[1] === 'CHANGED-BY-HASHLINE', fixture)
  run.check('bulk append through the text channel landed byte-exact', fixture === 'line one\nCHANGED-BY-HASHLINE\nbulk 一\nbulk 二\nbulk 三\nline three\n', fixture)
  run.check('stock edit hidden from the model tool catalog', requests.length > 0 && requests.every((r) => !r.tools.includes('edit')), JSON.stringify(requests.map((r) => r.tools)))
  run.check('hash_edit present in the model tool catalog', requests.some((r) => r.tools.includes('hash_edit')), JSON.stringify(requests.map((r) => r.tools)))
  run.check('hash_edit schema advertises the sandbox escalation fields', requests.some((r) => Array.isArray(r.hashEditEscalationEnum) && r.hashEditEscalationEnum.includes('workspace-write') && r.hashEditEscalationEnum.includes('danger-full-access')), JSON.stringify(requests.map((r) => r.hashEditEscalationEnum)))
  const hashResults = run.events.filter((r) => r.type === 'tool/result' && r.hashEdit)
  run.check('successful hash_edit persisted meta.diffs fragments', hashResults.some((r) => !r.isError && Array.isArray(r.meta?.diffs) && r.meta.diffs.length > 0 && r.meta.diffs.every((d) => typeof d.path === 'string' && (d.oldText === null || typeof d.oldText === 'string') && typeof d.newText === 'string')), JSON.stringify(hashResults.map((r) => [r.isError, r.meta])))
  run.check('failed hash_edit persisted no diff metadata', hashResults.filter((r) => r.isError).every((r) => r.meta == null || !Array.isArray(r.meta?.diffs)), JSON.stringify(hashResults.map((r) => [r.isError, r.meta])))
  run.check('out-of-workspace edit denied with the shared marker and the escalation hint', requests.some((r) => r.escalationDenialSeen && r.escalationHintSeen), JSON.stringify(requests.map((r) => [r.escalationDenialSeen, r.escalationHintSeen])))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, assert }
