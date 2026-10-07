// Session blackboard mount tests: the five tool definitions (object-rooted
// JSON Schemas, closed entryType enum, English descriptions carrying the six
// discriminators and the search-before-create discipline), the service
// surface, board identity across the delegation tree, the settings-driven
// TTL, and the terminate/dispose lifecycle hooks. Stub ctx — no cordis.
import { describe, expect, it } from '../helpers.js'
import { createBlackboardKernel } from '../../src/blackboard/kernel.js'
import { createBlackboardPlugin, DEFAULT_WRITE_TOKEN_TTL_MINUTES, resolveWriteTokenTtlMinutes } from '../../src/blackboard/index.js'

const TTL = 60_000

/** @param {{ settings?: object, sessions?: Map<string, object> }} [options] */
function mountStub({ settings = {}, sessions = new Map() } = {}) {
  /** @type {any[]} */
  const registered = []
  /** @type {Map<string, Function>} */
  const handlers = new Map()
  /** @type {Map<string, any>} */
  const provided = new Map()
  /** @type {Array<{ type: string, record: object }>} */
  const emitted = []
  /** @type {string[]} */
  const warnings = []
  const ctx = {
    tools: { register: (/** @type {any} */ definition) => { registered.push(definition); return () => {} } },
    on: (/** @type {string} */ name, /** @type {Function} */ fn) => { handlers.set(name, fn); return () => handlers.delete(name) },
    reflect: { provide: (/** @type {string} */ name, /** @type {any} */ service) => { provided.set(name, service) } },
    get: (/** @type {string} */ name) => {
      if (name === 'orrerySettings') return { get: (/** @type {string} */ section) => settings[section] }
      if (name === 'sessions') return { get: (/** @type {string} */ id) => sessions.get(id) }
      return undefined
    },
    emit: (/** @type {string} */ type, /** @type {object} */ record) => { emitted.push({ type, record }) },
    logger: { warn: (/** @type {string} */ message) => warnings.push(message) },
    effect: (/** @type {Function} */ fn) => fn(),
  }
  const apply = createBlackboardPlugin({ kernel: () => createBlackboardKernel() })
  const dispose = apply(ctx, {})
  return { ctx, registered, handlers, provided, emitted, warnings, dispose }
}

const tool = (/** @type {{ registered: any[] }} */ mount, /** @type {string} */ name) => mount.registered.find((/** @type {any} */ definition) => definition.name === name)

/** An exec stub for a root agent of session `id`. */
const rootExec = (/** @type {string} */ id) => ({ agent: { id, session: { id, header: { delegationDepth: 0 } } } })
/** An exec stub for a delegated child whose session header points at its parent. */
const childExec = (/** @type {string} */ id, /** @type {string} */ parentId, /** @type {number} */ depth = 1) => ({ agent: { id, session: { id, header: { delegationDepth: depth, parentSession: parentId } } } })

describe('resolveWriteTokenTtlMinutes (volatile settings resolution)', () => {
  it('defaults to 60 minutes when the section or the key is unset', () => {
    expect(resolveWriteTokenTtlMinutes(undefined)).toBe(DEFAULT_WRITE_TOKEN_TTL_MINUTES)
    expect(resolveWriteTokenTtlMinutes({})).toBe(DEFAULT_WRITE_TOKEN_TTL_MINUTES)
    expect(DEFAULT_WRITE_TOKEN_TTL_MINUTES).toBe(60)
  })

  it('takes a positive number from the section', () => {
    expect(resolveWriteTokenTtlMinutes({ writeTokenTtlMinutes: 2 })).toBe(2)
    expect(resolveWriteTokenTtlMinutes({ writeTokenTtlMinutes: 60 })).toBe(60)
  })

  it('throws with the flat settings key named for a present but unusable value', () => {
    expect(() => resolveWriteTokenTtlMinutes({ writeTokenTtlMinutes: 0 })).toThrow(/blackboardWriteTokenTtlMinutes/)
    expect(() => resolveWriteTokenTtlMinutes({ writeTokenTtlMinutes: 'soon' })).toThrow(/blackboardWriteTokenTtlMinutes/)
  })
})

describe('tool surface (S12: object-rooted schemas, closed enum, English discipline)', () => {
  const mount = mountStub()

  it('registers exactly the five board tools, each object-rooted with a required array', () => {
    expect(mount.registered.map((/** @type {any} */ definition) => definition.name).sort()).toEqual([
      'blackboard_apply', 'blackboard_delete', 'blackboard_list', 'blackboard_read', 'blackboard_write',
    ])
    for (const definition of mount.registered) {
      expect(definition.parameters.type).toBe('object')
      expect(Array.isArray(definition.parameters.required)).toBe(true)
      expect(typeof definition.execute).toBe('function')
      expect(definition.output.render).toBeTruthy()
    }
  })

  it('the entryType schema enum is exactly the closed six, on list and write', () => {
    for (const name of ['blackboard_list', 'blackboard_write']) {
      expect(tool(mount, name).parameters.properties.entryType.enum).toEqual(['map', 'contract', 'deadend', 'wiring', 'recipe', 'why'])
      expect(tool(mount, name).parameters.properties.entryType.type).toBe('string')
    }
    expect(tool(mount, 'blackboard_write').parameters.required).toEqual(['key', 'entryType', 'summary', 'content'])
    expect(tool(mount, 'blackboard_write').parameters.properties.summary.required).toEqual(['fact', 'cost', 'reVerify'])
  })

  it('descriptions carry the six discriminators and the search-before-create discipline', () => {
    const list = tool(mount, 'blackboard_list').description
    const write = tool(mount, 'blackboard_write').description
    const apply = tool(mount, 'blackboard_apply').description
    for (const line of ['map = where something lives', 'contract = what holds', 'deadend = what does not work', 'wiring = hidden cross-file coupling', 'recipe = how to do something', 'why = why it was built this way']) {
      expect(list).toContain(line)
      expect(write).toContain(line)
    }
    expect(write).toMatch(/search before create/i)
    expect(apply).toMatch(/search before create/i)
    expect(write).toMatch(/never instructions/i)
    expect(list).toContain('List NEVER returns entry content')
  })

  it('provides the orreryBlackboard service with the five routes and the lifecycle surface', () => {
    const service = mount.provided.get('orreryBlackboard')
    expect(service).toBeTruthy()
    for (const method of ['list', 'read', 'apply', 'write', 'deleteKey', 'boardOf', 'entriesOf', 'tokensOf', 'subscriptionsOf', 'releaseHolder', 'dropBoard']) {
      expect(typeof service[method]).toBe('function')
    }
  })
})

describe('board identity across the delegation tree', () => {
  it('a root agent is its own board; a child resolves the root through the sessions walk', () => {
    const sessions = new Map([
      ['root', { id: 'root', header: { delegationDepth: 0 } }],
      ['mid', { id: 'mid', header: { delegationDepth: 1, parentSession: 'root' } }],
    ])
    const mount = mountStub({ sessions })
    const service = mount.provided.get('orreryBlackboard')
    expect(service.boardOf(rootExec('root').agent)).toBe('root')
    expect(service.boardOf(childExec('child', 'root').agent)).toBe('root')
    expect(service.boardOf(childExec('deep', 'mid', 2).agent)).toBe('root')
  })

  it('a child without a live sessions registry degrades to its direct parent id', () => {
    const mount = mountStub({ sessions: new Map() })
    const service = mount.provided.get('orreryBlackboard')
    expect(service.boardOf(childExec('child', 'root').agent)).toBe('root')
  })
})

describe('tool execution: the shared-board flow', () => {
  it('root writes, a sibling child reads the same board through the full tool surface', async () => {
    const mount = mountStub()
    const root = rootExec('root')
    const child = childExec('child', 'root')
    await tool(mount, 'blackboard_write').execute({ key: 'dsh-runtime-map', entryType: 'map', summary: { fact: 'the fact', cost: 'two searches', reVerify: 'ls packages' }, content: 'full content' }, root)
    const listed = await tool(mount, 'blackboard_list').execute({}, child)
    expect(listed.message).toContain('- dsh-runtime-map (map)')
    expect(listed.message).toContain('the fact')
    expect(listed.message).not.toContain('full content')
    const read = await tool(mount, 'blackboard_read').execute({ keys: ['dsh-runtime-map', 'ghost'] }, child)
    expect(read.message).toContain('full content')
    expect(read.message).toContain('Missing keys (not on the board): ghost')
  })

  it('list search and exact type filter work through the tool', async () => {
    const mount = mountStub()
    const root = rootExec('root')
    await tool(mount, 'blackboard_write').execute({ key: 'layout-map', entryType: 'map', summary: { fact: 'where packages live', cost: 'c', reVerify: 'r' }, content: 'c1' }, root)
    await tool(mount, 'blackboard_write').execute({ key: 'deadend-x', entryType: 'deadend', summary: { fact: 'plugin does not work', cost: 'c', reVerify: 'r' }, content: 'c2' }, root)
    expect((await tool(mount, 'blackboard_list').execute({ query: 'PACKAGES' }, root)).message).toContain('layout-map')
    expect((await tool(mount, 'blackboard_list').execute({ entryType: 'deadend' }, root)).message).toContain('deadend-x')
    expect((await tool(mount, 'blackboard_list').execute({ entryType: 'deadend' }, root)).message).not.toContain('layout-map')
  })

  it('apply → write → consume → contention → auto-subscribe → terminate release', async () => {
    const mount = mountStub()
    const root = rootExec('root')
    const child = childExec('child', 'root')
    await tool(mount, 'blackboard_write').execute({ key: 'k', entryType: 'map', summary: { fact: 'f', cost: 'c', reVerify: 'r' }, content: 'c' }, root)
    const applied = await tool(mount, 'blackboard_apply').execute({ key: 'k' }, child)
    expect(applied.status).toBe('granted')
    await expect(async () => tool(mount, 'blackboard_apply').execute({ key: 'k' }, root)).rejects.toThrow(/held by another agent/)
    expect(mount.provided.get('orreryBlackboard').subscriptionsOf('root')).toEqual([{ key: 'k', subscriberIds: ['root'] }])
    // The terminate path releases the child's token and delivers the release event.
    mount.handlers.get('orrery/supervision/terminate')({ time: 1, session: 'root', type: 'orrery/supervision/terminate', data: { kind: 'terminate', childId: 'child' } })
    expect(mount.provided.get('orreryBlackboard').tokensOf('root')).toEqual([])
    expect(mount.emitted).toHaveLength(1)
    expect(mount.emitted[0].type).toBe('orrery/blackboard/released')
    expect(mount.emitted[0].record.session).toBe('root')
    expect(typeof mount.emitted[0].record.time).toBe('number')
    expect(mount.emitted[0].record.data).toEqual({ key: 'k', holder: 'child', reason: 'terminate', subscriberIds: ['root'] })
  })

  it('write and delete without authority fail explicitly, naming the holder', async () => {
    const mount = mountStub()
    const root = rootExec('root')
    const child = childExec('child', 'root')
    await tool(mount, 'blackboard_write').execute({ key: 'k', entryType: 'map', summary: { fact: 'f', cost: 'c', reVerify: 'r' }, content: 'c' }, root)
    await tool(mount, 'blackboard_apply').execute({ key: 'k' }, child)
    await expect(async () => tool(mount, 'blackboard_write').execute({ key: 'k', entryType: 'map', summary: { fact: 'f', cost: 'c', reVerify: 'r' }, content: 'c' }, root)).rejects.toThrow(/not held by this session.*held by another agent/)
    await expect(async () => tool(mount, 'blackboard_delete').execute({ key: 'k' }, root)).rejects.toThrow(/not held by this session/)
    await expect(async () => tool(mount, 'blackboard_delete').execute({ key: 'ghost' }, root)).rejects.toThrow(/does not exist/)
  })

  it('entryType outside the closed enum and a summary missing reVerify are refused at write time', async () => {
    const mount = mountStub()
    const root = rootExec('root')
    await expect(async () => tool(mount, 'blackboard_write').execute({ key: 'k', entryType: 'banana', summary: { fact: 'f', cost: 'c', reVerify: 'r' }, content: 'c' }, root)).rejects.toThrow(/entryType must be one of/)
    await expect(async () => tool(mount, 'blackboard_write').execute({ key: 'k', entryType: 'map', summary: { fact: 'f', cost: 'c' }, content: 'c' }, root)).rejects.toThrow(/summary\.reVerify/)
  })

  it('reads the write-token TTL live from the settings section', async () => {
    const mount = mountStub({ settings: { blackboard: { writeTokenTtlMinutes: 2 } } })
    const root = rootExec('root')
    const applied = await tool(mount, 'blackboard_apply').execute({ key: 'k' }, root)
    expect(applied.ttlMs).toBe(120_000)
    const bad = mountStub({ settings: { blackboard: { writeTokenTtlMinutes: -1 } } })
    const fallback = await tool(bad, 'blackboard_apply').execute({ key: 'k' }, rootExec('root'))
    expect(fallback.ttlMs).toBe(DEFAULT_WRITE_TOKEN_TTL_MINUTES * 60_000)
    expect(bad.warnings.join('\n')).toContain('blackboardWriteTokenTtlMinutes')
  })

  it('agent disposal releases a child token and drops the root board', () => {
    const mount = mountStub()
    const service = mount.provided.get('orreryBlackboard')
    service.write(rootExec('root'), { key: 'k', entryType: 'map', summary: { fact: 'f', cost: 'c', reVerify: 'r' }, content: 'c' })
    service.apply(childExec('child', 'root'), 'k')
    expect(service.tokensOf('root')).toHaveLength(1)
    mount.handlers.get('agent/disposed')({ agent: childExec('child', 'root').agent })
    expect(service.tokensOf('root')).toEqual([])
    expect(service.entriesOf('root')).toHaveLength(1)
    mount.handlers.get('agent/disposed')({ agent: rootExec('root').agent })
    expect(service.entriesOf('root')).toEqual([])
  })

  it('unmount removes the listeners without breaking the kernel', () => {
    const mount = mountStub()
    mount.dispose()
    expect(mount.handlers.size).toBe(0)
  })
})
