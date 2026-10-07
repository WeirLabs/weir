// child-scope: pins for the shared delegated-child predicate, the
// orchestrator-only tool deny list + merge, and the worker collaboration
// contract (src/shared/child-scope.js). Pure module — driven directly.
import { describe, expect, it } from './helpers.js'
import { CHILD_DENY_TOOLS, CONTINUABLE_CONTRACT, WORKER_CONTRACT, childToolFilter, isDelegatedChild } from '../src/shared/child-scope.js'

describe('isDelegatedChild', () => {
  it('fails open to main-agent rendering when fields are missing', () => {
    expect(isDelegatedChild(undefined)).toBe(false)
    expect(isDelegatedChild(null)).toBe(false)
    expect(isDelegatedChild({})).toBe(false)
    expect(isDelegatedChild({ agent: {} })).toBe(false)
    expect(isDelegatedChild({ agent: { session: {} } })).toBe(false)
    expect(isDelegatedChild({ agent: { session: { header: {} } } })).toBe(false)
    expect(isDelegatedChild({ agent: { session: { header: { delegationDepth: undefined } } } })).toBe(false)
  })

  it('is false at depth 0 and true at any delegation depth >= 1', () => {
    expect(isDelegatedChild({ agent: { session: { header: { delegationDepth: 0 } } } })).toBe(false)
    expect(isDelegatedChild({ agent: { session: { header: { delegationDepth: 1 } } } })).toBe(true)
    expect(isDelegatedChild({ agent: { session: { header: { delegationDepth: 2 } } } })).toBe(true)
  })
})

describe('CHILD_DENY_TOOLS', () => {
  it('covers every orchestrator-only tool family', () => {
    const expected = [
      'delegate', 'subagent', 'subagent_fork', 'workflow',
      'resume_agent', 'terminate_agent', 'supervised_status', 'interrupt_agent', 'list_agents', 'send_message',
      'worktree_open', 'worktree_land', 'worktree_cleanup', 'worktree_abandon', 'worktree_check',
      'exit_plan_mode',
      'ask_user_question', 'present',
      'edit_lock_acquire', 'edit_lock_hold', 'edit_lock_pause', 'edit_lock_release', 'edit_lock_status', 'edit_lock_try_steal',
    ]
    expect(CHILD_DENY_TOOLS).toEqual(expected)
    expect(new Set(CHILD_DENY_TOOLS).size).toBe(CHILD_DENY_TOOLS.length)
  })
})

describe('childToolFilter', () => {
  it('turns an absent filter into a deny-only filter with the full child deny list', () => {
    expect(childToolFilter(undefined)).toEqual({ deny: [...CHILD_DENY_TOOLS] })
  })

  it('merges and dedupes into an existing deny list', () => {
    const merged = childToolFilter({ deny: ['rm', 'delegate'] })
    expect(merged.deny).toEqual(['rm', ...CHILD_DENY_TOOLS])
    expect(merged.deny.filter((name) => name === 'delegate')).toHaveLength(1)
  })

  it('returns allow-list filters unchanged (allow semantics untouched)', () => {
    const allow = { allow: ['bash', 'read'] }
    expect(childToolFilter(allow)).toBe(allow)
    const withDeny = { allow: ['bash'], deny: ['rm'] }
    expect(childToolFilter(withDeny)).toBe(withDeny)
  })

  it('intersects the deny list with the composition\'s restrictable names (tools.restrict rejects unknown names)', () => {
    // Headless composition shape: no ask_user_question/present/edit_lock_*.
    const known = new Set(['bash', 'read', 'delegate', 'workflow', 'send_message'])
    expect(childToolFilter(undefined, known)).toEqual({ deny: ['delegate', 'workflow', 'send_message'] })
    const merged = childToolFilter({ deny: ['rm'] }, known)
    expect(merged.deny).toEqual(['rm', 'delegate', 'workflow', 'send_message'])
    // Allow lists still win over the intersection.
    const allow = { allow: ['bash'] }
    expect(childToolFilter(allow, known)).toBe(allow)
  })
})

describe('WORKER_CONTRACT', () => {
  it('pins the verbatim contract text', () => {
    expect(WORKER_CONTRACT).toBe(
      '\n\nYou are a delegated child of the Orchestrator. Your final message is the report delivered to the parent — make it self-contained: what you changed or found, the evidence it works, and the assumptions you made. You cannot delegate further, and you cannot ask the user questions: decide from the task and the codebase. If you are genuinely blocked, end with the concrete blocker instead of retrying.',
    )
  })

  it('states the three obligations a child loses with the orchestrator sections', () => {
    expect(WORKER_CONTRACT).toContain('final message is the report delivered to the parent')
    expect(WORKER_CONTRACT).toContain('cannot delegate further')
    expect(WORKER_CONTRACT).toContain('cannot ask the user questions')
  })
})

describe('CONTINUABLE_CONTRACT', () => {
  it('pins the verbatim contract text', () => {
    expect(CONTINUABLE_CONTRACT).toBe(
      '\n\nYou are a continuable child: the parent may follow up with new messages after any of your turns, and each turn\'s final message is delivered to the parent automatically — keep it self-contained. An interrupted turn is not a cancelled task: wait for the next message and continue from your prior context.',
    )
  })

  it('states the three continuation facts a one-shot contract does not cover', () => {
    expect(CONTINUABLE_CONTRACT).toContain('follow up with new messages after any of your turns')
    expect(CONTINUABLE_CONTRACT).toContain('final message is delivered to the parent automatically')
    expect(CONTINUABLE_CONTRACT).toContain('interrupted turn is not a cancelled task')
  })

  it('never carries the supervised terminal-status vocabulary', () => {
    expect(CONTINUABLE_CONTRACT).not.toContain('STATUS:')
    expect(CONTINUABLE_CONTRACT).not.toContain('Terminal status contract')
  })
})
