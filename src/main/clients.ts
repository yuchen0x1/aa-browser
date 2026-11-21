import { app } from 'electron'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeFileAtomic } from './atomic-json'
import { diagnosticMessage, errorDetail, clientNameFor } from '../shared/diagnostics'
import type { Locale } from '../shared/locale'
import { getMainLocale } from './locale'
import { randomUUID } from 'node:crypto'
import { readJsonEntry, readTomlEntry, replaceJsonEntry, replaceTomlEntry, sameEntry } from './client-config'

/**
 * 一键接入：检测本机 AI 客户端并把 aa-browser 的 MCP 配置写入其配置文件。
 * 安全规则：写入前备份、幂等（一致则跳过）、只改 aa-browser 一个键、解析失败不硬写。
 */

export interface ClientDef {
  id: string
  name: string
  /** 存在即视为已安装（目录或文件） */
  detectPath: () => string
  /** MCP 配置文件（可能尚不存在，写入时创建） */
  file: () => string
  /** MCP 条目在 JSON 中的容器键（点路径），如 mcpServers / servers / mcp.servers */
  container: string
  /** VS Code 原生 MCP 要求 type 字段 */
  vscodeStyle?: boolean
  /** 配置可能是 JSONC（含注释） */
  jsonc?: boolean
  /** MCP 配置使用 TOML 格式 */
  toml?: boolean
  /** 客户端支持 OpenCode 的 mcp 配置格式（type=local, command 为数组） */
  opencodeStyle?: boolean
  /** 仅展示手动接入卡片；绝不读写客户端配置文件 */
  manual?: boolean
  /** 多个候选配置路径；优先使用已经存在的路径，避免覆盖另一平台的配置。 */
  fileCandidates?: () => string[]
}

export interface ClientDetectResult {
  id: string
  name: string
  file: string
  /** 客户端已安装（检测路径存在） */
  installed: boolean
  /** 已配置且条目与当前一致 */
  configured: boolean
  /** 已有 aa-browser 条目但内容过时 */
  outdated: boolean
}

export interface ClientSetupResult {
  id: string
  name: string
  status: 'added' | 'updated' | 'skipped' | 'manual' | 'error'
  message: string
}

const home = (): string => os.homedir()
const appData = (): string => app.getPath('appData')
const isAppImage = (): boolean => app.isPackaged && process.platform === 'linux' && !!process.env['APPIMAGE']

const joinHome = (...p: string[]): string => path.join(home(), ...p)

/** OpenCode 官方全局配置路径；保留候选路径以兼容旧版/手动迁移的 XDG 配置。 */
function openCodeConfigCandidates(): string[] {
  const xdg = process.env['XDG_CONFIG_HOME'] || joinHome('.config')
  const candidates = process.platform === 'win32'
    ? [
        path.join(process.env['APPDATA'] || joinHome('AppData', 'Roaming'), 'opencode', 'opencode.json'),
        path.join(xdg, 'opencode', 'opencode.json')
      ]
    : process.platform === 'darwin'
      ? [
          path.join(home(), 'Library', 'Application Support', 'opencode', 'opencode.json'),
          path.join(xdg, 'opencode', 'opencode.json')
        ]
      : [path.join(xdg, 'opencode', 'opencode.json')]
  return [...new Set(candidates)]
}

function openCodeDetectPath(): string {
  const candidates = openCodeConfigCandidates().map((file) => path.dirname(file))
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
}

function configFileFor(def: ClientDef): string {
  const candidates = def.fileCandidates?.() ?? [def.file()]
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
}

/** Find a system Node executable without invoking a shell or spawning a probe process. */
function findSystemNode(): string | undefined {
  const names = process.platform === 'win32' ? ['node.exe'] : ['node']
  const pathValue = [process.env['PATH'], process.env['Path']].filter(Boolean).join(path.delimiter)
  for (const directory of pathValue.split(path.delimiter).filter(Boolean)) {
    for (const name of names) {
      const candidate = path.join(directory, name)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        /* Keep looking; a stale PATH entry is harmless. */
      }
    }
  }
  return undefined
}

export const CLIENT_DEFS: ClientDef[] = [
  {
    id: 'zcode',
    name: 'ZCode',
    detectPath: () => joinHome('.zcode'),
    file: () => joinHome('.zcode', 'cli', 'config.json'),
    container: 'mcp.servers'
  },
  {
    id: 'claude',
    name: 'Claude Code',
    detectPath: () => joinHome('.claude.json'),
    file: () => joinHome('.claude.json'),
    container: 'mcpServers'
  },
  {
    id: 'cursor',
    name: 'Cursor',
    detectPath: () => joinHome('.cursor'),
    file: () => joinHome('.cursor', 'mcp.json'),
    container: 'mcpServers'
  },
  {
    id: 'windsurf',
    name: 'Windsurf',
    detectPath: () => joinHome('.codeium', 'windsurf'),
    file: () => joinHome('.codeium', 'windsurf', 'mcp_config.json'),
    container: 'mcpServers'
  },
  {
    id: 'cline',
    name: 'Cline (VS Code 扩展)',
    detectPath: () => path.join(appData(), 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev'),
    file: () =>
      path.join(
        appData(),
        'Code',
        'User',
        'globalStorage',
        'saoudrizwan.claude-dev',
        'settings',
        'cline_mcp_settings.json'
      ),
    container: 'mcpServers',
    jsonc: true
  },
  {
    id: 'vscode',
    name: 'VS Code (原生 MCP)',
    detectPath: () => path.join(appData(), 'Code', 'User'),
    file: () => path.join(appData(), 'Code', 'User', 'mcp.json'),
    container: 'servers',
    vscodeStyle: true,
    jsonc: true
  },
  {
    id: 'gemini',
    name: 'Gemini CLI',
    detectPath: () => joinHome('.gemini'),
    file: () => joinHome('.gemini', 'settings.json'),
    container: 'mcpServers'
  },
  {
    id: 'qwen',
    name: 'Qwen Code',
    detectPath: () => joinHome('.qwen'),
    file: () => joinHome('.qwen', 'settings.json'),
    container: 'mcpServers'
  },
  {
    id: 'opencode',
    name: 'OpenCode（开源）',
    detectPath: openCodeDetectPath,
    file: () => openCodeConfigCandidates()[0],
    fileCandidates: openCodeConfigCandidates,
    container: 'mcp',
    opencodeStyle: true
  },
  {
    id: 'deepseek-harness',
    name: 'DeepSeek Harness（插件市场手动接入）',
    // 这是一个插件式手动接入卡片，不把任何路径当作已安装证据，也不触碰 .dsh。
    detectPath: () => joinHome('.aabrowser'),
    file: () => '插件市场：Aa Browser / DeepSeek Harness',
    container: 'mcpServers',
    manual: true
  },
  {
    id: 'codex',
    name: 'Codex（桌面端 / CLI / IDE）',
    detectPath: () => joinHome('.codex'),
    file: () => joinHome('.codex', 'config.toml'),
    container: 'mcp_servers',
    toml: true
  },
  {
    id: 'workbuddy',
    name: 'WorkBuddy',
    detectPath: () => joinHome('.workbuddy'),
    file: () => joinHome('.workbuddy', 'mcp.json'),
    container: 'mcpServers',
    vscodeStyle: true
  }
]

/** MCP 桥脚本的绝对路径：优先用构建出的单文件零依赖产物（out/bridge/mcp.cjs） */
export function mcpBridgePath(): string {
  if (isAppImage()) return path.join(app.getPath('userData'), 'mcp', 'bridge.cjs')
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'out', 'bridge', 'mcp.cjs')
  }
  const bundled = path.resolve(app.getAppPath(), 'out', 'bridge', 'mcp.cjs')
  if (fs.existsSync(bundled)) return bundled
  return path.resolve(app.getAppPath(), 'cli', 'mcp.mjs')
}

/** AppImage mount paths change every launch. Publish the bridge under a stable client path. */
export function syncAppImageBridge(existingOnly = false): void {
  if (!isAppImage()) return
  const dest = mcpBridgePath()
  if (existingOnly && !fs.existsSync(dest)) return
  writeFileAtomic(dest, fs.readFileSync(path.join(process.resourcesPath, 'app.asar.unpacked', 'out', 'bridge', 'mcp.cjs')))
}

/** MCP 条目：优先系统 node；没有则用本应用本体（ELECTRON_RUN_AS_NODE）作为运行时 */
export function bridgeEntry(): { command: string; args: string[]; env?: Record<string, string> } {
  const mcp = mcpBridgePath()
  const env: Record<string, string> = {
    AA_BROWSER_CONNECTION_FILE: app.isPackaged
      ? path.join(home(), '.aabrowser', 'connection.json')
      : path.join(app.getPath('userData'), 'connection.json')
  }
  const systemNode = findSystemNode()
  if (systemNode) return { command: systemNode, args: [mcp], env }
  if (isAppImage()) return { command: 'node', args: [mcp], env }
  env['ELECTRON_RUN_AS_NODE'] = '1'
  return { command: process.execPath, args: [mcp], env }
}

/** 组装将要写入的 MCP 条目 */
export function entryFor(def: ClientDef): Record<string, unknown> {
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
  if (def.id === 'workbuddy' && !isAppImage()) {
    return {
      type: 'stdio',
      command: process.execPath,
      args: [mcpBridgePath()],
      env: {
        ELECTRON_RUN_AS_NODE: '1',
        AA_BROWSER_CONNECTION_FILE: joinHome('.aabrowser', 'connection.json')
      },
      timeout: 60000
    }
  }
  const e = bridgeEntry()
  const entry: Record<string, unknown> = { command: e.command, args: e.args }
  if (e.env) entry['env'] = e.env
  if (def.vscodeStyle || def.id === 'workbuddy') entry['type'] = 'stdio'
  if (def.id === 'workbuddy') entry['timeout'] = 60000
  return entry
}

function tomlQuote(value: string): string {
  return JSON.stringify(value)
}

function codexEntryToml(): string {
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

function writeClientConfig(file: string, value: string): void {
  const metadata = fs.lstatSync(file, { throwIfNoEntry: false })
  // Dotfile managers commonly symlink client configs; replace the target, not the user's link.
  const target = metadata?.isSymbolicLink() ? fs.realpathSync(file) : file
  writeFileAtomic(target, value)
}

function configureCodex(def: ClientDef, ts: string, locale: Locale): ClientSetupResult {
  const file = configFileFor(def)
  const entry = codexEntryToml()
  const existingText = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : ''
  const existing = readTomlEntry(existingText)
  const exists = existing !== undefined
  if (sameEntry(existing, readTomlEntry(entry))) {
    return { id: def.id, name: def.name, status: 'skipped', message: diagnosticMessage(locale, 'clients.configured', file) }
  }
  const output = replaceTomlEntry(existingText, entry)
  if (fs.existsSync(file)) fs.copyFileSync(file, `${file}.aa-backup-${ts}`, fs.constants.COPYFILE_EXCL)
  writeClientConfig(file, output)
  return {
    id: def.id,
    name: def.name,
    status: exists ? 'updated' : 'added',
    message: diagnosticMessage(locale, exists ? 'clients.codexUpdated' : 'clients.codexAdded', file)
  }
}

export function detectClients(): ClientDetectResult[] {
  return CLIENT_DEFS.map((def) => {
    const file = configFileFor(def)
    const installed = def.manual ? true : fs.existsSync(def.detectPath())
    const result = { id: def.id, name: def.name, file, installed, configured: false, outdated: false }
    if (def.manual || !fs.existsSync(file)) return result
    try {
      const text = fs.readFileSync(file, 'utf-8')
      if (def.toml) {
        const existing = readTomlEntry(text)
        result.configured = sameEntry(existing, readTomlEntry(codexEntryToml()))
        result.outdated = existing !== undefined && !result.configured
        return result
      }
      const existing = readJsonEntry(text, def.container)
      result.configured = installed && sameEntry(existing, entryFor(def))
      result.outdated = installed && existing !== undefined && !result.configured
      const entry = existing as Record<string, unknown> | undefined
      const bridgeArgs = Array.isArray(entry?.['args'])
        ? entry['args']
        : Array.isArray(entry?.['command']) ? entry['command'].slice(1) : undefined
      result.outdated ||= !!(bridgeArgs && typeof bridgeArgs[0] === 'string' && !fs.existsSync(bridgeArgs[0]))
    } catch {
      // An unreadable or malformed client file must not prevent scanning the other clients.
    }
    return result
  })
}

/**
 * 把 aa-browser 条目写入指定客户端配置。
 * 返回逐个结果；绝不触碰 aa-browser 以外的键；写前备份。
 */
export function setupClients(ids: string[]): ClientSetupResult[] {
  const locale = getMainLocale()
  const results: ClientSetupResult[] = []
  const ts = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`
  try {
    if (isAppImage() && !findSystemNode()) throw new Error(diagnosticMessage(locale, 'clients.nodeRequired'))
    if (CLIENT_DEFS.some((def) => ids.includes(def.id) && !def.manual)) syncAppImageBridge()
  } catch (error) {
    return CLIENT_DEFS.filter((def) => ids.includes(def.id)).map((def) => ({
      id: def.id, name: def.name, status: 'error', message: String(error)
    }))
  }
  for (const def of CLIENT_DEFS) {
    if (!ids.includes(def.id)) continue
    if (def.manual) {
      results.push({
        id: def.id,
        name: def.name,
        status: 'manual',
        message: diagnosticMessage(locale, 'clients.manual')
      })
      continue
    }
    if (def.toml) {
      try {
        results.push(configureCodex(def, ts, locale))
      } catch (err) {
        results.push({ id: def.id, name: def.name, status: 'error', message: diagnosticMessage(locale, 'clients.codexWriteFailed', errorDetail(err)) })
      }
      continue
    }
    const file = configFileFor(def)
    try {
      // 客户端本体未安装：仍可创建配置（对 CLI 型客户端安全），但提示
      const installed = fs.existsSync(def.detectPath())

      const exists = fs.existsSync(file)
      const text = exists ? fs.readFileSync(file, 'utf-8') : '{}\n'
      let existing: unknown
      try {
        existing = readJsonEntry(text, def.container)
      } catch {
        if (exists) fs.copyFileSync(file, `${file}.aa-backup-${ts}`, fs.constants.COPYFILE_EXCL)
        results.push({
          id: def.id,
          name: def.name,
          status: 'manual',
          message: diagnosticMessage(locale, 'clients.unparseable', file, bridgeEntry().command, bridgeEntry().args[0])
        })
        continue
      }
      const entry = entryFor(def)
      if (sameEntry(existing, entry)) {
        results.push({
          id: def.id,
          name: def.name,
          status: 'skipped',
          message: diagnosticMessage(locale, 'clients.configured', file)
        })
        continue
      }
      const status = existing === undefined ? 'added' : 'updated'
      const output = replaceJsonEntry(text, def.container, entry)
      if (exists) fs.copyFileSync(file, `${file}.aa-backup-${ts}`, fs.constants.COPYFILE_EXCL)
      writeClientConfig(file, output)
      const note = installed ? '' : diagnosticMessage(locale, 'clients.notDetected')
      results.push({
        id: def.id,
        name: def.name,
        status,
        message: diagnosticMessage(locale, status === 'added' ? 'clients.added' : 'clients.updated', clientNameFor(locale, def.id, def.name), file, note)
      })
    } catch (err) {
      results.push({
        id: def.id,
        name: def.name,
        status: 'error',
        message: diagnosticMessage(locale, 'clients.writeFailed', clientNameFor(locale, def.id, def.name), errorDetail(err))
      })
    }
  }
  return results
}
