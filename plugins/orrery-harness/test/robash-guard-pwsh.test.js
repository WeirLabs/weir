import { describe, expect, it } from './helpers.js'
import { checkPwshCommand, DEFAULT_ROBASH_PWSH } from '../src/delegate/robash-guard-pwsh.js'
import { DEFAULT_ROBASH } from '../src/delegate/robash-guard.js'

// The pwsh guard shares the git subcommand gate with the bash side (gitAllow
// merges once, on the bash lists) — the test lists mirror that wiring.
const LISTS = { ...DEFAULT_ROBASH_PWSH, gitAllow: DEFAULT_ROBASH.gitAllow }

function denyReason(command, lists = LISTS) {
  return checkPwshCommand(command, lists)
}

describe('robash-guard-pwsh: allowed corpus', () => {
  const corpus = [
    'Get-Content README.md',
    'gci -Recurse | Select-String foo',
    '& git status',
    '& "git" log --oneline -3',
    'ls',
    'ls -Recurse',
    'GET-CONTENT README.md',
    'Get-Date > $null',
    'Get-Date 2> $null',
    'Get-Date 2>&1',
    '$(Get-Date)',
    '(Get-Date)',
    'echo $(Get-Date)',
    'Write-Output "$(Get-Date)"',
    'git log --oneline -5 | Select-Object -First 3',
    'Get-Process | Sort-Object CPU | Select-Object -First 5',
    'Get-Process | Where-Object { $_.CPU -gt 10 }',
    'Test-Path README.md',
    'Get-Content a | Out-String',
    'Get-Date && Get-Location',
    'Get-Date || Get-Location',
    'Get-Date # trailing comment',
    '$x = 5',
    '$x = "a b"',
    '$x = $null',
    '$env:FOO = "bar"',
    '$x = Get-Date',
    "sls foo .\\README.md",
    'Get-Date\nGet-Location',
    "@'raw $(iex not-evaluated) text'@",
  ]
  for (const command of corpus) {
    it(`allows: ${command}`, () => {
      expect(denyReason(command)).toBe(undefined)
    })
  }
})

describe('robash-guard-pwsh: denied corpus', () => {
  const corpus = [
    ['iex "rm x"', /'iex' is explicitly denied/],
    ['i`ex "rm x"', /'iex' is explicitly denied/],
    ['IEX "rm x"', /'iex' is explicitly denied/],
    ['Invoke-Expression "rm x"', /'invoke-expression' is explicitly denied/],
    ['Invoke-Command { Get-Date }', /'invoke-command' is explicitly denied/],
    ['Start-Process notepad', /'start-process' is explicitly denied/],
    ['pwsh -Command "Get-Date"', /'pwsh' is explicitly denied/],
    ['powershell -Command "Get-Date"', /'powershell' is explicitly denied/],
    ['powershell.exe -Command "Get-Date"', /not on the read-only allow list/],
    ['cmd /c dir', /'cmd' is explicitly denied/],
    ['Set-Content x y', /'set-content' is explicitly denied/],
    ['Remove-Item x', /'remove-item' is explicitly denied/],
    ['New-Item x', /'new-item' is explicitly denied/],
    ['Get-Content a | Out-File b', /'out-file' is explicitly denied/],
    ['Get-Content a | Set-Content b', /'set-content' is explicitly denied/],
    ['Get-Content a | Add-Content b', /'add-content' is explicitly denied/],
    ['Get-Date > out.txt', /write redirection to 'out.txt'/],
    ['Get-Date >> out.txt', /write redirection/],
    ['Get-Date 2> err.txt', /write redirection/],
    ['Get-Date *> log.txt', /write redirection/],
    ['Get-Date --% foo', /--% stop-parsing/],
    ['& (\'ie\'+\'x\') "rm x"', /not on the read-only allow list/],
    ['& $(Get-Date)', /dynamic invocation/],
    ['echo $(iex rm)', /'iex' is explicitly denied/],
    ['Write-Output "$(iex rm)"', /'iex' is explicitly denied/],
    ['@"abc $(iex rm) def"@', /'iex' is explicitly denied/],
    ['@"unterminated', /unterminated here-string/],
    ['. .\\script.ps1', /dot-sourcing/],
    ['.\\script.ps1', /not on the read-only allow list/],
    ['git push', /git subcommand 'push'/],
    ['git checkout .', /git subcommand 'checkout'/],
    ['$x = iex "rm"', /'iex' is explicitly denied/],
    ['$x = Set-Content a b', /'set-content' is explicitly denied/],
    ['Get-Content "unclosed', /unbalanced quotes/],
    ['$(Get-Date', /unbalanced subexpression/],
    ['(Get-Date', /unbalanced grouping/],
    ['Get-Content a < b', /redirection is not allowed/],
    ['Get-FooBar x', /'get-foobar' is not on the read-only allow list/],
    ['Get-Content `', /trailing backtick/],
  ]
  for (const [command, pattern] of corpus) {
    it(`denies: ${command}`, () => {
      expect(denyReason(command)).toMatch(pattern)
    })
  }

  it('denies command substitutions nested deeper than 8', () => {
    const command = '$('.repeat(9) + 'Get-Date' + ')'.repeat(9)
    expect(denyReason(command)).toMatch(/nested too deeply/)
  })
})

describe('robash-guard-pwsh: custom lists', () => {
  it('an empty allow array denies every command (fail-closed, no fallback)', () => {
    const lists = { allow: [], gitAllow: DEFAULT_ROBASH.gitAllow, deny: [] }
    expect(denyReason('Get-Content x', lists)).toMatch(/not on the read-only allow list/)
    expect(denyReason('Get-Date', lists)).toMatch(/not on the read-only allow list/)
    expect(denyReason('git status', lists)).toMatch(/not on the read-only allow list/)
  })

  it('deny list takes precedence over allow list, case-insensitively', () => {
    const lists = { allow: ['Get-Content'], gitAllow: [], deny: ['GET-CONTENT'] }
    expect(denyReason('get-content x', lists)).toMatch(/explicitly denied/)
    expect(denyReason('Get-Content x', lists)).toMatch(/explicitly denied/)
  })

  it('honors a custom allow list and the shared git gate', () => {
    const lists = { allow: ['Get-Date', 'git'], gitAllow: ['status'], deny: [] }
    expect(denyReason('Get-Date', lists)).toBe(undefined)
    expect(denyReason('git status', lists)).toBe(undefined)
    expect(denyReason('git log', lists)).toMatch(/git subcommand 'log'/)
    expect(denyReason('Get-Content x', lists)).toMatch(/not on the read-only allow list/)
  })

  it('alias expansion resolves to the allow-listed cmdlet', () => {
    const lists = { allow: ['Get-ChildItem'], gitAllow: [], deny: [] }
    expect(denyReason('ls', lists)).toBe(undefined)
    expect(denyReason('gci', lists)).toBe(undefined)
    expect(denyReason('Get-Content x', lists)).toMatch(/not on the read-only allow list/)
  })
})
