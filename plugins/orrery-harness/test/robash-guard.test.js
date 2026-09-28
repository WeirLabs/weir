import { describe, expect, it } from './helpers.js'
import { attachReadOnlyBashGuard, checkBashCommand, DEFAULT_ROBASH } from '../src/delegate/robash-guard.js'
import { DEFAULT_ROBASH_PWSH } from '../src/delegate/robash-guard-pwsh.js'

const LISTS = DEFAULT_ROBASH
// the guard takes both list sets; the pwsh git gate shares the bash gitAllow
const BOTH_LISTS = { bash: LISTS, pwsh: { ...DEFAULT_ROBASH_PWSH, gitAllow: LISTS.gitAllow } }

function allow(command) {
  return checkBashCommand(command, LISTS) === undefined
}

function denyReason(command) {
  return checkBashCommand(command, LISTS)
}

describe('robash-guard: allowed corpus', () => {
  const corpus = [
    'ls',
    'ls -la /tmp',
    'git status',
    'git log --oneline -5 | head',
    'git --no-pager log -3',
    'git -C /repo diff HEAD~1',
    'git -c color.ui=false show HEAD',
    'git blame -L 1,5 -- src/x.js',
    'FOO=bar ls',
    'FOO="a b" ls -la',
    'cat < in.txt',
    'ls 2>&1',
    'ls > /dev/null',
    'ls &> /dev/null',
    'ls 2> /dev/null',
    'echo $(ls)',
    'echo "$(git rev-parse HEAD)"',
    'echo `ls`',
    'find . -name "*.js" | grep src',
    'jq .dependencies < package.json',
    'echo $((1 + 2))',
    'sleep 1 && ls',
    'cd /tmp && ls',
    'A=1',
    'echo "a;b|c&&d"',
    "echo 'raw $(rm x)'",
    'test -f x && echo yes',
    '[ -f x ] && echo yes',
    'echo $(<file)',
    'echo a | grep a > /dev/null',
    'git --version',
  ]
  for (const command of corpus) {
    it(`allows: ${command}`, () => {
      expect(denyReason(command)).toBe(undefined)
    })
  }
})

describe('robash-guard: denied corpus', () => {
  const corpus = [
    ['rm -rf build/', /'rm' is explicitly denied/],
    ['ls && touch x', /'touch' is explicitly denied/],
    ['/bin/rm x', /'rm' is explicitly denied/],
    ['FOO=bar rm x', /'rm' is explicitly denied/],
    ['cat a > b', /write redirection to 'b'/],
    ['ls >> log.txt', /write redirection/],
    ['echo $(rm -rf x)', /'rm' is explicitly denied/],
    ['ls `touch x`', /'touch' is explicitly denied/],
    ['echo $(ls | rm x)', /'rm' is explicitly denied/],
    ['node -e "..."', /'node' is explicitly denied/],
    ['sh -c "ls"', /'sh' is explicitly denied/],
    ['ls | xargs rm', /'xargs' is explicitly denied/],
    ['sudo ls', /'sudo' is explicitly denied/],
    ['eval ls', /'eval' is explicitly denied/],
    ['env ls', /'env' is explicitly denied/],
    ['git push', /git subcommand 'push'/],
    ['git branch -D x', /git subcommand 'branch'/],
    ['git checkout .', /git subcommand 'checkout'/],
    ['git -c alias.log=!rm log', /git config key 'alias.log'/],
    ['git -c=alias.st=!x st', /git config key 'alias.st'/],
    ['git --exec-path', /git without a subcommand|not recognized/],
    ['find . -exec rm {} \\;', /find flag '-exec'/],
    ['find . -delete', /find flag '-delete'/],
    ['sort -o out.txt in.txt', /sort flag/],
    ['cat << EOF', /here-documents/],
    ['ls <(pwd)', /process substitution/],
    ['(ls)', /subshell grouping/],
    ['ls $(rm', /could not be proven read-only/],
    ['echo "unclosed', /unbalanced quotes/],
    ['if ls; then echo x; fi', /'if' is not on the read-only allow list/],
    ['unknowncmd --help', /'unknowncmd' is not on the read-only allow list/],
    ['echo $(( a[$(rm x)] ))', /'rm' is explicitly denied/],
  ]
  for (const [command, pattern] of corpus) {
    it(`denies: ${command}`, () => {
      expect(denyReason(command)).toMatch(pattern)
    })
  }
})

describe('robash-guard: custom lists', () => {
  it('honors a custom allow list', () => {
    const lists = { allow: ['ls', 'python'], gitAllow: [], deny: [] }
    expect(checkBashCommand('python script.py', lists)).toBe(undefined)
    expect(checkBashCommand('git status', lists)).toMatch(/'git' is not on the read-only allow list/)
  })

  it('deny list takes precedence over allow list', () => {
    const lists = { allow: ['ls'], gitAllow: [], deny: ['ls'] }
    expect(checkBashCommand('ls', lists)).toMatch(/explicitly denied/)
  })
})

describe('attachReadOnlyBashGuard', () => {
  function fakeAgent() {
    const guards = []
    return {
      guards,
      agent: {
        ctx: {
          tools: {
            guard: (fn) => {
              guards.push(fn)
              return () => {}
            },
          },
        },
      },
    }
  }

  it('registers one guard on the child scope', () => {
    const { agent, guards } = fakeAgent()
    attachReadOnlyBashGuard(agent, BOTH_LISTS)
    expect(guards).toHaveLength(1)
  })

  it('passes non-bash tools through', () => {
    const { agent, guards } = fakeAgent()
    attachReadOnlyBashGuard(agent, BOTH_LISTS)
    expect(guards[0]({ name: 'read', arguments: {} })).toBe(undefined)
  })

  it('dispatches pwsh executions to the pwsh parser with the pwsh lists', () => {
    const { agent, guards } = fakeAgent()
    attachReadOnlyBashGuard(agent, BOTH_LISTS)
    expect(guards[0]({ name: 'pwsh', arguments: { command: 'Get-Content x' } })).toBe(undefined)
    expect(guards[0]({ name: 'pwsh', arguments: { command: 'gci | Select-String foo' } })).toBe(undefined)
    expect(guards[0]({ name: 'pwsh', arguments: { command: 'iex "rm x"' } })).toMatch(/'iex' is explicitly denied/)
    expect(guards[0]({ name: 'pwsh', arguments: { command: 'ls' } })).toBe(undefined) // alias: pwsh-side ls is Get-ChildItem
    expect(guards[0]({ name: 'pwsh', arguments: { command: 'git status' } })).toBe(undefined) // shared gitAllow gate
    expect(guards[0]({ name: 'pwsh', arguments: { command: 'git push' } })).toMatch(/git subcommand 'push'/)
  })

  it('denies pwsh calls without a command string', () => {
    const { agent, guards } = fakeAgent()
    attachReadOnlyBashGuard(agent, BOTH_LISTS)
    expect(guards[0]({ name: 'pwsh', arguments: {} })).toMatch(/without a command string/)
  })

  it('denies bash calls without a command string', () => {
    const { agent, guards } = fakeAgent()
    attachReadOnlyBashGuard(agent, BOTH_LISTS)
    expect(guards[0]({ name: 'bash', arguments: {} })).toMatch(/without a command string/)
  })

  it('validates bash commands against the lists', () => {
    const { agent, guards } = fakeAgent()
    attachReadOnlyBashGuard(agent, BOTH_LISTS)
    expect(guards[0]({ name: 'bash', arguments: { command: 'git status' } })).toBe(undefined)
    expect(guards[0]({ name: 'bash', arguments: { command: 'rm x' } })).toMatch(/'rm' is explicitly denied/)
  })
})
