// Verdict vocabulary for the integration runner (design D1 of
// test-harness-env-capability-skip): PASS/FAIL/SKIP collection plus the
// summary/exit semantics. SKIP reports an absent OPTIONAL environment
// capability with evidence — it is printed and counted in the summary but
// never fails the suite; only FAIL decides a non-zero exit code. Extracted
// from run.mjs so the semantics are unit-testable without booting the driver
// (same pattern as src/run-lock.js: logic here, wiring source-pinned there).

/**
 * Create the runner's verdict collector.
 * @param {{ log?: (line: string) => void }} deps - output sink (console.log in run.mjs)
 * @returns {{ results: object[], check: Function, skip: Function, summarize: Function }}
 */
export function makeVerdicts({ log = console.log } = {}) {
  const results = []
  const check = (scenario, label, ok, detail = '') => {
    results.push({ scenario, label, ok, detail })
    log(`${ok ? 'PASS' : 'FAIL'} [${scenario}] ${label}${ok ? '' : ` — ${detail}`}`)
  }
  const skip = (scenario, label, detail = '') => {
    results.push({ scenario, label, skip: true, detail })
    log(`SKIP [${scenario}] ${label} — ${detail}`)
  }
  const summarize = () => {
    const failed = results.filter((result) => !result.ok && !result.skip)
    const skipped = results.filter((result) => result.skip === true).length
    const passed = results.length - failed.length - skipped
    log(`\n${passed}/${results.length - skipped} integration checks passed${skipped > 0 ? ` (skipped ${skipped})` : ''}`)
    return { total: results.length, passed, failed: failed.length, skipped, exitCode: failed.length > 0 ? 1 : 0 }
  }
  return { results, check, skip, summarize }
}
