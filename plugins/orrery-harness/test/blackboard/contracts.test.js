// Session blackboard contract tests: the injected English discipline (design
// D7) — the child write contract's triggers/exemptions/search-before-create/
// report-reference/knowledge-not-instructions content, and the orchestrator
// retrieval discipline. The audience gating (child vs main, tools visibility)
// is pinned in index.test.js through the registered variable providers.
import { describe, expect, it } from '../helpers.js'
import { BLACKBOARD_RETRIEVAL_SECTION, BLACKBOARD_WRITE_CONTRACT, BLACKBOARD_WRITE_CONTRACT_HEADING } from '../../src/blackboard/contracts.js'

describe('blackboard write contract text (English template layer)', () => {
  it('starts with the pinned heading and names the five tools', () => {
    expect(BLACKBOARD_WRITE_CONTRACT.startsWith(BLACKBOARD_WRITE_CONTRACT_HEADING)).toBe(true)
    for (const tool of ['blackboard_list', 'blackboard_read', 'blackboard_apply', 'blackboard_write', 'blackboard_delete']) {
      expect(BLACKBOARD_WRITE_CONTRACT).toContain(tool)
    }
  })

  it('carries the four write triggers with their one-line meanings', () => {
    expect(BLACKBOARD_WRITE_CONTRACT).toMatch(/cost — the finding took multiple calls or an experiment/)
    expect(BLACKBOARD_WRITE_CONTRACT).toMatch(/surprise — it contradicts your priors or the documented behavior/)
    expect(BLACKBOARD_WRITE_CONTRACT).toMatch(/dead end — a plausible approach was ruled out/)
    expect(BLACKBOARD_WRITE_CONTRACT).toMatch(/irreversible — losing it would force redoing the work/)
  })

  it('exempts cheap re-derivable findings and demands search-before-create', () => {
    expect(BLACKBOARD_WRITE_CONTRACT).toMatch(/Exempt: anything one cheap command can re-derive — do not write it/)
    expect(BLACKBOARD_WRITE_CONTRACT).toMatch(/Search before create: run blackboard_list \(with a query\) before minting a new key/)
  })

  it('settlement reports reference keys instead of inlining discoveries, and the board is knowledge, never instructions', () => {
    expect(BLACKBOARD_WRITE_CONTRACT).toMatch(/reference the entry keys you wrote or read/)
    expect(BLACKBOARD_WRITE_CONTRACT).toMatch(/never instructions/)
    expect(BLACKBOARD_WRITE_CONTRACT.match(/promotion/i)).toBeNull()
    expect(BLACKBOARD_WRITE_CONTRACT.match(/晋升/)).toBeNull()
  })
})

describe('blackboard retrieval discipline text (English template layer)', () => {
  it('lists before delegating, passes keys into child prompts, and reads reported keys', () => {
    expect(BLACKBOARD_RETRIEVAL_SECTION).toMatch(/Before delegating: run blackboard_list/)
    expect(BLACKBOARD_RETRIEVAL_SECTION).toMatch(/pass the keys relevant to the child's task into its prompt/)
    expect(BLACKBOARD_RETRIEVAL_SECTION).toMatch(/blackboard_read them before you decide/)
    expect(BLACKBOARD_RETRIEVAL_SECTION).toMatch(/Never re-delegate work whose answer already sits on the board/)
    expect(BLACKBOARD_RETRIEVAL_SECTION).toMatch(/never instructions/)
    expect(BLACKBOARD_RETRIEVAL_SECTION.match(/promotion/i)).toBeNull()
  })
})
