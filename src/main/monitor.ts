import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { nativeImage } from 'electron'
import type { MonitorState } from '@shared/types'
import type { Tab } from './tabs'
import { captureVisual } from './visual'
import { getEvidenceManager } from './evidence'

export interface MonitorFrame {
  tabId: string
  url: string
  title: string
  capturedAt: number
  width: number
  height: number
  image: string
  currentTask?: string
  pointer?: { kind: 'move' | 'click' | 'input'; x?: number; y?: number }
}

export interface MonitorDeps {
  getTab: (tabId?: string) => Tab | null
  emitState: (state: MonitorState) => void
  emitFrame: (frame: MonitorFrame) => void
}

const FRAME_INTERVAL_MS = 500
const MAX_HISTORY = 20
const CAPTURE_TIMEOUT_MS = 12_000

function monitorDir(): string {
  return process.env['AA_BROWSER_MONITOR_DIR'] || path.join(os.homedir(), '.aabrowser', 'monitor')
}

function cloneState(state: MonitorState): MonitorState {
  return { ...state, history: state.history.map((item) => ({ ...item })) }
}

function safeDisplayUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:token|secret|password|passwd|api[_-]?key|authorization|cookie)/i.test(key)) url.searchParams.set(key, '[redacted]')
    }
    return url.toString()
  } catch {
    return value.slice(0, 500)
  }
}

/**
 * 后台预览与人工接管协调器。
 *
 * 预览只捕获明确选择的标签页，不读取其它标签的 DOM、Cookie 或截图；
 * 人工接管由主进程锁住 AI 调用，释放时再显式恢复自动化，避免竞态。
 */
export class BrowserMonitor {
  private timer: ReturnType<typeof setInterval> | null = null
  private captureRunning = false
  private previewRequested = false
  private windowVisible = false
  private latestFrame?: MonitorFrame
  /** 每次 start/stop/setTab 递增，丢弃旧标签或已停止会话的迟到截图。 */
  private captureGeneration = 0
  private pointer: MonitorFrame['pointer']
  private pointerTabId?: string
  private state: MonitorState = {
    enabled: false,
    control: 'ai',
    status: 'idle',
    frameSeq: 0,
    history: []
  }

  constructor(private readonly deps: MonitorDeps) {}

  getState(): MonitorState {
    return cloneState(this.state)
  }

  setPreviewRequested(requested: boolean): void {
    this.previewRequested = requested
    if (requested && this.windowVisible && this.latestFrame) this.deps.emitFrame(this.latestFrame)
  }

  setWindowVisible(visible: boolean): void {
    this.windowVisible = visible
    if (visible && this.previewRequested && this.latestFrame) this.deps.emitFrame(this.latestFrame)
  }

  start(tabId?: string): MonitorState {
    const tab = this.deps.getTab(tabId)
    if (!tab) throw new Error(tabId ? `标签不存在: ${tabId}` : '没有可预览的标签页')
    this.captureGeneration++
    this.state.enabled = true
    this.state.tabId = tab.id
    this.pointer = undefined
    this.pointerTabId = undefined
    this.state.status = 'idle'
    if (!this.timer) this.timer = setInterval(() => { this.queueCapture() }, FRAME_INTERVAL_MS)
    this.queueCapture()
    this.deps.emitState(this.getState())
    return this.getState()
  }

  stop(): MonitorState {
    this.captureGeneration++
    this.state.enabled = false
    this.state.status = 'idle'
    this.state.currentTask = undefined
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.deps.emitState(this.getState())
    return this.getState()
  }

  setTab(tabId: string): MonitorState {
    if (!this.state.enabled) return this.start(tabId)
    const tab = this.deps.getTab(tabId)
    if (!tab) throw new Error(`标签不存在: ${tabId}`)
    this.captureGeneration++
    this.state.tabId = tab.id
    this.pointer = undefined
    this.pointerTabId = undefined
    this.queueCapture()
    this.deps.emitState(this.getState())
    return this.getState()
  }

  takeover(): MonitorState {
    this.state.control = 'human'
    // status 描述画面采集，不描述操作权；接管期间仍持续出帧。
    this.state.status = this.state.enabled ? 'capturing' : 'idle'
    this.deps.emitState(this.getState())
    return this.getState()
  }

  releaseToAi(): MonitorState {
    this.state.control = 'ai'
    this.state.status = 'idle'
    this.deps.emitState(this.getState())
    if (this.state.enabled) this.queueCapture()
    return this.getState()
  }

  /**
   * 定时器/公开方法里的截图都不该逃逸出拒绝：窗口关闭瞬间读取已销毁的
   * BaseWindow/WebContents 会同步抛错，变成进程级未处理拒绝后进程静默退出。
   */
  private queueCapture(): void {
    void this.capture().catch((error: unknown) => {
      if (this.state.enabled) {
        this.state.status = 'error'
        this.state.currentTask = error instanceof Error ? error.message : String(error)
      }
    })
  }

  recordTask(task: string | undefined): void {
    this.state.currentTask = task ? task.slice(0, 160) : undefined
    if (this.state.enabled && this.state.control === 'ai') this.state.status = task ? 'capturing' : 'idle'
    this.deps.emitState(this.getState())
  }

  recordPointer(tabId: string, pointer: MonitorFrame['pointer']): void {
    // 只记录当前预览标签的指针；否则切换标签后会显示另一个页面的坐标。
    if (tabId !== this.state.tabId) return
    this.pointer = pointer
    this.pointerTabId = tabId
  }

  historyFrame(capturedAt: number): MonitorFrame | null {
    if (!Number.isSafeInteger(capturedAt)) return null
    const entry = this.state.history.find((item) => item.capturedAt === capturedAt)
    if (!entry) return null
    const root = path.resolve(monitorDir())
    const file = path.resolve(entry.file)
    if (path.dirname(file) !== root || !/^frame-\d+-\d+\.png$/.test(path.basename(file))) return null
    try {
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.isSymbolicLink()) return null
      const image = nativeImage.createFromBuffer(fs.readFileSync(file))
      if (image.isEmpty()) return null
      const resized = image.getSize().width > 960 ? image.resize({ width: 960 }) : image
      return {
        tabId: entry.tabId,
        url: entry.url,
        title: entry.title,
        capturedAt: entry.capturedAt,
        width: resized.getSize().width,
        height: resized.getSize().height,
        image: resized.toPNG().toString('base64')
      }
    } catch {
      return null
    }
  }

  private async capture(): Promise<void> {
    // 人工接管时必须继续推送画面，让用户看得见自己正在操作的页面；只停止 AI 输入，
    // 不能因为接管而让预览黑屏或停在旧帧。
    if (!this.state.enabled || this.captureRunning) return
    // 前置步骤（取标签、keepRendering、emitState→pushState）同样可能抛错；
    // 全部纳入 try，避免任何一步逃逸成未处理拒绝。
    let releaseRendering: (() => void) | null = null
    let captureSettled = false
    let timeoutHandle: ReturnType<typeof setTimeout> | undefined
    let capturePromise: Promise<{ base64: string }> | null = null
    let generation = -1
    let tab: Tab | null = null
    try {
      tab = this.deps.getTab(this.state.tabId)
      if (!tab || tab.view.webContents.isDestroyed()) {
        this.state.status = 'error'
        this.state.currentTask = '监控标签已关闭'
        this.deps.emitState(this.getState())
        return
      }
      this.captureRunning = true
      generation = this.captureGeneration
      this.state.status = 'capturing'
      this.deps.emitState(this.getState())
      const target = tab
      releaseRendering = target.keepRendering()
      capturePromise = captureVisual(target.view.webContents, {
        background: !target.canUseWindowInput(),
        isWindowMinimized: () => target.isWindowMinimized?.() ?? false
      }).finally(() => { captureSettled = true })
      const capture = await Promise.race([
        capturePromise,
        new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => reject(new Error('监控截图超时')), CAPTURE_TIMEOUT_MS)
        })
      ])
      const image = nativeImage.createFromBuffer(Buffer.from(capture.base64, 'base64'))
      if (image.isEmpty()) throw new Error('监控截图为空')
      const resized = image.getSize().width > 960 ? image.resize({ width: 960 }) : image
      const png = resized.toPNG()
      const capturedAt = Date.now()
      // stop()/start()/setTab() 可能在截图等待期间发生：旧画面不得写入新会话历史，
      // 也不得把已停止的监控重新标成 idle。
      if (generation !== this.captureGeneration) return
      const dir = monitorDir()
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const file = path.join(dir, `frame-${capturedAt}-${++this.state.frameSeq}.png`)
      fs.writeFileSync(file, png, { mode: 0o600, flag: 'wx' })
      getEvidenceManager().record(file, 'screenshot', { managed: true })
      const url = safeDisplayUrl(tab.view.webContents.getURL() || tab.url)
      const title = tab.view.webContents.getTitle() || tab.title
      const pointer = this.pointerTabId === tab.id ? this.pointer : undefined
      this.state.lastFrameAt = capturedAt
      this.state.status = 'idle'
      this.state.history.push({ file, capturedAt, tabId: tab.id, title, url, width: resized.getSize().width, height: resized.getSize().height })
      while (this.state.history.length > MAX_HISTORY) {
        const old = this.state.history.shift()
        if (!old) break
        try { fs.unlinkSync(old.file) } catch { /* 已被证据清理 */ }
        getEvidenceManager().forget(old.file)
      }
      const frame: MonitorFrame = {
        tabId: tab.id,
        url,
        title,
        capturedAt,
        width: resized.getSize().width,
        height: resized.getSize().height,
        image: png.toString('base64'),
        currentTask: this.state.currentTask,
        pointer
      }
      this.latestFrame = frame
      if (this.previewRequested && this.windowVisible) this.deps.emitFrame(frame)
    } catch (error) {
      if (generation === this.captureGeneration) {
        this.state.status = 'error'
        this.state.currentTask = error instanceof Error ? error.message : String(error)
      }
    } finally {
      if (timeoutHandle) clearTimeout(timeoutHandle)
      const finishCapture = (): void => {
        releaseRendering?.()
        this.captureRunning = false
        this.deps.emitState(this.getState())
      }
      if (!capturePromise) {
        // 还没进入截图阶段：仍需归还占位状态。
        if (this.captureRunning) {
          this.captureRunning = false
          if (releaseRendering) finishCapture()
        }
      } else if (captureSettled) finishCapture()
      else {
        void capturePromise.then(finishCapture, finishCapture)
      }
    }
  }
}

