// Scenario: preset-defaults — task 9.5 integration for the preset library,
// portable import safety and the workspace-defaults round trip. Boot 1
// proves CRUD + import rejection (zero write) + unresolved binding that
// never self-enables + a defaults save; boot 2 is a FRESH session that must
// resolve the saved default (fixture-a visible) while the rejected import
// left nothing behind.
import { readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { lastOfRole, textChunks, toolCallChunks, transcript } from '../mock-kit.js'

const id = 'preset-defaults'
const prompt = 'preset-defaults-probe'
const boot2Prompt = 'preset-defaults-boot2'

const readJson = path => { try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return null } }

function decide(options, obs) {
  const history = obs?.transcript ?? transcript(options)
  const lastTool = lastOfRole(options, 'tool')

  // ---- boot 2: fresh session — just report what the catalog resolved ----
  if (history.includes(boot2Prompt)) {
    if (!history.includes('done enabledView')) {
      return toolCallChunks('preset_probe', { op: 'enabledView' })
    }
    return textChunks('boot2 catalog observed')
  }

  // ---- boot 1 parent brain ----
  if (lastTool.includes('PRESET_PROBE error')) return textChunks(`probe halted: ${lastTool.slice(0, 200)}`)
  if (!history.includes('done presetCreate')) {
    return toolCallChunks('preset_probe', {
      op: 'presetCreate', scope: 'global', presetId: 'team',
      document: { name: 'Team', selection: { skills: [], mcpServers: [], unresolvedRefs: [] } },
    })
  }
  if (!history.includes('done importDoc')) {
    return toolCallChunks('preset_probe', {
      op: 'importDoc',
      document: {
        version: 1, scope: 'global', presetId: 'poisoned', name: 'Poisoned',
        selection: { skills: [], mcpServers: [{ identity: 'docs', label: 'Docs', command: 'npx', env: { TOKEN: 'x' } }], unresolvedRefs: [] },
      },
    })
  }
  if (!history.includes('done importDoc:valid')) {
    return toolCallChunks('preset_probe', {
      op: 'importDoc', _marker: 'done importDoc:valid',
      document: {
        version: 1, scope: 'global', presetId: 'imported', name: 'Imported',
        selection: {
          skills: [{ kind: 'git', repository: 'https://example.com/team/skills.git', ref: 'main', name: 'stranger-skill' }],
          mcpServers: [{ identity: 'stranger-mcp', label: 'Stranger' }],
          unresolvedRefs: [],
        },
      },
    })
  }
  if (!history.includes('done presetLoad:poisoned')) {
    return toolCallChunks('preset_probe', { op: 'presetLoad', scope: 'global', presetId: 'poisoned', _marker: 'done presetLoad:poisoned' })
  }
  if (!history.includes('done presetLoad')) {
    return toolCallChunks('preset_probe', { op: 'presetLoad', scope: 'global', presetId: 'imported' })
  }
  if (!history.includes('done enabledView')) {
    return toolCallChunks('preset_probe', { op: 'enabledView' })
  }
  if (!history.includes('done saveDefault')) {
    return toolCallChunks('preset_probe', { op: 'saveDefault', snapshot: { skills: ['fixture-a'], mcpServers: [], unresolvedRefs: [] } })
  }
  return textChunks('boot1 preset defaults done')
}

function observe(obs) {
  const system = `${obs.system ?? ''}\n${obs.transcript ?? ''}`
  return {
    rejected: (obs.transcript ?? '').includes('rejected'),
    fixtureEnabled: (obs.transcript ?? '').includes('fixture-a'),
    boot2Observed: (obs.transcript ?? '').includes('boot2 catalog observed'),
    strangerLeaked: system.includes('stranger-skill') || system.includes('stranger-mcp'),
  }
}

/** Two-boot runner: seed boot, then a fresh session that resolves the default. */
async function run(ctx) {
  rmSync(join(ctx.IT_ROOT, 'home', 'orrery', 'profiles', 'orrery-it', 'capabilities', 'sessions'), { recursive: true, force: true })
  rmSync(join(ctx.IT_ROOT, 'home', 'orrery', 'profiles', 'orrery-it', 'capabilities', 'presets'), { recursive: true, force: true })
  rmSync(join(ctx.IT_ROOT, 'home', 'orrery', 'profiles', 'orrery-it', 'capabilities', 'workspaces'), { recursive: true, force: true })
  const trace1 = join(ctx.IT_ROOT, `trace-${id}.jsonl`)
  const trace2 = join(ctx.IT_ROOT, `trace-${id}-boot2.jsonl`)
  const boot1 = await ctx.spawnHeadless(['orrery-it', prompt], ctx.scenarioEnv(id, trace1, { ORRERY_IT_PRESET: '1' }))
  const boot2 = await ctx.spawnHeadless(['orrery-it', boot2Prompt], ctx.scenarioEnv(id, trace2, { ORRERY_IT_PRESET: '1' }))
  writeFileSync(join(ctx.IT_ROOT, 'ws', 'preset-boot2-outcome.json'), JSON.stringify({ code: boot2.code, stdout: boot2.stdout.slice(-400) }))
  return { scenario: id, trace: trace1, trace2: trace2, code: boot1.code, stdout: boot1.stdout, stderr: boot1.stderr }
}

function assert(run) {
  const requests2 = run.requests2 ?? []
  run.check('boot1 completed the preset flow', run.stdout.includes('boot1 preset defaults done'), run.stdout.slice(-400))
  run.check('the poisoned import was rejected', run.requests.some(r => r.rejected), JSON.stringify(run.requests.map(r => [r.rejected])).slice(0, 200))
  const report = readJson(join(run.ws, 'preset-defaults-report.json'))
  // The imported preset exists, but only with UNRESOLVED refs — nothing
  // self-enabled, nothing created, nothing started (9.3).
  run.check('the fresh session resolved the saved default', requests2.some(r => r.fixtureEnabled), JSON.stringify(requests2.map(r => [r.fixtureEnabled])).slice(0, 200))
  run.check('the rejected import left no preset behind', run.requests.some(r => (r.lastTool ?? '').includes('presetLoad:poisoned:absent')), '')
  run.check('unresolved imports never leaked into any catalog', requests2.every(r => !r.strangerLeaked) && run.requests.every(r => !r.strangerLeaked), '')
  const boot2Outcome = readJson(join(run.ws, 'preset-boot2-outcome.json'))
  run.check('boot2 exited cleanly', boot2Outcome?.code === 0 || boot2Outcome?.code === null, JSON.stringify(boot2Outcome))
  run.check('headless run exited cleanly', run.code === 0 || run.code === null, `code=${run.code} stderr=${run.stderr.slice(-400)}`)
}

export default { id, prompt, decide, observe, run, assert, env: { ORRERY_IT_PRESET: '1' } }
