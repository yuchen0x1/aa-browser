import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { shell } from 'electron'
import type { Session, DownloadItem } from 'electron'
import { diagnosticMessage, errorDetail } from '../shared/diagnostics'
import { getMainLocale } from './locale'
import { DEFAULT_PROFILE_ID, getProfileManager } from './profiles'
import { redactText } from './redaction'

/** 一条下载记录 */
export interface DownloadRecord {
  id: string
  profileId: string
  filename: string
  url: string
  savePath: string
  totalBytes: number
  receivedBytes: number
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  ts: number
  /** 由哪条记录重试而来（仅重试产生的新记录有） */
  retriedFrom?: string
}

const MAX_RECORDS = 100
/** 进度每秒最多推送一次，避免高频刷屏 */
const PROGRESS_THROTTLE_MS = 1000

function defaultDownloadDir(): string {
  return process.env['AA_BROWSER_DOWNLOAD_DIR'] || path.join(os.homedir(), '.aabrowser', 'downloads')
}

function truncateFilename(value: string, maxBytes: number): string {
  let result = ''
  let bytes = 0
  for (const character of value) {
    const size = Buffer.byteLength(character)
    if (bytes + size > maxBytes) break
    result += character
    bytes += size
  }
  return result
}

/** Keep the unique prefix without exceeding common filesystem leaf-name limits. */
function downloadBasename(prefix: string, filename: string): string {
  const budget = 255 - Buffer.byteLength(prefix)
  const extension = truncateFilename(path.extname(filename), Math.min(40, budget))
  const stem = filename.slice(0, filename.length - path.extname(filename).length)
  return prefix + truncateFilename(stem, budget - Buffer.byteLength(extension)) + extension
}

/**
 * 下载追踪器：捕获浏览器各隔离 session 的下载，自动静默保存。
 * （preventDefault + setSavePath，避免弹保存对话框打断 Agent）。
 */
export class DownloadTracker {
  private records: DownloadRecord[] = []
  private attachedSessions = new WeakSet<Session>()
  /** 仍在进行的下载：id -> item + 所属 session（取消与重试都要用） */
  private activeItems = new Map<string, { item: DownloadItem; session: Session }>()
  /** 记录 -> 发起它的 session（完成后仍保留，用于重试） */
  private recordSessions = new Map<string, Session>()
  /** 发起重试时排队的来源记录；will-download 用它标注新记录 */
  private pendingRetries: { id: string; url: string; ts: number; session: Session }[] = []
  /** URL 白名单校验（由主进程注入；未注入时拒绝重试） */
  private urlGuard: (url: string) => boolean = () => false
  private directoryProvider: () => string = defaultDownloadDir
  private lastPush = 0
  private sessionProfiles = new WeakMap<Session, string>()
  /** 下载列表变化时回调（主进程用来 pushState） */
  onChange: (() => void) | null = null

  setDirectoryProvider(provider: () => string): void {
    this.directoryProvider = provider
  }

  /** 主进程注入站点白名单校验；重试前必须重新校验 URL，不能绕过导航白名单。 */
  setUrlGuard(guard: (url: string) => boolean): void {
    this.urlGuard = guard
  }

  private notify(): void {
    const now = Date.now()
    if (now - this.lastPush < PROGRESS_THROTTLE_MS) return
    this.lastPush = now
    this.onChange?.()
  }

  private directoryFor(profileId: string): string {
    return profileId === DEFAULT_PROFILE_ID ? this.directoryProvider() || defaultDownloadDir() : getProfileManager().directory(profileId, 'downloads')
  }

  private visible(record: DownloadRecord, profileId?: string): boolean {
    const profiles = getProfileManager()
    const selected = profileId ?? (profiles.hasContext() ? profiles.currentProfileId() : undefined)
    return selected === undefined || record.profileId === selected
  }

  attach(session: Session, profileId = DEFAULT_PROFILE_ID): void {
    if (this.attachedSessions.has(session)) return
    this.attachedSessions.add(session)
    this.sessionProfiles.set(session, profileId)
    session.on('will-download', (_event, item: DownloadItem) => {
      const dir = this.directoryFor(profileId)
      try {
        let ancestor = path.resolve(dir)
        for (;;) {
          if (fs.existsSync(ancestor) && fs.lstatSync(ancestor).isSymbolicLink()) throw new Error('Unsafe download directory')
          const parent = path.dirname(ancestor)
          if (parent === ancestor) break
          ancestor = parent
        }
        fs.mkdirSync(dir, { recursive: true })
      } catch {
        item.cancel()
        return
      }
      const stamp = Date.now().toString(36)
      const downloadId = randomUUID()
      const downloadUrl = item.getURL()
      // 只有 URL 匹配才认领重试记录，避免启动失败后把下一条无关下载标成 -r。
      const retryIndex = this.pendingRetries.findIndex((p) => p.url === downloadUrl && p.session === session)
      const retriedFrom = retryIndex >= 0 ? this.pendingRetries.splice(retryIndex, 1)[0].id : undefined
      const rawFilename = item.getFilename() || `download-${stamp}`
      // Chromium normally supplies a basename, but a hostile server can still
      // return separators or traversal segments in Content-Disposition.
      // biome-ignore lint/suspicious/noControlCharactersInRegex: This sanitizer intentionally matches ASCII control characters in untrusted filenames.
      const filename = path.basename(rawFilename).replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_').trim() || `download-${stamp}`
      const savePath = path.join(dir, downloadBasename(`${stamp}-${downloadId}${retriedFrom ? '-r' : '-'}`, filename))
      item.setSavePath(savePath)

      const record: DownloadRecord = {
        id: `d${downloadId.replace(/-/g, '')}`,
        profileId,
        filename,
        url: item.getURL(),
        savePath,
        totalBytes: item.getTotalBytes(),
        receivedBytes: 0,
        state: 'progressing',
        ts: Date.now(),
        ...(retriedFrom ? { retriedFrom } : {})
      }
      this.records.push(record)
      this.activeItems.set(record.id, { item, session })
      this.recordSessions.set(record.id, session)
      while (this.records.length > MAX_RECORDS) {
        const index = this.records.findIndex((entry) => !this.activeItems.has(entry.id))
        if (index < 0) break
        const [evicted] = this.records.splice(index, 1)
        this.recordSessions.delete(evicted.id)
      }
      this.notify()

      item.on('updated', (_e, state) => {
        record.receivedBytes = item.getReceivedBytes()
        record.totalBytes = item.getTotalBytes()
        record.state = state === 'interrupted' ? 'interrupted' : 'progressing'
        this.notify()
      })
      item.once('done', (_e, state) => {
        record.receivedBytes = item.getReceivedBytes()
        record.totalBytes = item.getTotalBytes()
        record.state = state as DownloadRecord['state']
        this.activeItems.delete(record.id)
        this.onChange?.()
      })
    })
  }

  list(limit = 20, profileId?: string): DownloadRecord[] {
    return this.records.filter((record) => this.visible(record, profileId)).slice(-Math.min(100, Math.max(1, limit))).map((record) => ({ ...record, url: redactText(record.url, 4000) }))
  }

  /** 下载目录（与 attach 保持一致） */
  get dir(): string {
    return this.directoryFor(getProfileManager().currentProfileId())
  }

  /** 打开文件（仅已完成的下载；返回失败原因供 UI 展示） */
  async open(id: string): Promise<{ ok: boolean; reason?: string }> {
    const locale = getMainLocale()
    const rec = this.records.find((r) => r.id === id && this.visible(r))
    if (!rec) return { ok: false, reason: diagnosticMessage(locale, 'downloads.missing', id) }
    if (rec.state !== 'completed') {
      return { ok: false, reason: diagnosticMessage(locale, 'downloads.notCompleted', rec.state) }
    }
    if (!fs.existsSync(rec.savePath)) {
      return { ok: false, reason: diagnosticMessage(locale, 'downloads.openFailed', rec.savePath) }
    }
    const error = await shell.openPath(rec.savePath)
    return error ? { ok: false, reason: diagnosticMessage(locale, 'downloads.openFailed', error) } : { ok: true }
  }

  /** 在系统文件管理器中显示 */
  showInFolder(id: string): void {
    const rec = this.records.find((r) => r.id === id && this.visible(r))
    if (!rec) return
    shell.showItemInFolder(rec.savePath)
  }

  /** 取消正在进行的下载；已完成/已取消的记录返回 false。 */
  cancel(id: string): boolean {
    if (!this.records.some((record) => record.id === id && this.visible(record))) return false
    const active = this.activeItems.get(id)
    if (!active) return false
    try {
      active.item.cancel()
    } catch {
      /* 下载项可能已随页面销毁 */
    }
    const rec = this.records.find((r) => r.id === id && this.visible(r))
    if (rec) rec.state = 'cancelled'
    this.activeItems.delete(id)
    this.onChange?.()
    return true
  }
  cancelProfile(profileId: string): number {
    let count = 0
    getProfileManager().runWithProfile(profileId, () => {
      for (const record of this.records) if (record.profileId === profileId && this.cancel(record.id)) count++
    })
    return count
  }

  /**
   * 重试一条已结束的下载：新建一次下载，文件名带 -r 前缀避免覆盖原文件。
   * URL 必须用主进程注入的白名单重新校验，防止绕过站点限制。
   */
  async retry(id: string): Promise<{ ok: boolean; reason?: string }> {
    const locale = getMainLocale()
    const rec = this.records.find((r) => r.id === id && this.visible(r))
    if (!rec) return { ok: false, reason: diagnosticMessage(locale, 'downloads.missing', id) }
    if (this.activeItems.has(id) || rec.state === 'progressing') {
      return { ok: false, reason: diagnosticMessage(locale, 'downloads.active') }
    }
    if (rec.state === 'completed') {
      return { ok: false, reason: diagnosticMessage(locale, 'downloads.retryCompleted') }
    }
    if (!this.urlGuard(rec.url)) return { ok: false, reason: diagnosticMessage(locale, 'downloads.notAllowed') }

    const session = this.recordSessions.get(id)
    if (!session) return { ok: false, reason: diagnosticMessage(locale, 'downloads.noSession') }
    const pending = { id, url: rec.url, ts: Date.now(), session }
    this.pendingRetries.push(pending)
    const discard = (): void => {
      const index = this.pendingRetries.indexOf(pending)
      if (index >= 0) this.pendingRetries.splice(index, 1)
    }
    // 60 秒没有 will-download 就丢弃，避免永远占位并误标后续下载。
    const timer = setTimeout(discard, 60_000)
    timer.unref?.()
    try {
      // Electron 45 返回 Promise；旧版本的同步异常也要捕获。
      await session.downloadURL(rec.url)
    } catch (error) {
      clearTimeout(timer)
      discard()
      return { ok: false, reason: diagnosticMessage(locale, 'downloads.failed', errorDetail(error)) }
    }
    return { ok: true }
  }
}

/** 模块级单例：下载追踪器（覆盖所有标签页隔离 session） */
let tracker: DownloadTracker | null = null
export function getDownloadTracker(): DownloadTracker {
  if (!tracker) tracker = new DownloadTracker()
  return tracker
}
