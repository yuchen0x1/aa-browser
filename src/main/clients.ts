import { app } from 'electron'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
const appData = (): string => process.env['APPDATA'] || path.join(home(), 'AppData', 'Roaming')

const joinHome = (...p: string[]): string => path.join(home(), ...p)

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
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'app.asar.unpacked', 'out', 'bridge', 'mcp.cjs')
  }
  const bundled = path.resolve(app.getAppPath(), 'out', 'bridge', 'mcp.cjs')
  if (fs.existsSync(bundled)) return bundled
  return path.resolve(app.getAppPath(), 'cli', 'mcp.mjs')
}

/** MCP 条目：优先系统 node；没有则用本应用本体（ELECTRON_RUN_AS_NODE）作为运行时 */
export function bridgeEntry(): { command: string; args: string[]; env?: Record<string, string> } {
  const mcp = mcpBridgePath()
  const env: Record<string, string> = {
    AA_BROWSER_CONNECTION_FILE: app.isPackaged
      ? path.join(home(), '.aabrowser', 'connection.json')
      : path.join(app.getPath('userData'), 'connection.json')
  }
  try {
    const r = spawnSync('node', ['--version'], { encoding: 'utf-8', shell: true, timeout: 5000 })
    if (r.status === 0 && /^v\d/.test((r.stdout || '').trim())) {
      return { command: 'node', args: [mcp], env }
    }
  } catch {
    /* 无系统 node */
  }
  env['ELECTRON_RUN_AS_NODE'] = '1'
  return { command: process.execPath, args: [mcp], env }
}

/** 宽松 JSON 解析：容忍 JSONC 注释与尾逗号 */
function parseLoose(text: string): Record<string, unknown> | null {
  try {
    return JSON.parse(text) as Record<string, unknown>
  } catch {
    /* 继续尝试 JSONC */
  }
  try {
    const stripped = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/[^\n]*/g, '$1')
      .replace(/,(\s*[}\]])/g, '$1')
    return JSON.parse(stripped) as Record<string, unknown>
  } catch {
    return null
  }
}

function getContainer(obj: Record<string, unknown>, container: string): Record<string, unknown> {
  const keys = container.split('.')
  let cur = obj as Record<string, unknown>
  for (const k of keys) {
    if (!cur[k] || typeof cur[k] !== 'object') cur[k] = {}
    cur = cur[k] as Record<string, unknown>
  }
  return cur
}

/** 组装将要写入的 MCP 条目 */
export function entryFor(def: ClientDef): Record<string, unknown> {
  if (def.id === 'workbuddy') {
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
  if (def.vscodeStyle) entry['type'] = 'stdio'
  return entry
}

function sameEntry(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function detectClients(): ClientDetectResult[] {
  return CLIENT_DEFS.map((def) => {
    const file = def.file()
    const installed = fs.existsSync(def.detectPath())
    let configured = false
    let outdated = false
    if (installed && fs.existsSync(file)) {
      const parsed = parseLoose(fs.readFileSync(file, 'utf-8'))
      if (parsed) {
        const container = getContainer(parsed, def.container)
        const existing = container['aa-browser']
        if (existing) {
          if (sameEntry(existing, entryFor(def))) configured = true
          else outdated = true
        }
      }
    }
    const entry = fs.existsSync(file) ? parseLoose(fs.readFileSync(file, 'utf-8')) : null
    const current = entry ? (entry as Record<string, any>) : null
    const existingEntry = current ? getContainer(current, def.container)['aa-browser'] as Record<string, any> | undefined : undefined
    const bridgeArgs = existingEntry?.args
    const bridgeMissing = Array.isArray(bridgeArgs) && typeof bridgeArgs[0] === 'string' && !fs.existsSync(bridgeArgs[0])
    return { id: def.id, name: def.name, file, installed, configured, outdated: outdated || bridgeMissing }
  })
}

/**
 * 把 aa-browser 条目写入指定客户端配置。
 * 返回逐个结果；绝不触碰 aa-browser 以外的键；写前备份。
 */
export function setupClients(ids: string[]): ClientSetupResult[] {
  const results: ClientSetupResult[] = []
  const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  for (const def of CLIENT_DEFS) {
    if (!ids.includes(def.id)) continue
    const file = def.file()
    try {
      // 客户端本体未安装：仍可创建配置（对 CLI 型客户端安全），但提示
      const installed = fs.existsSync(def.detectPath())

      let parsed: Record<string, unknown> = {}
      if (fs.existsSync(file)) {
        const backup = `${file}.aa-backup-${ts}`
        fs.copyFileSync(file, backup)
        const text = fs.readFileSync(file, 'utf-8')
        const p = parseLoose(text)
        if (!p) {
          results.push({
            id: def.id,
            name: def.name,
            status: 'manual',
            message: `配置文件存在但无法解析（${file}），已跳过自动写入。请手动添加 MCP 条目：command="${bridgeEntry().command}", args=["${bridgeEntry().args[0]}"]`
          })
          continue
        }
        parsed = p
      }

      const container = getContainer(parsed, def.container)
      const entry = entryFor(def)
      let status: ClientSetupResult['status'] = 'added'
      if (container['aa-browser']) {
        if (sameEntry(container['aa-browser'], entry)) {
          results.push({
            id: def.id,
            name: def.name,
            status: 'skipped',
            message: `已配置且无需更新：${file}`
          })
          continue
        }
        status = 'updated'
      }

      container['aa-browser'] = entry
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(parsed, null, 2) + '\n', 'utf-8')
      const verb = status === 'added' ? '已写入' : '已更新'
      const note = installed ? '' : `（客户端目录未检测到，已创建新配置）`
      results.push({
        id: def.id,
        name: def.name,
        status,
        message: `${verb} ${def.name} 配置：${file}${note}`
      })
    } catch (err) {
      results.push({
        id: def.id,
        name: def.name,
        status: 'error',
        message: `写入 ${def.name} 失败：${(err as Error).message}`
      })
    }
  }
  return results
}
