import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface HistoryEntry {
  url: string
  title: string
  ts: number
  /** 访问次数（用于补全排序） */
  count: number
}

const MAX_ENTRIES = 1000

/** 跨会话历史：追加式写 ~/.aabrowser/history/，并提供标题/URL 前缀补全。 */
export class HistoryStore {
  private entries: HistoryEntry[] = []
  private loaded = false

  get dir(): string {
    return process.env['AA_BROWSER_HISTORY_DIR'] || path.join(os.homedir(), '.aabrowser', 'history')
  }

  private file(): string {
    return path.join(this.dir, 'history.json')
  }

  private ensureLoaded(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = fs.readFileSync(this.file(), 'utf8')
      const arr = JSON.parse(raw) as HistoryEntry[]
      if (Array.isArray(arr)) this.entries = arr
    } catch {
      this.entries = []
    }
  }

  private persist(): void {
    try {
      fs.mkdirSync(this.dir, { recursive: true })
      fs.writeFileSync(this.file(), JSON.stringify(this.entries.slice(-MAX_ENTRIES)))
    } catch {
      /* 忽略写入失败 */
    }
  }

  /** 记录一次访问（忽略新标签页/内部页） */
  add(url: string, title: string): void {
    if (!url || /^(about:|chrome:|devtools:|view-source:|data:|blob:|file:)/i.test(url)) return
    this.ensureLoaded()
    const idx = this.entries.findIndex((e) => e.url === url)
    if (idx >= 0) {
      const e = this.entries[idx]
      e.title = title || e.title
      e.count += 1
      e.ts = Date.now()
      this.entries.splice(idx, 1)
      this.entries.push(e)
    } else {
      this.entries.push({ url, title: title || url, ts: Date.now(), count: 1 })
    }
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES)
    this.persist()
  }

  /** 按前缀查询补全建议：优先标题/URL 前缀匹配，按 count 排序 */
  suggest(query: string, limit = 8): HistoryEntry[] {
    this.ensureLoaded()
    const q = (query || '').trim().toLowerCase()
    if (!q) return []
    const scored: { e: HistoryEntry; s: number }[] = []
    for (const e of this.entries) {
      const host = safeHost(e.url)
      const title = (e.title || '').toLowerCase()
      const url = e.url.toLowerCase()
      let s = 0
      if (host.startsWith(q)) s = 100
      else if (url.startsWith(q)) s = 80
      else if (host.includes(q)) s = 50
      else if (title.includes(q)) s = 40
      if (s > 0) scored.push({ e, s: s + Math.min(20, e.count) + (e.ts > Date.now() - 3600e3 ? 10 : 0) })
    }
    scored.sort((a, b) => b.s - a.s)
    return scored.slice(0, Math.min(limit, scored.length)).map((x) => x.e)
  }

  list(limit = 50): HistoryEntry[] {
    this.ensureLoaded()
    return this.entries.slice(-Math.min(limit, this.entries.length)).reverse()
  }
}

function safeHost(u: string): string {
  try {
    return new URL(u).host
  } catch {
    return u
  }
}

/** 模块级单例 */
let store: HistoryStore | null = null
export function getHistoryStore(): HistoryStore {
  if (!store) store = new HistoryStore()
  return store
}