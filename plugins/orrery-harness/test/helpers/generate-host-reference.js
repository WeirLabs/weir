// Regenerate only against an explicitly selected host extract; tests never import it.
import { readFile, readdir, writeFile, mkdtemp, mkdir, realpath, rm } from 'node:fs/promises'
import { join, dirname, resolve, basename } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'

const extract = process.env.DSH_EXTRACT
if (!extract) throw new Error('Set DSH_EXTRACT to the extracted node_modules/@deepseek-ai directory')
// The parser belongs to dsh-skill-filesystem, not dsh-skill (the registry).
const { FileSystemSkillProvider } = await import(pathToFileURL(join(extract, 'dsh-skill-filesystem/lib/index.js')).href)
const fixtures = resolve(dirname(fileURLToPath(import.meta.url)), '../fixtures/skill-inventory')
const corpus = join(fixtures, 'corpus')
const ctx = { get: () => undefined, logger: { warn() {} } }
const control = () => ({ signal: new AbortController().signal, invalidate() {} })
const provider = new FileSystemSkillProvider(ctx, control(), { watch: false, includeDefaultRoots: false, customSkillDirs: [corpus] })
const results = {}
try {
  const listed = await provider.list({})
  const candidates = Array.isArray(listed) ? listed : listed.candidates
  for (const file of (await readdir(corpus)).sort()) {
    const candidate = candidates.find(item => basename(item.locator.path) === file)
    if (!candidate) { results[file] = null; continue }
    const skill = await provider.get(candidate, {})
    const { name, description, whenToUse, invocation, metadata, content } = skill
    results[file] = { name, description, ...(whenToUse !== undefined ? { whenToUse } : {}), invocation, ...(metadata !== undefined ? { metadata } : {}), content }
  }
} finally { await provider.dispose() }

const base = await realpath(tmpdir())
const temp = await mkdtemp(join(base, 'orrery-skill-host-'))
let rootProvider
let roots
try {
  await mkdir(join(temp, 'project/.git'), { recursive: true })
  rootProvider = new FileSystemSkillProvider(ctx, control(), { watch: false, dshHome: join(temp, 'dsh'), agentsHome: join(temp, 'agents'), customSkillDirs: [join(temp, 'custom')], bundledSkillDir: join(temp, 'bundled') })
  roots = (await rootProvider.roots(join(temp, 'project'))).map(root => ({ ...root, path: root.path.replace(temp, '$ROOT'), ...(root.projectRoot ? { projectRoot: root.projectRoot.replace(temp, '$ROOT') } : {}) }))
} finally {
  await rootProvider?.dispose()
  if (dirname(resolve(temp)) !== base || !basename(temp).startsWith('orrery-skill-host-')) throw new Error('Unsafe cleanup path')
  await rm(temp, { recursive: true, force: true })
}
const version = JSON.parse(await readFile(join(extract, 'dsh-skill-filesystem/package.json'), 'utf8')).version
await writeFile(join(fixtures, 'host-reference.json'), JSON.stringify({ hostPackage: '@deepseek-ai/dsh-skill-filesystem', version, roots, files: results }, null, 2) + '\n')
console.log(`Generated ${Object.keys(results).length} file references against ${version}`)
