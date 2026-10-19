import { describe, expect, it } from './helpers.js'
import { createLspTools } from '../src/lsp/tools.js'
import { isLeaseConflict } from '../src/file-lease/client.js'

// `lsp_rename` under the file lease (edit-lock-rebuild 3C step 1): the whole
// preflighted target set is claimed in ONE `withLeases(owner, paths, scope, fn)`
// call before the first byte, and a failure reports the three-way truth —
// written / provably not written / unprovable — without ever claiming a
// rollback.
//
// The classification is the contract worth pinning (design D12): only a refused
// claim, the version guard and a sandbox denial PROVE that no byte landed; any
// other error leaves the remaining targets uncertain. Reporting an I/O failure as
// "not written" would be a lie the model would act on.
//
// Everything runs on a fake manager, a fake client and an in-memory fs: no
// language server, no socket, no daemon.

const CWD = '/ws'
const A = `${CWD}/a.ts`
const B = `${CWD}/b.ts`
const C = `${CWD}/c.ts`

/** @param {number} sl @param {number} sc @param {number} el @param {number} ec @param {string} newText */
function edit(sl, sc, el, ec, newText) {
  return { range: { start: { line: sl, character: sc }, end: { line: el, character: ec } }, newText }
}

/** A real conflict: another lineage holds one path of the batch. */
function conflictError(paths) {
  const error = /** @type {any} */ (new Error('lease broker refused acquire: held'))
  error.code = 'held'
  error.conflicts = paths.map((path) => ({ path, owner: { session: 'other-session', label: 'reviewer' } }))
  return error
}

/**
 * The fake lease client: one recorded batch, and the callback runs exactly the
 * way the real client runs it (acquire first, then the callback). `conflict`
 * refuses BEFORE the callback, like a real refused batch claim.
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
 * An in-memory fs with the surface lsp_rename uses. `failOn` maps a display
 * path to the error its writeText throws, so a mid-batch failure is injected
 * deterministically.
 * @param {Record<string, { text: string, version: string }>} files
 * @param {{ failOn?: Record<string, any> }} [options]
 */
function createFs(files, options = {}) {
  /** @type {string[]} */
  const writes = []
  const fs = {
    writes,
    async resolve(path) {
      return { displayPath: path, processPath: path }
    },
    async stat(target) {
      const entry = files[target.displayPath]
      return entry === undefined ? undefined : { type: 'file', version: entry.version, size: Buffer.byteLength(entry.text, 'utf8') }
    },
    async readText(target) {
      return files[target.displayPath].text
    },
    async readByteRange(target, range) {
      return Buffer.from(files[target.displayPath].text, 'utf8').subarray(range.offset, range.offset + range.length)
    },
    async writeText(target, content, expected) {
      const injected = options.failOn?.[target.displayPath]
      if (injected !== undefined) throw injected
      const entry = files[target.displayPath]
      if (entry === undefined) throw new Error(`cannot write "${target.displayPath}": not found`)
      if (expected?.kind === 'replaceIfVersion' && entry.version !== expected.version) {
        throw new Error(`cannot write "${target.displayPath}": file changed since it was read (FS_STALE_VERSION)`)
      }
      writes.push(target.displayPath)
      files[target.displayPath] = { text: content, version: `${entry.version}+w` }
      return { version: files[target.displayPath].version }
    },
  }
  return fs
}

/**
 * A ctx with the fs, the per-call sandbox policy seam and nothing else.
 * @param {any} fs
 */
function createCtx(fs) {
  return {
    fs,
    get: () => undefined,
    inject(deps, callback) {
      if (deps[0] === 'sandboxPolicy') callback({ sandboxPolicy: { resolve: () => ({ mode: 'workspace-write', workspaceRoot: CWD }) } })
    },
  }
}

/** The named-operations manager stand-in: capabilities + the rename request. */
function createManager(changes) {
  return {
    async capabilitiesOf() {
      return { renameProvider: true }
    },
    async requestOn() {
      return { changes }
    },
  }
}

const AGENT = {
  id: 'agent-1',
  session: { id: 'sess-a', header: { id: 'sess-a', cwd: CWD, delegationDepth: 0, title: 'Orchestrator' } },
}
const OWNER = { id: 'sess-a', session: 'sess-a', label: 'Orchestrator' }

/**
 * Mount the tools for one agent and hand back the rename definition.
 * @param {{ files?: Record<string, { text: string, version: string }>, changes: any, failOn?: Record<string, any>, conflict?: any }} options
 */
function mount(options) {
  const files = options.files ?? {
    [A]: { text: 'const alphaFn = () => 1\n', version: 'v1' },
    [B]: { text: 'import { alphaFn } from "./a"\n', version: 'v9' },
  }
  const fs = createFs(files, { failOn: options.failOn })
  const client = options.client ?? createFakeClient({ conflict: options.conflict })
  const tools = createLspTools({ manager: createManager(options.changes), ctx: createCtx(fs), agent: AGENT, leaseClient: client })
  const rename = tools.find((tool) => tool.name === 'lsp_rename')
  return { files, fs, client, rename, exec: { agent: AGENT, callId: 'rename-1', signal: new AbortController().signal } }
}

/** The two-file rename every case below starts from. */
const TWO_FILE_CHANGES = {
  'file:///ws/a.ts': [edit(0, 6, 0, 13, 'betaFn')],
  'file:///ws/b.ts': [edit(0, 9, 0, 16, 'betaFn')],
}

/** @param {any} agent @returns {Promise<any>} the thrown error, or a failure marker */
async function failureOf(run) {
  try {
    await run()
  } catch (error) {
    return error
  }
  return { message: '<no error thrown>' }
}

describe('lsp_rename claims the batch once, before any write', () => {
  it('wraps the sequential write pass in one withLeases over every preflighted target', async () => {
    const { client, rename, fs, exec, files } = mount({ changes: TWO_FILE_CHANGES })
    const result = await rename.execute({ file_path: A, line: 1, character: 7, new_name: 'betaFn' }, exec)

    expect(client.calls).toHaveLength(1)
    expect(client.calls[0].owner).toEqual(OWNER)
    expect(client.calls[0].paths).toEqual([A, B])
    expect(client.calls[0].scope).toBe(CWD)
    // Sequential, version-guarded writes inside the one claim.
    expect(fs.writes).toEqual([A, B])
    expect(files[A].text).toBe('const betaFn = () => 1\n')
    expect(files[B].text).toBe('import { betaFn } from "./a"\n')
    expect(result.text).toContain('renamed: 2 edit(s) across 2 file(s)')
  })

  it('claims the complete preflighted set, including a target whose edits are a no-op', async () => {
    const files = {
      [A]: { text: 'const alphaFn = () => 1\n', version: 'v1' },
      [B]: { text: 'import { alphaFn } from "./a"\n', version: 'v9' },
      // Identity edit: byte-identical synthesis, so c.ts is never written but IS
      // part of the rename the arbiter must arbitrate.
      [C]: { text: 'const untouched = 1\n', version: 'v3' },
    }
    const changes = { ...TWO_FILE_CHANGES, 'file:///ws/c.ts': [edit(0, 6, 0, 15, 'untouched')] }
    const { client, rename, fs, exec } = mount({ changes, files })
    await rename.execute({ file_path: A, line: 1, character: 7, new_name: 'betaFn' }, exec)

    expect(client.calls[0].paths).toEqual([A, B, C])
    expect(fs.writes).toEqual([A, B])
  })

  it('claims nothing and writes nothing for a no-op rename', async () => {
    const changes = { 'file:///ws/a.ts': [edit(0, 6, 0, 13, 'alphaFn')] }
    const { client, rename, fs, exec } = mount({ changes })
    const result = await rename.execute({ file_path: A, line: 1, character: 7, new_name: 'alphaFn' }, exec)

    expect(result.text).toContain('no-op')
    expect(client.calls).toEqual([])
    expect(fs.writes).toEqual([])
  })

  it('keeps phase 1 preflight free of claims and writes', async () => {
    const changes = {
      ...TWO_FILE_CHANGES,
      'file:///ws/absent.ts': [edit(0, 0, 0, 7, 'betaFn')],
    }
    const { client, rename, fs, exec } = mount({ changes })
    const failure = await failureOf(() => rename.execute({ file_path: A, line: 1, character: 7, new_name: 'betaFn' }, exec))

    expect(failure.message).toContain('no regular file at /ws/absent.ts')
    expect(failure.message).toContain('no files were written')
    expect(client.calls).toEqual([])
    expect(fs.writes).toEqual([])
  })
})

describe('lsp_rename reports the three-way truth on failure', () => {
  it('refuses a conflicting batch with zero writes and an empty written/uncertain pair', async () => {
    const conflict = conflictError([B])
    expect(isLeaseConflict(conflict)).toBe(true)
    const { client, rename, fs, exec } = mount({ changes: TWO_FILE_CHANGES, conflict })
    const failure = await failureOf(() => rename.execute({ file_path: A, line: 1, character: 7, new_name: 'betaFn' }, exec))

    expect(fs.writes).toEqual([])
    expect(client.calls).toHaveLength(1)
    expect(failure.cause).toBe(conflict)
    expect(failure.message.split('\n')).toEqual([
      'lsp_rename: the rename was refused before any write: lease broker refused acquire: held',
      'filesAlreadyWritten: [];',
      'filesNotWritten: ["/ws/a.ts", "/ws/b.ts"];',
      'filesUncertain: [];',
      'no claim was taken for this batch (no rollback)',
    ])
    expect(failure.message).toContain('no rollback')
  })

  it('classifies a mid-batch stale version as provably not written and keeps the claim', async () => {
    const stale = Object.assign(
      new Error(`cannot write "${B}": file changed since it was read (FS_STALE_VERSION)`),
      { code: 'FS_STALE_VERSION' },
    )
    const { rename, exec, files } = mount({ changes: TWO_FILE_CHANGES, failOn: { [B]: stale } })
    const failure = await failureOf(() => rename.execute({ file_path: A, line: 1, character: 7, new_name: 'betaFn' }, exec))

    expect(failure.message.split('\n')).toEqual([
      `lsp_rename: write failed for "/ws/b.ts": cannot write "${B}": file changed since it was read (FS_STALE_VERSION)`,
      'filesAlreadyWritten: ["/ws/a.ts"];',
      'filesNotWritten: ["/ws/b.ts"];',
      'filesUncertain: [];',
      'ownership retained (no rollback)',
    ])
    // a.ts carries the rename, b.ts kept its bytes, nothing was rolled back.
    expect(files[A].text).toBe('const betaFn = () => 1\n')
    expect(files[B].text).toBe('import { alphaFn } from "./a"\n')
  })

  it('classifies a mid-batch sandbox denial as provably not written', async () => {
    const denied = Object.assign(
      new Error(`[sandbox: file access denied under workspace-write mode]`),
      { code: 'FS_SANDBOX_DENIED' },
    )
    const { rename, exec, files } = mount({ changes: TWO_FILE_CHANGES, failOn: { [B]: denied } })
    const failure = await failureOf(() => rename.execute({ file_path: A, line: 1, character: 7, new_name: 'betaFn' }, exec))

    expect(failure.message).toContain('filesAlreadyWritten: ["/ws/a.ts"];')
    expect(failure.message).toContain('filesNotWritten: ["/ws/b.ts"];')
    expect(failure.message).toContain('filesUncertain: [];')
    expect(files[A].text).toBe('const betaFn = () => 1\n')
    expect(files[B].text).toBe('import { alphaFn } from "./a"\n')
  })

  it('classifies an unknown mid-batch error as uncertain — never as not written', async () => {
    const boom = new Error('EIO: i/o error, write')
    const { rename, exec, files } = mount({ changes: TWO_FILE_CHANGES, failOn: { [B]: boom } })
    const failure = await failureOf(() => rename.execute({ file_path: A, line: 1, character: 7, new_name: 'betaFn' }, exec))

    expect(failure.message.split('\n')).toEqual([
      'lsp_rename: write failed for "/ws/b.ts": EIO: i/o error, write',
      'filesAlreadyWritten: ["/ws/a.ts"];',
      'filesNotWritten: [];',
      'filesUncertain: ["/ws/b.ts"];',
      'ownership retained (no rollback)',
    ])
    expect(files[A].text).toBe('const betaFn = () => 1\n')
    // b.ts is NOT claimed intact — the failure might have landed bytes.
    expect(files[B].text).toBe('import { alphaFn } from "./a"\n')
  })

  it('lists every remaining target as uncertain when the unknown error hits the first file', async () => {
    const files = {
      [A]: { text: 'const alphaFn = () => 1\n', version: 'v1' },
      [B]: { text: 'import { alphaFn } from "./a"\n', version: 'v9' },
      [C]: { text: 'export const useIt = alphaFn + 1\n', version: 'v4' },
    }
    const changes = {
      ...TWO_FILE_CHANGES,
      'file:///ws/c.ts': [edit(0, 20, 0, 27, 'betaFn')],
    }
    const boom = new Error('EPIPE: broken pipe')
    const { rename, exec } = mount({ changes, files, failOn: { [A]: boom } })
    const failure = await failureOf(() => rename.execute({ file_path: A, line: 1, character: 7, new_name: 'betaFn' }, exec))

    expect(failure.message).toContain('filesAlreadyWritten: [];')
    expect(failure.message).toContain('filesNotWritten: [];')
    expect(failure.message).toContain('filesUncertain: ["/ws/a.ts", "/ws/b.ts", "/ws/c.ts"];')
    expect(failure.message).toContain('no rollback')
  })

  it('never claims a rollback and always names all three lists', async () => {
    const boom = new Error('EIO: i/o error, write')
    const { rename, exec } = mount({ changes: TWO_FILE_CHANGES, failOn: { [B]: boom } })
    const failure = await failureOf(() => rename.execute({ file_path: A, line: 1, character: 7, new_name: 'betaFn' }, exec))

    for (const label of ['filesAlreadyWritten', 'filesNotWritten', 'filesUncertain']) {
      expect(failure.message).toContain(`${label}: [`)
    }
    expect(failure.message).toContain('no rollback')
    expect(failure.message.toLowerCase()).not.toContain('rolled back')
    expect(failure.message.toLowerCase()).not.toContain('reverted')
  })
})
