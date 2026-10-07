// The single adapter over the vendored DSH-fork volatile-ref protocol (S16):
// schemastery materializes volatile fields as frozen { get() } refs, and the
// service layer is OBLIGED to dereference them. This module is the only place
// in product code that names `isVolatile` — vendor files are never edited
// (S14/§3.8); adaptation happens at the consumer edge only.
import { isVolatile } from '../vendor/cosmokit.js'

/** Dereference one config entry: volatile refs yield get(), plain values pass. */
export function configValue(entry) {
  return isVolatile(entry) ? entry.get() : entry
}

/** Unwrap every entry and drop unset fields, restoring "absent means absent". */
export function flattenConfig(config) {
  const flat = {}
  for (const [key, rawValue] of Object.entries(config ?? {})) {
    const value = configValue(rawValue)
    if (value === undefined) continue
    flat[key] = value
  }
  return flat
}
