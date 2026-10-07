import test from 'node:test'
import assert from 'node:assert/strict'
import { installEditLockWriteScope } from '../src/edit-lock/tool-scope.js'

test('scope teardown never restores inherited direct writers', () => {
 let denied = []
 let own
 const agent = {ctx:{tools:{restrict({deny}) {denied = deny},register(def) {own = def; return () => {own = undefined}}}}}
 const ctx = {fs:{},tools:{get(name) {return name === 'write' ? own : undefined}}}
 const dispose = installEditLockWriteScope(agent,ctx,{publish() {},publishBatch() {}},{})
 assert.equal(own.name,'write')
 assert.deepEqual(denied,['write','edit'])
 dispose(); dispose()
 assert.equal(own,undefined)
 assert.deepEqual(denied,['write','edit'])
})
