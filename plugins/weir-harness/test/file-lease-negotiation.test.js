import { describe, expect, it } from './helpers.js'
import { createTransferNegotiation } from '../src/file-lease/negotiation.js'

// Pure reply-window state: no socket, broker, registration or notification.
// Mounted-plugin tests cover the adapter; these cases pin the outcome matrix
// itself and prove that request ids and agents do not share local settlement.

describe('Transfer Negotiation', () => {
  it('keeps a transport-failed request and closes multiple request ids independently', () => {
    const negotiation = createTransferNegotiation()
    const agent = {}
    negotiation.openRequest(agent, 'r-1', { path: '/p/a', from: {} })
    negotiation.openRequest(agent, 'r-2', { path: '/p/b', from: {} })

    expect(negotiation.finishReply(agent, 'r-1', { degraded: true, code: 'transport' })).toBe(2)
    expect(negotiation.finishReply(agent, 'r-2', { state: 'transferred' })).toBe(1)
    expect(negotiation.finishReply(agent, 'r-1', { state: 'declined' })).toBe(0)
    expect(negotiation.finishReply(agent, 'r-1', { code: 'transport' })).toBeUndefined()
  })

  it('closes expired, stale and not-holder requests without closing a sibling id', () => {
    for (const code of ['expired', 'stale', 'not-holder']) {
      const negotiation = createTransferNegotiation()
      const agent = {}
      negotiation.openRequest(agent, 'r-domain', { path: '/p/a', from: {} })
      negotiation.openRequest(agent, 'r-other', { path: '/p/b', from: {} })

      expect(negotiation.finishReply(agent, 'r-domain', Object.assign(new Error(code), { code }))).toBe(1)
      expect(negotiation.finishReply(agent, 'r-other', { state: 'declined' })).toBe(0)
    }
  })

  it('scopes not-holder cleanup to the unauthorized agent only', () => {
    const negotiation = createTransferNegotiation()
    const unauthorized = {}
    const holder = {}
    negotiation.openRequest(unauthorized, 'r-1', { path: '/p/a', from: {} })
    negotiation.openRequest(holder, 'r-1', { path: '/p/a', from: {} })

    expect(negotiation.finishReply(unauthorized, 'r-1', { code: 'not-holder' })).toBe(0)
    // The other agent's local window is untouched; its own transport result is
    // still retryable and its later broker settlement closes normally.
    expect(negotiation.finishReply(holder, 'r-1', { code: 'transport' })).toBe(1)
    expect(negotiation.finishReply(holder, 'r-1', { state: 'transferred' })).toBe(0)
  })

  it('preserves legacy unknown-outcome cleanup and independent lifetime exits', () => {
    const negotiation = createTransferNegotiation()
    const agent = {}
    negotiation.openRequest(agent, 'r-1', { path: '/p/a', from: {} })
    negotiation.openRequest(agent, 'r-2', { path: '/p/b', from: {} })

    expect(negotiation.finishReply(agent, 'r-1', new Error('unknown failure'))).toBe(1)
    negotiation.closeAgent(agent)
    expect(negotiation.finishReply(agent, 'r-2', { code: 'transport' })).toBeUndefined()
  })
})
