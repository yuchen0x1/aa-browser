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
  const run = (client) => spawnSync(process.execPath, [path.join(root, 'cli', 'setup.mjs'), '--yes', '--client', client], {
    encoding: 'utf8',
    env
  })

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
