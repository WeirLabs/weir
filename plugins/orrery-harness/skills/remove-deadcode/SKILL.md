---
name: remove-deadcode
description: "Removes unused code with zero-false-positive verification and parallel removal batches: compiler scan, per-symbol reference checks, atomic commits. Use when asked to remove dead code, clean up unused symbols, or prune orphaned files."
metadata:
  short-description: Verified dead-code removal with parallel batches
---

# Remove Dead Code

Dead code removal via parallel delegate batches. You are the ORCHESTRATOR — you
scan, verify, batch, then delegate ALL removals to parallel children. Run this
workflow under the `deep-work` skill's discipline: every removal is verified,
every batch leaves the project green.

<rules>
- **Reference verification is law.** Confirm zero references before ANY removal
  decision — never remove on a name-match hunch.
- **Never remove entry points.** Entry files, barrel `index.ts` re-exports,
  test files, config files, and anything the project manifest exports are
  off-limits.
- **You do NOT remove code yourself.** You scan, verify, batch, then fire
  delegate children. They do the work.
</rules>

<false-positive-guards>
NEVER mark as dead:
- Symbols in entry files or barrel `index.ts` re-exports
- Symbols referenced in test files (tests are valid consumers)
- Symbols with `@public` / `@api` JSDoc tags
- Factory functions and definitions registered by name (hook/tool/agent
  factories, registry entries)
- Symbols referenced in `package.json` exports, plugin manifests, skill or
  command definitions, or any config file
</false-positive-guards>

---

## PHASE 1: SCAN — Find Dead Code Candidates

Run all of these in parallel:

<parallel-scan>

**TypeScript strict mode (your primary scanner — run this FIRST):**
```bash
npx tsc --noEmit --noUnusedLocals --noUnusedParameters 2>&1
```
This gives you the definitive list of unused locals, imports, parameters, and
types with exact file:line locations. For non-TypeScript projects, use the
language-native equivalent (compiler or linter warnings for unused code).

**Finder children (fire ALL simultaneously in the background):**

```
delegate(agent="finder", run_in_background=true,
  prompt="TASK: Find files in src/ NOT imported by any other file. Check all import statements. EXCLUDE: index/barrel files, test files, entry points, docs, config. DELIVERABLE: file paths only. SCOPE: src/ VERIFY: each candidate's import count is zero. STOP WHEN: the list is complete")

delegate(agent="finder", run_in_background=true,
  prompt="TASK: Find exported functions/types/constants in src/ that no other file imports. Cross-reference: for each export, grep the symbol name across src/ — if it only appears in its own file, it is a candidate. EXCLUDE: barrel/entry exports and test files. DELIVERABLE: file path, line, symbol name, export type. SCOPE: src/ VERIFY: every candidate cross-checked. STOP WHEN: the list is complete")
```

</parallel-scan>

Collect all results into a master candidate list.

---

## PHASE 2: VERIFY — Reference Confirmation (Zero False Positives)

For EACH candidate from Phase 1, confirm zero references:

- **When LSP tooling is available** (a find-references capability wired into
  the environment): use it as the accelerator —
  `findReferences(file, line, character, includeDeclaration=false)`.
  0 references → CONFIRMED dead; 1+ → NOT dead, drop from list.
- **Baseline path (always available): grep cross-reference.** Search the whole
  repo for the symbol name and its common usage forms (import lines, qualified
  references, string references in registries/configs). Exclude the declaration
  site itself. Zero remaining hits → CONFIRMED dead. Any ambiguous hit —
  including dynamic import, reflection, or string-template usage you cannot
  rule out → NOT dead, drop from list. When unsure, the symbol stays.

Also apply the false-positive-guards above. Produce a confirmed list:

```
| # | File | Symbol | Type | Action |
|---|------|--------|------|--------|
| 1 | src/foo.ts:42 | unusedFunc | function | REMOVE |
| 2 | src/bar.ts:10 | OldType | type | REMOVE |
| 3 | src/baz.ts:7 | ctx | parameter | PREFIX _ |
```

**Action types:**
- `REMOVE` — delete the symbol/import/file entirely
- `PREFIX _` — unused function parameter required by signature → rename to `_paramName`

If ZERO confirmed: report "No dead code found" and STOP.

---

## PHASE 3: BATCH — Group by File for Conflict-Free Parallelism

<batching-rules>

**Goal: maximize parallel children with ZERO write-scope overlap.**

1. Group confirmed dead code items by FILE PATH
2. All items in the SAME file go to the SAME batch (prevents two children editing the same file)
3. If a dead FILE (entire file deletion) exists, it's its own batch
4. Target 5-15 batches. If fewer than 5 items total, use 1 batch per item.

**Example batching:**
```
Batch A: [src/hooks/foo/hook.ts — 3 unused imports]
Batch B: [src/features/bar/manager.ts — 2 unused constants, 1 dead function]
Batch C: [src/tools/baz/tool.ts — 1 unused param, src/tools/baz/types.ts — 1 unused type]
Batch D: [src/dead-file.ts — entire file deletion]
```

Files in the same directory CAN be batched together (they won't conflict as long as no two children edit the same file). Maximize batch count for parallelism.

</batching-rules>

---

## PHASE 4: EXECUTE — Fire Parallel Delegate Children

For EACH batch, fire one delegate child:

```
delegate(category="general-high",
  load_skills=["git-master"],
  run_in_background=true,
  name="deadbatch-N",
  prompt="[see template below]")
```

Use `quick` for single-file mechanical batches. When the batch touches typed
languages and the `programming` skill is available in the catalog, add it to
`load_skills`.

<agent-prompt-template>

Every child gets this prompt structure (fill in the specifics per batch):

```
TASK: Remove dead code from [file list]

## DEAD CODE TO REMOVE

### [file path] line [N]
- Symbol: `[name]` — [type: unused import / unused constant / unused function / unused parameter / dead file]
- Action: [REMOVE entirely / REMOVE from import list / PREFIX with _]

### [file path] line [N]
- ...

## PROTOCOL

1. Read each file to understand exact syntax at the target lines
2. For each symbol, RE-VERIFY it is still dead (another child may have changed things): grep the symbol repo-wide beyond its declaration — zero hits means dead
3. Apply the change:
   - Unused import (only symbol in line): remove entire import line
   - Unused import (one of many): remove only that symbol from the import list
   - Unused constant/function/type: remove the declaration. Clean up trailing blank lines.
   - Unused parameter: prefix with `_` (do NOT remove — required by signature)
   - Dead file: delete with `rm`
4. After ALL edits in this batch, run the project's typecheck (detect it from the manifest scripts, e.g. `npm run typecheck` / `pnpm run typecheck`; fall back to the cheapest compile or lint check)
5. If typecheck fails: `git checkout -- [files]` and report failure
6. If typecheck passes: stage ONLY your files and commit:
   `git add [your-specific-files] && git commit -m "refactor: remove dead code from [brief file list]"`
7. Report what you removed and the commit hash

## CRITICAL
- Stage ONLY your batch's files (`git add [specific files]`). NEVER `git add -A` — other children are working in parallel.
- If typecheck fails after your edits, REVERT all changes and report. Do not attempt to fix.
- Pre-existing test failures in other files are expected. Only typecheck matters for your batch.

DELIVERABLE: the removed symbols and the commit hash
SCOPE: only the files listed above
VERIFY: typecheck passes after your edits
STOP WHEN: the batch is committed or reverted
```

</agent-prompt-template>

Fire ALL batches simultaneously, then END THE TURN while they run — settlement
notices wake you. Pull each report with `job_output`.

---

## PHASE 5: FINAL VERIFICATION

After ALL children complete, run the project's own gates:

```bash
# the project's typecheck — must pass
# the project's test suite — note any NEW failures vs pre-existing
# the project's build — must pass
```

Produce summary:

```markdown
## Dead Code Removal Complete

### Removed
| # | Symbol | File | Type | Commit | Batch |
|---|--------|------|------|--------|-------|
| 1 | unusedFunc | src/foo.ts | function | abc1234 | Batch A |

### Skipped (child reported failure)
| # | Symbol | File | Reason |
|---|--------|------|--------|

### Verification
- Typecheck: PASS/FAIL
- Tests: X passing, Y failing (Z pre-existing)
- Build: PASS/FAIL
- Total removed: N symbols across M files
- Total commits: K atomic commits
- Parallel children used: P
```

---

## SCOPE CONTROL

When the user names a scope, narrow the scan:
- File path → only that file
- Directory → only that directory
- Symbol name → only that symbol
- No scope given → full project scan (default)

## ABORT CONDITIONS

STOP and report if:
- More than 50 candidates found (ask user to narrow scope or confirm proceeding)
- Build breaks and cannot be fixed by reverting
