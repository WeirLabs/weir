// Direct unit suite for the interleave-tolerant wait primitive (design D1,
// task 1.1): advance on marker, wait with a stamped retry marker, exhausted
// only after the budget is spent, and the retry count rebuilt from history
// alone (the mock's decide is a pure function — no process-local state).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { WAIT_MARKER_PREFIX, waitForMarker } from '../src/mock-kit.js'
import { shellToolName } from '../src/shell.js'

const SHELL = shellToolName()

/** The single block-end payload of a wait verdict's chunks. */
function waitCall(verdict) {
  const blocks = [...verdict.chunks].filter((chunk) => chunk.type === 'block-end').map((chunk) => chunk.block)
  assert.equal(blocks.length, 1)
  return blocks[0]
}

describe('waitForMarker verdicts', () => {
  it('advances the moment the marker is present in history', () => {
    const verdict = waitForMarker('user:\ndelegate result\n---\nuser:\nchild settled MARKER_DONE', 'MARKER_DONE')
    assert.deepEqual(verdict, { state: 'advance' })
  })

  it('advances only when EVERY marker of a list is present', () => {
    assert.equal(waitForMarker('alpha done', ['alpha done', 'beta done']).state, 'wait')
    assert.equal(waitForMarker('alpha done\nbeta done', ['alpha done', 'beta done']).state, 'advance')
  })

  it('waits with a stamped echo-and-wait shell call while the marker is absent', () => {
    const verdict = waitForMarker('user:\ndelegate result', 'MARKER_DONE')
    assert.equal(verdict.state, 'wait')
    assert.equal(verdict.waits, 1)
    const call = waitCall(verdict)
    assert.equal(call.type, 'tool-call')
    assert.equal(call.name, SHELL)
    const args = JSON.parse(call.arguments)
    assert.ok(args.command.includes(`${WAIT_MARKER_PREFIX}1`), `command stamps the first wait marker: ${args.command}`)
    assert.ok(args.command.includes('sleep') || args.command.includes('Start-Sleep'), `command actually waits: ${args.command}`)
  })

  it('is interleave-immune: a trailing user-role snapshot cannot misalign it', () => {
    // The runtime-context snapshot arrives as a user message AFTER the tool
    // result that carried the marker — a lastRole gate would miss, history
    // must not.
    const history = 'tool:\ndelegate returned MARKER_DONE\n---\nuser:\n<system-reminder>runtime context snapshot</system-reminder>'
    assert.equal(waitForMarker(history, 'MARKER_DONE').state, 'advance')
  })
})

describe('waitForMarker retry budget', () => {
  it('rebuilds the retry count from the wait markers in history', () => {
    const history = `tool:\n${WAIT_MARKER_PREFIX}1\n---\ntool:\n${WAIT_MARKER_PREFIX}2`
    const verdict = waitForMarker(history, 'MARKER_DONE')
    assert.equal(verdict.state, 'wait')
    assert.equal(verdict.waits, 3)
    const call = waitCall(verdict)
    assert.ok(JSON.parse(call.arguments).command.includes(`${WAIT_MARKER_PREFIX}3`), 'next marker continues the sequence')
  })

  it('survives non-consecutive marker numbering (counts the maximum)', () => {
    const history = `tool:\n${WAIT_MARKER_PREFIX}5`
    const verdict = waitForMarker(history, 'MARKER_DONE')
    assert.equal(verdict.waits, 6)
  })

  it('is exhausted only once the budget is fully spent', () => {
    const history = `tool:\n${WAIT_MARKER_PREFIX}8`
    const verdict = waitForMarker(history, 'MARKER_DONE')
    assert.deepEqual(verdict, { state: 'exhausted', waits: 8 })
  })

  it('honors an explicit budget', () => {
    assert.equal(waitForMarker(`tool:\n${WAIT_MARKER_PREFIX}2`, 'MARKER_DONE', 2).state, 'exhausted')
    assert.equal(waitForMarker(`tool:\n${WAIT_MARKER_PREFIX}1`, 'MARKER_DONE', 2).state, 'wait')
  })

  it('never exhausts early and never waits past the budget', () => {
    let history = 'user:\nprobe'
    for (let n = 1; n <= 8; n++) {
      const verdict = waitForMarker(history, 'NEVER_COMES')
      assert.equal(verdict.state, 'wait', `attempt ${n} must keep waiting`)
      history += `\n---\ntool:\n${WAIT_MARKER_PREFIX}${n}`
    }
    assert.equal(waitForMarker(history, 'NEVER_COMES').state, 'exhausted')
  })

  it('advance wins over an already-spent budget (marker present is terminal)', () => {
    const history = `tool:\n${WAIT_MARKER_PREFIX}8\n---\nuser:\nMARKER_DONE`
    assert.equal(waitForMarker(history, 'MARKER_DONE').state, 'advance')
  })
})
