import { AUDIT_TYPES } from '../shared/audit.js'

const COMMITTED_SESSION_EVENT = ['session', 'event'].join('/')

export function mountToolUsageObservability({ ctx, audit }) {
  let active = true
  const emit = (session, kind, data) => {
    try { audit(session, `${AUDIT_TYPES.toolUsage}/${kind}`, data) } catch { /* audit never affects runtime behavior */ }
  }
  const offRequest = ctx.on(COMMITTED_SESSION_EVENT, (session, event) => {
    if (!active || event?.type !== 'request/header') return
    try {
      const header = event.data?.header
      if (!Array.isArray(header?.tools)) return
      let schemaBytes = 0
      let deferredCount = 0
      let deferredSchemaBytes = 0
      for (const schema of header.tools) {
        const serialized = JSON.stringify(schema)
        if (typeof serialized !== 'string') return
        const bytes = Buffer.byteLength(serialized)
        schemaBytes += bytes
        if (schema?.deferLoading === true) {
          deferredCount += 1
          deferredSchemaBytes += bytes
        }
      }
      const config = header.config
      emit(session, 'request', {
        ...(Number.isSafeInteger(event.seq) ? { seq: event.seq } : {}),
        ...(typeof config?.provider === 'string' ? { provider: config.provider } : {}),
        ...(typeof config?.model === 'string' ? { model: config.model } : {}),
        schemaCount: header.tools.length,
        deferredCount,
        schemaBytes,
        deferredSchemaBytes,
      })
    } catch { /* malformed observations never affect the committed request */ }
  })
  const offResult = ctx.on('tools/result', (exec, result) => {
    if (!active || typeof exec?.name !== 'string') return
    try {
      const agent = exec.agent
      const session = agent?.session ?? (typeof agent?.id === 'string' ? { id: agent.id } : null)
      const code = result?.error?.info?.code
      emit(session, 'result', {
        name: exec.name,
        isError: result?.isError === true,
        ...(typeof code === 'string' ? { code } : {}),
        ...(typeof exec.callId === 'string' ? { callId: exec.callId } : {}),
      })
    } catch { /* observation never changes the frozen tool outcome */ }
  })
  return () => {
    if (!active) return
    active = false
    try { offRequest?.() } catch { /* observation teardown is best-effort */ }
    try { offResult?.() } catch { /* observation teardown is best-effort */ }
  }
}
