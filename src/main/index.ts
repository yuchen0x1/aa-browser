import { app, BaseWindow, WebContentsView, ipcMain, Menu } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import { TabManager } from './tabs'
import { AgentServer } from './agent-server'
import { buildTools } from './tools'
import { normalizeUrl } from './tabs'
import { detectClients, setupClients } from './clients'
import { getDownloadTracker } from './downloads'
import { ApprovalManager } from './approvals'
import { session } from 'electron'
import type { UiState } from '@shared/types'

const __dirname = fileURLToPath(new URL('.', import.meta.url))
const VERSION = app.getVersion()

const CHROME_HEIGHT = 78
const SEARCH_URL = 'https://www.bing.com/search?q='

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

/** 新标签页地址：dev 走 vite dev server，产物走打包出的 renderer 文件 */
function newtabUrl(): string {
  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) return `${devUrl}/newtab.html`
  return path.join(__dirname, '../renderer/newtab.html')
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
    agentInterrupted: approvals.isInterrupted()
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
      t?.net.dispose()
      wc.openDevTools({ mode: 'detach' })
      return
    }
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
  void cv.webContents.loadURL(assets.index)
  handleBeforeInput(cv.webContents)
}

function registerIpc(): void {
  ipcMain.handle('aa:get-state', () => {
    return {
      tabs: tabManager?.infos() ?? [],
      activeId: tabManager?.activeId ?? null,
      agentCount,
      bridgeState,
      connectionMessage,
      pendingApprovals: approvals.list(),
      agentInterrupted: approvals.isInterrupted()
    } satisfies UiState
  })
  ipcMain.handle('aa:tab-new', (_e, url?: string) => {
    const target = url ? normalizeUrl(url, SEARCH_URL, newtabUrl()) : newtabUrl()
    tabManager?.createTab(target)
  })
  ipcMain.handle('aa:tab-close', (_e, id: string) => {
    const tab = tabManager?.get(id)
    if (tab) detachTabView(tab.view)
    tabManager?.closeTab(id)
  })
  ipcMain.handle('aa:tab-select', (_e, id: string) => {
    const prev = tabManager?.tabs.find((t) => t.id === tabManager?.activeId)
    const next = tabManager?.get(id)
    if (!tabManager || !next) return
    if (prev && prev.id !== id) detachTabView(prev.view)
    attachTabView(next.view)
    tabManager.selectTab(id)
    next.view.webContents.focus()
  })
  ipcMain.handle('aa:back', () => {
    const active = tabManager?.active()
    if (active) tabManager?.goBack(active)
  })
  ipcMain.handle('aa:forward', () => {
    const active = tabManager?.active()
    if (active) tabManager?.goForward(active)
  })
  ipcMain.handle('aa:reload', () => {
    const active = tabManager?.active()
    active?.view.webContents.reload()
  })
  ipcMain.handle('aa:omnibox-submit', (_e, value: string) => {
    const active = tabManager?.active()
    if (!active) return
    const target = normalizeUrl(value, SEARCH_URL, newtabUrl())
    void active.view.webContents.loadURL(target)
  })
  ipcMain.handle('aa:devtools', () => {
    const active = tabManager?.active()
    active?.net.dispose() // DevTools 与抓包共用调试通道
    active?.view.webContents.openDevTools({ mode: 'detach' })
  })
  ipcMain.handle('aa:approval-decide', (event, id: string, allowed: boolean) => {
    if (event.sender !== chromeView?.webContents || !approvals.decide(String(id), allowed === true)) return false
    return true
  })
  ipcMain.handle('aa:agent-interrupt', (event) => {
    if (event.sender !== chromeView?.webContents) return false
    approvals.interrupt()
    return true
  })
  ipcMain.handle('aa:agent-resume', (event) => {
    if (event.sender !== chromeView?.webContents) return false
    approvals.resume()
    return true
  })
  approvals.onChange = pushState
  ipcMain.handle('aa:clients-detect', () => {
    return detectClients()
  })
  ipcMain.handle('aa:clients-setup', (_e, ids: string[]) => {
    return setupClients(Array.isArray(ids) ? ids : [])
  })
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

  registerIpc()

  tabManager = new TabManager(newtabUrl(), SEARCH_URL)
  tabManager.newtabPreload = path.join(__dirname, '../preload/index.js')
  tabManager.onChange = onTabChange

  createWindow()

  // 首个标签页：新标签页
  tabManager.createTab()

  // 下载追踪：静默捕获所有下载（自动保存到 ~/.aabrowser/downloads/）
  getDownloadTracker().attach(session.defaultSession)

  // Agent 接入服务
  const tools = buildTools(
    tabManager,
    newtabUrl(),
    SEARCH_URL,
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
    approvals
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
