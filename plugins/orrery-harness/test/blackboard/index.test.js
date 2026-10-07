// Session blackboard mount tests: the five tool definitions (object-rooted
// JSON Schemas, closed entryType enum, English descriptions carrying the six
// discriminators and the search-before-create discipline), the service
// surface, board identity across the delegation tree, the settings-driven
// TTL, and the terminate/dispose lifecycle hooks. Stub ctx — no cordis.
import { describe, expect, it } from '../helpers.js'
import { createBlackboardKernel } from '../../src/blackboard/kernel.js'
import { createBlackboardPlugin, DEFAULT_WRITE_TOKEN_TTL_MINUTES, resolveWriteTokenTtlMinutes } from '../../src/blackboard/index.js'

const TTL = 60_000

/** @param {{ settings?: object, sessions?: Map<string, object>, toolsView?: (agent: any) => { visible: Set<string> } }} [options] */
function mountStub({ settings = {}, sessions = new Map(), toolsView } = {}) {
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
  /** @type {Array<{ name: string, order: number, text: string }>} */
  const sections = []
  /** @type {Map<string, Function>} */
  const variables = new Map()
  const ctx = {
    tools: {
      register: (/** @type {any} */ definition) => { registered.push(definition); return () => {} },
      view: toolsView ?? (() => ({ visible: new Set(['blackboard_list', 'blackboard_read', 'blackboard_apply', 'blackboard_write', 'blackboard_delete']) })),
    },
    on: (/** @type {string} */ name, /** @type {Function} */ fn) => { handlers.set(name, fn); return () => handlers.delete(name) },
    reflect: { provide: (/** @type {string} */ name, /** @type {any} */ service) => { provided.set(name, service) } },
    get: (/** @type {string} */ name) => {
      if (name === 'orrerySettings') return { get: (/** @type {string} */ section) => settings[section] }
      if (name === 'sessions') return { get: (/** @type {string} */ id) => sessions.get(id) }
      return undefined
    },
    emit: (/** @type {string} */ type, /** @type {object} */ record) => { emitted.push({ type, record }) },
    systemPrompt: {
      section: (/** @type {any} */ section) => { sections.push(section); return () => {} },
      variable: (/** @type {string} */ name, /** @type {Function} */ provider) => { variables.set(name, provider); return () => variables.delete(name) },
    },
    logger: { warn: (/** @type {string} */ message) => warnings.push(message) },
    effect: (/** @type {Function} */ fn) => fn(),
  }
  const apply = createBlackboardPlugin({ kernel: () => createBlackboardKernel() })
  const dispose = apply(ctx, {})
  return { ctx, registered, handlers, provided, emitted, warnings, sections, variables, dispose }
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

  it('registers exactly the six board tools, each object-rooted with a required array', () => {
    expect(mount.registered.map((/** @type {any} */ definition) => definition.name).sort()).toEqual([
      'blackboard_apply', 'blackboard_delete', 'blackboard_list', 'blackboard_mark_promoted', 'blackboard_read', 'blackboard_write',
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
    expect(tool(mount, 'blackboard_write').parameters.properties.summary.type).toBe('string')
  })

  it('the markPromoted tool pins the closed destination enum and names the promoted read-only semantics', () => {
    const mark = tool(mount, 'blackboard_mark_promoted')
    expect(mark.parameters.type).toBe('object')
    expect(mark.parameters.required).toEqual(['key', 'destination'])
    expect(mark.parameters.properties.destination.enum).toEqual(['docs/spikes.md', 'runtime-map', 'agents-pointer'])
    expect(mark.description).toMatch(/read-only/)
    expect(mark.description).toMatch(/Only the conversation's main agent may mark/)
    expect(mark.description).toMatch(/Discarded entries are NOT marked/)
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

  it('provides the orreryBlackboard service with the six routes and the lifecycle surface', () => {
    const service = mount.provided.get('orreryBlackboard')
    expect(service).toBeTruthy()
    for (const method of ['list', 'read', 'apply', 'write', 'deleteKey', 'markPromoted', 'boardOf', 'entriesOf', 'tokensOf', 'subscriptionsOf', 'releaseHolder', 'dropBoard']) {
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

describe('markPromoted tool execution (slice 3: root-gated, fold the kernel statuses)', () => {
  it('the root agent marks an entry promoted; the entry then refuses every mutation', async () => {
    const mount = mountStub()
    const service = mount.provided.get('orreryBlackboard')
    service.write(rootExec('root'), { key: 'probe.key', entryType: 'map', summary: 'f', content: 'body' })
    const mark = tool(mount, 'blackboard_mark_promoted')
    const result = await mark.execute({ key: 'probe.key', destination: 'docs/spikes.md' }, rootExec('root'))
    expect(result.status).toBe('promoted')
    expect(result.message).toContain('Marked entry "probe.key" promoted to docs/spikes.md')
    expect(result.message).toContain('read-only')
    // Marking twice reports the existing marker instead of overwriting it.
    const again = await mark.execute({ key: 'probe.key', destination: 'runtime-map' }, rootExec('root'))
    expect(again.status).toBe('already-promoted')
    expect(again.destination).toBe('docs/spikes.md')
    // The kernel refuses mutations with the explicit promoted status.
    expect(service.apply(rootExec('root'), 'probe.key').status).toBe('promoted')
    // A delegated child is refused outright — promotion is the user's call.
    await expect(async () => mark.execute({ key: 'probe.key', destination: 'docs/spikes.md' }, childExec('child', 'root'))).rejects.toThrow(/reserved for the conversation main agent/)
  })

  it('a missing key and a bad destination surface as explicit errors', async () => {
    const mount = mountStub()
    const mark = tool(mount, 'blackboard_mark_promoted')
    await expect(async () => mark.execute({ key: 'ghost', destination: 'docs/spikes.md' }, rootExec('root'))).rejects.toThrow(/does not exist/)
    await expect(async () => mark.execute({ key: 'k', destination: 'banana' }, rootExec('root'))).rejects.toThrow(/destination must be one of/)
  })
})

describe('tool execution: the shared-board flow', () => {
  it('root writes, a sibling child reads the same board through the full tool surface', async () => {
    const mount = mountStub()
    const root = rootExec('root')
    const child = childExec('child', 'root')
    await tool(mount, 'blackboard_write').execute({ key: 'dsh-runtime-map', entryType: 'map', summary: 'the fact', content: 'full content' }, root)
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
    await tool(mount, 'blackboard_write').execute({ key: 'layout-map', entryType: 'map', summary: 'where packages live', content: 'c1' }, root)
    await tool(mount, 'blackboard_write').execute({ key: 'deadend-x', entryType: 'deadend', summary: 'plugin does not work', content: 'c2' }, root)
    expect((await tool(mount, 'blackboard_list').execute({ query: 'PACKAGES' }, root)).message).toContain('layout-map')
    expect((await tool(mount, 'blackboard_list').execute({ entryType: 'deadend' }, root)).message).toContain('deadend-x')
    expect((await tool(mount, 'blackboard_list').execute({ entryType: 'deadend' }, root)).message).not.toContain('layout-map')
  })

  it('apply → write → consume → contention → auto-subscribe → terminate release', async () => {
    const mount = mountStub()
    const root = rootExec('root')
    const child = childExec('child', 'root')
    await tool(mount, 'blackboard_write').execute({ key: 'k', entryType: 'map', summary: 'f', content: 'c' }, root)
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
    await tool(mount, 'blackboard_write').execute({ key: 'k', entryType: 'map', summary: 'f', content: 'c' }, root)
    await tool(mount, 'blackboard_apply').execute({ key: 'k' }, child)
    await expect(async () => tool(mount, 'blackboard_write').execute({ key: 'k', entryType: 'map', summary: 'f', content: 'c' }, root)).rejects.toThrow(/not held by this session.*held by another agent/)
    await expect(async () => tool(mount, 'blackboard_delete').execute({ key: 'k' }, root)).rejects.toThrow(/not held by this session/)
    await expect(async () => tool(mount, 'blackboard_delete').execute({ key: 'ghost' }, root)).rejects.toThrow(/does not exist/)
  })

  it('entryType outside the closed enum and a non-string/blank summary are refused at write time', async () => {
    const mount = mountStub()
    const root = rootExec('root')
    await expect(async () => tool(mount, 'blackboard_write').execute({ key: 'k', entryType: 'banana', summary: 'f', content: 'c' }, root)).rejects.toThrow(/entryType must be one of/)
    await expect(async () => tool(mount, 'blackboard_write').execute({ key: 'k', entryType: 'map', summary: '  ', content: 'c' }, root)).rejects.toThrow(/summary/)
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
    service.write(rootExec('root'), { key: 'k', entryType: 'map', summary: 'f', content: 'c' })
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

describe('agent contracts (design D7) and the remote bridge feed', () => {
  it('registers the orchestrator retrieval section after the orchestrator band and suppresses it for delegated children', () => {
    const mount = mountStub()
    const section = mount.sections.find((entry) => entry.name === 'orchestrator:blackboard')
    expect(section).toBeTruthy()
    expect(section.order).toBe(630)
    expect(section.text).toBe('{{orrery_blackboard}}')
    const provider = mount.variables.get('orrery_blackboard')
    expect(typeof provider).toBe('function')
    // Main agent renders the retrieval discipline; a delegated child renders ''.
    const main = provider({ agent: { session: { header: { delegationDepth: 0 } } } })
    expect(main).toContain('Before delegating')
    expect(main).toContain('blackboard_list')
    expect(main).toMatch(/never instructions/i)
    expect(provider({ agent: { session: { header: { delegationDepth: 1 } } } })).toBe('')
  })

  it('registers the worker write-contract section and gates it: children with the tools get it, others do not', () => {
    const mount = mountStub()
    const section = mount.sections.find((entry) => entry.name === 'worker:blackboard')
    expect(section).toBeTruthy()
    expect(section.order).toBe(400)
    expect(section.text).toBe('{{orrery_blackboard_worker}}')
    const provider = mount.variables.get('orrery_blackboard_worker')
    expect(typeof provider).toBe('function')
    // A delegated child whose tool view admits blackboard_write gets the contract.
    const childText = provider({ agent: { id: 'c', session: { header: { delegationDepth: 1 } } } })
    expect(childText).toContain('Session blackboard (write contract)')
    expect(childText).toMatch(/Search before create/)
    // The main agent never sees the write contract.
    expect(provider({ agent: { id: 'root', session: { header: { delegationDepth: 0 } } } })).toBe('')
    // An allow-listed child without blackboard_write sees nothing either.
    const curated = mountStub({ toolsView: () => ({ visible: new Set(['bash', 'read']) }) })
    const curatedProvider = curated.variables.get('orrery_blackboard_worker')
    expect(curatedProvider({ agent: { id: 'c', session: { header: { delegationDepth: 1 } } } })).toBe('')
    // An unqueryable tools view fails closed to no contract (never a lie about tools).
    const blind = mountStub({ toolsView: () => undefined })
    expect(blind.variables.get('orrery_blackboard_worker')({ agent: { id: 'c', session: { header: { delegationDepth: 1 } } } })).toBe('')
  })

  it('feeds the remote bridge on mount and clears it on dispose', async () => {
    const { blackboardRemoteBridge } = await import('../../src/blackboard/remote.js')
    const mount = mountStub()
    const faces = blackboardRemoteBridge()
    expect(faces).toBeTruthy()
    expect(typeof faces.kernel.list).toBe('function')
    expect(typeof faces.boardOf).toBe('function')
    expect(typeof faces.ttlMs).toBe('function')
    expect(typeof faces.requestPromotion).toBe('function')
    expect(faces.boardOf(rootExec('root').agent)).toBe('root')
    mount.dispose()
    expect(blackboardRemoteBridge()).toBeNull()
  })

  it('the bridge requestPromotion face delivers the brief to the root agent, deferred and producer-tagged', async () => {
    const { blackboardRemoteBridge } = await import('../../src/blackboard/remote.js')
    const mount = mountStub()
    const delivered = []
    const root = { id: 'root', session: { id: 'root', header: { delegationDepth: 0 } }, status: 'idle', steer: (/** @type {any} */ m) => { delivered.push(m) }, followup: (/** @type {any} */ m) => { delivered.push(m) } }
    const faces = blackboardRemoteBridge()
    const request = faces.requestPromotion(root)
    expect(request).toEqual({ requested: true, channel: 'followup' })
    expect(delivered).toHaveLength(0)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(delivered).toHaveLength(1)
    expect(delivered[0].role).toBe('user')
    expect(delivered[0].source.kind).toBe('orrery-blackboard-promotion')
    expect(delivered[0].content[0].text.startsWith('Blackboard promotion request')).toBe(true)
    mount.dispose()
  })
})
