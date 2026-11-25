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
const normal = center.create({
  id: 'normal',
  maxRetries: 1,
  idempotencyKey: 'session:call-1',
  sideEffect: { risk: 'none', destructive: false },
  source: { type: 'mcp', clientId: 7, sessionId: 'session-a', clientName: 'fixture' },
  browser: { pid: 123, instanceId: 'browser-a', startedAt: Date.now() },
  tab: { id: 'tab-a', url: 'https://example.test/', title: 'Fixture', rendererPid: 456 }
})
assert.equal(normal.state, 'pending')
center.transition('normal', 'running')
center.transition('normal', 'completed')
assert.equal(center.get('normal').state, 'completed')
assert.throws(() => center.transition('normal', 'running'), TaskStateError)
assert.equal(center.findByIdempotencyKey('session:call-1')?.id, 'normal', 'idempotency keys survive in-memory lookup')

const risky = center.create({ id: 'risky', highRisk: true, maxRetries: 1 })
center.transition(risky.id, 'running')
const waiting = center.requestRecovery(risky.id, 'renderer crash')
assert.equal(waiting.state, 'waiting')
assert.equal(waiting.history.at(-1).details.requiresConfirmation, true)
const recovering = center.requestRecovery(risky.id, 'user confirmed', true)
assert.equal(recovering.state, 'recovering')
assert.equal(recovering.retryCount, 1)

for (const state of ['interrupted', 'failed']) {
  const recoverable = center.create({ id: `risky-${state}`, highRisk: true })
  center.transition(recoverable.id, 'running')
  center.transition(recoverable.id, state)
  assert.equal(center.requestRecovery(recoverable.id, 'inspect side effects').state, 'waiting', `${state} writes must enter the approval wait state`)
}

center.addStep('normal', { label: 'step-1', status: 'ok' })
assert.equal(center.get('normal').currentStep, 'step-1')
center.persist(true)
const persisted = JSON.parse(fs.readFileSync(store, 'utf8'))
assert.equal(persisted.version, 2, 'new stores use the current schema version')
assert.equal(persisted.tasks.find((task) => task.id === 'normal')?.source?.sessionId, 'session-a')
assert.equal(persisted.tasks.find((task) => task.id === 'normal')?.tab?.rendererPid, 456)
const reloaded = new TaskCenter()
reloaded.load()
const restored = reloaded.get('normal')
assert.equal(restored.state, 'completed')
assert.equal(restored.steps?.[0].label, 'step-1')
assert.equal(restored.source?.clientName, 'fixture')
assert.equal(restored.recovery?.automaticReplay, false)
assert.equal(reloaded.findByIdempotencyKey('session:call-1')?.tab?.id, 'tab-a')
assert.equal(reloaded.get('risky').state, 'interrupted', 'active tasks must not be mistaken for running after restart')
assert.match(reloaded.get('risky').error ?? '', /未自动重放/)

const pendingPause = reloaded.create({ id: 'pending-pause' })
const pausedPending = reloaded.notePause(pendingPause.id, 'pause before dispatch')
assert.equal(pausedPending.state, 'pending', 'a not-yet-started task remains pending when pause is recorded')
assert.equal(pausedPending.history.at(-1).state, 'paused')
const pausedPersisted = JSON.parse(fs.readFileSync(store, 'utf8')).tasks.find((task) => task.id === pendingPause.id)
assert.equal(pausedPersisted.history.at(-1).reason, 'pause before dispatch', 'pending pause audit is persisted immediately')

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

const partialOriginal = {
  version: 2,
  tasks: [{
    id: 'partial-good',
    state: 'completed',
    createdAt: Date.now() - 10,
    updatedAt: Date.now() - 5,
    highRisk: false,
    retryCount: 0,
    maxRetries: 2,
    history: [{ state: 'completed', at: Date.now() - 5 }]
  }, { state: 'running', highRisk: true }]
}
fs.writeFileSync(store, JSON.stringify(partialOriginal))
const partial = new TaskCenter()
partial.load()
assert.equal(partial.get('partial-good')?.state, 'completed', 'valid records survive a partially corrupt store')
const partialBackup = fs.readdirSync(tmp).find((name) => name.startsWith('task-center.json.partial-'))
assert.ok(partialBackup, 'a partially corrupt store is preserved before rewriting')
assert.deepEqual(JSON.parse(fs.readFileSync(path.join(tmp, partialBackup), 'utf8')), partialOriginal, 'the partial backup contains the original rejected record')

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
assert.equal(JSON.parse(fs.readFileSync(store, 'utf8')).version, 2, 'v1 data is migrated to v2 on load')

fs.writeFileSync(store, JSON.stringify({ version: 2, tasks: [{
  id: 'v2-full',
  state: 'running',
  createdAt: Date.now() - 10,
  updatedAt: Date.now() - 5,
  highRisk: true,
  retryCount: 1,
  maxRetries: 2,
  currentStep: 'submit',
  source: { type: 'mcp', clientId: 3, sessionId: 'session-b', clientName: 'v2' },
  browser: { pid: 321, instanceId: 'browser-b' },
  tab: { id: 'tab-b', rendererPid: 654, recovery: { reason: 'crash', attempts: 1, at: Date.now() } },
  sideEffect: { risk: 'possible', destructive: true },
  idempotencyKey: 'session-b:9',
  history: [{ state: 'running', at: Date.now() - 5 }],
  steps: [{ at: Date.now() - 6, label: 'submit', status: 'started' }]
}] }))
const migrated = new TaskCenter()
migrated.load()
const recoveredFull = migrated.get('v2-full')
assert.equal(recoveredFull?.state, 'interrupted')
assert.equal(recoveredFull?.source?.sessionId, 'session-b')
assert.equal(recoveredFull?.tab?.rendererPid, 654)
assert.equal(recoveredFull?.sideEffect?.risk, 'possible')
assert.equal(recoveredFull?.recovery?.automaticReplay, false)
assert.equal(recoveredFull?.recovery?.resumable, false, 'a write with possible side effects is not marked automatically resumable')
assert.equal(recoveredFull?.recovery?.requiresConfirmation, true)

if (previousStore === undefined) delete process.env.AA_BROWSER_TASK_CENTER_FILE
else process.env.AA_BROWSER_TASK_CENTER_FILE = previousStore
fs.rmSync(tmp, { recursive: true, force: true })

console.log('PASS: task lifecycle, durable state/steps, safe restart conversion, and corrupt-store recovery')

