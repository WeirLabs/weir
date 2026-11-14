// Dev-only `fileUploads` provider for the blackboard-fork integration scenario.
//
// The real `@deepseek-ai/dsh-api-session-controller` row injects `fileUploads`,
// and the production provider (`@deepseek-ai/dsh-client-file-upload`) injects
// `connection` — a web-only service — so in the headless test profile that row
// stays permanently pending and the Session Controller never activates. This
// stub supplies exactly the four faces the controller uses; the fork path
// (`session/fork`) never touches an upload, so the stubbed calls exist only to
// keep the controller constructible.
//
// Never install into a real profile.
const name = 'weir-it-file-uploads-stub'
const inject = []

function apply(ctx) {
  ctx.reflect.provide('fileUploads', Object.freeze({
    // `Service.init` registers the Agent resolver that maps a wire session id to
    // a live Agent; it only stores the callback and returns a disposer.
    registerAgentResolver() { return () => {} },
    resolve() { throw new Error('file uploads are unavailable in the IT stub') },
    bindPrompt() { throw new Error('file uploads are unavailable in the IT stub') },
    retirePrompt() {},
  }))
}

export { name, inject, apply }
