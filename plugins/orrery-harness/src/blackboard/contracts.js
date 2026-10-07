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

/** The promotion-evaluation brief (design D6, slice 3): injected as one
 * followup/steer message into the MAIN agent when the user clicks the
 * panel's promotion button. Before this message the agent knows NOTHING
 * about promotion (design: agents must not know promotion exists), so the
 * template is deliberately complete on its own: board access, evaluation
 * criteria, the per-entry adjudication interaction, the landing formats
 * per destination, the after-marking, and the single-pass stop rule.
 * English template-layer text (charter rule 3.7). */
export const PROMOTION_REQUEST_TEMPLATE = `Blackboard promotion request — the user clicked the evaluation action in the blackboard panel. This message is the automatic evaluation brief, not a user instruction. It asks you to run exactly one curation pass over this conversation's blackboard, and nothing beyond it.

1. Gather the board.
Run blackboard_list with no filter to get every entry and its read/subscribe counts, then blackboard_read the candidate keys in one batch for their full content. Entries already marked promoted carry a promoted marker with their destination — skip them: they are read-only and already landed.

2. Rank and judge.
Rank the non-promoted entries by readCount, then subscribeCount — usage is the empirical evidence a finding keeps getting reused. Then reverse-check the four write triggers (cost, surprise, dead end, irreversible): an entry that satisfies none of them, or that one cheap command can re-derive, is noise. Finally judge durable value: would a FUTURE session in this repository still need this finding, and is it stable enough to live in a persistent document? The board is session-scoped and disappears when the conversation ends — promotion is the only way a finding survives.

3. Present candidates and adjudicate with the user.
Present each candidate as one short block: key, one-line summary, read/subscribe counts, your recommended destination, and a one-line reason. Then call ask_user_question once per candidate (stable id blackboard-promotion) with these four options, your recommendation FIRST and marked "(Recommended)":
- docs/spikes.md — verified runtime hard contracts and constraints (the S-numbered contract log).
- runtime map — where-things-live layout knowledge: modules/packages, responsibilities, entry points.
- AGENTS.md pointer — cross-cutting agent discipline: a one-line pointer into AGENTS.md's knowledge map.
- discard — leave the entry on the board untouched; no doc write, no marking.
Write no document until the user has answered.

4. Land each promoted entry.
Only after the user's answers, for every entry they picked a destination for:
- docs/spikes.md: append a new S-numbered section (the next free number) to the repository's docs/spikes.md in the file's existing format — finding, evidence, re-verify command — and mention the blackboard key in the section title.
- runtime map: merge the entry into the repository's runtime-layout documentation (a repo-root architecture map, CONTEXT.md, or docs/design.md — whatever exists): a bullet with the key, what lives where, and its responsibility; never a copy of the full content.
- AGENTS.md pointer: add one line to AGENTS.md's knowledge map — the blackboard key, the one-sentence fact, and "full content on the session blackboard". The full content stays on the board.
Use your file tools for the writes; never invent content beyond what the entry testifies.

5. Mark the promoted entries.
After the doc writes, call blackboard_mark_promoted once per promoted entry with its key and destination (docs/spikes.md, runtime-map or agents-pointer). The entry then becomes read-only on the board: its content and counts keep serving the session, but nobody can edit or delete it anymore. Discarded entries are NOT marked.

6. Stop.
After the landing and the marking, end your turn. Never start additional turns, delegate, or take any other action beyond this single evaluation pass.`
