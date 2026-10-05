// Tasks 9.2/9.3 of the session-capability-manager change: portable ref
// whitelists, import validation bounds, and the unresolved binding rules
// (imported items never create/start/connect, never self-enable).
import { test, expect } from './helpers.js'
import { validateSkillRef, validateMcpRef, validatePortableDocument, bindImportedSelection, IMPORT_LIMITS } from '../src/capabilities/portable-refs.js'

const skillRef = (extras = {}) => ({ kind: 'git', repository: 'https://example.com/team/skills.git', ref: 'main', name: 'deploy-helper', ...extras })
const mcpRef = (extras = {}) => ({ identity: 'docs', label: 'Docs server', ...extras })
const portableDoc = (extras = {}) => ({ version: 1, scope: 'global', name: 'Team', selection: { skills: [skillRef()], mcpServers: [mcpRef()], unresolvedRefs: [] }, ...extras })

test('9.2 the skill ref whitelist accepts the credential-free shape and rejects unknown fields', () => {
  expect(validateSkillRef(skillRef()).ok).toBe(true)
  expect(validateSkillRef(skillRef({ token: 'secret' })).reason).toBe('skill-ref:unknown-field:token')
  expect(validateSkillRef(skillRef({ kind: 'svn' })).reason).toBe('skill-ref:unknown-kind')
  expect(validateSkillRef(skillRef({ repository: '' })).reason).toBe('skill-ref:missing:repository')
  expect(validateSkillRef(skillRef({ name: 'x'.repeat(5000) })).reason).toBe('skill-ref:field-too-large:name')
})

test('9.2 an MCP ref is only a logical binding identity + label — connection content is rejected', () => {
  expect(validateMcpRef(mcpRef()).ok).toBe(true)
  expect(validateMcpRef(mcpRef({ command: 'npx' })).reason).toBe('mcp-ref:unknown-field:command')
  expect(validateMcpRef(mcpRef({ url: 'https://x' })).reason).toBe('mcp-ref:unknown-field:url')
  expect(validateMcpRef(mcpRef({ env: { KEY: 'v' } })).reason).toBe('mcp-ref:unknown-field:env')
  expect(validateMcpRef(mcpRef({ label: '' })).reason).toBe('mcp-ref:missing:label')
})

test('9.2 document validation: version, bounds, unknown fields — all atomic, boundary values behave', () => {
  expect(validatePortableDocument(portableDoc()).ok).toBe(true)
  expect(validatePortableDocument(portableDoc({ version: 2 })).reason).toBe('document:unknown-version')
  expect(validatePortableDocument(portableDoc({ secret: 'x' })).reason).toBe('document:unknown-field:secret')
  expect(validatePortableDocument(portableDoc({ selection: { skills: [skillRef({ command: 'rm' })], mcpServers: [], unresolvedRefs: [] } })).reason).toContain('skills[0]:skill-ref:unknown-field:command')
  // Boundary: exactly at the entry cap passes, one over fails.
  const atCap = { version: 1, scope: 'global', name: 'Cap', selection: { skills: [], mcpServers: Array.from({ length: IMPORT_LIMITS.maxEntries }, () => mcpRef()), unresolvedRefs: [] } }
  expect(validatePortableDocument(atCap).ok).toBe(true)
  const overCap = { ...atCap, selection: { ...atCap.selection, mcpServers: [...atCap.selection.mcpServers, mcpRef()] } }
  expect(validatePortableDocument(overCap).reason).toBe('document:too-many-entries')
  // A document whose MCP entry carries connection fields never reaches local config.
  const poisoned = portableDoc({ selection: { skills: [], mcpServers: [mcpRef({ command: 'npx', env: { TOKEN: 'x' } })], unresolvedRefs: [] } })
  expect(validatePortableDocument(poisoned).ok).toBe(false)
})

test('9.3 imported items bind only existing local identities and never self-enable', () => {
  const bound = bindImportedSelection(
    { skills: [skillRef()], mcpServers: [mcpRef({ identity: 'docs' }), mcpRef({ identity: 'stranger' })] },
    { localMcpIdentities: ['docs'] },
  )
  // The configured identity binds; everything else stays unresolved metadata.
  expect(bound.mcpServers).toEqual(['docs'])
  expect(bound.unresolvedRefs).toHaveLength(2)
  expect(bound.unresolvedRefs[0].kind).toBe('skill')
  expect(bound.unresolvedRefs[1].ref.identity).toBe('stranger')
  // Nothing created: no new identities appear anywhere.
  expect(bound.mcpServers).not.toContain('stranger')
})
