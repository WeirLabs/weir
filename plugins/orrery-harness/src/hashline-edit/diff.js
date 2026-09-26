// Minimal line-based unified diff: changed regions with context lines.
// No dependencies; deterministic; used for hash_edit result rendering.

const CONTEXT_LINES = 3

/**
 * @param {string} path
 * @param {string} before
 * @param {string} after
 * @returns {string} unified-ish diff text (empty string when identical)
 */
export function unifiedDiff(path, before, after) {
  const beforeLines = before.split('\n')
  const afterLines = after.split('\n')
  const hunks = computeHunks(beforeLines, afterLines)
  if (hunks.length === 0) return ''

  const output = [`--- a/${path}`, `+++ b/${path}`]
  for (const hunk of hunks) {
    const oldCount = hunk.oldLines.length
    const newCount = hunk.newLines.length
    output.push(`@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`)
    for (const line of hunk.lines) output.push(line)
  }
  return output.join('\n')
}

/**
 * Compute hunks with a longest-common-substring-free approach: walk both line
 * arrays, collapsing equal runs; each change region gets CONTEXT_LINES of
 * leading/trailing equal lines merged into one hunk when close.
 */
function computeHunks(beforeLines, afterLines) {
  // Simple LCS over lines (files here are bounded by the read/write caps).
  const table = lcsTable(beforeLines, afterLines)
  const ops = diffOps(beforeLines, afterLines, table)
  return groupHunks(ops, CONTEXT_LINES)
}

function lcsTable(a, b) {
  const rows = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      rows[i][j] = a[i] === b[j] ? rows[i + 1][j + 1] + 1 : Math.max(rows[i + 1][j], rows[i][j + 1])
    }
  }
  return rows
}

/** Walk the LCS table into a flat op list: [' ', line] | ['-', line] | ['+', line]. */
function diffOps(a, b, table) {
  const ops = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      ops.push({ tag: ' ', line: a[i] })
      i++
      j++
    } else if (table[i + 1][j] >= table[i][j + 1]) {
      ops.push({ tag: '-', line: a[i] })
      i++
    } else {
      ops.push({ tag: '+', line: b[j] })
      j++
    }
  }
  while (i < a.length) ops.push({ tag: '-', line: a[i++] })
  while (j < b.length) ops.push({ tag: '+', line: b[j++] })
  return ops
}

/** Group ops into hunks, merging change regions separated by <= 2*context equals. */
function groupHunks(ops, context) {
  const changed = ops.map((op, index) => ({ ...op, index })).filter((op) => op.tag !== ' ')
  if (changed.length === 0) return []

  const hunks = []
  let start = Math.max(0, changed[0].index - context)
  let end = Math.min(ops.length, changed[0].index + 1 + context)
  for (let k = 1; k < changed.length; k++) {
    const index = changed[k].index
    if (index - end <= context) {
      end = Math.min(ops.length, index + 1 + context)
    } else {
      hunks.push([start, end])
      start = Math.max(0, index - context)
      end = Math.min(ops.length, index + 1 + context)
    }
  }
  hunks.push([start, end])

  let oldLine = 1
  const oldStarts = []
  for (let index = 0; index < ops.length; index++) {
    oldStarts.push(oldLine)
    if (ops[index].tag !== '+') oldLine++
  }
  let newLine = 1
  const newStarts = []
  for (let index = 0; index < ops.length; index++) {
    newStarts.push(newLine)
    if (ops[index].tag !== '-') newLine++
  }

  return hunks.map(([from, to]) => {
    const slice = ops.slice(from, to)
    return {
      oldStart: oldStarts[from],
      newStart: newStarts[from],
      oldLines: slice.filter((op) => op.tag !== '+'),
      newLines: slice.filter((op) => op.tag !== '-'),
      lines: slice.map((op) => `${op.tag}${op.line}`),
    }
  })
}
