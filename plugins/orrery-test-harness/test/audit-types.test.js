// Conformance for the single-sourced audit vocabulary (design D4, task 2.4):
//  1. the event-tap's subscription set equals Object.values(AUDIT_TYPES) plus
//     every registered AUDIT_SUBTYPES sub-event;
//  2. the three product emit files carry no audit() call whose type argument
//     is a string literal outside the registry (defense in depth against a
//     new emit site forgetting the constants);
//  3. the group coordinator's onFact kinds equal AUDIT_SUBTYPES.supervision
//     (a new supervision fact kind cannot silently escape the tap).
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { AUDIT_TYPES, AUDIT_SUBTYPES } from '../../orrery-harness/src/shared/audit.js'
import { apply } from '../src/event-tap.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PRODUCT_SRC = join(HERE, '..', '..', 'orrery-harness', 'src')
// Emit-site files: every product module that calls audit(...) with a type
// argument. After the delegate split the supervision emits live in
// supervision-mount.js — keep this list aligned with a grep for "audit(".
const EMIT_FILES = ['intent-gate/index.js', 'todo-driver/index.js', 'delegate/supervision-mount.js']

/** The subscription set the tap is expected to register on the cordis bus. */
function expectedAuditEvents() {
  return [
    ...Object.values(AUDIT_TYPES),
    ...Object.entries(AUDIT_SUBTYPES).flatMap(([name, kinds]) => kinds.map((kind) => `${AUDIT_TYPES[name]}/${kind}`)),
  ].map((type) => `orrery/${type}`)
}

describe('event-tap audit subscriptions', () => {
  it('subscribes exactly to Object.values(AUDIT_TYPES) plus AUDIT_SUBTYPES sub-events', () => {
    const subscribed = []
    const fakeCtx = { on: (name) => subscribed.push(name) }
    apply(fakeCtx)
    const auditEvents = subscribed.filter((name) => name.startsWith('orrery/'))
    assert.deepEqual(auditEvents.sort(), expectedAuditEvents().sort())
  })

  it('AUDIT_SUBTYPES keys are AUDIT_TYPES member names (expansion can never miss)', () => {
    for (const name of Object.keys(AUDIT_SUBTYPES)) {
      assert.equal(typeof AUDIT_TYPES[name], 'string', `AUDIT_SUBTYPES.${name} has no AUDIT_TYPES counterpart`)
    }
  })
})

describe('product emit sites', () => {
  it('no audit() type argument is a string literal outside the registry', () => {
    const registry = new Set(Object.values(AUDIT_TYPES))
    for (const file of EMIT_FILES) {
      const source = readFileSync(join(PRODUCT_SRC, file), 'utf8')
      // audit(<session-expr>, '<literal>' — template/constant args do not match.
      const literals = [...source.matchAll(/\baudit\(\s*[^,()]+,\s*(['"])([^'"]*)\1/g)].map((match) => match[2])
      for (const literal of literals) {
        assert.ok(registry.has(literal), `${file} emits unregistered audit type literal '${literal}'`)
      }
    }
  })

  it('every emit file references AUDIT_TYPES constants (scan reads real content)', () => {
    for (const file of EMIT_FILES) {
      const source = readFileSync(join(PRODUCT_SRC, file), 'utf8')
      assert.ok(source.includes('AUDIT_TYPES.'), `${file} references no AUDIT_TYPES constant`)
    }
  })
})

describe('supervision sub-event registry (task 2.4)', () => {
  it('group coordinator onFact kinds equal AUDIT_SUBTYPES.supervision', () => {
    const source = readFileSync(join(PRODUCT_SRC, 'delegate', 'group-coordinator.js'), 'utf8')
    const kinds = [...source.matchAll(/onFact\?\.\(\{ kind: '([^']+)'/g)].map((match) => match[1])
    assert.ok(kinds.length > 0, 'no onFact kinds found — scan is broken')
    assert.deepEqual([...new Set(kinds)].sort(), [...AUDIT_SUBTYPES.supervision].sort())
  })
})
