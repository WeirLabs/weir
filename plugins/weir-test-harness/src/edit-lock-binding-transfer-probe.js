// Dev-only probe for the editlock-binding-transfer scenario's negative arm
// (openspec edit-lock-binding-transfer, task 4.3): once the calm transferable
// refusal notice lands in the claimant's inbox, queue ONE runtime-injected
// message (producer source, never 'user'). The notice is delivered from
// setupAgentOnce's catch AFTER bindingFailures.set, so the failure record is
// already standing when the injected message's inbox intake evaluates the
// arming condition — a correct implementation arms nothing for it.
//
// Turn separation is deterministic, not a race: the notice (and this followup)
// land while the adoption's agent/created serial dispatch still runs inside the
// agent factory's maintenance scope, so the followup's wake is latched; the
// injected message drives the boot's FIRST turn alone, and the headless
// runner's whenIdle() awaits that turn before sending the genuine task.
// Armed per boot via WEIR_IT_BINDING_TRANSFER_PROBE=inject.
import { randomUUID } from 'node:crypto'
import { textOf } from './message-text.js'

export function installBindingTransferProbe(ctx, tap) {
  if (process.env.WEIR_IT_BINDING_TRANSFER_PROBE !== 'inject') return
  const scenario = process.env.WEIR_IT_SCENARIO ?? 'editlock-binding-transfer'
  let sent = false
  ctx.on('agent/inbox/inserted', (payload) => {
    if (sent) return
    const agent = payload?.agent
    // The calm transferable notice is the in-band proof that the duplicate
    // binding failure (holderKind 'transferable') is already recorded.
    if (!agent || !textOf(payload?.message).includes('inactive attachment of this same session')) return
    sent = true
    tap({ kind: 'binding-transfer-inject', session: agent.id })
    agent.followup({
      id: randomUUID(),
      role: 'user',
      source: { kind: 'weir-it-binding-transfer-injected' },
      content: [{ type: 'text', text: `${scenario}-injected` }],
    })
  })
}
