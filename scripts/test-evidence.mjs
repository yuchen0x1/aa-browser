#!/usr/bin/env node
/**
 * 证据文件生命周期单元测试（不需要 Electron）。
 * 把 evidence.ts / atomic-json.ts 临时编译成 ESM，用隔离的临时目录验证：
 *   1) sha256 与文件大小登记正确
 *   2) TTL 到期且超过宽限期后文件被删除
 *   3) 配额超限时按时间从旧到新淘汰，且 baseline/durable 文件不被删
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-evidence-'))
const out = path.join(tmp, 'compiled')

const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
const result = spawnSync(
  process.execPath,
  [
    tsc,
    path.join(root, 'src', 'main', 'evidence.ts'),
    path.join(root, 'src', 'main', 'atomic-json.ts'),
    '--ignoreConfig', '--outDir', out, '--target', 'ES2022', '--module', 'ESNext', '--moduleResolution', 'Bundler',
    '--skipLibCheck', '--esModuleInterop', '--types', 'node'
  ],
  { encoding: 'utf8' }
)
if (result.status !== 0) {
  console.error(result.stdout, result.stderr)
  process.exit(1)
}

// Node 把 .js 当 CJS；改为 .mjs 并修正相对导入
for (const name of ['evidence', 'atomic-json']) {
  const src = path.join(out, `${name}.js`)
  if (!fs.existsSync(src)) throw new Error(`编译产物缺失: ${src}`)
  let text = fs.readFileSync(src, 'utf8')
  text = text.replace(/from '\.\/atomic-json'/g, "from './atomic-json.mjs'")
  fs.writeFileSync(path.join(out, `${name}.mjs`), text)
}

const registry = path.join(tmp, 'registry.json')
process.env['AA_BROWSER_EVIDENCE_FILE'] = registry
const { EvidenceManager, hashFile } = await import(pathToFileURL(path.join(out, 'evidence.mjs')).href)

// 1) 登记与 hash
const fileA = path.join(tmp, 'a.png')
fs.writeFileSync(fileA, 'hello')
const mgr = new EvidenceManager()
const entry = mgr.record(fileA, 'screenshot', { ttlMs: 1000 })
assert.ok(entry)
assert.equal(entry.bytes, 5)
assert.equal(entry.hash, createHash('sha256').update('hello').digest('hex'))
assert.equal(entry.hash, hashFile(fileA))
console.log('  ✅ 证据登记记录 size/sha256/TTL')

// 2) TTL 到期（把登记时间改旧，模拟时间流逝）
const reg = JSON.parse(fs.readFileSync(registry, 'utf8'))
reg.entries[0].ts = Date.now() - 10 * 24 * 3600 * 1000
fs.writeFileSync(registry, JSON.stringify(reg))
const sweep1 = new EvidenceManager().sweep()
assert.ok(sweep1.removed.includes(fileA))
assert.equal(fs.existsSync(fileA), false)
console.log('  ✅ TTL 到期后清理过期临时证据')

// 3) 配额淘汰：只删最旧的临时证据，保留 baseline
delete process.env['AA_BROWSER_EVIDENCE_QUOTA_BYTES']
process.env['AA_BROWSER_EVIDENCE_QUOTA_BYTES'] = '10'
const f1 = path.join(tmp, 'old.png')
const f2 = path.join(tmp, 'new.png')
const baseline = path.join(tmp, 'baseline.png')
fs.writeFileSync(f1, '1234567890')
fs.writeFileSync(f2, '1234567890')
fs.writeFileSync(baseline, 'BASELINE-DATA')
const mgr3 = new EvidenceManager()
mgr3.record(f1, 'screenshot')
await new Promise((r) => setTimeout(r, 5))
mgr3.record(f2, 'screenshot')
mgr3.record(baseline, 'baseline')
const reg3 = JSON.parse(fs.readFileSync(registry, 'utf8'))
for (const e of reg3.entries) e.ts = Date.now() - 2 * 3600 * 1000 // 越过 60s 宽限期
fs.writeFileSync(registry, JSON.stringify(reg3))
const sweep2 = new EvidenceManager().sweep()
assert.equal(sweep2.removed.length, 1, `expected 1 removal, got ${JSON.stringify(sweep2)}`)
assert.ok(sweep2.removed[0].includes('old.png'), `oldest should go first: ${sweep2.removed[0]}`)
assert.equal(fs.existsSync(f1), false)
assert.equal(fs.existsSync(f2), true)
assert.equal(fs.existsSync(baseline), true)
console.log('  ✅ 配额超限按时间淘汰，baseline 等持久数据保留')

fs.rmSync(tmp, { recursive: true, force: true })
console.log('🎉 证据生命周期单元测试全部通过')
