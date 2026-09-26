---
name: research
description: "Deep research over code, docs, and the web: parallel explore/librarian fan-out, then a cited synthesis. Use when the research itself is the deliverable or a claim needs an execution-backed verdict."
metadata:
  short-description: Deep research workflow with cited synthesis
---

# Deep Research

The deliverable is a synthesis where every claim carries a citation or a proof
artifact. Ordinary context-gathering for an implementation task does NOT use
this workflow — read the code directly instead.

## Protocol

1. **Scope the question.** Write the research question, the sub-questions, and
   what a satisfactory answer looks like into a research note
   (`.orrery/research-<timestamp>.md`). Name which sources can answer each
   sub-question: this codebase, official docs, OSS usage, or the web at large.

2. **Fan out in parallel.** One background `delegate` child per lane:
   - `agent="explore"` for this codebase (several in parallel for disjoint
     areas — name the area in each prompt),
   - `agent="librarian"` for official docs / library APIs / OSS examples,
   - `agent="oracle"` when the question is architectural.
   Every prompt is self-contained: TASK / DELIVERABLE (the cited answer, with
   file:line or URLs) / SCOPE / VERIFY / STOP WHEN.

3. **Keep working while they run.** Do not idle-wait: read the obvious files
   yourself, or end the turn — settlement notices wake you.

4. **Verify contested claims by running them.** A claim about behavior is a
   claim you can execute: run the snippet, hit the endpoint, reproduce the
   case. Mark each claim VERIFIED (artifact), CITED (source), or DISPUTED.

5. **Synthesize.** Pull every report with `job_output`, then write the
   synthesis into the research note:
   - The direct answer first.
   - Claims with their citations or proof artifacts.
   - Contradictions between sources, named as contradictions.
   - What remains unknown, and what would settle it.

## Stop rules

- Stop expanding when two consecutive waves add no new facts.
- Stop when every sub-question is VERIFIED or CITED, or explicitly marked
  unknown with its settling path.
- Never present a library's behavior from memory when a doc page or a 5-line
  reproduction would answer it.
