import { describe, expect, it } from './helpers.js'
import { createSettingsOverlay, mergeWhitelist, readOnlyShellName } from '../src/delegate/settings-overlay.js'
import { FALLBACK_TABLES } from '../src/shared/whitelist-defaults.js'

// Mutable settings service with an onChange broadcast (same liveSettings
// pattern as delegate.test.js): commit() publishes one section change to every
// subscriber, exactly like the real service does on loader/volatile-update.
function liveSettings(initial = {}) {
  const listeners = new Set()
  const sections = { robash: undefined, delegate: undefined, ...initial }
  return {
    service: {
      get: (key) => sections[key],
      onChange: (callback) => {
        listeners.add(callback)
        return () => listeners.delete(callback)
      },
    },
    commit(section, value) {
      sections[section] = value
      for (const callback of listeners) callback()
    },
    listenerCount: () => listeners.size,
  }
}

function makeOverlay({ sections, config = {}, platform = 'linux' } = {}) {
  const warnings = []
  const live = liveSettings(sections)
  const overlay = createSettingsOverlay({
    settings: live.service,
    config,
    logger: { warn: (message) => warnings.push(message) },
    platform,
    fallbackTables: FALLBACK_TABLES,
  })
  return { overlay, live, warnings }
}

describe('mergeWhitelist', () => {
  it('unions defaults and additions, de-duplicated on first occurrence', () => {
    expect(mergeWhitelist(['a', 'b'], ['b', 'c'])).toEqual(['a', 'b', 'c'])
    expect(mergeWhitelist(['a'], ['a', 'a'])).toEqual(['a'])
  })

  it('skips non-string and empty entries and tolerates absent lists', () => {
    expect(mergeWhitelist(undefined, undefined)).toEqual([])
    expect(mergeWhitelist(['a'], ['', 42, null, 'b'])).toEqual(['a', 'b'])
  })
})

describe('readOnlyShellName', () => {
  it('names pwsh on win32 and bash elsewhere', () => {
    expect(readOnlyShellName('win32')).toBe('pwsh')
    expect(readOnlyShellName('linux')).toBe('bash')
    expect(readOnlyShellName('darwin')).toBe('bash')
  })
})

describe('createSettingsOverlay', () => {
  it('shellName follows the injected platform', () => {
    expect(makeOverlay({ platform: 'win32' }).overlay.shellName).toBe('pwsh')
    expect(makeOverlay({ platform: 'darwin' }).overlay.shellName).toBe('bash')
  })

  it('robashNow unions the three layers with first-occurrence dedupe', () => {
    const { overlay } = makeOverlay({
      config: { readOnlyBash: { allow: ['cfg-tool'] } },
      sections: { robash: { deny: ['user-deny'], gitAllow: ['user-git', 'user-git'] } },
    })
    const { lists } = overlay.robashNow()
    // config row additions land after the defaults
    expect(lists.bash.allow[0]).toBe(FALLBACK_TABLES.robashAllow[0])
    expect(lists.bash.allow[lists.bash.allow.length - 1]).toBe('cfg-tool')
    // settings list keys append to the defaults as well
    expect(lists.bash.deny).toEqual([...FALLBACK_TABLES.robashDeny, 'user-deny'])
    // first occurrence wins: the duplicated settings entry appears once
    expect(lists.bash.gitAllow.filter((entry) => entry === 'user-git')).toHaveLength(1)
    expect(lists.bash.gitAllow[0]).toBe(FALLBACK_TABLES.robashGitAllow[0])
  })

  it('an empty settings array adds nothing rather than clearing the list', () => {
    const { overlay } = makeOverlay({ sections: { robash: { allow: [], deny: [] } } })
    const { lists } = overlay.robashNow()
    expect(lists.bash.allow).toEqual(FALLBACK_TABLES.robashAllow)
    expect(lists.bash.deny).toEqual(FALLBACK_TABLES.robashDeny)
  })

  it('enabled is a plain switch with the settings section taking the last word', () => {
    expect(makeOverlay().overlay.robashNow().enabled).toBe(true)
    expect(makeOverlay({ config: { readOnlyBash: { enabled: false } } }).overlay.robashNow().enabled).toBe(false)
    // settings re-enables over a disabling row config
    expect(
      makeOverlay({ config: { readOnlyBash: { enabled: false } }, sections: { robash: { enabled: true } } }).overlay.robashNow().enabled,
    ).toBe(true)
    expect(makeOverlay({ sections: { robash: { enabled: false } } }).overlay.robashNow().enabled).toBe(false)
  })

  it('categoryChains replaces a named chain wholesale and warns on unknown categories', () => {
    const chain = [{ provider: 'acme', model: 'm1' }]
    const { overlay, warnings } = makeOverlay({
      sections: { delegate: { categoryChains: { quick: chain, bogus: chain } } },
    })
    const categories = overlay.categoriesNow()
    expect(categories.quick.chain).toEqual(chain)
    // the replacement keeps the category's other fields
    expect(categories.quick.reasoningEffort).toBe('low')
    expect(categories.bogus).toBeUndefined()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('bogus')
  })

  it('supervisionNow merges row config with the three settings keys', () => {
    const { overlay } = makeOverlay({
      config: { supervision: { maxRetries: 9, initialBackoffMs: 1 } },
      sections: { delegate: { supervisionMaxRetries: 3, supervisionMaxBackoffMs: 50 } },
    })
    expect(overlay.supervisionNow()).toEqual({ maxRetries: 3, initialBackoffMs: 1, maxBackoffMs: 50 })
  })

  it('resolves at read time: a commit is visible to the very next call', () => {
    const { overlay, live } = makeOverlay()
    expect(overlay.robashNow().lists.bash.allow).toEqual(FALLBACK_TABLES.robashAllow)
    live.commit('robash', { allow: ['late-tool'] })
    expect(overlay.robashNow().lists.bash.allow).toEqual([...FALLBACK_TABLES.robashAllow, 'late-tool'])
    live.commit('delegate', { supervisionMaxRetries: 7 })
    expect(overlay.supervisionNow().maxRetries).toBe(7)
  })

  it('works without a settings service (absent service = no-op overlay)', () => {
    const overlay = createSettingsOverlay({
      settings: undefined,
      config: {},
      logger: undefined,
      platform: 'linux',
      fallbackTables: FALLBACK_TABLES,
    })
    expect(overlay.robashNow().enabled).toBe(true)
    expect(overlay.supervisionNow()).toEqual({})
  })

  it('readOnlyTools appends the platform shell only when the guard is enabled', () => {
    expect(makeOverlay({ platform: 'win32' }).overlay.readOnlyTools(['read'])).toEqual(['read', 'pwsh'])
    expect(makeOverlay({ platform: 'linux' }).overlay.readOnlyTools(['read', 'bash'])).toEqual(['read', 'bash'])
    const disabled = makeOverlay({ sections: { robash: { enabled: false } } })
    expect(disabled.overlay.readOnlyTools(['read'])).toEqual(['read'])
  })
})
