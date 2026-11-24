import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-task-center-'))
const store = path.join(tmp, 'task-center.json')
const previousStore = process.env.AA_BROWSER_TASK_CENTER_FILE
process.env.AA_BROWSER_TASK_CENTER_FILE = store
const root = decodeURIComponent(new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
const out = path.join(tmp, 'compiled')
const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc')
const compiled = spawnSync('node', [
  tsc, '--ignoreConfig', '--noCheck', '--noResolve', '--outDir', out,
  '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--esModuleInterop',
  path.join(root, 'src/main/task-center.ts'), path.join(root, 'src/main/atomic-json.ts')
], { cwd: root, encoding: 'utf8', env: process.env })
if (compiled.status !== 0) throw new Error(`Compilation failed: ${compiled.error ?? ''}\n${compiled.stdout}\n${compiled.stderr}`)
const { TaskCenter, TaskStateError } = require(path.join(out, 'task-center.js'))

const center = new TaskCenter()
const normal = center.create({ id: 'normal', maxRetries: 1 })
assert.equal(normal.state, 'pending')
center.transition('normal', 'running')
center.transition('normal', 'completed')
assert.equal(center.get('normal').state, 'completed')
assert.throws(() => center.transition('normal', 'running'), TaskStateError)

const risky = center.create({ id: 'risky', highRisk: true, maxRetries: 1 })
center.transition(risky.id, 'running')
const waiting = center.requestRecovery(risky.id, 'renderer crash')
assert.equal(waiting.state, 'waiting')
assert.equal(waiting.history.at(-1).details.requiresConfirmation, true)
const recovering = center.requestRecovery(risky.id, 'user confirmed', true)
assert.equal(recovering.state, 'recovering')
assert.equal(recovering.retryCount, 1)

center.addStep('normal', { label: 'step-1', status: 'ok' })
center.persist(true)
const reloaded = new TaskCenter()
reloaded.load()
const restored = reloaded.get('normal')
assert.equal(restored.state, 'completed')
assert.equal(restored.steps?.[0].label, 'step-1')
assert.equal(reloaded.get('risky').state, 'interrupted', 'active tasks must not be mistaken for running after restart')
assert.match(reloaded.get('risky').error ?? '', /未自动重放/)

fs.writeFileSync(store, '{broken')
const corrupt = new TaskCenter()
corrupt.load()
assert.equal(corrupt.list().length, 0)
assert.ok(fs.readdirSync(tmp).some((name) => name.startsWith('task-center.json.corrupt-')))

fs.writeFileSync(store, JSON.stringify({ version: 999, tasks: [{ id: 'future' }] }))
const unsupported = new TaskCenter()
unsupported.load()
assert.equal(unsupported.list().length, 0)
assert.ok(fs.readdirSync(tmp).some((name) => name.startsWith('task-center.json.unsupported-')), 'unknown data versions are preserved before replacing the store')

fs.writeFileSync(store, JSON.stringify({ version: 1, tasks: [{
  id: 'pending-at-exit',
  state: 'pending',
  createdAt: Date.now(),
  updatedAt: Date.now(),
  highRisk: false,
  retryCount: 0,
  maxRetries: 2,
  history: [{ state: 'pending', at: Date.now() }]
}] }))
const pending = new TaskCenter()
pending.load()
assert.equal(pending.get('pending-at-exit').state, 'interrupted', 'tasks that never started are not restored as active')

if (previousStore === undefined) delete process.env.AA_BROWSER_TASK_CENTER_FILE
else process.env.AA_BROWSER_TASK_CENTER_FILE = previousStore
fs.rmSync(tmp, { recursive: true, force: true })

console.log('PASS: task lifecycle, durable state/steps, safe restart conversion, and corrupt-store recovery')

