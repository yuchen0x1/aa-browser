/** Update-restart marker regression: bridge must distinguish update restarts from normal exits. */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = path.join(root, '.local-verification', `update-restart-${Date.now()}-${process.pid}`)
fs.mkdirSync(dir, { recursive: true })
const config = path.join(dir, 'tsconfig.json')
fs.writeFileSync(config, JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    esModuleInterop: true,
    skipLibCheck: true,
    types: ['node'],
    rootDir: path.join(root, 'src'),
    outDir: path.join(dir, 'compiled')
  },
  files: [path.join(root, 'src/main/update-restart.ts')]
}))
const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc')
const compiled = spawnSync(process.execPath, [tsc, '--project', config], { cwd: root, stdio: 'inherit' })
if (compiled.status !== 0) process.exit(compiled.status ?? 1)

const markers = require(path.join(dir, 'compiled/main/update-restart.js'))

const connectionFile = path.join(dir, 'profile', 'connection.json')
fs.mkdirSync(path.dirname(connectionFile), { recursive: true })
let failures = 0
function test(label, fn) {
  try {
    fn()
    console.log(`PASS: ${label}`)
  } catch (error) {
    failures++
    console.error(`FAIL: ${label}: ${error.message}`)
  }
}

try {
  test('marker lives next to the connection discovery file', () => {
    assert.equal(markers.updateRestartMarkerPath(connectionFile), path.join(dir, 'profile', 'update-restart.json'))
  })
  test('write and read round-trip the update intent', () => {
    markers.writeUpdateRestartMarker(connectionFile, '0.9.0')
    const marker = markers.readUpdateRestartMarker(connectionFile)
    assert.equal(marker?.reason, 'update')
    assert.equal(marker?.from, '0.9.0')
    assert.ok(Math.abs(Date.now() - marker.at) < 5_000)
  })
  test('clear removes the marker before a normal launch', () => {
    markers.clearUpdateRestartMarker(connectionFile)
    assert.equal(markers.readUpdateRestartMarker(connectionFile), null)
  })
  test('expired or malformed markers are ignored instead of blocking auto-launch', () => {
    const file = markers.updateRestartMarkerPath(connectionFile)
    fs.writeFileSync(file, JSON.stringify({ reason: 'update', at: Date.now() - markers.UPDATE_RESTART_TTL_MS - 1 }))
    assert.equal(markers.readUpdateRestartMarker(connectionFile), null)
    fs.writeFileSync(file, JSON.stringify({ reason: 'something-else', at: Date.now() }))
    assert.equal(markers.readUpdateRestartMarker(connectionFile), null)
    fs.writeFileSync(file, '{ broken')
    assert.equal(markers.readUpdateRestartMarker(connectionFile), null)
    fs.rmSync(file, { force: true })
  })
} finally {
  fs.rmSync(dir, { recursive: true, force: true })
}

console.log(`${failures ? 'FAILED' : 'OK'}: update-restart marker checks`)
process.exitCode = failures ? 1 : 0
