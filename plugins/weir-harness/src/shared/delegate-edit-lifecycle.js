// Same-instance bridge: trusted supervision actions, never message provenance.
// Each Edit Lock mount claims only its own parent composition. No host service
// or persisted/custom session event is introduced.
const mounts = new Set()

export function registerDelegateEditLifecycle(mount) {
  mounts.add(mount)
  return () => mounts.delete(mount)
}

export async function withSupervisedEditResume(parent, childId, deliver) {
  const cleanups = []
  let delivered = false
  try {
    for (const mount of mounts) {
      if (mount.owns(parent)) cleanups.push(await mount.resume(childId))
    }
    const result = await deliver()
    delivered = true
    return result
  } finally {
    // Await rollback before reporting a failed delivery to the coordinator.
    const outcomes = await Promise.allSettled(cleanups.map(cleanup => cleanup?.(delivered)))
    const failed = outcomes.find(outcome => outcome.status === 'rejected')
    if (failed?.status === 'rejected') throw failed.reason
  }
}

// Joining is not a request to destroy a running agent. Mounts resolve only
// after a runtime quiescence event and the ordinary disposition acknowledgement.
// The optional exact handle pins a one-shot waiter to its incarnation.
export async function settleDelegateEditLifecycle(parent, childId, agent) {
  for (const mount of mounts) {
    if (mount.owns(parent)) await mount.settle(childId, agent)
  }
}
