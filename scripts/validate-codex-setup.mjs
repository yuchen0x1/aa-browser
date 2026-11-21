#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa codex setup validation-'))
const home = path.join(tmp, 'home')
const codexDir = path.join(home, '.codex')
const configFile = path.join(codexDir, 'config.toml')

try {
  fs.mkdirSync(codexDir, { recursive: true })
  const original = [
    '# Preserve the user defaults',
    'model = "gpt-test"',
    '',
    '[mcp_servers.other]',
    'command = "keep-this-server"',
    '',
    '[mcp_servers."aa-browser"]',
    'command = "old-command"',
    'args = ["old-bridge"]',
    '',
    '[mcp_servers."aa-browser".env]',
    'OLD_VALUE = "replace-only-this-server"',
    '',
    '[projects."E:/existing-project"]',
    'trust_level = "trusted"',
    ''
  ].join('\r\n')
  fs.writeFileSync(configFile, original, 'utf8')

  // Run successive updates with exactly the same timestamp, without relying on process startup timing.
  const fixedClock = `globalThis.Date = class extends Date {
    constructor(...args) { super(...(args.length ? args : ['2020-01-01T00:00:00.000Z'])) }
  };`
  const run = (prelude = '') => spawnSync(process.execPath, [
    '--import', `data:text/javascript,${encodeURIComponent(`${fixedClock}\n${prelude}`)}`,
    path.join(root, 'cli', 'setup.mjs'), '--yes', '--client', 'codex'
  ], {
    encoding: 'utf8',
    env: { ...process.env, USERPROFILE: home, HOME: home, APPDATA: home, XDG_CONFIG_HOME: home }
  })
  const prefix = 'config.toml.aa-backup-'
  const listBackups = () => fs.readdirSync(codexDir).filter((file) => file.startsWith(prefix))

  let result = run()
  assert.equal(result.status, 0, result.stderr || result.stdout)
  let config = fs.readFileSync(configFile, 'utf8')
  assert.ok(config.includes('model = "gpt-test"'), 'preserves top-level Codex preferences')
  assert.ok(config.includes('[mcp_servers.other]\r\ncommand = "keep-this-server"'), 'preserves other MCP servers')
  assert.ok(config.includes('[projects."E:/existing-project"]\r\ntrust_level = "trusted"'), 'preserves project trust settings')
  assert.equal((config.match(/\[mcp_servers\.aa-browser\]/g) ?? []).length, 1, 'writes one Aa Browser server entry')
  assert.match(config, /command = ".+"\r\nargs = \[".+"\]/, 'writes a quoted stdio command and argument list')
  assert.ok(!config.includes('replace-only-this-server'), 'replaces only the prior Aa Browser entry, including its env subsection')
  assert.ok(config.includes('\r\n'), 'preserves the existing CRLF line endings')

  const backups = fs.readdirSync(codexDir).filter((file) => file.startsWith('config.toml.aa-backup-'))
  assert.equal(backups.length, 1, 'backs up the original Codex config before updating')
  assert.equal(fs.readFileSync(path.join(codexDir, backups[0]), 'utf8'), original, 'backup is byte-for-byte identical to the original')

  const configured = config
  result = run()
  assert.equal(result.status, 0, result.stderr || result.stdout)
  config = fs.readFileSync(configFile, 'utf8')
  assert.equal(config, configured, 'a second setup is idempotent')
  assert.equal(fs.readdirSync(codexDir).filter((file) => file.startsWith('config.toml.aa-backup-')).length, 1, 'idempotent setup does not create a redundant backup')

  const firstBackup = backups[0]
  const outdated = configured.replace('startup_timeout_sec = 20', 'startup_timeout_sec = 19')
  fs.writeFileSync(configFile, outdated)
  result = run()
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const secondBackup = listBackups().find((name) => name !== firstBackup)
  assert.ok(secondBackup, 'same-millisecond updates create distinct backups')
  assert.equal(fs.readFileSync(path.join(codexDir, firstBackup), 'utf8'), original, 'a second update never overwrites the first recovery point')
  assert.equal(fs.readFileSync(path.join(codexDir, secondBackup), 'utf8'), outdated)

  // Even an exact destination collision must fail before writing, not overwrite a recovery point.
  fs.writeFileSync(configFile, outdated)
  const collisionPrelude = `import fs from 'node:fs';
    const copy = fs.copyFileSync;
    fs.copyFileSync = (source, dest, flags) => {
      fs.writeFileSync(dest, 'existing recovery point');
      return copy(source, dest, flags);
    };`
  result = run(collisionPrelude)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /EEXIST/)
  assert.equal(fs.readFileSync(configFile, 'utf8'), outdated)
  const collision = listBackups().find((name) => ![firstBackup, secondBackup].includes(name))
  assert.ok(collision)
  assert.equal(fs.readFileSync(path.join(codexDir, collision), 'utf8'), 'existing recovery point')
  for (const file of listBackups()) fs.unlinkSync(path.join(codexDir, file))

  const uuid = '00000000-0000-4000-8000-000000000001'
  const stale = [`${prefix}2000-01-01T00-00-00`, `${prefix}2000-01-01T00-00-00-001Z-${uuid}`]
  const future = Array.from({ length: 5 }, (_, i) => `${prefix}2099-01-01T00-00-0${i}${i % 2 ? `-001Z-${uuid}` : ''}`)
  for (const name of [...stale, ...future]) fs.writeFileSync(path.join(codexDir, name), name)
  const notes = [`${prefix}notes`, `${prefix}1999-01-01T00-00-00-000Z-${uuid}.notes`, `${prefix}1999-01-01T00-00-00-000Z`, `${prefix}1999-02-30T00-00-00`]
  for (const name of notes) fs.writeFileSync(path.join(codexDir, name), 'user notes')
  const directory = `${prefix}1999-01-02T00-00-00`
  fs.mkdirSync(path.join(codexDir, directory))
  const target = path.join(codexDir, directory, 'target')
  fs.writeFileSync(target, 'user target')
  const link = `${prefix}1999-01-03T00-00-00`
  const linkPath = path.join(codexDir, link)
  try {
    fs.symlinkSync(target, linkPath, 'file')
  } catch (error) {
    if (process.platform !== 'win32' || !['EPERM', 'EACCES'].includes(error.code)) throw error
    fs.symlinkSync(path.dirname(target), linkPath, 'junction')
  }
  const linkTarget = fs.readlinkSync(linkPath)

  // Failed writes must not trigger retention, even when a new backup was already made.
  const failWritePrelude = `import fs from 'node:fs';
    const write = fs.writeFileSync;
    fs.writeFileSync = (file, ...args) => {
      if (file === ${JSON.stringify(configFile)}) throw new Error('fixture write failure');
      return write(file, ...args);
    };`
  result = run(failWritePrelude)
  assert.notEqual(result.status, 0)
  assert.match(result.stderr, /fixture write failure/)
  assert.equal(fs.readFileSync(configFile, 'utf8'), outdated)
  for (const name of [...stale, ...future]) assert.equal(fs.readFileSync(path.join(codexDir, name), 'utf8'), name)
  const failedBackup = listBackups().find((name) => ![...stale, ...future, ...notes, directory, link].includes(name))
  assert.ok(failedBackup)
  assert.equal(fs.readFileSync(path.join(codexDir, failedBackup), 'utf8'), outdated)

  result = run()
  assert.equal(result.status, 0, result.stderr || result.stdout)
  const retained = listBackups().filter((name) => ![...notes, directory, link].includes(name))
  const fresh = retained.filter((name) => !future.includes(name))
  assert.equal(fresh.length, 1)
  assert.notEqual(fresh[0], failedBackup)
  assert.deepEqual(retained.sort(), [...future.slice(1), fresh[0]].sort(), 'keeps the current recovery point plus the newest four, even with five future backups')
  assert.equal(fs.readFileSync(path.join(codexDir, fresh[0]), 'utf8'), outdated, 'current backup has the exact pre-write bytes')
  for (const name of future.slice(1)) assert.equal(fs.readFileSync(path.join(codexDir, name), 'utf8'), name)
  for (const name of notes) assert.equal(fs.readFileSync(path.join(codexDir, name), 'utf8'), 'user notes')
  assert.ok(fs.lstatSync(path.join(codexDir, directory)).isDirectory())
  assert.equal(fs.readlinkSync(linkPath), linkTarget)
  assert.equal(fs.readFileSync(target, 'utf8'), 'user target')
  assert.equal(fs.readFileSync(configFile, 'utf8'), configured)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('✅ Codex MCP TOML setup preserves unrelated settings, backs up changes, and is idempotent')
