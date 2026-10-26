// Structural contract for bundle-shipped skills: every skills/<name>/SKILL.md
// carries well-formed frontmatter (name == directory, non-empty description)
// and an English body (template-layer language discipline, machine-enforced).
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { describe, expect, it } from './helpers.js'

const SKILLS_DIR = fileURLToPath(new URL('../skills/', import.meta.url))

function skillEntries() {
  return readdirSync(SKILLS_DIR)
    .filter((entry) => statSync(join(SKILLS_DIR, entry)).isDirectory())
    .map((entry) => ({ dir: entry, path: join(SKILLS_DIR, entry, 'SKILL.md') }))
}

function parseFrontmatter(text) {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text)
  if (!match) return null
  const fields = {}
  for (const line of match[1].split('\n')) {
    const field = /^([A-Za-z-]+):\s*(.*)$/.exec(line)
    if (field) fields[field[1]] = field[2].replace(/^["']|["']$/g, '').trim()
  }
  return { fields, body: match[2] }
}

describe('bundle skills structure', () => {
  const entries = skillEntries()

  it('ships at least the contracted catalog', () => {
    const names = entries.map((entry) => entry.dir).sort()
    for (const required of ['debugging', 'deep-work', 'mcp-server-setup', 'research', 'review-work']) {
      expect(names).toContain(required)
    }
  })

  it('ships the MCP setup workflow with refs-only confirmation and separate Apply', () => {
    const body = readFileSync(join(SKILLS_DIR, 'mcp-server-setup', 'SKILL.md'), 'utf8')
    expect(body).toContain('mcp_install')
    expect(body).toContain('credential reference')
    expect(body).toContain('Only the user can approve')
    expect(body).toMatch(/Select for this\s+session/)
    expect(body).toContain('saved-degraded')
  })

  for (const { dir, path } of entries) {
    it(`${dir}: frontmatter name matches the directory and description is present`, () => {
      const parsed = parseFrontmatter(readFileSync(path, 'utf8'))
      expect(parsed, `${dir}: SKILL.md must start with a --- frontmatter block`).not.toBeNull()
      expect(parsed.fields.name).toBe(dir)
      expect(parsed.fields.description?.length > 0).toBe(true)
    })

    it(`${dir}: body is English (no CJK in the template layer)`, () => {
      const parsed = parseFrontmatter(readFileSync(path, 'utf8'))
      expect(parsed).not.toBeNull()
      expect(/[一-鿿]/.test(parsed.body)).toBe(false)
    })
  }
})
