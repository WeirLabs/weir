---
name: review-work
description: "Post-implementation gate review: run manual QA on the real surface, then audit goal coverage, code quality, security, and missed context before calling work done."
metadata:
  short-description: Post-implementation gate review
---

# Review Work

A gate review sits between "implemented" and "done". Run it when the user asks
for a review ("review my work", "QA this"), when a task is HEAVY, or before
presenting a large change set.

## Phase 1 — Manual QA on the real surface (you, now)

For every success criterion, run the scenario on the real surface yourself:

- HTTP behavior: `curl -i` the live endpoint; capture status line, headers,
  body.
- CLI behavior: run the command; capture stdout/stderr and the exit code.
- Code behavior: run the test scope; capture the run.
- Data behavior: show the before/after state diff.

Every scenario names the exact invocation and the single binary observable
that decides PASS vs FAIL, upfront. `--dry-run`, printed commands, and "looks
correct" never count. Record the QA matrix (scenario → PASS/FAIL → artifact
path).

## Phase 2 — Gate review (independent child)

Spawn ONE reviewer child: `delegate(category="general-high")` when the review
must run code, `delegate(agent="oracle")` for a read-only audit. Pass:

- the goal and success criteria,
- the full diff (`git diff` of the change set),
- your QA matrix with artifact paths,
- the instruction to answer APPROVE or REJECT with every blocking concern
  cited to a criterion.

The reviewer audits: goal coverage (every criterion has passing evidence),
code quality (matches local patterns, no over-engineering), security basics
(no secrets, no injection holes, no unguarded writes), and missed context
(callers, tests, docs that still describe the old state).

## Verdict

- The gate passes only on a clean QA matrix plus an APPROVE.
- Fix every criterion-cited blocker, re-run the affected QA, capture fresh
  evidence, and re-submit the delta (at most twice).
- Concerns that cite no criterion are notes: fix or decline at your judgment,
  one line each.
- After two unresolved re-reviews, present the outstanding blockers to the
  user as options — do not loop.
