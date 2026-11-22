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
import { randomUUID } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'
import process from 'node:process'

const HERE = path.dirname(fileURLToPath(import.meta.url))
// 优先使用显式指定的稳定桥（跨平台安装器写入），其次构建出的单文件零依赖桥（out/bridge/mcp.cjs），
// 源码运行退回 cli/mcp.mjs。
const BUNDLED = path.resolve(HERE, '..', 'out', 'bridge', 'mcp.cjs')
const MCP_PATH = process.env['AA_BROWSER_MCP_BRIDGE'] || (fs.existsSync(BUNDLED) ? BUNDLED : path.resolve(HERE, 'mcp.mjs'))
const home = os.homedir()
const isWindows = process.platform === 'win32'
const appData = process.env['APPDATA'] || (isWindows ? path.join(home, 'AppData', 'Roaming') : process.env['XDG_CONFIG_HOME'] || path.join(home, '.config'))
const j = (...p) => path.join(home, ...p)
const jA = (...p) => path.join(appData, ...p)

function openCodeConfigCandidates() {
  const xdg = process.env['XDG_CONFIG_HOME'] || j('.config')
  const candidates = process.platform === 'win32'
    ? [
        path.join(appData, 'opencode', 'opencode.json'),
        path.join(xdg, 'opencode', 'opencode.json')
      ]
    : process.platform === 'darwin'
      ? [
          path.join(home, 'Library', 'Application Support', 'opencode', 'opencode.json'),
          path.join(xdg, 'opencode', 'opencode.json')
        ]
      : [path.join(xdg, 'opencode', 'opencode.json')]
  return [...new Set(candidates)]
}

function openCodeDetectPath() {
  const candidates = openCodeConfigCandidates().map((file) => path.dirname(file))
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0]
}

function configFileFor(def) {
  const candidates = def.fileCandidates ? def.fileCandidates() : [def.file]
  return candidates.find((candidate) => fs.existsSync(candidate)) || candidates[0]
}

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
  { id: 'opencode', name: 'OpenCode (开源)', detect: openCodeDetectPath(), file: openCodeConfigCandidates()[0], fileCandidates: openCodeConfigCandidates, container: 'mcp', opencodeStyle: true },
  {
    id: 'deepseek-harness',
    name: 'DeepSeek Harness (插件市场手动接入)',
    detect: j('.aabrowser'),
    file: '插件市场：Aa Browser / DeepSeek Harness',
    container: 'mcpServers',
    manual: true
  },
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

// 与 App 内 clients.ts 一致：兼容旧版秒级命名和当前的毫秒 + UUID v4 命名。
const BACKUP_KEEP = 5
const BACKUP_TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})(?:-(\d{3})Z-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})?$/

function isBackupTimestamp(suffix) {
  const match = BACKUP_TIMESTAMP.exec(suffix)
  if (!match || match[0] !== suffix) return false
  const [, hour, minute, second, millis = '000'] = match
  const iso = `${hour}:${minute}:${second}.${millis}Z`
  const date = new Date(iso)
  return Number.isFinite(date.getTime()) && date.toISOString() === iso
}

function backupConfig(file) {
  const ts = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
  const backup = `${file}.aa-backup-${ts}`
  fs.copyFileSync(file, backup, fs.constants.COPYFILE_EXCL)
  return backup
}

function pruneBackups(file, freshBackup) {
  try {
    const dir = path.dirname(file)
    const prefix = `${path.basename(file)}.aa-backup-`
    const freshName = path.basename(freshBackup)
    // 时钟回拨时也保留本次恢复点，只对其他备份排序。
    const stale = fs.readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name !== freshName && entry.name.startsWith(prefix) &&
        isBackupTimestamp(entry.name.slice(prefix.length)))
      .map((entry) => entry.name)
      .sort()
      .reverse()
      .slice(BACKUP_KEEP - 1)
    for (const name of stale) {
      const candidate = path.join(dir, name)
      if (fs.lstatSync(candidate, { throwIfNoEntry: false })?.isFile()) fs.unlinkSync(candidate)
    }
  } catch {
    // 保留清理是 best-effort；新备份已生成。
  }
}

function writeClientConfig(file, value) {
  const backup = fs.existsSync(file) ? backupConfig(file) : undefined
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, value, 'utf-8')
  if (backup) pruneBackups(file, backup)
}

/** MCP 条目：本 CLI 无论被 node 还是 electron(RUN_AS_NODE) 执行都成立 */
function bridgeEntry() {
  const entry = { command: process.execPath, args: [MCP_PATH] }
  if (process.versions.electron) entry.env = { ELECTRON_RUN_AS_NODE: '1' }
  if (process.argv.includes('--vscode-style-entry')) entry.type = 'stdio'
  return entry
}

/**
 * 零依赖 JSONC 扫描器：返回带 [start,end) 字节区间的 AST。
 *
 * 只用于找到目标键的区间，让写入可以只替换 `aa-browser` 那一小段文本。
 * 这样 `//`、`/* *\/` 注释、缩进和文件其余内容都不会被整体重写丢失；
 * 字符串里的 `//` 也不会被误当成注释（旧实现的直接正则替换会因此误报“无法解析”）。
 */
function parseJsonc(text) {
  let i = 0
  const fail = () => { throw new Error('JSONC 语法错误') }
  function skip() {
    for (;;) {
      const ch = text[i]
      if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\uFEFF') { i++; continue }
      if (ch === '/' && text[i + 1] === '/') {
        i += 2
        while (i < text.length && text[i] !== '\n') i++
        continue
      }
      if (ch === '/' && text[i + 1] === '*') {
        const end = text.indexOf('*/', i + 2)
        if (end === -1) fail()
        i = end + 2
        continue
      }
      break
    }
  }
  function parseString() {
    const start = i
    i++
    while (i < text.length) {
      const ch = text[i]
      if (ch === '\\') { i += 2; continue }
      if (ch === '"') {
        i++
        return { type: 'string', start, end: i, value: JSON.parse(text.slice(start, i)) }
      }
      if (ch === '\n' || ch === '\r') fail()
      i++
    }
    fail()
  }
  function parseValue() {
    skip()
    const ch = text[i]
    if (ch === '{') return parseObject()
    if (ch === '[') return parseArray()
    if (ch === '"') return parseString()
    const start = i
    while (i < text.length && !/[\s,\]}]/.test(text[i])) i++
    if (i === start) fail()
    JSON.parse(text.slice(start, i)) // 只做合法性检查
    return { type: 'literal', start, end: i }
  }
  function parseObject() {
    const start = i
    i++
    const members = []
    for (;;) {
      skip()
      if (text[i] === '}') { i++; return { type: 'object', start, end: i, members } }
      if (text[i] === ',') { i++; continue } // 尾逗号
      if (text[i] !== '"') fail()
      const key = parseString()
      skip()
      if (text[i] !== ':') fail()
      i++
      const value = parseValue()
      members.push({ key: key.value, keyStart: key.start, keyEnd: key.end, value })
      skip()
      if (text[i] === ',') { i++; continue }
      if (text[i] === '}') { i++; return { type: 'object', start, end: i, members } }
      fail()
    }
  }
  function parseArray() {
    const start = i
    i++
    const items = []
    for (;;) {
      skip()
      if (text[i] === ']') { i++; return { type: 'array', start, end: i, items } }
      if (text[i] === ',') { i++; continue }
      items.push(parseValue())
      skip()
      if (text[i] === ',') { i++; continue }
      if (text[i] === ']') { i++; return { type: 'array', start, end: i, items } }
      fail()
    }
  }
  const root = parseValue()
  skip()
  if (i !== text.length) fail()
  return root
}

function materializeJsonc(node, text) {
  if (node.type === 'object') {
    const out = {}
    for (const member of node.members) out[member.key] = materializeJsonc(member.value, text)
    return out
  }
  if (node.type === 'array') return node.items.map((item) => materializeJsonc(item, text))
  if (node.type === 'string') return node.value
  return JSON.parse(text.slice(node.start, node.end))
}

function parseLoose(text) {
  try {
    return JSON.parse(text)
  } catch {
    try {
      return materializeJsonc(parseJsonc(text), text)
    } catch {
      return null
    }
  }
}

function lineIndentAt(text, pos) {
  const lineStart = text.lastIndexOf('\n', pos - 1) + 1
  const match = /^[ \t]*/.exec(text.slice(lineStart, pos))
  return match ? match[0] : ''
}

function detectIndentUnit(text) {
  const match = /^(?:\uFEFF)?[^\r\n]*\r?\n([ \t]+)\S/m.exec(text)
  return match ? match[1] : '  '
}

function newlineOf(text) {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** 多行 JSON 的续行按目标位置缩进；缩进单位沿用文件自身的风格。 */
function stringifyIndented(value, baseIndent, indentUnit, newline) {
  return JSON.stringify(value, null, indentUnit).split('\n').join(newline + baseIndent)
}

function objectMember(node, key) {
  if (!node || node.type !== 'object') return null
  const matches = node.members.filter((member) => member.key === key)
  // 重复键会让“只改一个条目”变成改错条目；客户端对重复键的取舍也不一致。
  if (matches.length > 1) throw new Error(`配置中存在重复键 ${key}`)
  return matches[0] || null
}

/** 在对象末尾插入一个成员；保留已有注释、缩进与换行风格。 */
function insertMember(text, node, key, value, indentUnit, newline) {
  const close = node.end - 1 // '}' 的位置
  const closingIndent = lineIndentAt(text, close)
  if (!node.members.length) {
    const insertAt = text.slice(close - closingIndent.length, close) === closingIndent ? close - closingIndent.length : close
    const memberIndent = closingIndent + indentUnit
    const body = `${JSON.stringify(key)}: ${stringifyIndented(value, memberIndent, indentUnit, newline)}`
    // 空对象 `{}` 的 `{` 与 `}` 在同一行时，先换行再写成员。
    const atLineStart = insertAt === 0 || text[insertAt - 1] === '\n' || text[insertAt - 1] === '\r'
    const head = atLineStart ? '' : newline
    return `${text.slice(0, insertAt)}${head}${memberIndent}${body}${newline}${closingIndent}${text.slice(close)}`
  }
  // 插在最后一个成员之后：先跳过它可能已有的尾逗号。
  let anchor = node.members[node.members.length - 1].value.end
  while (text[anchor] === ' ' || text[anchor] === '\t') anchor++
  const hadComma = text[anchor] === ','
  if (hadComma) anchor++
  const memberIndent = closingIndent + indentUnit
  const body = `${JSON.stringify(key)}: ${stringifyIndented(value, memberIndent, indentUnit, newline)}`
  return `${text.slice(0, anchor)}${hadComma ? '' : ','}${newline}${memberIndent}${body}${text.slice(anchor)}`
}

/**
 * 只替换/插入 aa-browser 配置，返回新文本。
 * 容器路径缺失时补建中间对象；任一层不是对象则不猜，交给调用方提示手动处理。
 */
function applyMcpEntry(text, containerPath, entry) {
  const indentUnit = detectIndentUnit(text)
  const newline = newlineOf(text)
  const root = parseJsonc(text)
  if (root.type !== 'object') throw new Error('配置根节点不是对象')
  const keys = containerPath.split('.').filter(Boolean)
  let node = root
  let missingAt = -1
  for (let k = 0; k < keys.length; k++) {
    const member = objectMember(node, keys[k])
    if (!member) { missingAt = k; break }
    if (member.value.type !== 'object') throw new Error(`配置项 ${keys.slice(0, k + 1).join('.')} 不是对象`)
    node = member.value
  }
  if (missingAt === -1) {
    const existing = objectMember(node, 'aa-browser')
    if (existing) {
      const baseIndent = lineIndentAt(text, existing.value.start)
      return `${text.slice(0, existing.value.start)}${stringifyIndented(entry, baseIndent, indentUnit, newline)}${text.slice(existing.value.end)}`
    }
    return insertMember(text, node, 'aa-browser', entry, indentUnit, newline)
  }
  // 补建缺失的容器层级：从最内层往外包，一次插入到已存在的那一层。
  let nested = { 'aa-browser': entry }
  for (let k = keys.length - 1; k > missingAt; k--) nested = { [keys[k]]: nested }
  return insertMember(text, node, keys[missingAt], nested, indentUnit, newline)
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
  if (def.manual) return {}
  if (def.opencodeStyle) {
    const e = bridgeEntry()
    return {
      type: 'local',
      command: [e.command, ...e.args],
      enabled: true,
      timeout: 180000,
      ...(e.env && Object.keys(e.env).length ? { environment: e.env } : {})
    }
  }
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
  const file = configFileFor(def)
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
  const blocks = codexEntryBlocks(text)
  const configured = blocks.some((block) => block === codexEntryToml())
  return { def, file, installed: fs.existsSync(def.detect), configured, outdated: blocks.length > 0 && !configured }
}

function detectOne(def) {
  const file = configFileFor(def)
  if (def.toml) return detectCodex(def)
  if (def.manual) return { def, file, installed: false, configured: false, outdated: false }
  const installed = fs.existsSync(def.detect)
  let configured = false
  let outdated = false
  if ((installed || def.id === 'workbuddy') && fs.existsSync(file)) {
    const parsed = parseLoose(fs.readFileSync(file, 'utf-8'))
    if (parsed) {
      const existing = getContainer(parsed, def.container)['aa-browser']
      if (existing) {
        if (JSON.stringify(existing) === JSON.stringify(entryFor(def))) configured = true
        else outdated = true
      }
    }
  }
  return { def, file, installed: installed || def.id === 'workbuddy', configured, outdated }
}

/** 补建容器路径时用的嵌套对象（新建配置文件也走这里）。 */
function nestedContainer(containerPath, entry) {
  const keys = containerPath.split('.').filter(Boolean)
  let value = { 'aa-browser': entry }
  for (let k = keys.length - 1; k >= 0; k--) value = { [keys[k]]: value }
  return value
}

function setupOne(def) {
  if (def.manual) {
    log(`  ⚠️  ${def.name}: 请在 DeepSeek Harness 插件市场安装并启用 Aa Browser 插件；本脚本不会修改 .dsh 配置或内部状态。启用后让 Agent 实际调用 mcp__aa-browser__browser_tabs 验证。`)
    return
  }
  if (def.toml) {
    const file = configFileFor(def)
    const entry = codexEntryToml()
    const existingText = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
    const exists = codexEntryBlocks(existingText).length > 0
    if (exists && codexEntryBlocks(existingText).some((block) => block === entry)) {
      log(`  ℹ️  ${def.name}: 已配置，无需变更（${file}）`)
      return
    }
    writeClientConfig(file, replaceCodexEntry(existingText, entry))
    log(`  ✅ ${def.name} ${exists ? '已更新' : '已写入'}（${file}）`)
    return
  }
  const file = configFileFor(def)
  const installed = fs.existsSync(def.detect)
  const entry = entryFor(def)
  let existingText = ''
  let parsed = {}
  if (fs.existsSync(file)) {
    existingText = fs.readFileSync(file, 'utf-8')
    parsed = parseLoose(existingText)
    if (!parsed || typeof parsed !== 'object') {
      backupConfig(file)
      log(`  ⚠️  ${def.name}: 配置文件无法解析（${file}），请手动添加`)
      return
    }
  }
  const container = getContainer(parsed, def.container)
  let verb = '已写入'
  if (container['aa-browser']) {
    if (JSON.stringify(container['aa-browser']) === JSON.stringify(entry)) {
      log(`  ℹ️  ${def.name}: 已配置，无需变更（${file}）`)
      return
    }
    verb = '已更新'
  }
  // 只改 aa-browser 对应的字节区间：注释、缩进、换行和其余配置原样保留。
  let nextText
  try {
    nextText = existingText
      ? applyMcpEntry(existingText, def.container, entry)
      : `${JSON.stringify(nestedContainer(def.container, entry), null, 2)}\n`
  } catch (err) {
    backupConfig(file)
    log(`  ⚠️  ${def.name}: 无法安全改写配置（${err.message}），请手动添加`)
    return
  }
  writeClientConfig(file, nextText)
  log(`  ✅ ${def.name} ${verb}（${file}${installed ? '' : '，客户端目录未检测到，已创建新配置'}）`)
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
          (d.def.manual ? '需手动接入' : d.configured ? '已配置' : d.outdated ? '已配置(待更新)' : d.installed ? '未配置' : '未安装') +
          `  ${d.file}`
      )
    }
    process.exit(0)
  }

  log(`MCP 桥: ${MCP_PATH}`)
  log(`运行时: ${process.versions.electron ? 'Aa Browser 内置 Node (ELECTRON_RUN_AS_NODE)' : '系统 Node ' + process.version}`)
  log('')

  const requestedManual = wanted?.some((id) => CLIENTS.some((client) => client.id === id && client.manual))
  if (!installed.length && !requestedManual) {
    log('未检测到已安装的 AI 客户端。支持：' + CLIENTS.map((c) => c.name).join(' / '))
    log('（客户端安装后重新运行本命令即可）')
    process.exit(0)
  }

  let targets = detected.filter((d) => wanted
    ? wanted.includes(d.def.id) && (d.installed || d.def.manual)
    : d.installed)
  if (wanted) {
    const unknown = wanted.filter((w) => !CLIENTS.some((c) => c.id === w))
    if (unknown.length) log(`⚠️ 忽略未知客户端 id: ${unknown.join(', ')}`)
  }
  targets = targets.filter((d) => !d.configured)

  if (!targets.length) {
    log('所选客户端均已配置完成，无需变更。运行 --list 查看详情。')
    process.exit(0)
  }

  log('将处理以下客户端的 MCP 接入：')
  for (const d of targets) log(`  - ${d.def.name}（${d.file}）`)
  log('（写入前会自动备份原配置文件；手动接入项不会写入任何文件）')

  if (!yes) {
    const answer = await ask('\n确认写入？[y/N] ')
    if (answer !== 'y' && answer !== 'yes') {
      log('已取消。')
      process.exit(0)
    }
  }

  log('')
  for (const d of targets) {
    if (d.def.id !== 'workbuddy') {
      setupOne(d.def)
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
  log('完成接入处理。请确认目标客户端实际加载了 MCP 工具；配置文件存在不等于连接成功。')
}

main().catch((err) => {
  console.error('setup 失败:', err.message)
  process.exit(1)
})
