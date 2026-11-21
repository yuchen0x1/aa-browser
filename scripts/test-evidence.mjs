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

// 后续场景各用独立注册表，避免旧登记或环境配额互相影响。
function fixture(name, quota) {
  const dir = path.join(tmp, name)
  fs.mkdirSync(dir)
  const registry = path.join(dir, 'registry.json')
  process.env['AA_BROWSER_EVIDENCE_FILE'] = registry
  if (quota === undefined) delete process.env['AA_BROWSER_EVIDENCE_QUOTA_BYTES']
  else process.env['AA_BROWSER_EVIDENCE_QUOTA_BYTES'] = String(quota)
  return {
    dir,
    registry,
    manager: new EvidenceManager(),
    write(name, content = '12345678') {
      const file = path.join(dir, name)
      fs.writeFileSync(file, content)
      return file
    }
  }
}

function readEntries(f) {
  return JSON.parse(fs.readFileSync(f.registry, 'utf8')).entries
}

function writeEntries(f, entries) {
  fs.writeFileSync(f.registry, JSON.stringify({ version: 1, entries }))
}

function ageEntries(f) {
  const entries = readEntries(f)
  entries.forEach((e, i) => { e.ts = Date.now() - 2 * 3600 * 1000 + i })
  writeEntries(f, entries)
}

// 4) TTL 和配额都不能删除路径上的用户替换文件；同内容也不代表同一个文件。
for (const mode of ['ttl', 'quota']) {
  const f = fixture(`replacement-${mode}`, mode === 'quota' ? 5 : undefined)
  const edited = f.write('edited.png', 'before')
  const resized = f.write('resized.png', 'old')
  const replaced = f.write('replaced.png', 'identical')
  const survivor = f.write('survivor.png', 'owned')
  for (const file of [edited, resized, replaced]) {
    f.manager.record(file, 'screenshot', { ttlMs: mode === 'ttl' ? 1000 : 0 })
  }
  f.manager.record(survivor, 'screenshot')
  ageEntries(f)
  fs.writeFileSync(edited, 'after!') // 长度相同的原地修改
  fs.writeFileSync(resized, 'user replacement with a different size')
  const originalStat = fs.statSync(replaced)
  fs.renameSync(replaced, `${replaced}.original`)
  fs.writeFileSync(replaced, 'identical')
  fs.utimesSync(replaced, originalStat.atime, originalStat.mtime)
  assert.equal(hashFile(replaced), hashFile(`${replaced}.original`))
  const result = new EvidenceManager().sweep()
  assert.deepEqual(result, { removed: [], kept: 1, bytesFreed: 0 }, `${mode}: user replacements are not owned evidence`)
  assert.equal(fs.readFileSync(edited, 'utf8'), 'after!')
  assert.equal(fs.readFileSync(resized, 'utf8'), 'user replacement with a different size')
  assert.equal(fs.readFileSync(replaced, 'utf8'), 'identical')
  assert.equal(fs.readFileSync(survivor, 'utf8'), 'owned')
  assert.deepEqual(readEntries(f).map((e) => e.file), [survivor], 'stale ownership must be saved even without unlinks')
  assert.equal(new EvidenceManager().list().length, 1)
}
console.log('  PASS: TTL/quota preserve edited and identical-content replacement files and retire stale ownership')

// 5) 身份/大小相符也必须校验 hash，不能信任过时的缓存 hash。
{
  const f = fixture('hash-mismatch')
  const file = f.write('cached.png', 'user data')
  const staleHash = createHash('sha256').update('old bytes').digest('hex')
  const entry = f.manager.record(file, 'screenshot', { hash: staleHash, ttlMs: 1000 })
  assert.equal(entry.hash, staleHash, 'cached hash option remains supported')
  const stat = fs.lstatSync(file, { bigint: true })
  assert.deepEqual(entry.identity, Object.fromEntries(
    ['dev', 'ino', 'birthtimeNs', 'mtimeNs', 'ctimeNs'].map((key) => [key, stat[key].toString()])
  ), 'new entries persist lossless identity metadata')
  ageEntries(f)
  assert.deepEqual(new EvidenceManager().sweep(), { removed: [], kept: 0, bytesFreed: 0 })
  assert.equal(fs.readFileSync(file, 'utf8'), 'user data')
  assert.deepEqual(readEntries(f), [])
}
console.log('  PASS: deletion requires both recorded identity and current content hash')

// 6) 符号链接和目录不能作为普通证据删除或重新登记。
{
  const f = fixture('non-files', 1)
  const directory = f.write('directory.png')
  const junction = f.write('junction.png')
  const link = f.write('link.png')
  const dangling = f.write('dangling.png')
  for (const file of [directory, junction, link, dangling]) f.manager.record(file, 'screenshot', { ttlMs: 1000 })
  ageEntries(f)
  for (const file of [directory, junction, link, dangling]) fs.unlinkSync(file)
  fs.mkdirSync(directory)
  const targetDir = path.join(f.dir, 'target-dir')
  fs.mkdirSync(targetDir)
  const target = path.join(targetDir, 'user.png')
  fs.writeFileSync(target, '12345678')
  fs.symlinkSync(targetDir, junction, process.platform === 'win32' ? 'junction' : 'dir')
  let fileLinks = false
  try {
    fs.symlinkSync(target, link, 'file')
    fs.symlinkSync(path.join(f.dir, 'missing-target'), dangling, 'file')
    fileLinks = true
  } catch (error) {
    if (!['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) throw error
    console.log(`  SKIP: file symlink creation unavailable (${error.code}); directory symlink/junction still tested`)
  }
  assert.equal(f.manager.record(directory, 'screenshot'), null)
  assert.equal(f.manager.record(junction, 'screenshot'), null)
  if (fileLinks) assert.equal(f.manager.record(link, 'screenshot'), null)
  assert.deepEqual(new EvidenceManager().sweep(), { removed: [], kept: 0, bytesFreed: 0 })
  assert.equal(fs.lstatSync(directory).isDirectory(), true)
  assert.equal(fs.lstatSync(junction).isSymbolicLink(), true)
  assert.equal(fs.readFileSync(target, 'utf8'), '12345678')
  if (fileLinks) {
    assert.equal(fs.lstatSync(link).isSymbolicLink(), true)
    assert.equal(fs.lstatSync(dangling).isSymbolicLink(), true)
  }
  assert.deepEqual(readEntries(f), [])
}
console.log('  PASS: non-file outputs are preserved and their stale records are removed')

// 7) 历史条目不论有无身份信息都不能推断所有权；保留文件及查询记录，不现场认领。
{
  const f = fixture('legacy', 1)
  const file = f.write('legacy.png')
  const pdf = f.write('aa-page-123.pdf')
  const har = f.write('aa-123.har')
  const baseline = f.write('baseline.png')
  const download = f.write('download.zip')
  f.manager.record(file, 'screenshot', { ttlMs: 1000 })
  f.manager.record(pdf, 'pdf', { managed: true, ttlMs: 1000 })
  f.manager.record(har, 'har', { managed: true, ttlMs: 1000 })
  f.manager.record(baseline, 'baseline', { ttlMs: 1000 })
  f.manager.record(download, 'download', { ttlMs: 1000 })
  ageEntries(f)
  const legacy = readEntries(f).map(({ managed, ...entry }, i) => {
    if (i % 2 === 0) delete entry.identity
    return entry
  })
  writeEntries(f, legacy)
  const manager = new EvidenceManager()
  assert.equal(manager.list().length, 5, 'legacy entries remain readable')
  assert.ok(manager.list().every((e) => e.ttlMs === 0), 'report retained legacy records without an active TTL')
  assert.deepEqual(manager.sweep(Date.now() + 31 * 24 * 3600 * 1000), { removed: [], kept: 5, bytesFreed: 0 })
  for (const entry of legacy) assert.equal(fs.readFileSync(entry.file, 'utf8'), '12345678')
  assert.deepEqual(readEntries(f), legacy, 'do not silently infer ownership, replace metadata, or drop legacy lookup records')
  // 只有主流程重新明确登记的临时文件才恢复清理资格；其余历史记录继续保留。
  const rerecorded = new EvidenceManager()
  assert.ok(rerecorded.record(file, 'screenshot', { ttlMs: 1000 }))
  ageEntries(f)
  assert.deepEqual(new EvidenceManager().sweep(), { removed: [file], kept: 4, bytesFreed: 8 })
  for (const retained of [pdf, har, baseline, download]) assert.equal(fs.existsSync(retained), true)
}
console.log('  PASS: ambiguous legacy ownership is retained with and without identity, including generated-looking PDF/HAR names')

// 8) 注册表不可信：无效字段不能成为删除任意文件的依据，且仅删坏登记也必须落盘。
{
  const f = fixture('invalid-records', 1)
  const file = f.write('user.png')
  const entry = f.manager.record(file, 'screenshot', { ttlMs: 1000 })
  entry.ts = Date.now() - 2 * 3600 * 1000
  const invalid = [null, false, 1, 'entry', [], { file }]
  // Windows CI checks out on D: but creates fixtures on C:. path.relative
  // across drives returns an absolute path, which is a valid registry entry.
  const relativeFile = path.join('relative', 'user.png')
  assert.equal(path.isAbsolute(relativeFile), false, 'invalid-path fixture must actually be relative')
  for (const [key, value] of [
    ['file', relativeFile], ['file', `${file}\0`],
    ['kind', 'unknown'], ['kind', 'constructor'], ['kind', '__proto__'],
    ['bytes', -1], ['bytes', 1.5], ['bytes', '8'], ['bytes', Number.MAX_SAFE_INTEGER + 1],
    ['hash', ''], ['hash', 'not-a-sha256'], ['hash', null],
    ['ts', -1], ['ts', 'yesterday'], ['ts', null],
    ['ttlMs', -1], ['ttlMs', '1000'], ['ttlMs', null],
    ['managed', 'true'], ['managed', 'false'], ['managed', 1], ['managed', null],
    ['identity', null], ['identity', {}], ['identity', { ...entry.identity, ino: 'invalid' }]
  ]) invalid.push({ ...entry, [key]: value })
  for (const key of ['kind', 'bytes', 'hash', 'ts', 'ttlMs']) {
    const missing = { ...entry }
    delete missing[key]
    invalid.push(missing)
  }
  invalid.push({ ...entry, ttlMs: 'nonfinite' })
  fs.writeFileSync(f.registry, JSON.stringify({ version: 1, entries: invalid }).replace('"nonfinite"', '1e999'))
  const manager = new EvidenceManager()
  assert.deepEqual(manager.list(), [], 'malformed entries must be filtered before use')
  assert.deepEqual(manager.sweep(), { removed: [], kept: 0, bytesFreed: 0 })
  assert.equal(fs.readFileSync(file, 'utf8'), '12345678')
  assert.deepEqual(readEntries(f), [])
  for (const raw of ['null', '[]', '{"entries":null}', '{"entries":{}}', '{broken-json']) {
    fs.writeFileSync(f.registry, raw)
    assert.doesNotThrow(() => new EvidenceManager().sweep())
    assert.equal(fs.existsSync(file), true)
  }
}
console.log('  PASS: malformed registry entries cannot authorize deletion')

// 9) 重复登记不能把同一个文件重复计入配额。
{
  const f = fixture('duplicates', 16)
  const first = f.write('first.png')
  const second = f.write('second.png')
  f.manager.record(first, 'screenshot')
  f.manager.record(second, 'screenshot')
  ageEntries(f)
  const entries = readEntries(f)
  writeEntries(f, [entries[0], entries[0], entries[1]])
  assert.deepEqual(new EvidenceManager().sweep(), { removed: [], kept: 2, bytesFreed: 0 })
  assert.equal(fs.existsSync(first), true)
  assert.equal(fs.existsSync(second), true)
  assert.equal(readEntries(f).length, 2)
}
console.log('  PASS: duplicate paths do not inflate quota')

// 10) 检查/读取/删除失败都保留真实重试资格，不能把失败当作腾出了配额。
for (const operation of ['lstatSync', 'readFileSync', 'unlinkSync']) {
  const f = fixture(`retry-${operation}`, 10)
  const blocked = f.write('blocked.png')
  const next = f.write('next.png')
  const last = f.write('last.png')
  f.manager.record(blocked, 'screenshot', { ttlMs: 1000 })
  f.manager.record(next, 'screenshot', { ttlMs: 0 })
  f.manager.record(last, 'screenshot', { ttlMs: 0 })
  ageEntries(f)
  const original = fs[operation]
  let attempts = 0
  fs[operation] = function (file, ...args) {
    if (file === blocked) {
      attempts++
      throw Object.assign(new Error('simulated retryable filesystem error'), { code: operation === 'unlinkSync' ? 'EBUSY' : 'EACCES' })
    }
    return original.call(this, file, ...args)
  }
  let result
  try {
    result = new EvidenceManager().sweep()
  } finally {
    fs[operation] = original
  }
  assert.ok(attempts > 0, `${operation} fault must be exercised`)
  if (operation === 'unlinkSync') assert.equal(attempts, 1, 'do not retry a failed TTL unlink again in the quota pass')
  assert.deepEqual(result, { removed: [next, last], kept: 1, bytesFreed: 16 })
  assert.equal(fs.existsSync(blocked), true)
  assert.deepEqual(readEntries(f).map((e) => e.file), [blocked])
  assert.deepEqual(new EvidenceManager().sweep(), { removed: [blocked], kept: 0, bytesFreed: 8 }, 'a later sweep can retry the unchanged file')
}
console.log('  PASS: retryable filesystem errors retain records and only successful unlinks free quota/bytes')

// 11) 丢失的文件、被替换成文件的父目录，以及检查后消失的文件仅清除登记，不计释放字节。
{
  const f = fixture('missing')
  const missing = f.write('missing.png')
  const parent = path.join(f.dir, 'parent')
  fs.mkdirSync(parent)
  const nested = path.join(parent, 'nested.png')
  fs.writeFileSync(nested, 'evidence')
  f.manager.record(missing, 'screenshot')
  f.manager.record(nested, 'screenshot')
  fs.unlinkSync(missing)
  fs.unlinkSync(nested)
  fs.rmdirSync(parent)
  fs.writeFileSync(parent, 'user file replacing parent directory')
  assert.deepEqual(new EvidenceManager().sweep(), { removed: [], kept: 0, bytesFreed: 0 })
  assert.deepEqual(readEntries(f), [])
  assert.equal(fs.readFileSync(parent, 'utf8'), 'user file replacing parent directory')
}
{
  const f = fixture('missing-at-unlink')
  const file = f.write('vanishing.png')
  f.manager.record(file, 'screenshot', { ttlMs: 1000 })
  ageEntries(f)
  const unlink = fs.unlinkSync
  fs.unlinkSync = function (target, ...args) {
    if (target === file) {
      unlink.call(this, target, ...args)
      throw Object.assign(new Error('removed by another process'), { code: 'ENOENT' })
    }
    return unlink.call(this, target, ...args)
  }
  let result
  try { result = new EvidenceManager().sweep() } finally { fs.unlinkSync = unlink }
  assert.deepEqual(result, { removed: [], kept: 0, bytesFreed: 0 })
  assert.deepEqual(readEntries(f), [])
}
console.log('  PASS: missing paths retire ownership persistently without claiming deleted bytes')

// 12) 用户导出仍登记，但不参与 TTL/配额；受管 PDF/HAR 的 TTL、截图宽限期等不变。
{
  const f = fixture('ownership-contracts')
  const pdf = f.write('user-chosen.pdf')
  const har = f.write('aa-123.har') // 名称像默认输出也不能推断为受管文件。
  const managedPdf = f.write('automatic.pdf')
  const managedHar = f.write('automatic.har')
  const baseline = f.write('baseline.png')
  const download = f.write('download.zip')
  const screenshot = f.write('recent.png')
  const noTtl = f.write('no-ttl.png')
  const pdfEntry = f.manager.record(pdf, 'pdf', { managed: false, ttlMs: 1 })
  const harEntry = f.manager.record(har, 'har') // 未明确传入 managed 的 PDF/HAR 安全缺省为保留。
  for (const entry of [pdfEntry, harEntry]) {
    assert.equal(entry.managed, false)
    assert.equal(entry.ttlMs, 0)
  }
  assert.equal(f.manager.record(managedPdf, 'pdf', { managed: true }).ttlMs, 30 * 24 * 3600 * 1000)
  assert.equal(f.manager.record(managedHar, 'har', { managed: true }).ttlMs, 7 * 24 * 3600 * 1000)
  f.manager.record(baseline, 'baseline', { managed: true, ttlMs: 1 })
  f.manager.record(download, 'download', { managed: true, ttlMs: 1 })
  f.manager.record(screenshot, 'screenshot', { ttlMs: 1 })
  f.manager.record(noTtl, 'screenshot', { ttlMs: 0 })
  const entries = readEntries(f)
  for (const e of entries) if (e.file !== screenshot) e.ts -= 31 * 24 * 3600 * 1000
  writeEntries(f, entries)
  const now = Date.now()
  assert.deepEqual(new EvidenceManager().sweep(now + 1000), { removed: [managedPdf, managedHar], kept: 6, bytesFreed: 16 })
  process.env['AA_BROWSER_EVIDENCE_QUOTA_BYTES'] = '1'
  assert.deepEqual(new EvidenceManager().sweep(now + 1000), { removed: [noTtl], kept: 5, bytesFreed: 8 }, 'managed ttlMs=0 still participates in quota; grace applies to recent evidence')
  for (const retained of [pdf, har, baseline, download, screenshot]) assert.equal(fs.existsSync(retained), true)
  const manager = new EvidenceManager()
  assert.ok(manager.list().some((e) => e.file === pdf && e.kind === 'pdf' && e.ttlMs === 0))
  assert.equal(manager.hash(har), harEntry.hash, 'protected exports remain hashable')
  assert.equal(manager.forget(pdf), true, 'protected exports remain individually forgettable')
  assert.equal(fs.readFileSync(pdf, 'utf8'), '12345678', 'forget only removes metadata')
}
console.log('  PASS: explicit exports stay registered and protected; automatic exports, grace, and durable kinds retain their contracts')

{
  const f = fixture('export-quota', 8)
  const pdf = f.write('explicit.pdf')
  const har = f.write('explicit.har')
  const picture = f.write('user-saved.png')
  const managed = f.write('managed.har')
  f.manager.record(pdf, 'pdf', { managed: false })
  f.manager.record(har, 'har', { managed: false })
  assert.equal(f.manager.record(picture, 'context-shot').ttlMs, 0, 'right-click saves have no expiry')
  f.manager.record(managed, 'har', { managed: true, ttlMs: 0 })
  ageEntries(f)
  assert.deepEqual(new EvidenceManager().sweep(Date.now() + 31 * 86400000), { removed: [], kept: 4, bytesFreed: 0 }, 'user bytes must not expire or displace otherwise-within-quota managed evidence')
  process.env['AA_BROWSER_EVIDENCE_QUOTA_BYTES'] = '1'
  assert.deepEqual(new EvidenceManager().sweep(), { removed: [managed], kept: 3, bytesFreed: 8 }, 'automatic exports still participate in quota')
  for (const file of [pdf, har, picture]) assert.equal(fs.readFileSync(file, 'utf8'), '12345678')
}
console.log('  PASS: user exports do not consume managed quota, while automatic HAR exports remain sweepable')

// 13) 非受管历史数量达到上限也不能挤掉受管文件，超过旧总数上限的临时文件仍可清理。
{
  const f = fixture('managed-overflow')
  const old = f.write('old.png')
  const next = f.write('next.png')
  const exported = f.write('explicit.pdf')
  const seed = f.manager.record(old, 'screenshot', { ttlMs: 1000 })
  writeEntries(f, [seed, ...Array.from({ length: 4999 }, (_, i) => ({
    ...seed, file: path.join(f.dir, `missing-managed-${i}.png`)
  }))])
  const manager = new EvidenceManager()
  manager.record(next, 'screenshot', { ttlMs: 1000 })
  assert.equal(readEntries(f).length, 5001, 'do not evict managed records at the former total-entry cap')
  manager.record(exported, 'pdf')
  assert.ok(readEntries(f).some((e) => e.file === old), 'old managed file must not be forgotten')
  assert.ok(manager.list().some((e) => e.file === exported), 'new user exports remain visible beside many managed records')
  ageEntries(f)
  assert.deepEqual(new EvidenceManager().sweep(), { removed: [old, next], kept: 1, bytesFreed: 16 })
  assert.equal(fs.existsSync(exported), true)
  const retained = readEntries(f)[0]
  writeEntries(f, [seed, ...Array.from({ length: 5000 }, (_, i) => ({
    ...retained, file: path.join(f.dir, `missing-export-${i}.pdf`)
  }))])
  const capped = new EvidenceManager()
  capped.record(exported, 'pdf')
  const cappedEntries = readEntries(f)
  assert.equal(cappedEntries.filter((e) => !e.managed).length, 5000, 'user export lookup history remains bounded')
  assert.ok(cappedEntries.some((e) => e.file === old), 'protected-history pruning must never evict managed registrations')
}
console.log('  PASS: managed cleanup responsibility survives registry limits while user lookup history stays bounded')

fs.rmSync(tmp, { recursive: true, force: true })
console.log('All evidence lifecycle unit tests passed')
