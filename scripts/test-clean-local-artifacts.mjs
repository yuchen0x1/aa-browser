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
  makeFile('docs/internal/report.md', 'Evidence: `.local-verification/keep-this/result.json`, `.local-verification/referenced.log` and `bare-reference`')
  makeFile('.local-verification/keep-this/result.json')
  makeFile('.local-verification/bare-reference/result.json')
  makeFile('.local-verification/old-v017/resources/app.asar')
  makeFile('.local-verification/remove-this/profile/Cache/data_0')
  makeFile('.local-verification/old-version-update-success/result.json', JSON.stringify({ mode: 'live', status: 'passed' }))
  makeFile('.local-verification/old-version-update-failed/result.json', JSON.stringify({ mode: 'live', status: 'failed' }))
  makeFile('.local-verification/verification.log')
  makeFile('.local-verification/referenced.log')
  makeFile('out/main/index.js')
  makeFile('release/previous-installer.exe')
  makeFile('node_modules/dependency/index.js')
  makeDirectory('userData')

  const plan = planLocalArtifactCleanup(root)
  assert.deepEqual(new Set(plan), new Set([path.join('.local-verification', 'remove-this'), path.join('.local-verification', 'old-version-update-failed'), path.join('.local-verification', 'verification.log'), 'out']))
  assert.deepEqual(new Set(planLocalArtifactCleanup(root, { includeRelease: true })), new Set([...plan, 'release']))
  const preview = cleanLocalArtifacts({ root })
  assert.deepEqual(preview.removed, [])
  assert.ok(fs.existsSync(path.join(root, 'out/main/index.js')))

  const result = cleanLocalArtifacts({ root, apply: true })
  assert.deepEqual(new Set(result.removed), new Set(plan))
  assert.ok(fs.existsSync(path.join(root, '.local-verification/keep-this/result.json')))
  assert.ok(fs.existsSync(path.join(root, '.local-verification/bare-reference/result.json')))
  assert.ok(fs.existsSync(path.join(root, '.local-verification/old-v017/resources/app.asar')))
  assert.ok(fs.existsSync(path.join(root, '.local-verification/old-version-update-success/result.json')))
  assert.ok(!fs.existsSync(path.join(root, '.local-verification/verification.log')))
  assert.ok(fs.existsSync(path.join(root, '.local-verification/referenced.log')))
  assert.ok(fs.existsSync(path.join(root, 'release/previous-installer.exe')))
  assert.ok(fs.existsSync(path.join(root, 'node_modules/dependency/index.js')))
  assert.ok(fs.existsSync(path.join(root, 'userData')))
  assert.ok(!fs.existsSync(path.join(root, '.local-verification/remove-this')))
  assert.ok(!fs.existsSync(path.join(root, '.local-verification/old-version-update-failed')))
  assert.ok(!fs.existsSync(path.join(root, 'out')))

  assert.deepEqual(planLocalArtifactCleanup(root), [])
  assert.deepEqual(cleanLocalArtifacts({ root, apply: true, includeRelease: true }).removed, ['release'])
  assert.ok(!fs.existsSync(path.join(root, 'release')))
  assert.deepEqual(planLocalArtifactCleanup(root, { includeRelease: true }), [])

  for (const name of ['out', 'release', '.local-verification']) {
    const linkedRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-clean-artifacts-link-'))
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-clean-artifacts-outside-'))
    const sentinel = path.join(outside, 'keep.txt')
    fs.writeFileSync(sentinel, 'must stay')
    try {
      fs.symlinkSync(outside, path.join(linkedRoot, name), process.platform === 'win32' ? 'junction' : 'dir')
      assert.throws(() => cleanLocalArtifacts({ root: linkedRoot, apply: true, includeRelease: true }), /linked/)
      assert.equal(fs.readFileSync(sentinel, 'utf8'), 'must stay')
    } finally {
      fs.rmSync(linkedRoot, { recursive: true, force: true })
      fs.rmSync(outside, { recursive: true, force: true })
    }
  }

  console.log('PASS local artifact cleanup removes unreferenced logs and optional release outputs while preserving evidence, fixtures and dependencies')
} finally {
  fs.rmSync(root, { recursive: true, force: true })
}
