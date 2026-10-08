// Distribution guard for the rows this bundle mounts (the weir-model-picker
// incident): a bundle patch may only name specifiers that EVERY consumer
// profile can resolve from the installed tarball. The picker used to be a
// second package, private and never published, mounted by the bare specifier
// `weir-model-picker`; nothing failed in CI, but on a real registry install the
// entry had no fiber and startup reported
// `ui-weir-model-picker (weir-model-picker): failed to import`.
//
// The rule enforced here, over the real cordis.patch.yml:
//   - `@deepseek-ai/*` — supplied by the DSH runtime itself, never shipped;
//   - this package's own name and subpaths — the subpath must be a declared
//     `exports` entry, and its target must be inside the `files` whitelist;
//   - anything else — a bare specifier consumers cannot resolve: fail.
import { test, expect } from './helpers.js'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'

const packageRoot = fileURLToPath(new URL('../', import.meta.url))
const manifest = JSON.parse(readFileSync(join(packageRoot, 'package.json'), 'utf8'))
const patch = readFileSync(join(packageRoot, 'cordis.patch.yml'), 'utf8')

/** Host scope: packages the running Harness supplies to every profile. */
const HOST_SCOPE = '@deepseek-ai/'
/** npm always ships package.json, whatever `files` lists. */
const ALWAYS_SHIPPED = ['./package.json']

/**
 * A module-specifier shape (scoped or plain package name, optional subpaths).
 * The patch is YAML carrying `!!js` tags, so this is a text scan — the same
 * instrument settings-fields.test.js and preset-realms.test.js use. The shape
 * test is what excludes non-specifiers: `cordis:group` (a Loader builtin) and
 * preset display titles such as `Weir`.
 */
const SPECIFIER = /^(?:@[a-z0-9][a-z0-9._~-]*\/)?[a-z0-9][a-z0-9._~-]*(?:\/[A-Za-z0-9._~-]+)*$/

/** Every `name:` value in the patch that reads as a module specifier, with its line. */
function moduleSpecifiers(text) {
  return text.split('\n').flatMap((line, index) => {
    const match = /^\s*(?:- )?name:\s*(.+?)\s*$/.exec(line)
    if (match === null) return []
    const specifier = match[1].replace(/^['"]/, '').replace(/['"]$/, '')
    return SPECIFIER.test(specifier) ? [{ line: index + 1, specifier }] : []
  })
}

/**
 * Every specifier a consumer profile could not resolve, as readable lines.
 * @param rows - {@link moduleSpecifiers} output.
 * @param pkg - the bundle manifest under test.
 * @returns failure descriptions; empty when every row is resolvable.
 */
function unresolvableRows(rows, pkg) {
  const failures = []
  for (const { line, specifier } of rows) {
    if (specifier.startsWith(HOST_SCOPE)) continue
    if (specifier === pkg.name || specifier.startsWith(`${pkg.name}/`)) {
      const subpath = specifier === pkg.name ? '.' : `./${specifier.slice(pkg.name.length + 1)}`
      const target = pkg.exports?.[subpath]
      if (typeof target !== 'string') {
        failures.push(`cordis.patch.yml:${line}: ${specifier} is not declared in exports ("${subpath}")`)
        continue
      }
      const relative = target.replace(/^\.\//, '')
      if (!isShipped(relative, pkg.files ?? [])) {
        failures.push(`cordis.patch.yml:${line}: ${specifier} resolves to ${relative}, which the files whitelist does not ship`)
      }
      continue
    }
    failures.push(`cordis.patch.yml:${line}: ${specifier} is a bare specifier this bundle does not ship — a consumer profile can never resolve it (publish it as its own dependency, or fold it into this package)`)
  }
  return failures
}

/** Whether a package-relative path is covered by the `files` whitelist. */
function isShipped(relative, files) {
  return files.some((entry) => relative === entry || relative.startsWith(`${entry}/`))
}

/** Every exported target the tarball would not carry — a row mounting it would 404. */
function unshippedExports(pkg) {
  const failures = []
  for (const [subpath, target] of Object.entries(pkg.exports ?? {})) {
    if (ALWAYS_SHIPPED.includes(subpath)) continue
    if (typeof target !== 'string') {
      failures.push(`exports["${subpath}"] is not a plain path string`)
      continue
    }
    const relative = target.replace(/^\.\//, '')
    if (!isShipped(relative, pkg.files ?? [])) failures.push(`exports["${subpath}"] → ${relative} is outside the files whitelist`)
  }
  return failures
}

test('the patch mounts only specifiers every consumer profile can resolve', () => {
  const failures = unresolvableRows(moduleSpecifiers(patch), manifest)
  expect(failures, failures.join('\n')).toEqual([])
})

test('every export of this package is shipped by the files whitelist', () => {
  const failures = unshippedExports(manifest)
  expect(failures, failures.join('\n')).toEqual([])
})

test('the scan actually reads the patch (it is not silently matching nothing)', () => {
  const rows = moduleSpecifiers(patch)
  expect(rows.length).toBeGreaterThan(10)
  expect(rows.some((row) => row.specifier === manifest.name)).toBe(true)
  expect(rows.some((row) => row.specifier === 'weir-harness/settings')).toBe(true)
  // preset display titles and Loader builtins are not specifiers
  expect(rows.some((row) => row.specifier === 'Weir')).toBe(false)
  expect(rows.some((row) => row.specifier === 'cordis:group')).toBe(false)
})

test('the guard rejects the exact shape that broke ui-weir-model-picker', () => {
  // the pre-fix row, verbatim
  const rows = moduleSpecifiers("- id: ui-weir-model-picker\n  name: 'weir-model-picker'\n")
  expect(rows).toEqual([{ line: 2, specifier: 'weir-model-picker' }])
  const failures = unresolvableRows(rows, manifest)
  expect(failures).toHaveLength(1)
  expect(failures[0]).toContain('weir-model-picker')
  expect(failures[0]).toContain('consumer profile can never resolve it')
})

test('the guard rejects an unexported or unshipped subpath of this package', () => {
  const missingExport = unresolvableRows([{ line: 1, specifier: 'weir-harness/not-a-real-subpath' }], manifest)
  expect(missingExport).toHaveLength(1)
  expect(missingExport[0]).toContain('not declared in exports')
  const unshipped = unresolvableRows([{ line: 1, specifier: 'weir-harness/lsp' }], { ...manifest, files: ['lib'] })
  expect(unshipped).toHaveLength(1)
  expect(unshipped[0]).toContain('files whitelist does not ship')
})
