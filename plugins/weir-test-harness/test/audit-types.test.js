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
import { AUDIT_TYPES, AUDIT_SUBTYPES } from '../../weir-harness/src/shared/audit.js'
import { SPAWN_FACT_RECORD_TYPE, SPAWN_FACT_TYPE } from '../../weir-harness/src/delegate/child-composition.js'
import { apply } from '../src/event-tap.js'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const PRODUCT_SRC = join(HERE, '..', '..', 'weir-harness', 'src')
// Emit-site files: every product module that calls audit(...) with a type
// argument. After the delegate split the supervision emits live in
// supervision-mount.js — keep this list aligned with a grep for "audit(".
const EMIT_FILES = ['intent-gate/index.js', 'todo-driver/index.js', 'delegate/supervision-mount.js', 'delegate/child-composition.js']

/** The subscription set the tap is expected to register on the cordis bus. */
function expectedAuditEvents() {
  return [
    ...Object.values(AUDIT_TYPES),
    ...Object.entries(AUDIT_SUBTYPES).flatMap(([name, kinds]) => kinds.map((kind) => `${AUDIT_TYPES[name]}/${kind}`)),
  ].map((type) => `weir/${type}`)
}

describe('event-tap audit subscriptions', () => {
  it('subscribes exactly to Object.values(AUDIT_TYPES) plus AUDIT_SUBTYPES sub-events', () => {
    const subscribed = []
    const fakeCtx = { on: (name) => subscribed.push(name) }
    apply(fakeCtx)
    const auditEvents = subscribed.filter((name) => name.startsWith('weir/'))
    assert.deepEqual(auditEvents.sort(), expectedAuditEvents().sort())
  })

  it('AUDIT_SUBTYPES keys are AUDIT_TYPES member names (expansion can never miss)', () => {
    for (const name of Object.keys(AUDIT_SUBTYPES)) {
      assert.equal(typeof AUDIT_TYPES[name], 'string', `AUDIT_SUBTYPES.${name} has no AUDIT_TYPES counterpart`)
    }
  })
})

describe('delegate spawn-fact vocabulary (single-prefix contract)', () => {
  it('the sink type is the unprefixed registry value and the record adds exactly one weir/ prefix', () => {
    // createAudit prepends `weir/` itself (src/shared/audit.js), so the value
    // handed to audit() must stay unprefixed; a pre-prefixed constant wrote
    // `weir/weir/delegate/spawn` records that every reader silently missed.
    assert.equal(SPAWN_FACT_TYPE, `${AUDIT_TYPES.delegate}/${AUDIT_SUBTYPES.delegate[0]}`)
    assert.equal(SPAWN_FACT_TYPE, 'delegate/spawn')
    assert.equal(SPAWN_FACT_RECORD_TYPE, `weir/${SPAWN_FACT_TYPE}`)
    assert.equal(SPAWN_FACT_RECORD_TYPE, 'weir/delegate/spawn')
  })

  it('the spawn-fact emit hands the UNPREFIXED constant to audit()', () => {
    const source = readFileSync(join(PRODUCT_SRC, 'delegate', 'child-composition.js'), 'utf8')
    const calls = [...source.matchAll(/\baudit\(([^)]*)\)/g)].map((match) => match[1])
    assert.ok(calls.length > 0, 'no audit() call found — scan is broken')
    for (const args of calls) {
      const type = args.split(',')[1]?.trim()
      assert.equal(type, 'SPAWN_FACT_TYPE', `the spawn fact passes '${type}' as the audit type; the sink already prepends weir/`)
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
