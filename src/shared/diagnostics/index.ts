import type { Locale } from '../locale'

/** Aa-owned diagnostics only; paths, commands and external errors are opaque arguments. */
type DiagnosticParameters = {
  'clients.nodeRequired': []
  'clients.manual': []
  'clients.configured': [file: string]
  'clients.codexAdded': [file: string]
  'clients.codexUpdated': [file: string]
  'clients.codexWriteFailed': [error: string]
  'clients.unparseable': [file: string, command: string, bridge: string]
  'clients.added': [name: string, file: string, note: string]
  'clients.updated': [name: string, file: string, note: string]
  'clients.notDetected': []
  'clients.writeFailed': [name: string, error: string]
  'downloads.missing': [id: string]
  'downloads.active': []
  'downloads.notAllowed': []
  'downloads.noSession': []
  'downloads.failed': [error: string]
}

type DiagnosticCatalog = { [K in keyof DiagnosticParameters]: (...args: DiagnosticParameters[K]) => string }

const catalogs: Record<Locale, DiagnosticCatalog> = {
  'zh-CN': {
    'clients.nodeRequired': () => '请先安装 Node.js 22 并重新打开 Aa Browser。',
    'clients.manual': () => '请在 DeepSeek Harness 插件市场安装并启用 Aa Browser 插件；本应用不会修改 .dsh 配置或内部状态。启用后让 Agent 实际调用 mcp__aa-browser__browser_tabs 验证。',
    'clients.configured': (file) => `已配置且无需更新：${file}`,
    'clients.codexAdded': (file) => `已写入 Codex MCP 配置：${file}`,
    'clients.codexUpdated': (file) => `已更新 Codex MCP 配置：${file}`,
    'clients.codexWriteFailed': (error) => `写入 Codex 配置失败：${error}`,
    'clients.unparseable': (file, command, bridge) => `配置文件存在但无法解析（${file}），已跳过自动写入。请手动添加 MCP 条目：command="${command}", args=["${bridge}"]`,
    'clients.added': (name, file, note) => `已写入 ${name} 配置：${file}${note}`,
    'clients.updated': (name, file, note) => `已更新 ${name} 配置：${file}${note}`,
    'clients.notDetected': () => '（客户端目录未检测到，已创建新配置）',
    'clients.writeFailed': (name, error) => `写入 ${name} 失败：${error}`,
    'downloads.missing': (id) => `找不到下载记录 ${id}`,
    'downloads.active': () => '该下载仍在进行中，无法重试',
    'downloads.notAllowed': () => '该下载地址不在当前站点白名单内，已拒绝重试',
    'downloads.noSession': () => '无法找到该下载所属的浏览器会话',
    'downloads.failed': (error) => `重新发起下载失败：${error}`
  },
  'en-US': {
    'clients.nodeRequired': () => 'Install Node.js 22 and reopen Aa Browser first.',
    'clients.manual': () => 'Install and enable the Aa Browser plugin in the DeepSeek Harness plugin marketplace; this app will not modify .dsh configuration or internal state. After enabling it, ask the Agent to call mcp__aa-browser__browser_tabs to verify the connection.',
    'clients.configured': (file) => `Already configured; no update needed: ${file}`,
    'clients.codexAdded': (file) => `Wrote Codex MCP configuration: ${file}`,
    'clients.codexUpdated': (file) => `Updated Codex MCP configuration: ${file}`,
    'clients.codexWriteFailed': (error) => `Failed to write Codex configuration: ${error}`,
    'clients.unparseable': (file, command, bridge) => `The configuration file exists but could not be parsed (${file}); automatic writing was skipped. Add the MCP entry manually: command="${command}", args=["${bridge}"]`,
    'clients.added': (name, file, note) => `Wrote ${name} configuration: ${file}${note}`,
    'clients.updated': (name, file, note) => `Updated ${name} configuration: ${file}${note}`,
    'clients.notDetected': () => ' (Client directory not detected; created a new configuration)',
    'clients.writeFailed': (name, error) => `Failed to write ${name} configuration: ${error}`,
    'downloads.missing': (id) => `Download record not found: ${id}`,
    'downloads.active': () => 'This download is still in progress and cannot be retried',
    'downloads.notAllowed': () => 'This download URL is not on the current site allowlist; retry denied',
    'downloads.noSession': () => 'The browser session for this download could not be found',
    'downloads.failed': (error) => `Failed to restart the download: ${error}`
  }
}

/** English display names per client id; only messages use them, the returned name field stays untouched. */
const clientNames: Record<string, string> = {
  zcode: 'ZCode',
  claude: 'Claude Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  cline: 'Cline (VS Code extension)',
  vscode: 'VS Code (native MCP)',
  gemini: 'Gemini CLI',
  qwen: 'Qwen Code',
  opencode: 'OpenCode (open source)',
  'deepseek-harness': 'DeepSeek Harness (manual install from the plugin marketplace)',
  codex: 'Codex (Desktop / CLI / IDE)',
  workbuddy: 'WorkBuddy'
}

export function diagnosticMessage<K extends keyof DiagnosticParameters>(locale: Locale, key: K, ...args: DiagnosticParameters[K]): string {
  return catalogs[locale][key](...args)
}

/** English display name for a client id; unknown ids keep the stored name unchanged. */
export function clientNameFor(locale: Locale, id: string, name: string): string {
  return locale === 'en-US' ? (clientNames[id] ?? name) : name
}

/** Do not translate, normalize or otherwise rewrite external exception text. */
export function errorDetail(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
