/** Tool service for exactly one authenticated child channel. No local fs
 * capability and no fallback. Parent must bind the other end before admission.
 * @param {ReturnType<typeof import('./peer-client.js').createEditLockPeerClient>} client
 * @param {object} agent
 * @param {(agent:object)=>boolean} isRegisteredAgent */
export function createRemoteEditLockService(client, agent, isRegisteredAgent) {
  let closed = false
  /** @param {{agent:object,callId:string,signal:AbortSignal}} exec */
  function authorize(exec) {
    if (closed || exec.agent !== agent || !isRegisteredAgent(agent)) throw new Error('agent has no authenticated remote edit execution')
  }
  return Object.freeze({
    service:Object.freeze({
      /** @param {{agent:object,callId:string,signal:AbortSignal}} exec @param {unknown} request */
      async publish(exec,request) {
        authorize(exec)
        return client.request('publish',exec.callId,request,exec.signal)
      },
      /** @param {{agent:object,callId:string,signal:AbortSignal}} exec @param {unknown} request */
      async publishBatch(exec,request) {
        authorize(exec)
        return client.request('batch',exec.callId,request,exec.signal)
      },
    }),
    // This only closes local admission; durable stop is acknowledged by parent.
    close() {closed = true; client.close()},
  })
}
