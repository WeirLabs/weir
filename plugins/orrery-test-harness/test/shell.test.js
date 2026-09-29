// Contract tests for the test harness's platform shell abstraction.
//
// These pin the vocabulary the integration mock emits: the platform tool name
// and the exact command line each named operation produces. The expected
// command strings are independent literals (not recomputed from the module),
// so the assertions can actually disagree with the implementation.
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SHELL_OPERATIONS, shellCommand, shellToolName } from '../src/shell.js'

describe('shellToolName', () => {
  it('names pwsh on win32 (the read-only shell the delegate allowlist picks)', () => {
    assert.equal(shellToolName('win32'), 'pwsh')
  })

  it('names bash everywhere else', () => {
    assert.equal(shellToolName('darwin'), 'bash')
    assert.equal(shellToolName('linux'), 'bash')
  })
})

describe('SHELL_OPERATIONS vocabulary', () => {
  it('exposes exactly the operations the integration scenarios need', () => {
    assert.deepEqual([...SHELL_OPERATIONS].sort(), [
      'echo-and-wait',
      'echo-only',
      'remove-file',
      'stay-busy',
      'wait',
    ])
  })
})

describe('shellCommand posix', () => {
  it('echoes a marker so the guard admits it', () => {
    assert.equal(shellCommand('echo-only', 'darwin', { text: 'ROBASH_LS_RAN' }), 'echo ROBASH_LS_RAN')
  })

  it('echoes a marker then sleeps', () => {
    assert.equal(
      shellCommand('echo-and-wait', 'linux', { text: 'REHYDRATE_WAITED', seconds: 2 }),
      'echo REHYDRATE_WAITED && sleep 2',
    )
  })

  it('sleeps without echoing', () => {
    assert.equal(shellCommand('wait', 'darwin', { seconds: 1 }), 'sleep 1')
  })

  it('stays busy long enough for an interrupt', () => {
    assert.equal(shellCommand('stay-busy', 'darwin', { seconds: 30 }), 'sleep 30')
  })

  it('removes a file so the write denial is the observable outcome', () => {
    assert.equal(shellCommand('remove-file', 'darwin', { path: 'fixture.txt' }), 'rm -rf fixture.txt')
  })
})

describe('shellCommand win32', () => {
  it('echoes a marker through Write-Output', () => {
    assert.equal(shellCommand('echo-only', 'win32', { text: 'ROBASH_LS_RAN' }), 'Write-Output "ROBASH_LS_RAN"')
  })

  it('echoes a marker then sleeps through Start-Sleep', () => {
    assert.equal(
      shellCommand('echo-and-wait', 'win32', { text: 'REHYDRATE_WAITED', seconds: 2 }),
      'Write-Output "REHYDRATE_WAITED"; Start-Sleep -Seconds 2',
    )
  })

  it('sleeps through Start-Sleep', () => {
    assert.equal(shellCommand('wait', 'win32', { seconds: 1 }), 'Start-Sleep -Seconds 1')
  })

  it('stays busy long enough for an interrupt', () => {
    assert.equal(shellCommand('stay-busy', 'win32', { seconds: 30 }), 'Start-Sleep -Seconds 30')
  })

  it('removes a file through a cmdlet the deny list rejects', () => {
    assert.equal(shellCommand('remove-file', 'win32', { path: 'fixture.txt' }), 'Remove-Item -Force -Recurse fixture.txt')
  })
})

describe('shellCommand input hygiene', () => {
  it('rejects an unknown operation instead of emitting a guess', () => {
    assert.throws(() => shellCommand('explode', 'win32', {}), /unknown shell operation/)
  })

  it('rejects an unknown platform rather than defaulting to a shell', () => {
    assert.throws(() => shellCommand('wait', 'plan9', { seconds: 1 }), /unknown platform/)
  })

  it('rejects a non-integer or negative delay', () => {
    assert.throws(() => shellCommand('wait', 'win32', { seconds: 1.5 }), /seconds/)
    assert.throws(() => shellCommand('wait', 'win32', { seconds: -1 }), /seconds/)
  })

  it('refuses to interpolate text that could smuggle shell syntax', () => {
    assert.throws(() => shellCommand('echo-only', 'darwin', { text: 'x; rm -rf /' }), /text/)
    assert.throws(() => shellCommand('echo-only', 'win32', { text: 'x" ; Remove-Item y' }), /text/)
    assert.throws(() => shellCommand('echo-only', 'darwin', { text: '$(whoami)' }), /text/)
  })

  it('refuses to interpolate a path that could smuggle shell syntax', () => {
    assert.throws(() => shellCommand('remove-file', 'darwin', { path: 'a.txt; rm -rf /' }), /path/)
    assert.throws(() => shellCommand('remove-file', 'win32', { path: '..\\..\\x' }), /path/)
  })
})
