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
