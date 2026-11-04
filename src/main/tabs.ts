import { WebContentsView, WebContents } from 'electron'
import type { TabInfo } from '@shared/types'
import { NetworkCapture } from './network'

export interface Tab {
  id: string
  view: WebContentsView
  title: string
  url: string
  favicon?: string
  loading: boolean
  consoleBuf: { level: string; text: string; ts: number }[]
  net: NetworkCapture
}

export function normalizeUrl(input: string, searchUrl: string, newtabUrl: string): string {
  const s = (input || '').trim()
  if (!s) return newtabUrl
  if (/^(https?|file|about|chrome|devtools|view-source|data|blob):/i.test(s)) return s
  if (/^localhost(:\d+)?([/?#]|$)/i.test(s)) return 'http://' + s
  if (/^(127|192\.168|10\.\d+|172\.(1[6-9]|2\d|3[01]))\./.test(s)) return 'http://' + s
  // 像域名的输入直接补 https
  if (/^[a-z0-9][a-z0-9-]*(\.[a-z0-9-]+)+(:\d+)?([/?#].*)?$/i.test(s)) return 'https://' + s
  // 其余当作搜索词
  return searchUrl + encodeURIComponent(s)
}

let idSeq = 0
const genId = (): string => `t${Date.now().toString(36)}${(idSeq++).toString(36)}`

/** 捕获 console-message 事件的两种 Electron 形态（旧的位置参数 / 新的事件对象） */
function readConsoleMessage(args: unknown[]): { level: string; text: string } | null {
  const a0 = args[0] as Record<string, unknown> | undefined
  if (a0 && typeof a0 === 'object' && 'level' in a0 && 'message' in a0) {
    return { level: String(a0['level'] ?? 'log'), text: String(a0['message'] ?? '') }
  }
  const level = args[1]
  const message = args[2]
  if (typeof message === 'string') {
    return { level: typeof level === 'number' ? String(level) : String(level ?? 'log'), text: message }
  }
  return null
}

export class TabManager {
  tabs: Tab[] = []
  activeId: string | null = null
  onChange: () => void = () => {}
  /** 新标签页专用 preload（接入卡片 UI 需要 IPC） */
  newtabPreload: string | null = null

  constructor(
    private newtabUrl: string,
    private searchUrl: string
  ) {}

  active(): Tab | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? null
  }

  get(id: string): Tab | null {
    return this.tabs.find((t) => t.id === id) ?? null
  }

  createTab(url?: string, activate = true): Tab {
    const target = url || this.newtabUrl
    const view = new WebContentsView({
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        preload: target === this.newtabUrl ? this.newtabPreload ?? undefined : undefined
      }
    })
    const tab: Tab = {
      id: genId(),
      view,
      title: '新建标签页',
      url: url || this.newtabUrl,
      loading: false,
      consoleBuf: [],
      net: new NetworkCapture(view.webContents)
    }
    this.attachEvents(tab)
    this.tabs.push(tab)
    if (activate) this.activeId = tab.id
    void tab.net.ensure().catch(() => {}) // 抓包随 tab 建立，覆盖首屏导航的请求
    view.webContents.loadURL(tab.url).catch(() => {}) // 被后续导航打断时静默
    this.onChange()
    return tab
  }

  closeTab(id: string): void {
    const idx = this.tabs.findIndex((t) => t.id === id)
    if (idx === -1) return
    const [tab] = this.tabs.splice(idx, 1)
    tab.net.dispose()
    try {
      tab.view.webContents.close()
    } catch {
      /* 已销毁 */
    }
    if (this.activeId === id) {
      this.activeId = this.tabs.length ? this.tabs[Math.min(idx, this.tabs.length - 1)].id : null
    }
    this.onChange()
  }

  selectTab(id: string): void {
    if (this.get(id)) {
      this.activeId = id
      this.onChange()
    }
  }

  closeAll(): void {
    for (const t of [...this.tabs]) this.closeTab(t.id)
  }

  private attachEvents(tab: Tab): void {
    const wc = tab.view.webContents

    wc.on('did-start-loading', () => {
      tab.loading = true
      this.onChange()
    })
    wc.on('did-stop-loading', () => {
      tab.loading = false
      tab.url = wc.getURL() || tab.url
      this.onChange()
    })
    wc.on('page-title-updated', (_e, title) => {
      tab.title = title || tab.title
      this.onChange()
    })
    wc.on('page-favicon-updated', (_e, favs) => {
      tab.favicon = favs?.length ? favs[favs.length - 1] : undefined
      this.onChange()
    })
    wc.on('did-navigate', (_e, url) => {
      tab.url = url
      this.onChange()
    })
    wc.on('did-navigate-in-page', (_e, url) => {
      if (url) tab.url = url
      this.onChange()
    })
    wc.on('render-process-gone', () => {
      tab.title = '页面已崩溃'
      this.onChange()
    })
    wc.on('console-message', (...args: unknown[]) => {
      const msg = readConsoleMessage(args)
      if (!msg) return
      tab.consoleBuf.push({ level: msg.level, text: msg.text, ts: Date.now() })
      if (tab.consoleBuf.length > 200) tab.consoleBuf.splice(0, tab.consoleBuf.length - 200)
    })

    // target=_blank / window.open → 在本浏览器新开标签
    wc.setWindowOpenHandler(({ url }) => {
      if (url && /^https?:|^file:/i.test(url)) {
        this.createTab(url)
      }
      return { action: 'deny' }
    })
  }

  canBack(tab: Tab): boolean {
    const wc = tab.view.webContents as WebContents & {
      navigationHistory?: { canGoBack: () => boolean }
    }
    if (wc.navigationHistory) return wc.navigationHistory.canGoBack()
    return (wc as unknown as { canGoBack: () => boolean }).canGoBack()
  }

  canForward(tab: Tab): boolean {
    const wc = tab.view.webContents as WebContents & {
      navigationHistory?: { canGoForward: () => boolean }
    }
    if (wc.navigationHistory) return wc.navigationHistory.canGoForward()
    return (wc as unknown as { canGoForward: () => boolean }).canGoForward()
  }

  goBack(tab: Tab): void {
    const wc = tab.view.webContents as WebContents & {
      navigationHistory?: { goBack: () => void }
    }
    if (wc.navigationHistory) wc.navigationHistory.goBack()
    else (wc as unknown as { goBack: () => void }).goBack()
  }

  goForward(tab: Tab): void {
    const wc = tab.view.webContents as WebContents & {
      navigationHistory?: { goForward: () => void }
    }
    if (wc.navigationHistory) wc.navigationHistory.goForward()
    else (wc as unknown as { goForward: () => void }).goForward()
  }

  infos(): TabInfo[] {
    return this.tabs.map((t) => ({
      id: t.id,
      title: t.title,
      url: t.url,
      favicon: t.favicon,
      loading: t.loading,
      active: t.id === this.activeId,
      canBack: this.canBack(t),
      canForward: this.canForward(t)
    }))
  }
}
