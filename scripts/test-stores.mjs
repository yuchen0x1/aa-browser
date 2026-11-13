/** Persistence regressions against compiled production stores, using repo-local fixtures. */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const runDir = path.join(root, '.local-verification', `stores-${Date.now()}-${process.pid}`)
fs.mkdirSync(runDir, { recursive: true })
const config = path.join(runDir, 'tsconfig.json')
fs.writeFileSync(config, JSON.stringify({
  compilerOptions: { target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', esModuleInterop: true, skipLibCheck: true, types: ['node'], rootDir: path.join(root, 'src/main'), outDir: path.join(runDir, 'compiled') },
  files: ['settings.ts', 'history.ts'].map((file) => path.join(root, 'src/main', file))
}))
const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc')
const compiled = spawnSync(process.execPath, [tsc, '--project', config], { cwd: root, stdio: 'inherit' })
if (compiled.status !== 0) process.exit(compiled.status ?? 1)
const { SettingsStore } = require(path.join(runDir, 'compiled/settings.js'))
const { HistoryStore } = require(path.join(runDir, 'compiled/history.js'))
let failures = 0
const results = []
function test(label, fn) {
  try { fn(); results.push({ label, status: 'PASS' }); console.log(`PASS: ${label}`) }
  catch (error) { failures++; results.push({ label, status: 'FAIL', error: error.message }); console.error(`FAIL: ${label}\n${error.message}`) }
}
function fixture(name) {
  const directory = path.join(runDir, name)
  fs.mkdirSync(directory, { recursive: true })
  process.env.AA_BROWSER_SETTINGS_FILE = path.join(directory, 'settings.json')
  process.env.AA_BROWSER_HISTORY_DIR = directory
  return directory
}

test('invalid stored settings are normalized without leaking unsafe types', () => {
  fixture('invalid-settings')
  fs.writeFileSync(process.env.AA_BROWSER_SETTINGS_FILE, JSON.stringify({ searchEngine: 42, downloadDir: {}, fullSnapshot: 'false', allowedSites: [null, 8, ' https://example.com '] }))
  const value = new SettingsStore().get()
  assert.equal(typeof value.searchEngine, 'string')
  assert.equal(typeof value.downloadDir, 'string')
  assert.equal(value.fullSnapshot, false)
  assert.deepEqual(value.allowedSites, ['https://example.com'])
})
test('failed settings write throws and keeps previous in-memory settings', () => {
  fixture('failed-settings')
  fs.mkdirSync(process.env.AA_BROWSER_SETTINGS_FILE)
  const store = new SettingsStore()
  const previous = store.get()
  assert.throws(() => store.set({ fullSnapshot: true }))
  assert.deepEqual(store.get(), previous)
})
test('settings snapshots cannot mutate the stored allowlist', () => {
  fixture('settings-copy')
  const store = new SettingsStore()
  store.get().allowedSites.push('https://unexpected.example')
  assert.deepEqual(store.get().allowedSites, [])
})
test('settings reject non-HTTP search URLs', () => {
  fixture('settings-url')
  const store = new SettingsStore()
  assert.throws(() => store.set({ searchEngine: 'javascript:alert(1)' }))
})
test('mixed malformed history does not break suggestions or lose valid records', () => {
  const dir = fixture('invalid-history')
  fs.writeFileSync(path.join(dir, 'history.json'), JSON.stringify([null, { url: 7 }, { url: 'https://example.com', title: 12, ts: 'invalid', count: 'invalid' }, { url: 'https://valid.example', title: 'Valid', ts: 123, count: 2 }]))
  const store = new HistoryStore()
  const suggestions = store.suggest('valid')
  assert.equal(suggestions.length, 1)
  assert.equal(suggestions[0].title, 'Valid')
})
test('invalid history limit does not expand a bounded query', () => {
  fixture('history-limit')
  const store = new HistoryStore()
  store.add('https://one.example', 'One')
  store.add('https://two.example', 'Two')
  assert.deepEqual(store.list(0), [])
  assert.deepEqual(store.suggest('example', -1), [])
})
test('interrupted settings replacement preserves the old file and cleans temporary files', () => {
  const dir = fixture('atomic-settings')
  const store = new SettingsStore()
  store.set({ fullSnapshot: false })
  const oldFile = fs.readFileSync(process.env.AA_BROWSER_SETTINGS_FILE, 'utf8')
  const rename = fs.renameSync
  fs.renameSync = () => { throw new Error('simulated replacement failure') }
  try { assert.throws(() => store.set({ fullSnapshot: true })) }
  finally { fs.renameSync = rename }
  assert.equal(fs.readFileSync(process.env.AA_BROWSER_SETTINGS_FILE, 'utf8'), oldFile)
  assert.equal(store.get().fullSnapshot, false)
  assert.equal(fs.readdirSync(dir).some((file) => file.endsWith('.tmp')), false)
})
test('malformed JSON is backed up before a successful repair write', () => {
  const dir = fixture('preserve-corruption')
  const raw = '{ broken JSON'
  fs.writeFileSync(process.env.AA_BROWSER_SETTINGS_FILE, raw)
  const store = new SettingsStore()
  store.set({ fullSnapshot: true })
  const backups = fs.readdirSync(dir).filter((file) => file.includes('.invalid-'))
  assert.equal(backups.length, 1)
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), 'utf8'), raw)
})
fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify({ failures, results }, null, 2))
console.log(`${results.length - failures}/${results.length} persistence checks passed`)
process.exitCode = failures ? 1 : 0
