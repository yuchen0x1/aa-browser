#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa opencode setup validation-'))
const home = path.join(tmp, 'home')
const appData = path.join(tmp, 'AppData', 'Roaming')
const xdg = path.join(tmp, 'xdg')
const bridge = path.join(tmp, 'mcp.cjs')
const configFile = process.platform === 'win32'
  ? path.join(appData, 'opencode', 'opencode.json')
  : process.platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support', 'opencode', 'opencode.json')
    : path.join(xdg, 'opencode', 'opencode.json')

try {
  fs.mkdirSync(path.dirname(configFile), { recursive: true })
  fs.writeFileSync(bridge, '// test bridge\n', 'utf8')
  const original = {
    '$schema': 'https://opencode.ai/config.json',
    model: 'keep-this-model',
    mcp: { other: { type: 'local', command: ['keep-this-server'] } }
  }
  fs.writeFileSync(configFile, JSON.stringify(original, null, 2) + '\n', 'utf8')

  const env = {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    APPDATA: appData,
    XDG_CONFIG_HOME: xdg,
    AA_BROWSER_MCP_BRIDGE: bridge
  }
  const fixedClock = `globalThis.Date = class extends Date {
    constructor(...args) { super(...(args.length ? args : ['2020-01-01T00:00:00.000Z'])) }
  };`
  const run = (client, prelude = '') => spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(`${fixedClock}\n${prelude}`)}`,
    path.join(root, 'cli', 'setup.mjs'), '--yes', '--client', client
  ], { encoding: 'utf8', env })
  const dir = path.dirname(configFile)
  const prefix = 'opencode.json.aa-backup-'
  const listBackups = () => fs.readdirSync(dir).filter((file) => file.startsWith(prefix))

  let result = run('opencode')
  assert.equal(result.status, 0, result.stderr || result.stdout)
  let config = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  assert.equal(config.model, original.model, 'preserves unrelated top-level settings')
  assert.deepEqual(config.mcp.other, original.mcp.other, 'preserves unrelated MCP servers')
  assert.deepEqual(config.mcp['aa-browser'], {
    type: 'local',
    command: [process.execPath, bridge],
    enabled: true,
    timeout: 180000
  }, 'writes the OpenCode local MCP schema')

  const configured = fs.readFileSync(configFile, 'utf8')
  result = run('opencode')
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(fs.readFileSync(configFile, 'utf8'), configured, 'second setup is idempotent')
  assert.equal(fs.readdirSync(path.dirname(configFile)).filter((file) => file.startsWith('opencode.json.aa-backup-')).length, 1, 'backs up only the first change')

  const firstBackup = listBackups()[0]
  const outdated = configured.replace('"timeout": 180000', '"timeout": 1')
  fs.writeFileSync(configFile, outdated)
  result = run('opencode')
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const secondBackup = listBackups().find((name) => name !== firstBackup)
  assert.ok(secondBackup, 'same-millisecond updates have distinct recovery points')
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, firstBackup), 'utf8')), original)
  assert.equal(fs.readFileSync(path.join(dir, secondBackup), 'utf8'), outdated)
  for (const name of listBackups()) fs.unlinkSync(path.join(dir, name))

  const uuid = '00000000-0000-4000-8000-000000000001'
  const old = [`${prefix}2000-01-01T00-00-00`, `${prefix}2000-01-01T00-00-00-001Z-${uuid}`]
  const future = Array.from({ length: 5 }, (_, i) => `${prefix}2099-01-01T00-00-0${i}${i % 2 ? `-001Z-${uuid}` : ''}`)
  for (const name of [...old, ...future]) fs.writeFileSync(path.join(dir, name), name)
  const notes = [`${prefix}notes`, `${prefix}1999-01-01T00-00-00-000Z-${uuid}.notes`, `${prefix}1999-01-01T00-00-00-000Z`, `${prefix}1999-02-30T00-00-00`]
  for (const name of notes) fs.writeFileSync(path.join(dir, name), 'user notes')
  const directory = `${prefix}1999-01-02T00-00-00`
  fs.mkdirSync(path.join(dir, directory))
  const target = path.join(dir, directory, 'target')
  fs.writeFileSync(target, 'user target')
  const link = `${prefix}1999-01-03T00-00-00`
  const linkPath = path.join(dir, link)
  try {
    fs.symlinkSync(target, linkPath, 'file')
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error
    fs.symlinkSync(path.dirname(target), linkPath, 'junction')
  }
  const linkTarget = fs.readlinkSync(linkPath)
  fs.writeFileSync(configFile, outdated)
  const failWritePrelude = `import fs from 'node:fs';
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, ...args) => {
      if (file === ${JSON.stringify(configFile)}) throw new Error('fixture write failure');
      return write(file, ...args);
    };`
  result = run('opencode', failWritePrelude)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /fixture write failure/)
  assert.equal(fs.readFileSync(configFile, 'utf8'), outdated)
  for (const name of [...old, ...future]) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), name)
  const failedBackup = listBackups().find((name) => ![...old, ...future, ...notes, directory, link].includes(name))
  assert.ok(failedBackup)
  assert.equal(fs.readFileSync(path.join(dir, failedBackup), 'utf8'), outdated)

  result = run('opencode')
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const retained = listBackups().filter((name) => ![...notes, directory, link].includes(name))
  const fresh = retained.filter((name) => !future.includes(name))
  assert.equal(fresh.length, 1)
  assert.notEqual(fresh[0], failedBackup)
  assert.deepEqual(retained.sort(), [...future.slice(1), fresh[0]].sort(), 'always keeps the current restore point and four latest historical backups')
  assert.equal(fs.readFileSync(path.join(dir, fresh[0]), 'utf8'), outdated)
  for (const name of future.slice(1)) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), name)
  for (const name of notes) assert.equal(fs.readFileSync(path.join(dir, name), 'utf8'), 'user notes')
  assert.ok(fs.lstatSync(path.join(dir, directory)).isDirectory())
  assert.equal(fs.readlinkSync(linkPath), linkTarget)
  assert.equal(fs.readFileSync(target, 'utf8'), 'user target')
  assert.equal(fs.readFileSync(configFile, 'utf8'), configured)

  const dshDir = path.join(home, '.dsh')
  fs.mkdirSync(dshDir, { recursive: true })
  const dshSentinel = path.join(dshDir, 'sentinel')
  fs.writeFileSync(dshSentinel, 'keep', 'utf8')
  result = run('deepseek-harness')
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.equal(fs.readFileSync(dshSentinel, 'utf8'), 'keep', 'manual Harness setup does not touch .dsh')
  assert.equal(fs.readdirSync(dshDir).length, 1, 'manual Harness setup creates no internal files')
  assert.match(result.stdout, /插件市场|DeepSeek Harness/, 'manual setup explains the plugin-market path')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('✅ OpenCode MCP setup preserves unrelated settings, is idempotent, and DeepSeek Harness remains manual-only')
