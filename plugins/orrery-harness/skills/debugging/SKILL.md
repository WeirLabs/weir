---
name: debugging
description: "Hypothesis-driven debugging: reproduce first, form ranked hypotheses, test the cheapest discriminator, fix the cause — never the symptom."
metadata:
  short-description: Hypothesis-driven debugging loop
---

# Debugging

Bugs are not fixed by staring harder. They are fixed by discriminating between
hypotheses with evidence.

## The loop

1. **Reproduce first.** Run the failing case and capture the failure (the
   exact command, the exact error, the exact input). No reproduction, no
   debugging — write the reproduction before anything else.

2. **State what you actually know.** Read the code on the path of the failure:
   the exact line that throws, the inputs it received, the callers that
   produced them. `grep` the error text; read the surrounding tests. List
   observations, not guesses.

3. **Rank hypotheses.** Write 2-4 candidate causes, each with the observation
   it would explain and the cheapest experiment that would discriminate it
   from the others. Cheapest first: a log line, a focused test, a REPL probe.

4. **Run the discriminator.** One experiment at a time. Record the outcome
   before interpreting it. An experiment that "should" confirm and does not is
   the most valuable result — update the ranking honestly.

5. **Fix the cause, not the symptom.** Trace at least two levels above the
   failure before settling: prefer the change that makes the failure class
   impossible over the guard that hides this instance. Keep the diff as small
   as the cause allows.

6. **Prove the fix.** The reproduction now passes; the existing tests stay
   green. If the repository keeps regression tests for this area, add the
   minimal one that fails on the old code and passes on the new.

## Rules

- Never present a hypothesis as a diagnosis. The words "this fixes it" require
  a captured passing reproduction.
- Never change two things at once while discriminating — you will not know
  which change mattered.
- After 2 identical failed attempts, stop and surface the evidence to the
  user instead of retrying.
- If the bug involves a library you have not verified, check the library's
  actual behavior (run it, or `delegate(agent="librarian")`) before blaming
  your own code — or theirs.
