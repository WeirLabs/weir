import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const fixture = readFileSync(new URL('../../weir-test-harness/cordis.patch.yml', import.meta.url), 'utf8')
for (const [label, text] of [['preset', patch], ['fixture', fixture]]) {
  test(`${label}: OFF composition disables both host rows by id`, () => {
    for (const id of ['skill-filesystem', 'tool-skill']) assert.match(text, new RegExp(`^- id: ${id}\\n  disabled: true$`, 'm'))
  })
  test(`${label}: no mounted filesystem provider or stray customSkillDirs`, () => {
    assert.doesNotMatch(text, /^ +[-] id: skill-filesystem$/m)
    assert.doesNotMatch(text, /name: ['"]@deepseek-ai\/dsh-skill-filesystem/)
    // Post-migration invariant: no customSkillDirs anywhere — EXCEPT inside
    // the preset-weir-creative row, whose own weir-skill-selection row
    // takes the key as the selection plugin's sanctioned config input (the
    // fused Cordis development skills). Strip that trailing row, then ban.
    const stripped = label === 'preset' ? text.split('\n    - id: preset-weir-creative')[0] : text
    assert.doesNotMatch(stripped, /customSkillDirs:/)
  })
  test(`${label}: selection provider and stock skill tool are retained`, () => {
    assert.match(text, /- id: weir-skill-selection/)
    assert.match(text, label === 'preset' ? /name: 'weir-harness\/skill-selection'/ : /weir-test-harness\/skill-selection/)
    assert.match(text, /name: '@deepseek-ai\/dsh-tool-skill'/)
  })
}
// Regression guard: neither the preset registry (`entryListProblem`) nor the
// loader ever evaluates a `!!js` expression in a row's `name` — only `disabled`
// and config values are evaluated. A `!!js` name fails preset validation with
// 'names no plugin', breaking every new session of the preset.
test('preset patch has no !!js expression in any name field', () => {
  assert.doesNotMatch(patch, /name:\s*!!js/)
  assert.doesNotMatch(fixture, /name:\s*!!js/)
})
test('fixture uses the exact product selection provider entry', () => {
  const bridge = readFileSync(new URL('../../weir-test-harness/src/skill-selection.js', import.meta.url), 'utf8')
  assert.match(bridge, /export \{ name, inject, apply \} from '..\/..\/weir-harness\/src\/capabilities\/skill-selection-plugin.js'/)
})
