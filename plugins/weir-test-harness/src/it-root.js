import { fileURLToPath } from 'node:url'

// Resolve from this package, not cwd: linked lane profiles stay lane-local.
export function defaultItRoot() {
  return fileURLToPath(new URL('../../../.weir/it-root', import.meta.url))
}
