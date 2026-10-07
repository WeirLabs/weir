import { describe, expect, it } from './helpers.js'
import { loadClientChunk } from './helpers/load-client-chunk.js'

/**
 * Zero-dependency view-model chunk test: driven with the default throwing
 * require (zero stubs). Assertions migrated verbatim from the pre-split
 * client.test.js.
 */

describe('client.lsp-model chunk', () => {
  it('round-trips lspServers maps through JSON and degrades invalid values to {}', async () => {
    const { definition, exports } = await loadClientChunk('lib/client.lsp-model.js')
    expect(definition.id).toBe('orrery-harness')
    expect(definition.chunk).toBe('client.lsp-model.js')

    // helper round-trips
    const { jsonToLspServers, lspServersToJson } = exports
    expect(jsonToLspServers('not-json')).toEqual({})
    expect(jsonToLspServers('{"zig":{"command":"zls"}}').zig.command).toBe('zls')
    expect(lspServersToJson({})).toBe('{}')
  })

  it('splits shell-style install commands', async () => {
    const { exports } = await loadClientChunk('lib/client.lsp-model.js')
    const { splitInstallCommand } = exports
    expect(splitInstallCommand('npm i -g zls')).toEqual({ command: 'npm', args: ['i', '-g', 'zls'] })
    expect(splitInstallCommand('brew install llvm')).toEqual({ command: 'brew', args: ['install', 'llvm'] })
    expect(splitInstallCommand('single')).toEqual({ command: 'single', args: [] })
    expect(splitInstallCommand('  ')).toBe(undefined)
    expect(splitInstallCommand(undefined)).toBe(undefined)
  })

  it('judges stored lspServers JSON validity: blank or a plain map pass, arrays/scalars/broken JSON fail', async () => {
    const { exports } = await loadClientChunk('lib/client.lsp-model.js')
    const { lspServersJsonValid } = exports
    expect(lspServersJsonValid('')).toBe(true)
    expect(lspServersJsonValid('   ')).toBe(true)
    expect(lspServersJsonValid(undefined)).toBe(true)
    expect(lspServersJsonValid('{}')).toBe(true)
    expect(lspServersJsonValid('{"zig":{"command":"zls"}}')).toBe(true)
    expect(lspServersJsonValid('[1]')).toBe(false)
    expect(lspServersJsonValid('"x"')).toBe(false)
    expect(lspServersJsonValid('42')).toBe(false)
    expect(lspServersJsonValid('null')).toBe(false)
    expect(lspServersJsonValid('not-json')).toBe(false)
    expect(lspServersJsonValid('{"zig":')).toBe(false)
  })
})
