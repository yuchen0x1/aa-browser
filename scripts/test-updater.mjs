/** Updater scheduling/state regressions with an in-memory release provider (no network). */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import Module, { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, '.local-verification', `updater-${Date.now()}-${process.pid}`)
fs.mkdirSync(dir, { recursive: true })
const config = path.join(dir, 'tsconfig.json')
fs.writeFileSync(config, JSON.stringify({ compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', esModuleInterop: true, skipLibCheck: true, types: ['node'], rootDir: path.join(root, 'src'), outDir: path.join(dir, 'compiled') }, files: [path.join(root, 'src/main/updater.ts')] }))
const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc')
const result = spawnSync(process.execPath, [tsc, '--project', config], { cwd: root, stdio: 'inherit' })
if (result.status !== 0) process.exit(result.status ?? 1)
const provider = new EventEmitter()
let providerCalls = 0
provider.checkForUpdates = async () => { providerCalls++ }
const load = Module._load
let UpdateManager
try {
  Module._load = function (name, ...args) { return name === 'electron-updater' ? { autoUpdater: provider } : load.call(this, name, ...args) }
  ;({ UpdateManager } = require(path.join(dir, 'compiled/main/updater.js')))
} finally { Module._load = load }

const savedTimers = { setTimeout, clearTimeout, setInterval, clearInterval }
const timers = new Map()
let seq = 0
globalThis.setTimeout = (fn, delay) => { const id = ++seq; timers.set(id, { kind: 'timeout', fn, delay }); return id }
globalThis.setInterval = (fn, delay) => { const id = ++seq; timers.set(id, { kind: 'interval', fn, delay }); return id }
globalThis.clearTimeout = globalThis.clearInterval = (id) => timers.delete(id)
const checks = []
let failures = 0
async function test(label, fn) {
  timers.clear()
  provider.removeAllListeners()
  providerCalls = 0
  provider.checkForUpdates = async () => { providerCalls++ }
  try { await fn(); checks.push({ label, status: 'PASS' }); console.log(`PASS: ${label}`) }
  catch (error) { failures++; checks.push({ label, status: 'FAIL', error: error.message }); console.error(`FAIL: ${label}: ${error.message}`) }
}
try {
  await test('repeated settings saves keep exactly one startup check and one interval', () => {
    const manager = new UpdateManager('0.0.2', () => ({ autoUpdate: true, updateChannel: 'stable' }), true)
    manager.init(() => {})
    manager.refreshSettings(); manager.refreshSettings(); manager.refreshSettings()
    assert.equal([...timers.values()].filter((t) => t.kind === 'timeout').length, 1)
    assert.equal([...timers.values()].filter((t) => t.kind === 'interval').length, 1)
  })
  await test('disabling automatic updates also cancels the pending startup check', () => {
    let autoUpdate = true
    const manager = new UpdateManager('0.0.2', () => ({ autoUpdate, updateChannel: 'stable' }), true)
    manager.init(() => {})
    autoUpdate = false
    manager.refreshSettings()
    assert.equal(timers.size, 0)
  })
  await test('overlapping check requests call the provider only once', async () => {
    let finish
    provider.checkForUpdates = () => { providerCalls++; return new Promise((resolve) => { finish = resolve }) }
    const manager = new UpdateManager('0.0.2', () => ({ autoUpdate: false, updateChannel: 'stable' }), true)
    manager.init(() => {})
    const first = manager.check()
    const second = manager.check()
    assert.equal(providerCalls, 1)
    finish()
    await Promise.all([first, second])
  })
  await test('a completed download stays ready to install when a new check is requested', async () => {
    provider.checkForUpdates = async () => { providerCalls++ }
    const manager = new UpdateManager('0.0.2', () => ({ autoUpdate: false, updateChannel: 'stable' }), true)
    manager.init(() => {})
    provider.emit('update-downloaded', { version: '0.0.3', files: [], releaseDate: '2026-11-13' })
    await manager.check()
    assert.equal(providerCalls, 0)
    assert.equal(manager.getState().status, 'downloaded')
  })
  await test('shutdown cancels both updater timers', () => {
    const manager = new UpdateManager('0.0.2', () => ({ autoUpdate: true, updateChannel: 'stable' }), true)
    manager.init(() => {})
    manager.dispose()
    assert.equal(timers.size, 0)
  })
  await test('automatic updates enable background downloads without forced installation', () => {
    const manager = new UpdateManager('0.0.2', () => ({ autoUpdate: true, updateChannel: 'stable' }), true)
    manager.init(() => {})
    assert.equal(provider.autoDownload, true)
    assert.equal(provider.autoInstallOnAppQuit, false)
    assert.equal([...timers.values()].find((timer) => timer.kind === 'timeout').delay, 5000)
    assert.equal([...timers.values()].find((timer) => timer.kind === 'interval').delay, 15 * 60_000)
  })
  await test('update and download completion notices remain visible without opening settings', () => {
    const manager = new UpdateManager('0.0.2', () => ({ autoUpdate: true, updateChannel: 'stable' }), true)
    manager.init(() => {})
    provider.emit('update-available', { version: '0.0.3', files: [] })
    assert.equal(manager.getState().status, 'downloading')
    assert.equal(manager.getState().noticeVisible, true)
    manager.dismissNotice()
    provider.emit('download-progress', { percent: 50, transferred: 50, total: 100, bytesPerSecond: 1 })
    assert.equal(manager.getState().noticeVisible, false)
    provider.emit('update-downloaded', { version: '0.0.3', files: [] })
    assert.equal(manager.getState().noticeVisible, true)
  })
  await test('manual mode exposes an available update without background downloads', () => {
    const manager = new UpdateManager('0.0.2', () => ({ autoUpdate: false, updateChannel: 'stable' }), true)
    manager.init(() => {})
    provider.emit('update-available', { version: '0.0.3', files: [] })
    assert.equal(provider.autoDownload, false)
    assert.equal(manager.getState().status, 'available')
  })
  await test('automatic network retry has bounded backoff and visible diagnostics', async () => {
    provider.checkForUpdates = async () => { throw new Error('network unavailable') }
    const manager = new UpdateManager('0.0.2', () => ({ autoUpdate: true, updateChannel: 'stable' }), true)
    manager.init(() => {})
    for (const delay of [60_000, 5 * 60_000, 15 * 60_000]) {
      await manager.check()
      assert.equal(manager.getState().failedOperation, 'check')
      assert.equal(manager.getState().noticeVisible, true)
      assert.ok([...timers.values()].some((timer) => timer.delay === delay))
    }
    await manager.check()
    assert.equal(manager.getState().retryAt, undefined)
  })
  await test('background download errors are caught and retry the download rather than checking again', async () => {
    let failDownload
    const manager = new UpdateManager('0.0.2', () => ({ autoUpdate: true, updateChannel: 'stable' }), true)
    manager.init(() => {})
    provider.checkForUpdates = async () => {
      provider.emit('update-available', { version: '0.0.3', files: [] })
      return { downloadPromise: new Promise((_, reject) => { failDownload = reject }) }
    }
    await manager.check()
    failDownload(new Error('download connection reset'))
    await Promise.resolve()
    assert.equal(manager.getState().failedOperation, 'download')
    let downloads = 0
    provider.downloadUpdate = async () => { downloads++ }
    await manager.retry()
    assert.equal(downloads, 1)
  })
  await test('focus/network wake checks are throttled after a recent successful check', async () => {
    const manager = new UpdateManager('0.0.2', () => ({ autoUpdate: true, updateChannel: 'stable' }), true)
    manager.init(() => {})
    provider.checkForUpdates = async () => { providerCalls++; provider.emit('update-not-available', { version: '0.0.2', files: [] }) }
    await manager.checkIfDue(); await manager.checkIfDue()
    assert.equal(providerCalls, 1)
  })
  await test('development mode stays inert and shutdown rejects further checks', async () => {
    const development = new UpdateManager('0.0.2', () => ({ autoUpdate: true, updateChannel: 'stable' }), false)
    development.init(() => {})
    await development.checkIfDue()
    assert.equal(providerCalls, 0)
    const manager = new UpdateManager('0.0.2', () => ({ autoUpdate: true, updateChannel: 'stable' }), true)
    manager.init(() => {}); manager.dispose()
    await manager.checkIfDue()
    assert.equal(providerCalls, 0)
    assert.equal(provider.listenerCount('download-progress'), 0)
  })
} finally { Object.assign(globalThis, savedTimers) }
fs.writeFileSync(path.join(dir, 'result.json'), JSON.stringify({ failures, checks }, null, 2))
console.log(`${checks.length - failures}/${checks.length} updater checks passed (simulated provider, not a live update)`)
process.exitCode = failures ? 1 : 0
