import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { cleanLocalArtifacts, planLocalArtifactCleanup } from './clean-local-artifacts.mjs'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-clean-artifacts-'))
const makeDirectory = (relative) => fs.mkdirSync(path.join(root, relative), { recursive: true })
const makeFile = (relative, contents = 'fixture') => {
  const file = path.join(root, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, contents)
}

try {
  makeFile('docs/internal/report.md', 'Evidence: `.local-verification/keep-this/result.json` and `bare-reference`')
  makeFile('.local-verification/keep-this/result.json')
  makeFile('.local-verification/bare-reference/result.json')
  makeFile('.local-verification/old-v017/resources/app.asar')
  makeFile('.local-verification/remove-this/profile/Cache/data_0')
  makeFile('.local-verification/old-version-update-success/result.json', JSON.stringify({ mode: 'live', status: 'passed' }))
  makeFile('.local-verification/old-version-update-failed/result.json', JSON.stringify({ mode: 'live', status: 'failed' }))
  makeFile('.local-verification/verification.log')
  makeFile('out/main/index.js')
  makeFile('release/previous-installer.exe')
  makeFile('node_modules/dependency/index.js')
  makeDirectory('userData')

  const plan = planLocalArtifactCleanup(root)
  assert.deepEqual(new Set(plan), new Set([path.join('.local-verification', 'remove-this'), path.join('.local-verification', 'old-version-update-failed'), 'out']))
  const preview = cleanLocalArtifacts({ root })
  assert.deepEqual(preview.removed, [])
  assert.ok(fs.existsSync(path.join(root, 'out/main/index.js')))

  const result = cleanLocalArtifacts({ root, apply: true })
  assert.deepEqual(new Set(result.removed), new Set(plan))
  assert.ok(fs.existsSync(path.join(root, '.local-verification/keep-this/result.json')))
  assert.ok(fs.existsSync(path.join(root, '.local-verification/bare-reference/result.json')))
  assert.ok(fs.existsSync(path.join(root, '.local-verification/old-v017/resources/app.asar')))
  assert.ok(fs.existsSync(path.join(root, '.local-verification/old-version-update-success/result.json')))
  assert.ok(fs.existsSync(path.join(root, '.local-verification/verification.log')))
  assert.ok(fs.existsSync(path.join(root, 'release/previous-installer.exe')))
  assert.ok(fs.existsSync(path.join(root, 'node_modules/dependency/index.js')))
  assert.ok(fs.existsSync(path.join(root, 'userData')))
  assert.ok(!fs.existsSync(path.join(root, '.local-verification/remove-this')))
  assert.ok(!fs.existsSync(path.join(root, '.local-verification/old-version-update-failed')))
  assert.ok(!fs.existsSync(path.join(root, 'out')))

  const linkedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-clean-artifacts-link-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-clean-artifacts-outside-'))
  try {
    fs.symlinkSync(outside, path.join(linkedRoot, 'out'), process.platform === 'win32' ? 'junction' : 'dir')
    assert.throws(() => planLocalArtifactCleanup(linkedRoot), /linked path/)
  } finally {
    fs.rmSync(linkedRoot, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }

  console.log('PASS local artifact cleanup preserves referenced evidence, fixtures, logs, dependencies and release assets')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
