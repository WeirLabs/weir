// Single-extraction conformance (design D2/D6, task 3.3):
//  1. extract() is a pure function producing the observation base;
//  2. planRequest calls extract exactly once per request (DI counting) and
//     every consumer (decide + observe + record) shares that one pass;
//  3. the union of per-scenario trace-record keys equals the pre-registry
//     47-key superset exactly — no field was renamed or orphaned in the
//     migration into per-scenario observe();
//  4. the strict-provider schema gate throws its verbatim error before any
//     scenario logic runs.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { extract } from '../src/mock-kit.js'
import { planRequest, streamScenario } from '../src/mock-llm.js'
import { SCENARIOS } from '../src/scenarios/index.js'

// The pre-registry trace record carried these keys on every request (mock
// generic fields + all 38 scenario-specific fields + seq from the writer).
const PRE_MIGRATION_KEYS = [
  'seq',
  'scenario',
  'purpose',
  'tools',
  'hashEditEscalationEnum',
  'escalationDenialSeen',
  'escalationHintSeen',
  'intentInjected',
  'continuationSeen',
  'pressureAdvisorySeen',
  'anchoredReadSeen',
  'sawDelegateProbe',
  'sawChildMarker',
  'sawRobashChild',
  'roBashWaitSeen',
  'roBashRmDenied',
  'sawClassifyCall',
  'sawGroupProbe',
  'groupRetrySeen',
  'mergedAlphaSeen',
  'mergedBetaSeen',
  'groupSettledSignalSeen',
  'sawRehydrateProbe',
  'settlementBlockedSeen',
  'rehydrateResumeCallSeen',
  'sawEscalateProbe',
  'escalationFindingsSeen',
  'sawBackgroundProbe',
  'backgroundChildSeen',
  'backgroundMarkerInParentContext',
  'sawTerminateProbe',
  'rehydrateResumeContextSeen',
  'editLockToolsSeen',
  // worktree scenario observations (lane contract, guard refusal, writer)
  'worktreeChild',
  'childSawLaneContract',
  'childGuardRefusal',
  'rehydrateResumedReportSeen',
  'rehydrateChildASeen',
  'lspToggledOn',
  'lspRenameSeen',
  'lspRenameStaleSeen',
  'lspDiagSeen',
  'lspDefSeen',
  'lspRefsSeen',
  'lspSymbolsSeen',
  'lspUnknownAfterOff',
  // Delegation-target guidance observations (targets scenario + the guidance
  // assertions added to the delegate scenario).
  'sawTargetsGuidance',
  'guidanceListsQuick',
  'guidanceListsEnabledCategory',
  'guidanceListsDisabledCategory',
  'guidanceLeftVariableRaw',
  'emitted',
  'emittedNames',
  'lastUser',
  'lastTool',
  // capstore scenario observation (capability-store probe tools advertised)
  'capstoreToolsSeen',
  'applyTxProbeSeen',
  'catalogLeak',
  'sawOneshot',
  'sawGroupSettled',
  'sawEscalated',
  'sawFork',
  'sawResumeCandidate',
  // jobs-aware todo continuation observations
  'jobsAwareParent',
  'jobsAwareChild',
  'settlementSeen',
  'compositionProbeServed',
  // cold-session scenario observation (task 5.5: convergence probe advertised)
  'coldProbeSeen',
]

const GENERIC_KEYS = ['seq', 'scenario', 'purpose', 'tools', 'emitted', 'emittedNames', 'lastUser', 'lastTool']

/** A synthetic obs good enough to enumerate a scenario's observe() keys. */
function syntheticObs() {
  return { transcript: '', lastUser: '', lastTool: '', system: '', toolNames: [], toolDefs: [], messages: [] }
}

function userOptions(text) {
  return { messages: [{ role: 'user', content: [{ type: 'text', text }] }], tools: [] }
}

describe('extract', () => {
  it('builds the observation base from one options pass', () => {
    const options = {
      system: 'the system prompt',
      tools: [{ name: 'read', parameters: { type: 'object' } }, { name: 'bash' }],
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'hello' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'working' }] },
        { role: 'tool', content: [{ type: 'text', text: 'tool output' }] },
      ],
    }
    const obs = extract(options)
    assert.equal(obs.system, 'the system prompt')
    assert.deepEqual(obs.toolNames, ['read', 'bash'])
    assert.equal(obs.toolDefs, options.tools)
    assert.equal(obs.messages, options.messages)
    assert.ok(obs.transcript.includes('user:\nhello'))
    assert.ok(obs.transcript.includes('tool:\ntool output'))
    assert.equal(obs.lastUser, 'hello')
    assert.equal(obs.lastTool, 'tool output')
  })

  it('tolerates missing fields', () => {
    const obs = extract({})
    assert.equal(obs.transcript, '')
    assert.equal(obs.lastUser, '')
    assert.equal(obs.lastTool, '')
    assert.equal(obs.system, '')
    assert.deepEqual(obs.toolNames, [])
    assert.deepEqual(obs.toolDefs, [])
    assert.deepEqual(obs.messages, [])
  })
})

describe('planRequest single extraction', () => {
  it('calls extract exactly once per request (decide + observe share the pass)', () => {
    let calls = 0
    const counting = (options) => {
      calls += 1
      return extract(options)
    }
    const { out, record } = planRequest(userOptions('深度工作：注册计划然后停住'), counting)
    assert.equal(calls, 1)
    // The deepwork probe answers with a todo_write tool call...
    const blockEnds = out.filter((chunk) => chunk.type === 'block-end')
    assert.deepEqual(record.emittedNames, blockEnds.map((chunk) => chunk.block?.name ?? chunk.block?.type))
    assert.ok(record.emittedNames.includes('todo_write'))
    // ...and the record carries the generic keys plus deepwork's observe keys.
    assert.deepEqual(
      Object.keys(record).sort(),
      ['scenario', 'purpose', 'tools', 'intentInjected', 'continuationSeen', 'emitted', 'emittedNames', 'lastUser', 'lastTool'].sort(),
    )
  })
})

describe('trace record key migration', () => {
  it('the union of per-scenario record keys equals the pre-migration superset', () => {
    const union = new Set(GENERIC_KEYS)
    for (const scenario of SCENARIOS) {
      for (const key of Object.keys(scenario.observe?.(syntheticObs()) ?? {})) union.add(key)
    }
    assert.deepEqual([...union].sort(), [...PRE_MIGRATION_KEYS].sort())
  })

  it('every scenario emits at least one observation key (no silent gap)', () => {
    for (const scenario of SCENARIOS) {
      const keys = Object.keys(scenario.observe?.(syntheticObs()) ?? {})
      assert.ok(keys.length > 0, `${scenario.id} observes nothing`)
    }
  })
})

describe('schema gate', () => {
  it('throws the verbatim strict-provider error before scenario logic', async () => {
    const options = {
      messages: [],
      tools: [{ name: 'bad-tool', parameters: { type: 'string' } }],
    }
    await assert.rejects(
      async () => {
        for await (const _chunk of streamScenario(options)) {
          // must not yield
        }
      },
      { message: `Invalid schema for function 'bad-tool': schema must be a JSON Schema of 'type: "object"'` },
    )
  })
})
