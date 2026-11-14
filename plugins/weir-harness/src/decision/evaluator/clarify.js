// Clarification sidecar (clarify-contract/1): the user asks about a pending
// Case and the assistant explains using ONLY the case's existing evidence pack.
// Plain-text output — never an answer, a suggestion, or new evidence.
import { DecisionContractError } from '../contracts.js'
import { resolveDecisionModelRoute, streamDecision } from './sidecar.js'

const CLARIFY_SYSTEM = `Clarification contract: clarify-contract/1
The user is deciding a pending question and asked for more context. Answer their QUESTION using ONLY the evidence pack below.

Hard rules:
- Plain text, at most 2000 characters, in the user's language when recognizable.
- Never choose or recommend an option, never answer the pending question itself, never fabricate facts beyond the pack.
- If the pack cannot answer, say plainly what is missing.`

/** @param {string} value @param {number} limit */
function bounded(value, limit) {
  const text = typeof value === 'string' ? value : ''
  return text.length > limit ? text.slice(0, limit) : text
}

/**
 * @param {{llm:any,sessionRoute?:any,timeoutMs:number,maxOutputTokens:number,signal?:AbortSignal,questions:any[],evidence:{excerpt?:string}[],question:string}} input
 * @returns {Promise<{kind:'ok',text:string}|{kind:'failed',reason:string}>}
 */
export async function clarifyCase(input) {
  const question = bounded(input.question, 2000).trim()
  if (!question) throw new DecisionContractError('MISSING_CONTEXT', 'A clarification question is required')
  const pack = {
    system: CLARIFY_SYSTEM,
    messages: [{
      role: 'user',
      content: [
        'PENDING QUESTIONS:',
        ...input.questions.map(item => `- ${bounded(item?.question, 4000)}`),
        '',
        'EVIDENCE PACK:',
        ...(input.evidence.length ? input.evidence.map(item => `- ${bounded(item?.excerpt, 600)}`) : ['(empty)']),
        '',
        `QUESTION: ${question}`,
      ].join('\n'),
    }],
  }
  const route = await resolveDecisionModelRoute({ llm: input.llm, chain: [], sessionRoute: input.sessionRoute })
  const streamed = await streamDecision({
    llm: input.llm, route, pack,
    maxOutputTokens: input.maxOutputTokens, timeoutMs: input.timeoutMs, signal: input.signal,
  })
  if (streamed.finishReason !== 'stop') return { kind: 'failed', reason: streamed.finishReason }
  const text = streamed.text.trim()
  if (!text) return { kind: 'failed', reason: 'invalid_output' }
  if (text.length > 2000) return { kind: 'failed', reason: 'truncated' }
  // Answer-shaped output violates the contract: a JSON blob with answers or
  // claims is an attempted decision, not a clarification.
  if (/^\s*\{/.test(text) && /"(answers|claims|outcome)"/.test(text)) return { kind: 'failed', reason: 'invalid_output' }
  return { kind: 'ok', text }
}
