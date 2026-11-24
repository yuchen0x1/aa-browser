#!/usr/bin/env node
/** 原子写入在 Windows 短暂文件锁下的有界重试与失败保留回归。 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { compileFunction } from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-atomic-json-'))
const out = path.join(tmp, 'compiled')
const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc')

try {
  const compiled = spawnSync(process.execPath, [
    tsc, '--ignoreConfig', '--noCheck', '--noResolve', '--outDir', out,
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    path.join(root, 'src/main/atomic-json.ts')
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(compiled.status, 0, `Compilation failed:\n${compiled.stdout}\n${compiled.stderr}`)

  function loadAtomic(fsOverride) {
    const filename = path.join(out, 'atomic-json.js')
    const module = { exports: {} }
    const localRequire = (specifier) => specifier === 'node:fs' ? fsOverride : require(specifier)
    compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(localRequire, module, module.exports)
    return module.exports
  }

  const target = path.join(tmp, 'state.json')
  fs.writeFileSync(target, '{"old":true}')
  let attempts = 0
  const flakyFs = {
    ...fs,
    renameSync(from, to) {
      attempts += 1
      if (attempts < 3) throw Object.assign(new Error('locked by indexer'), { code: 'EPERM' })
      return fs.renameSync(from, to)
    }
  }
  loadAtomic(flakyFs).writeJsonAtomic(target, { version: 2 })
  assert.equal(attempts, 3, 'transient EPERM must be retried with a bounded delay')
  assert.deepEqual(JSON.parse(fs.readFileSync(target, 'utf8')), { version: 2 })

  fs.writeFileSync(target, '{"old":true}')
  const lockedFs = {
    ...fs,
    renameSync() {
      throw Object.assign(new Error('persistent lock'), { code: 'EBUSY' })
    }
  }
  assert.throws(() => loadAtomic(lockedFs).writeJsonAtomic(target, { version: 3 }), /persistent lock/)
  assert.equal(fs.readFileSync(target, 'utf8'), '{"old":true}', 'failed replacement must preserve the previous file')
  assert.equal(fs.readdirSync(tmp).some((name) => name.endsWith('.tmp')), false, 'temporary file must be removed after failure')

  console.log('PASS: atomic JSON retries transient Windows locks and preserves the previous file on permanent failure')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
