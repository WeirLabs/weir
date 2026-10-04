import { test, expect } from '../../test/helpers.js'
import { createSkillIdentity, sameSkillIdentity, skillIdentityKey, SKILL_SCOPES } from '../../src/capabilities/skill-identity.js'

const input = { scope: 'project', root: '/project/.dsh/skills', name: 'example', provenance: { repository: 'owner/repo', subpath: 'skills/example' } }

test('scope, root, name and provenance each participate in identity', () => {
  const identity = createSkillIdentity(input)
  expect(sameSkillIdentity(identity, { ...input, provenance: { subpath: 'skills/example', repository: 'owner/repo' } })).toBe(true)
  for (const change of [{ scope: 'user' }, { root: '/other' }, { name: 'other' }, { provenance: { repository: 'other/repo' } }]) {
    expect(sameSkillIdentity(identity, { ...input, ...change })).toBe(false)
  }
  for (const scope of SKILL_SCOPES) expect(createSkillIdentity({ ...input, scope }).scope).toBe(scope)
})

test('content digest, rank and discovery order confer no identity or authorization', () => {
  expect(skillIdentityKey({ ...input, digest: 'old', rank: 100 })).toBe(skillIdentityKey({ ...input, digest: 'new', rank: 600 }))
  expect(Object.keys(createSkillIdentity(input))).toEqual(['scope', 'root', 'name', 'provenance', 'portable'])
})

test('unknown provenance requires a persistent machine-local opaque id and is not portable', () => {
  const local = { ...input, provenance: null, opaqueId: 'machine-a:local-1' }
  expect(createSkillIdentity(local).portable).toBe(false)
  expect(sameSkillIdentity(local, { ...local, opaqueId: 'machine-b:local-1' })).toBe(false)
  expect(() => createSkillIdentity({ ...input, provenance: null })).toThrow(TypeError)
})

test('identity validation rejects malformed inputs and freezes copied provenance', () => {
  for (const patch of [{ scope: 'bundled' }, { root: '' }, { name: 'Bad' }, { provenance: {} }, { provenance: [] }, { provenance: { repository: 1 } }]) {
    expect(() => createSkillIdentity({ ...input, ...patch })).toThrow(TypeError)
  }
  const source = { ...input, provenance: { repository: 'repo' } }
  const identity = createSkillIdentity(source)
  source.provenance.repository = 'changed'
  expect(identity.provenance.repository).toBe('repo')
  expect(Object.isFrozen(identity.provenance)).toBe(true)
})
