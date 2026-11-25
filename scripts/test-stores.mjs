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
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    esModuleInterop: true,
    skipLibCheck: true,
    types: ['node'],
    rootDir: path.join(root, 'src'),
    outDir: path.join(runDir, 'compiled'),
    paths: { '@shared/*': [path.join(root, 'src/shared/*')] }
  },
  files: ['settings.ts', 'history.ts', 'session-store.ts'].map((file) => path.join(root, 'src/main', file))
}))
const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc')
const compiled = spawnSync(process.execPath, [tsc, '--project', config], { cwd: root, stdio: 'inherit' })
if (compiled.status !== 0) process.exit(compiled.status ?? 1)
const { SettingsStore } = require(path.join(runDir, 'compiled/main/settings.js'))
const { HistoryStore } = require(path.join(runDir, 'compiled/main/history.js'))
const { SessionStore, normalizeSessionSnapshot } = require(path.join(runDir, 'compiled/main/session-store.js'))
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
  process.env.AA_BROWSER_SESSION_FILE = path.join(directory, 'session.json')
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
test('new users default to dark theme and explicit legacy themes are preserved', () => {
  fixture('theme-defaults')
  const fresh = new SettingsStore()
  assert.equal(fresh.get().theme, 'dark')
  const legacyFile = path.join(path.dirname(process.env.AA_BROWSER_SETTINGS_FILE), 'legacy.json')
  fs.writeFileSync(legacyFile, JSON.stringify({ locale: 'zh-CN', searchEngine: 'https://www.bing.com/search?q=' }))
  process.env.AA_BROWSER_SETTINGS_FILE = legacyFile
  const legacy = new SettingsStore()
  assert.equal(legacy.get().theme, 'dark')
  assert.equal(legacy.set({ theme: 'dark' }).theme, 'dark')
  assert.equal(legacy.set({ theme: 'system' }).theme, 'system')
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
test('session snapshots only keep web URLs, strip credentials, dedupe and cap tabs', () => {
  const snapshot = normalizeSessionSnapshot({
    version: 1,
    activeIndex: 99,
    tabs: [
      { url: 'https://user:secret@example.com/path#frag', title: 'A', id: 'tab01' },
      { url: 'file:///C:/Windows/win.ini' },
      { url: 'javascript:alert(1)' },
      { url: 'https://example.com/path#frag', id: 'tab01' },
      { url: 'http://example.org/b', title: 42, id: 'not a tab id' },
      ...Array.from({ length: 25 }, (_, i) => ({ url: `https://site${i}.example/` }))
    ]
  })
  assert.ok(snapshot)
  assert.equal(snapshot.tabs.length, 20)
  assert.equal(snapshot.tabs[0].url, 'https://example.com/path#frag')
  assert.equal(snapshot.tabs[1].url, 'http://example.org/b')
  assert.equal(snapshot.tabs[0].id, 'tab01', 'v2 snapshots keep the tab id for agent continuity')
  assert.equal(snapshot.tabs[1].id, undefined, 'malformed tab ids are dropped, not restored')
  assert.equal(snapshot.activeIndex, 19)
  assert.equal(JSON.stringify(snapshot).includes('secret'), false)
  assert.equal(normalizeSessionSnapshot({ version: 2, tabs: [{ url: 'https://example.com' }] }).tabs.length, 1)
  assert.equal(normalizeSessionSnapshot({ version: 4, tabs: [{ url: 'https://example.com' }] }), null)
  assert.equal(normalizeSessionSnapshot({ version: 1, tabs: [{ url: 'about:blank' }] }), null)
})
test('session store round-trips restorable tabs and clears the record when none remain', () => {
  fixture('session-roundtrip')
  const store = new SessionStore()
  const saved = store.save([
    { url: 'https://a.example/', title: 'A', id: 'tabaa' },
    { url: 'file:///tmp/x' },
    { url: 'https://b.example/', id: 'tabbb' }
  ], 1)
  assert.deepEqual(saved.tabs.map((tab) => tab.url), ['https://a.example/', 'https://b.example/'])
  assert.deepEqual(saved.tabs.map((tab) => tab.id), ['tabaa', 'tabbb'])
  assert.equal(saved.version, 3)
  assert.equal(saved.activeIndex, 1)
  const loaded = store.load()
  assert.deepEqual(loaded.tabs.map((tab) => tab.url), ['https://a.example/', 'https://b.example/'])
  assert.deepEqual(loaded.tabs.map((tab) => tab.id), ['tabaa', 'tabbb'], 'agent-facing tab ids survive a restart')
  assert.equal(loaded.activeIndex, 1)
  assert.equal(store.save([{ url: 'javascript:alert(1)' }]), null)
  assert.equal(store.load(), null)
})
test('corrupted or future session records are ignored instead of failing startup', () => {
  fixture('session-invalid')
  const file = process.env.AA_BROWSER_SESSION_FILE
  fs.writeFileSync(file, '{ broken JSON')
  assert.equal(new SessionStore().load(), null)
  fs.writeFileSync(file, JSON.stringify({ version: 99, tabs: [{ url: 'https://x.example/' }] }))
  assert.equal(new SessionStore().load(), null)
})
test('session v3 preserves equal URLs in different profiles and rejects unsafe profile identifiers', () => {
  const id = `p${'a'.repeat(24)}`
  const result = normalizeSessionSnapshot({ version: 3, tabs: [
    { url: 'https://same.example/', profileId: 'default' },
    { url: 'https://same.example/', profileId: id },
    { url: 'https://same.example/', profileId: id },
    { url: 'https://unsafe.example/', profileId: '../another' }
  ] })
  assert.deepEqual(result.tabs.map((tab) => tab.profileId), ['default', id])
})
fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify({ failures, results }, null, 2))
console.log(`${results.length - failures}/${results.length} persistence checks passed`)
process.exitCode = failures ? 1 : 0
