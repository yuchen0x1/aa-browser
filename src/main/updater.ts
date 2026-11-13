import { autoUpdater } from 'electron-updater'
import type { ProgressInfo, UpdateInfo } from 'electron-updater'
import type { UpdateState, UpdateStatus } from '../shared/types'
export type { UpdateState, UpdateStatus } from '../shared/types'

export const UPDATE_STARTUP_DELAY_MS = 5_000
export const UPDATE_INTERVAL_MS = 15 * 60_000
export const UPDATE_WAKE_COOLDOWN_MS = 2 * 60_000
const RETRY_DELAYS = [60_000, 5 * 60_000, 15 * 60_000]

type SettingsSnapshot = { autoUpdate: boolean; updateChannel: 'stable' | 'beta' }
type UpdateEvent = Parameters<typeof autoUpdater.on>[0]

function notesText(notes: UpdateInfo['releaseNotes']): string | undefined {
  if (!notes) return undefined
  if (typeof notes === 'string') return notes
  return notes.map((item) => item.note ? `${item.version}: ${item.note}` : item.version).join('\n') || undefined
}

function sizeOf(info: UpdateInfo): number | undefined {
  const value = info.files?.reduce((max, file) => Math.max(max, Number(file.size ?? 0)), 0)
  return value > 0 ? value : undefined
}

export class UpdateManager {
  private state: UpdateState
  private timer: ReturnType<typeof setInterval> | null = null
  private startupTimer: ReturnType<typeof setTimeout> | null = null
  private retryTimer: ReturnType<typeof setTimeout> | null = null
  private retryCount = 0
  private dismissedNotice = ''
  private stopped = false
  private listeners: { event: UpdateEvent; handler: (...args: any[]) => void }[] = []
  private initialized = false
  private onChange: () => void = () => {}

  constructor(
    private readonly currentVersion: string,
    private readonly getSettings: () => SettingsSnapshot,
    private readonly enabled = true
  ) {
    this.state = { status: 'disabled', currentVersion }
  }

  init(onChange: () => void): void {
    if (this.initialized) return
    this.initialized = true
    this.onChange = onChange
    // electron-updater is only meaningful for a packaged application. In
    // development (`electron .` / electron-vite) it must stay fully inert:
    // no timer and no checkForUpdates call against a non-existent app-update.yml.
    if (this.enabled) {
      autoUpdater.autoDownload = this.getSettings().autoUpdate
      autoUpdater.autoInstallOnAppQuit = false
      autoUpdater.allowDowngrade = false
      autoUpdater.fullChangelog = true
      this.listen('checking-for-update', () => this.patch({ status: 'checking', error: undefined, checkedAt: Date.now() }))
      this.listen('update-not-available', (info: UpdateInfo) => this.applyInfo('up-to-date', info))
      this.listen('update-available', (info: UpdateInfo) => this.applyInfo(autoUpdater.autoDownload ? 'downloading' : 'available', info))
      this.listen('download-progress', (progress: ProgressInfo) => this.applyProgress(progress))
      this.listen('update-downloaded', (info: UpdateInfo) => this.applyInfo('downloaded', info))
      this.listen('update-cancelled', (info: UpdateInfo) => this.applyInfo('available', info))
      this.listen('error', (error: Error) => this.fail(error, this.state.status === 'downloading' ? 'download' : this.state.failedOperation ?? 'check'))
      this.state = { status: 'idle', currentVersion: this.currentVersion }
      this.schedule()
    }
    this.emit()
  }

  getState(): UpdateState {
    const notice = ['available', 'downloading', 'downloaded', 'error'].includes(this.state.status)
    return { ...this.state, noticeVisible: notice && this.dismissedNotice !== this.noticeKey() }
  }

  dismissNotice(): void { this.dismissedNotice = this.noticeKey(); this.emit() }

  private noticeKey(): string { return `${this.state.status}:${this.state.version ?? ''}` }

  private listen(event: UpdateEvent, handler: (...args: any[]) => void): void {
    this.listeners.push({ event, handler })
    autoUpdater.on(event, handler)
  }

  async check(): Promise<UpdateState> {
    if (this.stopped || ['disabled', 'checking', 'downloading', 'downloaded'].includes(this.state.status)) return this.getState()
    this.clearRetry()
    autoUpdater.autoDownload = this.getSettings().autoUpdate
    autoUpdater.allowPrerelease = this.getSettings().updateChannel === 'beta'
    autoUpdater.allowDowngrade = false
    this.patch({ status: 'checking', error: undefined, failedOperation: undefined, checkedAt: Date.now() })
    try {
      const result = await autoUpdater.checkForUpdates()
      void result?.downloadPromise?.catch((error: unknown) => this.fail(error, 'download'))
    } catch (error) { this.fail(error, 'check') }
    return this.getState()
  }

  async download(): Promise<UpdateState> {
    if (this.stopped || !(this.state.status === 'available' || this.state.status === 'error' && this.state.failedOperation === 'download')) return this.getState()
    this.clearRetry()
    try { this.patch({ status: 'downloading', error: undefined, failedOperation: undefined }); await autoUpdater.downloadUpdate() }
    catch (error) { this.fail(error, 'download') }
    return this.getState()
  }

  install(): boolean {
    if (this.state.status !== 'downloaded') return false
    autoUpdater.quitAndInstall(false, true)
    return true
  }

  async retry(): Promise<UpdateState> {
    return this.state.failedOperation === 'download' ? this.download() : this.check()
  }

  async checkIfDue(): Promise<UpdateState> {
    if (!this.getSettings().autoUpdate) return this.getState()
    if (this.state.status !== 'error' && this.state.checkedAt && Date.now() - this.state.checkedAt < UPDATE_WAKE_COOLDOWN_MS) return this.getState()
    return this.state.status === 'error' ? this.retry() : this.check()
  }

  refreshSettings(): void {
    if (!this.initialized || this.state.status === 'disabled') return
    autoUpdater.allowPrerelease = this.getSettings().updateChannel === 'beta'
    autoUpdater.autoDownload = this.getSettings().autoUpdate
    this.schedule()
  }

  private schedule(): void {
    this.clearTimers()
    if (!this.getSettings().autoUpdate) return
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null
      if (this.getSettings().autoUpdate) void this.check()
    }, UPDATE_STARTUP_DELAY_MS)
    this.timer = setInterval(() => { if (this.getSettings().autoUpdate) void this.checkIfDue() }, UPDATE_INTERVAL_MS)
  }

  dispose(): void {
    this.stopped = true
    this.clearTimers()
    for (const { event, handler } of this.listeners) autoUpdater.removeListener(event, handler)
    this.listeners = []
  }

  private clearRetry(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer)
    this.retryTimer = null
    this.state.retryAt = undefined
  }

  private clearTimers(): void {
    if (this.timer !== null) clearInterval(this.timer)
    if (this.startupTimer !== null) clearTimeout(this.startupTimer)
    this.timer = null
    this.startupTimer = null
    this.clearRetry()
  }

  private fail(error: unknown, operation: 'check' | 'download'): void {
    if (this.stopped) return
    const message = (error instanceof Error ? error.message : String(error)).slice(0, 1500)
    if (this.state.status === 'error' && this.state.error === message && this.state.failedOperation === operation) return
    this.clearRetry()
    const delay = this.getSettings().autoUpdate ? RETRY_DELAYS[this.retryCount++] : undefined
    if (delay) {
      this.retryTimer = setTimeout(() => { this.retryTimer = null; void this.retry() }, delay)
    }
    this.patch({ status: 'error', error: message, failedOperation: operation, checkedAt: Date.now(), retryAt: delay ? Date.now() + delay : undefined })
  }

  private applyInfo(status: UpdateStatus, info: UpdateInfo): void {
    this.retryCount = 0
    this.clearRetry()
    this.patch({ status, version: info.version, releaseDate: info.releaseDate, releaseNotes: notesText(info.releaseNotes), size: sizeOf(info), progress: status === 'downloaded' ? 100 : status === 'downloading' ? 0 : undefined, checkedAt: Date.now(), error: undefined, failedOperation: undefined, downloaded: undefined, bytesPerSecond: undefined })
  }

  private applyProgress(progress: ProgressInfo): void {
    this.patch({ status: 'downloading', downloaded: progress.transferred, size: progress.total || this.state.size, progress: progress.percent, bytesPerSecond: progress.bytesPerSecond, error: undefined })
  }

  private patch(next: Partial<UpdateState>): void { if (this.stopped) return; this.state = { ...this.state, ...next }; this.emit() }
  private emit(): void { this.onChange() }
}
