// Scenario: lsp — LSP tool set toggle, diagnostics/definition/references/
// symbols, cross-file rename, stale-version rejection, unregister on off.
// Migrated from mock-llm.js decideLsp / run.mjs assertLsp (D1/D2).
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { IT_ROOT, lastOfRole, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'lsp'
const prompt = 'lsp-probe'

const TSFIXTURE = process.env.ORRERY_IT_TSFIXTURE ?? join(IT_ROOT, 'ws', 'probe.ts')

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const lastRole = options.messages?.at(-1)?.role
  if (lastRole === 'tool') {
    const toolText = lastOfRole(options, 'tool')
    if (toolText.includes('unknown tool')) return textChunks('lsp scenario done')
    if (toolText.includes('disabled for this session')) return toolCallChunks('lsp_diagnostics', { file_path: TSFIXTURE })
    // The stale-version probe finished (ordinary tool error naming the
    // written/not-written lists) → toggle the tool set off.
    if (toolText.includes('filesNotWritten')) return toolCallChunks('lsp', { enabled: false })
    // Cross-file rename applied → run the deterministic stale-version probe.
    if (toolText.includes('across 2 file(s)')) return toolCallChunks('lsp_rename', { file_path: TSFIXTURE, line: 1, character: 14, new_name: 'staleProbe' })
    // Document symbols listed → run the cross-file rename.
    if (toolText.includes('Document symbols:')) return toolCallChunks('lsp_rename', { file_path: TSFIXTURE, line: 1, character: 14, new_name: 'renamedSymbol' })
    if (toolText.includes('reference(s)')) return toolCallChunks('lsp_symbols', { file_path: TSFIXTURE })
    if (toolText.includes('Definition location')) return toolCallChunks('lsp_references', { file_path: TSFIXTURE, line: 3, character: 5 })
    if (toolText.includes('diagnostic(s) for')) return toolCallChunks('lsp_definition', { file_path: TSFIXTURE, line: 3, character: 5 })
    if (toolText.includes('enabled for this session')) return toolCallChunks('lsp_diagnostics', { file_path: TSFIXTURE })
    return textChunks('unhandled lsp turn')
  }
  if (history.includes('lsp-probe')) {
    return toolCallChunks('lsp', { enabled: true })
  }
  return textChunks('unhandled lsp turn')
}

function observe(obs) {
  return {
    lspToggledOn: obs.transcript.includes('LSP semantic tools enabled'),
    lspRenameSeen: obs.transcript.includes('across 2 file(s)'),
    lspRenameStaleSeen: obs.transcript.includes('filesAlreadyWritten') && obs.transcript.includes('filesNotWritten'),
    lspDiagSeen: obs.transcript.includes('mock-diagnostic'),
    lspDefSeen: obs.transcript.includes('probe.ts:3:5'),
    lspRefsSeen: obs.transcript.includes('2 reference(s)'),
    lspSymbolsSeen: obs.transcript.includes('fixtureSymbol'),
    lspUnknownAfterOff: obs.transcript.includes('unknown tool "lsp_diagnostics"'),
  }
}

function assert(run) {
  const requests = run.requests
  run.check('toggle enabled the LSP tool set', requests.some((r) => r.lspToggledOn), JSON.stringify(requests.map((r) => r.lspToggledOn)))
  run.check('diagnostics delivered through the mock LSP server', requests.some((r) => r.lspDiagSeen), JSON.stringify(requests.map((r) => r.lspDiagSeen)))
  run.check('definition, references, and symbols answered', requests.some((r) => r.lspDefSeen) && requests.some((r) => r.lspRefsSeen) && requests.some((r) => r.lspSymbolsSeen), JSON.stringify(requests.map((r) => [r.lspDefSeen, r.lspRefsSeen, r.lspSymbolsSeen])))
  // Rename probes: fixtureSymbol → renamedSymbol (cross-file), then
  // renamedSymbol → staleProbe (deterministic stale-version injection — the
  // mock's WorkspaceEdit carries a same-file alias entry ordered after the
  // real one, so the alias's replaceIfVersion always rejects mid-write).
  // Final on-disk state reflects BOTH renames on the real entries only.
  const probeTs = readFileSync(join(run.ws, 'probe.ts'), 'utf8')
  const probeOther = readFileSync(join(run.ws, 'probe-other.ts'), 'utf8')
  run.check('rename summary rendered to the model', requests.some((r) => r.lspRenameSeen), JSON.stringify(requests.map((r) => r.lspRenameSeen)))
  run.check('cross-file rename rewrote both fixtures on disk', probeTs === 'export const staleProbe = 1\n' && probeOther === 'import { staleProbe } from "./probe"\r\nexport const useIt = staleProbe + 1\r\n', JSON.stringify([probeTs, probeOther]))
  run.check('CRLF fixture kept its line-ending style on write-back', probeOther.includes('\r\n') && probeOther.split('\r\n').every((line) => !line.includes('\n')), JSON.stringify(probeOther))
  run.check('stale-version write stopped mid-pass and named written/not-written files', requests.some((r) => r.lspRenameStaleSeen), JSON.stringify(requests.map((r) => r.lspRenameStaleSeen)))
  run.check('the rejected alias write never landed (no X-suffixed content)', !probeTs.includes('staleProbeX') && !probeOther.includes('staleProbeX'), JSON.stringify([probeTs, probeOther]))
  run.check('tools unregistered after toggle off', requests.some((r) => r.lspUnknownAfterOff), JSON.stringify(requests.map((r) => r.lspUnknownAfterOff)))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, assert }
