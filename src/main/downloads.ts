import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
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

/**
 * 下载追踪器：捕获 defaultSession 的下载，自动静默保存到 ~/.aabrowser/downloads/
 * （preventDefault + setSavePath，避免弹保存对话框打断 Agent）。
 */
export class DownloadTracker {
  private records: DownloadRecord[] = []
  private attached = false

  attach(session: Session): void {
    if (this.attached) return
    this.attached = true
    session.on('will-download', (_event, item: DownloadItem) => {
      const dir = process.env['AA_BROWSER_DOWNLOAD_DIR'] || path.join(os.homedir(), '.aabrowser', 'downloads')
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

      item.on('updated', (_e, state) => {
        record.receivedBytes = item.getReceivedBytes()
        record.totalBytes = item.getTotalBytes()
        record.state = state === 'interrupted' ? 'interrupted' : 'progressing'
      })
      item.once('done', (_e, state) => {
        record.receivedBytes = item.getReceivedBytes()
        record.totalBytes = item.getTotalBytes()
        record.state = state as DownloadRecord['state']
      })
    })
  }

  list(limit = 20): DownloadRecord[] {
    return this.records.slice(-Math.min(100, Math.max(1, limit)))
  }
}

/** 模块级单例：下载追踪器（defaultSession 全局生效） */
let tracker: DownloadTracker | null = null
export function getDownloadTracker(): DownloadTracker {
  if (!tracker) tracker = new DownloadTracker()
  return tracker
}
