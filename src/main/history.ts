import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeJsonAtomic } from './atomic-json'

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
  private backupInvalid = false

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
      const arr: unknown = JSON.parse(raw)
      if (Array.isArray(arr)) {
        for (const item of arr) {
          if (!item || typeof item !== 'object' || typeof item.url !== 'string' || !isHistoryUrl(item.url)) {
            this.backupInvalid = true
            continue
          }
          const entry: HistoryEntry = {
            url: item.url,
            title: typeof item.title === 'string' ? item.title : item.url,
            ts: typeof item.ts === 'number' && Number.isFinite(item.ts) && item.ts >= 0 ? item.ts : 0,
            count: typeof item.count === 'number' && Number.isFinite(item.count) && item.count > 0 ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(item.count)) : 1
          }
          if (JSON.stringify(item) !== JSON.stringify(entry)) this.backupInvalid = true
          this.entries.push(entry)
        }
        this.entries = this.entries.slice(-MAX_ENTRIES)
      } else this.backupInvalid = true
    } catch (error) {
      this.entries = []
      this.backupInvalid = error instanceof SyntaxError
    }
  }

  private persist(): void {
    try {
      writeJsonAtomic(this.file(), this.entries.slice(-MAX_ENTRIES), this.backupInvalid)
      this.backupInvalid = false
    } catch {
      console.warn('[aa-browser] 历史记录保存失败，原文件保留，当前记录暂存在内存中。')
    }
  }

  /** 记录一次访问（忽略新标签页/内部页） */
  add(url: string, title: string): void {
    if (!isHistoryUrl(url)) return
    this.ensureLoaded()
    const idx = this.entries.findIndex((e) => e.url === url)
    if (idx >= 0) {
      const e = this.entries[idx]
      e.title = title || e.title
      e.count = Math.min(Number.MAX_SAFE_INTEGER, e.count + 1)
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
    return scored.slice(0, boundedLimit(limit, MAX_ENTRIES)).map((x) => ({ ...x.e }))
  }

  list(limit = 50): HistoryEntry[] {
    this.ensureLoaded()
    const count = boundedLimit(limit, MAX_ENTRIES)
    return count ? this.entries.slice(-count).reverse().map((entry) => ({ ...entry })) : []
  }
}

function boundedLimit(value: number, maximum: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(maximum, Math.floor(value))) : 0
}

function isHistoryUrl(value: string): boolean {
  try { return ['http:', 'https:'].includes(new URL(value).protocol) } catch { return false }
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
