import { app, BaseWindow, WebContentsView, ipcMain, Menu, MenuItem, shell, clipboard } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { TabManager } from './tabs'
import { AgentServer } from './agent-server'
import { buildTools } from './tools'
import { normalizeUrl } from './tabs'
import { detectClients, setupClients } from './clients'
import { getDownloadTracker } from './downloads'
import { getHistoryStore } from './history'
import { getSettingsStore } from './settings'
import { ApprovalManager } from './approvals'
import { applyPermissionPolicy, clearIsolatedPartition, sweepStalePartitions } from './sessions'
import { session } from 'electron'
import type { UiState } from '@shared/types'
import { UpdateManager } from './updater'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const VERSION = app.getVersion()

const CHROME_HEIGHT = 78

/** 默认搜索引擎基址：优先读取用户设置 */
function searchUrlBase(): string {
  return getSettingsStore().get().searchEngine
}

// 开发版使用独立 userData：避免与安装版争单实例锁/登录态/connection.json。
// ⚠️ 必须在 requestSingleInstanceLock() 之前调用（锁按 userData 路径区分）。
if (!app.isPackaged) {
  const userData = process.env['AA_BROWSER_USER_DATA_DIR'] || path.join(app.getPath('appData'), 'aa-browser-dev')
  app.setPath('userData', userData)
  process.env['AA_BROWSER_CONNECTION_FILE'] ||= path.join(userData, 'connection.json')
}

let win: BaseWindow | null = null
let chromeView: WebContentsView | null = null
let tabManager: TabManager | null = null
let agentServer: AgentServer | null = null
let agentCount = 0
let bridgeState: UiState['bridgeState'] = 'waiting'
let connectionMessage = '等待 MCP 桥启动并连接'
const approvals = new ApprovalManager()
let updater: UpdateManager | null = null
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
  const panelHeight = approvals?.list().length ? 132 : 0
  chromeView.setBounds({ x: 0, y: 0, width, height: CHROME_HEIGHT + panelHeight })
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
  const state: UiState = {
    tabs: tabManager?.infos() ?? [],
    activeId: tabManager?.activeId ?? null,
    agentCount,
    bridgeState,
    connectionMessage,
    pendingApprovals: approvals.list(),
    agentInterrupted: approvals.isInterrupted(),
    recentActions: [...recentActions],
    downloads: getDownloadTracker().list(20),
    update: updater?.getState()
  }
  chromeView.webContents.send('aa:state', state)
}

function handleBeforeInput(wc: Electron.WebContents): void {
  wc.on('before-input-event', (event, input) => {
    const ctrl = input.control || input.meta
    if (input.type !== 'keyDown') return
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
    const hasLink = /^https?:|^file:/i.test(params.linkURL)
    const linkAllowed = !!tabManager?.isUrlAllowed(params.linkURL)
    const hasSelection = !!params.selectionText
    const editable = !!params.isEditable

    const push = (opts: MenuItemConstructorOptions): void => { menu.append(new MenuItem(opts)) }

    if (editable) {
      push({ label: '撤销', role: 'undo' })
      push({ label: '重做', role: 'redo' })
      push({ type: 'separator' })
      push({ label: '剪切', role: 'cut' })
      push({ label: '复制', role: 'copy' })
      push({ label: '粘贴', role: 'paste' })
      push({ label: '全选', role: 'selectAll' })
    } else if (hasSelection) {
      push({ label: '复制', role: 'copy' })
    }

    if (menu.items.length) push({ type: 'separator' })

    if (hasLink) {
      push({ label: '打开链接', enabled: linkAllowed, click: () => { if (linkAllowed) void wc.loadURL(params.linkURL) } })
      push({ label: '在新标签页打开链接', enabled: linkAllowed, click: () => { if (linkAllowed) tabManager?.createTab(params.linkURL) } })
      push({ label: '复制链接地址', click: () => { clipboard.writeText(params.linkURL) } })
      push({ type: 'separator' })
    }

    const active = tabManager?.active()
    const isActiveTab = active?.view.webContents === wc
    const canBack = tabManager && active ? tabManager.canBack(active) : false
    const canForward = tabManager && active ? tabManager.canForward(active) : false
    push({ label: '后退', enabled: isActiveTab && canBack, click: () => { const t = tabManager?.active(); if (t) tabManager?.goBack(t) } })
    push({ label: '前进', enabled: isActiveTab && canForward, click: () => { const t = tabManager?.active(); if (t) tabManager?.goForward(t) } })
    push({ label: '刷新', click: () => wc.reload() })
    push({ type: 'separator' })
    push({ label: '查看源代码', enabled: !getSettingsStore().get().allowedSites.length, click: () => {
      if (!getSettingsStore().get().allowedSites.length) void wc.loadURL(`view-source:${wc.getURL()}`)
    } })
    push({ label: '开发者工具', click: () => {
      const t = tabManager?.tabs.find((x) => x.view.webContents === wc)
      t?.net.releaseDebugger() // DevTools 与 debugger/对话框守卫互斥
      wc.openDevTools({ mode: 'detach' })
    } })
    push({ label: '截图保存', click: () => {
      void wc.capturePage().then((img) => {
        const dir = app.getPath('pictures') || os.homedir()
        const p = path.join(dir, `aabrowser-${Date.now()}.png`)
        fs.writeFileSync(p, img.toPNG())
        shell.showItemInFolder(p)
      }).catch(() => {})
    } })

    menu.popup({ window: win ?? undefined })
  })
}

function createWindow(): void {
  win = new BaseWindow({
    width: 1280,
    height: 840,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: '#16171b',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#1b1c21',
      symbolColor: '#d7d8db',
      height: 38
    },
    title: 'Aa Browser'
  })

  // chrome UI 加载完成后再显示窗口，避免白闪（见下方 chromeView 创建处）
  win.on('resize', layout)
  win.on('closed', () => {
    win = null
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
      bridgeState,
      connectionMessage,
      pendingApprovals: approvals.list(),
      agentInterrupted: approvals.isInterrupted(),
      downloads: getDownloadTracker().list(20)
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
  ipcMain.handle('aa:tab-close', (event, id: string) => {
    return guard(event, undefined, () => {
      const tab = tabManager?.get(id)
      if (tab) detachTabView(tab.view)
      tabManager?.closeTab(id)
    })
  })
  ipcMain.handle('aa:tab-select', (event, id: string) => {
    return guard(event, undefined, () => {
      const prev = tabManager?.tabs.find((t) => t.id === tabManager?.activeId)
      const next = tabManager?.get(id)
      if (!tabManager || !next) return
      if (prev && prev.id !== id) detachTabView(prev.view)
      attachTabView(next.view)
      tabManager.selectTab(id)
      next.view.webContents.focus()
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
      void active.view.webContents.loadURL(target)
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
    return true
  })
  ipcMain.handle('aa:agent-resume', (event) => {
    if (!isTrustedSender(event)) return false
    approvals.resume()
    return true
  })
  approvals.onChange = pushState
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
      const result = getSettingsStore().set((patch ?? {}) as Record<string, unknown>)
      updater?.refreshSettings()
      return result
    })
  })
  ipcMain.handle('aa:agent-info', (event) => {
    return guard(event, null, () => agentServer?.info() ?? null)
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
  getDownloadTracker().onChange = pushState
}

function onTabChange(): void {
  if (!win || !tabManager) return
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
}

app.whenReady().then(() => {
  app.setAppUserModelId('com.aa.browser')
  Menu.setApplicationMenu(null)

  updater = new UpdateManager(VERSION, () => {
    const settings = getSettingsStore().get()
    return { autoUpdate: settings.autoUpdate, updateChannel: settings.updateChannel }
  }, app.isPackaged)
  updater.init(pushState)

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

  tabManager = new TabManager(newtabUrl(), searchUrlBase())
  tabManager.onChange = onTabChange
  tabManager.onContextMenu = installPageContextMenu
  tabManager.onNavigate = (url, title) => getHistoryStore().add(url, title)
  tabManager.getAllowedSites = () => getSettingsStore().get().allowedSites
  tabManager.getDefaultIsolated = () => getSettingsStore().get().isolatedSessions
  tabManager.onSession = (ses) => {
    applyPermissionPolicy(ses)
    getDownloadTracker().attach(ses)
  }
  tabManager.onIsolatedClosed = (partition) => void clearIsolatedPartition(partition)
  tabManager.onViewDetach = (view) => detachTabView(view)
  getDownloadTracker().setDirectoryProvider(() => getSettingsStore().get().downloadDir)

  createWindow()

  // 首个标签页：新标签页
  tabManager.createTab()

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
    () => ({ requireOperationApproval: getSettingsStore().get().requireOperationApproval, fullSnapshot: getSettingsStore().get().fullSnapshot })
  )
  agentServer = new AgentServer(
    tools,
    (n) => {
      agentCount = n
      bridgeState = n > 0 ? 'connected' : 'waiting'
      connectionMessage = n > 0 ? `${n} 个 MCP 桥已通过本机 token 验证` : '等待 MCP 桥启动并连接'
      pushState()
    },
    VERSION,
    approvals
  )
  void agentServer.start().then(() => {
    bridgeState = 'waiting'
    const discoveryFile = process.env['AA_BROWSER_CONNECTION_FILE'] || path.join(app.getPath('home'), '.aabrowser', 'connection.json')
    connectionMessage = `本地服务已启动，发现文件：${discoveryFile}；等待 MCP 客户端完成认证握手`
    pushState()
    console.log(`[aa-browser] agent server ready: ${discoveryFile}`)
  }).catch((err: unknown) => {
    bridgeState = 'disconnected'
    connectionMessage = `本地 Agent 服务启动失败：${err instanceof Error ? err.message : String(err)}`
    pushState()
  })
})

app.on('before-quit', () => {
  approvals.cancelAll()
  agentServer?.stop()
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
    fs.appendFileSync(path.join(app.getPath('home'), '.aabrowser', 'error.log'), `${new Date().toISOString()} ${err.stack ?? err}\n`)
  } catch {
    /* 忽略 */
  }
})
