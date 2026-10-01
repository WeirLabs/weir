/** Strict canonical JSON for trusted adapter input, before hashing or copying.
 * Rejects lossy representations rather than silently dropping request fields.
 * This is not a sandbox for hostile executable objects (including Proxies).
 * @param {unknown} value @returns {string} */
export function canonicalRequestData(value) {
  const ancestors = new Set()
  /** @param {unknown} node @returns {string} */
  function encode(node) {
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return JSON.stringify(node)
    if (typeof node === 'number' && Number.isFinite(node) && !Object.is(node, -0)) return JSON.stringify(node)
    if (typeof node !== 'object' || node === null || ancestors.has(node)) throw new Error('invalid request data')
    const array = Array.isArray(node)
    const prototype = Object.getPrototypeOf(node)
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new Error('invalid request data prototype')
    const descriptors = Object.getOwnPropertyDescriptors(node)
    const keys = Reflect.ownKeys(descriptors)
    for (const key of keys) {
      if (typeof key !== 'string') throw new Error('invalid request data symbol')
      const descriptor = descriptors[key]
      if (!('value' in descriptor) || (!descriptor.enumerable && !(array && key === 'length'))) throw new Error('invalid request data descriptor')
    }
    ancestors.add(node)
    try {
      if (array) {
        if (keys.length !== node.length + 1) throw new Error('invalid request data array')
        const items = []
        for (let index = 0; index < node.length; index++) {
          const descriptor = descriptors[String(index)]
          if (!descriptor) throw new Error('invalid request data sparse array')
          items.push(encode(descriptor.value))
        }
        return `[${items.join(',')}]`
      }
      return `{${Object.keys(descriptors).sort().map(key => `${JSON.stringify(key)}:${encode(descriptors[key].value)}`).join(',')}}`
    } finally {
      ancestors.delete(node)
    }
  }
  return encode(value)
}
