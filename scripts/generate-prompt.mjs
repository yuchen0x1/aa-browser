#!/usr/bin/env node
/**
 * 生成通用安装/接入提示词。
 *
 * 单一来源：
 *   installer/install-prompt.md  —— 还没安装 Aa Browser 时使用（下载 + 安装 + 接入）
 *   installer/connect-prompt.md  —— 已下载并打开 Aa Browser 时使用（只接入 + 验证）
 *
 * 生成物：
 *   PROMPT.md                    —— 仓库根目录可直接发给任意 AI 的提示词
 *   src/renderer/newtab.html     —— 新标签页 textarea 内的提示词（<!-- aa-universal-prompt:start --> 区域）
 *
 * 用法：
 *   node scripts/generate-prompt.mjs           # 重新生成
 *   node scripts/generate-prompt.mjs --check   # 仅检查是否与源文件一致（CI 用，不一致退出 1）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const INSTALL = path.join(ROOT, 'installer', 'install-prompt.md')
const CONNECT = path.join(ROOT, 'installer', 'connect-prompt.md')
const PROMPT_FILE = path.join(ROOT, 'PROMPT.md')
const NEWTAB = path.join(ROOT, 'src', 'renderer', 'newtab.html')
const START = '<!-- aa-universal-prompt:start -->'
const END = '<!-- aa-universal-prompt:end -->'
const CHECK = process.argv.includes('--check')

function readPrompt(file) {
  const value = fs.readFileSync(file, 'utf8').trim()
  if (!value) throw new Error(`${path.relative(ROOT, file)} 为空`)
  if (value.includes('```') || value.includes('</textarea>')) throw new Error(`${path.relative(ROOT, file)} 不能包含三反引号或 </textarea>`)
  return value
}

function escapeHtml(value) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function renderMarkdown(installPrompt, connectPrompt) {
  return `# Aa Browser 通用安装与接入提示词

> 一段提示词，适用于 Windows x64 / Linux x86_64 上的任意具备本机执行能力的 AI 客户端（WorkBuddy、ZCode、Codex/ChatGPT 桌面端、Claude Code、Cursor、Windsurf、Cline、VS Code、Gemini CLI、Qwen Code、DeepSeek Harness 等）。
>
> 不需要先手动下载 App：把「一」整段发给 AI，它会自动下载、安装并写入 MCP 配置。
> 已经从 GitHub Releases 下载并打开了 Aa Browser：把「二」整段发给 AI，它会只接入并验证，不重复安装。
>
> 网页版 ChatGPT 等没有本机命令执行能力的环境无法自动安装，提示词会要求 AI 明确说明并给出手动步骤，不会假装成功。

## 一、本机还没安装 Aa Browser

把下面整段发给 AI。

\`\`\`text
${installPrompt}
\`\`\`

## 二、已经下载并打开 Aa Browser

Aa Browser 新标签页里也显示这段提示词，点「复制接入提示词」即可。把整段发给 AI。

\`\`\`text
${connectPrompt}
\`\`\`

## 三、支持的平台与客户端

- 官方安装包：Windows x64（NSIS 安装器）、Linux x86_64（AppImage）。
- macOS、Windows ARM64 和其他架构目前没有官方安装包；安装器会明确拒绝，不会假装安装。
- 自动写入配置的客户端：ZCode、Claude Code、Cursor、Windsurf、Cline、VS Code、Gemini CLI、Qwen Code、OpenCode、Codex（桌面端 / CLI / IDE）、WorkBuddy。
- DeepSeek Harness：通过插件市场安装/启用 Aa Browser 插件手动接入；安装器不会修改 \`.dsh\` 配置、数据库或缓存，启用后实际调用 \`mcp__aa-browser__browser_tabs\` 验证。
- 其他支持 MCP 的客户端：运行 \`node install.mjs --print-config\` 获取启动配置，按该客户端官方 MCP 文档添加。

## 四、自动更新

- Aa Browser 通过 GitHub Releases 自动检查、下载并在用户确认后安装更新。
- MCP 配置指向稳定桥接路径，应用升级后一般无需重写；MCP 桥随应用版本更新。
- 升级后如果工具消失，重新运行 \`node install.mjs --connect-only --verify\`（幂等，会先备份配置）。

## 五、安全

- 只从官方仓库 \`yuchen0x1/aa-browser\` 下载安装器；安装器校验 Release 的 SHA-256 与文件头。
- 安装器写入配置前会备份原文件，只修改 \`aa-browser\` 一个 MCP 条目。
- 不要输入或泄露密码、token、API key、Cookie；不要用真实账号做验证。
`
}

function markerRange(html) {
  const start = html.indexOf(START)
  const end = html.indexOf(END)
  if (start === -1 || end === -1 || end < start) throw new Error(`newtab.html 缺少 ${START} / ${END} 标记`)
  return { start, end }
}

function renderNewtab(html, connectPrompt) {
  const { start, end } = markerRange(html)
  const block = `${START}\n${escapeHtml(connectPrompt)}\n${END}`
  return html.slice(0, start) + block + html.slice(end + END.length)
}

function writeOrCheck(file, content, label) {
  const current = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  // Windows checkouts commonly materialize text with CRLF while the generator
  // emits LF. Compare normalized text so `check:prompt` is checkout-independent.
  const normalize = (value) => value.replace(/\r\n/g, '\n')
  if (normalize(current) === normalize(content)) {
    console.log(`✅ ${label} 已是最新`)
    return true
  }
  if (CHECK) {
    console.error(`❌ ${label} 与提示词源文件不一致：运行 npm run prompt 重新生成`)
    return false
  }
  fs.writeFileSync(file, content, 'utf8')
  console.log(`✏️  已生成 ${label}`)
  return true
}

const installPrompt = readPrompt(INSTALL)
const connectPrompt = readPrompt(CONNECT)
const markdown = renderMarkdown(installPrompt, connectPrompt)
const newtab = renderNewtab(fs.readFileSync(NEWTAB, 'utf8'), connectPrompt)
const ok = [
  writeOrCheck(PROMPT_FILE, markdown, 'PROMPT.md'),
  writeOrCheck(NEWTAB, newtab, 'src/renderer/newtab.html')
].every(Boolean)
if (!ok) process.exit(1)
if (CHECK) console.log('✅ 通用提示词与源文件一致')
