// P1 routing and conservative pre-semantic exclusion. No Auto route exists.
import { realpathSync } from 'node:fs'
import { isDeepStrictEqual } from 'node:util'
import { resolveRootSession } from './store/profiles.js'
import { DecisionContractError } from './contracts.js'

const AUTHORITY_TEXT = /\b(?:approve|approval|delete|remove|publish|deploy|merge|release|execute|run\s+(?:this\s+)?command|modify\s+(?:this\s+)?file|force\s*push|drop\s+table|send\s+(?:this\s+)?externally|grant\s+(?:access|permission)|irreversible|credential|secret)\b|删除|发布|部署|合并|执行命令|运行命令|修改文件|提权|外发|不可逆/i
const EXECUTION_TEXT = /\b(?:edit|change|write|modify|update|patch|replace)\b[\s\S]{0,120}?\b(?:file|code|config(?:uration)?|script|source|workspace|repo(?:sitory)?|[\w.-]+\.(?:cjs|mjs|js|jsx|ts|tsx|json|md|ya?ml|py|rs|go|sh))\b|\b(?:rm|rmdir|del|erase|chmod|chown|sudo)\s+|\bgit\s+(?:reset|clean|checkout|restore)\b|\b(?:npm|pnpm|yarn)\s+(?:run|exec|install|remove|uninstall|publish)\b|编辑文件|更改文件|写入文件|删除文件/i
/** @param {any} request */
export function excludedRequest(request) {
  return (request.questions ?? []).some(question => {
    if (['approval', 'plan-review'].includes(question.intent?.kind)) return true
    const text = `${question.header ?? ''} ${question.question ?? ''} ${question.detail ?? ''}`
    return AUTHORITY_TEXT.test(text) || EXECUTION_TEXT.test(text)
  })
}

/**
 * Read authority evidence from one persisted stock call. Legacy recovery also
 * compares every field projected into the normalized Host request.
 * @param {any} event @param {any} live @param {boolean} exactProjection
 */
function rawStockQuestions(event, live, exactProjection = false) {
  if (event?.data?.name !== 'ask_user_question' || typeof event.data.arguments !== 'string') return undefined
  let raw
  try { raw = JSON.parse(event.data.arguments)?.questions } catch { return undefined }
  if (!Array.isArray(raw) || !Array.isArray(live) || raw.length !== live.length) return undefined
  const ids = new Set()
  for (let index = 0; index < raw.length; index++) {
    const question = raw[index]
    const current = live[index]
    if (typeof question?.id !== 'string' || !question.id || ids.has(question.id)
      || question.id !== current?.id || question.question !== current?.question) return undefined
    if (exactProjection && (!isDeepStrictEqual(question.options, current?.options)
      || question.header !== current?.header || question.multi_select !== current?.multiSelect)) return undefined
    ids.add(question.id)
  }
  return raw
}

/** @param {any[]} events @param {number} callIndex */
function settledStockCall(events, callIndex) {
  const call = events[callIndex]
  return events.slice(callIndex + 1).some(event => {
    if (event?.type !== 'tool/result') return false
    const message = event.data?.message
    return (typeof call.seq === 'number' && event.sourceEventSeqs?.includes(call.seq))
      || message?.toolCallId === call.data.callId || message?.source?.callId === call.data.callId
  })
}

/**
 * Recheck native authority from the exact persisted stock tool call. Raw
 * arguments are evidence only: never return them into routing or persistence.
 * Host stock calls with unusable current evidence fail closed; direct Broker
 * callers without the Host-owned request.agent retain their legacy contract.
 * @param {any} request @param {string} originSessionId @param {any} ctx
 */
export async function excludedStockHookRequest(request, originSessionId, ctx) {
  if (excludedRequest(request)) return true
  const callId = request.wait?.callId
  if (request.agent === undefined) return false
  if (request.agent?.id !== originSessionId) return true
  const sessionQuery = ctx?.sessionQuery ?? ctx?.get?.('sessionQuery')
  if (!sessionQuery) return true
  if ((callId !== undefined && (typeof callId !== 'string' || !callId)) || typeof sessionQuery.readSession !== 'function') return true

  let snapshot
  try { snapshot = await sessionQuery.readSession(originSessionId) } catch { return true }
  if (snapshot?.session?.id !== originSessionId || !Array.isArray(snapshot.events)) return true
  if (callId !== undefined) {
    const matches = snapshot.events.filter(event => event?.type === 'tool/call' && event.data?.callId === callId)
    if (matches.length !== 1) return true
    const raw = rawStockQuestions(matches[0], request.questions)
    return raw ? excludedRequest({ questions: raw }) : true
  }

  const live = request.questions
  if (!Array.isArray(live) || live.length === 0) return true
  const calls = snapshot.events.map((event, index) => ({ event, index })).filter(call => call.event?.type === 'tool/call')
  const current = calls.at(-1)
  if (!current || current.event.data?.name !== 'ask_user_question'
    || typeof current.event.data?.callId !== 'string' || !current.event.data.callId) return true
  const candidates = []
  for (const call of calls) {
    const raw = rawStockQuestions(call.event, live, true)
    if (raw && !settledStockCall(snapshot.events, call.index)) candidates.push({ call, raw })
  }
  if (candidates.length !== 1 || candidates[0].call !== current) return true
  return excludedRequest({ questions: candidates[0].raw })
}

/** @param {any} agent @param {any} ctx */
export async function decisionOrigin(agent, ctx) {
  const header = agent?.session?.header
  const originSessionId = header?.id ?? agent?.session?.id ?? agent?.id
  if (typeof originSessionId !== 'string' || !originSessionId) throw new DecisionContractError('ORIGIN_UNAVAILABLE', 'agent session id is required')
  const originKind = (header?.delegationDepth ?? 0) >= 1 ? 'delegated' : 'root'
  const rootSessionId = originKind === 'root'
    ? originSessionId
    : await resolveRootSession(originSessionId, ctx?.sessionQuery)
  const cwd = header?.cwd ?? agent?.session?.cwd
  if (typeof cwd !== 'string' || !cwd) throw new DecisionContractError('WORKSPACE_UNAVAILABLE', 'session cwd is required')
  return { originSessionId, originKind, rootSessionId, workspaceKey: realpathSync(cwd) }
}

/** @param {any} agent */
export function sessionModelRoute(agent) {
  const route = agent?.session?.requestContext?.()
  return route ? { provider: route.provider, model: route.model, reasoningEffort: route.reasoningEffort } : undefined
}
