import { autoUpdater } from 'electron-updater'
import type { ProgressInfo, UpdateInfo } from 'electron-updater'

export type UpdateStatus = 'disabled' | 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  version?: string
  releaseDate?: string
  releaseNotes?: string
  size?: number
  downloaded?: number
  progress?: number
  bytesPerSecond?: number
  error?: string
  checkedAt?: number
}

type SettingsSnapshot = { autoUpdate: boolean; updateChannel: 'stable' | 'beta' }

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
      autoUpdater.autoDownload = false
      autoUpdater.autoInstallOnAppQuit = false
      autoUpdater.allowDowngrade = false
      autoUpdater.fullChangelog = true
      autoUpdater.on('checking-for-update', () => this.patch({ status: 'checking', error: undefined }))
      autoUpdater.on('update-not-available', (info) => this.applyInfo('up-to-date', info))
      autoUpdater.on('update-available', (info) => this.applyInfo('available', info))
      autoUpdater.on('download-progress', (progress) => this.applyProgress(progress))
      autoUpdater.on('update-downloaded', (info) => this.applyInfo('downloaded', info))
      autoUpdater.on('update-cancelled', (info) => this.applyInfo('available', info))
      autoUpdater.on('error', (error) => this.patch({ status: 'error', error: error.message || String(error), checkedAt: Date.now() }))
      this.state = { status: 'idle', currentVersion: this.currentVersion }
      this.schedule()
    }
    this.emit()
  }

  getState(): UpdateState { return { ...this.state } }

  async check(): Promise<UpdateState> {
    if (['disabled', 'checking', 'downloading', 'downloaded'].includes(this.state.status)) return this.getState()
    autoUpdater.allowPrerelease = this.getSettings().updateChannel === 'beta'
    autoUpdater.allowDowngrade = false
    this.patch({ status: 'checking', error: undefined })
    try { await autoUpdater.checkForUpdates() }
    catch (error) { this.patch({ status: 'error', error: error instanceof Error ? error.message : String(error), checkedAt: Date.now() }) }
    return this.getState()
  }

  async download(): Promise<UpdateState> {
    if (this.state.status !== 'available') return this.getState()
    try { this.patch({ status: 'downloading', error: undefined }); await autoUpdater.downloadUpdate() }
    catch (error) { this.patch({ status: 'error', error: error instanceof Error ? error.message : String(error), checkedAt: Date.now() }) }
    return this.getState()
  }

  install(): boolean {
    if (this.state.status !== 'downloaded') return false
    autoUpdater.quitAndInstall(false, true)
    return true
  }

  refreshSettings(): void {
    if (!this.initialized || this.state.status === 'disabled') return
    autoUpdater.allowPrerelease = this.getSettings().updateChannel === 'beta'
    this.schedule()
  }

  private schedule(): void {
    this.dispose()
    if (!this.getSettings().autoUpdate) return
    this.startupTimer = setTimeout(() => {
      this.startupTimer = null
      if (this.getSettings().autoUpdate) void this.check()
    }, 15000)
    this.timer = setInterval(() => { if (this.getSettings().autoUpdate) void this.check() }, 6 * 60 * 60 * 1000)
  }

  dispose(): void {
    if (this.timer !== null) clearInterval(this.timer)
    if (this.startupTimer !== null) clearTimeout(this.startupTimer)
    this.timer = null
    this.startupTimer = null
  }

  private applyInfo(status: UpdateStatus, info: UpdateInfo): void {
    this.patch({ status, version: info.version, releaseDate: info.releaseDate, releaseNotes: notesText(info.releaseNotes), size: sizeOf(info), progress: status === 'downloaded' ? 100 : undefined, checkedAt: Date.now(), error: undefined })
  }

  private applyProgress(progress: ProgressInfo): void {
    this.patch({ status: 'downloading', downloaded: progress.transferred, size: progress.total || this.state.size, progress: progress.percent, bytesPerSecond: progress.bytesPerSecond, error: undefined })
  }

  private patch(next: Partial<UpdateState>): void { this.state = { ...this.state, ...next }; this.emit() }
  private emit(): void { this.onChange() }
}
