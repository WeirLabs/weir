// Default category registry for the orrery preset. Semantics ported from OmO's
// category system, renamed and re-grounded on DSH primitives. Default chains are
// empty: children inherit the session route until the deployment maps a
// category to an explicit provider/model chain via configuration.

/**
 * @typedef {object} CategoryDefinition
 * @property {string} description - caller-facing: what kind of work routes here
 * @property {string} guidance - caller-facing routing guidance
 * @property {string} promptAppend - child-facing mindset contract (English)
 * @property {Array<{ provider: string, model: string, reasoningEffort?: string }>} chain
 * @property {string[]} [gateModels]
 * @property {boolean} [disabled]
 * @property {string} [reasoningEffort] - effort hint applied when chain is empty
 * @property {boolean} [readOnly] - whether the worker is read-only (advisory lanes)
 */

/** @type {Record<string, CategoryDefinition>} */
export const DEFAULT_CATEGORIES = {
  quick: {
    description: 'Trivial mechanical work: single-file changes, typo fixes, boilerplate, config/copy edits.',
    guidance: 'Default for every splittable piece; fan out several quick children in one burst when scopes are disjoint.',
    reasoningEffort: 'low',
    chain: [],
    promptAppend: `<Category_Context name="quick">
This is a mechanical, bounded task: one file, one pattern, no open design decisions. Do exactly what the task says — no refactors, no drive-by improvements, no scope growth. Match the file's existing conventions exactly. Report the change and the evidence that it works; stop the moment the success criteria hold.
</Category_Context>`,
  },

  deep: {
    description: 'One goal, one deliverable; decisions the codebase can settle. Debugging, cross-module work, subtle logic.',
    guidance: 'The default deep lane: hand it ONE goal and ONE deliverable. It may return ESCALATE: deep-plus when the central decision cannot be settled from evidence.',
    reasoningEffort: 'medium',
    chain: [],
    promptAppend: `<Category_Context name="deep">
One goal, one deliverable. Before any change, read the files involved and trace their dependencies until you can explain the mechanism you are about to modify. The goal is already defined: do not ask clarifying questions; make reasonable assumptions, record them in the final message, and proceed.

Escalation is a complete result. When the correct choice depends on a trade-off the brief does not settle, a contract other code relies on, or an argument about invariants you cannot verify by running something, stop before editing and return \`ESCALATE: deep-plus\` as the first line, followed by what you read, the decision you could not settle, and the options you saw.

Prefer the fix that removes the cause over the patch that hides the symptom. Report completion with the changes made and the evidence they work.
</Category_Context>`,
  },

  'deep-plus': {
    description: 'Escalation lane: the central decision cannot be settled from evidence alone (trade-offs, contracts, invariants).',
    guidance: 'Usually reached by escalation from deep; direct routing is valid for genuinely hard, logic-heavy problems — hand it the goal, not steps.',
    reasoningEffort: 'high',
    chain: [],
    promptAppend: `<Category_Context name="deep-plus">
The central decision here cannot be settled from evidence alone: a trade-off, a contract other code depends on, a mechanism with no pattern to copy, or correctness that must be argued from invariants. The exploration budget is generous: read every file involved, trace callers and dependencies in both directions, until you can explain the full mechanism you are about to change.

The goal is the authorization. Choose how to reach it yourself. Fix the cause, preferring the change that makes the failure impossible over the guard that hides it; the diff stays as small as the fix allows. Close with the delivered change, the evidence that it works, the decision you settled with the alternative you rejected, and the assumptions you made.
</Category_Context>`,
  },

  visual: {
    description: 'Frontend, UI/UX, styling, animation, layout work.',
    guidance: 'All browser-facing implementation and styling work routes here.',
    reasoningEffort: 'medium',
    chain: [],
    promptAppend: `<Category_Context name="visual">
You are implementing a user-facing visual surface. Craft matters: match the project's design language, spacing, typography, and interaction patterns exactly. After each change, verify the rendered result before the next one — read the page output, check the layout at the relevant viewport widths, and never declare visual work done from code reading alone.
</Category_Context>`,
  },

  writing: {
    description: 'Documentation, prose, technical writing, README and guide work.',
    guidance: 'Documentation and prose route here.',
    reasoningEffort: 'low',
    chain: [],
    promptAppend: `<Category_Context name="writing">
You are writing prose for humans: documentation, guides, explanations. Match the repository's existing documentation voice and structure. Be concrete: every claim names the file, command, or behavior it rests on. No marketing tone, no filler sections, no restating the obvious.
</Category_Context>`,
  },

  'general-low': {
    description: "Small tasks that fit no other category.",
    guidance: 'Fallback lane for small work that fits no specialist category.',
    reasoningEffort: 'low',
    chain: [],
    promptAppend: `<Category_Context name="general-low">
A bounded task in an unfamiliar area. Read the relevant code before changing it, follow local patterns, keep the change small, and report with evidence. Ask no questions you can answer by reading.
</Category_Context>`,
  },

  'general-high': {
    description: 'Standard features spanning a few files with known patterns.',
    guidance: 'Default for cohesive multi-file features with established in-repo patterns.',
    reasoningEffort: 'medium',
    chain: [],
    promptAppend: `<Category_Context name="general-high">
This task spans several files or modules. Before committing to an approach, survey every caller and consumer of what you will modify, the tests that encode the current behavior, and the history of the area. Deliver the change consistently across every surface it touches, so no caller, test, doc, or config still describes the old state. Decide from context, record assumptions in the final message, and finish.
</Category_Context>`,
  },

  artistry: {
    description: 'Highly creative or artistic tasks, novel ideas, design exploration.',
    guidance: 'Novel, creative, or open-ended design work routes here.',
    reasoningEffort: 'medium',
    chain: [],
    promptAppend: `<Category_Context name="artistry">
This is creative work without an established pattern. Propose boldly within the constraints given, then make the result concrete and verifiable. Novelty is welcome; vagueness is not — the deliverable must exist and work, not just be described.
</Category_Context>`,
  },

  architect: {
    description: 'Advisory architecture consult: module boundaries, decomposition, trade-offs. Read-only.',
    guidance: 'Design consultation lane. Advisory only: it reads and recommends, it never writes.',
    reasoningEffort: 'high',
    readOnly: true,
    chain: [],
    promptAppend: `<Category_Context name="architect">
You are an architecture consultant. You are read-only: survey the system, weigh trade-offs, and propose designs; you never edit files. Give one clear recommendation with the reasons it wins, the strongest alternatives with the reasons they lose, the risks you see, and the migration or implementation shape you would take. Cite the code you read for every load-bearing claim.
</Category_Context>`,
  },
}
