import { describe, expect, it } from './helpers.js'
import { apply as applyHashline, HASH_EDIT_NAME } from '../src/hashline-edit/index.js'
import { anchorFor } from '../src/hashline-edit/anchors.js'
import { isLeaseConflict } from '../src/file-lease/client.js'
import { getSharedLeaseClient } from '../src/file-lease/singleton.js'

// The three managed editors' lease wiring (edit-lock-rebuild 3C step 1): the
// managed `write` and `hash_edit` must CLAIM the target through
// `client.withLeases(owner, paths, scope, fn)` before any target-side effect,
// and must keep every previously documented behaviour — the stock observation
// guard, the stale-version message, the sandbox denial marker — while a real
// conflict refuses the write with the error passed through untouched.
//
// Everything here runs on a fake client, a fake ctx and an in-memory fs: no
// socket, no daemon, no real host. The fake client is deliberately the WHOLE
// arbiter surface this step uses, `withLeases`, which is what makes the
// assertions about owner/paths/scope exact.

const CWD = '/ws'

/** @param {unknown} error @returns {boolean} */
function isConflict(error) {
  return isLeaseConflict(error)
}

/** A real conflict: the arbiter says another lineage holds the path. */
function conflictError(path = `${CWD}/a.js`) {
  const error = /** @type {any} */ (new Error('lease broker refused acquire: held'))
  error.code = 'held'
  error.conflicts = [{ path, owner: { session: 'other-session', label: 'reviewer' } }]
  return error
}

/**
 * The fake lease client: records every batch and runs the callback exactly the
 * way the real one does (acquire first, then the callback). `conflict` makes the
 * batch refuse BEFORE the callback, which is what a real refused claim does.
 * @param {{ conflict?: any }} [options]
 */
function createFakeClient(options = {}) {
  /** @type {{ owner: any, paths: string[], scope: string }[]} */
  const calls = []
  return {
    calls,
    async withLeases(owner, paths, scope, fn) {
      calls.push({ owner, paths: [...paths], scope })
      if (options.conflict !== undefined) throw options.conflict
      return await fn()
    },
  }
}

/**
 * An agent as the runtime hands it to a tool: a session header (identity, cwd,
 * delegation depth) plus an OWN scope whose registration wins over the denied
 * inherited name — the same shape the stock registry has.
 * @param {{ id?: string, depth?: number, parent?: string, title?: string }} [options]
 */
function createAgent(options = {}) {
  const id = options.id ?? 'sess-a'
  /** @type {Map<string, any>} definitions this agent's scope registered */
  const own = new Map()
  /** @type {any[]} restrict() calls, in order */
  const denies = []
  const agent = {
    id,
    own,
    denies,
    status: 'idle',
    session: {
      id,
      header: {
        id,
        cwd: CWD,
        delegationDepth: options.depth ?? 0,
        ...(options.parent !== undefined ? { parentSession: options.parent } : {}),
        ...(options.title !== undefined ? { title: options.title } : {}),
      },
    },
  }
  agent.ctx = {
    tools: {
      restrict(filter) {
        denies.push(filter)
      },
      register(definition) {
        own.set(definition.name, definition)
        return () => {
          own.delete(definition.name)
        }
      },
      get(name) {
        return own.get(name)
      },
    },
  }
  return agent
}

/**
 * A ctx good enough for `apply()` of hashline-edit: a tool registry, the stock
 * `fs/write-intent` waterfall (the observation guard), an in-memory fs whose
 * writeText can be told to fail, the sandbox policy seam and the sessions
 * registry the lineage rule reads.
 */
function createCtx(options = {}) {
  /** @type {Map<string, { text: string, version: string }>} */
  const files = new Map()
  for (const [path, text] of options.files ?? []) files.set(path, { text, version: `v:${text}` })
  /** @type {Set<string>} paths this session has already observed (stock policy) */
  const observed = new Set(options.observed ?? [])
  /** @type {{ target: string, content: string, expected: any, policy: any }[]} */
  const writes = []
  /** @type {{ target: string, observation: any, exec: any }[]} */
  const observedEvents = []
  /** @type {any[]} */
  const registered = []
  /** @type {Record<string, Function>} */
  const listeners = {}
  /** @type {{ deps: string[], callback: Function }[]} */
  const injected = []
  /** @type {Map<string, any>} session id → session handle (lineage walk) */
  const sessions = new Map(options.sessions ?? [])
  const fs = {
    /** @param {string} path */
    resolve: async (path) => ({ displayPath: path, processPath: path, targetKey: path }),
    /** @param {any} target */
    stat: async (target) => {
      const entry = files.get(target.targetKey)
      return entry === undefined ? undefined : { type: 'file', version: entry.version, size: entry.text.length }
    },
    /** @param {any} target */
    readText: async (target) => {
      const entry = files.get(target.targetKey)
      if (entry === undefined) throw new Error(`no such file: ${target.displayPath}`)
      return entry.text
    },
    /**
     * @param {any} target @param {string} content @param {any} expected @param {any} _signal @param {any} policy
     */
    writeText: async (target, content, expected, _signal, policy) => {
      if (options.writeError) throw options.writeError
      const entry = files.get(target.targetKey)
      if (expected?.kind === 'createIfAbsent' && entry !== undefined) throw new Error(`cannot write "${target.displayPath}": already exists (FS_EXISTS)`)
      if (expected?.kind === 'replaceIfVersion') {
        if (entry === undefined) throw new Error(`cannot write "${target.displayPath}": not found (FS_NOT_FOUND)`)
        if (entry.version !== expected.version) {
          throw new Error(`cannot write "${target.displayPath}": file changed since it was read (FS_STALE_VERSION)`)
        }
      }
      writes.push({ target: target.displayPath, content, expected, policy })
      files.set(target.targetKey, { text: content, version: `v:${content}` })
      observed.add(target.targetKey)
      return { version: `v:${content}` }
    },
    ...(options.sandboxMode !== undefined ? { sandboxMode: options.sandboxMode } : {}),
  }
  const ctx = {
    files,
    writes,
    observedEvents,
    registered,
    listeners,
    injected,
    sessions,
    fs,
    tools: {
      register(definition) {
        registered.push(definition)
        return () => registered.splice(registered.indexOf(definition), 1)
      },
      // The effective definition for one agent: `get(name, agent)` resolves
      // against the AGENT's own scope first (own registration beats the denied
      // inherited layer), then the inherited stock layer.
      get(name, scope) {
        const own = scope?.ctx?.tools?.get?.(name)
        if (own !== undefined) return own
        return options.stock?.[name]
      },
    },
    get(name) {
      if (name === 'sessions') return { get: (id) => sessions.get(id) }
      if (name === 'approval') return options.approval
      return undefined
    },
    on(event, handler) {
      listeners[event] = handler
    },
    inject(deps, callback) {
      injected.push({ deps, callback })
      if (deps[0] === 'sandboxPolicy' && options.policy !== null) {
        callback({ sandboxPolicy: { resolve: () => options.policy ?? { mode: 'workspace-write', workspaceRoot: CWD } } })
      }
    },
    // The stock observation policy: a file this session observed hands back its
    // version; an unobserved existing file hands back NOTHING (that is the guard
    // the managed write must not weaken).
    async waterfall(name, target) {
      if (name !== 'fs/write-intent') return undefined
      const entry = files.get(target.targetKey)
      if (entry === undefined) return { kind: 'createIfAbsent' }
      if (!observed.has(target.targetKey)) return undefined
      return { kind: 'replaceIfVersion', version: entry.version }
    },
    emit(event, target, observation) {
      if (event === 'fs/observed') observedEvents.push({ target: target.displayPath, observation })
    },
  }
  return ctx
}

/** A create of a brand-new file through the managed `write`. */
const CREATE_ARGS = { file_path: `${CWD}/new.js`, content: 'const a = 1\n' }

/** One hash_edit that rewrites line 1 of `/ws/a.js`. */
const EDIT_ARGS = { file_path: `${CWD}/a.js`, edits: [{ op: 'replace', pos: anchorFor(1, 'alpha'), text: 'beta' }] }

/** @param {any} agent */
function execFor(agent) {
  return { agent, callId: 'call-1', signal: new AbortController().signal }
}

/**
 * Mount hashline-edit with an injected lease client (the unit-test seam).
 * `hideStockEdit` mounts model a preset composition: the stock `edit`/`write`
 * are inherited from the host layer, which is exactly what the deny list
 * replaces.
 */
const STOCK_EDITORS = { edit: { name: 'edit' }, write: { name: 'write' } }

function mount(options = {}) {
  const ctx = createCtx({ stock: STOCK_EDITORS, ...options })
  const client = options.client ?? createFakeClient()
  applyHashline(ctx, { hideStockEdit: options.hideStockEdit === true, leaseClient: client })
  return { ctx, client, agent: createAgent(options.agent) }
}

describe('managed write claims the path through the file lease', () => {
  it('hides both stock editors and installs the managed write at the agent scope', () => {
    const { ctx, agent } = mount({ files: [[`${CWD}/a.js`, 'alpha']], hideStockEdit: true })
    const stock = STOCK_EDITORS
    const create = ctx.listeners['agent/created']
    expect(typeof create).toBe('function')
    create({ agent })
    // Deny FIRST — the inherited stock editors — then provide our own writer.
    expect(agent.denies).toEqual([{ deny: ['edit', 'write'] }])
    expect([...agent.own.keys()]).toEqual(['write'])
    expect(agent.own.get('write')).not.toBe(stock.write)
    // The agent's effective `write` is the managed definition, not the stock one.
    expect(ctx.tools.get('write', agent)).toBe(agent.own.get('write'))
  })

  it('claims the target with the caller owner, the absolute path and the session scope', async () => {
    const { ctx, client, agent } = mount({ hideStockEdit: true, agent: { title: 'Orchestrator' } })
    ctx.listeners['agent/created']({ agent })
    const write = agent.own.get('write')
    const result = await write.execute(CREATE_ARGS, execFor(agent))

    expect(client.calls).toHaveLength(1)
    expect(client.calls[0].owner).toEqual({ id: 'sess-a', session: 'sess-a', label: 'Orchestrator' })
    expect(client.calls[0].paths).toEqual([`${CWD}/new.js`])
    expect(client.calls[0].scope).toBe(CWD)
    // The write happened INSIDE the callback, once, with the stock guard.
    expect(ctx.writes).toHaveLength(1)
    expect(ctx.writes[0].content).toBe(CREATE_ARGS.content)
    expect(ctx.writes[0].expected.kind).toBe('createIfAbsent')
    expect(ctx.observedEvents).toEqual([{ target: `${CWD}/new.js`, observation: { kind: 'present', version: 'v:const a = 1\n' } }])
    expect(result.operation).toBe('create')
    expect(result.path).toBe(`${CWD}/new.js`)
    expect(result.fragments).toEqual([])
  })

  it('replaces a file the session observed and reports the diff', async () => {
    const { ctx, client, agent } = mount({
      files: [[`${CWD}/a.js`, 'alpha\nbeta\n']],
      observed: [`${CWD}/a.js`],
      hideStockEdit: true,
    })
    ctx.listeners['agent/created']({ agent })
    const args = { file_path: `${CWD}/a.js`, content: 'alpha\nGAMMA\n' }
    const result = await agent.own.get('write').execute(args, execFor(agent))

    expect(client.calls).toHaveLength(1)
    expect(client.calls[0].paths).toEqual([`${CWD}/a.js`])
    expect(ctx.writes[0].expected).toEqual({ kind: 'replaceIfVersion', version: 'v:alpha\nbeta\n' })
    expect(result.operation).toBe('update')
    expect(result.before).toBe('alpha\nbeta\n')
    expect(result.after).toBe('alpha\nGAMMA\n')
    expect(result.fragments[0].oldText).toContain('beta')
    expect(result.fragments[0].newText).toContain('GAMMA')
  })

  it('refuses an unread overwrite before the lease is even asked', async () => {
    const { ctx, client, agent } = mount({ files: [[`${CWD}/a.js`, 'alpha\n']], hideStockEdit: true })
    ctx.listeners['agent/created']({ agent })
    const write = agent.own.get('write')
    const args = { file_path: `${CWD}/a.js`, content: 'overwritten\n' }
    await expect(async () => write.execute(args, execFor(agent))).rejects.toThrow(/explicit observation guard/)
    // The stock guard is what refused: no claim, no write, bytes unchanged.
    expect(client.calls).toEqual([])
    expect(ctx.writes).toEqual([])
    expect(ctx.files.get(`${CWD}/a.js`).text).toBe('alpha\n')
  })

  it('does not install the managed writer when the stock editors are kept', () => {
    const { ctx } = mount({ hideStockEdit: false })
    expect(ctx.listeners['agent/created']).toBeUndefined()
    expect(ctx.registered.map((tool) => tool.name)).toEqual([HASH_EDIT_NAME])
  })
})

describe('hash_edit claims its target through the file lease', () => {
  it('wraps the version-guarded write in one withLeases call', async () => {
    const { ctx, client, agent } = mount({ files: [[`${CWD}/a.js`, 'alpha']], agent: { title: 'Orchestrator' } })
    const hashEdit = ctx.registered.find((tool) => tool.name === HASH_EDIT_NAME)
    const result = await hashEdit.execute(EDIT_ARGS, execFor(agent))

    expect(client.calls).toHaveLength(1)
    expect(client.calls[0].owner).toEqual({ id: 'sess-a', session: 'sess-a', label: 'Orchestrator' })
    expect(client.calls[0].paths).toEqual([`${CWD}/a.js`])
    expect(client.calls[0].scope).toBe(CWD)
    expect(ctx.writes[0].content).toBe('beta')
    expect(ctx.writes[0].expected).toEqual({ kind: 'replaceIfVersion', version: 'v:alpha' })
    expect(result.diff).toContain('-alpha')
    expect(result.diff).toContain('+beta')
    expect(result.version).toBe('v:beta')
  })

  it('gives a delegated child its spawner lineage so the chain never self-conflicts', async () => {
    const parentHeader = { id: 'sess-root', cwd: CWD, delegationDepth: 0 }
    const { ctx, client, agent } = mount({
      files: [[`${CWD}/a.js`, 'alpha']],
      sessions: [['sess-root', { id: 'sess-root', header: parentHeader }]],
      agent: { id: 'sess-child', depth: 1, parent: 'sess-root' },
    })
    const hashEdit = ctx.registered.find((tool) => tool.name === HASH_EDIT_NAME)
    await hashEdit.execute(EDIT_ARGS, execFor(agent))

    // Same owner id as the spawner (no conflict), own session (its turn releases it).
    expect(client.calls[0].owner.id).toBe('sess-root')
    expect(client.calls[0].owner.session).toBe('sess-child')
    expect(ctx.writes).toHaveLength(1)
  })

  it('refuses a conflicting claim with zero writes and passes the error through untouched', async () => {
    const conflict = conflictError(`${CWD}/a.js`)
    expect(isConflict(conflict)).toBe(true)
    const client = createFakeClient({ conflict })
    const { ctx, agent } = mount({ files: [[`${CWD}/a.js`, 'alpha']], client })
    const hashEdit = ctx.registered.find((tool) => tool.name === HASH_EDIT_NAME)

    let failure
    try {
      await hashEdit.execute(EDIT_ARGS, execFor(agent))
    } catch (error) {
      failure = error
    }
    // The arbiter's answer is the tool's answer: same object, same code, no
    // stale-version or sandbox rewrite, and the bytes are untouched.
    expect(failure).toBe(conflict)
    expect(isConflict(failure)).toBe(true)
    expect(ctx.writes).toEqual([])
    expect(ctx.files.get(`${CWD}/a.js`).text).toBe('alpha')
    expect(client.calls).toHaveLength(1)
  })

  it('keeps the stale-version message verbatim', async () => {
    const stale = Object.assign(new Error(`cannot write "${CWD}/a.js": file changed since it was read (FS_STALE_VERSION)`), { code: 'FS_STALE_VERSION' })
    const { ctx, agent } = mount({ files: [[`${CWD}/a.js`, 'alpha']], writeError: stale })
    const hashEdit = ctx.registered.find((tool) => tool.name === HASH_EDIT_NAME)
    let failure
    try {
      await hashEdit.execute(EDIT_ARGS, execFor(agent))
    } catch (error) {
      failure = error
    }
    expect(failure.message).toBe(
      'hash_edit: the file changed on disk between your read and this edit. Re-read it and copy the current anchors before retrying.',
    )
    expect(ctx.files.get(`${CWD}/a.js`).text).toBe('alpha')
  })

  it('keeps the sandbox denial marker and the escalation hint', async () => {
    const denied = Object.assign(new Error('[sandbox: file access denied under workspace-write mode]'), { code: 'FS_SANDBOX_DENIED' })
    const { ctx, agent } = mount({
      files: [[`${CWD}/a.js`, 'alpha']],
      writeError: denied,
      sandboxMode: 'workspace-write',
    })
    const hashEdit = ctx.registered.find((tool) => tool.name === HASH_EDIT_NAME)
    let failure
    try {
      await hashEdit.execute(EDIT_ARGS, execFor(agent))
    } catch (error) {
      failure = error
    }
    expect(failure.message).toContain('[sandbox: file access denied under workspace-write mode]')
    expect(failure.message).toContain('[sandbox: escalation available')
    expect(ctx.files.get(`${CWD}/a.js`).text).toBe('alpha')
  })
})

describe('the process-wide client is one per endpoint and never dials on creation', () => {
  it('returns the same instance for the same endpoint and ignores later overrides', () => {
    const socketPath = `/tmp/weir-lease-singleton-test-${process.pid}.sock`
    /** @type {string[]} */
    const dials = []
    const connect = (path) => {
      dials.push(path)
      throw new Error('this suite must never dial')
    }
    const first = getSharedLeaseClient({ socketPath, connect })
    const second = getSharedLeaseClient({ socketPath, timeoutMs: 5 })
    expect(second).toBe(first)
    // Creation is inert: no socket, no spawn (design D11).
    expect(dials).toEqual([])
    expect(first.endpoint).toBe(socketPath)
  })

  it('keys clients by endpoint instead of sharing one across endpoints', () => {
    const a = getSharedLeaseClient({ socketPath: `/tmp/weir-lease-a-${process.pid}.sock` })
    const b = getSharedLeaseClient({ socketPath: `/tmp/weir-lease-b-${process.pid}.sock` })
    expect(a).not.toBe(b)
    expect(a.endpoint).not.toBe(b.endpoint)
  })
})
