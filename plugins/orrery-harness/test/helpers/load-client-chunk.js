// Shared test helper for the package-local client chunks (lib/client.*.js):
// capture the chunk's `window.__ModuleLoader__.load` registration, then drive
// its factory with the caller's require stub. Zero-dependency view-model
// chunks pass no stub at all — the default require throws on any call.
// `path` is relative to the orrery-harness package root (e.g.
// "lib/client.chain-model.js").

let importCounter = 0

export function throwingRequire(name) {
  throw new Error(`unexpected require ${name}`)
}

export async function loadClientChunk(path, requireStub = throwingRequire) {
  const loaded = []
  globalThis.window = {
    __ModuleLoader__: {
      load: (definition) => loaded.push(definition),
    },
  }
  // Cache-busted import: one process may load the same chunk per test case.
  const url = new URL(`../../${path}?load-client-chunk=${++importCounter}`, import.meta.url)
  await import(url.href)
  if (loaded.length !== 1) throw new Error(`${path} registered ${loaded.length} module(s), expected exactly one`)
  const definition = loaded[0]
  return { definition, exports: definition.factory(requireStub) }
}
