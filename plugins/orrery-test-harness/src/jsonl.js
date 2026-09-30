// Fault-tolerant JSONL parsing for the integration harness (design D3).
//
// Single source for the driver's three former parse sites (trace reads,
// rehydrate phase-1 stdout, audit facts). Unified semantics: per-line
// fault tolerance — blank lines are skipped and unparseable lines are
// dropped, never fatal; a missing/unreadable file parses as zero records.
import { readFileSync } from 'node:fs'

/**
 * Parse JSONL text into records, dropping blank and unparseable lines.
 * @param {unknown} text - JSONL source (non-strings yield [])
 * @returns {any[]} the parsed records, in line order
 */
export function parseJsonlLines(text) {
  if (typeof text !== 'string') return []
  const records = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    try {
      records.push(JSON.parse(trimmed))
    } catch {
      // bad lines are dropped, never fatal
    }
  }
  return records
}

/**
 * Read and parse a JSONL file; a missing or unreadable file yields [].
 * @param {string} file - absolute path
 * @returns {any[]} the parsed records, in line order
 */
export function readJsonl(file) {
  try {
    return parseJsonlLines(readFileSync(file, 'utf8'))
  } catch {
    return []
  }
}
