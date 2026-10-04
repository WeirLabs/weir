import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runInNewContext } from 'node:vm'
import { defaultItRoot } from '../src/it-root.js'

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const expected = resolve(packageDir, '../..', '.orrery/it-root')

test('default IT root resolves from the package location, not cwd or environment', () => {
  assert.equal(defaultItRoot(), expected)
})

// Evaluate only each consumer's root declaration: importing the driver would
// run setup and destroy fixtures. Also pin the shared import (no copied default).
for (const [file, variable] of [['run.mjs', 'IT_ROOT'], ['src/mock-kit.js', 'IT_ROOT'], ['src/event-tap.js', 'TRACE']]) {
  const source = readFileSync(join(packageDir, file), 'utf8')
  test(`${file} consumes the shared default and preserves explicit overrides`, () => {
    assert.match(source, /import \{ defaultItRoot \} from ['"].*it-root\.js['"]/)
    const declaration = source.match(new RegExp(`const ${variable} = ([\\s\\S]*?)(?=\\n(?:const |\\n))`))
    assert.ok(declaration, 'root declaration must remain testable without running the driver')
    const evaluate = env => runInNewContext(declaration[1], { process: { env }, defaultItRoot, join })
    const rootOf = value => variable === 'TRACE' ? dirname(value) : value
    assert.equal(rootOf(evaluate({})), expected)
    const override = resolve(packageDir, 'explicit-root')
    assert.equal(rootOf(evaluate({ ORRERY_IT_ROOT: override })), override)
    if (variable === 'TRACE') assert.equal(evaluate({ ORRERY_IT_TRACE: 'custom.jsonl' }), 'custom.jsonl')
  })
}
