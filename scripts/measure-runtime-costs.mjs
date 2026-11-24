#!/usr/bin/env node
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import Module, { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { performance } from 'node:perf_hooks'
import { fileURLToPath } from 'node:url'
import v8 from 'node:v8'

const script = fileURLToPath(import.meta.url)
const root = path.resolve(path.dirname(script), '..')
const require = createRequire(import.meta.url)
const TYPICAL_TASKS = 20
const TYPICAL_STEPS = 20
const FULL_TASKS = 200
const FULL_STEPS = 200
const PERSIST_SAMPLES = 7
const TYPICAL_LOAD_SAMPLES = 5
const FULL_LOAD_SAMPLES = 3
const RAPID_STEPS = 20
const DEBOUNCE_WAIT_MS = 1_300
const bytesPerMiB = 1024 * 1024
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const bytes = (value) => Buffer.byteLength(value)
const round = (value) => Math.round(value * 1_000) / 1_000

function stats(values) {
  assert.ok(values.length)
  const sorted = [...values].sort((left, right) => left - right)
  const percentile = (value) => sorted[Math.max(0, Math.ceil(value * sorted.length) - 1)]
  return {
    samples: values.length,
    total_ms: round(values.reduce((total, value) => total + value, 0)),
    mean_ms: round(values.reduce((total, value) => total + value, 0) / values.length),
    min_ms: round(sorted[0]),
    p50_ms: round(percentile(0.5)),
    p95_ms: round(percentile(0.95)),
    max_ms: round(sorted.at(-1)),
    raw_ms: values.map(round)
  }
}

function sha256(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function compileProduction(runDir) {
  const out = path.join(runDir, 'compiled')
  const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc')
  const compiled = spawnSync(process.execPath, [
    tsc,
    '--ignoreConfig',
    '--noCheck',
    '--noResolve',
    '--outDir',
    out,
    '--target',
    'ES2022',
    '--module',
    'NodeNext',
    '--moduleResolution',
    'NodeNext',
    '--esModuleInterop',
    path.join(root, 'src/main/task-center.ts'),
    path.join(root, 'src/main/atomic-json.ts')
  ], { cwd: root, encoding: 'utf8', timeout: 120_000 })
  assert.equal(compiled.status, 0, `Production compilation failed:\n${compiled.stdout}${compiled.stderr}`)
  return out
}

function loadInstrumentedTaskCenter(out) {
  const taskCenterModule = path.join(out, 'task-center.js')
  const atomicModule = require(path.join(out, 'atomic-json.js'))
  const originalLoad = Module._load
  const counters = { writes: 0, writeTimes: [] }
  let TaskCenter
  try {
    Module._load = function (request, parent, isMain) {
      if (request === './atomic-json' && path.resolve(parent?.filename ?? '') === taskCenterModule) {
        return {
          ...atomicModule,
          writeJsonAtomic(...args) {
            counters.writes += 1
            counters.writeTimes.push(performance.now())
            return atomicModule.writeJsonAtomic(...args)
          }
        }
      }
      return originalLoad.call(this, request, parent, isMain)
    }
    ;({ TaskCenter } = require(taskCenterModule))
  } finally {
    Module._load = originalLoad
  }
  const resetWrites = () => {
    counters.writes = 0
    counters.writeTimes = []
  }
  return { TaskCenter, counters, resetWrites }
}

function taskContext(index, tab, now) {
  return {
    client: 1,
    callId: index + 1,
    startedAt: now,
    tool: 'browser_click',
    source: 'runtime-cost-measurement',
    tabId: tab,
    currentTab: tab,
    rendererPid: 10_000 + index,
    browserPid: 9_000
  }
}

function step(index, taskIndex) {
  return {
    label: `step-${String(index + 1).padStart(3, '0')}`,
    status: index > 0 && index % 17 === 0 ? 'retry' : 'ok',
    detail: `browser_click completed on https://example.test/products/${String(taskIndex + 1).padStart(3, '0')}?step=${index + 1}; element=ref=e${12 + index}`
  }
}

function buildFixture(TaskCenter, store, taskCount, stepCount, prefix) {
  const center = new TaskCenter(store)
  const start = performance.now()
  for (let taskIndex = 0; taskIndex < taskCount; taskIndex++) {
    const id = `${prefix}-${String(taskIndex).padStart(3, '0')}`
    const now = Date.now() + taskIndex
    center.create({
      id,
      retryCount: 0,
      maxRetries: 2,
      context: taskContext(taskIndex, `tab-${String(taskIndex % 12).padStart(2, '0')}`, now)
    })
    center.transition(id, 'running')
    for (let stepIndex = 0; stepIndex < stepCount; stepIndex++) {
      center.addStep(id, step(stepIndex, taskIndex))
    }
    center.transition(id, 'completed')
  }
  center.persist(true)
  const buildMs = performance.now() - start
  const tasks = center.list()
  assert.equal(tasks.length, taskCount)
  assert.ok(tasks.every((task) => task.state === 'completed'))
  assert.ok(tasks.every((task) => task.steps?.length === stepCount))
  return { center, buildMs }
}

function verifyStore(store, expectedTasks, expectedSteps) {
  const raw = JSON.parse(fs.readFileSync(store, 'utf8'))
  assert.equal(raw.version, 2)
  assert.equal(raw.tasks.length, expectedTasks)
  assert.ok(raw.tasks.every((task) => task.state === 'completed'))
  assert.ok(raw.tasks.every((task) => task.steps.length === expectedSteps))
  return raw
}

function measurePersist(center, counters, resetWrites) {
  center.persist(true)
  resetWrites()
  const samples = []
  for (let index = 0; index < PERSIST_SAMPLES; index++) {
    const before = counters.writes
    const start = performance.now()
    center.persist(true)
    samples.push(performance.now() - start)
    assert.equal(counters.writes - before, 1)
  }
  return { ...stats(samples), atomic_writes: counters.writes }
}

function measureLoad(TaskCenter, store, counters, resetWrites, expectedTasks, expectedSteps, sampleCount) {
  const samples = []
  const writeCounts = []
  for (let index = 0; index < sampleCount; index++) {
    resetWrites()
    const start = performance.now()
    const center = new TaskCenter(store)
    const tasks = center.load()
    samples.push(performance.now() - start)
    writeCounts.push(counters.writes)
    assert.equal(tasks.length, expectedTasks)
    assert.ok(tasks.every((task) => task.state === 'completed'))
    assert.ok(tasks.every((task) => task.steps?.length === expectedSteps))
  }
  assert.ok(writeCounts.every((count) => count === 1))
  return { ...stats(samples), rewrites_per_load: 1 }
}

function fixtureResult(center, counters, resetWrites, store, buildMs, expectedTasks, expectedSteps, loadSamples) {
  const raw = verifyStore(store, expectedTasks, expectedSteps)
  const storeBytes = fs.statSync(store).size
  const persist = measurePersist(center, counters, resetWrites)
  const load = measureLoad(center.constructor, store, counters, resetWrites, expectedTasks, expectedSteps, loadSamples)
  const leftovers = fs.readdirSync(path.dirname(store)).filter((name) => name.endsWith('.tmp'))
  assert.deepEqual(leftovers, [])
  return {
    tasks: expectedTasks,
    steps_per_task: expectedSteps,
    persisted_steps: raw.tasks.reduce((total, task) => total + task.steps.length, 0),
    store_bytes: storeBytes,
    store_mib: round(storeBytes / bytesPerMiB),
    fixture_build_ms: round(buildMs),
    persist_sync: persist,
    load_and_rewrite: load,
    leftover_temp_files: leftovers.length
  }
}

function agentTaskRecord(baseSteps, index = 0) {
  const startedAt = 1_790_000_000_000 + index
  return {
    id: 100 + index,
    tool: 'browser_click',
    startedAt,
    client: 1,
    status: 'completed',
    finishedAt: startedAt + 5_000,
    error: 'Element became stale before the retry completed; latest snapshot was reloaded.',
    taskId: `1:${100 + index}:${startedAt}`,
    tabId: `tab-${String(index % 12).padStart(2, '0')}`,
    source: 'runtime-cost-measurement',
    updatedAt: startedAt + 5_000,
    retryCount: 1,
    steps: baseSteps.slice(-20).map((step) => ({ ...step }))
  }
}

function ipcEstimate(center) {
  const task = center.get('typical-000')
  assert.ok(task?.steps?.length === TYPICAL_STEPS)
  const record = agentTaskRecord(task.steps)
  const records = Array.from({ length: 24 }, (_, index) => agentTaskRecord(task.steps, index))
  const recordJson = JSON.stringify(record)
  const recordsJson = JSON.stringify(records)
  const recordV8 = v8.serialize(record)
  const recordsV8 = v8.serialize(records)
  return {
    record_steps: record.steps.length,
    record_json_bytes: bytes(recordJson),
    record_v8_bytes: recordV8.byteLength,
    records_24_json_bytes: bytes(recordsJson),
    records_24_v8_bytes: recordsV8.byteLength,
    definition: 'Serialization size only; not measured Electron IPC latency or transport framing.'
  }
}

async function measureDebounce(TaskCenter, store, counters, resetWrites) {
  const center = new TaskCenter(store)
  const tasks = center.load()
  const task = tasks.find((value) => value.id === 'typical-000')
  assert.ok(task?.steps?.length === TYPICAL_STEPS)
  center.persist(true)
  resetWrites()
  const start = performance.now()
  for (let index = 0; index < RAPID_STEPS; index++) {
    center.addStep(task.id, {
      label: `rapid-${String(index + 1).padStart(2, '0')}`,
      status: 'ok',
      detail: `Rapid progress update ${index + 1}`
    })
  }
  const enqueueMs = performance.now() - start
  assert.equal(counters.writes, 0)
  await sleep(DEBOUNCE_WAIT_MS)
  assert.equal(counters.writes, 1)
  assert.equal(counters.writeTimes.length, 1)
  const persisted = JSON.parse(fs.readFileSync(store, 'utf8'))
  assert.equal(persisted.version, 2)
  assert.equal(persisted.tasks.length, TYPICAL_TASKS)
  assert.equal(persisted.tasks.reduce((total, value) => total + value.steps.length, 0), TYPICAL_TASKS * TYPICAL_STEPS + RAPID_STEPS)
  assert.ok(persisted.tasks.some((value) => value.id === task.id && value.steps.length === TYPICAL_STEPS + RAPID_STEPS && value.steps.at(-1).label === `rapid-${RAPID_STEPS}`))
  return {
    rapid_updates: RAPID_STEPS,
    enqueue_ms: round(enqueueMs),
    wait_ms: DEBOUNCE_WAIT_MS,
    observed_atomic_writes: counters.writes,
    first_write_after_enqueue_ms: round(counters.writeTimes[0] - start),
    persisted: true
  }
}

function freeSpace(target) {
  if (typeof fs.statfsSync !== 'function') return null
  try {
    const value = fs.statfsSync(target)
    return {
      available_bytes: Number(value.bavail) * Number(value.bsize),
      total_bytes: Number(value.blocks) * Number(value.bsize)
    }
  } catch {
    return null
  }
}

async function main() {
  const startedAt = new Date()
  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-runtime-costs-'))
  const typicalStore = path.join(runDir, 'task-center-typical.json')
  const fullStore = path.join(runDir, 'task-center-full.json')
  const taskCenterSource = path.join(root, 'src/main/task-center.ts')
  const atomicSource = path.join(root, 'src/main/atomic-json.ts')
  const sourceHashes = { task_center: sha256(taskCenterSource), atomic_json: sha256(atomicSource) }
  const out = compileProduction(runDir)
  const { TaskCenter, counters, resetWrites } = loadInstrumentedTaskCenter(out)
  const typical = buildFixture(TaskCenter, typicalStore, TYPICAL_TASKS, TYPICAL_STEPS, 'typical')
  const full = buildFixture(TaskCenter, fullStore, FULL_TASKS, FULL_STEPS, 'full')
  const typicalResult = fixtureResult(typical.center, counters, resetWrites, typicalStore, typical.buildMs, TYPICAL_TASKS, TYPICAL_STEPS, TYPICAL_LOAD_SAMPLES)
  const fullResult = fixtureResult(full.center, counters, resetWrites, fullStore, full.buildMs, FULL_TASKS, FULL_STEPS, FULL_LOAD_SAMPLES)
  const debounce = await measureDebounce(TaskCenter, typicalStore, counters, resetWrites)
  assert.deepEqual(sourceHashes, { task_center: sha256(taskCenterSource), atomic_json: sha256(atomicSource) })
  const report = {
    status: 'PASS',
    started_at: startedAt.toISOString(),
    finished_at: new Date().toISOString(),
    environment: {
      node: process.version,
      typescript: require('typescript/package.json').version,
      platform: process.platform,
      architecture: process.arch,
      release: os.release(),
      cpu: os.cpus()[0]?.model ?? null,
      logical_cpus: os.cpus().length,
      temp_dir: runDir,
      typical_store: typicalStore,
      full_store: fullStore,
      free_space: freeSpace(runDir)
    },
    source_sha256: sourceHashes,
    fixtures: {
      typical: typicalResult,
      full: fullResult
    },
    debounce,
    agent_task_ipc_estimate: ipcEstimate(typical.center),
    definitions: {
      persist_sync: 'TaskCenter.persist(true): production JSON.stringify, temp-file write, fsync, close, and rename; seven hot local-disk samples.',
      load_and_rewrite: 'new TaskCenter(store).load(): production read, validation, clone/list, active-task normalization, and immediate atomic rewrite; startup path, not parse-only.',
      percentiles: 'Nearest-rank percentile over the listed samples; p95 with this sample count is not a robust tail estimate.',
      store_bytes: 'Exact task-center JSON file size in UTF-8 bytes.'
    },
    caveat: 'Windows/local-disk observations only; not a browser-wide performance, memory, input-latency, or cross-platform claim. IPC values are serialization byte estimates, not measured Electron IPC timing.',
    production_sources_unchanged: true
  }
  console.log(JSON.stringify(report, null, 2))
}

await main()
