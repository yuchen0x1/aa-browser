#!/usr/bin/env node
/**
 * aa-browser-setup —— 一键接入 CLI（零依赖）。
 *
 * 检测本机 AI 客户端并把 aa-browser 的 MCP 配置写入其配置文件：
 *   node cli/setup.mjs [--yes] [--client zcode,cursor,...] [--list]
 *
 * 安全规则：写前备份（<file>.aa-backup-<时间戳>）、幂等、只改 aa-browser 一个键。
 * 打包版中本文件位于 resources/app.asar.unpacked/cli/，可用系统 node 或
 * "Aa Browser.exe"（ELECTRON_RUN_AS_NODE=1）运行。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'
import process from 'node:process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 优先使用构建出的单文件零依赖桥（out/bridge/mcp.cjs），源码运行退回 cli/mcp.mjs
const BUNDLED = path.resolve(HERE, '..', 'out', 'bridge', 'mcp.cjs')
const MCP_PATH = fs.existsSync(BUNDLED) ? BUNDLED : path.resolve(HERE, 'mcp.mjs')
const home = os.homedir()
const appData = process.env['APPDATA'] || path.join(home, 'AppData', 'Roaming')
const j = (...p) => path.join(home, ...p)
const jA = (...p) => path.join(appData, ...p)

const CLIENTS = [
  { id: 'zcode', name: 'ZCode', detect: j('.zcode'), file: j('.zcode', 'cli', 'config.json'), container: 'mcp.servers' },
  { id: 'claude', name: 'Claude Code', detect: j('.claude.json'), file: j('.claude.json'), container: 'mcpServers' },
  { id: 'cursor', name: 'Cursor', detect: j('.cursor'), file: j('.cursor', 'mcp.json'), container: 'mcpServers' },
  { id: 'windsurf', name: 'Windsurf', detect: j('.codeium', 'windsurf'), file: j('.codeium', 'windsurf', 'mcp_config.json'), container: 'mcpServers' },
  {
    id: 'cline',
    name: 'Cline (VS Code 扩展)',
    detect: jA('Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev'),
    file: jA('Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'settings', 'cline_mcp_settings.json'),
    container: 'mcpServers',
    jsonc: true
  },
  { id: 'vscode', name: 'VS Code (原生 MCP)', detect: jA('Code', 'User'), file: jA('Code', 'User', 'mcp.json'), container: 'servers', vscodeStyle: true, jsonc: true },
  { id: 'gemini', name: 'Gemini CLI', detect: j('.gemini'), file: j('.gemini', 'settings.json'), container: 'mcpServers' },
  { id: 'qwen', name: 'Qwen Code', detect: j('.qwen'), file: j('.qwen', 'settings.json'), container: 'mcpServers' },
  { id: 'codex', name: 'Codex (Desktop / CLI / IDE)', detect: j('.codex'), file: j('.codex', 'config.toml'), container: 'mcp_servers', toml: true },
  {
    id: 'workbuddy',
    name: 'WorkBuddy (生成本地 MCP 配置；需在应用中导入/启用)',
    detect: j('.workbuddy'),
    file: j('.workbuddy', 'mcp.json'),
    container: 'mcpServers',
    stdioType: true
  }
]

const log = (...a) => console.log(...a)

/** MCP 条目：本 CLI 无论被 node 还是 electron(RUN_AS_NODE) 执行都成立 */
function bridgeEntry() {
  const entry = { command: process.execPath, args: [MCP_PATH] }
  if (process.versions.electron) entry.env = { ELECTRON_RUN_AS_NODE: '1' }
  if (process.argv.includes('--vscode-style-entry')) entry.type = 'stdio'
  return entry
}

function parseLoose(text) {
  try {
    return JSON.parse(text)
  } catch {
    try {
      const stripped = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
        .replace(/,(\s*[}\]])/g, '$1')
      return JSON.parse(stripped)
    } catch {
      return null
    }
  }
}

function getContainer(obj, container) {
  let cur = obj
  for (const k of container.split('.')) {
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {}
    cur = cur[k]
  }
  return cur
}

function entryFor(def) {
  if (def.id === 'workbuddy') {
    const installDir = path.resolve(HERE, '..', '..', '..')
    return {
      type: 'stdio',
      command: path.join(installDir, 'Aa Browser.exe'),
      args: [path.join(installDir, 'resources', 'app.asar.unpacked', 'out', 'bridge', 'mcp.cjs')],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        AA_BROWSER_CONNECTION_FILE: j('.aabrowser', 'connection.json')
      },
      timeout: 60000
    }
  }
  const e = bridgeEntry()
  const entry = { command: e.command, args: e.args }
  if (e.env) entry.env = e.env
  if (def.vscodeStyle || def.stdioType) entry.type = 'stdio'
  return entry
}

function tomlQuote(value) {
  return JSON.stringify(value)
}

function codexEntryToml() {
  const entry = bridgeEntry()
  const lines = [
    '[mcp_servers.aa-browser]',
    `command = ${tomlQuote(entry.command)}`,
    `args = [${entry.args.map(tomlQuote).join(', ')}]`,
    'startup_timeout_sec = 20',
    'tool_timeout_sec = 180'
  ]
  if (entry.env && Object.keys(entry.env).length) {
    const env = Object.entries(entry.env).map(([key, value]) => `${key} = ${tomlQuote(value)}`)
    lines.push('', '[mcp_servers.aa-browser.env]', ...env)
  }
  return lines.join('\n')
}

function isCodexEntryHeader(line) {
  const header = /^\s*\[([^\[\]]+)\]\s*(?:#.*)?$/.exec(line)?.[1]?.trim()
  return !!header && /^mcp_servers\s*\.\s*(?:aa-browser|"aa-browser"|'aa-browser')(?:\s*\.\s*.+)?$/.test(header)
}

function codexEntryBlocks(text) {
  const blocks = []
  let active = false
  let lines = []
  for (const line of text.split(/\r?\n/)) {
    const isHeader = /^\s*\[[^\[\]]+\]\s*(?:#.*)?$/.test(line)
    if (isHeader) {
      if (active) blocks.push(lines.join('\n').trim())
      active = isCodexEntryHeader(line)
      lines = active ? [line.trim()] : []
    } else if (active) {
      lines.push(line)
    }
  }
  if (active) blocks.push(lines.join('\n').trim())
  return blocks
}

function replaceCodexEntry(text, entry) {
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const kept = []
  let removing = false
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[[^\[\]]+\]\s*(?:#.*)?$/.test(line)) removing = isCodexEntryHeader(line)
    if (!removing) kept.push(line)
  }
  const base = kept.join(newline).replace(/[\r\n\t ]+$/, '')
  return `${base}${base ? `${newline}${newline}` : ''}${entry.replace(/\n/g, newline)}${newline}`
}

function detectCodex(def) {
  const text = fs.existsSync(def.file) ? fs.readFileSync(def.file, 'utf-8') : ''
  const blocks = codexEntryBlocks(text)
  const configured = blocks.some((block) => block === codexEntryToml())
  return { def, installed: fs.existsSync(def.detect), configured, outdated: blocks.length > 0 && !configured }
}

function detectOne(def) {
  if (def.toml) return detectCodex(def)
  const installed = fs.existsSync(def.detect)
  let configured = false
  let outdated = false
  if ((installed || def.id === 'workbuddy') && fs.existsSync(def.file)) {
    const parsed = parseLoose(fs.readFileSync(def.file, 'utf-8'))
    if (parsed) {
      const existing = getContainer(parsed, def.container)['aa-browser']
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(entryFor(def))) configured = true
        else outdated = true
      }
    }
  }
  return { def, installed: installed || def.id === 'workbuddy', configured, outdated }
}

function setupOne(def, ts) {
  if (def.toml) {
    const entry = codexEntryToml()
    const existingText = fs.existsSync(def.file) ? fs.readFileSync(def.file, 'utf-8') : ''
    const exists = codexEntryBlocks(existingText).length > 0
    if (exists && codexEntryBlocks(existingText).some((block) => block === entry)) {
      log(`  ℹ️  ${def.name}: 已配置，无需变更（${def.file}）`)
      return
    }
    if (fs.existsSync(def.file)) fs.copyFileSync(def.file, `${def.file}.aa-backup-${ts}`)
    fs.mkdirSync(path.dirname(def.file), { recursive: true })
    fs.writeFileSync(def.file, replaceCodexEntry(existingText, entry), 'utf-8')
    log(`  ✅ ${def.name} ${exists ? '已更新' : '已写入'}（${def.file}）`)
    return
  }
  const installed = fs.existsSync(def.detect)
  let parsed = {}
  if (fs.existsSync(def.file)) {
    const backup = `${def.file}.aa-backup-${ts}`
    fs.copyFileSync(def.file, backup)
    const p = parseLoose(fs.readFileSync(def.file, 'utf-8'))
    if (!p) {
      log(`  ⚠️  ${def.name}: 配置文件无法解析（${def.file}），请手动添加`)
      return
    }
    parsed = p
  }
  const container = getContainer(parsed, def.container)
  const entry = entryFor(def)
  let verb = '已写入'
  if (container['aa-browser']) {
    if (JSON.stringify(container['aa-browser']) === JSON.stringify(entry)) {
      log(`  ℹ️  ${def.name}: 已配置，无需变更（${def.file}）`)
      return
    }
    verb = '已更新'
  }
  container['aa-browser'] = entry
  fs.mkdirSync(path.dirname(def.file), { recursive: true })
  fs.writeFileSync(def.file, JSON.stringify(parsed, null, 2) + '\n', 'utf-8')
  log(`  ✅ ${def.name} ${verb}（${def.file}${installed ? '' : '，客户端目录未检测到，已创建新配置'}）`)
}

function ask(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim().toLowerCase())
    })
  })
}

async function main() {
  const args = process.argv.slice(2)
  if (!fs.existsSync(MCP_PATH)) {
    console.error(`找不到 MCP 桥脚本: ${MCP_PATH}（请确认安装完整）`)
    process.exit(1)
  }
  const yes = args.includes('--yes')
  const listOnly = args.includes('--list')
  const clientArgIdx = args.indexOf('--client')
  const wanted = clientArgIdx !== -1 ? (args[clientArgIdx + 1] || '').split(',').filter(Boolean) : null

  const detected = CLIENTS.map(detectOne)
  const installed = detected.filter((d) => d.installed)

  if (listOnly) {
    log('本机 AI 客户端检测结果：')
    for (const d of detected) {
      log(
        `  ${d.installed ? '✓' : '·'} ${d.def.name.padEnd(18)} ` +
          (d.configured ? '已配置' : d.outdated ? '已配置(待更新)' : d.installed ? '未配置' : '未安装') +
          `  ${d.def.file}`
      )
    }
    process.exit(0)
  }

  log(`MCP 桥: ${MCP_PATH}`)
  log(`运行时: ${process.versions.electron ? 'Aa Browser 内置 Node (ELECTRON_RUN_AS_NODE)' : '系统 Node ' + process.version}`)
  log('')

  if (!installed.length) {
    log('未检测到已安装的 AI 客户端。支持：' + CLIENTS.map((c) => c.name).join(' / '))
    log('（客户端安装后重新运行本命令即可）')
    process.exit(0)
  }

  let targets = installed.filter((d) => !wanted || wanted.includes(d.def.id))
  if (wanted) {
    const unknown = wanted.filter((w) => !CLIENTS.some((c) => c.id === w))
    if (unknown.length) log(`⚠️ 忽略未知客户端 id: ${unknown.join(', ')}`)
  }
  targets = targets.filter((d) => !d.configured)

  if (!targets.length) {
    log('所选客户端均已配置完成，无需变更。运行 --list 查看详情。')
    process.exit(0)
  }

  log('将写入以下客户端的 MCP 配置：')
  for (const d of targets) log(`  - ${d.def.name}（${d.def.file}）`)
  log('（写入前会自动备份原配置文件）')

  if (!yes) {
    const answer = await ask('\n确认写入？[y/N] ')
    if (answer !== 'y' && answer !== 'yes') {
      log('已取消。')
      process.exit(0)
    }
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  log('')
  for (const d of targets) {
    if (d.def.id !== 'workbuddy') {
      setupOne(d.def, ts)
      continue
    }
    const installDir = path.resolve(HERE, '..', '..', '..')
    const workbuddyScript = path.join(HERE, 'workbuddy.mjs')
    const runtime = process.execPath
    const env = process.versions.electron ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : process.env
    const result = spawnSync(runtime, [workbuddyScript, installDir], { encoding: 'utf8', env, timeout: 30000 })
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    if (result.status !== 0) {
      log(`  ❌ WorkBuddy 配置生成失败（${result.error?.message ?? `exit ${result.status}`}）`)
      continue
    }
    log('  ✅ WorkBuddy MCP 配置与本地 Connector 包已准备')
  }
  log('')
  log('完成配置写入。请确认目标客户端实际加载了 MCP 工具；配置文件存在不等于连接成功。')
}

main().catch((err) => {
  console.error('setup 失败:', err.message)
  process.exit(1)
})
