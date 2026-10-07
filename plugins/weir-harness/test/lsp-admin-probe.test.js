import { describe, expect, it } from './helpers.js'
import { PassThrough } from 'node:stream'
import { probeVersion } from '../src/lsp/admin.js'

/**
 * `probeVersion` arms a timeout so a silent server cannot block the status
 * surface. Every settle path has to release it: a launch failure rejects out of
 * the race (spawn EINVAL is routine on Windows for shim-installed servers), and
 * an 8s timer left armed there pins the host process — and every `node --test`
 * run that probed such a server — long after the caller gave up.
 */
const timeouts = () => process.getActiveResourcesInfo().filter((kind) => kind === 'Timeout').length

function stubbedProbe({ done, terminate = () => {} }) {
  return {
    spawn: () => ({
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      done,
      terminate,
    }),
  }
}

describe('lsp admin probe hygiene', () => {
  it('releases its timeout when the probe window expires with no output', async () => {
    const before = timeouts()
    const started = Date.now()
    const subprocess = stubbedProbe({ done: new Promise(() => {}) })
    expect(await probeVersion(subprocess, '/resolved/silent', ['--version'], 60)).toBe(null)
    const elapsed = Date.now() - started
    // it waited out the window (a probe that gave up immediately would be wrong)
    expect(elapsed >= 50).toBe(true)
    expect(elapsed < 2_000).toBe(true)
    expect(timeouts()).toBe(before)
  })

  it('releases its timeout when the spawn itself fails', async () => {
    const before = timeouts()
    const failure = Object.assign(new Error('spawn EINVAL'), { code: 'EINVAL' })
    const subprocess = stubbedProbe({ done: Promise.reject(failure) })
    await expect(async () => probeVersion(subprocess, '/resolved/npm.cmd', ['--version'], 8_000)).rejects.toThrow(/EINVAL/)
    // the rejection escapes the race: without a finally, the 8s window stays
    // armed and the process outlives every caller
    expect(timeouts()).toBe(before)
  })

  it('terminates the child it gave up on', async () => {
    let terminated = 0
    const subprocess = stubbedProbe({ done: new Promise(() => {}), terminate: () => { terminated++ } })
    expect(await probeVersion(subprocess, '/resolved/silent', ['--version'], 40)).toBe(null)
    expect(terminated).toBe(1)
  })
})
