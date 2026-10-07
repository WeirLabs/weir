// Hand-authored ModuleLoader chunks are already executable JavaScript. Build
// validates every artifact and binds entry content to the exact lazy-chunk bytes.
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { Script } from 'node:vm'

const lib = new URL('../lib/', import.meta.url)
const chunks = (await readdir(lib)).filter(name => /^client\..+\.js$/.test(name)).sort()
const manifest = {}
for (const name of chunks) {
  const source = await readFile(new URL(name, lib), 'utf8')
  new Script(source, { filename: name })
  manifest[name] = createHash('sha256').update(source).digest('hex')
}
const entry = new URL('client.js', lib)
const source = (await readFile(entry, 'utf8')).replace(/^\/\/ Weir client chunks: .*\n/, '')
new Script(source, { filename: 'client.js' })
await writeFile(entry, `// Weir client chunks: ${JSON.stringify(manifest)}\n${source}`)
console.log(`Built client entry against ${chunks.length} validated chunks`)
