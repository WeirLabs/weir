// Design-system contract: the client half may only use tokens that exist in the
// installed host, may not spell colours or radii inline, and may not hide typos
// behind var() fallbacks. Keep this list in sync with a deliberate token change.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readdirSync, readFileSync } from 'node:fs'

const LIB = new URL('../lib/', import.meta.url)
const files = readdirSync(LIB).filter(name => /^client.*\.js$/.test(name)).sort()

// Every name below exists in the installed app's token set (476 names extracted
// from app.asar). A new surface must add its token here and prove it exists.
const ALLOWED_TOKENS = new Set([
  '--dsw-alias-bg-base',
  '--dsw-alias-bg-layer-1',
  '--dsw-alias-bg-layer-2',
  '--dsw-alias-bg-layer-3',
  '--dsw-alias-bg-overlay',
  '--dsw-alias-bg-skeleton',
  '--dsw-alias-border-l1',
  '--dsw-alias-border-l2',
  '--dsw-alias-border-l3',
  '--dsw-alias-button-elevated-fill',
  '--dsw-alias-button-info-hover',
  '--dsw-alias-button-primary-fill',
  '--dsw-alias-button-primary-hover',
  '--dsw-alias-interactive-bg-hover',
  '--dsw-alias-label-deep-diving',
  '--dsw-alias-label-on-color',
  '--dsw-alias-label-primary',
  '--dsw-alias-label-secondary',
  '--dsw-alias-label-tertiary',
  '--dsw-alias-link',
  '--dsw-alias-separator-primary',
  '--dsw-alias-settings-card-fill',
  '--dsw-alias-settings-card-stroke',
  '--dsw-alias-state-business-primary',
  '--dsw-alias-state-error-primary',
  '--dsw-alias-state-success-primary',
  '--dsw-alias-state-warn-label',
  '--dsw-alias-state-warn-primary',
  '--dsw-alias-toast-bg',
  '--dsw-alias-toast-label',
  '--dsw-elevation-panel',
  '--dsw-elevation-prominent',
  '--dsw-elevation-soft',
  '--dsw-font-base-16-font-size',
  '--dsw-font-base-16-line-height',
  '--dsw-font-m-18-font-size',
  '--dsw-font-m-18-line-height',
  '--dsw-font-markdown-code-block-font-family',
  '--dsw-font-mono',
  '--dsw-font-s-14-font-size',
  '--dsw-font-s-14-line-height',
  '--dsw-font-xl-24-font-size',
  '--dsw-font-xl-24-line-height',
  '--dsw-font-xs-13-font-size',
  '--dsw-font-xs-13-line-height',
  '--dsw-font-xxs-12-font-size',
  '--dsw-font-xxs-12-line-height',
  '--dsw-radius-lg',
  '--dsw-radius-md',
  '--dsw-radius-panel',
  '--dsw-radius-sm',
  '--dsw-radius-xl',
  '--dsw-radius-xs',
  '--dsw-shadow-lv3',
  '--dsw-specific-menu',
  '--dsw-specific-selector',
])

// The only colour literal the design system allows: the theme-independent modal
// scrim required by the official overlay rule.
const ALLOWED_COLOUR_LITERALS = new Set(['rgba(0, 0, 0, .32)'])

function eachFile (assertion) {
  for (const name of files) {
    const source = readFileSync(new URL(name, LIB), 'utf8')
    assertion(name, source)
  }
}

test('design system: only verified --dsw-* tokens are referenced', () => {
  const unknown = []
  eachFile((name, source) => {
    for (const match of source.matchAll(/--dsw-[a-z0-9-]+/g)) {
      if (!ALLOWED_TOKENS.has(match[0])) unknown.push(`${name}: ${match[0]}`)
    }
  })
  assert.deepEqual(unknown, [], `unknown tokens:\n${unknown.join('\n')}`)
})

test('design system: no colour literals outside the modal scrim', () => {
  const literals = []
  eachFile((name, source) => {
    for (const match of source.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) literals.push(`${name}: ${match[0]}`)
    for (const match of source.matchAll(/rgba?\([^)]*\)/g)) {
      if (!ALLOWED_COLOUR_LITERALS.has(match[0])) literals.push(`${name}: ${match[0]}`)
    }
    for (const match of source.matchAll(/--dsw-static-[a-z0-9-]+/g)) literals.push(`${name}: ${match[0]}`)
  })
  assert.deepEqual(literals, [], `colour literals:\n${literals.join('\n')}`)
})

test('design system: var() fallbacks never mask a token typo', () => {
  const fallbacks = []
  eachFile((name, source) => {
    for (const match of source.matchAll(/var\(--dsw-[a-z0-9-]+,/g)) fallbacks.push(`${name}: ${match[0]}`)
  })
  assert.deepEqual(fallbacks, [], `fallbacks:\n${fallbacks.join('\n')}`)
})

test('design system: neutral borders are hairlines', () => {
  const thick = []
  eachFile((name, source) => {
    for (const match of source.matchAll(/1px solid var\(--dsw-alias-border-[a-z0-9]+\)/g)) thick.push(`${name}: ${match[0]}`)
    for (const match of source.matchAll(/1px solid \$\{BORDER\w*\}/g)) thick.push(`${name}: ${match[0]}`)
  })
  assert.deepEqual(thick, [], `non-hairline borders:\n${thick.join('\n')}`)
})

test('design system: radii come from the shared scale', () => {
  const offScale = []
  eachFile((name, source) => {
    for (const match of source.matchAll(/borderRadius: "\d+px"/g)) offScale.push(`${name}: ${match[0]}`)
    for (const match of source.matchAll(/border-radius: \d+px/g)) offScale.push(`${name}: ${match[0]}`)
  })
  assert.deepEqual(offScale, [], `off-scale radii:\n${offScale.join('\n')}`)
})
