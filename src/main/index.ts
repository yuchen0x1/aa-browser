import { app, BaseWindow, WebContentsView, ipcMain, Menu, MenuItem, shell, clipboard, powerMonitor, nativeTheme } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TabManager } from './tabs'
import type { Tab } from './tabs'
import { AgentServer } from './agent-server'
import { buildTools } from './tools'
import { normalizeUrl } from './tabs'
import { detectClients, setupClients, syncAppImageBridge } from './clients'
import { getDownloadTracker } from './downloads'
import { getEvidenceManager } from './evidence'
import { getHistoryStore } from './history'
import { getSettingsStore } from './settings'
import { getSessionStore } from './session-store'
import { ApprovalManager } from './approvals'
import { applyPermissionPolicy, clearIsolatedPartition, sweepStalePartitions } from './sessions'
import { session } from 'electron'
import type { UiState } from '@shared/types'
import { contextMenuLabels } from '@shared/menu-labels'
import { UpdateManager } from './updater'
import { PageFinder } from './page-finder'
import { printPage } from './printing'
import { getMainLocale } from './locale'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const VERSION = app.getVersion()

const CHROME_HEIGHT = 84

/** 默认搜索引擎基址：优先读取用户设置 */
function searchUrlBase(): string {
  return getSettingsStore().get().searchEngine
}

// 开发版使用独立 userData：避免与安装版争单实例锁/登录态/connection.json。
// ⚠️ 必须在 requestSingleInstanceLock() 之前调用（锁按 userData 路径区分）。
const profileOverride = process.env['AA_BROWSER_USER_DATA_DIR']
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
let bridgeState: UiState['bridgeState'] = 'waiting'
let agentActivity: NonNullable<UiState['agentActivity']> = { active: false, paused: false }
let settingsOpen = false
let overlayHeight = 0
let finder: PageFinder | null = null
const approvals = new ApprovalManager()
let updater: UpdateManager | null = null
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
  if (!win || !chromeView) return
  const { width, height } = win.getContentBounds()
  const panelHeight = (approvals.list().length ? 180 : 0) + (finder?.getState().open ? 48 : 0) + (updater?.getState().noticeVisible ? 44 : 0)
  const showActivityOverlay = agentActivity.active || agentActivity.paused
  const chromeHeight = settingsOpen || showActivityOverlay
    ? height
    : Math.min(height, Math.max(CHROME_HEIGHT + panelHeight, overlayHeight))
  chromeView.setBounds({ x: 0, y: 0, width, height: chromeHeight })
  const active = tabManager?.active()
  if (active) {
    active.view.setBounds({ x: 0, y: CHROME_HEIGHT + panelHeight, width, height: Math.max(0, height - CHROME_HEIGHT - panelHeight) })
  }
}

function attachTabView(tabView: WebContentsView): void {
  if (!win) return
  // 页面视图插到底部，保证 chromeView（后加入）始终在最上层
  win.contentView.addChildView(tabView, 0)
  layout()
}

function detachTabView(tabView: WebContentsView): void {
  win?.contentView.removeChildView(tabView)
}

function pushState(): void {
  if (!chromeView) return
  layout()
  const state: UiState = {
    tabs: tabManager?.infos() ?? [],
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
    windowHeight: win?.getContentBounds().height
  }
  chromeView.webContents.send('aa:state', state)
}

function handleBeforeInput(wc: Electron.WebContents): void {
  wc.on('before-input-event', (event, input) => {
    const ctrl = input.control || input.meta
    if (input.type !== 'keyDown') return
    // 模态设置不允许浏览器快捷键改变背后的网页或夺走表单焦点。
    const key = input.key.toLowerCase()
    if (settingsOpen && ((ctrl && ['t', 'w', 'l', 'f', 'r', 'p'].includes(key)) || (ctrl && input.shift && key === 'i') || key === 'f5' || (input.alt && ['arrowleft', 'arrowright'].includes(key)))) {
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
    if (ctrl && input.shift && input.key.toLowerCase() === 'i') {
      event.preventDefault()
      // DevTools 与抓包共用调试通道：打开前先释放抓包
      const t = tabManager?.tabs.find((x) => x.view.webContents === wc)
      t?.net.releaseDebugger()
      wc.openDevTools({ mode: 'detach' })
      return
    }
  })
}

/** 为单个页面 WebContents 注册右键菜单（普通网页浏览器基本操作） */
function installPageContextMenu(wc: Electron.WebContents): void {
  wc.on('context-menu', (_e, params) => {
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
        getEvidenceManager().record(p, 'context-shot')
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
  if (wc.getURL() !== newtabUrl()) return
  const theme = resolvedTheme()
  const locale = getSettingsStore().get().locale
  const url = newtabUrl()
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

function createWindow(): void {
  win = new BaseWindow({
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
  nativeTheme.on('updated', () => {
    applyTitleBarOverlay()
    syncInternalAppearance()
  })
  applyTitleBarOverlay()

  // chrome UI 加载完成后再显示窗口，避免白闪（见下方 chromeView 创建处）
  win.on('resize', pushState)
  win.on('focus', () => { void updater?.checkIfDue() })
  win.on('closed', () => {
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
  // chrome UI 加载完成后再显示窗口，避免白闪
  cv.webContents.once('did-finish-load', () => win?.show())
  setTimeout(() => win?.show(), 2500) // 兜底：加载卡住也要出窗口
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
  function isTrustedSender(event: Electron.IpcMainInvokeEvent): boolean {
    return !!chromeView && event.sender === chromeView.webContents
  }
  function guard<T>(event: Electron.IpcMainInvokeEvent, fallback: T, fn: () => T): T {
    if (!isTrustedSender(event)) return fallback
    return fn()
  }

  ipcMain.handle('aa:get-state', (event) => {
    return guard(event, null, () => ({
      tabs: tabManager?.infos() ?? [],
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
      windowHeight: win?.getContentBounds().height
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
  ipcMain.handle('aa:tab-close', (event, id: string) => {
    return guard(event, undefined, () => {
      const tab = tabManager?.get(id)
      if (tab) detachTabView(tab.view)
      tabManager?.closeTab(id)
    })
  })
  ipcMain.handle('aa:tab-select', (event, id: string, focusPage: unknown = true) => {
    return guard(event, undefined, () => {
      const prev = tabManager?.tabs.find((t) => t.id === tabManager?.activeId)
      const next = tabManager?.get(id)
      if (!tabManager || !next) return
      if (prev && prev.id !== id) detachTabView(prev.view)
      attachTabView(next.view)
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
      const active = tabManager?.active()
      if (!active || !tabManager) return false
      const target = normalizeUrl(value, searchUrlBase(), newtabUrl())
      try {
        tabManager.assertUrlAllowed(target)
      } catch {
        return false
      }
      void tabManager.navigate(active, target).catch(() => {
        // 页面加载失败由 WebContents 呈现，地址栏 IPC 只确认是否接受输入。
      })
      return true
    })
  })
  ipcMain.handle('aa:devtools', (event) => {
    return guard(event, undefined, () => {
      const active = tabManager?.active()
      active?.net.releaseDebugger() // DevTools 与 debugger/对话框守卫互斥
      active?.view.webContents.openDevTools({ mode: 'detach' })
    })
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
  ipcMain.handle('aa:agent-cancel-call', (event, callId: number) => {
    if (!isTrustedSender(event)) return false
    return agentServer?.cancelCall(Number(callId)) ?? false
  })
  approvals.onChange = () => {
    if (approvals.isInterrupted()) {
      agentActivity = { active: false, paused: true, resumeAt: approvals.getResumeAt() }
    } else if (!agentActivity.active) {
      agentActivity = { active: false, paused: false }
      agentServer?.resume()
    }
    pushState()
  }
  ipcMain.handle('aa:clients-detect', (event) => {
    return guard(event, [], () => detectClients())
  })
  ipcMain.handle('aa:clients-setup', (event, ids: string[]) => {
    return guard(event, [], () => setupClients(Array.isArray(ids) ? ids : []))
  })
  ipcMain.handle('aa:downloads-list', (event) => {
    return guard(event, [], () => getDownloadTracker().list(20))
  })
  ipcMain.handle('aa:download-open', (event, id: string) => {
    return guard(event, undefined, () => getDownloadTracker().open(String(id)))
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
  ipcMain.handle('aa:agent-info', (event) => {
    return guard(event, null, () => {
      const info = agentServer?.info()
      if (!info) return null
      return {
        port: info.port,
        version: info.version,
        discoveryFile: info.discoveryFile,
        clientCount: info.clientCount,
        verifiedClientCount: info.verifiedClientCount
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
  ipcMain.handle('aa:update-install', (event) => guard(event, false, () => updater?.install() ?? false))
  ipcMain.handle('aa:update-dismiss', (event) => guard(event, undefined, () => updater?.dismissNotice()))
  ipcMain.handle('aa:update-retry', (event) => guard(event, null, () => updater?.retry() ?? null))
  ipcMain.handle('aa:update-wake', (event) => guard(event, null, () => updater?.checkIfDue() ?? null))
  getDownloadTracker().onChange = pushState
}

function onTabChange(): void {
  if (!win || !tabManager) return
  finder?.syncActive()
  // 活动标签挂载/卸载
  const active = tabManager.active()
  for (const t of tabManager.tabs) {
    const isShown = t.id === tabManager.activeId
    const isAttached = win.contentView.children.includes(t.view)
    if (isShown && !isAttached) attachTabView(t.view)
    if (!isShown && isAttached) detachTabView(t.view)
  }
  if (active) layout()
  pushState()
  scheduleSessionSave()
}

app.whenReady().then(() => {
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
  getDownloadTracker().setDirectoryProvider(() => getSettingsStore().get().downloadDir)
  // 重试是新的网络请求，必须重新过站点白名单，不能沿用创建下载时的授权
  getDownloadTracker().setUrlGuard((url) => tabManager?.isUrlAllowed(url) ?? false)

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
  if (restored) {
    restoringSession = true
    const created: Tab[] = []
    for (const entry of restored.tabs) {
      try {
        created.push(tabManager.createTab(entry.url, false, false))
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
        })
    },
    getDownloadTracker(),
    approvals,
    logAgentAction,
    () => {
      const settings = getSettingsStore().get()
      return { requireOperationApproval: settings.requireOperationApproval, fullSnapshot: settings.fullSnapshot, searchEngine: settings.searchEngine }
    }
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
      agentActivity = activity
      pushState()
    }
  )
  void agentServer.start().then(() => {
    if (agentCount === 0) bridgeState = 'waiting'
    pushState()
    console.log('[aa-browser] agent server ready')
  }).catch(() => {
    bridgeState = 'disconnected'
    pushState()
  })
})

app.on('before-quit', () => {
  try { flushSessionRecord?.(true) } catch { /* 会话记录是尽力而为，不阻塞退出 */ }
  updater?.dispose()
  approvals.cancelAll()
  agentServer?.stop()
  tabManager?.closeAll()
})

app.on('window-all-closed', () => {
  tabManager?.closeAll()
  app.quit()
})

// 单实例：再次启动聚焦已有窗口
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
}

// 未捕获异常写日志，避免静默崩溃
process.on('uncaughtException', (err) => {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'error.log'), `${new Date().toISOString()} ${err.stack ?? err}\n`)
  } catch {
    /* 忽略 */
  }
})
