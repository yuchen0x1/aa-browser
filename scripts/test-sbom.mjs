import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'

const sourceDateEpoch = '1704067200'
const manifest = {
  name: 'sbom-fixture',
  version: '7.8.9',
  description: 'Offline SBOM regression fixture',
  devDependencies: { electron: '^45.0.0' }
}

function lockFixture() {
  return {
    lockfileVersion: 3,
    packages: {
      '': { name: manifest.name, version: manifest.version },
      'node_modules/electron': { version: '45.3.2', dev: true, license: 'MIT' },
      'node_modules/production': { version: '1.0.0', license: 'MIT' },
      'node_modules/development': { version: '2.0.0', dev: true }
    }
  }
}

function fixture(t, { pkg = manifest, lock = lockFixture(), missingLock = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), 'aa-sbom-test-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const script = path.join(root, 'scripts', 'generate-sbom.mjs')
  const output = path.join(root, 'release', 'sbom.cdx.json')
  mkdirSync(path.dirname(script))
  copyFileSync(new URL('./generate-sbom.mjs', import.meta.url), script)
  writeFileSync(path.join(root, 'package.json'), JSON.stringify(pkg))
  if (!missingLock) {
    writeFileSync(path.join(root, 'package-lock.json'), typeof lock === 'string' ? lock : JSON.stringify(lock))
  }
  return {
    output,
    run() {
      const result = spawnSync(process.execPath, [script], {
        cwd: root,
        env: { ...process.env, SOURCE_DATE_EPOCH: sourceDateEpoch },
        encoding: 'utf8',
        timeout: 10_000,
        windowsHide: true
      })
      assert.ifError(result.error)
      return result
    }
  }
}

function generate(fixture) {
  const result = fixture.run()
  assert.equal(result.status, 0, result.stderr || result.stdout)
  return JSON.parse(readFileSync(fixture.output, 'utf8'))
}

function reject(fixture, message) {
  const result = fixture.run()
  assert.notEqual(result.status, 0, 'invalid input must fail generation')
  assert.match(result.stderr, message)
  assert.equal(existsSync(fixture.output), false, 'invalid input must not produce a BOM')
}

test('uses the exact locked Electron runtime, not the declarative range', (t) => {
  const lock = lockFixture()
  lock.packages['node_modules/tool/node_modules/electron'] = { version: '44.0.0', dev: true }
  lock.packages['node_modules/other/node_modules/electron'] = { version: '45.3.2', dev: true }
  const bom = generate(fixture(t, { lock }))
  const electron = bom.components.filter((component) => component.name === 'electron')
  assert.deepEqual(electron, [
    { type: 'library', name: 'electron', version: '44.0.0', purl: 'pkg:npm/electron@44.0.0', scope: 'optional' },
    {
      type: 'framework', name: 'electron', version: '45.3.2', purl: 'pkg:npm/electron@45.3.2', scope: 'required',
      licenses: [{ license: { name: 'MIT' } }]
    }
  ])
})

test('deduplicates by name/version with required scope winning in either order', (t) => {
  const lock = lockFixture()
  lock.packages = {
    ...lock.packages,
    'node_modules/tool/node_modules/shared': { version: '3.0.0', dev: true },
    'node_modules/shared': { version: '3.0.0' },
    'node_modules/tool/node_modules/production': { version: '1.0.0', dev: true },
    'node_modules/tool/node_modules/development': { version: '2.0.0', dev: true },
    'node_modules/tool/node_modules/@fixture/shared': { version: '4.0.0', dev: true },
    'node_modules/@fixture/shared': { version: '4.0.0', dev: false },
    'node_modules/legacy/node_modules/shared': { version: '2.0.0', dev: true }
  }
  const bom = generate(fixture(t, { lock }))
  const ids = bom.components.map((component) => `${component.name}@${component.version}`)
  assert.equal(new Set(ids).size, ids.length, 'component keys must be unique')
  assert.deepEqual(Object.fromEntries(bom.components.map((component) => [
    `${component.name}@${component.version}`, component.scope
  ])), {
    '@fixture/shared@4.0.0': 'required',
    'development@2.0.0': 'optional',
    'electron@45.3.2': 'required',
    'production@1.0.0': 'required',
    'shared@2.0.0': 'optional',
    'shared@3.0.0': 'required'
  })
  assert.equal(bom.components.find((component) => component.name === '@fixture/shared').purl,
    'pkg:npm/%40fixture/shared@4.0.0')
})

test('preserves CycloneDX and application versions and produces deterministic output', (t) => {
  const first = fixture(t)
  const bom = generate(first)
  const original = readFileSync(first.output, 'utf8')
  assert.equal(bom.bomFormat, 'CycloneDX')
  assert.equal(bom.specVersion, '1.5')
  assert.equal(bom.version, 1)
  assert.equal(bom.metadata.component.version, manifest.version)
  assert.equal(bom.metadata.component.purl, `pkg:npm/${manifest.name}@${manifest.version}`)
  assert.equal(bom.metadata.tools[0].version, manifest.version)
  assert.equal(bom.metadata.timestamp, '2024-01-01T00:00:00.000Z')
  generate(first)
  assert.equal(readFileSync(first.output, 'utf8'), original)
  const lock = lockFixture()
  lock.packages = Object.fromEntries(Object.entries(lock.packages).reverse())
  const reversed = fixture(t, { lock })
  generate(reversed)
  assert.equal(readFileSync(reversed.output, 'utf8'), original)
})

await test('rejects missing or malformed lock data without falling back to the manifest', async (t) => {
  const cases = [
    ['missing lock file', { missingLock: true }, /package-lock\.json/],
    ['malformed JSON', { lock: '{' }, /package-lock\.json/],
    ['null lock', { lock: null }, /package-lock\.json.*packages/],
    ['missing packages', { lock: {} }, /package-lock\.json.*packages/],
    ['invalid packages', { lock: { packages: [] } }, /package-lock\.json.*packages/],
    ['missing runtime', { lock: { packages: {
      'node_modules/tool/node_modules/electron': { version: '45.3.2', dev: true }
    } } }, /package-lock\.json.*node_modules\/electron/],
    ['invalid runtime entry', { lock: { packages: { 'node_modules/electron': [] } } }, /package-lock\.json.*node_modules\/electron/]
  ]
  for (const [name, options, message] of cases) {
    await t.test(name, (t) => reject(fixture(t, options), message))
  }
})

await test('rejects missing, ranged, or invalid locked runtime versions', async (t) => {
  for (const version of [undefined, null, 45, '', '^45.3.2', '~45.3.2', '45.x', '45.3',
    '45.3.2 || 46.0.0', 'v45.3.2', '045.3.2', '45.3.2-01', '45.3.2+bad..id', ' 45.3.2 ']) {
    await t.test(`version ${JSON.stringify(version)}`, (t) => {
      const lock = lockFixture()
      lock.packages['node_modules/electron'].version = version
      reject(fixture(t, { lock }), /package-lock\.json.*node_modules\/electron.*version.*exact/)
    })
  }
})

await test('accepts exact prerelease and build versions without rewriting them', async (t) => {
  for (const version of ['45.4.0-beta.1', '45.4.0-beta.1+build.7']) {
    await t.test(version, (t) => {
      const lock = lockFixture()
      lock.packages['node_modules/electron'].version = version
      const bom = generate(fixture(t, { lock }))
      assert.deepEqual(bom.components.filter((component) => component.name === 'electron').map((component) => [
        component.version, component.purl, component.type, component.scope
      ]), [[version, `pkg:npm/electron@${version}`, 'framework', 'required']])
    })
  }
})

test('generates from the repository lock in a temporary fixture', (t) => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
  const lock = JSON.parse(readFileSync(new URL('../package-lock.json', import.meta.url), 'utf8'))
  const bom = generate(fixture(t, { pkg, lock }))
  const runtime = bom.components.filter((component) => component.name === 'electron' && component.type === 'framework')
  assert.equal(runtime.length, 1)
  assert.equal(runtime[0].version, lock.packages['node_modules/electron'].version)
  assert.equal(runtime[0].scope, 'required')
  assert.equal(bom.metadata.component.version, pkg.version)
  const ids = bom.components.map((component) => `${component.name}@${component.version}`)
  assert.equal(new Set(ids).size, ids.length)
  assert.ok(bom.components.every((component) => ['required', 'optional'].includes(component.scope)))
})
