import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, realpathSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createEditLockPlugin } from '../src/edit-lock/index.js'
import { anchorFor } from '../src/hashline-edit/anchors.js'

for (const platform of ['darwin', 'linux', 'win32', 'freebsd']) {
  test(`${platform}: genuinely off never mounts protection or probes the filesystem`, () => {
    const get = () => ({ get: () => ({ enabled: false }) })
    assert.equal(createEditLockPlugin({ platform })({ get }), undefined)
    assert.equal(createEditLockPlugin({ platform })({ get }, { enabled: false }), undefined)
  })
}

for (const platform of ['darwin', 'linux', 'win32']) {
  test(`${platform}: supported mount retains the normal provider`, async () => {
    const services = new Map()
    const warnings = []
    const dispose = createEditLockPlugin({ platform })({
      get: name => services.get(name),
      reflect: { provide: (name, value) => services.set(name, value) },
      tools: { register: () => () => {} },
      on() {}, fs: {}, logger: { warn: value => warnings.push(value) },
    }, { enabled: true })
    assert.equal(typeof services.get('weirEditLock').publish, 'function')
    assert.deepEqual(warnings, [])
    await dispose()
  })
}

// Opt-in installed-runtime acceptance: no formal profile is modified. The full
// shipped patch (including both preset trees and every realm) is mirrored, with
// ONLY the edit-lock module replaced by its platform-injected factory adapter.
// WEIR_IT_DSH_EXEC must name the installed self-contained DSH CLI launcher.
const launcher = process.env.WEIR_IT_DSH_EXEC
for (const preset of ['weir', 'weir-creative']) for (const enabled of [true, false]) {
  test(`installed ${preset}: freebsd requested-${enabled ? 'on denies' : 'off permits'} editing`, { skip: !launcher, timeout: 120_000 }, () => {
    const base = realpathSync.native(mkdtempSync(join(tmpdir(), 'weir-platform-')))
    const home = join(base, 'home')
    const profile = join(home, 'profiles', 'preflight')
    const bundle = join(base, 'mirror')
    const workspace = join(base, 'work')
    for (const path of [profile, bundle, workspace, join(profile, 'node_modules')]) mkdirSync(path, { recursive: true })
    const product = fileURLToPath(new URL('..', import.meta.url))
    symlinkSync(product, join(profile, 'node_modules', 'weir-harness'), process.platform === 'win32' ? 'junction' : 'dir')
    symlinkSync(bundle, join(profile, 'node_modules', 'weir-platform-mirror'), process.platform === 'win32' ? 'junction' : 'dir')
    writeFileSync(join(bundle, 'package.json'), JSON.stringify({ name: 'weir-platform-mirror', version: '1.0.0', type: 'module', dsh: { bundle: { patch: './cordis.patch.yml' } } }))
    const adapter = join(bundle, 'platform.js')
    writeFileSync(adapter, `import { createEditLockPlugin, name, inject } from ${JSON.stringify(new URL('../src/edit-lock/index.js', import.meta.url).href)};\nexport { name, inject }; export const apply = createEditLockPlugin({ platform: 'freebsd' });\n`)
    const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
    assert.equal(patch.split("name: 'weir-harness/edit-lock'").length - 1, 2)
    writeFileSync(join(bundle, 'cordis.patch.yml'), patch.replaceAll("name: 'weir-harness/edit-lock'", `name: ${JSON.stringify(adapter)}`))
    const report = join(base, 'report.json')
    const probe = join(bundle, 'probe.js')
    writeFileSync(probe, `
import { writeFileSync } from 'node:fs'
export const name = 'platform-probe'
export const inject = ['agentPresets', 'tools']
export function apply(ctx) {
  ctx.on('agent/created', async ({ agent }) => {
    try {
      await ctx.agentPresets.select(agent, ${JSON.stringify(preset)})
      const service = ctx.agentPresets.serviceFor(agent, 'weirEditLock')
      const before = service?.startupFailure(agent)
      const call = (name, args) => ctx.tools.execute({ name, arguments: args, callId: 'probe-' + name, agent, signal: new AbortController().signal })
      const lsp = await call('lsp', { enabled: true })
      // Production hides stock edit and has no str_replace_editor; own-layer
      // sentinels prove these names also cannot bypass the preset's guard.
      let sentinelCalls = 0
      for (const name of ['edit', 'str_replace_editor']) agent.ctx.tools.register({
        name, description: 'Test editor sentinel', parameters: { type: 'object', properties: {} },
        output: { schema: { type: 'object' }, render: () => [] },
        async execute() { sentinelCalls++; return {} },
      })
      const results = {}
      results.read = await call('read', { file_path: 'a.txt' })
      results.write = await call('write', { file_path: 'a.txt', content: 'changed\\n' })
      results.hash_edit = await call('hash_edit', { file_path: 'a.txt', edits: [{ op: 'replace', pos: ${JSON.stringify(anchorFor(1, 'changed'))}, text: 'hash changed' }] })
      results.lsp_rename = await call('lsp_rename', { file_path: 'a.txt', line: 1, character: 1, new_name: 'changed' })
      results.edit = await call('edit', {})
      results.str_replace_editor = await call('str_replace_editor', {})
      writeFileSync(${JSON.stringify(report)}, JSON.stringify({ preset: ctx.agentPresets.composedPreset(agent.ctx), provider: !!service, before, lsp, sentinelCalls, results }))
      setImmediate(() => process.exit(0))
    } catch (error) {
      writeFileSync(${JSON.stringify(report)}, JSON.stringify({ failure: error.stack }))
      setImmediate(() => process.exit(1))
    }
  })
}
`)
    writeFileSync(join(profile, 'package.json'), JSON.stringify({ name: 'platform-profile', private: true, dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless', 'weir-platform-mirror'] } } }))
    writeFileSync(join(profile, 'cordis.patch.yml'), JSON.stringify([
      { id: 'weir-settings', config: { editLockEnabled: enabled, lspEnabled: true, hashlineHideStockEdit: true, notifyEnabled: false } },
      { id: 'weir-notify', disabled: true },
      { insert: [
        { id: 'cordis-host-runner', name: '@deepseek-ai/dsh-cordis-host-runner' },
        { id: 'cordis-inspect-providers', name: '@deepseek-ai/dsh-tool-cordis/host' },
        { id: 'platform-presets', name: '@deepseek-ai/dsh-agent-preset-registry', config: { default: preset } },
        { id: 'platform-probe', name: probe },
      ] },
    ]))
    writeFileSync(join(workspace, 'a.txt'), 'original\n')
    try {
      execFileSync(launcher, ['preflight', 'Verify platform preflight.'], { cwd: workspace, env: { ...process.env, DSH_HOME: home }, timeout: 90_000, encoding: 'utf8', stdio: 'pipe' })
    } catch (error) {
      assert.fail(`${error.message}\n${error.stdout ?? ''}\n${error.stderr ?? ''}\n${existsSync(report) ? readFileSync(report, 'utf8') : 'No probe report'}`)
    }
    const observed = JSON.parse(readFileSync(report, 'utf8'))
    assert.equal(observed.failure, undefined)
    assert.equal(observed.preset, preset)
    assert.equal(observed.provider, enabled)
    assert.equal(observed.lsp.isError, false, JSON.stringify(observed.lsp))
    assert.equal(observed.results.read.isError, false)
    if (enabled) {
      assert.match(observed.before.reason, /unsupported platform: freebsd/)
      for (const name of ['write', 'hash_edit', 'lsp_rename', 'edit', 'str_replace_editor']) {
        assert.equal(observed.results[name].isError, true, name)
        assert.match(observed.results[name].error.message, /unsupported platform: freebsd/, name)
      }
      assert.equal(observed.sentinelCalls, 0)
      assert.equal(readFileSync(join(workspace, 'a.txt'), 'utf8'), 'original\n')
    } else {
      assert.equal(observed.results.write.isError, false, JSON.stringify(observed.results.write))
      assert.equal(observed.results.hash_edit.isError, false, JSON.stringify(observed.results.hash_edit))
      assert.equal(observed.sentinelCalls, 2)
      assert.equal(readFileSync(join(workspace, 'a.txt'), 'utf8'), 'hash changed\n')
    }
    assert.equal(existsSync(join(workspace, '.weir', 'edit-lock')), false)
    assert.equal(existsSync(join(workspace, '.weir', '.edit-lock.publisher-reservation')), false)
  })
}
