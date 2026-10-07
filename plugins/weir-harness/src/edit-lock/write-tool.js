import { probeEscalation, resolveCallPolicy } from '../hashline-edit/sandbox.js'
import { diffResult } from '../hashline-edit/diff.js'

/** Build only; the lifecycle mount must hide the inherited stock definition
 * before registering this tool. Never falls back to local mutation.
 * @param {any} ctx @param {{publish: (exec: any, request: any) => Promise<any>}} host
 * @param {any} sandboxPolicy */
export function createManagedWriteTool(ctx, host, sandboxPolicy) {
  const escalation = probeEscalation(ctx.fs)
  return {
    name: 'write',
    description: 'Create or fully replace a UTF-8 text file through Edit Lock. Read an existing file before overwriting it.',
    parameters: { type: 'object', properties: {
      file_path: { type: 'string', description: 'Path to write, resolved by the filesystem backend.' },
      content: { type: 'string', description: 'Full UTF-8 text content to write.' },
      ...(escalation?.fields ?? {}),
    }, required: ['file_path', 'content'] },
    output: {
      schema: { type: 'object' },
      render: (/** @type {any} */ _args, /** @type {any} */ value) => [{ type: 'text', text: `${value.operation === 'create' ? 'Created' : 'Updated'} file: ${value.path}` }],
      presentationMeta: (/** @type {any} */ _args, /** @type {any} */ value) => ({ diffs: value.fragments }),
    },
    async execute(/** @type {any} */ args, /** @type {any} */ exec) {
      if (typeof args.file_path !== 'string' || !args.file_path.trim() || typeof args.content !== 'string') throw new Error('write requires file_path and content strings')
      const { policy, resolveCwd } = await resolveCallPolicy(args, {
        escalation, sandboxPolicy, session: exec.agent?.session, sessionCwd: exec.agent?.session?.header?.cwd,
        approval: { approver: ctx.get?.('approval'), agent: exec.agent, toolName: 'write',
          ...(exec.callId !== undefined ? {callId: exec.callId} : {}), ...(exec.signal ? {signal: exec.signal} : {}) },
      })
      if (!resolveCwd || !policy) throw new Error('managed write requires trusted cwd and effective policy')
      const target = await ctx.fs.resolve(args.file_path, {cwd: resolveCwd})
      // Keep the stock observation policy's exact guard; do not stat a fresh
      // version and thereby silently authorize an unread overwrite.
      const intent = await ctx.waterfall('fs/write-intent', target, exec, () => undefined)
      if (!intent || !['createIfAbsent', 'replaceIfVersion'].includes(intent.kind)) throw new Error('managed write requires an explicit observation guard')
      const before = intent.kind === 'replaceIfVersion' ? await ctx.fs.readText(target, exec.signal) : null
      const outcome = await host.publish(exec, {tool: 'write', filePath: args.file_path, args, content: args.content,
        expected: intent, cwd: resolveCwd, effectivePolicy: policy})
      if (!outcome || !('version' in outcome)) throw new Error('write publication not acknowledged')
      ctx.emit('fs/observed', target, {kind: 'present', version: outcome.version}, exec)
      const fragments = before === null ? [] : diffResult(target.displayPath, before, args.content).fragments
      return {path: target.displayPath, operation: outcome.kind === 'created' ? 'create' : 'update', before, after: args.content, fragments}
    },
  }
}
