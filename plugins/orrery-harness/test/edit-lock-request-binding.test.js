import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { bindRequest } from '../src/edit-lock/request-binding.js'

const request = () => ({ tool: 'write', filePath: 'new.txt', cwd: '/workspace', args: { file_path: 'new.txt', content: 'a\r\né' },
  content: 'a\r\né', effectivePolicy: { mode: 'workspace-write', writableRoots: ['/workspace'] },
  target: { kind: 'create', ancestor: '/workspace', suffix: 'new.txt', policy: { kind: 'createIfAbsent' } } })

test('binds exact UTF8 payload, original arguments, policy and target without caller digests', () => {
  const input = request()
  const binding = bindRequest(input)
  assert.equal(binding.payloadDigest, createHash('sha256').update(Buffer.from(input.content, 'utf8')).digest('hex'))
  for (const change of [ { content: 'a\né' }, { args: { ...input.args, other: true } },
    { effectivePolicy: { mode: 'danger-full-access', writableRoots: ['/workspace'] } },
    { target: { ...input.target, suffix: 'other.txt' } }, { filePath: './new.txt' } ]) {
    assert.notEqual(bindRequest({ ...input, ...change }).requestDigest, binding.requestDigest)
  }
  input.target.suffix = 'mutated'
  assert.equal(binding.target.suffix, 'new.txt')
  assert.ok(Object.isFrozen(binding.target.policy))
})

test('requires complete policy data and reserves creation for write', () => {
  assert.throws(() => bindRequest({ ...request(), effectivePolicy: undefined }), /request data/)
  assert.throws(() => bindRequest({ ...request(), tool: 'hash_edit' }), /creation/)
  assert.throws(() => bindRequest({ ...request(), content: 42 }), /content/)
})
