#!/usr/bin/env node
/** Production ExtensionManager: manifest validation, idempotent load, persistence, remove — no Electron. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileFunction } from 'node:vm'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-extensions-'))
const out = path.join(tmp, 'compiled')
const home = path.join(tmp, 'home')
const extFile = path.join(tmp, 'extensions.json')
const previous = {
  HOME: process.env.HOME,
  USERPROFILE: process.env.USERPROFILE,
  AA_BROWSER_EXTENSIONS_FILE: process.env.AA_BROWSER_EXTENSIONS_FILE
}
let failures = 0

function load(name, deps) {
  const filename = path.join(out, 'main', `${name}.js`)
  const module = { exports: {} }
  compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })((name) => {
    assert.ok(Object.hasOwn(deps, name), `Unexpected production dependency: ${name}`)
    return deps[name]
  }, module, module.exports)
  return module.exports
}

/** Fake Electron session.extensions: records load/remove calls, assigns deterministic ids. */
function fakeSession() {
  const calls = []
  const ids = new Map()
  let seq = 0
  return {
    calls,
    extensions: {
      loadExtension(dir, options) {
        calls.push({ op: 'load', dir, options })
        const id = `ext-${++seq}`
        ids.set(dir, id)
        return Promise.resolve({ id })
      },
      removeExtension(id) {
        calls.push({ op: 'remove', id })
      }
    }
  }
}

function writeExtension(dir, manifest, extraFiles = []) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest))
  for (const [name, content] of extraFiles) fs.writeFileSync(path.join(dir, name), content)
}

try {
  process.env.HOME = home
  process.env.USERPROFILE = home
  process.env.AA_BROWSER_EXTENSIONS_FILE = extFile
  const compiled = spawnSync(process.execPath, [
    path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--ignoreConfig', '--noCheck', '--noResolve', '--rootDir', path.join(root, 'src'), '--outDir', out,
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--esModuleInterop',
    ...['extensions', 'atomic-json'].map((name) => path.join(root, 'src', 'main', `${name}.ts`))
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(compiled.status, 0, `Compilation failed: ${compiled.stdout}\n${compiled.stderr}`)

  const atomic = load('atomic-json', { 'node:fs': fs, 'node:path': path, 'node:crypto': crypto })
  const { ExtensionManager } = load('extensions', { 'node:fs': fs, 'node:os': os, 'node:path': path, './atomic-json': atomic })

  const good = path.join(tmp, 'good-extension')
  writeExtension(good, { name: 'Fixture Ext', version: '1.2.3', manifest_version: 3 })
  const mv2 = path.join(tmp, 'mv2-extension')
  writeExtension(mv2, { name: 'MV2 Ext', version: '0.1', manifest_version: 2 })
  const missing = path.join(tmp, 'missing-manifest')
  fs.mkdirSync(missing, { recursive: true })
  const badJson = path.join(tmp, 'bad-json')
  fs.mkdirSync(badJson, { recursive: true })
  fs.writeFileSync(path.join(badJson, 'manifest.json'), '{not json')
  const noName = path.join(tmp, 'no-name')
  writeExtension(noName, { version: '1.0', manifest_version: 3 })
  const notExist = path.join(tmp, 'no-such-dir')

  // Load success: returns manifest summary + deterministic id, records allowFileAccess
  const ses = fakeSession()
  const manager = new ExtensionManager()
  const entry = await manager.load(ses, good)
  assert.equal(entry.name, 'Fixture Ext')
  assert.equal(entry.version, '1.2.3')
  assert.equal(entry.manifestVersion, 3)
  assert.ok(entry.id.startsWith('ext-'), `expected assigned id, got ${entry.id}`)
  assert.equal(entry.path, path.resolve(good))
  assert.deepEqual(ses.calls[0], { op: 'load', dir: path.resolve(good), options: { allowFileAccess: false } }, 'extensions must not receive implicit local file access')

  // Idempotent reload of the same path returns the existing entry without a second load call
  const again = await manager.load(ses, path.join(good, 'sub', '..', '..') === path.join(good, 'sub') ? good : good)
  assert.equal(again.id, entry.id)
  assert.equal(ses.calls.length, 1, 'same path must not be loaded twice')

  // list reflects the single loaded extension
  assert.equal(manager.list().length, 1)
  assert.deepEqual(manager.list()[0], { id: entry.id, name: 'Fixture Ext', version: '1.2.3', manifestVersion: 3, path: path.resolve(good), enabled: true, permissions: [], hostPermissions: [], source: 'local-unpacked', status: 'running' })

  // Failure cases surface readable errors and don't touch the session
  const failCases = [
    [missing, 'manifest.json'],
    [badJson, 'manifest.json'],
    [noName, 'name'],
    [notExist, '不存在']
  ]
  for (const [dir, needle] of failCases) {
    await assert.rejects(() => manager.load(ses, dir), (err) => {
      assert.ok(String(err.message).includes(needle), `${dir}: expected "${needle}" in "${err.message}"`)
      return true
    })
  }
  assert.equal(ses.calls.length, 1, 'failed loads must not reach the session API')
  assert.deepEqual(JSON.parse(fs.readFileSync(extFile, 'utf8')), [path.resolve(good)], 'failed loads must not change the persisted registry')

  // Second extension loads alongside the first; persistence keeps both in order
  await manager.load(ses, mv2)
  assert.equal(manager.count, 2)
  assert.ok(fs.existsSync(extFile), 'successful load must persist the registry')
  const persisted = JSON.parse(fs.readFileSync(extFile, 'utf8'))
  assert.deepEqual(persisted, [path.resolve(good), path.resolve(mv2)])
  await manager.setEnabled(ses, entry.id, false)
  assert.equal(manager.list().find((item) => item.id === entry.id).enabled, false)
  const disabledRestore = new ExtensionManager()
  const disabledSession = fakeSession()
  await disabledRestore.restore(disabledSession)
  assert.equal(disabledSession.calls.length, 1, 'disabled extension must not be loaded into Chromium after restart')
  assert.equal(disabledRestore.list().find((item) => item.path === good).status, 'disabled')
  await manager.setEnabled(ses, entry.id, true)
  assert.equal(manager.list().find((item) => item.path === good).enabled, true)
  assert.equal(manager.checkUpdates().every((item) => !item.changed), true)
  writeExtension(good, { name: 'Fixture Ext', version: '1.3.0', manifest_version: 3, permissions: ['tabs'], host_permissions: ['https://fixture.test/*'] })
  assert.equal(manager.checkUpdates().find((item) => item.id === manager.list().find((item) => item.path === good).id).changed, true)

  // Profile stop removes background extension execution without losing enabled preferences.
  manager.suspend(ses)
  assert.equal(manager.list().every((item) => item.enabled && item.status === 'stopped'), true)
  const beforeRestart = ses.calls.filter((call) => call.op === 'load').length
  const restarted = await manager.restore(ses)
  assert.equal(restarted.restored, 2)
  assert.equal(manager.list().every((item) => item.status === 'running'), true)
  assert.equal(ses.calls.filter((call) => call.op === 'load').length, beforeRestart + 2)
  assert.equal(manager.count, 2, 'restart must not duplicate extension records')

  // Restore into a fresh session replays the persisted list in order
  const manager2 = new ExtensionManager()
  const ses2 = fakeSession()
  const restore = await manager2.restore(ses2)
  assert.equal(restore.restored, 2)
  assert.equal(restore.skipped.length, 0)
  assert.deepEqual(ses2.calls.map((c) => c.dir), [path.resolve(good), path.resolve(mv2)])

  // Restore exposes broken extensions while preserving their configuration for repair.
  fs.rmSync(good, { recursive: true, force: true })
  const manager3 = new ExtensionManager()
  const ses3 = fakeSession()
  const restore3 = await manager3.restore(ses3)
  assert.equal(restore3.restored, 1)
  assert.deepEqual(restore3.skipped, [path.resolve(good)])
  assert.equal(manager3.list().find((item) => item.path === good).status, 'error')
  assert.deepEqual(JSON.parse(fs.readFileSync(extFile, 'utf8')), [path.resolve(good), path.resolve(mv2)])

  // Remove unloads by id and by path, and persists the shrink
  const removed = manager3.remove(ses3, manager3.list().find((entry) => entry.status === 'running').id)
  assert.equal(removed.path, path.resolve(mv2))
  assert.deepEqual(ses3.calls[ses3.calls.length - 1], { op: 'remove', id: removed.id })
  assert.deepEqual(JSON.parse(fs.readFileSync(extFile, 'utf8')), [path.resolve(good)])
  assert.equal(manager3.count, 1)
  manager3.remove(ses3, manager3.list()[0].id)
  assert.equal(manager3.count, 0)
  assert.throws(() => manager3.remove(ses3, path.resolve(mv2)), /未找到该扩展/)

  // MAX cap: persisted list is truncated to 20 entries before restore
  const many = Array.from({ length: 25 }, () => '/fixture/overflow')
  fs.writeFileSync(extFile, JSON.stringify(many))
  const manager4 = new ExtensionManager()
  const ses4 = fakeSession()
  const restore4 = await manager4.restore(ses4)
  assert.ok(restore4.restored <= 20, 'restore must cap at MAX_EXTENSIONS')
  assert.ok(ses4.calls.length <= 20)

  // Corrupt registry file: restore treats it as empty, never throws
  fs.writeFileSync(extFile, '{{{broken')
  const manager5 = new ExtensionManager()
  const restore5 = await manager5.restore(fakeSession())
  assert.equal(restore5.restored, 0)

  console.log('PASS: ExtensionManager validates manifests, denies implicit file access, preserves errors and enabled preferences across stop/restore, caps at 20 and unloads on remove')
} catch (error) {
  failures++
  console.error('FAIL:', error.message)
  throw error
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tmp, { recursive: true, force: true })
  process.exitCode = failures ? 1 : 0
}
