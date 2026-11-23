import { app, BaseWindow, WebContentsView, ipcMain, Menu, MenuItem, shell, clipboard, powerMonitor, nativeTheme, dialog, Notification } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TabManager } from './tabs'
import type { Tab } from './tabs'
import { SHARED_PARTITION } from './tabs'
import { getExtensionManager } from './extensions'
import { AgentServer } from './agent-server'
import { buildTools } from './tools'
import { normalizeUrl } from './tabs'
import { bridgeFileState, detectClients, setupClients, syncAppImageBridge } from './clients'
import { getDownloadTracker } from './downloads'
import { getEvidenceManager } from './evidence'
import { getHistoryStore } from './history'
import { getSettingsStore } from './settings'
import { getSessionStore } from './session-store'
import { ApprovalManager } from './approvals'
import { applyPermissionPolicy, clearIsolatedPartition, sweepStalePartitions } from './sessions'
import { session } from 'electron'
import type { PagePointerForward, UiState } from '@shared/types'
import type { BackgroundMode } from '@shared/types'
import { contextMenuLabels } from '@shared/menu-labels'
import { UpdateManager } from './updater'
import { clearUpdateRestartMarker, writeUpdateRestartMarker } from './update-restart'
import { PageFinder } from './page-finder'
import { printPage } from './printing'
import { getMainLocale } from './locale'
import { BrowserMonitor } from './monitor'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const VERSION = app.getVersion()

/** AgentServer 使用的连接发现文件；更新重启标记与它放在同一目录。 */
function discoveryFile(): string {
  return process.env['AA_BROWSER_CONNECTION_FILE'] || path.join(os.homedir(), '.aabrowser', 'connection.json')
}

const CHROME_HEIGHT = 84
let lastContentSize = { width: 1280, height: 840 }
/** 页面视图在窗口内容区里的顶部偏移；外壳转发指针事件时用它区分工具栏与页面。 */
let lastPageTop = CHROME_HEIGHT

/** 默认搜索引擎基址：优先读取用户设置 */
function searchUrlBase(): string {
  return getSettingsStore().get().searchEngine
}

// 开发版使用独立 userData：避免与安装版争单实例锁/登录态/connection.json。
// ⚠️ 必须在 requestSingleInstanceLock() 之前调用（锁按 userData 路径区分）。
const profileOverride = process.env['AA_BROWSER_USER_DATA_DIR']
// 桥冷启动只创建窗口和连接服务，不打断桌面操作；普通启动仍显示窗口。
const startInBackground = process.env['AA_BROWSER_START_IN_BACKGROUND'] === '1'
delete process.env['AA_BROWSER_START_IN_BACKGROUND']
if (profileOverride || !app.isPackaged) {
  const userData = profileOverride || path.join(app.getPath('appData'), 'aa-browser-dev')
  app.setPath('userData', userData)
  process.env['AA_BROWSER_CONNECTION_FILE'] ||= path.join(userData, 'connection.json')
}

let win: BaseWindow | null = null
let chromeView: WebContentsView | null = null
let tabManager: TabManager | null = null
let agentServer: AgentServer | null = null
let agentCount = 0
let agentVerifiedCount = 0
let bridgeState: UiState['bridgeState'] = 'starting'
let agentActivity: NonNullable<UiState['agentActivity']> = { active: false, paused: false }
let settingsOpen = false
let overlayHeight = 0
let finder: PageFinder | null = null
const approvals = new ApprovalManager()
let updater: UpdateManager | null = null
let monitor: BrowserMonitor | null = null
/** 由 whenReady 注入：立即写入跨会话标签记录（final=true 时允许清空过期记录） */
let flushSessionRecord: ((final?: boolean) => void) | null = null
/** 由 whenReady 注入：标签变化后延迟写入跨会话记录 */
let scheduleSessionSave: () => void = () => {}
const recentActions: import('@shared/types').ActionLogItem[] = []

export function logAgentAction(item: import('@shared/types').ActionLogItem): void {
  recentActions.push(item)
  if (recentActions.length > 30) recentActions.shift()
  pushState()
}

/** 新标签页地址：dev 走 vite dev server，产物走打包出的 renderer 文件 */
function newtabUrl(): string {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) return `${devUrl}/newtab.html`
  return pathToFileURL(path.join(__dirname, '../renderer/newtab.html')).toString()
}

function isDev(): boolean {
  return !!process.env['ELECTRON_RENDERER_URL']
}

/** chrome UI 的 preload 与页面路径 */
function rendererAssets(): { preload: string; index: string } {
  if (isDev()) {
    return {
      preload: path.join(__dirname, '../preload/index.js'),
      index: `${process.env['ELECTRON_RENDERER_URL']}/index.html`
    }
  }
  return {
    preload: path.join(__dirname, '../preload/index.js'),
    index: path.join(__dirname, '../renderer/index.html')
  }
}

function layout(): void {
  // 监控/视觉截图可能比窗口晚完成一拍；窗口销毁后的迟到回调不能再去读
  // 已销毁的 BaseWindow，否则会抛出未处理的 Promise 异常。
  if (!win || win.isDestroyed() || !chromeView || chromeView.webContents.isDestroyed()) return
  const currentSize = win.getContentBounds()
  if (!win.isMinimized() && currentSize.width > 0 && currentSize.height > CHROME_HEIGHT) lastContentSize = currentSize
  const { width, height } = lastContentSize
  const panelHeight = (approvals.list().length ? 180 : 0) + (finder?.getState().open ? 48 : 0) + (updater?.getState().noticeVisible ? 44 : 0)
  const showActivityOverlay = agentActivity.active || agentActivity.paused
  const chromeHeight = settingsOpen || showActivityOverlay
    ? height
    : Math.min(height, Math.max(CHROME_HEIGHT + panelHeight, overlayHeight))
  chromeView.setBounds({ x: 0, y: 0, width, height: chromeHeight })
  const pageTop = CHROME_HEIGHT + panelHeight
  lastPageTop = pageTop
  if (width <= 0 || height <= pageTop) return // 某些桌面在最小化时不给出可用的内容区。
  const bounds = { x: 0, y: pageTop, width, height: height - pageTop }
  // 未挂到窗口的标签也有可用视口，MCP 可以定向操作而不切换用户正在看的标签。
  for (const tab of tabManager?.tabs ?? []) {
    const previous = tab.view.getBounds()
    if (previous.y !== bounds.y || previous.width !== bounds.width || previous.height !== bounds.height) tab.view.setBounds(bounds)
  }
}

function detachTabView(tabView: WebContentsView): void {
  win?.contentView.removeChildView(tabView)
}

/**
 * 最小化时 Chromium 会把渲染器视口压成 0×0，页面快照为空、整页截图挂起。
 * 此时用 CDP 设备度量覆盖维持一个记忆尺寸的虚拟视口；恢复前台后清除。
 * 按 WebContents 记录已覆盖的标签，确保最小化期间新建的标签也能补上。
 * 与 viewport 工具共用同一覆盖通道：工具收尾后的 pushState 会重新触发本函数，
 * 恢复后台覆盖，因此短暂互相覆盖是安全的。
 */
const backgroundViewportTabs = new Set<Electron.WebContents>()
let backgroundMetricsRunning = false
let backgroundMetricsRerun = false

async function syncBackgroundViewports(): Promise<void> {
  if (!tabManager || !win || win.isDestroyed()) return
  const minimized = win.isMinimized()
  const width = lastContentSize.width
  const height = Math.max(300, lastContentSize.height - CHROME_HEIGHT)
  if (!minimized) {
    for (const wc of [...backgroundViewportTabs]) {
      backgroundViewportTabs.delete(wc)
      if (wc.isDestroyed() || !wc.debugger.isAttached()) continue
      try { await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride') } catch { /* 已销毁 */ }
    }
    return
  }
  if (width <= 0 || height <= 0) return
  for (const tab of [...tabManager.tabs]) {
    const wc = tab.view.webContents
    if (wc.isDestroyed() || backgroundViewportTabs.has(wc) || !wc.debugger.isAttached()) continue
    try {
      // 若监控或视觉工具刚扩容过视口，先清掉再设回记忆尺寸，避免叠加出错误布局。
      await wc.debugger.sendCommand('Emulation.clearDeviceMetricsOverride')
      await wc.debugger.sendCommand('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height
      })
      backgroundViewportTabs.add(wc)
    } catch { /* 已销毁或通道占用 */ }
  }
}

/** 合并并发调用：布局或状态推送很频繁，但只需按最后一次窗口状态收敛。 */
function updateBackgroundViewports(): void {
  if (backgroundMetricsRunning) {
    backgroundMetricsRerun = true
    return
  }
  backgroundMetricsRunning = true
  void (async () => {
    try {
      do {
        backgroundMetricsRerun = false
        await syncBackgroundViewports()
      } while (backgroundMetricsRerun)
    } finally {
      backgroundMetricsRunning = false
    }
  })()
}

function pushState(): void {
  if (!chromeView || chromeView.webContents.isDestroyed()) return
  // 窗口关闭期间 win 对象仍然存在但已销毁；此时读取 bounds 会抛
  // "Object has been destroyed"，把整个关窗流程带崩。布局与窗口尺寸都需要活窗口。
  const liveWindow = win && !win.isDestroyed() ? win : null
  layout()
  updateBackgroundViewports()
  const state: UiState = {
    tabs: tabManager?.infosForUi() ?? [],
    activeId: tabManager?.activeId ?? null,
    agentCount,
    agentVerifiedCount,
    bridgeState,
    pendingApprovals: approvals.list(),
    agentInterrupted: approvals.isInterrupted(),
    agentActivity,
    recentActions: [...recentActions],
    downloads: getDownloadTracker().list(20),
    update: updater?.getState(),
    find: finder?.getState(),
    canReopenClosed: tabManager?.canReopenClosed ?? false,
    // windowHeight 反映真实窗口（最小化时为 0）；后台布局使用记忆中的最后有效尺寸。
    windowHeight: liveWindow ? liveWindow.getContentBounds().height : 0,
    backgroundMode: currentWindowMode(),
    monitor: monitor?.getState()
  }
  chromeView.webContents.send('aa:state', state)
}

function handleBeforeInput(wc: Electron.WebContents): void {
  wc.on('before-input-event', (event, input) => {
    const ctrl = input.control || input.meta
    if (input.type !== 'keyDown') return
    const key = input.key.toLowerCase()
    // 后台/最小化时忽略按键，避免 AI 注入的按键触发浏览器快捷键。
    // 例外：独立 DevTools 窗口获得焦点时主窗口不算前台，但当前页仍需能用 F12 收起调试器。
    if (!win?.isFocused() || win.isMinimized()) {
      const togglesDevTools = (ctrl && input.shift && key === 'i') || key === 'f12'
      if (!togglesDevTools || !wc.isDevToolsOpened()) return
    }
    // 模态设置不允许浏览器快捷键改变背后的网页或夺走表单焦点。
    if (settingsOpen && ((ctrl && ['t', 'w', 'l', 'f', 'r', 'p'].includes(key)) || (ctrl && input.shift && key === 'i') || key === 'f5' || key === 'f12' || (input.alt && ['arrowleft', 'arrowright'].includes(key)))) {
      event.preventDefault()
      return
    }
    if (ctrl && input.shift && input.key.toLowerCase() === 't') {
      event.preventDefault()
      tabManager?.reopenClosed()
      return
    }
    if (ctrl && input.key.toLowerCase() === 'f') {
      event.preventDefault()
      finder?.open()
      chromeView?.webContents.focus()
      chromeView?.webContents.send('aa:focus-find')
      return
    }
    if (ctrl && !input.alt && !input.shift && key === 'p') {
      event.preventDefault()
      const active = tabManager?.active()
      if (active) printPage(active.view.webContents, win)
      return
    }
    if (input.key === 'Escape' && wc !== chromeView?.webContents && finder?.getState().open) {
      event.preventDefault()
      finder.close()
      return
    }
    if (ctrl && input.key.toLowerCase() === 't') {
      event.preventDefault()
      tabManager?.createTab()
      return
    }
    if (ctrl && input.key.toLowerCase() === 'w') {
      event.preventDefault()
      const active = tabManager?.active()
      if (active) tabManager?.closeTab(active.id)
      return
    }
    if (ctrl && input.key.toLowerCase() === 'l') {
      event.preventDefault()
      chromeView?.webContents.focus()
      chromeView?.webContents.send('aa:focus-omnibox')
      return
    }
    if ((ctrl && input.key.toLowerCase() === 'r') || input.key === 'F5') {
      event.preventDefault()
      const active = tabManager?.active()
      active?.view.webContents.reload()
      return
    }
    if (input.alt && input.key === 'ArrowLeft') {
      event.preventDefault()
      const active = tabManager?.active()
      if (active) tabManager?.goBack(active)
      return
    }
    if (input.alt && input.key === 'ArrowRight') {
      event.preventDefault()
      const active = tabManager?.active()
      if (active) tabManager?.goForward(active)
      return
    }
    if ((ctrl && input.shift && key === 'i') || key === 'f12') {
      event.preventDefault()
      togglePageDevTools(wc)
      return
    }
  })
}

/** F12 / Ctrl+Shift+I：切换 DevTools。外壳上按下时针对当前活动网页，与主流浏览器一致。 */
function togglePageDevTools(origin: Electron.WebContents): void {
  if (settingsOpen) return
  // DevTools 与抓包共用调试通道：打开前先释放抓包
  const target = origin === chromeView?.webContents
    ? tabManager?.active()?.view.webContents
    : origin
  if (!target || target.isDestroyed()) return
  const t = tabManager?.tabs.find((x) => x.view.webContents === target)
  t?.net.releaseDebugger()
  if (target.isDevToolsOpened()) {
    target.closeDevTools()
    return
  }
  target.openDevTools({ mode: 'detach' })
}

/** 为单个页面 WebContents 注册右键菜单（普通网页浏览器基本操作） */
function installPageContextMenu(wc: Electron.WebContents): void {
  wc.on('context-menu', (_e, params) => {
    // 原生菜单只属于用户正在看的活动页；最小化/隐藏的后台页与其他标签交给网页自身处理。
    // 不要求 isFocused：可见窗口的点击会先获得焦点，而焦点可能因 DevTools 等独立窗口暂时不在主窗口上。
    const activeView = tabManager?.active()?.view.webContents
    if (!win?.isVisible() || win.isMinimized() || activeView !== wc) return
    const menu = new Menu()
    const L = contextMenuLabels(getMainLocale() === 'en-US' ? 'en' : 'zh')
    const hasLink = /^https?:|^file:/i.test(params.linkURL)
    const linkAllowed = !!tabManager?.isUrlAllowed(params.linkURL)
    const hasSelection = !!params.selectionText
    const editable = !!params.isEditable
    const hasImage = params.mediaType === 'image' && /^https?:|^data:|^file:/i.test(params.srcURL)
    const imageAllowed = hasImage && /^https?:/i.test(params.srcURL) && !!tabManager?.isUrlAllowed(params.srcURL)

    const push = (opts: MenuItemConstructorOptions): void => { menu.append(new MenuItem(opts)) }

    if (editable) {
      push({ label: L.undo, role: 'undo' })
      push({ label: L.redo, role: 'redo' })
      push({ type: 'separator' })
      push({ label: L.cut, role: 'cut' })
      push({ label: L.copy, role: 'copy' })
      push({ label: L.paste, role: 'paste' })
      push({ label: L.selectAll, role: 'selectAll' })
    } else if (hasSelection) {
      push({ label: L.copy, role: 'copy' })
    }

    if (menu.items.length) push({ type: 'separator' })

    if (hasLink) {
      push({ label: L.openLink, enabled: linkAllowed, click: () => { if (linkAllowed) void wc.loadURL(params.linkURL) } })
      push({ label: L.openLinkNewTab, enabled: linkAllowed, click: () => {
        const source = tabManager?.tabs.find((t) => t.view.webContents === wc)
        if (linkAllowed) tabManager?.createTab(params.linkURL, true, source?.isolated)
      } })
      push({ label: L.copyLink, click: () => { clipboard.writeText(params.linkURL) } })
      push({ type: 'separator' })
    }
    if (hasImage) {
      push({ label: L.copyImage, click: () => { clipboard.writeText(params.srcURL) } })
      push({ label: L.saveImage, enabled: imageAllowed, click: () => {
        if (imageAllowed) void wc.downloadURL(params.srcURL)
      } })
      push({ type: 'separator' })
    }

    const active = tabManager?.active()
    const isActiveTab = active?.view.webContents === wc
    const canBack = tabManager && active ? tabManager.canBack(active) : false
    const canForward = tabManager && active ? tabManager.canForward(active) : false
    push({ label: L.back, enabled: isActiveTab && canBack, click: () => { const t = tabManager?.active(); if (t) tabManager?.goBack(t) } })
    push({ label: L.forward, enabled: isActiveTab && canForward, click: () => { const t = tabManager?.active(); if (t) tabManager?.goForward(t) } })
    push({ label: L.reload, click: () => wc.reload() })
    push({ type: 'separator' })
    push({ label: L.viewSource, enabled: !getSettingsStore().get().allowedSites.length, click: () => {
      if (!getSettingsStore().get().allowedSites.length) void wc.loadURL(`view-source:${wc.getURL()}`)
    } })
    push({ label: L.devtools, click: () => {
      const t = tabManager?.tabs.find((x) => x.view.webContents === wc)
      t?.net.releaseDebugger() // DevTools 与 debugger/对话框守卫互斥
      wc.openDevTools({ mode: 'detach' })
    } })
    push({ label: L.print, enabled: !settingsOpen, click: () => { if (!settingsOpen) printPage(wc, win) } })
    push({ label: L.saveScreenshot, click: () => {
      void wc.capturePage().then((img) => {
        const dir = app.getPath('pictures') || os.homedir()
        const p = path.join(dir, `aabrowser-${Date.now()}.png`)
        fs.writeFileSync(p, img.toPNG())
        getEvidenceManager().record(p, 'context-shot', { managed: false })
        shell.showItemInFolder(p)
      }).catch(() => {})
    } })

    menu.popup({ window: win ?? undefined })
  })
}

/** 外壳 UI 使用的解析后主题（与渲染层 resolveUiTheme 保持一致）。 */
function resolvedTheme(): 'light' | 'dark' {
  const setting = getSettingsStore().get().theme
  return setting === 'dark' || (setting === 'system' && nativeTheme.shouldUseDarkColors) ? 'dark' : 'light'
}

/** 原生标题栏覆盖层不受页面 CSS 控制，必须单独跟随主题设置。 */
function titleBarColors(): { color: string; symbolColor: string } {
  return resolvedTheme() === 'dark'
    ? { color: '#0a0b10', symbolColor: '#e8eeec' }
    : { color: '#ebf1f4', symbolColor: '#1d2a2f' }
}

/** 内部新标签页只接收已保存的外观设置；外部网页不会被注入或读取。 */
function applyInternalAppearance(wc: Electron.WebContents): void {
  const url = wc.getURL()
  if (url !== newtabUrl()) return
  const theme = resolvedTheme()
  const locale = getSettingsStore().get().locale
  void wc.executeJavaScript(`if (location.href === ${JSON.stringify(url)}) { window.__aaApplyTheme?.(${JSON.stringify(theme)}); window.__aaApplyLocale?.(${JSON.stringify(locale)}) }`).catch(() => {})
}

function syncInternalAppearance(): void {
  tabManager?.forEachWebView(applyInternalAppearance)
}

function applyTitleBarOverlay(): void {
  if (!win || win.isDestroyed()) return
  try {
    win.setTitleBarOverlay({ ...titleBarColors(), height: 38 })
  } catch {
    /* macOS 等平台不支持覆盖层 */
  }
}

function revealWindow(): void {
  const current = win
  if (!current || current.isDestroyed()) return
  if (current.isMinimized()) current.restore()
  else if (!current.isVisible()) current.show()
  if (!current.isFocused()) current.focus()
  // 某些桌面环境不允许应用主动获取焦点；仍可从任务栏恢复。
  if (!current.isFocused()) current.flashFrame(true)
}

function currentWindowMode(): BackgroundMode {
  return getSettingsStore().get().backgroundMode
}

/** 把用户选择映射到 Electron 的真实窗口 API；不向页面注入可见性伪造。 */
function applyWindowMode(mode: BackgroundMode): BackgroundMode {
  const current = win
  if (!current || current.isDestroyed()) return mode
  const showInactive = (): void => {
    const candidate = current as BaseWindow & { showInactive?: () => void }
    if (typeof candidate.showInactive === 'function') candidate.showInactive()
    else current.show()
  }
  try {
    if (mode === 'visible') {
      current.setFocusable(true)
      if (current.isMinimized()) current.restore()
      if (!current.isVisible()) current.show()
      current.focus()
    } else if (mode === 'background' || mode === 'background-visual') {
      if (current.isMinimized()) {
        // Windows restore() activates the minimized window. Temporarily disable
        // focusability so it can be restored without taking the foreground.
        current.setFocusable(false)
        try {
          current.restore()
          current.showInactive()
        } finally {
          setImmediate(() => {
            if (!current.isDestroyed()) current.setFocusable(true)
          })
        }
        return mode
      }
      showInactive()
    } else if (mode === 'minimized') {
      if (!current.isVisible()) showInactive()
      current.minimize()
    } else if (mode === 'hidden') {
      current.hide()
    }
  } catch {
    /* 窗口正在关闭；保留设置供下次启动使用。 */
  }
  return mode
}

function setWindowMode(mode: BackgroundMode): BackgroundMode {
  const next = getSettingsStore().set({ backgroundMode: mode }).backgroundMode
  applyWindowMode(next)
  pushState()
  return next
}

function createWindow(): void {
  const window = new BaseWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: titleBarColors().color,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      ...titleBarColors(),
      height: 38
    },
    title: 'Aa Browser'
  })
  win = window
  nativeTheme.on('updated', () => {
    applyTitleBarOverlay()
    syncInternalAppearance()
  })
  applyTitleBarOverlay()

  // chrome UI 加载完成后再显示窗口，避免白闪（见下方 chromeView 创建处）
  window.on('resize', pushState)
  // Windows 最小化不一定伴随 resize；显式接住，让后台视口覆盖及时生效。
  window.on('minimize', () => { monitor?.setWindowVisible(false); pushState() })
  window.on('restore', () => { monitor?.setWindowVisible(window.isVisible()); pushState() })
  window.on('show', () => { monitor?.setWindowVisible(true); pushState() })
  window.on('hide', () => { monitor?.setWindowVisible(false); pushState() })
  window.on('focus', () => {
    window.flashFrame(false)
    void updater?.checkIfDue()
  })
  win.on('closed', () => {
    // 两种退出路径都会关闭窗口；在清理 WebContentsView 之前保留最终标签快照。
    try { flushSessionRecord?.(true) } catch { /* 会话记录是尽力而为，不阻塞退出 */ }
    scheduleSessionSave = () => {}
    monitor?.stop()
    monitor = null
    win = null
    const cv = chromeView
    chromeView = null
    tabManager?.closeAll()
    // BaseWindow 不负责销毁 WebContentsView 的 WebContents。
    if (cv && !cv.webContents.isDestroyed()) cv.webContents.close()
  })

  const assets = rendererAssets()
  chromeView = new WebContentsView({
    webPreferences: {
      preload: assets.preload,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false
    }
  })
  win.contentView.addChildView(chromeView)
  const cv = chromeView
  cv.setBackgroundColor('#00000000')
  // chrome UI 加载完成后再显示窗口，避免白闪。
  // 只在启动策略明确为 visible 时执行；hidden/minimized/background 都不能被首屏兜底
  // 重新 show()，否则用户选择的静默启动会被 setTimeout 覆盖。
  if (!startInBackground && getSettingsStore().get().backgroundMode === 'visible') {
    const showInitially = (): void => {
      clearTimeout(fallback)
      cv.webContents.removeListener('did-finish-load', showInitially)
      // 启动兜底只能执行一次；不要在用户已最小化后重新显示窗口。
      if (!window.isDestroyed() && !window.isVisible() && !window.isMinimized() && getSettingsStore().get().backgroundMode === 'visible') window.show()
    }
    const fallback = setTimeout(showInitially, 2500)
    cv.webContents.once('did-finish-load', showInitially)
    window.once('closed', () => clearTimeout(fallback))
  }
  // 外壳视图是唯一带 preload 的 WebContents：禁止它离开应用自身的 UI 文件，
  // 否则一次导航就会把特权桥暴露给任意站点（与页面视图同类的泄漏路径）。
  const chromeEntryUrl = /^[a-z]+:/i.test(assets.index) ? assets.index : pathToFileURL(assets.index).toString()
  cv.webContents.on('will-navigate', (event, target) => {
    if (target !== chromeEntryUrl) event.preventDefault()
  })
  cv.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  void cv.webContents.loadURL(chromeEntryUrl).catch((error: unknown) => {
    console.error(`[aa-browser] chrome UI 加载失败: ${error instanceof Error ? error.message : String(error)}`)
  })
  handleBeforeInput(cv.webContents)
}

function registerIpc(): void {
  /**
   * 特权 IPC 只接受外壳 chrome 视图。
   *
   * chrome 视图是唯一挂 preload 的 WebContents；页面标签永不挂 preload（见 TabManager.createTab）。
   * 这里再做一次显式校验，防止将来有人给页面视图加回 preload 时静默放宽权限。
   * 注意 approvals/downloads 等 handler 原本就逐项比对 sender，统一后语义不变。
   */
  function isTrustedSender(event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent): boolean {
    return !!chromeView && event.sender === chromeView.webContents
  }
  function guard<T>(event: Electron.IpcMainInvokeEvent, fallback: T, fn: () => T | Promise<T>): T | Promise<T> {
    if (!isTrustedSender(event)) return fallback
    return fn()
  }

  ipcMain.handle('aa:get-state', (event) => {
    return guard(event, null, () => ({
      tabs: tabManager?.infosForUi() ?? [],
      activeId: tabManager?.activeId ?? null,
      agentCount,
      agentVerifiedCount,
      bridgeState,
      pendingApprovals: approvals.list(),
      agentInterrupted: approvals.isInterrupted(),
    agentActivity,
      downloads: getDownloadTracker().list(20),
      recentActions: [...recentActions],
      update: updater?.getState(),
      find: finder?.getState(),
      canReopenClosed: tabManager?.canReopenClosed ?? false,
      windowHeight: win?.getContentBounds().height,
      backgroundMode: currentWindowMode(),
      monitor: monitor?.getState()
    } satisfies UiState))
  })
  ipcMain.handle('aa:tab-new', (event, url?: string) => {
    return guard(event, false, () => {
      const target = url ? normalizeUrl(url, searchUrlBase(), newtabUrl()) : newtabUrl()
      try {
        tabManager?.createTab(target)
      } catch {
        return false
      }
      return true
    })
  })
  ipcMain.handle('aa:tab-reopen', (event) => guard(event, false, () => !!tabManager?.reopenClosed()))
  ipcMain.handle('aa:find-open', (event) => guard(event, undefined, () => finder?.open()))
  ipcMain.handle('aa:find', (event, query: unknown, forward: unknown, next: unknown) => {
    return guard(event, undefined, () => {
      if (typeof query === 'string') finder?.search(query, forward !== false, next === true)
    })
  })
  ipcMain.handle('aa:find-close', (event) => guard(event, undefined, () => finder?.close(false)))
  ipcMain.handle('aa:overlay-height', (event, value: unknown) => {
    return guard(event, undefined, () => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return
      overlayHeight = Math.max(0, Math.ceil(value))
      layout()
    })
  })
  /**
   * 活动 HUD 把外壳视图展开到整窗后，透明区域仍会截获鼠标事件，网页看起来“点不动”。
   * 渲染层只转发落在页面区域的指针事件；主进程再校验来源、窗口状态与坐标范围，
   * 换算成页面视图本地坐标后投递给活动页。
   */
  ipcMain.on('aa:page-pointer', (event, payload: unknown) => {
    if (!isTrustedSender(event) || !win || win.isDestroyed() || !tabManager) return
    if (win.isMinimized() || !win.isVisible() || settingsOpen) return
    if (!agentActivity.active && !agentActivity.paused) return
    const input = payload as Partial<PagePointerForward> | null
    if (!input || typeof input !== 'object') return
    const type = input.type
    if (type !== 'mouseDown' && type !== 'mouseUp' && type !== 'mouseMove' && type !== 'mouseWheel') return
    const x = Number(input.x)
    const y = Number(input.y)
    if (!Number.isFinite(x) || !Number.isFinite(y)) return
    const bounds = win.getContentBounds()
    if (bounds.width <= 0 || bounds.height <= 0) return
    if (x < 0 || y < 0 || x >= bounds.width || y >= bounds.height) return
    if (y < lastPageTop) return
    const active = tabManager.active()
    const wc = active?.view.webContents
    if (!active || !wc || wc.isDestroyed()) return
    const point = { x: Math.round(x), y: Math.round(y - lastPageTop) }
    if (type === 'mouseMove') {
      wc.sendInputEvent({ type, ...point })
      return
    }
    if (type === 'mouseWheel') {
      const deltaX = Number(input.deltaX) || 0
      const deltaY = Number(input.deltaY) || 0
      // DOM 的 delta 正方向是“内容向上/向右”，Chromium wheel delta 的正方向相反。
      wc.sendInputEvent({
        type,
        ...point,
        deltaX: Math.round(-deltaX),
        deltaY: Math.round(-deltaY),
        wheelTicksX: Math.round(-deltaX / 120),
        wheelTicksY: Math.round(-deltaY / 120),
        hasPreciseScrollingDeltas: true,
        canScroll: true
      })
      return
    }
    // 用户主动点击页面：把焦点还给网页，键盘与后续输入才会落到页面上。
    wc.focus()
    wc.sendInputEvent({
      type,
      ...point,
      button: input.button === 'right' ? 'right' : input.button === 'middle' ? 'middle' : 'left',
      clickCount: Math.max(1, Math.min(3, Math.trunc(Number(input.clickCount) || 1)))
    })
  })
  ipcMain.handle('aa:tab-close', (event, id: string) => {
    return guard(event, undefined, () => {
      const tab = tabManager?.get(id)
      if (tab) detachTabView(tab.view)
      tabManager?.closeTab(id)
    })
  })
  ipcMain.handle('aa:tab-select', (event, id: string, focusPage: unknown = true) => {
    return guard(event, undefined, () => {
      const next = tabManager?.get(id)
      if (!tabManager || !next) return
      // onTabChange owns view attachment for both UI and MCP tab selection.
      tabManager.selectTab(id)
      if (focusPage !== false) next.view.webContents.focus()
      else chromeView?.webContents.focus()
    })
  })
  ipcMain.handle('aa:back', (event) => {
    return guard(event, undefined, () => {
      const active = tabManager?.active()
      if (active) tabManager?.goBack(active)
    })
  })
  ipcMain.handle('aa:forward', (event) => {
    return guard(event, undefined, () => {
      const active = tabManager?.active()
      if (active) tabManager?.goForward(active)
    })
  })
  ipcMain.handle('aa:reload', (event) => {
    return guard(event, undefined, () => {
      const active = tabManager?.active()
      active?.view.webContents.reload()
    })
  })
  ipcMain.handle('aa:omnibox-submit', (event, value: string) => {
    return guard(event, false, () => {
      if (!tabManager) return false
      const target = normalizeUrl(value, searchUrlBase(), newtabUrl())
      // Electron 不带 Chrome 桌面版的 chrome://extensions 页面；映射到 Aa Browser 设置中的扩展区。
      if (/^chrome:\/\/extensions\/?$/i.test(target)) {
        settingsOpen = true
        layout()
        chromeView?.webContents.send('aa:open-extensions')
        return true
      }
      try {
        tabManager.assertUrlAllowed(target)
      } catch {
        return false
      }
      const active = tabManager.active()
      if (!active) {
        // 最后一个标签已关闭时地址栏仍应可用：直接开一个新标签。
        tabManager.createTab(target, true, false)
        return true
      }
      void tabManager.navigate(active, target).catch(() => {
        // 页面加载失败由 WebContents 呈现，地址栏 IPC 只确认是否接受输入。
      })
      return true
    })
  })
  ipcMain.handle('aa:devtools', (event) => {
    return guard(event, undefined, () => {
      togglePageDevTools(chromeView?.webContents ?? event.sender)
    })
  })
  ipcMain.handle('aa:window-mode', (event, mode?: unknown) => {
    return guard(event, currentWindowMode(), () => {
      if (mode === undefined) return currentWindowMode()
      if (mode !== 'visible' && mode !== 'background' && mode !== 'minimized' && mode !== 'hidden' && mode !== 'background-visual') return currentWindowMode()
      return setWindowMode(mode)
    })
  })
  ipcMain.handle('aa:monitor-start', (event, tabId?: unknown) => {
    return guard(event, null, () => monitor?.start(typeof tabId === 'string' ? tabId : undefined) ?? null)
  })
  ipcMain.handle('aa:monitor-stop', (event) => guard(event, null, () => monitor?.stop() ?? null))
  ipcMain.handle('aa:monitor-history-frame', (event, capturedAt: unknown) => {
    return guard(event, null, () => monitor?.historyFrame(Number(capturedAt)) ?? null)
  })
  ipcMain.handle('aa:monitor-view', (event, visible: unknown) => {
    if (!isTrustedSender(event) || typeof visible !== 'boolean' || !monitor) return false
    monitor.setPreviewRequested(visible)
    return true
  })
  ipcMain.handle('aa:monitor-takeover', (event) => {
    if (!isTrustedSender(event) || !monitor) return null
    const next = monitor.takeover()
    setImmediate(() => {
      approvals.interrupt()
      agentServer?.pause()
    })
    return next
  })
  ipcMain.handle('aa:monitor-release', (event) => {
    if (!isTrustedSender(event) || !monitor) return null
    approvals.resume()
    agentServer?.resume()
    return monitor.releaseToAi()
  })
  ipcMain.handle('aa:approval-decide', (event, id: string, allowed: boolean) => {
    if (!isTrustedSender(event)) return false
    return approvals.decide(String(id), allowed === true)
  })
  ipcMain.handle('aa:agent-interrupt', (event) => {
    if (!isTrustedSender(event)) return false
    approvals.interrupt()
    agentServer?.pause(approvals.getResumeAt())
    return true
  })
  ipcMain.handle('aa:agent-resume', (event) => {
    if (!isTrustedSender(event)) return false
    approvals.resume()
    agentServer?.resume()
    return true
  })
  /** HUD 上“停止此调用”：只取消指定调用，不影响其他客户端/其他并发调用。 */
  ipcMain.handle('aa:agent-cancel-call', (event, callId: number, client?: number) => {
    if (!isTrustedSender(event)) return false
    return agentServer?.cancelCall(callId, client) ?? false
  })
  ipcMain.handle('aa:tasks-control', (event, action: unknown, callId?: unknown, client?: unknown) => {
    return guard(event, false, () => {
      if (action === 'cancel') return agentServer?.cancelCall(Number(callId), client === undefined ? undefined : Number(client)) ?? false
      if (action === 'pause') {
        approvals.pauseIndefinitely()
        agentServer?.pause()
        return true
      }
      if (action === 'resume') {
        approvals.resume()
        agentServer?.resume()
        return true
      }
      return false
    })
  })
  approvals.onChange = () => {
    if (approvals.isInterrupted()) {
      agentActivity = { active: false, paused: true, resumeAt: approvals.getResumeAt() }
    } else if (!agentActivity.active) {
      agentActivity = { active: false, paused: false }
      agentServer?.resume()
    }
    pushState()
    if (!approvals.list().length) win?.flashFrame(false)
  }
  approvals.onRequest = () => {
    revealWindow()
    // 敏感输入审批发生在当前活动页面上；恢复窗口后把焦点还给网页，
    // 否则焦点停在外壳 UI，用户点“允许”后无法继续在页面上输入。
    const pending = approvals.list()
    const latest = pending[pending.length - 1]
    if (latest && (latest.kind === undefined || latest.kind === 'sensitive')) {
      const wc = tabManager?.active()?.view.webContents
      if (wc && !wc.isDestroyed()) wc.focus()
    }
  }
  ipcMain.handle('aa:clients-detect', (event) => {
    return guard(event, [], () => detectClients())
  })
  ipcMain.handle('aa:clients-setup', (event, ids: string[], locale?: string) => {
    return guard(event, [], () => setupClients(Array.isArray(ids) ? ids : [], locale === 'en-US' || locale === 'zh-CN' ? locale : undefined))
  })
  ipcMain.handle('aa:downloads-list', (event) => {
    return guard(event, [], () => getDownloadTracker().list(20))
  })
  ipcMain.handle('aa:download-open', (event, id: string) => {
    return guard(event, { ok: false }, () => getDownloadTracker().open(String(id)))
  })
  ipcMain.handle('aa:download-show', (event, id: string) => {
    return guard(event, undefined, () => getDownloadTracker().showInFolder(String(id)))
  })
  ipcMain.handle('aa:download-dir', (event) => {
    return guard(event, '', () => getDownloadTracker().dir)
  })
  ipcMain.handle('aa:download-cancel', (event, id: string) => {
    return guard(event, false, () => getDownloadTracker().cancel(String(id)))
  })
  ipcMain.handle('aa:download-retry', (event, id: string) => {
    return guard(event, { ok: false }, () => getDownloadTracker().retry(String(id)))
  })
  ipcMain.handle('aa:history-suggest', (event, query: string, limit?: number) => {
    return guard(event, [], () => getHistoryStore().suggest(String(query ?? ''), Number(limit) || 8))
  })
  ipcMain.handle('aa:settings-get', (event) => {
    return guard(event, null, () => {
      const s = getSettingsStore()
      return { settings: s.get(), presets: s.presets() }
    })
  })
  ipcMain.handle('aa:settings-set', (event, patch: unknown) => {
    return guard(event, null, () => {
      let result: ReturnType<ReturnType<typeof getSettingsStore>['set']>
      try {
        result = getSettingsStore().set((patch ?? {}) as Record<string, unknown>)
      } catch {
        return null
      }
      updater?.refreshSettings()
      if ((patch as Record<string, unknown> | null)?.['backgroundMode'] === 'visible' || (patch as Record<string, unknown> | null)?.['backgroundMode'] === 'background' || (patch as Record<string, unknown> | null)?.['backgroundMode'] === 'minimized' || (patch as Record<string, unknown> | null)?.['backgroundMode'] === 'hidden' || (patch as Record<string, unknown> | null)?.['backgroundMode'] === 'background-visual') {
        applyWindowMode(result.backgroundMode)
        if (result.backgroundMode === 'background-visual' && !monitor?.getState().enabled) monitor?.start(tabManager?.active()?.id)
      }
      // 关闭恢复时立刻删除旧记录；重新开启时立即记录当前标签，避免下次启动恢复过期页面。
      if (!result.restoreSession) getSessionStore().clear()
      else if ((patch as Record<string, unknown> | null)?.['restoreSession'] === true) flushSessionRecord?.()
      if ((patch as Record<string, unknown> | null)?.['theme'] !== undefined) applyTitleBarOverlay()
      if ((patch as Record<string, unknown> | null)?.['theme'] !== undefined || (patch as Record<string, unknown> | null)?.['locale'] !== undefined) {
        syncInternalAppearance()
      }
      pushState()
      return result
    })
  })
  ipcMain.handle('aa:settings-open', (event, open: boolean) => {
    return guard(event, undefined, () => {
      settingsOpen = open === true
      layout()
    })
  })
  /** 原生目录选择对话框：选择「已解压扩展」目录。取消返回空串。 */
  ipcMain.handle('aa:extension-pick', async (event) => {
    if (!isTrustedSender(event)) return ''
    const result = await dialog.showOpenDialog({
      title: getMainLocale() === 'en-US' ? 'Load unpacked extension' : '加载已解压的扩展程序',
      properties: ['openDirectory'],
      buttonLabel: getMainLocale() === 'en-US' ? 'Load' : '加载'
    })
    if (result.canceled || !result.filePaths.length) return ''
    return result.filePaths[0]
  })
  ipcMain.handle('aa:extension-list', (event) => {
    return guard(event, [], () => getExtensionManager().list())
  })
  ipcMain.handle('aa:extension-load', async (event, dir: string) => {
    if (!isTrustedSender(event)) return { ok: false, error: 'untrusted' } as { ok: boolean; error?: string }
    try {
      const entry = await getExtensionManager().load(session.fromPartition(SHARED_PARTITION), String(dir ?? ''))
      pushState()
      return { ok: true, extension: entry }
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) }
    }
  })
  ipcMain.handle('aa:extension-remove', (event, key: string) => {
    return guard(event, { ok: false, error: 'untrusted' }, () => {
      try {
        const removed = getExtensionManager().remove(session.fromPartition(SHARED_PARTITION), String(key ?? ''))
        pushState()
        return { ok: true, extension: removed }
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) }
      }
    })
  })
  ipcMain.handle('aa:agent-info', (event) => {
    return guard(event, null, () => {
      const info = agentServer?.info()
      return {
        port: info?.port ?? 0,
        version: VERSION,
        discoveryFile: info?.discoveryFile ?? '',
        clientCount: agentCount,
        verifiedClientCount: agentVerifiedCount,
        bridgeFile: bridgeFileState()
      }
    })
  })
  ipcMain.handle('aa:connection-diagnostics-copy', (event) => {
    return guard(event, false, () => {
      if (!settingsOpen) return false
      // Explicit allowlist: never stringify AgentServer.info(), paths, or config.
      try {
        clipboard.writeText([
          `Aa Browser ${VERSION} (${process.platform}-${process.arch})`,
          `Local service: ${bridgeState}`,
          `Bridge file: ${bridgeFileState()}`,
          `Authenticated clients: ${agentCount}`,
          `Verified clients: ${agentVerifiedCount}`
        ].join('\n'))
        return true
      } catch {
        return false
      }
    })
  })
  ipcMain.handle('aa:update-check', async (event) => {
    if (!isTrustedSender(event)) return updater?.getState() ?? null
    return updater?.check() ?? null
  })
  ipcMain.handle('aa:update-download', async (event) => {
    if (!isTrustedSender(event)) return updater?.getState() ?? null
    return updater?.download() ?? null
  })
  ipcMain.handle('aa:update-install', async (event) => {
    if (!isTrustedSender(event) || !updater) return false
    const activity = agentServer?.activity()
    const busyTool = activity?.calls?.find((call) => call.tool)?.tool ?? activity?.tool
    const busy = activity?.active === true || approvals.list().length > 0
    if (busy) {
      const en = getMainLocale() === 'en-US'
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        buttons: en ? ['Cancel', 'Restart and install anyway'] : ['取消', '仍然重启安装'],
        defaultId: 0,
        cancelId: 0,
        noLink: true,
        message: en
          ? 'AI is using the browser right now'
          : 'AI 正在操作浏览器',
        detail: en
          ? `Restarting to install the update will interrupt the current step${busyTool ? ` (${busyTool})` : ''}. The AI may need to read the page again before continuing.`
          : `重启安装会中断当前步骤${busyTool ? `（${busyTool}）` : ''}。更新后 AI 可能需要重新读取页面才能继续。`
      })
      if (response !== 1) return false
    }
    return updater.install()
  })
  ipcMain.handle('aa:update-dismiss', (event) => guard(event, undefined, () => updater?.dismissNotice()))
  ipcMain.handle('aa:update-retry', (event) => guard(event, null, () => updater?.retry() ?? null))
  ipcMain.handle('aa:update-wake', (event) => guard(event, null, () => updater?.checkIfDue() ?? null))
  getDownloadTracker().onChange = pushState
}

function onTabChange(): void {
  if (!win || !tabManager) return
  tabManager.runAsUi(() => {
    finder?.syncActive()
    // 先摘除旧页面，再把新页面放到外壳下面；每次切换只挂载一次。
    const active = tabManager?.activeForUi()?.view
    const parent = win?.contentView
    if (!parent) return
    for (const tab of tabManager?.tabs ?? []) {
      if (tab.view !== active && parent.children.includes(tab.view)) parent.removeChildView(tab.view)
    }
    if (active && !parent.children.includes(active)) parent.addChildView(active, 0)
    pushState()
    scheduleSessionSave()
  })
}

app.whenReady().then(async () => {
  if (process.platform === 'linux' && app.isPackaged && app.commandLine.hasSwitch('no-sandbox')) {
    console.error('Aa Browser requires the Chromium sandbox. Enable user namespaces for the application and relaunch.')
    app.exit(1)
    return
  }
  app.setAppUserModelId('com.aa.browser')
  Menu.setApplicationMenu(null)
  try { syncAppImageBridge(true) }
  catch (error) { console.error('Failed to refresh the installed MCP bridge:', error) }

  const appImage = process.platform === 'linux' && process.env['APPIMAGE']
  updater = new UpdateManager(VERSION, () => {
    const settings = getSettingsStore().get()
    return { autoUpdate: settings.autoUpdate, updateChannel: settings.updateChannel }
  }, app.isPackaged && (process.platform === 'win32' || !!appImage), appImage ? {
    source: appImage,
    directory: path.join(app.getPath('userData'), 'previous-versions')
  } : undefined)
  updater.init(pushState)
  powerMonitor.on('resume', () => { void updater?.checkIfDue() })

  registerIpc()

  // 清理上次异常退出遗留的隔离分区与 v0.6.x 的每标签分区目录。
  // 必须在创建任何会话之前做，避免和 Chromium 抢占同一批文件。
  try {
    const swept = sweepStalePartitions()
    if (swept.removed.length) {
      console.log(`[aa-browser] 已清理 ${swept.removed.length} 个过期会话分区目录`)
    }
  } catch {
    /* 清理失败不应阻塞启动 */
  }
  try {
    const evidence = getEvidenceManager().sweep()
    if (evidence.removed.length) {
      console.log(`[aa-browser] 已清理 ${evidence.removed.length} 个过期证据文件（${Math.round(evidence.bytesFreed / 1024)}KB）`)
    }
  } catch {
    /* 证据清理失败不应阻塞启动 */
  }

  tabManager = new TabManager(newtabUrl(), searchUrlBase())
  finder = new PageFinder(tabManager, pushState)
  tabManager.onChange = onTabChange
  tabManager.isWindowForeground = () => !!win && win.isVisible() && !win.isMinimized() && win.isFocused()
  tabManager.isWindowMinimized = () => !!win && win.isMinimized()
  tabManager.isViewAttached = (view) => !!win && !win.isDestroyed() && win.contentView.children.includes(view)
  tabManager.shouldShowAgentTab = () => getSettingsStore().get().backgroundMode === 'visible'
  tabManager.onContextMenu = (wc) => {
    handleBeforeInput(wc)
    installPageContextMenu(wc)
  }
  tabManager.onNavigate = (url, title) => getHistoryStore().add(url, title)
  tabManager.getAllowedSites = () => getSettingsStore().get().allowedSites
  tabManager.getDefaultIsolated = () => getSettingsStore().get().isolatedSessions
  tabManager.applyInternalTheme = applyInternalAppearance
  tabManager.onSession = (ses) => {
    applyPermissionPolicy(ses, { requestApproval: (meta) => approvals.request(meta) })
    getDownloadTracker().attach(ses)
  }
  tabManager.onIsolatedClosed = (partition) => void clearIsolatedPartition(partition)
  tabManager.onViewDetach = (view) => detachTabView(view)
  monitor = new BrowserMonitor({
    getTab: (tabId) => tabId ? tabManager?.get(tabId) ?? null : tabManager?.active() ?? null,
    emitState: () => pushState(),
    emitFrame: (frame) => chromeView?.webContents.send('aa:monitor-frame', frame)
  })
  monitor.setWindowVisible(!!win && win.isVisible() && !win.isMinimized())
  tabManager.onAgentPointer = (tab, pointer) => monitor?.recordPointer(tab.id, pointer)
  getDownloadTracker().setDirectoryProvider(() => getSettingsStore().get().downloadDir)
  // 重试是新的网络请求，必须重新过站点白名单，不能沿用创建下载时的授权
  getDownloadTracker().setUrlGuard((url) => tabManager?.isUrlAllowed(url) ?? false)

  // 上次会话装载的已解压扩展：必须在第一个标签创建前恢复，
  // 否则扩展的 content scripts 会错过首屏页面。
  try {
    const restoredExtensions = await getExtensionManager().restore(session.fromPartition(SHARED_PARTITION))
    if (restoredExtensions.restored) {
      console.log(`[aa-browser] 已恢复 ${restoredExtensions.restored} 个已解压扩展`)
      if (restoredExtensions.skipped.length) {
        console.warn(`[aa-browser] ${restoredExtensions.skipped.length} 个扩展路径已失效，从恢复列表移除`)
      }
    }
  } catch (error) {
    console.warn(`[aa-browser] 扩展恢复失败: ${error instanceof Error ? error.message : String(error)}`)
  }

  // 跨会话标签恢复：先把上次的普通标签建回来，再开启自动保存。
  // 恢复过程中的 onChange 也会排队保存，但 during-restore 标志保证不会用半恢复状态覆盖记录。
  const sessionStore = getSessionStore()
  let sessionSaveTimer: ReturnType<typeof setTimeout> | null = null
  let restoringSession = false
  function flushSession(final = false): void {
    if (sessionSaveTimer) {
      clearTimeout(sessionSaveTimer)
      sessionSaveTimer = null
    }
    if (restoringSession || !getSettingsStore().get().restoreSession || !tabManager) return
    const snapshot = tabManager.sessionTabs()
    // 启动/导航的中间态会短暂出现 about:blank：此时不要清掉刚读入的旧记录，
    // 只在退出时允许把「确实没有任何可恢复标签」的空记录落盘。
    if (!snapshot.tabs.length && !final) return
    sessionStore.save(snapshot.tabs, snapshot.activeIndex)
  }
  flushSessionRecord = (final?: boolean) => flushSession(final === true)
  scheduleSessionSave = (): void => {
    if (!getSettingsStore().get().restoreSession) return
    if (sessionSaveTimer) clearTimeout(sessionSaveTimer)
    sessionSaveTimer = setTimeout(() => {
      sessionSaveTimer = null
      flushSession()
    }, 600)
  }

  createWindow()

  // 首个标签页：优先恢复上次会话；没有可恢复记录时打开新标签页。
  const restored = getSettingsStore().get().restoreSession ? sessionStore.load() : null
  /** 恢复标签的首载 promise：MCP 服务要等它们结束，避免更新后的重放落在 about:blank。 */
  const restoredInitialLoads: Promise<void>[] = []
  if (restored) {
    restoringSession = true
    const created: Tab[] = []
    for (const entry of restored.tabs) {
      try {
        const tab = tabManager.createTab(entry.url, false, false, false, entry.id)
        created.push(tab)
        restoredInitialLoads.push(tab.initialNavigation.catch(() => {}))
      } catch {
        /* 白名单收紧后旧地址会被拒绝：跳过并继续恢复其余标签 */
      }
    }
    restoringSession = false
    if (created.length) {
      const active = created[Math.min(restored.activeIndex, created.length - 1)]
      tabManager.selectTab(active.id)
    }
  }
  if (!tabManager.tabs.length) tabManager.createTab()

  // 下载追踪：静默捕获所有标签页隔离 session 的下载
  getDownloadTracker().attach(session.defaultSession)

  // 恢复标签仍在首次加载时，过早写入 connection.json 会让更新后的重放调用
  // （快照、提取等）落到 about:blank。各自有 20s 导航上限且并行执行；
  // 失败也继续，MCP 可用性不能因为某个站点不可达而永久挂起。
  if (restoredInitialLoads.length) await Promise.all(restoredInitialLoads)

  // Agent 接入服务
  const tools = buildTools(
    tabManager,
    newtabUrl(),
    searchUrlBase(),
    {
      resize: (w, h) =>
        new Promise((resolve, reject) => {
          if (!win) {
            reject(new Error('窗口未就绪'))
            return
          }
          win.setContentSize(w, h)
          const { width, height } = win.getContentBounds()
          resolve({ width, height })
        }),
      focus: () => revealWindow(),
      state: () => {
        const current = win
        if (!current || current.isDestroyed()) return { focused: false, visible: false, minimized: false }
        return { focused: current.isFocused(), visible: current.isVisible(), minimized: current.isMinimized() }
      },
      mode: () => currentWindowMode(),
      setMode: (mode) => setWindowMode(mode),
      monitorStart: (tabId) => {
        if (!monitor) throw new Error('实时预览服务未就绪')
        return monitor.start(tabId)
      },
      monitorStop: () => {
        if (!monitor) throw new Error('实时预览服务未就绪')
        return monitor.stop()
      },
      monitorState: () => monitor?.getState() ?? { enabled: false, control: 'ai', status: 'idle', frameSeq: 0, history: [] },
      takeover: () => {
        if (!monitor) throw new Error('人工接管服务未就绪')
        const next = monitor.takeover()
        // 让 takeover 自身先返回成功；下一轮事件循环再中断其它调用。
        setImmediate(() => {
          approvals.interrupt()
          agentServer?.pause()
        })
        return next
      },
      releaseToAi: () => {
        if (!monitor) throw new Error('人工接管服务未就绪')
        approvals.resume()
        agentServer?.resume()
        return monitor.releaseToAi()
      },
      assertAiControl: () => {
        if (monitor?.getState().control === 'human') throw new Error('当前处于人工接管，AI 操作已锁定；请先调用 browser_window action=release。')
      },
      taskState: (clientId) => {
        const activity = agentServer?.activity() ?? { active: false, paused: false, calls: [] }
        if (clientId === undefined) return activity
        const calls = (activity.calls ?? []).filter((call) => call.client === clientId)
        return {
          ...activity,
          active: calls.length > 0,
          paused: activity.paused || !!agentServer?.isClientPaused(clientId),
          tool: calls[0]?.tool,
          startedAt: calls[0]?.startedAt,
          calls,
          tasks: activity.tasks?.filter((task) => task.client === clientId)
        }
      },
      cancelTask: (id, client) => agentServer?.cancelCall(id, client) ?? false,
      pauseTasks: (clientId, exceptCallId) => {
        if (clientId !== undefined) {
          setImmediate(() => agentServer?.pauseClient(clientId, exceptCallId))
          return
        }
        setImmediate(() => {
          approvals.pauseIndefinitely()
          agentServer?.pause()
        })
      },
      resumeTasks: (clientId) => {
        if (clientId !== undefined) agentServer?.resumeClient(clientId)
        else { approvals.resume(); agentServer?.resume() }
      }
    },
    getDownloadTracker(),
    approvals,
    logAgentAction,
    () => {
      const settings = getSettingsStore().get()
      return { requireOperationApproval: settings.requireOperationApproval, fullSnapshot: settings.fullSnapshot, searchEngine: settings.searchEngine }
    },
    () => agentServer?.runtimeInfo ?? { pid: process.pid, version: VERSION },
    () => session.fromPartition(SHARED_PARTITION)
  )
  agentServer = new AgentServer(
    tools,
    (n, verifiedCount) => {
      agentCount = n
      agentVerifiedCount = verifiedCount
      bridgeState = n > 0 ? 'connected' : 'waiting'
      pushState()
    },
    VERSION,
    approvals,
    (activity) => {
      const wasActive = agentActivity.active
      agentActivity = activity
      monitor?.recordTask(activity.active ? activity.tool : activity.paused ? 'AI 已暂停' : undefined)
      if (wasActive && !activity.active && !activity.paused && win && !win.isFocused() && Notification.isSupported()) {
        const latest = activity.tasks?.find((task) => task.status === 'completed' || task.status === 'failed')
        if (latest) {
          try {
            const failed = latest.status === 'failed'
            new Notification({
              title: failed ? 'Aa Browser 后台任务失败' : 'Aa Browser 后台任务完成',
              body: failed ? `${latest.tool}: ${latest.error || '操作失败'}` : `${latest.tool} 已完成。`
            }).show()
          } catch { /* Desktop notification support varies by platform. */ }
        }
      }
      pushState()
    },
    (clientId, operation) => {
      const manager = tabManager
      return manager ? manager.runAsAgent(clientId, operation) : operation()
    },
    (clientId) => {
      // A bridge reconnect with the same session id is common (app/window restart
      // does not restart an MCP host). Keep ownership for a grace period, then
      // release it so an abandoned client does not permanently hide its tabs.
      setTimeout(() => {
        if (agentServer?.isClientConnected(clientId)) return
        tabManager?.releaseAgentClient(clientId)
        pushState()
      }, 60_000).unref()
    }
  )
  void agentServer.start().then(() => {
    // 新实例已经写好自己的连接信息：更新重启窗口结束，桥可以恢复正常流程。
    clearUpdateRestartMarker(discoveryFile())
    if (agentCount === 0) bridgeState = 'waiting'
    agentActivity = agentServer?.activity() ?? agentActivity
    pushState()
    console.log('[aa-browser] agent server ready')
  }).catch(() => {
    bridgeState = 'disconnected'
    pushState()
  })
  // 启动环境变量只覆盖本次冷启动；持久化模式仍用于普通启动。
  if (startInBackground) applyWindowMode('hidden')
  else {
    const mode = currentWindowMode()
    applyWindowMode(mode)
    if (mode === 'background-visual' && monitor && !monitor.getState().enabled) {
      try { monitor.start(tabManager?.active()?.id) } catch { /* 没有可恢复标签时等待用户选择 */ }
    }
  }
})

app.on('before-quit', () => {
  // quitAndInstall 会先触发 before-quit。先留下标记，桥就知道这次断开是
  // 「更新重启」，会等新实例而不是自动启动；普通退出则清掉残留标记。
  if (updater?.isInstalling()) writeUpdateRestartMarker(discoveryFile(), VERSION)
  else clearUpdateRestartMarker(discoveryFile())
  updater?.dispose()
  approvals.cancelAll()
  agentServer?.stop()
})

app.on('window-all-closed', () => {
  app.quit()
})

// 单实例：再次启动聚焦已有窗口
const gotLock = app.requestSingleInstanceLock({ startInBackground })
if (!gotLock) {
  // 启动意图已通过单实例通道转交给已有实例；当前进程还没有窗口或服务，
  // 直接以 0 退出，避免在 ready 之前走完整退出流程。
  app.exit(0)
} else {
  app.on('second-instance', (_event, _argv, _cwd, data) => {
    // 多个桥同时自动启动，后来的实例不应唤起最先启动的窗口。
    if ((data as { startInBackground?: boolean } | null)?.startInBackground !== true) revealWindow()
  })
  if (process.platform === 'darwin') app.on('activate', revealWindow)
}

// 未捕获异常写日志，避免静默崩溃
process.on('uncaughtException', (err) => {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'error.log'), `${new Date().toISOString()} ${err.stack ?? err}\n`)
  } catch {
    /* 忽略 */
  }
})

// 未处理的 Promise 拒绝同样要留痕。Node 默认会把未处理拒绝当作致命错误抛出，
// 桌面外壳里这会变成没有窗口、没有提示的静默退出；这里统一记录到 error.log，
// 并同步写一份到 stderr，保证在 CI 这类管道输出场景下不丢日志。
process.on('unhandledRejection', (reason) => {
  const text = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'error.log'), `${new Date().toISOString()} unhandledRejection ${text}\n`)
  } catch {
    /* 忽略 */
  }
  try {
    fs.writeSync(2, `[aa-browser] unhandledRejection ${text}\n`)
  } catch {
    /* 忽略 */
  }
})
