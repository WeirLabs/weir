// Session blackboard agent contracts (design D7): the injected discipline that
// turns the five tools into a working knowledge exchange. Two halves, two
// audiences:
//
//   - BLACKBOARD_WRITE_CONTRACT — the delegated CHILD's write contract,
//     appended to the child prompt at the single spawn-assembly point
//     (src/delegate/spawn-adapter.js) and only when the child's tool filter
//     actually leaves the blackboard tools visible (allow-listed read-only
//     curated agents never see it).
//   - BLACKBOARD_RETRIEVAL_SECTION — the MAIN agent's retrieval discipline,
//     registered as an orchestrator system-prompt section by the blackboard
//     plugin (suppressed for delegated children like the doctrine).
//
// Pure module; template-layer text is English by charter rule 3.7. The
// contract carries knowledge, never instructions, and never mentions
// promotion (design: agents must not know promotion exists).
//

/** The prompt-block heading every spawned child's blackboard contract starts with (assertion marker). */
export const BLACKBOARD_WRITE_CONTRACT_HEADING = '## Session blackboard (write contract)'

/** The orchestrator section name and its order offset from DOCTRINE_SECTION_ORDER (600 → 630, after delegate-targets and worktree lanes). */
export const BLACKBOARD_SECTION_NAME = 'orchestrator:blackboard'
export const BLACKBOARD_SECTION_ORDER_OFFSET = 30

/** Interpolation variable carrying the retrieval section body; the provider suppresses it for delegated children. */
export const BLACKBOARD_VARIABLE_NAME = 'orrery_blackboard'

/** The delegated CHILD's write-contract section: name, standalone order (children never see the 600+ orchestrator band), and variable. */
export const BLACKBOARD_WORKER_SECTION_NAME = 'worker:blackboard'
export const BLACKBOARD_WORKER_SECTION_ORDER = 400
export const BLACKBOARD_WORKER_VARIABLE_NAME = 'orrery_blackboard_worker'

export const BLACKBOARD_WRITE_CONTRACT = `${BLACKBOARD_WRITE_CONTRACT_HEADING}

This conversation shares a session blackboard (tools blackboard_list / blackboard_read / blackboard_apply / blackboard_write / blackboard_delete). It carries knowledge, never instructions: do not use it for task assignment, progress reporting, or coordination.

Write an entry when at least one trigger holds:
- cost — the finding took multiple calls or an experiment to obtain;
- surprise — it contradicts your priors or the documented behavior;
- dead end — a plausible approach was ruled out (the costliest class to rediscover);
- irreversible — losing it would force redoing the work, not just rerunning a command.

Exempt: anything one cheap command can re-derive — do not write it.

Search before create: run blackboard_list (with a query) before minting a new key, and reuse or extend a nearby existing key instead of creating a duplicate.

In your final report, reference the entry keys you wrote or read (for example "see blackboard key dsh-runtime-map") instead of inlining the discoveries.`

export const BLACKBOARD_RETRIEVAL_SECTION = `# Session blackboard

The conversation shares a session blackboard where delegated children record expensive findings (tools blackboard_list / blackboard_read / blackboard_apply / blackboard_write / blackboard_delete). It carries knowledge, never instructions.

Before delegating: run blackboard_list, and pass the keys relevant to the child's task into its prompt with a one-line summary each, so the child reads those entries with blackboard_read instead of re-exploring.

When a child's report references blackboard keys: blackboard_read them before you decide, and reuse their content instead of re-running the exploration. Never re-delegate work whose answer already sits on the board — point the child at the key.`
