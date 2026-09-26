// xxHash32 — reference implementation, no dependencies.
// Operates on UTF-8 bytes of a string with an optional seed.

const PRIME32_1 = 0x9e3779b1
const PRIME32_2 = 0x85ebca77
const PRIME32_3 = 0xc2b2ae3d
const PRIME32_4 = 0x27d4eb2f
const PRIME32_5 = 0x165667b1

const encoder = new TextEncoder()

function rotl32(value, bits) {
  return ((value << bits) | (value >>> (32 - bits))) >>> 0
}

function round32(acc, input) {
  acc = (acc + Math.imul(input, PRIME32_2)) >>> 0
  acc = rotl32(acc, 13)
  acc = Math.imul(acc, PRIME32_1) >>> 0
  return acc >>> 0
}

/**
 * @param {string} text
 * @param {number} [seed]
 * @returns {number} unsigned 32-bit hash
 */
export function xxh32(text, seed = 0) {
  const data = encoder.encode(text)
  const length = data.length
  let index = 0
  let hash

  if (length >= 16) {
    let acc1 = (seed + PRIME32_1 + PRIME32_2) >>> 0
    let acc2 = (seed + PRIME32_2) >>> 0
    let acc3 = seed >>> 0
    let acc4 = (seed - PRIME32_1) >>> 0
    const limit = length - 16
    while (index <= limit) {
      acc1 = round32(acc1, readUInt32(data, index))
      acc2 = round32(acc2, readUInt32(data, index + 4))
      acc3 = round32(acc3, readUInt32(data, index + 8))
      acc4 = round32(acc4, readUInt32(data, index + 12))
      index += 16
    }
    hash = (rotl32(acc1, 1) + rotl32(acc2, 7) + rotl32(acc3, 12) + rotl32(acc4, 18)) >>> 0
  } else {
    hash = (seed + PRIME32_5) >>> 0
  }

  hash = (hash + length) >>> 0

  while (index + 4 <= length) {
    hash = (hash + Math.imul(readUInt32(data, index), PRIME32_3)) >>> 0
    hash = rotl32(hash, 17)
    hash = Math.imul(hash, PRIME32_4) >>> 0
    index += 4
  }

  while (index < length) {
    hash = (hash + Math.imul(data[index], PRIME32_5)) >>> 0
    hash = rotl32(hash, 11)
    hash = Math.imul(hash, PRIME32_1) >>> 0
    index += 1
  }

  hash ^= hash >>> 15
  hash = Math.imul(hash, PRIME32_2) >>> 0
  hash ^= hash >>> 13
  hash = Math.imul(hash, PRIME32_3) >>> 0
  hash ^= hash >>> 16
  return hash >>> 0
}

function readUInt32(data, index) {
  return (data[index] | (data[index + 1] << 8) | (data[index + 2] << 16) | (data[index + 3] << 24)) >>> 0
}
