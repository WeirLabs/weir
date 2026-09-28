---
name: refactor
description: "Guides a refactor, cleanup, or restructure with the right decomposition: codemap first, plan, then verified steps. Use when the user asks to refactor, simplify, extract, modernize, or reshape code."
metadata:
  short-description: Codemap-driven safe refactor protocol
---

# Intelligent Refactor

Performs deterministic refactoring with full codebase awareness. Unlike blind
search-and-replace, this protocol:

1. **Understands intent** — analyzes what the change must achieve.
2. **Maps the codebase** — builds a definitive codemap before touching anything.
3. **Assesses risk** — evaluates test coverage and fixes the verification strategy.
4. **Plans meticulously** — atomic, ordered, independently verifiable steps.
5. **Executes precisely** — one step at a time, verified after each step.
6. **Verifies constantly** — tests after each change, zero regression tolerated.

If the task is part of a larger evidence-driven push, run it under the
`deep-work` skill's discipline; this protocol plugs into its delegation and
verification rules.

---

# PHASE 0: INTENT GATE (MANDATORY FIRST STEP)

**BEFORE ANY ACTION, classify and validate the request.**

## Step 0.1: Parse Request Type

| Signal | Classification | Action |
|--------|----------------|--------|
| Specific file/symbol | Explicit | Proceed to codebase analysis |
| "Refactor X to Y" | Clear transformation | Proceed to codebase analysis |
| "Improve", "Clean up" | Open-ended | **MUST ask**: "What specific improvement?" |
| Ambiguous scope | Uncertain | **MUST ask**: "Which modules/files?" |
| Missing context | Incomplete | **MUST ask**: "What's the desired outcome?" |

## Step 0.2: Validate Understanding

Before proceeding, confirm:
- [ ] Target is clearly identified
- [ ] Desired outcome is understood
- [ ] Scope is defined (file/module/project)
- [ ] Success criteria can be articulated

**If ANY of the above is unclear, ASK a clarifying question:**

```
I want to make sure I understand the refactoring goal correctly.

**What I understood**: [interpretation]
**What I'm unsure about**: [specific ambiguity]

Options I see:
1. [Option A] - [implications]
2. [Option B] - [implications]

**My recommendation**: [suggestion with reasoning]

Should I proceed with [recommendation], or would you prefer differently?
```

## Step 0.3: Create Initial Todos

Immediately after understanding the request, register the phase todos with
`todo_write` (one per phase: analysis, codemap, test assessment, plan,
execution, final verification).

---

# PHASE 1: CODEBASE ANALYSIS (PARALLEL EXPLORATION)

## 1.1: Launch Parallel Explore Children (BACKGROUND)

Fire all of these simultaneously as background `delegate` children
(`agent="explore"`, one per lane):

1. **Target lookup**: all occurrences and definitions of [TARGET] — file
   paths, line numbers, usage patterns.
2. **Dependency chains**: everything that imports, uses, or depends on
   [TARGET] — import graph, call sites.
3. **Similar patterns**: analogous implementations and established conventions
   around [TARGET].
4. **Tests**: all test files related to [TARGET] — paths, case names, coverage
   indicators.
5. **Architecture context**: module boundaries, layer structure, and design
   patterns in use around [TARGET].

Every child prompt is self-contained: TASK / DELIVERABLE / SCOPE / VERIFY /
STOP WHEN.

## 1.2: Direct Exploration (WHILE CHILDREN RUN)

Do not idle — read the obvious spots yourself:

- `grep` / `glob` for text patterns, definitions, import statements.
- `git log`/`git blame` on the paths to touch for recent-change context.
- **Optional accelerators, only when actually available**: LSP semantic tools
  (go-to-definition, find-references, document symbols, diagnostics) if the
  session has an LSP lane enabled; `sg` (ast-grep) for structural pattern
  search if the binary is installed. These accelerate; they are never
  required — grep/glob is the baseline that always works.

## 1.3: Collect Results

Pull every child report with `job_output`, then mark the phase completed.

---

# PHASE 2: BUILD CODEMAP (DEPENDENCY MAPPING)

Construct the definitive codemap from Phase 1 results:

```
## CODEMAP: [TARGET]

### Core Files (Direct Impact)
- path/to/file.ts:L10-L50 — primary definition
- path/to/file2.ts:L25 — key usage

### Dependency Graph
[TARGET]
├── imports from: module-a (types), module-b (utils)
├── imported by: consumer-1.ts, consumer-2.ts
└── used by: handler.ts (direct call), service.ts (injection)

### Impact Zones
| Zone      | Risk   | Files | Test Coverage |
|-----------|--------|-------|---------------|
| Core      | HIGH   | 3     | 85%           |
| Consumers | MEDIUM | 8     | 70%           |
| Edge      | LOW    | 2     | 50%           |

### Established Patterns
- Pattern A: [description] — used in N places
```

Then identify constraints:

- **MUST follow**: existing patterns identified.
- **MUST NOT break**: critical dependencies.
- **Safe to change**: isolated code zones.
- **Requires migration**: breaking-change impact.

---

# PHASE 3: TEST ASSESSMENT (VERIFICATION STRATEGY)

## 3.1: Detect Test Infrastructure

Find the repo's actual test/typecheck/lint commands from its own manifests
(`package.json` scripts, `pyproject.toml`, `Makefile`, CI config, `*_test.go`
presence). Never invent a command the repo does not keep.

## 3.2: Analyze Coverage for the Target

One synchronous `delegate(agent="explore")` child (or direct reading): which
test files cover [TARGET], what cases exist, integration coverage, edge cases,
estimated coverage level.

## 3.3: Determine Verification Strategy

| Coverage Level | Strategy |
|----------------|----------|
| HIGH (>80%) | Run existing tests after each step |
| MEDIUM (50-80%) | Run tests + add safety assertions |
| LOW (<50%) | **PAUSE**: propose adding tests first |
| NONE | **BLOCK**: refuse aggressive refactoring |

**If coverage is LOW or NONE, ask the user** (add-tests-first / extra-caution /
abort) before writing a line.

## 3.4: Document the Verification Plan

```
## VERIFICATION PLAN
### Commands
- Unit: [repo's command]  - Integration: [if exists]  - Type/lint: [if exists]
### Checkpoint after each step
1. Diagnostics/type check → no new errors
2. Test command → all pass
### Regression indicators
- [specific test that must pass] [behavior to preserve] [API contract]
```

---

# PHASE 4: PLAN GENERATION

## 4.1: Commission the Plan

`delegate(category="architect")` with: the refactoring goal, the codemap, the
verification plan, and the constraints. Require:

1. Atomic steps, each independently verifiable.
2. Dependency-ordered (what must happen first).
3. Exact files and line ranges per step.
4. A rollback strategy per step.
5. Commit checkpoints.
6. A staffing split: which steps are **mechanical** (rename, move, inline,
   signature change) vs **reasoning** (extract function, conditional
   restructure, cross-file API change) — this feeds the parallel fan-out
   addendum below.

## 4.2: Review and Validate

- Completeness: every identified file addressed?
- Safety: every step reversible?
- Order: dependencies respected?
- Verification: commands named per checkpoint?

## 4.3: Register Granular Todos

Convert the plan into `todo_write` items: one `refactor-N` step todo paired
with one `verify-N` todo, transitions in real time.

---

# PHASE 5: EXECUTE (DETERMINISTIC STEPS)

## 5.1: Per-Step Protocol

**Pre-step**: mark todo in_progress; read the current file state.

**Execute** with the appropriate tool:

- Anchored edits via `hash_edit` for precise, verifiable changes (anchors
  copied verbatim from read output).
- Structural pattern transformations: preview first (e.g. `sg --pattern ...
  --rewrite ...` when ast-grep is installed), review the preview, then apply.
- Symbol renames: use the `lsp_rename` tool when LSP is enabled for the
  session (the language server computes the cross-file edit set and the
  plugin applies it through the fs version guard); otherwise careful
  grep-mapped anchored edits with a post-rename grep sweep for stragglers.

**Post-step verification (MANDATORY)**: type/lint check → no new errors; test
command → all pass. Pass → todo completed. Fail → **STOP AND FIX**.

## 5.2: Failure Recovery

If any verification fails:

1. **STOP** immediately. 2. **REVERT** the failed change. 3. **DIAGNOSE**.
4. Options: fix and retry / skip if optional / consult
   `delegate(agent="oracle")` / ask the user.

**NEVER proceed to the next step with broken tests.**

## 5.3: Commit Checkpoints

After each logical group of changes, commit in the repository's own commit
convention. Checkpoints make per-step rollback real, not theoretical.

---

# PHASE 6: FINAL VERIFICATION

1. Full test suite. 2. Full type check. 3. Lint. 4. Build (if applicable).
5. Diagnostics over every changed file — all clean.
6. Summary: what changed (by intent, not file-by-file narration), files
   modified, verification results (tests/type/lint/build), and an explicit
   **No Regressions Detected** line backed by the evidence.

---

# PARALLEL FAN-OUT ADDENDUM (large plans)

For plans with **3+ file-independent steps**, dispatch execution instead of
walking steps serially:

- **Mechanical steps** → `delegate(category="quick")` workers, fanned out in
  one burst, each with disjoint write scopes (no two children edit the same
  files — non-negotiable).
- **Reasoning steps** → `delegate(category="general-low")` workers, same
  disjoint-scope rule; ambiguous steps report back UNCLEAR instead of
  improvising.
- **Verification stays outside the workers**: after each worker completion,
  spawn an independent verifier (`delegate(category="deep")`, foreground or
  background) with the touched files and the verification spec; it returns
  PASS or FAIL with the failing test and suggested revert hunks. A commit
  checkpoint happens only on verifier PASS.
- On FAIL: retry the step with the verifier's failure as a fix hint (re-spawn
  smaller); three FAIL cycles on one step → STOP and consult the user with
  full evidence.
- You orchestrate only in this mode: no direct edits, no running tests
  yourself — the verifier lane owns that.

Cross-file dependent steps never fan out; run them serially per the base
protocol.

---

# CRITICAL RULES

## NEVER DO
- Proceed with failing tests.
- Make changes without understanding impact.
- Use `as any`, `@ts-ignore`, `# type: ignore`, or equivalent escape hatches.
- Delete tests to make them pass.
- Commit broken code.
- Refactor without understanding existing patterns.

## ALWAYS DO
- Understand before changing.
- Preview structural transformations before applying.
- Verify after every change.
- Follow existing codebase patterns.
- Keep todos updated in real time.
- Commit at logical checkpoints.
- Report issues immediately.

## ABORT CONDITIONS — STOP and consult the user
- Test coverage is zero for target code.
- Changes would break a public API.
- Refactoring scope is unclear.
- 3 consecutive verification failures.
- User-defined constraints violated.

---

# Tool Usage Philosophy

- **Baseline (always works)**: `grep`/`glob` for discovery, `read` + anchored
  `hash_edit` for changes, the repo's own test/type/lint commands for proof.
- **Optional accelerators (only when present)**: LSP semantic tools for
  definition/reference mapping, rename, and diagnostics; `sg` (ast-grep) for
  structural search/rewrite previews. Never block on their absence.
- **Children**:
  - `delegate(agent="explore")` — parallel codebase pattern discovery.
  - `delegate(agent="oracle")` — read-only consultation for complex
    architectural decisions and debugging.
  - `delegate(category="architect")` — plan generation and design review.
  - `delegate(agent="librarian")` — **use proactively** on deprecated methods
    or library migrations: fetch the recommended modern alternative and
    current API docs before changing call sites. Never auto-upgrade versions
    unless the user explicitly requested a migration.

**Remember: refactoring without tests is reckless; refactoring without
understanding is destructive. This protocol ensures you do neither.**
