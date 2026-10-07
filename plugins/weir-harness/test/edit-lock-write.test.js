import test from 'node:test'
import assert from 'node:assert/strict'
import { createManagedWriteTool } from '../src/edit-lock/write-tool.js'

test('managed write preserves observation guard and denies unguarded mutation', async () => {
  let intent = {kind:'replaceIfVersion', version:'observed-v1'}
  const calls = []
  const ctx = {
    fs: {resolve: async () => ({displayPath:'/work/a'}), readText: async () => 'before'},
    waterfall: async () => intent, emit() {},
  }
  const host = {publish: async (_exec, request) => { calls.push(request); return {kind:'updated',version:'v2'} }}
  const policy = {resolve: () => ({mode:'workspace-write',workspaceRoot:'/work'})}
  const tool = createManagedWriteTool(ctx, host, policy)
  const exec = {agent:{session:{header:{cwd:'/work'}}},callId:'w',signal:new AbortController().signal}
  const result = await tool.execute({file_path:'a',content:'after'},exec)
  assert.equal(result.operation, 'update')
  assert.deepEqual(calls[0].expected, {kind:'replaceIfVersion',version:'observed-v1'})
  intent = undefined
  await assert.rejects(tool.execute({file_path:'a',content:'after'},exec), /observation guard/)
  assert.equal(calls.length, 1)
})
