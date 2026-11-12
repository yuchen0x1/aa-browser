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

  const run = () => spawnSync(process.execPath, [path.join(root, 'cli', 'setup.mjs'), '--yes', '--client', 'codex'], {
    encoding: 'utf8',
    env: { ...process.env, USERPROFILE: home, HOME: home }
  })

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
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log('✅ Codex MCP TOML setup preserves unrelated settings, backs up changes, and is idempotent')
