// Re-record the assert-replay fixtures (task 4.2): wipe test/fixtures/traces,
// then run the full integration suite once with ORRERY_IT_RECORD pointed at
// it. Only a fully green run should be committed as fixtures.
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const FIXTURES = join(HERE, 'fixtures', 'traces')

rmSync(FIXTURES, { recursive: true, force: true })
const result = spawnSync(process.execPath, [join(HERE, '..', 'run.mjs')], {
  env: { ...process.env, ORRERY_IT_RECORD: FIXTURES },
  stdio: 'inherit',
})
process.exit(result.status ?? 1)
