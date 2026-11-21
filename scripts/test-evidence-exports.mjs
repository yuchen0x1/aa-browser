#!/usr/bin/env node
/** Production export/lookup handlers with fixture PDF/HAR bytes and a temporary home only. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileFunction, constants } from 'node:vm'
import { TOOL_DEFS, TOOL_ANNOTATIONS } from '../src/shared/tool-defs.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-evidence-exports-'))
const out = path.join(tmp, 'compiled')
const home = path.join(tmp, 'home')
const downloads = path.join(home, '.aabrowser', 'downloads')
const harDir = path.join(home, '.aabrowser', 'har')
const registry = path.join(tmp, 'registry.json')
const env = {
  HOME: home,
  USERPROFILE: home,
  AA_BROWSER_DOWNLOAD_DIR: downloads,
  AA_BROWSER_EVIDENCE_FILE: registry,
  AA_BROWSER_EVIDENCE_QUOTA_BYTES: '1'
}
const previous = Object.fromEntries(Object.keys(env).map((key) => [key, process.env[key]]))

function load(name, deps) {
  const filename = path.join(out, 'main', `${name}.js`)
  const module = { exports: {} }
  compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], {
    filename,
    importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER
  })((name) => {
    assert.ok(Object.hasOwn(deps, name), `Unexpected production dependency: ${name}`)
    return deps[name]
  }, module, module.exports)
  return module.exports
}

try {
  Object.assign(process.env, env)
  assert.equal(os.homedir(), home, 'default export paths must resolve inside the temporary fixture home')
  const compiled = spawnSync(process.execPath, [
    path.join(root, 'node_modules', 'typescript', 'bin', 'tsc'),
    '--ignoreConfig', '--noCheck', '--noResolve', '--rootDir', path.join(root, 'src'), '--outDir', out,
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--esModuleInterop',
    ...['actions', 'tools', 'evidence', 'atomic-json'].map((name) => path.join(root, 'src', 'main', `${name}.ts`))
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(compiled.status, 0, `Compilation failed: ${compiled.error ?? ''}\n${compiled.stdout}\n${compiled.stderr}`)

  const electron = path.join(out, 'node_modules', 'electron')
  fs.mkdirSync(electron, { recursive: true })
  fs.writeFileSync(path.join(electron, 'package.json'), JSON.stringify({ exports: './index.mjs' }))
  fs.writeFileSync(path.join(electron, 'index.mjs'), "export const app = { getVersion: () => 'fixture-version' }\n")
  const atomic = load('atomic-json', { 'node:fs': fs, 'node:path': path, 'node:crypto': crypto })
  const { EvidenceManager } = load('evidence', {
    'node:fs': fs, 'node:os': os, 'node:path': path, 'node:crypto': crypto, './atomic-json': atomic
  })
  const manager = new EvidenceManager()
  const evidence = { getEvidenceManager: () => manager }
  const actions = load('actions', {
    electron: {}, '@snapshot/engine': { __aaSnapshot() {} }, '@snapshot/scripts': {}, './progress': {}, './evidence': evidence
  })
  const { buildTools } = load('tools', {
    '@shared/tool-defs.mjs': { TOOL_DEFS, TOOL_ANNOTATIONS }, '@snapshot/scripts': {}, './actions': actions,
    './evidence': evidence, './tabs': {}, './network': {}, './dialogs': {}, './assertions': {}, './frames': {},
    './visual': {}, './contrast': {}, './viewport': {}
  })
  let revision = 0
  const tab = {
    id: 'fixture-tab', title: 'Fixture', url: 'https://fixture.test/',
    view: { webContents: { isDestroyed: () => false, printToPDF: async () => Buffer.from(`fixture PDF ${++revision}`) } },
    net: { ensure: async () => {}, toHar: () => ({ log: { version: '1.2', comment: `fixture HAR ${++revision}` } }) }
  }
  const tools = buildTools({ active: () => tab }, 'about:blank', '', {}, {})
  const call = (name, args = {}) => {
    const tool = tools.find((tool) => tool.name === name)
    assert.ok(tool, `Missing tool: ${name}`)
    return tool.handler(args)
  }
  const entries = () => JSON.parse(fs.readFileSync(registry, 'utf8')).entries
  const userFiles = [path.join(downloads, 'aa-page-123.pdf'), path.join(harDir, 'aa-123.har')]
  for (const [i, kind] of ['pdf', 'har'].entries()) {
    const file = userFiles[i]
    const first = await call(`browser_${kind}`, { path: file })
    assert.equal(first.isError, undefined)
    const before = fs.readFileSync(file, 'utf8')
    const second = await call(`browser_${kind}`, { path: file })
    assert.equal(second.isError, undefined)
    assert.notEqual(fs.readFileSync(file, 'utf8'), before, 'explicit same-path export must still overwrite')
    assert.equal(entries().filter((entry) => entry.file === file).length, 1)
    assert.ok(entries().some((entry) => entry.file === file && entry.managed === false && entry.ttlMs === 0))
  }

  for (const kind of ['pdf', 'har']) {
    const result = await call(`browser_${kind}`)
    assert.equal(result.isError, undefined)
    const entry = entries().find((entry) => entry.kind === kind && entry.managed === true)
    assert.ok(entry, `automatic ${kind} must remain managed`)
    assert.equal(entry.ttlMs, (kind === 'pdf' ? 30 : 7) * 86400000)
    assert.equal(path.dirname(entry.file), kind === 'pdf' ? downloads : harDir)
  }
  const automatic = entries().filter((entry) => entry.managed)
  const reclaimed = automatic.find((entry) => entry.kind === 'pdf').file
  assert.equal((await call('browser_pdf', { path: reclaimed })).isError, undefined)
  userFiles.push(reclaimed)
  assert.equal(entries().find((entry) => entry.file === reclaimed).managed, false, 'explicit re-export must revoke old managed ownership')
  // Generate a separate automatic PDF without timestamp collision with the re-exported file.
  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal((await call('browser_pdf')).isError, undefined)
  const managedFiles = entries().filter((entry) => entry.managed).map((entry) => entry.file)
  assert.equal(managedFiles.length, 2)
  const contents = new Map(userFiles.map((file) => [file, fs.readFileSync(file, 'utf8')]))
  const sweep = manager.sweep(Date.now() + 31 * 86400000)
  assert.deepEqual(new Set(sweep.removed), new Set(managedFiles))
  assert.equal(sweep.kept, userFiles.length)
  for (const file of managedFiles) assert.equal(fs.existsSync(file), false)
  for (const file of userFiles) assert.equal(fs.readFileSync(file, 'utf8'), contents.get(file))
  const listing = await call('browser_evidence', { action: 'list' })
  assert.equal(listing.isError, undefined)
  assert.ok(listing.content[0].text.includes('保留'))
  for (const file of userFiles) assert.ok(listing.content[0].text.includes(file))
  const hashed = await call('browser_evidence', { action: 'hash', file: userFiles[0] })
  assert.ok(hashed.content[0].text.includes(manager.hash(userFiles[0])))
  const forgotten = await call('browser_evidence', { action: 'forget', file: userFiles[0] })
  assert.equal(forgotten.isError, undefined)
  assert.equal(fs.readFileSync(userFiles[0], 'utf8'), contents.get(userFiles[0]))
  console.log('PASS: production PDF/HAR handlers preserve explicit exports and overwrites, clean automatic exports, and retain lookup/hash/forget behavior')
} finally {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  fs.rmSync(tmp, { recursive: true, force: true })
}
