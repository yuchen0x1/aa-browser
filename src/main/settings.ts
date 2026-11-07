import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

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
}

const DEFAULTS: AppSettings = {
  searchEngine: 'https://www.bing.com/search?q=',
  fullSnapshot: false,
  downloadDir: '',
  requireOperationApproval: false,
  allowedSites: []
}

const PRESETS: { label: string; url: string }[] = [
  { label: '必应 (Bing)', url: 'https://www.bing.com/search?q=' },
  { label: 'Google', url: 'https://www.google.com/search?q=' },
  { label: '百度', url: 'https://www.baidu.com/s?wd=' },
  { label: 'DuckDuckGo', url: 'https://duckduckgo.com/?q=' },
  { label: 'GitHub', url: 'https://github.com/search?q=' }
]

/** 用户设置：持久化到 ~/.aabrowser/settings.json，内存缓存，进程内生效 */
export class SettingsStore {
  private settings: AppSettings = { ...DEFAULTS }
  private loaded = false
  private filePath = process.env['AA_BROWSER_SETTINGS_FILE'] || path.join(os.homedir(), '.aabrowser', 'settings.json')

  get(): AppSettings {
    this.ensureLoaded()
    return { ...this.settings }
  }

  set(patch: Partial<AppSettings>): AppSettings {
    this.ensureLoaded()
    if (typeof patch.searchEngine === 'string' && patch.searchEngine.trim()) this.settings.searchEngine = patch.searchEngine.trim()
    if (typeof patch.fullSnapshot === 'boolean') this.settings.fullSnapshot = patch.fullSnapshot
    if (typeof patch.downloadDir === 'string') this.settings.downloadDir = patch.downloadDir.trim()
    if (typeof patch.requireOperationApproval === 'boolean') this.settings.requireOperationApproval = patch.requireOperationApproval
    if (Array.isArray(patch.allowedSites)) {
      this.settings.allowedSites = patch.allowedSites
        .filter((site): site is string => typeof site === 'string')
        .map((site) => site.trim())
        .filter(Boolean)
    }
    this.persist()
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
      const parsed = JSON.parse(raw) as Partial<AppSettings>
      this.settings = {
        ...DEFAULTS,
        ...parsed,
        allowedSites: Array.isArray(parsed.allowedSites)
          ? parsed.allowedSites.filter((site): site is string => typeof site === 'string').map((site) => site.trim()).filter(Boolean)
          : [...DEFAULTS.allowedSites]
      }
    } catch {
      this.settings = { ...DEFAULTS }
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      fs.writeFileSync(this.filePath, JSON.stringify(this.settings, null, 2))
    } catch {
      /* 忽略写入失败 */
    }
  }
}

let store: SettingsStore | null = null
export function getSettingsStore(): SettingsStore {
  if (!store) store = new SettingsStore()
  return store
}