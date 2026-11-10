// P1 routing and conservative pre-semantic exclusion. No Auto route exists.
import { realpathSync } from 'node:fs'
import { resolveRootSession } from './store/profiles.js'
import { DecisionContractError } from './contracts.js'

const AUTHORITY_TEXT = /\b(?:approve|approval|delete|remove|publish|deploy|merge|release|execute|run\s+(?:this\s+)?command|modify\s+(?:this\s+)?file|force\s*push|drop\s+table|send\s+(?:this\s+)?externally|grant\s+(?:access|permission)|irreversible|credential|secret)\b|删除|发布|部署|合并|执行命令|运行命令|修改文件|提权|外发|不可逆/i
const EXECUTION_TEXT = /\b(?:edit|change|write|modify|update|patch|replace)\b[\s\S]{0,120}?\b(?:file|code|config(?:uration)?|script|source|workspace|repo(?:sitory)?|[\w.-]+\.(?:cjs|mjs|js|jsx|ts|tsx|json|md|ya?ml|py|rs|go|sh))\b|\b(?:rm|rmdir|del|erase|chmod|chown|sudo)\s+|\bgit\s+(?:reset|clean|checkout|restore)\b|\b(?:npm|pnpm|yarn)\s+(?:run|exec|install|remove|uninstall|publish)\b|编辑文件|更改文件|写入文件|删除文件/i
/** @param {any} request */
export function excludedRequest(request) {
  return (request.questions ?? []).some(question => {
    if (['approval', 'plan-review'].includes(question.intent?.kind)) return true
    if (['D', 'E', 'F'].includes(question.authorizationClass)) return true
    const text = `${question.header ?? ''} ${question.question ?? ''} ${question.detail ?? ''}`
    return AUTHORITY_TEXT.test(text) || EXECUTION_TEXT.test(text)
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
  if (callId === undefined || request.agent === undefined) return false
  if (request.agent?.id !== originSessionId) return true
  const sessionQuery = ctx?.sessionQuery ?? ctx?.get?.('sessionQuery')
  if (!sessionQuery) return true
  if (typeof callId !== 'string' || !callId || typeof sessionQuery.readSession !== 'function') return true

  let snapshot
  try { snapshot = await sessionQuery.readSession(originSessionId) } catch { return true }
  if (snapshot?.session?.id !== originSessionId || !Array.isArray(snapshot.events)) return true
  const matches = snapshot.events.filter(event => event?.type === 'tool/call' && event.data?.callId === callId)
  if (matches.length !== 1 || matches[0].data?.name !== 'ask_user_question' || typeof matches[0].data.arguments !== 'string') return true

  let raw
  try { raw = JSON.parse(matches[0].data.arguments)?.questions } catch { return true }
  const live = request.questions
  if (!Array.isArray(raw) || !Array.isArray(live) || raw.length !== live.length) return true
  const ids = new Set()
  for (let index = 0; index < raw.length; index++) {
    const question = raw[index]
    if (typeof question?.id !== 'string' || !question.id || ids.has(question.id)
      || question.id !== live[index]?.id || question.question !== live[index]?.question) return true
    ids.add(question.id)
  }
  return excludedRequest({ questions: raw })
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
