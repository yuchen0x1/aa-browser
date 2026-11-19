import { WebContentsView, WebContents, session } from 'electron'
import type { Session } from 'electron'
import type { TabInfo } from '@shared/types'
import { NetworkCapture } from './network'
import { installDialogGuard } from './dialogs'

export interface Tab {
  id: string
  partition: string
  session: Session
  view: WebContentsView
  title: string
  url: string
  favicon?: string
  loading: boolean
  consoleBuf: { level: string; text: string; ts: number }[]
  net: NetworkCapture
  ready: Promise<void>
  initialNavigation: Promise<void>
  /** 是否使用独立会话分区（隔离标签） */
  isolated: boolean
}

/**
 * 默认共享会话分区。
 *
 * v0.6.x 给每个标签分配 `persist:tab-<id>`，导致两个真实问题：
 *   1. 在 A 标签登录后，B 标签打开同一站点仍是未登录状态——不像浏览器；
 *   2. 每个分区在磁盘上留下独立目录，关闭标签后不回收，无限增长。
 * 现在普通标签统一走这个分区（登录态、Cookie、Storage 共享），
 * 只有显式要求隔离的标签（测试/脏数据场景）才创建一次性分区并在关闭时清理。
 */
export const SHARED_PARTITION = 'persist:aa-main'
/** 隔离标签分区前缀，用于退出时扫描并清理残留 */
export const ISOLATED_PARTITION_PREFIX = 'aa-iso-'

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

function defaultPort(protocol: string): string {
  return protocol === 'https:' ? '443' : protocol === 'http:' ? '80' : ''
}

function hostMatches(hostname: string, pattern: string): boolean {
  const normalizedHost = hostname.toLowerCase().replace(/\.$/, '')
  const normalizedPattern = pattern.toLowerCase().replace(/\.$/, '')
  if (normalizedPattern.startsWith('*.')) {
    const suffix = normalizedPattern.slice(2)
    return normalizedHost.endsWith(`.${suffix}`) && normalizedHost.length > suffix.length + 1
  }
  return normalizedHost === normalizedPattern
}

function siteRuleMatches(url: URL, rawRule: string): boolean {
  const rule = rawRule.trim()
  if (!rule) return false
  const candidate = rule.includes('://') ? rule : `https://${rule}`
  let parsed: URL
  try {
    parsed = new URL(candidate)
  } catch {
    return false
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (parsed.username || parsed.password || parsed.hash || parsed.search || parsed.pathname !== '/') return false
  if (parsed.port && parsed.port !== (url.port || defaultPort(url.protocol))) return false
  if (!hostMatches(url.hostname, parsed.hostname)) return false
  return parsed.protocol === url.protocol
}

export function isUrlAllowed(url: string, rules: string[], newtabUrl: string): boolean {
  if (url === newtabUrl) return true
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  // Only regular web pages are eligible for navigation.  In particular, an
  // empty allowlist must not turn file:, data:, devtools:, or other internal
  // schemes into an implicit allow rule.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (!rules.length) return true
  return rules.some((rule) => siteRuleMatches(parsed, rule))
}

let idSeq = 0
const genId = (): string => `t${Date.now().toString(36)}${(idSeq++).toString(36)}`
const NAVIGATION_TIMEOUT_MS = 20_000

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} 超时（${timeoutMs}ms）`)), timeoutMs)
      })
    ])
  } finally {
    if (timeout) clearTimeout(timeout)
  }
}

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
  /** 仅当前进程内保存普通标签 URL；隔离标签和退出清理不进入恢复记录。 */
  private recentlyClosed: string[] = []
  activeId: string | null = null
  onChange: () => void = () => {}
  /** 由主进程注入：为页面 WebContents 注册右键菜单（需访问 owner window） */
  onContextMenu: ((wc: WebContents) => void) | null = null
  /** 由主进程注入：页面完成导航时记录历史（url, title） */
  onNavigate: ((url: string, title: string) => void) | null = null
  /** 由主进程注入：为每个分区安装下载监听 */
  onSession: ((ses: Session) => void) | null = null
  /**
   * 由主进程注入：把视图从窗口移除。
   *
   * 关闭标签时必须先摘下视图：onTabChange 遍历的是已 splice 掉的数组，
   * 因此关闭的视图原本永远不会被移除，会作为窗口子视图长期驻留，
   * 既泄漏资源，也让隔离分区的文件句柄一直不释放（Windows 上删不掉目录）。
   */
  onViewDetach: ((view: WebContentsView) => void) | null = null
  /** 由主进程注入：读取最新站点白名单 */
  getAllowedSites: () => string[] = () => []
  /** 由主进程注入：是否默认使用隔离会话（设置项） */
  getDefaultIsolated: () => boolean = () => false
  /** 由主进程注入：隔离标签关闭时回调（用于清理分区数据） */
  onIsolatedClosed: ((partition: string) => void) | null = null

  constructor(
    private newtabUrl: string,
    private searchUrl: string
  ) {}

  isUrlAllowed(url: string): boolean {
    return isUrlAllowed(url, this.getAllowedSites(), this.newtabUrl)
  }

  assertUrlAllowed(url: string): void {
    if (!this.isUrlAllowed(url)) throw new Error(`站点不在白名单中：${url}`)
  }

  active(): Tab | null {
    return this.tabs.find((t) => t.id === this.activeId) ?? null
  }

  get(id: string): Tab | null {
    return this.tabs.find((t) => t.id === id) ?? null
  }

  /**
   * 新建标签。
   * @param isolated 使用独立会话分区（不共享登录态），关闭时自动清理。
   *                 省略时取设置里的「默认隔离」开关。
   */
  createTab(url?: string, activate = true, isolated?: boolean): Tab {
    const target = url || this.newtabUrl
    this.assertUrlAllowed(target)
    const id = genId()
    const useIsolated = isolated ?? this.getDefaultIsolated()
    const partition = useIsolated ? `persist:${ISOLATED_PARTITION_PREFIX}${id}` : SHARED_PARTITION
    const ses = session.fromPartition(partition)
    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false
        // 页面视图永不挂 preload：这个 WebContents 会继续导航到任意站点，
        // 任何注入的桥都会随导航泄漏给网页脚本。接入/设置等特权 UI 只在外壳 chrome 视图。
      }
    })
    const wc = view.webContents
    const net = new NetworkCapture(wc)
    const ready = Promise.resolve().then(() => this.prepareTab(wc, net, id))
    const tab: Tab = {
      id,
      partition,
      session: ses,
      view,
      isolated: useIsolated,
      title: '新建标签页',
      url: target,
      loading: false,
      consoleBuf: [],
      net,
      ready,
      initialNavigation: ready.then(() => this.loadPage(wc, target))
    }
    this.attachEvents(tab)
    this.tabs.push(tab)
    if (activate) this.activeId = tab.id
    this.onSession?.(ses)
    void tab.initialNavigation.catch((error: unknown) => {
      if (!wc.isDestroyed() && this.tabs.includes(tab)) {
        console.warn(`[aa-browser] 标签 ${id} 页面导航未完成 (${error instanceof Error ? error.name : '未知错误'})`)
      }
    })
    this.onChange()
    return tab
  }

  private async prepareTab(wc: WebContents, net: NetworkCapture, id: string): Promise<void> {
    // 注意安装顺序：新建的 WebContents 还没有渲染上下文，
    // 此时 Page.enable / Page.addScriptToEvaluateOnNewDocument 会永久挂起
    // （不 resolve 也不 reject，实测 >15s）。必须先加载 about:blank 建好上下文，
    // 再装守卫——守卫对之后的首屏导航依然生效，因为注入的是"新文档"脚本。
    if (wc.isDestroyed()) return
    try {
      await withTimeout(wc.loadURL('about:blank'), 3000, 'about:blank 初始化')
    } catch (error) {
      console.warn(`[aa-browser] 标签 ${id} 空白上下文初始化失败: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (wc.isDestroyed()) return
    try {
      await withTimeout(installDialogGuard(wc), 2500, '页面对话框守卫初始化')
    } catch (error) {
      console.warn(`[aa-browser] 标签 ${id} 对话框守卫未就绪: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (wc.isDestroyed()) return
    // 抓包和对话框守卫共用 CDP，按顺序启用后再开始首个页面导航。
    try {
      await withTimeout(net.ensure(), 3000, 'Network.enable 初始化')
    } catch (error) {
      console.warn(`[aa-browser] 标签 ${id} 抓包初始化失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private loadPage(wc: WebContents, url: string): Promise<void> {
    if (wc.isDestroyed()) throw new Error('页面已关闭')
    this.assertUrlAllowed(url)
    return withTimeout(wc.loadURL(url), NAVIGATION_TIMEOUT_MS, '目标页面导航')
  }

  async navigate(tab: Tab, url: string, capture = false): Promise<void> {
    await tab.ready
    const wc = tab.view.webContents
    if (capture && !wc.isDestroyed()) {
      await withTimeout(tab.net.ensure(), 3000, 'Network.enable').catch(() => {})
    }
    await this.loadPage(wc, url)
  }

  get canReopenClosed(): boolean {
    return this.recentlyClosed.some((url) => this.isUrlAllowed(url))
  }

  reopenClosed(): Tab | null {
    while (this.recentlyClosed.length) {
      const url = this.recentlyClosed.pop()!
      if (this.isUrlAllowed(url)) return this.createTab(url, true, false)
    }
    return null
  }

  closeTab(id: string, remember = true): void {
    const idx = this.tabs.findIndex((t) => t.id === id)
    if (idx === -1) return
    const [tab] = this.tabs.splice(idx, 1)
    if (remember && !tab.isolated && tab.url !== this.newtabUrl && /^(https?|file):/i.test(tab.url)) {
      this.recentlyClosed.push(tab.url)
      if (this.recentlyClosed.length > 20) this.recentlyClosed.shift()
    }
    // 标签已关闭，无须保留对话框守卫；先释放 CDP 再关闭页面，避免退出时悬挂命令。
    tab.net.releaseDebugger()
    // 先摘下视图再销毁：否则关闭的视图会一直挂在窗口上（资源泄漏 + 文件句柄不释放）
    try {
      this.onViewDetach?.(tab.view)
    } catch {
      /* 窗口可能已销毁 */
    }
    try {
      tab.view.webContents.close()
    } catch {
      /* 已销毁 */
    }
    if (this.activeId === id) {
      this.activeId = this.tabs.length ? this.tabs[Math.min(idx, this.tabs.length - 1)].id : null
    }
    // 隔离分区是一次性的：关闭标签后连同 Cookie/Storage/缓存一起清掉，
    // 否则每个隔离标签都会在 Partitions/ 下留一个永久目录。
    if (tab.isolated) this.onIsolatedClosed?.(tab.partition)
    this.onChange()
  }

  /** 该分区是否仍被其他标签使用（清理前确认） */
  private partitionInUse(partition: string): boolean {
    return this.tabs.some((t) => t.partition === partition)
  }

  selectTab(id: string): void {
    if (this.get(id)) {
      this.activeId = id
      this.onChange()
    }
  }

  closeAll(): void {
    for (const t of [...this.tabs]) this.closeTab(t.id, false)
  }

  private attachEvents(tab: Tab): void {
    const wc = tab.view.webContents

    wc.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
      if (isMainFrame && errorCode !== -3) console.warn(`[aa-browser] 标签 ${tab.id} 主文档加载失败 (${errorCode}): ${errorDescription}`)
    })

    wc.on('did-start-loading', () => {
      tab.loading = true
      this.onChange()
    })
    wc.on('did-stop-loading', () => {
      tab.loading = false
      tab.url = wc.getURL() || tab.url
      // 只移除用于初始化渲染上下文的历史项，保留真实页面的前进和后退记录。
      const history = wc.navigationHistory
      if (history.getActiveIndex() > 0 && history.getEntryAtIndex(0)?.url === 'about:blank') {
        history.removeEntryAtIndex(0)
      }
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
      if (!tab.isolated) this.onNavigate?.(url, tab.title)
    })
    wc.on('did-navigate-in-page', (_e, url, isMainFrame) => {
      if (!isMainFrame) return
      if (url) tab.url = url
      this.onChange()
      if (!tab.isolated) this.onNavigate?.(url, tab.title)
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

    wc.on('will-navigate', (event, url) => {
      if (!this.isUrlAllowed(url)) event.preventDefault()
    })
    wc.on('will-redirect', (event, url) => {
      if (!this.isUrlAllowed(url)) event.preventDefault()
    })

    // target=_blank / window.open → 在本浏览器新开标签
    wc.setWindowOpenHandler(({ url }) => {
      if (url && this.isUrlAllowed(url)) {
        try {
          this.createTab(url, true, tab.isolated)
        } catch {
          /* 白名单拒绝 */
        }
      }
      return { action: 'deny' }
    })

    // 页面右键菜单由主进程注册（需访问窗口 owner），见 index.ts 的 installPageContextMenu
    this.onContextMenu?.(wc)
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
      isolated: t.isolated,
      canBack: this.canBack(t),
      canForward: this.canForward(t)
    }))
  }

  /**
   * 跨会话恢复所需的普通网页标签（保持标签顺序，跳过隔离标签和内部页）。
   * 只收集 http(s) 地址；同一地址只保留一次，活动标签序号按过滤后的列表计算。
   */
  sessionTabs(): { tabs: { url: string; title: string }[]; activeIndex: number } {
    const restorable = this.tabs.filter((tab) => !tab.isolated && /^https?:\/\//i.test(tab.url))
    const seen = new Set<string>()
    const tabs: { url: string; title: string }[] = []
    let activeIndex = 0
    for (const tab of restorable) {
      if (seen.has(tab.url)) continue
      seen.add(tab.url)
      if (tab.id === this.activeId) activeIndex = tabs.length
      tabs.push({ url: tab.url, title: tab.title })
    }
    return { tabs, activeIndex }
  }
}
