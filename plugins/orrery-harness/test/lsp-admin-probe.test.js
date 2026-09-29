import { describe, expect, it } from './helpers.js'
import { PassThrough } from 'node:stream'
import { apply, probeVersion } from '../src/lsp/admin.js'

/**
 * `probeVersion` arms a timeout so a silent server cannot block the status
 * surface. When the probe DOES time out, the timer has to be released too:
 * an 8s timer left armed keeps the host process (and every `node --test` run
 * that probed a slow server) alive long after the assertion finished.
 */
function silentSubprocess() {
  const spawns = []
  return {
    spawns,
    resolveExecutable: async (command) => `/resolved/${command}`,
    spawn(spec) {
      const handle = {
        stdin: new PassThrough(),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        done: new Promise(() => {}),
        terminate() {},
        spec,
      }
      spawns.push(handle)
      return handle
    },
  }
}

describe('lsp admin probe hygiene', () => {
  it('releases its timeout when a silent server never answers', async () => {
    const subprocess = silentSubprocess()
    const started = Date.now()
    const activeBefore = process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length
    expect(await probeVersion(subprocess, '/resolved/silent', ['--version'], 60)).toBe(null)
    const elapsed = Date.now() - started
    const activeAfter = process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length
    // it honoured the probe window...
    expect(elapsed < 2_000).toBe(true)
    // ...and left no armed timer behind
    expect(activeAfter).toBe(activeBefore)
  })
})
