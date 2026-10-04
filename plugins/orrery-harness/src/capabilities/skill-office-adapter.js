import { createHash } from 'node:crypto'
import { realpath } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createSkillIdentity } from './skill-identity.js'

export const OFFICE_NAMES = Object.freeze(['office-docx', 'office-pptx', 'office-xlsx'])

// Keep denials even when discovery or policy reads fail. Rank also protects
// host-level test mounts; production relies on the nearer preset layer.
export const officeDenials = () => OFFICE_NAMES.map(name => ({
  name, description: 'This Office skill is not selected for this session.',
  provider: 'orrery-selected', source: 'bundled', rank: -1,
  invocation: { modelInvocable: false, userInvocable: false }, locator: null,
}))

/** Raw registration compatibility seam; never call the merged catalog here.
 * An incompatible registry disables discovery, not the fail-closed denials.
 */
export function createOfficeAdapter(skills, machineId) {
  const registration = () => {
    const providers = skills.layers?.global?.providers
    if (typeof providers?.get !== 'function') throw new Error('Office provider registry is unavailable')
    return providers.get('dsh-office')?.provider
  }
  return async options => {
    const provider = registration()
    if (!provider) return { complete: true, candidates: [] }
    if (typeof machineId !== 'string' || !machineId.length) throw new Error('A persistent machineId is required')
    const output = await provider.list(options)
    const observation = Array.isArray(output) ? { candidates: output, complete: true } : output
    const candidates = []
    for (const raw of observation.candidates) {
      if (!OFFICE_NAMES.includes(raw.name) || raw.provider !== 'dsh-office' || raw.source !== 'bundled' || typeof raw.locator !== 'string') {
        throw new Error('Unsupported Office provider candidate')
      }
      const path = await realpath(raw.locator)
      const root = await realpath(dirname(dirname(path)))
      const identity = createSkillIdentity({ scope: 'custom', root, name: raw.name,
        opaqueId: createHash('sha256').update(JSON.stringify([machineId, 'dsh-office', root, raw.name, path])).digest('hex') })
      candidates.push({ ...raw, status: 'parsed', path, identity,
        async load(lookup) {
          if (registration() !== provider || await realpath(raw.locator) !== path) return undefined
          return provider.get(raw, lookup)
        },
      })
    }
    return { complete: observation.complete, candidates }
  }
}
