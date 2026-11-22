#!/usr/bin/env node
/**
 * Regression tests for cli/setup.mjs JSONC editing.
 *
 * 背景：旧实现用正则去掉注释后整体 JSON.stringify 回写，导致
 *   1) `"path": "a//b"` 这类字符串被误删成无法解析（误报“请手动添加”）；
 *   2) 写回时丢掉用户注释、缩进和文件布局。
 * 这里用真实 CLI 子进程验证：注释被保留、只有 aa-browser 条目变化、
 * 第二次运行幂等，并且嵌套容器（zcode 的 mcp.servers）能正确补建。
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parse as parseJsonc } from 'jsonc-parser'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-setup-jsonc-'))
const home = path.join(tmp, 'home')
const isWindows = process.platform === 'win32'
const appData = isWindows
  ? path.join(tmp, 'AppData', 'Roaming')
  : path.join(tmp, 'appdata')
const bridgeA = path.join(tmp, 'bridge-a.cjs')
const bridgeB = path.join(tmp, 'bridge-b.cjs')

const envFor = (bridge) => ({
  ...process.env,
  HOME: home,
  USERPROFILE: home,
  APPDATA: appData,
  XDG_CONFIG_HOME: appData,
  AA_BROWSER_MCP_BRIDGE: bridge
})

const run = (client, bridge = bridgeA) => spawnSync(process.execPath, [
  path.join(root, 'cli', 'setup.mjs'),
  '--yes',
  '--client',
  client
], { encoding: 'utf8', env: envFor(bridge) })

const parse = (text) => parseJsonc(text, undefined, { allowTrailingComma: true })
const backupPrefix = (file) => `${path.basename(file)}.aa-backup-`
const backupsOf = (file) => fs.readdirSync(path.dirname(file)).filter((name) => name.startsWith(backupPrefix(file)))

const CLINE_DIR = path.join(appData, 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev')
const CLINE_FILE = path.join(CLINE_DIR, 'settings', 'cline_mcp_settings.json')
const ZCODE_DIR = path.join(home, '.zcode')
const ZCODE_FILE = path.join(ZCODE_DIR, 'cli', 'config.json')

const OTHER_SERVER = `"other": {
      "command": "node",
      "args": ["server//local.js"], // 字符串里的 // 不能被当成注释
      "env": { "BASE_URL": "http://127.0.0.1:3000" }
    }`

try {
  fs.writeFileSync(bridgeA, '// fixture bridge A\n')
  fs.writeFileSync(bridgeB, '// fixture bridge B\n')

  /* ── Cline：注释、字符串里的 // 与未触碰条目都要保留 ── */
  fs.mkdirSync(path.dirname(CLINE_FILE), { recursive: true })
  const clineOriginal = `{
  // Cline 用户设置：注释必须保留
  "mcpServers": {
    /* 现有服务 */
    ${OTHER_SERVER}
  },
  "theme": "dark" // 末尾注释
}
`
  fs.writeFileSync(CLINE_FILE, clineOriginal)

  let result = run('cline')
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.ok(!/无法解析/.test(result.stdout), `strings containing // must not be reported as unparseable:\n${result.stdout}`)
  let text = fs.readFileSync(CLINE_FILE, 'utf8')
  assert.ok(text.includes('// Cline 用户设置：注释必须保留'), 'line comment is preserved')
  assert.ok(text.includes('/* 现有服务 */'), 'block comment is preserved')
  assert.ok(text.includes('// 字符串里的 // 不能被当成注释'), 'inline comment is preserved')
  assert.ok(text.includes('// 末尾注释'), 'trailing file comment is preserved')
  assert.ok(text.includes('"server//local.js"'), 'double slash inside a string is never treated as a comment')
  assert.ok(text.includes(OTHER_SERVER), 'the other MCP server keeps its exact original layout')
  let parsed = parse(text)
  assert.equal(parsed.theme, 'dark')
  assert.equal(parsed.mcpServers.other.args[0], 'server//local.js')
  assert.ok(parsed.mcpServers['aa-browser'], 'aa-browser entry is written into the existing container')
  assert.equal(parsed.mcpServers['aa-browser'].args[0], bridgeA)

  const backups = backupsOf(CLINE_FILE)
  assert.equal(backups.length, 1, 'original Cline config is backed up once')
  assert.equal(fs.readFileSync(path.join(path.dirname(CLINE_FILE), backups[0]), 'utf8'), clineOriginal)

  const afterFirst = fs.readFileSync(CLINE_FILE, 'utf8')
  result = run('cline')
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /无需变更/, 'second run is idempotent')
  assert.equal(fs.readFileSync(CLINE_FILE, 'utf8'), afterFirst, 'idempotent run does not rewrite bytes')
  assert.equal(backupsOf(CLINE_FILE).length, 1, 'idempotent run does not create another backup')

  // 换桥路径 = 条目过期：只更新 aa-browser，其他字节与注释仍原样保留。
  result = run('cline', bridgeB)
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /已更新/)
  text = fs.readFileSync(CLINE_FILE, 'utf8')
  assert.ok(text.includes('// Cline 用户设置：注释必须保留'))
  assert.ok(text.includes('// 末尾注释'))
  assert.ok(text.includes(OTHER_SERVER), 'updating aa-browser must not reformat other servers')
  parsed = parse(text)
  assert.equal(parsed.mcpServers['aa-browser'].args[0], bridgeB)
  assert.equal(parsed.mcpServers.other.command, 'node')
  assert.equal(backupsOf(CLINE_FILE).length, 2, 'the outdated update creates its own recovery point')

  /* ── ZCode：容器路径 mcp.servers 缺失时补建嵌套对象，并保留只有注释的文件 ── */
  fs.mkdirSync(path.dirname(ZCODE_FILE), { recursive: true })
  const zcodeOriginal = `{
  // 只写了注释的配置也应该能安全接入
}
`
  fs.writeFileSync(ZCODE_FILE, zcodeOriginal)
  result = run('zcode')
  assert.equal(result.status, 0, result.stderr || result.stdout)
  text = fs.readFileSync(ZCODE_FILE, 'utf8')
  assert.ok(text.includes('// 只写了注释的配置也应该能安全接入'), 'comment-only config keeps its comment')
  parsed = parse(text)
  assert.equal(parsed.mcp.servers['aa-browser'].args[0], bridgeA, 'missing nested containers are created in order')

  const afterZcode = fs.readFileSync(ZCODE_FILE, 'utf8')
  result = run('zcode')
  assert.equal(result.status, 0, result.stderr || result.stdout)
  assert.match(result.stdout, /无需变更/)
  assert.equal(fs.readFileSync(ZCODE_FILE, 'utf8'), afterZcode, 'nested container creation is idempotent')

  console.log('✅ JSONC setup preserves comments/layout and no longer misparses // inside strings')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
