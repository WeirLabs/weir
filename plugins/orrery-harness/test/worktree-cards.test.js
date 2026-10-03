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
})
