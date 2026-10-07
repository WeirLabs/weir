import { hostname } from 'node:os'

// A shared deterministic identity lets independently opened in-process stores
// recognize each other's locks. No process probing belongs in this helper.
export function createStubLiveness({
  pid = process.pid,
  host = hostname(),
  identity = async () => ({ osStart: 'test-start', bootNonce: 'test-process' }),
  state = async owner => {
    if (owner.host !== host) return 'unknown'
    if (owner.pid !== pid) return 'unknown'
    return owner.startIdentity?.bootNonce === (await identity()).bootNonce ? 'alive' : 'dead'
  },
} = {}) {
  return { pid, host, identity, state }
}
