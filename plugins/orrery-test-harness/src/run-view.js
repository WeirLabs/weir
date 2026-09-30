// Run-view builder (design D5): pre-parses the scenario trace(s) via
// src/jsonl.js and exposes the common filtered views the scenario asserts
// consume. An assert is a pure function of a recorded run — the same view
// built from files under test/fixtures/traces/ replays it in-process (task
// 4.2) with no headless boot.
import { readJsonl } from './jsonl.js'

/**
 * @param {object} run - raw run record ({ scenario, trace, trace2?, code, stdout, stderr, sessionId? })
 * @param {{ ws: string, check: (label: string, ok: boolean, detail?: string) => void }} deps
 *   ws: the scenario workspace path (fixture files, .orrery/audit.jsonl);
 *   check: the scenario-bound assertion collector.
 * @returns {object} the structured view every scenario's assert(view) consumes
 */
export function makeRunView(run, { ws, check }) {
  const records = readJsonl(run.trace)
  const records2 = run.trace2 ? readJsonl(run.trace2) : []
  return {
    scenario: run.scenario,
    code: run.code,
    stdout: run.stdout ?? '',
    stderr: run.stderr ?? '',
    sessionId: run.sessionId ?? null,
    records,
    requests: records.filter((r) => Array.isArray(r.emitted)),
    events: records.filter((r) => r.kind === 'session-event'),
    created: records.filter((r) => r.kind === 'agent-created'),
    inboxInserted: records.filter((r) => r.kind === 'inbox-inserted'),
    records2,
    requests2: records2.filter((r) => Array.isArray(r.emitted)),
    ws,
    check,
  }
}
