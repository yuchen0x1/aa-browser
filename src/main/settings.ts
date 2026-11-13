import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeJsonAtomic } from './atomic-json'

export interface AppSettings {
  /** 默认搜索引擎基址（以 = 结尾，查询词直接拼接） */
  searchEngine: string
  /** 快照默认是否全量（false = 增量省 token） */
  fullSnapshot: boolean
  /** 下载保存目录（空 = 默认 ~/.aabrowser/downloads） */
  downloadDir: string
  /** 高危操作（提交表单/下载）前是否弹人工确认 */
  requireOperationApproval: boolean
  /** 允许导航的站点规则；空数组表示不启用白名单 */
  allowedSites: string[]
  /** 新建标签默认使用一次性隔离会话（不共享登录态，关闭即清理） */
  isolatedSessions: boolean
  /** 是否自动检查 GitHub Releases 更新 */
  autoUpdate: boolean
  /** 更新通道 */
  updateChannel: 'stable' | 'beta'
}

const DEFAULTS: AppSettings = {
  searchEngine: 'https://www.bing.com/search?q=',
  fullSnapshot: false,
  downloadDir: '',
  requireOperationApproval: false,
  allowedSites: [],
  isolatedSessions: false,
  autoUpdate: true,
  updateChannel: 'stable'
}

const PRESETS: { label: string; url: string }[] = [
  { label: '必应 (Bing)', url: 'https://www.bing.com/search?q=' },
  { label: 'Google', url: 'https://www.google.com/search?q=' },
  { label: '百度', url: 'https://www.baidu.com/s?wd=' },
  { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  { label: 'GitHub', url: 'https://github.com/search?q=' }
]

function validSearchEngine(value: unknown): value is string {
  if (typeof value !== 'string' || !value.trim()) return false
  try {
    const url = new URL(value.trim())
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
  } catch { return false }
}

function normalizeSettings(value: unknown): AppSettings {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
  return {
    searchEngine: validSearchEngine(raw.searchEngine) ? raw.searchEngine.trim() : DEFAULTS.searchEngine,
    fullSnapshot: typeof raw.fullSnapshot === 'boolean' ? raw.fullSnapshot : DEFAULTS.fullSnapshot,
    downloadDir: typeof raw.downloadDir === 'string' ? raw.downloadDir.trim() : DEFAULTS.downloadDir,
    requireOperationApproval: typeof raw.requireOperationApproval === 'boolean' ? raw.requireOperationApproval : DEFAULTS.requireOperationApproval,
    isolatedSessions: typeof raw.isolatedSessions === 'boolean' ? raw.isolatedSessions : DEFAULTS.isolatedSessions,
    autoUpdate: typeof raw.autoUpdate === 'boolean' ? raw.autoUpdate : DEFAULTS.autoUpdate,
    updateChannel: raw.updateChannel === 'beta' ? 'beta' : 'stable',
    allowedSites: Array.isArray(raw.allowedSites) ? raw.allowedSites.filter((site): site is string => typeof site === 'string').map((site) => site.trim()).filter(Boolean) : []
  }
}

/** 用户设置：持久化到 ~/.aabrowser/settings.json，内存缓存，进程内生效 */
export class SettingsStore {
  private settings: AppSettings = normalizeSettings({})
  private loaded = false
  private backupInvalid = false
  private filePath = process.env['AA_BROWSER_SETTINGS_FILE'] || path.join(os.homedir(), '.aabrowser', 'settings.json')

  get(): AppSettings {
    this.ensureLoaded()
    return { ...this.settings, allowedSites: [...this.settings.allowedSites] }
  }

  set(patch: Partial<AppSettings>): AppSettings {
    this.ensureLoaded()
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('设置必须是有效对象。')
    const next = this.get()
    if (patch.searchEngine !== undefined) {
      if (!validSearchEngine(patch.searchEngine)) throw new Error('搜索引擎必须是有效的 HTTP 或 HTTPS 地址，且不能包含账号密码。')
      next.searchEngine = patch.searchEngine.trim()
    }
    if (typeof patch.fullSnapshot === 'boolean') next.fullSnapshot = patch.fullSnapshot
    if (typeof patch.downloadDir === 'string') next.downloadDir = patch.downloadDir.trim()
    if (typeof patch.requireOperationApproval === 'boolean') next.requireOperationApproval = patch.requireOperationApproval
    if (typeof patch.isolatedSessions === 'boolean') next.isolatedSessions = patch.isolatedSessions
    if (typeof patch.autoUpdate === 'boolean') next.autoUpdate = patch.autoUpdate
    if (patch.updateChannel === 'stable' || patch.updateChannel === 'beta') next.updateChannel = patch.updateChannel
    if (Array.isArray(patch.allowedSites)) {
      next.allowedSites = patch.allowedSites
        .filter((site): site is string => typeof site === 'string')
        .map((site) => site.trim())
        .filter(Boolean)
    }
    try {
      writeJsonAtomic(this.filePath, next, this.backupInvalid)
    } catch (error) {
      throw new Error('设置保存失败，请检查文件或目录的写入权限。', { cause: error })
    }
    this.settings = next
    this.backupInvalid = false
    return this.get()
  }

  presets(): { label: string; url: string }[] {
    return PRESETS
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8')
      const parsed: unknown = JSON.parse(raw)
      this.settings = normalizeSettings(parsed)
      this.backupInvalid = !parsed || typeof parsed !== 'object' || Array.isArray(parsed)
        || Object.entries(parsed).some(([key, value]) => key in DEFAULTS && JSON.stringify(value) !== JSON.stringify(this.settings[key as keyof AppSettings]))
    } catch (error) {
      this.settings = normalizeSettings({})
      this.backupInvalid = error instanceof SyntaxError
    }
  }
}

let store: SettingsStore | null = null
export function getSettingsStore(): SettingsStore {
  if (!store) store = new SettingsStore()
  return store
}
