import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { nativeImage } from 'electron'
import type { MonitorState } from '@shared/types'
import type { Tab } from './tabs'
import { captureVisual } from './visual'
import { getEvidenceManager, type EvidenceEntry } from './evidence'

export interface MonitorFrame {
  tabId: string
  profileId?: string
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
/**
 * 监控截图的总上限。必须大于 captureVisual 内部各路径预算之和
 * （capturePage 3.5s + CDP 两级各 6s ≈ 15.5s），否则外层超时总会先触发，
 * 内部兜底永远轮不到执行。
 */
const CAPTURE_TIMEOUT_MS = 20_000
let contextProfile = (): string | undefined => undefined
let directoryProvider: ((profileId: string) => string) | undefined

export function configureMonitorProfiles(current: () => string | undefined, directoryFor: (profileId: string) => string): void {
  contextProfile = current
  directoryProvider = directoryFor
}

function monitorDir(profileId: string): string {
  return path.resolve((profileId === 'default' ? process.env.AA_BROWSER_MONITOR_DIR : undefined) || directoryProvider?.(profileId) ||
    (profileId === 'default' ? path.join(os.homedir(), '.aabrowser', 'monitor') : path.join(os.homedir(), '.aabrowser', 'profiles', profileId, 'monitor')))
}

function assertNoLinks(file: string): void {
  for (let current = path.resolve(file); ; current = path.dirname(current)) {
    try {
      if (fs.lstatSync(current).isSymbolicLink()) throw new Error('[FILE_LINK_DENIED] Monitor paths cannot contain symbolic links or junctions.')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    if (path.dirname(current) === current) break
  }
}

function cloneState(state: MonitorState): MonitorState {
  return { ...state, history: state.history.map((item) => ({ ...item })) }
}

function safeDisplayUrl(value: string): string {
  try {
    const url = new URL(value)
    url.username = ''
    url.password = ''
    url.search = ''
    url.hash = ''
    return url.toString()
  } catch {
    return '[invalid URL]'
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
  private selectedTab: Tab | null = null
  private selectedProfileId = 'default'
  private histories = new Map<string, MonitorState['history']>()
  private historyOwners = new Map<string, string>()
  private ownedFrames = new Map<string, EvidenceEntry>()
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
    const profileId = contextProfile()
    if (profileId !== undefined && profileId !== this.selectedProfileId) {
      return cloneState({ enabled: false, control: this.state.control, status: 'idle', frameSeq: 0, history: this.histories.get(profileId) ?? [] })
    }
    return cloneState(this.state)
  }

  getUiState(): MonitorState {
    return cloneState(this.state)
  }

  private select(tab: Tab): void {
    const profileId = tab.profileId ?? 'default'
    if (!/^(?:default|p[a-f0-9]{24})$/.test(profileId)) throw new Error('[INVALID_PROFILE] Invalid monitor Profile.')
    if (contextProfile() !== undefined && contextProfile() !== profileId) throw new Error('[PROFILE_ACCESS_DENIED] Monitor target belongs to another Profile.')
    this.captureGeneration++
    this.selectedTab = tab
    this.latestFrame = undefined
    this.pointer = undefined
    this.pointerTabId = undefined
    this.state.tabId = tab.id
    this.state.currentTask = undefined
    this.state.lastError = undefined
    this.state.lastFrameAt = undefined
    this.selectedProfileId = profileId
    let history = this.histories.get(profileId)
    if (!history) { history = []; this.histories.set(profileId, history) }
    this.state.history = history
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
    this.select(tab)
    this.state.enabled = true
    this.state.status = 'idle'
    this.state.lastError = undefined
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
    this.select(tab)
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
    const entry = this.getState().history.find((item) => item.capturedAt === capturedAt)
    if (!entry) return null
    const profileId = this.historyOwners.get(entry.file)
    if (!profileId) return null
    const root = monitorDir(profileId)
    const file = path.resolve(entry.file)
    if (path.dirname(file) !== root || !/^frame-\d+-\d+(?:-[a-f0-9-]{36})?\.png$/.test(path.basename(file))) return null
    try {
      assertNoLinks(file)
      const stat = fs.lstatSync(file)
      if (!stat.isFile() || stat.size > 64 * 1024 * 1024) return null
      const bytes = fs.readFileSync(file)
      if (bytes.length < 33 || bytes.toString('ascii', 12, 16) !== 'IHDR' ||
          !bytes.readUInt32BE(16) || !bytes.readUInt32BE(20) || bytes.readUInt32BE(16) * bytes.readUInt32BE(20) > 16_000_000) return null
      const image = nativeImage.createFromBuffer(bytes)
      if (image.isEmpty()) return null
      const resized = image.getSize().width > 960 ? image.resize({ width: 960 }) : image
      return {
        tabId: entry.tabId,
        profileId,
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

  private retireFrame(file: string, profileId: string): void {
    const entry = this.ownedFrames.get(file)
    const identity = entry?.identity
    const matches = (stat: fs.BigIntStats): boolean => !!entry && !!identity && stat.isFile() && stat.size === BigInt(entry.bytes) &&
      (['dev', 'ino', 'birthtimeNs', 'mtimeNs', 'ctimeNs'] as const).every((key) => identity[key] === stat[key].toString())
    try {
      assertNoLinks(file)
      if (path.dirname(file) === monitorDir(profileId) && matches(fs.lstatSync(file, { bigint: true })) &&
          getEvidenceManager(profileId).hash(file) === entry?.hash && matches(fs.lstatSync(file, { bigint: true }))) fs.unlinkSync(file)
    } catch { /* Preserve changed, missing or linked files; TTL cleanup retains its own identity checks. */ }
    getEvidenceManager(profileId).forget(file)
    this.ownedFrames.delete(file)
    this.historyOwners.delete(file)
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
      tab = this.selectedTab
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
      const profileId = tab.profileId ?? 'default'
      const dir = monitorDir(profileId)
      assertNoLinks(dir)
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      assertNoLinks(dir)
      const file = path.join(dir, `frame-${capturedAt}-${++this.state.frameSeq}-${randomUUID()}.png`)
      assertNoLinks(file)
      fs.writeFileSync(file, png, { mode: 0o600, flag: 'wx' })
      const owned = getEvidenceManager(profileId).record(file, 'screenshot', { managed: true })
      if (owned) this.ownedFrames.set(file, owned)
      this.historyOwners.set(file, profileId)
      const url = safeDisplayUrl(tab.view.webContents.getURL() || tab.url)
      const title = tab.view.webContents.getTitle() || tab.title
      const pointer = this.pointerTabId === tab.id ? this.pointer : undefined
      this.state.lastFrameAt = capturedAt
      this.state.status = 'idle'
      this.state.history.push({ file, capturedAt, tabId: tab.id, title, url, width: resized.getSize().width, height: resized.getSize().height })
      while (this.state.history.length > MAX_HISTORY) {
        const old = this.state.history.shift()
        if (!old) break
        this.retireFrame(old.file, profileId)
      }
      const frame: MonitorFrame = {
        tabId: tab.id,
        profileId,
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
        const message = error instanceof Error ? error.message : String(error)
        this.state.status = 'error'
        this.state.lastError = message
        this.state.currentTask = message
        // 预览出帧失败必须留痕：否则上层只看到「帧序号一直是 0」，
        // 无从判断是合成器没给画面、还是截图超时。
        console.warn(`[aa-browser] 预览截图失败: ${message}`)
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

