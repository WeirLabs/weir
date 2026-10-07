---
name: work-with-pr
description: "Full PR lifecycle in a fresh task-owned git worktree: implement via the deep-work skill with evidence-bound manual QA → reviewer-readable PR → CI/review-bot verification loop → merge by default → worktree cleanup. Use whenever implementation work needs to land as one or more atomic PRs."
metadata:
  short-description: Atomic PR lifecycle with verification loop
---

# Work With PR — Full PR Lifecycle

You are executing a complete PR lifecycle: from fresh task-owned worktree setup, through `deep-work`-driven implementation with evidence-bound manual QA, PR creation, and an unbounded verification loop until the PR is merged. The loop has two gates — CI and the repository's AI review bot — and a failing gate sends you back into that PR's worktree to fix and re-QA. You keep cycling until every active gate passes at once.

**The unit of delivery is the smallest PR that compiles, passes, and stands on its own — not "one task, one PR."** A single task routinely splits into several atomic PRs; the lifecycle below describes ONE of them, so apply it to each, and build the independent ones concurrently (Phase 0).

<architecture>

```
Phase 0: Setup         → Split into atomic PRs, then branch + worktree per PR (parallel when independent)
Phase 1: Implement     → Drive the work through the deep-work skill:
                         evidence-bound manual QA per success criterion, atomic commits
Phase 2: PR Creation   → Push, create a reviewer-readable English PR targeting the base branch
Phase 3: Verify Loop   → Unbounded iteration; a failing gate routes back to Phase 1:
  ├─ Gate A: CI         → gh pr checks (or the repo's CI view)
  └─ Gate B: Review bot → e.g. cubic-dev-ai[bot] "No issues found"
                          (N/A when the repo configures none; SKIPPED only on exhausted quota)
Phase 4: Merge         → Auto-merge by default; wait until actually merged, then worktree cleanup
```

</architecture>

---

## Phase 0: Setup

Create a fresh isolated worktree lane for each PR before implementation starts. The user's main working directory is read-only context — it may have uncommitted work, and a branch checkout would destroy it. Isolation also makes parallelism cheap: one lane per PR, so several build at once without colliding.

Lanes are host-owned (see the "Worktree lanes" prompt section): `worktree_open` creates the branch and worktree, `delegate(worktree=<lane>)` binds the implementer to it, the host checks the lane when the implementer settles, and every result names the next step. Do not hand-run `git worktree add` when the lane tools are available.

<setup>

### 1. Decide the PR split

Before creating anything, decompose the task into the smallest atomic PRs that each compile, pass, and deliver one reviewable slice. Prefer more small PRs over one large one — a 200-line PR gets a real review; a 2000-line PR gets a rubber stamp. Sequence by dependency: independent slices branch off the base and run in parallel; dependent slices stack, each branched off the previous.

Building more than one independent PR concurrently is the recommended default, not an exotic option: open one lane per PR and dispatch one background `delegate` child per lane (category `quick` or `general-high` by slice size, `worktree=<lane>`). Write scopes stay disjoint by construction — one lane per PR; pass `scope` to `worktree_open` when two lanes must provably not touch the same paths. Lane workers implement and commit; pushing, PR creation, and merging stay with you (the lane guard refuses `git push` inside a lane).

When the work is large enough to need the `deep-work` skill's up-front plan, this decomposition is not optional polish: the plan MUST encode the atomic PRs, their dependency order, and which run in parallel as first-class structure.

### 2. Resolve repository context

```bash
# Verify gh first — it drives PR creation, checks, and merge below.
command -v gh >/dev/null || echo "GH_ABSENT"

REPO=$(gh repo view --json nameWithOwner -q .nameWithOwner)
REPO_NAME=$(basename "$PWD")
# The PR target branch: follow the repo's convention (dev, main, ...).
# Check its contributing rules; some repos block PRs to the default branch.
BASE_BRANCH="dev"
```

**When `gh` is absent (graceful degradation):** proceed with Phases 0–1 exactly as written (worktree, implementation, manual QA, atomic commits), then `git push -u origin "$BRANCH_NAME"`. From there hand the hosted side over: print the PR-create URL (`https://github.com/<owner>/<repo>/compare/<base>...<branch>?expand=1`) with the ready PR title and body, and ask the user to open the PR (or confirm one exists). Resume the verification loop once the user reports CI results; iterate on fixes inside the worktree exactly as Phase 3 describes, and leave merge to the user unless they ask you to drive it via plain git (merge locally, push to the base branch — only with their explicit go-ahead).

### 3. Create branch

If user provides a branch name, use it. Otherwise, derive from the task:

```bash
# Auto-generate: feature/short-description or fix/short-description
BRANCH_NAME="feature/$(echo "$TASK_SUMMARY" | tr '[:upper:] ' '[:lower:]-' | head -c 50)"
git fetch origin "$BASE_BRANCH"
git branch "$BRANCH_NAME" "origin/$BASE_BRANCH"
```

### 4. Open the lane

```
worktree_open({ title: "<short PR summary>", scope: ["<paths this PR may write>"] })
```

The host derives the lane id, creates branch `weir/<lane-id>` from the current base, places the worktree at `.weir/worktrees/<lane-id>` (ignored locally through `.git/info/exclude`, so nothing tracked changes), and installs dependencies from the lockfile in the background. The result's `next` tells you when the lane is ready. Use `weir/<lane-id>` as `$BRANCH_NAME` from here on (step 3's branch name is only needed when the lane tools are unavailable — then fall back to a manual `git worktree add` inside the repository, never beside it, because the sandbox only allows writes inside the workspace).

### 5. Set working context

All implementation happens inside the lane: delegate with `worktree=<lane-id>`. The bound worker's shell calls must pass the lane as `workdir` and its writes must stay inside the lane — the host enforces both.

</setup>

---

## Phase 1: Implement

Drive all implementation through the `deep-work` skill from inside the worktree. Do not free-hand the work: `deep-work` decomposes the brief into success criteria and — the reason it is mandatory here — forces every criterion to be proven by its RUN step: the real-surface scenario, executed by you, with the artifact pasted into the notepad.

**Manual QA is the gate, not the tests.** The rule is absolute: a change is not done until you have driven the real surface (the HTTP call with `curl -i`, the CLI run, the rendered output) AND written the evidence to disk. No evidence file means the QA did not happen, and you may NOT commit or push. "It typechecks" and "the suite is green" are NOT QA.

<implementation>

### Scope discipline

Within each PR, stay minimal: deliver its one slice, add the test, prove it, stop. Do not refactor surrounding code, add config options, or "improve" things that aren't broken — that work belongs in its own PR, and scope creep makes failures harder to isolate.

### Commit strategy

Follow the `git-master` skill's atomic-commit discipline when it is loaded; otherwise apply the same rule directly. Keep commits atomic so that if CI fails on one change you can isolate and fix it without unwinding everything:

```
3+ files changed  → 2+ commits minimum
5+ files changed  → 3+ commits minimum
10+ files changed → 5+ commits minimum
```

Each commit pairs implementation with its tests, and you commit a criterion only after its QA evidence is on disk.

### Pre-push local validation

Before pushing, run the same checks CI will run — read the repo's CI configuration (`.github/workflows/`, or its package scripts) and mirror it locally. This is a cheap pre-filter that saves a CI round-trip, NOT a substitute for the manual QA above:

```bash
# Example shape — use the repo's own commands:
<package manager> run typecheck
<package manager> test
<package manager> run build
```

Fix any failure before pushing; each fix is its own atomic commit.

</implementation>

---

## Phase 2: PR Creation

<pr_creation>

### Push and create PR

```bash
git push -u origin "$BRANCH_NAME"
```

Write the PR body in English for a human reviewer who has not followed the implementation thread. It must explain the work in plain terms, group changes by reviewer-relevant area instead of dumping files, and make QA evidence auditable without forcing the reviewer to guess what each log proves. Cite sanitized artifacts; do not paste raw secret-bearing logs, env dumps, tokens, auth headers, or private credentials into the PR.

If the PR body needs screenshots or terminal PNGs: upload them via GitHub user attachments from an authenticated web session and include only the final `https://github.com/user-attachments/assets/<uuid>` URLs. Never commit temporary images, use release assets, use external hosts, or expose cookies/tokens anywhere in the process.

```bash
gh pr create \
  --base "$BASE_BRANCH" \
  --head "$BRANCH_NAME" \
  --title "$PR_TITLE" \
  --body "$(cat <<'EOF'
## Summary
[2-4 sentences in plain language: what changed, why it changed, and how observable behavior is different after this PR.]

## Changes
[Group bullets by reviewer-relevant area, not by file. Each bullet should say what changed and how a reviewer can map it to the diff.]

## QA & Evidence
For each automated command or manual QA action:
- **What was tested:** [command or surface driven, with the behavior it was meant to prove]
- **Observed result:** [actual result, including before/after when relevant]
- **Artifact:** [`path/to/sanitized-log-or-report`]
- **Why sufficient:** [which risk or success criterion this evidence covers]

## Risks & Residuals
[Map each meaningful risk to the evidence above and state the conclusion: mitigated, accepted, or blocked. Include unavailable gates here with the concrete reason.]

## Related Issues
[Link to issue if applicable]
EOF
)"
```

Capture the PR number:

```bash
PR_NUMBER=$(gh pr view --json number -q .number)
```

</pr_creation>

---

## Phase 3: Verification Loop

This is the core of the skill. Every active gate must pass for the PR to be ready. The loop has no iteration cap — keep going until done. Gate ordering is intentional: CI is cheapest/fastest; the review bot is external and asynchronous. Gate B has exactly two non-pass states: SKIPPED (only when the bot's quota is exhausted) or N/A (when the repo configures no review bot at all — record it, never silently drop the gate). It is never skipped because it found issues. A failing gate is not a patch-and-push: route back to Phase 1, where fixes get the same scope discipline and, if behavior changed, fresh manual-QA evidence before you re-enter the loop.

<verify_loop>

```
while true:
  1. Wait for CI              → Gate A
  2. If CI fails              → back to Phase 1: read logs, fix + re-QA, commit, push, continue
  3. Check the review bot     → Gate B (skip when the repo has none → record N/A)
  4. If the bot has issues    → back to Phase 1: fix + re-QA, commit, push, continue
  5. If the bot's quota is out → record Gate B SKIPPED, stop waiting on it
  6. All active gates pass    → break
```

### Gate A: CI Checks

CI is the fastest feedback loop. Watch it as a background job and end your turn — never burn model round-trips polling `gh pr checks` in a loop:

```bash
# Register the watch as a background job, then END THE TURN —
# the settlement notice wakes you when checks conclude.
gh pr checks "$PR_NUMBER" --watch --fail-fast        # run with run_in_background: true
# → end turn; pull the outcome with job_output when the notice arrives.
# For a single midpoint status peek (at most once), use:
#   gh pr checks "$PR_NUMBER"  # one-shot, no --watch
```

**On failure**: Get the failed run logs to understand what broke:

```bash
# Find the failed run
RUN_ID=$(gh run list --branch "$BRANCH_NAME" --status failure --json databaseId --jq '.[0].databaseId')

# Get failed job logs
gh run view "$RUN_ID" --log-failed
```

Read the logs, then fix per the iteration discipline below.

### Gate B: Review Bot Approval

Automated review bots (for example `cubic-dev-ai[bot]`) comment on PRs without using GitHub's APPROVED review state — they post comments with issue counts and confidence scores. If the repo configures no such bot, Gate B is N/A: record it and move on.

**Approval signal** (Cubic example): the latest bot comment contains `**No issues found**` and confidence `**5/5**`.

**Issue signal**: the comment lists issues with file-level detail.

**Quota-exhausted signal**: the bot posts a usage/quota/limit message instead of a review, or no review arrives within the bounded wait below. This is the ONLY case where you skip Gate B and proceed — record it as SKIPPED in the final report, never silently. Issues are never a reason to skip.

```bash
# Get the latest bot review (adapt the login for the repo's bot)
BOT_REVIEW=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}/reviews" \
  --jq '[.[] | select(.user.login == "cubic-dev-ai[bot]")] | last | .body')

if echo "$BOT_REVIEW" | grep -q "No issues found"; then
  echo "Review bot: APPROVED"
elif echo "$BOT_REVIEW" | grep -qiE "quota|usage limit|rate limit|out of (credits|reviews)|upgrade your plan"; then
  echo "Review bot: SKIPPED (quota exhausted)"   # Gate B satisfied-by-skip; do not loop on it
else
  echo "Review bot: ISSUES FOUND"
  echo "$BOT_REVIEW"
fi
```

**On issues**: the review body contains structured issue descriptions. Parse them, determine which are valid (some may be false positives), and fix the valid ones per the iteration discipline below.

Reviews are triggered automatically on PR updates. After pushing a fix, wait for the new review as a background job — never spin a `for _ in $(seq 1 30)` polling loop that burns model round-trips:

```bash
# Wait for a NEW review after push, as a background job. END THE TURN after
# starting it; the settlement notice wakes you. A job that outlives its
# reasonable window (≈10 min) means no review is coming → Gate B SKIPPED.
PUSH_TIME=$(date -u +%Y-%m-%dT%H:%M:%SZ)
LATEST=$(gh api "repos/${REPO}/pulls/${PR_NUMBER}/reviews" --jq '[.[] | select(.user.login == "cubic-dev-ai[bot]")] | last | .submitted_at // empty')
[ -n "$LATEST" ] && [ "$LATEST" > "$PUSH_TIME" ] && echo NEW_REVIEW || echo STILL_WAITING
# → re-check at most a few times via job_output; do not tight-loop.
```

### Iteration discipline

Each iteration through the loop:
1. Fix ONLY the issues identified by the failing gate
2. If the fix changes runtime behavior, capture fresh manual-QA evidence (Phase 1)
3. Commit atomically (one logical fix per commit)
4. Push
5. Re-enter from Gate A (code changed → full re-verification)

Avoid the temptation to "improve" unrelated code during fix iterations. Scope creep in the fix loop makes debugging harder and can introduce new failures.

</verify_loop>

---

## Phase 4: Merge & Cleanup

Once all active gates pass (the review bot may be SKIPPED on quota or N/A when unconfigured):

<merge_cleanup>

### Merge the PR (auto-merge by default)

Enabling auto-merge is the default — do it unless the user explicitly told you not to merge. Auto-merge hands the merge to GitHub, which lands the PR the moment every required gate is green, so you never sit and babysit checks. It does NOT bypass the gates: if a gate fails, GitHub will not merge, which routes you back to Phase 1 to fix and re-QA like any other failing gate.

```bash
# Use the repository's merge convention (check its contributing rules) —
# merge commit, squash, or rebase is the repo's choice, not yours.
# --auto arms auto-merge: GitHub merges as soon as all required checks pass.
gh pr merge "$PR_NUMBER" --merge --auto --delete-branch
# If the repo has not enabled the auto-merge feature, --auto errors; once the gates
# are green, fall back to a direct merge: gh pr merge "$PR_NUMBER" --merge --delete-branch
```

Then wait for the merge as a background job — never block a model round-trip on an `until [ ... MERGED ]` polling loop:

```bash
# Watch merge completion as a background job, then END THE TURN;
# the settlement notice wakes you for the cleanup step.
[ "$(gh pr view "$PR_NUMBER" --json state -q .state)" = "MERGED" ] && echo MERGED || echo WAITING
# → end turn; if the job outlives a reasonable window (≈30 min for auto-merge),
#   check merge state once: gh pr view "$PR_NUMBER" --json state -q .state
```

If the user opted out of merging, skip the merge but STILL close the lane below: the user's cleanup choice decides what is removed.

### Clean up the lane

Cleanup is the user's decision, made on a card the host raises. The host copies the lane's `.weir/` scratch (notepads, research notes, QA evidence) into the main repository's `.weir/lanes/<lane-id>/` before it removes anything, and it never forces a removal.

- **Merged locally** (no hosted PR): `worktree_land({ lane })` raises the merge approval card and, after the merge, the cleanup card (keep / remove worktree / remove worktree and branch).
- **Merged through the hosted PR**: the lane itself was never merged locally, so close it with `worktree_abandon({ lane })` — the card lets the user remove the worktree (the branch is already merged upstream; `git fetch` first so the unmerged-commit count is accurate).

### Report completion

Summarize what happened:

```
## PR Complete

- **PR**: #{PR_NUMBER} — {PR_TITLE}
- **Branch**: {BRANCH_NAME} → {BASE_BRANCH}
- **Iterations**: {N} verification loops
- **Gates**: CI pass | Review bot {pass | SKIPPED (quota exhausted) | N/A (not configured)}
- **Merged**: {yes | no — left for you to merge, as requested}
- **Worktree**: cleaned up
```

</merge_cleanup>

---

## Failure Recovery

<failure_recovery>

If you hit an unrecoverable error (e.g., merge conflict with the base branch, infrastructure failure):

1. **Do NOT delete the worktree** — the user may want to inspect or continue manually
2. Report what happened, what was attempted, and where things stand
3. Include the worktree path so the user can resume

For merge conflicts:

```bash
cd "$WORKTREE_PATH"
git fetch origin "$BASE_BRANCH"
git rebase "origin/$BASE_BRANCH"
# Resolve conflicts, then continue the loop
```

</failure_recovery>

---

## Anti-Patterns

| Violation | Why it fails | Severity |
|-----------|-------------|----------|
| Working in main worktree instead of isolated worktree | Pollutes user's working directory, may destroy uncommitted work | CRITICAL |
| Committing or pushing without manual-QA evidence on disk | "Tests pass" never proves the feature works on its real surface | CRITICAL |
| Pushing directly to the base branch | Bypasses review entirely | CRITICAL |
| Skipping CI gate after code changes | The review bot may pass on stale code | CRITICAL |
| Skipping the review bot because it found issues | Only an exhausted quota justifies a skip; real issues must be fixed and re-pushed | HIGH |
| Fixing unrelated code during verification loop | Scope creep causes new failures | HIGH |
| Deleting worktree on failure | User loses ability to inspect/resume | HIGH |
| Ignoring review-bot false positives without justification | Bot issues should be evaluated, not blindly dismissed | MEDIUM |
| Bundling independent slices into one big PR | Atomic review dies — a 2000-line PR gets rubber-stamped, regressions hide, and one bad slice blocks all the others | HIGH |
| Giant single commits | Harder to isolate failures, violates atomic-commit discipline | MEDIUM |
| Not running local checks before push | Wastes CI time on obvious failures | MEDIUM |
