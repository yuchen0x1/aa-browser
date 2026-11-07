import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { shell } from 'electron'
import type { Session, DownloadItem } from 'electron'

/** 一条下载记录 */
export interface DownloadRecord {
  id: string
  filename: string
  url: string
  savePath: string
  totalBytes: number
  receivedBytes: number
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  ts: number
}

const MAX_RECORDS = 100
/** 进度每秒最多推送一次，避免高频刷屏 */
const PROGRESS_THROTTLE_MS = 1000

function defaultDownloadDir(): string {
  return process.env['AA_BROWSER_DOWNLOAD_DIR'] || path.join(os.homedir(), '.aabrowser', 'downloads')
}

/**
 * 下载追踪器：捕获浏览器各隔离 session 的下载，自动静默保存。
 * （preventDefault + setSavePath，避免弹保存对话框打断 Agent）。
 */
export class DownloadTracker {
  private records: DownloadRecord[] = []
  private attachedSessions = new WeakSet<Session>()
  private directoryProvider: () => string = defaultDownloadDir
  private lastPush = 0
  /** 下载列表变化时回调（主进程用来 pushState） */
  onChange: (() => void) | null = null

  setDirectoryProvider(provider: () => string): void {
    this.directoryProvider = provider
  }

  private notify(): void {
    const now = Date.now()
    if (now - this.lastPush < PROGRESS_THROTTLE_MS) return
    this.lastPush = now
    this.onChange?.()
  }

  attach(session: Session): void {
    if (this.attachedSessions.has(session)) return
    this.attachedSessions.add(session)
    session.on('will-download', (_event, item: DownloadItem) => {
      const dir = this.directoryProvider() || defaultDownloadDir()
      try {
        fs.mkdirSync(dir, { recursive: true })
      } catch {
        /* 忽略 */
      }
      const stamp = Date.now().toString(36)
      const filename = item.getFilename() || `download-${stamp}`
      const savePath = path.join(dir, `${stamp}-${filename}`)
      item.setSavePath(savePath)

      const record: DownloadRecord = {
        id: `d${stamp}${this.records.length}`,
        filename,
        url: item.getURL(),
        savePath,
        totalBytes: item.getTotalBytes(),
        receivedBytes: 0,
        state: 'progressing',
        ts: Date.now()
      }
      this.records.push(record)
      if (this.records.length > MAX_RECORDS) this.records.splice(0, this.records.length - MAX_RECORDS)
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
        this.onChange?.()
      })
    })
  }

  list(limit = 20): DownloadRecord[] {
    return this.records.slice(-Math.min(100, Math.max(1, limit)))
  }

  /** 下载目录（与 attach 保持一致） */
  get dir(): string {
    return this.directoryProvider() || defaultDownloadDir()
  }

  /** 打开文件（用系统默认应用） */
  open(id: string): void {
    const rec = this.records.find((r) => r.id === id)
    if (!rec) return
    void shell.openPath(rec.savePath)
  }

  /** 在系统文件管理器中显示 */
  showInFolder(id: string): void {
    const rec = this.records.find((r) => r.id === id)
    if (!rec) return
    shell.showItemInFolder(rec.savePath)
  }
}

/** 模块级单例：下载追踪器（覆盖所有标签页隔离 session） */
let tracker: DownloadTracker | null = null
export function getDownloadTracker(): DownloadTracker {
  if (!tracker) tracker = new DownloadTracker()
  return tracker
}
