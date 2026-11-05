#!/usr/bin/env node
/**
 * Prepare a WorkBuddy user-level MCP config and local connector package.
 * Writes only ~/.workbuddy/mcp.json and files under ~/.aabrowser; it does not
 * edit WorkBuddy databases, caches, or other internal state.
 * Usage: node cli/workbuddy.mjs <installed Aa Browser directory>
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'

const home = process.env['AA_BROWSER_TEST_HOME'] || os.homedir()
const installDir = process.argv[2] ? path.resolve(process.argv[2]) : ''
if (!installDir || !fs.existsSync(path.join(installDir, 'Aa Browser.exe'))) {
  console.error('Usage: node cli/workbuddy.mjs <Aa Browser install directory>')
  process.exit(1)
}

const exe = path.join(installDir, 'Aa Browser.exe')
const bridge = path.join(installDir, 'resources', 'app.asar.unpacked', 'out', 'bridge', 'mcp.cjs')
if (!fs.existsSync(bridge)) {
  console.error(`找不到已安装的 MCP bridge: ${bridge}`)
  process.exit(1)
}

const configFile = path.join(home, '.workbuddy', 'mcp.json')
const configDir = path.dirname(configFile)
fs.mkdirSync(configDir, { recursive: true })
let config = { mcpServers: {} }
if (fs.existsSync(configFile)) {
  const raw = fs.readFileSync(configFile, 'utf8')
  try {
    config = JSON.parse(raw)
  } catch {
    console.error(`WorkBuddy MCP 配置不是有效 JSON，未覆盖：${configFile}`)
    process.exit(1)
  }
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    console.error(`WorkBuddy MCP 配置顶层必须是对象，未覆盖：${configFile}`)
    process.exit(1)
  }
  const existing = config.mcpServers && typeof config.mcpServers === 'object'
    ? config.mcpServers['aa-browser']
    : undefined
  const backup = `${configFile}.aa-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`
  if (!existing || JSON.stringify(existing) !== JSON.stringify({
    type: 'stdio',
    command: exe,
    args: [bridge],
    env: {
      ELECTRON_RUN_AS_NODE: '1',
      AA_BROWSER_CONNECTION_FILE: path.join(home, '.aabrowser', 'connection.json')
    },
    timeout: 60000
  })) {
    fs.copyFileSync(configFile, backup)
    console.log(`已备份 WorkBuddy 配置: ${backup}`)
  }
}
if (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) config.mcpServers = {}
const server = {
  type: 'stdio',
  command: exe,
  args: [bridge],
  env: {
    ELECTRON_RUN_AS_NODE: '1',
    AA_BROWSER_CONNECTION_FILE: path.join(home, '.aabrowser', 'connection.json')
  },
  timeout: 60000
}
config.mcpServers['aa-browser'] = server
fs.writeFileSync(configFile, JSON.stringify(config, null, 2) + '\n', 'utf8')

const outputDir = path.join(home, '.aabrowser', 'workbuddy-connector')
fs.mkdirSync(outputDir, { recursive: true })
const metadata = {
  name: 'Aa Browser',
  name_zh: 'Aa Browser 浏览器',
  name_en: 'Aa Browser',
  description: 'Control the locally installed Aa Browser through its browser_* MCP tools.',
  description_zh: '通过 browser_* MCP 工具控制本机安装并运行的 Aa Browser。',
  description_en: 'Control the locally installed Aa Browser through its browser_* MCP tools.',
  source: 'aa-browser',
  examples_zh: ['列出 Aa Browser 当前标签页', '在 Aa Browser 中打开本地测试页并检查页面快照'],
  examples_en: ['List tabs in Aa Browser', 'Open a local test page in Aa Browser and inspect its snapshot']
}
const skillDir = path.join(outputDir, 'skills', 'aa-browser')
fs.mkdirSync(skillDir, { recursive: true })
fs.writeFileSync(path.join(outputDir, 'mcp.json'), JSON.stringify({ mcpServers: { 'aa-browser': server } }, null, 2) + '\n', 'utf8')
fs.writeFileSync(path.join(outputDir, 'connector-meta.json'), JSON.stringify(metadata, null, 2) + '\n', 'utf8')
fs.writeFileSync(path.join(outputDir, 'icon.svg'), [
  '<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128" viewBox="0 0 128 128">',
  '  <rect width="128" height="128" rx="28" fill="#1b1c21"/>',
  '  <circle cx="64" cy="64" r="39" fill="none" stroke="#66d9c1" stroke-width="8"/>',
  '  <path d="M33 62h62M64 31v64" stroke="#66d9c1" stroke-width="7" stroke-linecap="round"/>',
  '  <circle cx="64" cy="64" r="12" fill="#f3f4f6"/>',
  '</svg>'
].join('\n') + '\n', 'utf8')
fs.writeFileSync(path.join(skillDir, 'SKILL.md'), [
  '---',
  'name: aa-browser',
  'description: Use the locally installed Aa Browser connector for browser automation.',
  '---',
  '',
  '# Aa Browser',
  '',
  'Use the `browser_*` tools from this connector only when the user asks to operate Aa Browser. First call `browser_tabs` to verify the connection. Do not substitute WorkBuddy built-in browser tools when validating this connector. For passwords, API keys, tokens, and other sensitive fields, never send the value through `browser_type`; let the user enter it directly in Aa Browser and follow its approval UI.'
].join('\n') + '\n', 'utf8')

console.log(`WorkBuddy MCP 配置已生成: ${path.join(outputDir, 'mcp.json')}`)
console.log(`WorkBuddy Connector 文件夹: ${outputDir}`)
console.log('若 WorkBuddy 未自动加载，请仅通过 WorkBuddy 当前版本支持的「专家·技能·连接器」流程导入/启用本地 Connector；不支持时需报告阻塞。')
console.log('此脚本不会改写 WorkBuddy 私有设置；配置生成不等于连接成功。')
