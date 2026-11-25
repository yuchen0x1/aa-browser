import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeJsonAtomic } from './atomic-json'

/**
 * 跨会话标签恢复（崩溃/正常退出后重启）。
 *
 * 只保存「普通标签的网页地址、标签 id + 活动标签序号」：
 *   - 隔离标签本身是一次性会话，关闭即清理，恢复它只会得到一个看不到登录态的页面；
 *   - 新标签页、内部页、file:/data:/javascript: 等地址不写入；
 *   - 地址中的账号密码被剥离，避免把凭据写进明文会话文件。
 *
 * 文件写入使用原子替换；损坏或未来版本的文件返回 null，绝不阻塞启动。
 */

export const SESSION_VERSION = 3
export const MAX_RESTORE_TABS = 20
const MAX_TITLE_LENGTH = 300
/** 与 TabManager 的 genId 同一形状；恢复时只接受这种 id，避免任意字符串进入运行时。 */
const TAB_ID = /^t[a-z0-9]{1,32}$/

export interface SessionTab {
  url: string
  profileId?: string
  title?: string
  /**
   * v2：保留标签 id。更新重启后 Agent 手里的 tabId 仍然有效，
   * 已排队的重放调用和后续步骤不会因为 id 全部换新而失败。
   */
  id?: string
}

export interface SessionSnapshot {
  version: number
  savedAt: number
  activeIndex: number
  tabs: SessionTab[]
}

function normalizeSessionUrl(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const value = raw.trim()
  if (!value) return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.username = ''
    url.password = ''
    for (const key of [...url.searchParams.keys()]) if (/(?:token|secret|password|passwd|api[-_]?key|authorization|cookie|credential|session|code)/i.test(key)) url.searchParams.delete(key)
    if (/(?:token|secret|password|passwd|api[-_]?key|authorization|cookie|credential|session|code)=/i.test(url.hash)) url.hash = ''
    return url.toString()
  } catch {
    return null
  }
}

/** 把任意来源的数据归一化成可安全恢复的快照；没有可恢复标签时返回 null。 */
export function normalizeSessionSnapshot(value: unknown): SessionSnapshot | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const version = record.version
  // v1 只有地址；v2 增加标签 id。旧文件继续可读，保存时统一写成当前版本。
  if (version !== undefined && version !== 1 && version !== 2 && version !== SESSION_VERSION) return null

  const seen = new Set<string>()
  const seenIds = new Set<string>()
  const tabs: SessionTab[] = []
  const rawTabs = Array.isArray(record.tabs) ? record.tabs : []
  for (const item of rawTabs) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue
    const tab = item as Record<string, unknown>
    const url = normalizeSessionUrl(tab.url)
    const profileId = tab.profileId === undefined ? undefined : typeof tab.profileId === 'string' && /^(?:default|p[a-f0-9]{24})$/.test(tab.profileId) ? tab.profileId : null
    if (profileId === null) continue
    const key = `${profileId ?? 'default'}\n${url}`
    if (!url || seen.has(key)) continue
    seen.add(key)
    const title = typeof tab.title === 'string' ? tab.title.trim().slice(0, MAX_TITLE_LENGTH) : ''
    const id = typeof tab.id === 'string' && TAB_ID.test(tab.id) && !seenIds.has(tab.id) ? tab.id : undefined
    if (id) seenIds.add(id)
    tabs.push({ url, ...(profileId ? { profileId } : {}), ...(title ? { title } : {}), ...(id ? { id } : {}) })
    if (tabs.length >= MAX_RESTORE_TABS) break
  }
  if (!tabs.length) return null

  const rawIndex = record.activeIndex
  const activeIndex = typeof rawIndex === 'number' && Number.isFinite(rawIndex)
    ? Math.min(tabs.length - 1, Math.max(0, Math.floor(rawIndex)))
    : 0
  const savedAt = typeof record.savedAt === 'number' && Number.isFinite(record.savedAt) && record.savedAt >= 0
    ? record.savedAt
    : 0
  return { version: SESSION_VERSION, savedAt, activeIndex, tabs }
}

/** 标签恢复记录：默认 ~/.aabrowser/session.json，可用 AA_BROWSER_SESSION_FILE 覆盖（测试用）。 */
export class SessionStore {
  get filePath(): string {
    return process.env['AA_BROWSER_SESSION_FILE'] || path.join(os.homedir(), '.aabrowser', 'session.json')
  }

  /** 读取上次会话；不存在、损坏或版本不符时返回 null。 */
  load(): SessionSnapshot | null {
    try {
      return normalizeSessionSnapshot(JSON.parse(fs.readFileSync(this.filePath, 'utf-8')))
    } catch {
      return null
    }
  }

  /**
   * 保存当前可恢复标签。
   * 没有任何可恢复网页时删除旧记录，避免下次启动恢复过期页面。
   * 写入失败只记录警告：会话记录是尽力而为的便利功能，不能影响浏览。
   */
  save(tabs: { url: string; title?: string; id?: string; profileId?: string }[], activeIndex = 0): SessionSnapshot | null {
    const snapshot = normalizeSessionSnapshot({ version: SESSION_VERSION, savedAt: Date.now(), activeIndex, tabs })
    try {
      if (!snapshot) {
        fs.rmSync(this.filePath, { force: true })
        return null
      }
      writeJsonAtomic(this.filePath, snapshot)
      return snapshot
    } catch (error) {
      console.warn(`[aa-browser] 会话恢复记录保存失败: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }

  clear(): void {
    try {
      fs.rmSync(this.filePath, { force: true })
    } catch {
      /* 文件不存在或不可写：无需处理 */
    }
  }
}

let store: SessionStore | null = null
export function getSessionStore(): SessionStore {
  if (!store) store = new SessionStore()
  return store
}
