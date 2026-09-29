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
  return renderUnified(path, hunksFor(before, after))
}

/**
 * Structured per-hunk fragments of the same comparison, for persisted
 * presentation metadata (`meta.diffs`). Each fragment carries the hunk's
 * removed/added lines plus context on BOTH sides; `oldText` is null only
 * when the hunk has no old-side lines at all (e.g. file creation).
 * @param {string} path
 * @param {string} before
 * @param {string} after
 * @returns {Array<{ path: string, oldText: string | null, newText: string }>} one fragment per hunk, in file order
 */
export function diffFragments(path, before, after) {
  return fragmentsFor(path, hunksFor(before, after))
}

/**
 * One-pass comparison feeding both the rendered text and the persisted
 * metadata, so the two channels can never disagree.
 * @param {string} path
 * @param {string} before
 * @param {string} after
 * @returns {{ text: string, fragments: Array<{ path: string, oldText: string | null, newText: string }> }}
 */
export function diffResult(path, before, after) {
  const hunks = hunksFor(before, after)
  return { text: renderUnified(path, hunks), fragments: fragmentsFor(path, hunks) }
}

/** @param {string} before @param {string} after */
function hunksFor(before, after) {
  return computeHunks(before.split('\n'), after.split('\n'))
}

/** @param {string} path @param {ReturnType<typeof computeHunks>} hunks */
function renderUnified(path, hunks) {
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

/** @param {string} path @param {ReturnType<typeof computeHunks>} hunks */
function fragmentsFor(path, hunks) {
  return hunks.map((hunk) => ({
    path,
    oldText: hunk.oldLines.length > 0 ? hunk.oldLines.map((op) => op.line).join('\n') : null,
    newText: hunk.newLines.map((op) => op.line).join('\n'),
  }))
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
