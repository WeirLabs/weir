// Child scope: the shared predicate, tool deny list, and collaboration
// contract that keep a delegated child's prompt and tool surface free of
// orchestrator-facing material. Pure module (no ctx, no imports) — the
// composition roots (core/delegate/worktree) and the spawn adapter consume
// it. Template-layer text is English by charter rule 3.7.

/**
 * Is this prompt-assembly context a delegated child? DSH's
 * systemPrompt.assemble() calls function-valued section/context text with
 * `(context)` = { agent, scope, signal } at EVERY assembly; a delegated
 * child's session header carries `delegationDepth >= 1`. Missing fields (main
 * agents) fail OPEN to main-agent rendering — the child check must never
 * swallow main-agent content.
 *
 * @param {any} context - systemPrompt assembly context ({ agent, scope, signal })
 * @returns {boolean}
 */
export function isDelegatedChild(context) {
  return (context?.agent?.session?.header?.delegationDepth ?? 0) >= 1
}

/**
 * Orchestrator-only tools every spawned child loses. A child cannot delegate,
 * supervise, steer lanes, drive plan/goal flows, ask the user, present files,
 * or hold edit locks — those verbs belong to the parent alone. Allow-list
 * filters (curated read-only targets) already exclude these and stay
 * untouched; see childToolFilter.
 */
export const CHILD_DENY_TOOLS = [
  'delegate',
  'subagent',
  'subagent_fork',
  'workflow',
  'resume_agent',
  'terminate_agent',
  'supervised_status',
  'interrupt_agent',
  'list_agents',
  'send_message',
  'worktree_open',
  'worktree_land',
  'worktree_cleanup',
  'worktree_abandon',
  'worktree_check',
  'exit_plan_mode',
  'create_goal',
  'get_goal',
  'update_goal',
  'ask_user_question',
  'present',
  'edit_lock_acquire',
  'edit_lock_hold',
  'edit_lock_pause',
  'edit_lock_release',
  'edit_lock_status',
  'edit_lock_try_steal',
]

/**
 * Merge the child deny list into a spawn tool filter. Allow-list filters
 * (read-only curated targets) already exclude orchestrator tools and are
 * returned unchanged — allow semantics stay untouched. Deny-list or absent
 * filters get CHILD_DENY_TOOLS merged in, deduped. Same merge pattern as
 * supervisedToolFilter in src/delegate/spawn-adapter.js, applied AFTER the
 * lane transform at the single request-assembly point.
 *
 * DSH's tools.restrict() REJECTS deny names the composition never registered
 * (e.g. ask_user_question/present/edit_lock_* are absent from a headless
 * composition), so `known` — the composition's restrictable tool names —
 * intersects the deny list. A name that is not registered needs no deny: it
 * is absent from the child's catalog either way. When `known` is not
 * resolvable the full list is kept (the desktop composition registers all).
 *
 * @param {{ allow?: string[], deny?: string[] } | undefined} filter
 * @param {{ has: (name: string) => boolean } | undefined} [known] - restrictable tool names of this composition
 * @returns {{ allow?: string[], deny: string[] } | { allow?: string[], deny?: string[] }}
 */
export function childToolFilter(filter, known) {
  if (filter?.allow !== undefined) return filter
  const deny = known ? CHILD_DENY_TOOLS.filter((name) => known.has(name)) : [...CHILD_DENY_TOOLS]
  return { ...filter, deny: [...new Set([...(filter?.deny ?? []), ...deny])] }
}

/**
 * The worker collaboration contract appended to every spawned child's persona
 * (both spawn lanes). It replaces what the suppressed orchestrator sections
 * used to imply: the child's final message IS the parent's report, it cannot
 * delegate further, and it cannot ask the user — decide from the task and the
 * codebase, or end with the concrete blocker. Supervised members additionally
 * carry SUPERVISION_CONTRACT, which stays last.
 */
export const WORKER_CONTRACT =
  '\n\nYou are a delegated child of the Orchestrator. Your final message is the report delivered to the parent — make it self-contained: what you changed or found, the evidence it works, and the assumptions you made. You cannot delegate further, and you cannot ask the user questions: decide from the task and the codebase. If you are genuinely blocked, end with the concrete blocker instead of retrying.'

/**
 * The continuation contract appended to a continuable child's persona AFTER
 * WORKER_CONTRACT (the continuable spawn lane; supervised members carry
 * SUPERVISION_CONTRACT instead — never both). Three facts the one-shot
 * worker contract does not cover: the parent may follow up after any turn,
 * every turn's final message is delivered to the parent automatically, and
 * an interrupted turn is not a cancelled task. Template-layer text is
 * English by charter rule 3.7.
 */
export const CONTINUABLE_CONTRACT =
  '\n\nYou are a continuable child: the parent may follow up with new messages after any of your turns, and each turn\'s final message is delivered to the parent automatically — keep it self-contained. An interrupted turn is not a cancelled task: wait for the next message and continue from your prior context.'
