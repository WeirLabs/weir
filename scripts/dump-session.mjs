#!/usr/bin/env node
// Dump a DSH session log to plain JSONL.
//
// Usage: node scripts/dump-session.mjs <session.v4.jsonl.zstd> <out.jsonl>
//
// Session logs live at ~/.dsh/sessions/<workspace-slug>/<session-id>/session.v4.jsonl.zstd
// and are append-only MULTI-FRAME zstd: every append is compressed as its own
// frame. Node's zlib can decompress zstd, but zstdDecompressSync stops after
// the FIRST frame and createZstdDecompress() throws "Unknown frame descriptor"
// on the second — so this script scans for frame magic (28 B5 2F FD) and
// decompresses frame by frame. If DSH ever changes the log format this shows
// up as decoded=0 in the stats line; treat that as "format changed", not as
// "empty session".
import { readFileSync, writeFileSync } from 'node:fs'
import zlib from 'node:zlib'

const [file, out] = process.argv.slice(2)
if (!file || !out) {
  console.error('usage: node scripts/dump-session.mjs <session.v4.jsonl.zstd> <out.jsonl>')
  process.exit(2)
}

const buf = readFileSync(file)
const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd])
const offsets = []
for (let i = 0; i + 4 <= buf.length; i++) {
  if (buf[i] === MAGIC[0] && buf[i + 1] === MAGIC[1] && buf[i + 2] === MAGIC[2] && buf[i + 3] === MAGIC[3]) offsets.push(i)
}
const parts = []
let skipped = 0
for (const off of offsets) {
  try {
    parts.push(zlib.zstdDecompressSync(buf.subarray(off)).toString('utf8'))
  } catch {
    skipped++
  }
}
const text = parts.join('')
writeFileSync(out, text)
console.error(`frames=${offsets.length} decoded=${parts.length} skipped=${skipped} chars=${text.length} -> ${out}`)
