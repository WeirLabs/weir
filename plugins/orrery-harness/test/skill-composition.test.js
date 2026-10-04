import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
const fixture = readFileSync(new URL('../../orrery-test-harness/cordis.patch.yml', import.meta.url), 'utf8')
for (const [label, text] of [['preset', patch], ['fixture', fixture]]) {
  test(`${label}: OFF composition disables both host rows by id`, () => {
    for (const id of ['skill-filesystem', 'tool-skill']) assert.match(text, new RegExp(`^- id: ${id}\\n  disabled: true$`, 'm'))
  })
  test(`${label}: no mounted filesystem provider or customSkillDirs`, () => {
    assert.doesNotMatch(text, /^ +[-] id: skill-filesystem$/m)
    assert.doesNotMatch(text, /customSkillDirs:/)
    assert.doesNotMatch(text, /name: ['"]@deepseek-ai\/dsh-skill-filesystem/)
  })
  test(`${label}: selection provider and stock skill tool are retained`, () => {
    assert.match(text, /- id: orrery-skill-selection/)
    assert.match(text, label === 'preset' ? /src\/capabilities\/skill-selection-plugin.js/ : /orrery-test-harness\/skill-selection/)
    assert.match(text, /name: '@deepseek-ai\/dsh-tool-skill'/)
  })
}
test('fixture uses the exact product selection provider entry', () => {
  const bridge = readFileSync(new URL('../../orrery-test-harness/src/skill-selection.js', import.meta.url), 'utf8')
  assert.match(bridge, /export \{ name, inject, apply \} from '..\/..\/orrery-harness\/src\/capabilities\/skill-selection-plugin.js'/)
})
