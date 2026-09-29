// Scripted mock LLM adapter for headless integration tests of orrery-harness.
// Registers provider `mock` on ctx.llm and answers every request from
// content-driven scenario rules (env ORRERY_IT_SCENARIO), tracing each call
// as one JSON line to ORRERY_IT_TRACE for the driver to assert on.
// Dev-only: never install into a real profile.
import { appendFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const name = 'orrery-it-mock-llm'
const inject = ['llm']

const SCENARIO = process.env.ORRERY_IT_SCENARIO ?? 'deepwork'
const TRACE = process.env.ORRERY_IT_TRACE ?? '/Users/young/.orrery-it/trace.jsonl'
const FIXTURE = process.env.ORRERY_IT_FIXTURE ?? '/Users/young/.orrery-it/ws/fixture.txt'
// Out-of-workspace file for the hashline denial probe: readable (reads are
// unfenced) but outside every writable root under workspace-write.
const DENIED = join(process.env.ORRERY_IT_ROOT ?? '/Users/young/.orrery-it', 'home', 'denied.txt')
const WINDOW = Number(process.env.ORRERY_IT_WINDOW ?? '128000')
const LONG_FILLER = 'Filler line to raise pressure. '.repeat(600)

let callSeq = 0

function trace(record) {
  try {

    mkdirSync(dirname(TRACE), { recursive: true })
    appendFileSync(TRACE, JSON.stringify({ seq: ++callSeq, ...record }) + '\n')
  } catch {
    // tracing must never break a test run
  }
}

// ---------- request inspection ----------

function blockText(message) {
  if (!message || !Array.isArray(message.content)) return ''
  return message.content
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text)
    .join('\n')
}

function transcript(options) {
  return (options.messages ?? [])
    .map((message) => `${message.role}:\n${blockText(message)}`)
    .join('\n---\n')
}

function lastOfRole(options, role) {
  const messages = options.messages ?? []
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index].role === role) {
      const text = blockText(messages[index])
      if (text.length > 0) return text
    }
  }
  return ''
}

function lastToolName(options) {
  const messages = options.messages ?? []
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]
    if (message?.role === 'tool') return message.source?.toolCallId ?? ''
  }
  return ''
}

// ---------- chunk emitters ----------

function usage() {
  return { type: 'usage', usage: { inputTokens: 600, outputTokens: 60 } }
}

function* textChunks(text) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'block-end', index: 0, block: { type: 'text', text } }
  yield usage()
  yield { type: 'finish', reason: { kind: 'stop' } }
}

function* toolCallChunks(callName, args) {
  const argumentsText = JSON.stringify(args)
  yield { type: 'block-start', index: 0, blockType: 'tool-call' }
  yield { type: 'tool-call-delta', index: 0, id: 'mock-call-1', name: callName, argumentsDelta: argumentsText }
  yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: 'mock-call-1', name: callName, arguments: argumentsText } }
  yield usage()
  yield { type: 'finish', reason: { kind: 'tool-calls' } }
}

function* errorChunks(message) {
  yield usage()
  yield { type: 'finish', reason: { kind: 'error', failure: { message, code: 'MOCK_429' } } }
}

// ---------- scenario brains ----------

function decideDeepwork(options) {
  const history = transcript(options)
  const lastRole = options.messages?.at(-1)?.role
  if (lastRole === 'tool') {
    // after a tool result
    if (history.includes('<todo_continuation>')) {
      return textChunks('All todos are complete now. Deep work run finished.')
    }
    return textChunks('Registered the plan and paused with one open todo.')
  }
  if (history.includes('<todo_continuation>')) {
    return toolCallChunks('todo_write', {
      todos: [
        { content: 'register the plan', status: 'completed' },
        { content: 'finish the run', status: 'completed' },
      ],
    })
  }
  if (history.includes('深度工作')) {
    return toolCallChunks('todo_write', {
      todos: [
        { content: 'register the plan', status: 'completed' },
        { content: 'finish the run', status: 'pending' },
      ],
    })
  }
  return textChunks('unhandled deepwork turn')
}

function decideDelegate(options) {
  const history = transcript(options)
  const lastRole = options.messages?.at(-1)?.role
  if (history.includes('MARKER_CHILD_OK') && !history.includes('delegate-probe')) {
    return textChunks('MARKER_CHILD_OK: child finished')
  }
  if (lastRole === 'tool') {
    return textChunks('parent observed child result')
  }
  if (history.includes('delegate-probe')) {
    return toolCallChunks('delegate', {
      category: 'quick',
      prompt: 'TASK: reply with the exact marker text MARKER_CHILD_OK\nDELIVERABLE: the marker line\nSCOPE: nothing else\nVERIFY: the reply contains the marker\nSTOP WHEN: the marker is sent',
      task_summary: 'probe child',
    })
  }
  return textChunks('unhandled delegate turn')
}

function decideHashline(options) {
  const history = transcript(options)
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

function decidePressure(options) {
  if (options.purpose === 'compaction') {
    return textChunks('SUMMARY: the probe task was in progress with no errors.')
  }
  const history = transcript(options)
  if (history.includes('Resume the task from the compaction summary')) {
    return textChunks('resumed after compaction')
  }
  if (history.includes('pressure-probe')) {
    return textChunks(LONG_FILLER)
  }
  return textChunks('unhandled pressure turn')
}

function decideSemantic(options) {
  const history = transcript(options)
  if (history.includes('<intent-gate id="deep-work"')) {
    return textChunks('semantic mode armed, task done')
  }
  return textChunks('unhandled semantic turn')
}

const TSFIXTURE = process.env.ORRERY_IT_TSFIXTURE ?? '/Users/young/.orrery-it/ws/probe.ts'

function decideLsp(options) {
  const history = transcript(options)
  const lastRole = options.messages?.at(-1)?.role
  if (lastRole === 'tool') {
    const toolText = lastOfRole(options, 'tool')
    if (toolText.includes('unknown tool')) return textChunks('lsp scenario done')
    if (toolText.includes('disabled for this session')) return toolCallChunks('lsp_diagnostics', { file_path: TSFIXTURE })
    // The stale-version probe finished (ordinary tool error naming the
    // written/not-written lists) → toggle the tool set off.
    if (toolText.includes('filesNotWritten')) return toolCallChunks('lsp', { enabled: false })
    // Cross-file rename applied → run the deterministic stale-version probe.
    if (toolText.includes('across 2 file(s)')) return toolCallChunks('lsp_rename', { file_path: TSFIXTURE, line: 1, character: 14, new_name: 'staleProbe' })
    // Document symbols listed → run the cross-file rename.
    if (toolText.includes('Document symbols:')) return toolCallChunks('lsp_rename', { file_path: TSFIXTURE, line: 1, character: 14, new_name: 'renamedSymbol' })
    if (toolText.includes('reference(s)')) return toolCallChunks('lsp_symbols', { file_path: TSFIXTURE })
    if (toolText.includes('Definition location')) return toolCallChunks('lsp_references', { file_path: TSFIXTURE, line: 3, character: 5 })
    if (toolText.includes('diagnostic(s) for')) return toolCallChunks('lsp_definition', { file_path: TSFIXTURE, line: 3, character: 5 })
    if (toolText.includes('enabled for this session')) return toolCallChunks('lsp_diagnostics', { file_path: TSFIXTURE })
    return textChunks('unhandled lsp turn')
  }
  if (history.includes('lsp-probe')) {
    return toolCallChunks('lsp', { enabled: true })
  }
  return textChunks('unhandled lsp turn')
}

function decideRehydrate(options) {
  const history = transcript(options)
  // Child A: proves the inherited toolset works via bash, then completes.
  // (The bash round-trip makes a second request whose tool list is observable
  // in the trace — the first request of an agent carries no tools there.)
  if (history.includes('REHYDRATE_CHILD_A') && !history.includes('rehydrate-probe') && !history.includes('rehydrate-resume-probe')) {
    if (options.messages?.at(-1)?.role === 'tool') {
      return textChunks('STATUS: completed\nREPORT: alpha rehydrate done')
    }
    return toolCallChunks('bash', { command: 'echo REHYDRATE_A_BASH_RAN', description: 'prove the inherited toolset works' })
  }
  // Child B: blocks in phase 1; after the post-restart resume message, completes.
  if (history.includes('REHYDRATE_CHILD_B') && !history.includes('rehydrate-probe') && !history.includes('rehydrate-resume-probe')) {
    if (history.includes('Your parent cleared your blocker')) {
      return textChunks('STATUS: completed\nREPORT: beta resumed after restart')
    }
    return textChunks('STATUS: blocked\nREPORT: rehydrate child stuck on missing payload')
  }
  // Parent phase 2 (adopted session, fresh process): resume the blocked child
  // on the rehydrated registry, then observe the group-settled signal.
  if (history.includes('rehydrate-resume-probe')) {
    if (history.includes('<supervised_group_settled')) {
      return textChunks('parent observed post-restart group-settled signal')
    }
    if (history.includes('Resumed supervised child') && !history.includes('REHYDRATE_WAITED')) {
      return toolCallChunks('bash', { command: 'echo REHYDRATE_WAITED && sleep 2', description: 'Let the resumed child settle' })
    }
    if (history.includes('REHYDRATE_WAITED')) {
      // End the turn: the group-settled signal then arrives via the deferred
      // followup — never loop on sleeps.
      return textChunks('waiting for the post-restart group-settled signal')
    }
    return toolCallChunks('resume_agent', { agent: 'beta', context: 'payload ready' })
  }
  // Parent phase 1: delegate the group, then STOP once the blocked notice
  // arrives — the run exits with the child still blocked (simulated restart
  // happens between the two phases).
  const lastRole = options.messages?.at(-1)?.role
  if (lastRole === 'tool') {
    const toolText = lastOfRole(options, 'tool')
    if (toolText.includes('Supervised group')) {
      return toolCallChunks('bash', { command: 'sleep 1', description: 'Let supervised children settle' })
    }
    return textChunks('unhandled rehydrate tool turn')
  }
  if (history.includes('rehydrate child stuck on missing payload')) {
    return textChunks('parent observed the built-in blocked settlement; stopping before the simulated restart')
  }
  if (history.includes('rehydrate-probe') && !history.includes('Supervised group')) {
    return toolCallChunks('delegate', {
      group: 'probe-group',
      tasks: [
        { category: 'quick', name: 'alpha', prompt: 'REHYDRATE_CHILD_A\nTASK: probe alpha\nDELIVERABLE: the marker\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done' },
        { category: 'quick', name: 'beta', prompt: 'REHYDRATE_CHILD_B\nTASK: probe beta\nDELIVERABLE: the marker\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done' },
      ],
    })
  }
  return textChunks('unhandled rehydrate turn')
}

function decideGrouped(options) {  const history = transcript(options)
  // Child A: first turn fails with a provider error; the coordinator's retry
  // message (RETRY_MESSAGE) then gets a clean terminal report.
  if (history.includes('GROUPED_CHILD_A') && !history.includes('grouped-probe')) {
    if (history.includes('Continue the task now, and remember to end')) {
      return textChunks('STATUS: completed\nREPORT: alpha finished after one retry')
    }
    return errorChunks('simulated provider 429')
  }
  // Child B: settles on the first try.
  if (history.includes('GROUPED_CHILD_B') && !history.includes('grouped-probe')) {
    return textChunks('STATUS: completed\nREPORT: beta finished first try')
  }
  // Parent: observe the group-settled signal; after the delegate tool result,
  // pad the busy window so the headless one-shot driver does not exit before
  // the (instant-mock) children settle; then end the turn and wait.
  if (history.includes('<supervised_group_settled')) {
    return textChunks('parent observed group-settled signal')
  }
  const lastRole = options.messages?.at(-1)?.role
  if (lastRole === 'tool') {
    const toolText = lastOfRole(options, 'tool')
    if (toolText.includes('Supervised group')) {
      return toolCallChunks('bash', { command: 'sleep 1', description: 'Let supervised children settle' })
    }
    return textChunks('group started, waiting for the settle signal')
  }
  if (history.includes('grouped-probe') && !history.includes('Supervised group')) {
    return toolCallChunks('delegate', {
      group: 'probe-group',
      tasks: [
        { category: 'quick', prompt: 'GROUPED_CHILD_A\nTASK: probe alpha\nDELIVERABLE: the marker\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done' },
        { category: 'quick', prompt: 'GROUPED_CHILD_B\nTASK: probe beta\nDELIVERABLE: the marker\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done' },
      ],
    })
  }
  return textChunks('unhandled grouped turn')
}

function decideEscalate(options) {
  const history = transcript(options)
  // First deep child returns an ESCALATE; the respawned deep-plus child settles.
  if (history.includes('ESCALATE_CHILD') && !history.includes('escalate-probe')) {
    if (history.includes('escalation_findings')) return textChunks('escalated child settled properly')
    return textChunks('ESCALATE: deep-plus\nfirst pass hit a boundary')
  }
  const lastRole = options.messages?.at(-1)?.role
  if (lastRole === 'tool') {
    const toolText = lastOfRole(options, 'tool')
    if (toolText.includes('escalated to deep-plus')) return textChunks('parent observed the escalation respawn')
    return textChunks('unhandled escalate tool turn')
  }
  if (history.includes('escalate-probe') && !history.includes('ESCALATE_CHILD')) {
    return toolCallChunks('delegate', { category: 'deep', prompt: 'ESCALATE_CHILD\nTASK: probe escalation\nDELIVERABLE: the marker\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done' })
  }
  return textChunks('unhandled escalate turn')
}

function decideBackground(options) {
  const history = transcript(options)
  // Background child brain: produce the report marker.
  if (history.includes('BACKGROUND_CHILD') && !history.includes('background-probe')) {
    return textChunks('BACKGROUND_CHILD_MARKER: background child finished its work')
  }
  // Parent: keep the turn alive until the compact job notice arrives, then
  // observe it WITHOUT pulling — the pull-only discipline is the contract.
  // (The full report must never enter the parent context.)
  const lastRole = options.messages?.at(-1)?.role
  if (lastRole === 'tool') {
    const toolText = lastOfRole(options, 'tool')
    if (toolText.includes('Delegated in the background')) {
      return toolCallChunks('bash', { command: 'echo WAITED_FOR_JOB && sleep 1', description: 'Keep the turn alive until the background job settles' })
    }
    if (toolText.includes('WAITED_FOR_JOB')) {
      if (history.includes('finished [status: completed]')) {
        return textChunks('parent observed the compact notice; the full report stays pull-only')
      }
      return toolCallChunks('bash', { command: 'echo WAITED_FOR_JOB && sleep 1', description: 'Wait for the job notice' })
    }
    return textChunks('unhandled background tool turn')
  }
  if (history.includes('finished [status: completed]') && history.includes('background job')) {
    return textChunks('parent observed the compact notice; the full report stays pull-only')
  }
  if (history.includes('background-probe') && !history.includes('BACKGROUND_CHILD')) {
    return toolCallChunks('delegate', { agent: 'explore', prompt: 'BACKGROUND_CHILD\nTASK: finish the background work\nDELIVERABLE: the marker\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done', run_in_background: true })
  }
  return textChunks('unhandled background turn')
}

function decideTerminate(options) {
  const history = transcript(options)
  // Child A: stays busy so the parent can interrupt it mid-flight.
  if (history.includes('TERMINATE_CHILD_A') && !history.includes('terminate-probe')) {
    return toolCallChunks('bash', { command: 'sleep 30', description: 'Stay busy so the parent can interrupt' })
  }
  // Child B: completes immediately.
  if (history.includes('TERMINATE_CHILD_B') && !history.includes('terminate-probe')) {
    return textChunks('STATUS: completed\nREPORT: beta finished for termination count')
  }
  // Parent: wait briefly, terminate the busy member, then observe the signal.
  // Keyed off history: the child's settlement notice may interleave as a user
  // message between the sleep result and the terminate call.
  if (history.includes('<supervised_group_settled')) {
    return textChunks('parent observed the settle signal after termination')
  }
  if (history.includes('TERMINATE_WAITED') && !history.includes('interrupted while running') && !history.includes('state bookkeeping')) {
    return toolCallChunks('terminate_agent', { agent: 'alpha' })
  }
  const lastRole = options.messages?.at(-1)?.role
  if (lastRole === 'tool') {
    const toolText = lastOfRole(options, 'tool')
    if (toolText.includes('Supervised group')) {
      return toolCallChunks('bash', { command: 'echo TERMINATE_WAITED && sleep 1', description: 'Let the busy child start, then interrupt it' })
    }
    if (toolText.includes('interrupted while running')) {
      // Keep the turn alive: the aborted member's settlement notice and the
      // gated group-settled signal land right after the interrupt result.
      return toolCallChunks('bash', { command: 'echo TERMINATE_DONE && sleep 1', description: 'Let the final notice and signal land' })
    }
    if (toolText.includes('TERMINATE_DONE')) {
      return textChunks('parent terminated alpha; waiting for the settle signal')
    }
    return textChunks('unhandled terminate tool turn')
  }
  if (history.includes('terminate-probe') && !history.includes('Supervised group')) {
    return toolCallChunks('delegate', {
      group: 'probe-group',
      tasks: [
        { category: 'quick', name: 'alpha', prompt: 'TERMINATE_CHILD_A\nTASK: stay busy\nDELIVERABLE: nothing\nSCOPE: nothing else\nVERIFY: n/a\nSTOP WHEN: interrupted' },
        { category: 'quick', name: 'beta', prompt: 'TERMINATE_CHILD_B\nTASK: finish\nDELIVERABLE: the marker\nSCOPE: nothing else\nVERIFY: done\nSTOP WHEN: done' },
      ],
    })
  }
  return textChunks('unhandled terminate turn')
}

function decideRobash(options) {
  const history = transcript(options)
  const lastRole = options.messages?.at(-1)?.role
  // Child brain (explore curated agent): run an allowed command, then a denied one.
  if (history.includes('ROBASH_CHILD') && !history.includes('robash-probe')) {
    if (lastRole === 'tool') {
      const toolText = lastOfRole(options, 'tool')
      if (toolText.includes('ROBASH_LS_RAN') && !history.includes('read-only agent')) {
        return toolCallChunks('bash', { command: 'rm -rf fixture.txt', description: 'Try to delete the fixture' })
      }
      return textChunks('MARKER_ROBASH_OK: ls ran, rm was denied')
    }
    return toolCallChunks('bash', { command: 'echo ROBASH_LS_RAN', description: 'Prove bash executed' })
  }
  // Parent brain: delegate to the explore curated agent.
  if (lastRole === 'tool') {
    return textChunks('parent observed robash child result')
  }
  if (history.includes('robash-probe')) {
    return toolCallChunks('delegate', {
      agent: 'explore',
      prompt: 'ROBASH_CHILD\nTASK: prove bash works, then attempt a write command\nDELIVERABLE: report both outcomes\nSCOPE: bash only\nVERIFY: the echo output and the denial both observed\nSTOP WHEN: reported',
      task_summary: 'robash child',
    })
  }
  return textChunks('unhandled robash turn')
}

function decide(options) {
  if (options.purpose === 'session-title') return textChunks('Integration Test Session')
  if (options.purpose === 'compaction') return textChunks('SUMMARY: the probe task was in progress with no errors.')
  // Intent-gate semantic-classifier sidecar: scripted answer per scenario.
  if ((options.system ?? '').includes('You classify a user prompt')) {
    return textChunks(SCENARIO === 'semantic' ? 'deep-work' : 'none')
  }
  switch (SCENARIO) {
    case 'deepwork':
      return decideDeepwork(options)
    case 'delegate':
      return decideDelegate(options)
    case 'hashline':
      return decideHashline(options)
    case 'pressure':
      return decidePressure(options)
    case 'robash':
      return decideRobash(options)
    case 'semantic':
      return decideSemantic(options)
    case 'grouped':
      return decideGrouped(options)
    case 'escalate':
      return decideEscalate(options)
    case 'background':
      return decideBackground(options)
    case 'terminate':
      return decideTerminate(options)
    case 'rehydrate':
      return decideRehydrate(options)
    case 'lsp':
      return decideLsp(options)
    default:
      return textChunks(`unknown scenario ${SCENARIO}`)
  }
}

async function* streamScenario(options) {
  const tools = (options.tools ?? []).map((tool) => tool.name)
  // Strict-provider schema validation: every tool's parameters must be an
  // object-rooted JSON Schema (DeepSeek rejects anything else) — this check
  // reproduces the provider-side schema gate headlessly.
  const invalidTools = (options.tools ?? [])
    .filter((tool) => tool.deferLoading !== true && (!tool.parameters || tool.parameters.type !== 'object'))
    .map((tool) => tool.name)
  if (invalidTools.length > 0) {
    throw new Error(`Invalid schema for function '${invalidTools[0]}': schema must be a JSON Schema of 'type: "object"'`)
  }
  const out = [...decide(options)]
  trace({
    scenario: SCENARIO,
    purpose: options.purpose ?? 'main',
    tools,
    hashEditEscalationEnum: (options.tools ?? []).find((tool) => tool.name === 'hash_edit')?.parameters?.properties?.sandbox_permissions?.enum ?? null,
    escalationDenialSeen: transcript(options).includes('[sandbox: file access denied under'),
    escalationHintSeen: transcript(options).includes('[sandbox: escalation available'),
    intentInjected: transcript(options).includes('<intent-gate id="deep-work"'),
    continuationSeen: transcript(options).includes('<todo_continuation>'),
    pressureAdvisorySeen: transcript(options).includes('<context_pressure>'),
    anchoredReadSeen: /#([ZPMQVRWSNKTXJBYH]{2})\|/.test(transcript(options)),
    sawDelegateProbe: transcript(options).includes('delegate-probe'),
    sawChildMarker: transcript(options).includes('MARKER_CHILD_OK'),
    sawRobashChild: transcript(options).includes('ROBASH_CHILD'),
    roBashLsSeen: transcript(options).includes('ROBASH_LS_RAN'),
    roBashRmDenied: transcript(options).includes('explicitly denied'),
    sawClassifyCall: (options.system ?? '').includes('You classify a user prompt'),
    sawGroupProbe: transcript(options).includes('grouped-probe'),
    groupRetrySeen: transcript(options).includes('Continue the task now, and remember to end'),
    mergedAlphaSeen: transcript(options).includes('alpha finished after one retry'),
    mergedBetaSeen: transcript(options).includes('beta finished first try'),
    groupSettledSignalSeen: transcript(options).includes('<supervised_group_settled'),
    sawRehydrateProbe: transcript(options).includes('rehydrate-probe'),
    settlementBlockedSeen: transcript(options).includes('rehydrate child stuck on missing payload'),
    rehydrateResumeCallSeen: transcript(options).includes('rehydrate-resume-probe'),
    sawEscalateProbe: transcript(options).includes('escalate-probe'),
    escalationFindingsSeen: transcript(options).includes('escalation_findings'),
    sawBackgroundProbe: transcript(options).includes('background-probe'),
    backgroundChildSeen: transcript(options).includes('BACKGROUND_CHILD') && !transcript(options).includes('background-probe'),
    backgroundMarkerInParentContext: transcript(options).includes('BACKGROUND_CHILD_MARKER') && transcript(options).includes('background-probe'),
    sawTerminateProbe: transcript(options).includes('terminate-probe'),
    rehydrateResumeContextSeen: transcript(options).includes('Your parent cleared your blocker'),
    rehydrateResumedReportSeen: transcript(options).includes('beta resumed after restart'),
    rehydrateChildASeen: transcript(options).includes('REHYDRATE_CHILD_A'),
    lspToggledOn: transcript(options).includes('LSP semantic tools enabled'),
    lspRenameSeen: transcript(options).includes('across 2 file(s)'),
    lspRenameStaleSeen: transcript(options).includes('filesAlreadyWritten') && transcript(options).includes('filesNotWritten'),
    lspDiagSeen: transcript(options).includes('mock-diagnostic'),
    lspDefSeen: transcript(options).includes('probe.ts:3:5'),
    lspRefsSeen: transcript(options).includes('2 reference(s)'),
    lspSymbolsSeen: transcript(options).includes('fixtureSymbol'),
    lspUnknownAfterOff: transcript(options).includes('unknown tool "lsp_diagnostics"'),
    emitted: out.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block?.type ?? 'unknown'),
    emittedNames: out.filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block?.name ?? chunk.block?.type ?? 'unknown'),
    lastUser: lastOfRole(options, 'user').slice(0, 200),
    lastTool: lastOfRole(options, 'tool').slice(0, 300),
  })
  yield* out
}

function apply(ctx) {
  const adapter = {
    providerInfo: (provider) => ({ id: provider, name: 'Mock LLM' }),
    providerRetryPolicy: () => undefined,
    imageRequestPricing: () => undefined,
    listModels: async (provider) => [{ provider, id: 'mock-1', name: 'Mock One', inputModalities: ['text'] }],
    resolveModel: async (provider, model) => ({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
      context: { contextWindow: WINDOW },
    }),
    prepareCall: async (provider, model) => ({
      config: { provider, model },
      retryPolicy: { mode: 'normal', maxRetries: 0, retryableCodes: [], initialDelayMs: 0, maxDelayMs: 0, jitterRatio: 0 },
      adapterDefaults: {},
      model: {
        provider,
        id: model,
        name: model,
        inputModalities: ['text'],
        context: { contextWindow: WINDOW },
      },
      stream: (options) => streamScenario(options),
    }),
    stream: (options) => streamScenario(options),
  }
  ctx.llm.registerAdapter(['mock'], adapter)
}

export { name, inject, apply }
