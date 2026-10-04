import { describe, expect, it } from './helpers.js'
import { cardCopy, cardLocale, displayPath } from '../src/worktree/cards.js'

describe('worktree decision-card copy', () => {
  it('picks zh for any Chinese locale and en otherwise', () => {
    expect(cardLocale('zh')).toBe('zh')
    expect(cardLocale('zh-CN')).toBe('zh')
    expect(cardLocale('en')).toBe('en')
    expect(cardLocale(undefined)).toBe('en')
  })

  it('shows paths relative to the repository so they fit the card', () => {
    expect(displayPath('/r/.orrery/worktrees/a-001', '/r')).toBe('.orrery/worktrees/a-001')
    expect(displayPath('/elsewhere/x', '/r')).toBe('/elsewhere/x')
    expect(displayPath('C:\\r\\.orrery\\worktrees\\a', 'C:\\r')).toBe('.orrery/worktrees/a')
  })

  it('offers the same choice set in both languages', () => {
    for (const locale of ['en', 'zh']) {
      const copy = cardCopy(locale)
      expect(Object.keys(copy.choices)).toEqual(['keep', 'worktree', 'all'])
      expect(new Set(Object.values(copy.choices)).size).toBe(3)
      expect(copy.mergeOption('main')).not.toBe(copy.notNow)
      expect(copy.abandonDescriptions.all(3)).toContain('3')
    }
    expect(cardCopy('en').mergeOption('main')).toBe('Merge into main (--no-ff)')
  })

  it('keeps the option row short: no branch in the description, no title in the lane fact', () => {
    const lane = { id: 'a-001', title: 'Fix login', branch: 'orrery/a-001', base: { branch: 'main' } }
    for (const locale of ['en', 'zh']) {
      const copy = cardCopy(locale)
      expect(copy.mergeOptionDescription('orrery/a-001')).not.toContain('orrery/a-001')
      const detail = copy.mergeDetail({ lane, commits: [], stat: { files: 0, added: 0, removed: 0 }, verification: { enabled: false } })
      expect(detail.split('\n')[0]).toBe(`- **${locale === 'zh' ? '车道' : 'Lane'}** \`a-001\``)
      expect(detail).not.toContain('Fix login')
    }
  })

  it('renders merge detail as GFM blocks that survive soft-break collapsing', () => {
    const lane = { id: 'a-001', title: 'Fix login', branch: 'orrery/a-001', base: { branch: 'main' } }
    const verification = { enabled: true, results: [{ name: 'test', exit: 0 }, { name: 'lint', exit: 2 }] }
    for (const locale of ['en', 'zh']) {
      const detail = cardCopy(locale).mergeDetail({ lane, commits: [{ sha: 'abc1234', subject: 'fix it' }], stat: { files: 2, added: 10, removed: 3 }, verification })
      const lines = detail.split('\n')
      // Every fact is its own list item: a single \n is a GFM soft break and
      // would collapse bare `**label** value` lines into one paragraph.
      for (const line of lines.filter((entry) => entry !== '' && !entry.startsWith('*'))) {
        expect(line.startsWith('- ') || line.startsWith('  - ') || line.startsWith('**'), `fact line must be a list item or heading: ${line}`).toBe(true)
      }
      expect(lines.some((line) => line.startsWith('- **'))).toBe(true)
      expect(lines).toContain('  - `abc1234` fix it')
      expect(detail).toContain('✗ (exit 2)')
      expect(lines.at(-1)).toMatch(/^\*.+\*$/)
    }
    const off = cardCopy('en').mergeDetail({ lane, commits: [], stat: { files: 0, added: 0, removed: 0 }, verification: { enabled: false } })
    expect(off.split('\n').some((line) => line.startsWith('- Verification: not enabled'))).toBe(true)
  })

  it('renders cleanup and abandon details as list items with the warning as its own paragraph', () => {
    const lane = { id: 'a-001', title: 'Fix login', state: 'working', branch: 'orrery/a-001', base: { branch: 'main' }, path: '/r/.orrery/worktrees/a-001' }
    for (const locale of ['en', 'zh']) {
      const copy = cardCopy(locale)
      const cleanup = copy.cleanupDetail(lane, { files: 1, added: 2, removed: 1 }, '/r')
      expect(cleanup.split('\n').every((line) => line.startsWith('- '))).toBe(true)
      const abandon = copy.abandonDetail(lane, 3, '/r')
      const paragraphs = abandon.split('\n\n')
      expect(paragraphs[0].split('\n').every((line) => line.startsWith('- '))).toBe(true)
      expect(paragraphs[1]).toContain('3')
      expect(paragraphs[1].startsWith('- ')).toBe(false)
    }
  })
})
