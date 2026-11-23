import { WebContentsView, WebContents, session } from 'electron'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { Session } from 'electron'
import type { TabInfo, TabRecoveryInfo } from '@shared/types'
import { NetworkCapture } from './network'
import { installDialogGuard } from './dialogs'
import { installClosedShadowCapture } from './closed-shadow'

export interface Tab {
  id: string
  /** 创建时间（用于 MCP 结果里的标签溯源） */
  createdAt: number
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
  /** 仅主窗口在前台且此页可见时，才走窗口输入管线。 */
  canUseWindowInput: () => boolean
  /** 主窗口当前是否最小化；截图收尾据此决定恢复还是清除虚拟视口。 */
  isWindowMinimized?: () => boolean
  /**
   * 该页面视图当前是否挂在窗口上。
   * 后台标签（其他 MCP 客户端的标签、未切换到的标签）不在窗口里，
   * capturePage 会一直等不到帧，截图必须改走 CDP。最小化但已挂载的页面
   * 仍可经 capturePage 得到画面（由 stayHidden 驱动合成），因此不算在内。
   */
  isComposited?: () => boolean
  /** 调用期间保持计时器与合成帧，不改变闲置网页的节能策略。 */
  keepRendering: () => () => void
  /** 由监控中心接收 Agent 的输入位置，供实时预览显示，不参与定位。 */
  recordPointer?: (pointer: { kind: 'move' | 'click' | 'input'; x?: number; y?: number }) => void
  /** 是否使用独立会话分区（隔离标签） */
  isolated: boolean
  /** 是否由跨会话恢复重建（沿用上次的标签 id） */
  restored: boolean
  /** MCP 客户端连接所有者；进程重启后不恢复该标记。 */
  agentClientId?: number
  recovery: TabRecoveryInfo
  recoveryTimer?: ReturnType<typeof setTimeout>
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
  if (parsed.username || parsed.password || parsed.hash || parsed.search) return false
  if (parsed.port && parsed.port !== (url.port || defaultPort(url.protocol))) return false
  if (!hostMatches(url.hostname, parsed.hostname)) return false
  if (parsed.protocol !== url.protocol) return false
  // 支持路径前缀规则（example.com/admin）：旧实现直接拒绝非根路径，
  // 导致规则静默失效或整站被误封。比较时忽略大小写与末尾斜杠差异。
  const rulePath = parsed.pathname.replace(/\/+$/, '')
  if (!rulePath) return true
  const targetPath = url.pathname.replace(/\/+$/, '')
  return targetPath === rulePath || targetPath.startsWith(`${rulePath}/`)
}

export function isUrlAllowed(url: string, rules: string[], newtabUrl: string): boolean {
  if (url === newtabUrl) return true
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  // Only exact first-party internal URLs are admitted above; every other
  // chrome:/file:/data:/devtools: address stays blocked, even with no allowlist.
  // Only regular web pages are eligible for navigation. In particular, an
  // empty allowlist must not turn file:, data:, devtools:, or other internal
  // schemes into an implicit allow rule.
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (!rules.length) return true
  return rules.some((rule) => siteRuleMatches(parsed, rule))
}

let idSeq = 0
const genId = (): string => `t${Date.now().toString(36)}${(idSeq++).toString(36)}`
const NAVIGATION_TIMEOUT_MS = 20_000
const MAX_RECOVERY_ATTEMPTS = 2
const RECOVERY_TIMEOUT_MS = 15_000

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string, onTimeout?: () => void): Promise<T> {
  let timeout: ReturnType<typeof setTimeout> | undefined
  // 超时后 Promise.race 不再消费原始 promise；若它随后才拒绝（例如页面已关闭导致
  // target closed），会变成进程级未处理拒绝并让测试进程以退出码 1 结束。
  // 预先挂一个空处理器，只用于吞掉迟到拒绝，不改变 race 的返回值/超时语义。
  void promise.catch(() => {})
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => {
          onTimeout?.()
          reject(new Error(`${label} 超时（${timeoutMs}ms）`))
        }, timeoutMs)
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
  private renderUsers = new WeakMap<WebContents, number>()
  private agentClientContext = new AsyncLocalStorage<number>()
  private agentActiveTabs = new Map<number, string>()
  private primaryAgentClientId: number | undefined

  private syncRendering(wc: WebContents): void {
    if (!wc.isDestroyed()) wc.setBackgroundThrottling(!this.renderUsers.get(wc))
  }

  onChange: () => void = () => {}
  onRecovery: ((tab: Tab) => void) | null = null
  /** 由主进程注入：为页面 WebContents 注册右键菜单（需访问 owner window） */
  onContextMenu: ((wc: WebContents) => void) | null = null
  /** 由主进程注入：页面完成导航时记录历史（url, title） */
  onNavigate: ((url: string, title: string) => void) | null = null
  /** 由主进程注入：为每个分区安装下载监听 */
  onSession: ((ses: Session) => void) | null = null
  isWindowForeground: () => boolean = () => false
  isWindowMinimized: () => boolean = () => false
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
  /** visible 模式保留传统标签切换；后台模式不更改用户当前视图。 */
  shouldShowAgentTab: () => boolean = () => true
  /** 由主进程注入：内部页加载完成后同步当前主题 */
  applyInternalTheme: ((wc: WebContents) => void) | null = null
  /** 由主进程注入：判断页面视图是否已挂到窗口（参与合成）。 */
  isViewAttached: ((view: WebContentsView) => boolean) | null = null
  /** 由主进程注入：隔离标签关闭时回调（用于清理分区数据） */
  onIsolatedClosed: ((partition: string) => void) | null = null
  /** 由监控中心接收后台输入位置。 */
  onAgentPointer: ((tab: Tab, pointer: { kind: 'move' | 'click' | 'input'; x?: number; y?: number }) => void) | null = null

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

  runAsAgent<T>(clientId: number, operation: () => Promise<T>): Promise<T> {
    if (this.primaryAgentClientId === undefined) this.primaryAgentClientId = clientId
    return this.agentClientContext.run(clientId, operation)
  }

  currentAgentClientId(): number | undefined {
    return this.agentClientContext.getStore()
  }

  runAsUi<T>(operation: () => T): T {
    return this.agentClientContext.exit(operation)
  }

  private claimIfUnowned(tab: Tab): void {
    const clientId = this.agentClientContext.getStore()
    if (clientId !== undefined && tab.agentClientId === undefined) tab.agentClientId = clientId
  }

  private syncVisiblePrimaryTab(tab: Tab): void {
    const clientId = this.primaryAgentClientId
    if (clientId === undefined || !this.shouldShowAgentTab() ||
      (tab.agentClientId !== undefined && tab.agentClientId !== clientId)) return
    this.agentActiveTabs.set(clientId, tab.id)
  }

  private visibleToCurrentAgent(tab: Tab): boolean {
    const clientId = this.agentClientContext.getStore()
    return clientId === undefined || tab.agentClientId === clientId ||
      (clientId === this.primaryAgentClientId && tab.agentClientId === undefined)
  }

  active(): Tab | null {
    const clientId = this.agentClientContext.getStore()
    if (clientId === undefined) return this.tabs.find((t) => t.id === this.activeId) ?? null
    const scopedId = this.agentActiveTabs.get(clientId)
    const scoped = scopedId ? this.tabs.find((tab) => tab.id === scopedId &&
      (tab.agentClientId === clientId || (clientId === this.primaryAgentClientId && tab.agentClientId === undefined))) : undefined
    if (scoped) {
      this.claimIfUnowned(scoped)
      return scoped
    }
    const owned = this.tabs.find((tab) => tab.agentClientId === clientId)
    if (owned) {
      this.agentActiveTabs.set(clientId, owned.id)
      return owned
    }
    if (clientId !== this.primaryAgentClientId) return null
    const current = this.tabs.find((tab) => tab.id === this.activeId && tab.agentClientId === undefined)
    if (!current) return null
    this.claimIfUnowned(current)
    this.agentActiveTabs.set(clientId, current.id)
    return current
  }

  activeForUi(): Tab | null {
    return this.agentClientContext.exit(() => this.active())
  }

  get(id: string): Tab | null {
    const tab = this.tabs.find((entry) => entry.id === id) ?? null
    if (!tab) return null
    const clientId = this.agentClientContext.getStore()
    if (clientId !== undefined && tab.agentClientId !== clientId) {
      if (tab.agentClientId !== undefined || clientId !== this.primaryAgentClientId) return null
      this.agentActiveTabs.set(clientId, tab.id)
    }
    if (!this.visibleToCurrentAgent(tab)) return null
    this.claimIfUnowned(tab)
    return tab
  }

  /**
   * 新建标签。
   * @param isolated 使用独立会话分区（不共享登录态），关闭时自动清理。
   *                 省略时取设置里的「默认隔离」开关。
   * @param restoreId 会话恢复时沿用上次的标签 id，让 Agent 缓存的 tabId 继续有效。
   *                  只接受 genId 形状且当前未被占用。
   */
  createTab(url?: string, activate = true, isolated?: boolean, deferInitialNavigation = false, restoreId?: string): Tab {
    const target = url || this.newtabUrl
    this.assertUrlAllowed(target)
    const reusable = restoreId !== undefined && /^t[a-z0-9]{1,32}$/.test(restoreId) && !this.get(restoreId)
    const id = reusable ? restoreId : genId()
    const useIsolated = isolated ?? this.getDefaultIsolated()
    const partition = useIsolated ? `persist:${ISOLATED_PARTITION_PREFIX}${id}` : SHARED_PARTITION
    const ses = session.fromPartition(partition)
    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: true,
        spellcheck: false
        // 页面视图永不挂 preload：这个 WebContents 会继续导航到任意站点，
        // 任何注入的桥都会随导航泄漏给网页脚本。接入/设置等特权 UI 只在外壳 chrome 视图。
      }
    })
    const wc = view.webContents
    const keepRendering = (): (() => void) => {
      this.renderUsers.set(wc, (this.renderUsers.get(wc) ?? 0) + 1)
      this.syncRendering(wc)
      let released = false
      return () => {
        if (released) return
        released = true
        this.renderUsers.set(wc, Math.max(0, (this.renderUsers.get(wc) ?? 1) - 1))
        this.syncRendering(wc)
      }
    }
    const net = new NetworkCapture(wc)
    const ready = Promise.resolve().then(() => this.prepareTab(wc, net, id))
    const tab: Tab = {
      id,
      createdAt: Date.now(),
      partition,
      session: ses,
      view,
      isolated: useIsolated,
      restored: reusable,
      agentClientId: this.agentClientContext.getStore(),
      title: '新建标签页',
      url: target,
      loading: false,
      consoleBuf: [],
      net,
      ready,
      // MCP 导航可先发布 Tab 再在 tab 锁内显式 navigate；其它创建入口保持既有自动首载。
      initialNavigation: deferInitialNavigation ? ready : ready.then(() => this.loadPage(wc, target)),
      canUseWindowInput: () => this.activeId === id && this.isWindowForeground(),
      isWindowMinimized: () => this.isWindowMinimized(),
      isComposited: () => this.isViewAttached?.(view) ?? false,
      keepRendering,
      recordPointer: (pointer) => this.onAgentPointer?.(tab, pointer),
      recovery: { status: 'healthy', attempts: 0 }
    }
    this.attachEvents(tab)
    this.tabs.push(tab)
    if (activate) {
      const clientId = this.agentClientContext.getStore()
      if (clientId === undefined) {
        this.activeId = tab.id
        this.syncVisiblePrimaryTab(tab)
      }
      else {
        this.agentActiveTabs.set(clientId, tab.id)
        // 只有主 Agent 客户端可以接管窗口里显示的标签。次级客户端的标签留在后台执行，
        // 否则两个客户端会互相把对方的视图从窗口摘下——被摘下的视图不再被桌面合成器
        // 绘制，截图与可视化都会失去画面。
        if (this.shouldShowAgentTab() && clientId === this.primaryAgentClientId) this.activeId = tab.id
      }
    }
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
      const message = error instanceof Error ? error.message : String(error)
      const expectedBlankCancellation = message.includes('ERR_FAILED (-2)') && message.includes("about:blank")
      if (!expectedBlankCancellation) console.warn(`[aa-browser] 标签 ${id} 空白上下文初始化失败: ${message}`)
    }
    if (wc.isDestroyed()) return
    try {
      await withTimeout(installDialogGuard(wc), 2500, '页面对话框守卫初始化')
    } catch (error) {
      console.warn(`[aa-browser] 标签 ${id} 对话框守卫未就绪: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (wc.isDestroyed()) return
    try {
      await withTimeout(installClosedShadowCapture(wc), 2500, 'closed shadow 捕获初始化')
    } catch (error) {
      console.warn(`[aa-browser] 标签 ${id} closed shadow 捕获未就绪: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (wc.isDestroyed()) return
    // 内部页每次加载完成都同步一次主题（含导航返回新标签页的场景）。
    // 回调由主进程提供，并自行判断当前 URL 是否内部页，绝不接触外部网页 DOM。
    wc.on('dom-ready', () => {
      if (wc.isDestroyed()) return
      try { this.applyInternalTheme?.(wc) } catch { /* 主题同步失败不应影响页面 */ }
    })
    // 抓包和对话框守卫共用 CDP，按顺序启用后再开始首个页面导航。
    try {
      await withTimeout(net.ensure(), 3000, 'Network.enable 初始化')
    } catch (error) {
      console.warn(`[aa-browser] 标签 ${id} 抓包初始化失败: ${error instanceof Error ? error.message : String(error)}`)
    }
    // 打开 DevTools 会抢占调试通道并 detach，对话框守卫、closed-shadow 捕获和抓包
    // 都随调试会话一起失效（守卫尤其危险：后续页面的 alert() 会让 Agent 永久卡死）。
    // 关闭 DevTools 后按同样顺序重新安装，恢复到打开前的状态。
    wc.on('devtools-closed', () => {
      if (wc.isDestroyed()) return
      void (async () => {
        try {
          await withTimeout(installDialogGuard(wc), 2500, '页面对话框守卫恢复')
          if (wc.isDestroyed()) return
          await withTimeout(installClosedShadowCapture(wc), 2500, 'closed shadow 捕获恢复')
          if (wc.isDestroyed()) return
          await withTimeout(net.ensure(), 3000, 'Network.enable 恢复')
          if (net.mockEnabled) await net.ensureMockInterception()
        } catch (error) {
          console.warn(`[aa-browser] 标签 ${id} DevTools 关闭后恢复页面守卫失败: ${error instanceof Error ? error.message : String(error)}`)
        }
      })()
    })
  }

  private async loadPage(wc: WebContents, url: string): Promise<void> {
    if (wc.isDestroyed()) throw new Error('页面已关闭')
    this.assertUrlAllowed(url)
    const loading = wc.loadURL(url)
    let timedOut = false
    try {
      await withTimeout(loading, NAVIGATION_TIMEOUT_MS, '目标页面导航', () => { timedOut = true })
    } catch (error) {
      // 超时包装结束不等于 Chromium 已停止；交还标签队列前等原始加载终结。
      // 其他失败可能来自手动发起的替代导航，不能停止那次新导航。
      if (timedOut) {
        try { if (!wc.isDestroyed()) wc.stop() } catch { /* 页面可能同时关闭 */ }
      }
      await loading.catch(() => {})
      throw error
    }
  }

  async navigate(tab: Tab, url: string, capture = false, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new Error('工具调用已被用户中断。')
    await tab.ready
    if (signal?.aborted) throw new Error('工具调用已被用户中断。')
    const wc = tab.view.webContents
    if (wc.isDestroyed()) throw new Error('页面已关闭')
    if (capture) {
      await withTimeout(tab.net.ensure(), 3000, 'Network.enable').catch(() => {})
      if (signal?.aborted) throw new Error('工具调用已被用户中断。')
      if (wc.isDestroyed()) throw new Error('页面已关闭')
    }
    // 等 ready / Network.enable 期间 signal 可能变化；必须在 loadURL 之前再检查。
    if (signal?.aborted) throw new Error('工具调用已被用户中断。')
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
    if (!this.visibleToCurrentAgent(tab)) {
      this.tabs.splice(idx, 0, tab)
      return
    }
    this.clearRecoveryTimer(tab)
    if (remember && !tab.isolated && tab.url !== this.newtabUrl && /^(https?|file):/i.test(tab.url)) {
      this.recentlyClosed.push(tab.url)
      if (this.recentlyClosed.length > 20) this.recentlyClosed.shift()
    }
    // 标签已关闭，无须保留对话框守卫；先释放 CDP 再关闭页面，避免退出时悬挂命令。
    tab.net.releaseDebugger()
    // 关闭页面前释放该视图的渲染计数，避免 WeakMap 条目随 WebContents 生命周期悬挂，
    // 也让后台节流策略不再把一个已销毁页面当作活跃租约。
    this.renderUsers.delete(tab.view.webContents)
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
    for (const [clientId, activeId] of this.agentActiveTabs) {
      if (activeId !== id) continue
      const visibleReplacement = clientId === this.primaryAgentClientId && this.shouldShowAgentTab()
        ? this.tabs.find((entry) => entry.id === this.activeId &&
          (entry.agentClientId === undefined || entry.agentClientId === clientId))
        : undefined
      const replacement = visibleReplacement ?? this.tabs.find((entry) => entry.agentClientId === clientId)
      if (replacement) this.agentActiveTabs.set(clientId, replacement.id)
      else this.agentActiveTabs.delete(clientId)
    }
    // 用户关闭最后一个标签时保留一个可输入的新标签页，而不是留下空窗口；
    // closeAll() 传 remember=false，退出时不会反向创建标签。
    if (remember && this.tabs.length === 0) {
      this.createTab(this.newtabUrl, true, false)
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

  selectTab(id: string, bringToFront = false): void {
    const tab = this.get(id)
    if (!tab) return
    const clientId = this.agentClientContext.getStore()
    if (clientId !== undefined) {
      this.agentActiveTabs.set(clientId, id)
      if (!bringToFront && !this.shouldShowAgentTab()) {
        this.onChange()
        return
      }
      // 只有主客户端的“切换”才改变窗口里显示的标签；次级客户端的切换只影响
      // 自己的标签视图，否则会把主标签摘下窗口、导致其不再被合成。
      if (clientId !== this.primaryAgentClientId) {
        this.onChange()
        return
      }
    }
    this.activeId = id
    if (clientId === undefined) this.syncVisiblePrimaryTab(tab)
    this.onChange()
  }

  closeAll(): void {
    for (const t of [...this.tabs]) this.closeTab(t.id, false)
  }

  private notifyRecovery(tab: Tab): void {
    this.onRecovery?.(tab)
    this.onChange()
  }

  private clearRecoveryTimer(tab: Tab): void {
    if (!tab.recoveryTimer) return
    clearTimeout(tab.recoveryTimer)
    tab.recoveryTimer = undefined
  }

  private markRecovered(tab: Tab): void {
    if (tab.recovery.status !== 'recovering') return
    this.clearRecoveryTimer(tab)
    tab.recovery = { ...tab.recovery, status: 'recovered', recoveredAt: Date.now(), error: undefined }
    this.notifyRecovery(tab)
  }

  private recoverTab(tab: Tab, reason: 'crash' | 'unresponsive'): void {
    const wc = tab.view.webContents
    if (tab.recovery.status === 'recovering' || tab.recovery.status === 'failed') return
    if (tab.recovery.attempts >= MAX_RECOVERY_ATTEMPTS || wc.isDestroyed()) {
      this.clearRecoveryTimer(tab)
      tab.recovery = {
        ...tab.recovery,
        status: 'failed',
        reason,
        error: wc.isDestroyed() ? '渲染进程已销毁，无法恢复' : '已达到最大自动恢复次数'
      }
      this.notifyRecovery(tab)
      return
    }
    tab.recovery = { status: 'recovering', attempts: tab.recovery.attempts + 1, reason, lastAttemptAt: Date.now() }
    this.clearRecoveryTimer(tab)
    tab.recoveryTimer = setTimeout(() => {
      tab.recoveryTimer = undefined
      if (tab.recovery.status !== 'recovering') return
      tab.recovery = { ...tab.recovery, status: 'failed', error: '页面恢复超时' }
      this.notifyRecovery(tab)
    }, RECOVERY_TIMEOUT_MS)
    tab.recoveryTimer.unref?.()
    this.notifyRecovery(tab)
    try {
      wc.reload()
    } catch (error) {
      this.clearRecoveryTimer(tab)
      tab.recovery = { ...tab.recovery, status: 'failed', error: error instanceof Error ? error.message : String(error) }
      this.notifyRecovery(tab)
    }
  }

  private attachEvents(tab: Tab): void {
    const wc = tab.view.webContents

    wc.on('input-event', (_event, input) => {
      if (input.type === 'mouseMove' || input.type === 'mouseDown') {
        const pointer = input as Electron.MouseInputEvent
        tab.recordPointer?.({ kind: input.type === 'mouseMove' ? 'move' : 'click', x: pointer.x, y: pointer.y })
      }
    })

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
      this.markRecovered(tab)
      this.onChange()
    })
    wc.on('responsive', () => this.markRecovered(tab))
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
      // 崩溃的渲染进程不再持有任何租约；立即清空计数，避免 keepRendering 永久阻止
      // 后续标签恢复 backgroundThrottling，并让监控/视觉工具下次重新持有。
      this.renderUsers.delete(wc)
      this.syncRendering(wc)
      this.recoverTab(tab, 'crash')
      this.onChange()
    })
    wc.on('unresponsive', () => {
      this.recoverTab(tab, 'unresponsive')
    })
    wc.on('console-message', (event) => {
      const msg = readConsoleMessage([event])
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

  /** 遍历所有标签视图（供主进程向内部页广播主题等设置） */
  forEachWebView(fn: (wc: WebContents) => void): void {
    for (const tab of [...this.tabs]) {
      if (!tab.view.webContents.isDestroyed()) fn(tab.view.webContents)
    }
  }

  infos(): TabInfo[] {
    const clientId = this.agentClientContext.getStore()
    if (clientId !== undefined && !this.tabs.some((tab) => tab.agentClientId === clientId)) this.active()
    const scopedActiveId = clientId === undefined ? this.activeId : this.agentActiveTabs.get(clientId) ?? null
    return this.tabs.filter((tab) => this.visibleToCurrentAgent(tab)).map((t) => ({
      id: t.id,
      createdAt: t.createdAt,
      title: t.title,
      url: t.url,
      favicon: t.favicon,
      loading: t.loading,
      active: t.id === scopedActiveId,
      isolated: t.isolated,
      restored: t.restored,
      agentClientId: t.agentClientId,
      recovery: { ...t.recovery },
      canBack: this.canBack(t),
      canForward: this.canForward(t)
    }))
  }

  infosForUi(): TabInfo[] {
    return this.agentClientContext.exit(() => this.infos())
  }

  /**
   * 释放已离线 MCP 客户端留下的标签归属。
   *
   * 桥重连会沿用同一 client id，因此释放动作由主进程延迟到重连宽限期之后；
   * 这里只清标记，不关闭标签，也不动 Cookie/Storage。
   */
  releaseAgentClient(clientId: number): void {
    this.agentActiveTabs.delete(clientId)
    if (this.primaryAgentClientId === clientId) this.primaryAgentClientId = undefined
    for (const tab of this.tabs) {
      if (tab.agentClientId === clientId) tab.agentClientId = undefined
    }
    this.onChange()
  }

  /**
   * 跨会话恢复所需的普通网页标签（保持标签顺序，跳过隔离标签和内部页）。
   * 只收集 http(s) 地址；同一地址只保留一次，活动标签序号按过滤后的列表计算。
   */
  sessionTabs(): { tabs: { url: string; title: string; id: string }[]; activeIndex: number } {
    const restorable = this.tabs.filter((tab) => !tab.isolated && /^https?:\/\//i.test(tab.url))
    const seen = new Set<string>()
    const tabs: { url: string; title: string; id: string }[] = []
    let activeIndex = 0
    for (const tab of restorable) {
      if (seen.has(tab.url)) continue
      seen.add(tab.url)
      if (tab.id === this.activeId) activeIndex = tabs.length
      tabs.push({ url: tab.url, title: tab.title, id: tab.id })
    }
    return { tabs, activeIndex }
  }
}
