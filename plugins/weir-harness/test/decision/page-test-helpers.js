import { loadClientChunk } from '../helpers/load-client-chunk.js'

export function findAll(node, predicate, found = []) {
  if (!node || typeof node !== 'object') return found
  if (predicate(node)) found.push(node)
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) for (const item of value) findAll(item, predicate, found)
    else if (value && typeof value === 'object') findAll(value, predicate, found)
  }
  return found
}

export function textOf(node) {
  if (node === null || node === undefined || typeof node === 'boolean') return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object') return textOf(node.children)
  return ''
}

export function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

export function makeReactRuntime() {
  const hooks = []
  let cursor = 0
  const react = {
    cloneElement: (element, props) => ({ ...element, ...props }),
    useState(initial) {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { value: typeof initial === 'function' ? initial() : initial }
      const set = next => { hooks[index].value = typeof next === 'function' ? next(hooks[index].value) : next }
      return [hooks[index].value, set]
    },
    useRef(initial) {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { current: initial }
      return hooks[index]
    },
    useId() {
      const index = cursor++
      if (!hooks[index]) hooks[index] = { value: `test-${index}` }
      return hooks[index].value
    },
    useEffect(fn, deps) {
      const index = cursor++
      const previous = hooks[index]
      const changed = !previous || !deps || !previous.deps || deps.length !== previous.deps.length || deps.some((value, at) => !Object.is(value, previous.deps[at]))
      if (!changed) return
      previous?.cleanup?.()
      const hook = { deps, cleanup: undefined }
      hooks[index] = hook
      hook.cleanup = fn()
    },
  }
  return {
    react,
    begin: () => { cursor = 0 },
    unmount: () => { for (const hook of hooks) hook?.cleanup?.() },
  }
}

export async function createPageHarness(options = {}) {
  const runtime = makeReactRuntime()
  const jsx = (type, props) => ({ type, ...(props ?? {}) })
  const requireStub = name => name === 'react' ? runtime.react : { jsx, jsxs: jsx }
  const model = (await loadClientChunk('lib/client.decision-model.js')).exports
  const ui = (await loadClientChunk('lib/client.decision-ui.js', requireStub)).exports
  const learning = (await loadClientChunk('lib/client.decision-learning.js', requireStub)).exports
  const page = (await loadClientChunk('lib/client.decision-page.js', requireStub)).exports
  let currentProps = {
    sessionId: options.sessionId === undefined ? 'root' : options.sessionId,
    connection: {},
    decisionRpc: async () => { throw new Error('unexpected direct RPC') },
    createDecisionActions: (_connection, sessionId) => options.actionsForSession?.(sessionId) ?? options.actions ?? {},
    errorBanner: reason => ({ message: reason instanceof Error ? reason.message : String(reason) }),
    decisionModel: model,
    pageView: model.pageView,
    narrowRecords: model.narrowRecords,
    narrowInbox: model.narrowInbox,
    ui,
    learning,
    t: options.t ?? (key => key),
    consumeOpenCase: options.consumeOpenCase,
    consumeAgentDestination: options.consumeAgentDestination,
    panelInfo: options.panelInfo,
  }
  const render = () => {
    runtime.begin()
    return page.DecisionPage({
      ...currentProps,
      getSessionId: () => currentProps.sessionId,
    })
  }
  const flush = async () => {
    await Promise.resolve()
    await new Promise(resolve => setImmediate(resolve))
    await Promise.resolve()
  }
  return {
    page, model, ui, learning, runtime,
    render,
    flush,
    async settle() {
      const first = render()
      await flush()
      const settled = render()
      await flush()
      return { first, tree: render() }
    },
    update(next) { currentProps = { ...currentProps, ...next } },
    unmount: runtime.unmount,
  }
}
