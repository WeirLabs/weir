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
    // braces inside single/double quotes are literal content, not structure
    "Write-Output 'literal { brace }'",
    'Write-Output "literal { brace }"',
    '$x = "literal { brace }"',
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
    ['& (\'ie\'+\'x\') "rm x"', /cannot be proven read-only/],
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

describe('robash-guard-pwsh: blanket brace rejection', () => {
  // R3: any bare { or } outside quotes refuses the whole call, at every
  // nesting level — PowerShell EXECUTES scriptblock bodies (Where-Object/
  // Sort-Object/Format-* parameters, hashtable values), and the executable
  // surface of expression syntax proved unenumerable across two review
  // rounds. Braces inside quotes stay literal (see the allowed corpus).
  const denied = [
    // the six R1 review payloads (deny-listed cmdlets hidden in the
    // scriptblock/hashtable parameters of allow-listed cmdlets)
    'Get-ChildItem | Where-Object { Set-Content x.txt pwned }',
    'Get-ChildItem | where { Remove-Item $_.FullName }',
    'Get-Process | Where-Object -FilterScript { iex "calc" }',
    'Get-ChildItem | Sort-Object { Set-Content a b }',
    'Get-Process | Select-Object @{e={iex "evil"}}',
    'Get-Process | Format-Table @{e={Remove-Item x}}',
    // a scriptblock on a deny-listed command: the brace refuses first
    'Invoke-Command { Get-Date }',
    // idiomatic read-only scriptblocks are refused along with the rest —
    // declared over-denial; the simplified-syntax forms stay allowed
    // (see the expression-lanes block below)
    "Get-ChildItem | Where-Object { $_.Name -like '*.ts' }",
    'Get-Process | Where-Object { $_.CPU -gt 10 }',
    'Get-ChildItem | Sort-Object { $_.Length }',
    "Get-Process | Select-Object @{n='Name';e={$_.Name}}",
    'Get-ChildItem | Where-Object { }',
    // hashtable literals
    '@{a=1}',
    "$x = @{a=1; b='two'}",
    // unbalanced braces fail closed through the same refusal
    'Get-ChildItem | Where-Object { Set-Content x.txt',
    'Get-Date }',
    // ${var} braced-variable reads — declared fail-closed over-denial
    'Write-Output ${HOME}',
  ]
  for (const command of denied) {
    it(`denies: ${command}`, () => {
      expect(denyReason(command)).toMatch(/scriptblock and hashtable literals/)
    })
  }
})

describe('robash-guard-pwsh: expression lanes (assignment RHS and (...) groups)', () => {
  // The R2 review payloads — the expression-mode execution surfaces that
  // killed the statement-level scriptblock design — pinned against the
  // two-rule validator in the two lanes where it still applies.
  const denied = [
    // static member access on an assignment right-hand side (:: rule)
    ['$x = [IO.File]::WriteAllText("a","b")', /static member access \(::\)/],
    // nested assignment: the rest of the statement is the RHS
    ['$a = $b = [IO.File]::WriteAllText("a","b")', /static member access \(::\)/],
    // assignment with a static-access RHS inside a (...) group
    ['Get-ChildItem | Where-Object Name -eq ($b = [IO.File]::WriteAllText("x","y"))', /static member access \(::\)/],
    // method invocation spellings on an assignment right-hand side
    ['$x = $_.Kill()', /method invocation is not allowed/],
    ['$x = (Get-Item a.txt).Delete()', /method invocation is not allowed/],
    ['$x = $_.Kill ()', /method invocation is not allowed/],
    ['$x = $_. Kill()', /method invocation is not allowed/],
    // method invocation spellings inside (...) expression groups
    ['($y.Kill())', /method invocation is not allowed/],
    ['($_.$m())', /method invocation is not allowed/],
    ['($_. Kill())', /method invocation is not allowed/],
    ['($x.Kill ().Bar)', /method invocation is not allowed/],
    ["($x.'Kill'())", /method invocation is not allowed/],
    // the same forms as bare statements stay denied (command path)
    ['$m = "Kill"; $_.$m()', /dynamic invocation cannot be proven read-only/],
    ['$_. Kill()', /not on the read-only allow list/],
    ['$x.Kill ().Bar', /not on the read-only allow list/],
    ["$x.'Kill'()", /dynamic invocation cannot be proven read-only/],
  ]
  for (const [command, pattern] of denied) {
    it(`denies: ${command}`, () => {
      expect(denyReason(command)).toMatch(pattern)
    })
  }

  const allowed = [
    // simplified-syntax cmdlet forms (property name / operator / value are
    // parameters, not a scriptblock) — the allow-face replacement for the
    // refused FilterScript idiom
    "Get-ChildItem | Where-Object Name -like '*.ts'",
    'Get-ChildItem | Sort-Object -Property Length',
    'Get-Process | Select-Object -Property Name',
    // literal right-hand sides
    '$x = 5',
    "$x = 's'",
    '$x = $(Get-Date)',
    '$x = (Get-Date)',
    // property reads with no following (...) invoke nothing
    '$x = $_.Name',
    '($_.Name)',
    '($x.Count -gt 1)',
    '(1 + 2)',
    "($_.Name -eq 'a')",
  ]
  for (const command of allowed) {
    it(`allows: ${command}`, () => {
      expect(denyReason(command)).toBe(undefined)
    })
  }
})

describe('robash-guard-pwsh: deny list double-name matching', () => {
  it('deny matches the raw alias name before expansion', () => {
    const lists = { ...LISTS, deny: [...DEFAULT_ROBASH_PWSH.deny, 'cat'] }
    expect(denyReason('cat x.txt', lists)).toMatch(/'cat' is explicitly denied/)
  })

  it('default lists still allow cat via the Get-Content alias (allow checks the expanded name)', () => {
    expect(denyReason('cat x.txt')).toBe(undefined)
  })
})

describe('robash-guard-pwsh: GIT_CONFIG_* smuggling', () => {
  it('refuses GIT_CONFIG_* environment assignments (git config through the environment)', () => {
    expect(denyReason("$env:GIT_CONFIG_COUNT='1'; $env:GIT_CONFIG_KEY_0='core.pager'; $env:GIT_CONFIG_VALUE_0='cat'; git -p log")).toMatch(/GIT_CONFIG_\*/)
    expect(denyReason('$env:GIT_CONFIG_VALUE_0=cat git log')).toMatch(/GIT_CONFIG_\*/)
  })
})

describe('robash-guard-pwsh: line continuations and lone CR (B1/N1 regression pins)', () => {
  const BT = '`'
  const LF = '\n'
  const CR = '\r'

  it('backtick-newline continuation cannot smuggle a method invocation past rule 2', () => {
    expect(denyReason(`$x = $_.Kill${BT}${LF}()`)).not.toBeUndefined()
    expect(denyReason(`$x = $_.${BT}${LF}Kill()`)).not.toBeUndefined()
    expect(denyReason(`$x = $_.Ki${BT}${LF}ll()`)).not.toBeUndefined()
    expect(denyReason(`$x = (Get-Item a.txt).${BT}${LF}Delete()`)).not.toBeUndefined()
    expect(denyReason(`($_.Kill${BT}${LF}())`)).not.toBeUndefined()
    expect(denyReason(`($x.Kill${BT}${LF}().Bar)`)).not.toBeUndefined()
    expect(denyReason(`$x = $_.Kill${BT}${CR}()`)).not.toBeUndefined()
    expect(denyReason(`$x = $_.Kill${BT}${CR}${LF}()`)).not.toBeUndefined()
    expect(denyReason(`$x = $_.Kill${BT}${LF} ()`)).not.toBeUndefined()
    expect(denyReason(`Write-Output $($x = $_.Kill${BT}${LF}())`)).not.toBeUndefined()
  })

  it('backtick-newline continuation cannot hide a subexpression inside an interpolating here-string', () => {
    expect(denyReason(`Write-Output @"Hello $${BT}${LF}(iex rm) there"@`)).not.toBeUndefined()
  })

  it('continuation join keeps benign multiline commands working', () => {
    expect(denyReason(`Get-Date ${BT}${LF}| Select-String x`)).toBe(undefined)
    expect(denyReason(`Get-ChildItem ${BT}${LF}-Recurse`)).toBe(undefined)
  })

  it('a lone CR is a statement terminator, not an argument gluer', () => {
    expect(denyReason(`Get-Date${CR}Set-Content a b`)).not.toBeUndefined()
    expect(denyReason(`Get-Date${CR}Remove-Item x`)).not.toBeUndefined()
    expect(denyReason(`Write-Output "a"${CR}iex "rm"`)).not.toBeUndefined()
    expect(denyReason(`Get-Date${CR}$env:GIT_CONFIG_COUNT="1"`)).not.toBeUndefined()
    expect(denyReason(`Get-Date${CR}Get-Location`)).toBe(undefined)
  })
})
