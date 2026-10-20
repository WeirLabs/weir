// TEMPORARY DIAGNOSTIC PROBE — written to locate ONE defect, DELETE once found.
//
// The defect under investigation: a turn-end lease release never reaches the
// arbitration daemon in a real run, while the same path is known-good in the
// integration test. These probes append one line per step to
// `/tmp/weir-editlock-diag.log` so the three candidate causes can be told apart
// from outside the process:
//
//   1. the `session/event` `turn/end` branch is never reached at all,
//   2. it is reached but the agent registry cannot resolve the session,
//   3. both are fine and the client ledger holds no releasable record.
//
// Every probe is strictly additive: `diag()` returns nothing, never throws (the
// try/catch below is the contract) and never changes control flow, timing or a
// return value. Remove this module together with its call sites.
//
// TEMPORARY — not part of the feature, must not ship.

import { appendFileSync } from 'node:fs'

/**
 * Append one diagnostic line to the fixed probe log.
 * @param {string} line
 * @returns {void}
 */
export function diag(line) {
  try {
    appendFileSync('/tmp/weir-editlock-diag.log', `${new Date().toISOString()} ${line}\n`)
  } catch {
    // A probe must never break the code it observes.
  }
}
