import type { TabInfo, UiState, DownloadInfo, HistoryEntry, AppSettings, SettingsView, AgentInfo, UpdateState } from '@shared/types'

/** 与主进程 clients.ts 的 ClientDetectResult / ClientSetupResult 对应 */
interface ClientDetectResult {
  id: string
  name: string
  file: string
  installed: boolean
  configured: boolean
  outdated: boolean
}
interface ClientSetupResult {
  id: string
  name: string
  status: 'added' | 'updated' | 'skipped' | 'manual' | 'error'
  message: string
}

declare global {
  interface Window {
    aa: {
      getState: () => Promise<UiState>
      tabNew: (url?: string) => Promise<void>
      tabClose: (id: string) => Promise<void>
      tabSelect: (id: string) => Promise<void>
      back: () => Promise<void>
      forward: () => Promise<void>
      reload: () => Promise<void>
      submit: (value: string) => Promise<void>
      devtools: () => Promise<void>
      decideApproval: (id: string, allowed: boolean) => Promise<boolean>
      interruptAgent: () => Promise<boolean>
      resumeAgent: () => Promise<boolean>
      downloadsList: () => Promise<DownloadInfo[]>
      downloadOpen: (id: string) => Promise<void>
      downloadShow: (id: string) => Promise<void>
      downloadDir: () => Promise<string>
      historySuggest: (query: string, limit?: number) => Promise<HistoryEntry[]>
      settingsGet: () => Promise<SettingsView | null>
      settingsSet: (patch: Partial<AppSettings>) => Promise<AppSettings | null>
      agentInfo: () => Promise<AgentInfo | null>
      clientsDetect: () => Promise<ClientDetectResult[]>
      clientsSetup: (ids: string[]) => Promise<ClientSetupResult[]>
      updateCheck: () => Promise<UpdateState>
      updateDownload: () => Promise<UpdateState>
      updateInstall: () => Promise<boolean>
      onState: (cb: (state: UiState) => void) => void
      onFocusOmnibox: (cb: () => void) => void
    }
  }
}

let state: UiState = { tabs: [], activeId: null, agentCount: 0, bridgeState: 'waiting', connectionMessage: '等待 MCP 桥启动并连接', pendingApprovals: [], agentInterrupted: false }

const tabsEl = document.getElementById('tabs') as HTMLDivElement
const omnibox = document.getElementById('omnibox') as HTMLInputElement
const agentPill = document.getElementById('agent-pill') as HTMLDivElement
const btnBack = document.getElementById('btn-back') as HTMLButtonElement
const btnForward = document.getElementById('btn-forward') as HTMLButtonElement
const btnReload = document.getElementById('btn-reload') as HTMLButtonElement
const agentStop = document.getElementById('agent-stop') as HTMLButtonElement
const approvalPanel = document.getElementById('approval-panel') as HTMLDivElement
const btnFeed = document.getElementById('btn-feed') as HTMLButtonElement | null
const feedDrawer = document.getElementById('action-feed-drawer') as HTMLDivElement | null
const feedList = document.getElementById('action-feed-list') as HTMLDivElement | null
const btnCloseFeed = document.getElementById('btn-close-feed') as HTMLButtonElement | null
const btnDownloads = document.getElementById('btn-downloads') as HTMLButtonElement | null
const dlPanel = document.getElementById('download-panel') as HTMLDivElement | null
const dlList = document.getElementById('download-list') as HTMLDivElement | null
const suggestPanel = document.getElementById('suggest-panel') as HTMLDivElement | null
const suggestList = document.getElementById('suggest-list') as HTMLDivElement | null
const btnSettings = document.getElementById('btn-settings') as HTMLButtonElement | null
const settingsModal = document.getElementById('settings-modal') as HTMLDivElement | null
const setEngine = document.getElementById('set-engine') as HTMLSelectElement | null
const setEngineUrl = document.getElementById('set-engine-url') as HTMLInputElement | null
const setFullSnapshot = document.getElementById('set-full-snapshot') as HTMLInputElement | null
const setOpApproval = document.getElementById('set-op-approval') as HTMLInputElement | null
const setIsolatedSessions = document.getElementById('set-isolated-sessions') as HTMLInputElement | null
const setDownloadDir = document.getElementById('set-download-dir') as HTMLInputElement | null
const setAllowedSites = document.getElementById('set-allowed-sites') as HTMLTextAreaElement | null
const setAgentInfo = document.getElementById('set-agent-info') as HTMLDivElement | null
const settingsStatus = document.getElementById('settings-status') as HTMLSpanElement | null
const setClientList = document.getElementById('set-client-list') as HTMLDivElement | null
const btnClientScan = document.getElementById('btn-client-scan') as HTMLButtonElement | null
const btnClientSetup = document.getElementById('btn-client-setup') as HTMLButtonElement | null
const setClientResult = document.getElementById('set-client-result') as HTMLDivElement | null
const setAutoUpdate = document.getElementById('set-auto-update') as HTMLInputElement | null
const setUpdateChannel = document.getElementById('set-update-channel') as HTMLSelectElement | null
const updateStatus = document.getElementById('update-status') as HTMLDivElement | null
const btnUpdateCheck = document.getElementById('btn-update-check') as HTMLButtonElement | null
const btnUpdateAction = document.getElementById('btn-update-action') as HTMLButtonElement | null

function formatUpdateBytes(value?: number): string {
  if (!value || value < 1024) return value ? `${value} B` : '未知大小'
  const units = ['KB', 'MB', 'GB']
  let n = value / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(n >= 10 ? 0 : 1)} ${units[i]}`
}

function renderUpdate(update?: UpdateState): void {
  if (!updateStatus || !update) return
  const labels: Record<UpdateState['status'], string> = {
    disabled: '开发模式不检查更新', idle: `当前版本 ${update.currentVersion}`, checking: '正在检查更新…',
    'up-to-date': `已是最新版本（${update.currentVersion}）`, available: `发现新版本 ${update.version ?? ''}`,
    downloading: `正在下载 ${update.version ?? ''} · ${Math.max(0, Math.round(update.progress ?? 0))}%`,
    downloaded: `已下载 ${update.version ?? ''}，可以重启安装`, error: `更新失败：${update.error ?? '未知错误'}`
  }
  updateStatus.textContent = labels[update.status]
  updateStatus.title = [update.releaseDate ? `发布时间：${update.releaseDate}` : '', update.size ? `大小：${formatUpdateBytes(update.size)}` : '', update.releaseNotes ?? ''].filter(Boolean).join('\n')
  if (btnUpdateCheck) btnUpdateCheck.disabled = update.status === 'checking' || update.status === 'downloading'
  if (btnUpdateAction) {
    btnUpdateAction.hidden = !['available', 'downloaded'].includes(update.status)
    btnUpdateAction.disabled = update.status === 'downloading'
    btnUpdateAction.textContent = update.status === 'downloaded' ? '重启并安装' : '下载更新'
  }
}

function activeTab(): TabInfo | null {
  return state.tabs.find((t) => t.active) ?? null
}

function shortenUrl(u: string): string {
  if (/^file:\/\//i.test(u)) return u.replace(/^file:\/\/\/?/, '本地文件 ')
  try {
    const url = new URL(u)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.host + url.pathname + url.search
    return u
  } catch {
    return u
  }
}

/** 渲染标签条 */
function renderTabs(): void {
  tabsEl.textContent = ''
  for (const t of state.tabs) {
    const el = document.createElement('div')
    el.className = 'tab' + (t.active ? ' active' : '')
    el.title = `${t.title}\n${t.url}${t.isolated ? '\n（隔离会话：不共享登录态）' : ''}`
    el.setAttribute('role', 'tab')
    el.setAttribute('aria-selected', String(t.active))
    el.tabIndex = t.active ? 0 : -1
    el.dataset['tabId'] = t.id

    const fav = document.createElement('div')
    fav.className = 'favicon'
    if (t.loading) {
      const dot = document.createElement('div')
      dot.className = 'dot'
      fav.appendChild(dot)
    } else if (t.favicon && /^https?:|^data:/i.test(t.favicon)) {
      const img = document.createElement('img')
      img.src = t.favicon
      img.onerror = () => {
        img.remove()
        fav.textContent = '•'
        fav.style.color = '#66676e'
      }
      fav.appendChild(img)
    } else {
      fav.textContent = '•'
      fav.style.color = '#66676e'
    }
    el.appendChild(fav)

    const title = document.createElement('span')
    title.className = 'title'
    title.textContent = t.title || '无标题'
    el.appendChild(title)

    // 隔离会话标签带锁标识：用户必须能一眼看出哪些标签不共享登录态
    if (t.isolated) {
      const lock = document.createElement('span')
      lock.className = 'tab-lock'
      lock.textContent = '🔒'
      lock.title = '隔离会话：不共享 Cookie / 登录态，关闭后清除数据'
      lock.setAttribute('aria-label', '隔离会话标签')
      el.appendChild(lock)
      el.classList.add('isolated')
    }

    const close = document.createElement('button')
    close.className = 'close'
    close.title = '关闭标签页 (Ctrl+W)'
    close.setAttribute('aria-label', `关闭标签页：${t.title || '无标题'}`)
    close.textContent = '×'
    close.addEventListener('click', (e) => {
      e.stopPropagation()
      void window.aa.tabClose(t.id)
    })
    el.appendChild(close)

    el.addEventListener('mousedown', (e) => {
      if (e.button === 1) {
        e.preventDefault()
        void window.aa.tabClose(t.id)
      }
    })
    el.addEventListener('click', () => void window.aa.tabSelect(t.id))

    tabsEl.appendChild(el)
  }
}

/** 渲染工具栏状态 */
function renderToolbar(): void {
  const active = activeTab()
  if (active) {
    if (document.activeElement !== omnibox) omnibox.value = shortenUrl(active.url)
    btnBack.disabled = !active.canBack
    btnForward.disabled = !active.canForward
  } else {
    omnibox.value = ''
    btnBack.disabled = true
    btnForward.disabled = true
  }
  agentPill.title = state.connectionMessage
  agentPill.classList.toggle('connected', state.bridgeState === 'connected')
  agentPill.classList.toggle('waiting', state.bridgeState === 'waiting')
  if (state.bridgeState === 'connected') {
    agentPill.textContent = `● 浏览器已连接 ×${state.agentCount}`
  } else if (state.bridgeState === 'waiting') {
    agentPill.textContent = '◌ 等待 AI 桥接'
  } else {
    agentPill.textContent = '○ AI 桥未连接'
  }
  agentStop.textContent = state.agentInterrupted ? '恢复' : '中断'
  agentStop.classList.toggle('active', state.agentInterrupted)
  agentStop.title = state.agentInterrupted ? '恢复 Agent 浏览器操作' : '中断 Agent 的后续浏览器操作'
  renderApprovals()
}

function renderApprovals(): void {
  const pending = state.pendingApprovals ?? []
  approvalPanel.hidden = pending.length === 0
  approvalPanel.textContent = ''
  for (const item of pending) {
    const isOp = item.kind === 'operation'
    const title = document.createElement('div')
    title.className = 'approval-title'
    title.textContent = isOp ? 'Agent 请求执行高危操作' : '需要你亲自填写敏感信息'
    const meta = document.createElement('div')
    meta.className = 'approval-meta'
    meta.textContent = `网站：${item.site} · 标签：${item.tabTitle} · 操作：${item.fieldLabel}`
    const help = document.createElement('div')
    help.className = 'approval-help'
    help.textContent = isOp
      ? (item.detail || 'Agent 即将执行此操作。请确认后点“允许”，拒绝则中止该步骤。')
      : '请直接在网页输入框中填写内容；敏感内容不会由 Agent 写入或回传。填写完成后再点“允许继续”。'
    const actions = document.createElement('div')
    actions.className = 'approval-actions'
    const deny = document.createElement('button')
    deny.className = 'approval-deny'
    deny.textContent = '拒绝'
    deny.addEventListener('click', () => void window.aa.decideApproval(item.id, false))
    const allow = document.createElement('button')
    allow.className = 'approval-allow'
    allow.textContent = isOp ? '允许' : '允许继续'
    allow.addEventListener('click', () => void window.aa.decideApproval(item.id, true))
    actions.append(deny, allow)
    approvalPanel.append(title, meta, help, actions)
  }
}

function renderFeed(): void {
  if (!feedList) return
  const actions = state.recentActions || []
  if (!actions.length) {
    const empty = document.createElement('div')
    empty.className = 'empty-feed'
    empty.textContent = '暂无 Agent 操作记录'
    feedList.replaceChildren(empty)
    return
  }
  const fragment = document.createDocumentFragment()
  for (const item of actions.slice().reverse()) {
    const el = document.createElement('div')
    el.className = 'feed-item' + (item.isError ? ' error' : '')
    const timeStr = new Date(item.ts).toLocaleTimeString()
    const head = document.createElement('div')
    head.className = 'feed-head'
    const tool = document.createElement('span')
    tool.className = 'feed-tool'
    tool.textContent = item.tool
    const time = document.createElement('span')
    time.className = 'feed-time'
    time.textContent = timeStr
    const summary = document.createElement('div')
    summary.className = 'feed-summary'
    summary.textContent = item.summary
    head.append(tool, time)
    el.append(head, summary)
    fragment.appendChild(el)
  }
  feedList.replaceChildren(fragment)
}

function formatBytes(n: number): string {
  if (!n || n <= 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let i = 0
  let v = n
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024
    i++
  }
  return `${v.toFixed(v >= 100 || i === 0 ? 0 : 1)} ${units[i]}`
}

function downloadStateLabel(s: string): string {
  switch (s) {
    case 'progressing': return '下载中'
    case 'completed': return '完成'
    case 'cancelled': return '已取消'
    case 'interrupted': return '已中断'
    default: return s
  }
}

function renderDownloads(): void {
  if (!dlList) return
  const items = state.downloads || []
  const hasActive = items.some((d) => d.state === 'progressing')
  if (btnDownloads) {
    btnDownloads.classList.toggle('has-active', hasActive)
    btnDownloads.title = items.length ? `下载（${items.length}）` : '下载'
  }
  if (!items.length) {
    dlList.innerHTML = '<div class="empty-feed">暂无下载记录</div>'
    return
  }
  dlList.innerHTML = ''
  for (const d of items.slice().reverse()) {
    const el = document.createElement('div')
    el.className = `dl-item ${d.state === 'completed' ? 'done' : ''} ${d.state === 'progressing' ? 'active' : ''}`
    const pct = d.totalBytes > 0 ? Math.round((d.receivedBytes / d.totalBytes) * 100) : 0

    const name = document.createElement('div')
    name.className = 'dl-name'
    name.title = d.url
    name.textContent = d.filename

    const meta = document.createElement('div')
    meta.className = 'dl-meta'
    const st = document.createElement('span')
    st.className = 'dl-state'
    st.textContent = downloadStateLabel(d.state)
    const size = document.createElement('span')
    size.className = 'dl-size'
    size.textContent = formatBytes(d.receivedBytes) + (d.state === 'progressing' && d.totalBytes ? ' / ' + formatBytes(d.totalBytes) : '')
    meta.append(st, size)
    el.appendChild(name)
    el.appendChild(meta)

    if (d.state === 'progressing') {
      const bar = document.createElement('div')
      bar.className = 'dl-bar'
      const fill = document.createElement('div')
      fill.className = 'dl-bar-fill'
      fill.style.width = `${pct}%`
      bar.appendChild(fill)
      el.appendChild(bar)
    }

    const actions = document.createElement('div')
    actions.className = 'dl-actions'
    const open = document.createElement('button')
    open.className = 'dl-act'
    open.textContent = '打开'
    open.addEventListener('click', () => void window.aa.downloadOpen(d.id))
    const show = document.createElement('button')
    show.className = 'dl-act'
    show.textContent = '在文件夹中显示'
    show.addEventListener('click', () => void window.aa.downloadShow(d.id))
    actions.append(open, show)
    el.appendChild(actions)

    dlList.appendChild(el)
  }
}

function hideSuggest(): void {
  if (suggestPanel) suggestPanel.hidden = true
}

function renderSuggest(items: HistoryEntry[]): void {
  if (!suggestPanel || !suggestList) return
  if (!items.length) {
    hideSuggest()
    return
  }
  suggestList.innerHTML = ''
  for (const it of items) {
    const el = document.createElement('div')
    el.className = 'suggest-item'
    el.addEventListener('click', () => {
      void window.aa.submit(it.url)
      hideSuggest()
    })
    const icon = document.createElement('span')
    icon.className = 'suggest-icon'
    icon.textContent = it.count > 3 ? '★' : '•'
    const text = document.createElement('div')
    text.className = 'suggest-text'
    const t = document.createElement('div')
    t.className = 'suggest-title'
    t.textContent = it.title || it.url
    const u = document.createElement('div')
    u.className = 'suggest-url'
    u.textContent = it.url
    text.append(t, u)
    el.append(icon, text)
    suggestList.appendChild(el)
  }
  suggestPanel.hidden = false
}

let suggestTimer: ReturnType<typeof setTimeout> | undefined
function onOmniboxInput(): void {
  const q = omnibox.value.trim()
  if (!q) {
    hideSuggest()
    return
  }
  clearTimeout(suggestTimer)
  suggestTimer = setTimeout(() => {
    void window.aa.historySuggest(q).then((items) => {
      if (document.activeElement === omnibox) renderSuggest(items)
    })
  }, 140)
}

function applyState(next: UiState): void {
  const focusedTabId = (document.activeElement as HTMLElement | null)?.dataset?.['tabId']
  state = next
  renderTabs()
  if (focusedTabId) tabsEl.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(focusedTabId)}"]`)?.focus()
  renderToolbar()
  renderFeed()
  renderDownloads()
  renderUpdate(next.update)
  if (document.activeElement !== omnibox) hideSuggest()
}

/* ── 事件绑定 ─────────────────────── */

btnBack.addEventListener('click', () => void window.aa.back())
btnForward.addEventListener('click', () => void window.aa.forward())
btnReload.addEventListener('click', () => void window.aa.reload())
agentStop.addEventListener('click', () => void (state.agentInterrupted ? window.aa.resumeAgent() : window.aa.interruptAgent()))
document.getElementById('btn-newtab')?.addEventListener('click', () => void window.aa.tabNew())

tabsEl.addEventListener('keydown', (event: KeyboardEvent) => {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  const tabs = Array.from(tabsEl.querySelectorAll<HTMLElement>('[role="tab"]'))
  if (!tabs.length) return
  const current = tabs.indexOf(document.activeElement as HTMLElement)
  const direction = event.key === 'ArrowRight' ? 1 : -1
  const next = tabs[(current + direction + tabs.length) % tabs.length]
  event.preventDefault()
  next.focus()
  const id = next.dataset['tabId']
  if (id) void window.aa.tabSelect(id)
})

btnDownloads?.addEventListener('click', () => {
  if (!dlPanel) return
  dlPanel.hidden = !dlPanel.hidden
  if (feedDrawer) feedDrawer.hidden = true
})
document.getElementById('btn-close-dl')?.addEventListener('click', () => {
  if (dlPanel) dlPanel.hidden = true
})
document.addEventListener('click', (e) => {
  if (!dlPanel || dlPanel.hidden) return
  if (btnDownloads?.contains(e.target as Node) || dlPanel.contains(e.target as Node)) return
  dlPanel.hidden = true
})

btnFeed?.addEventListener('click', () => {
  if (!feedDrawer) return
  feedDrawer.hidden = !feedDrawer.hidden
})
btnCloseFeed?.addEventListener('click', () => {
  if (feedDrawer) feedDrawer.hidden = true
})

/* ── 设置面板：连接 AI 客户端 ─────────────── */
const CLIENT_STATUS_BADGE: Record<ClientSetupResult['status'], string> = {
  added: '✅ 已写入',
  updated: '✅ 已更新',
  skipped: 'ℹ️ 已配置',
  manual: '⚠️ 需手动',
  error: '❌ 失败'
}

function renderClients(clients: ClientDetectResult[]): void {
  if (!setClientList) return
  const installed = clients.filter((c) => c.installed)
  if (!installed.length) {
    const empty = document.createElement('span')
    empty.className = 'settings-hint'
    empty.textContent = '未检测到已安装的 AI 客户端。安装后点「重新扫描」。'
    setClientList.replaceChildren(empty)
    setClientList.removeAttribute('aria-busy')
    if (btnClientSetup) btnClientSetup.disabled = true
    return
  }
  const fragment = document.createDocumentFragment()
  for (const client of installed) {
    const label = document.createElement('label')
    label.className = 'client-item'
    const checkbox = document.createElement('input')
    checkbox.type = 'checkbox'
    checkbox.dataset['id'] = client.id
    checkbox.disabled = client.configured
    checkbox.checked = !client.configured
    const name = document.createElement('span')
    name.className = 'client-name'
    name.textContent = client.name
    const badge = document.createElement('span')
    badge.className = client.configured ? 'client-pill ok' : client.outdated ? 'client-pill warn' : 'client-pill'
    badge.textContent = client.configured ? '已配置' : client.outdated ? '路径待修复' : '未配置'
    label.append(checkbox, name, badge)
    fragment.appendChild(label)
  }
  setClientList.replaceChildren(fragment)
  setClientList.removeAttribute('aria-busy')
  if (btnClientSetup) {
    btnClientSetup.disabled = setClientList.querySelectorAll('input[type=checkbox]:not(:disabled)').length === 0
  }
}

async function refreshClients(): Promise<void> {
  if (!setClientList || !btnClientSetup) return
  setClientList.setAttribute('aria-busy', 'true')
  setClientList.textContent = '正在扫描已安装的 AI 客户端…'
  btnClientSetup.disabled = true
  try {
    renderClients(await window.aa.clientsDetect())
  } catch (err) {
    setClientList.textContent = `扫描失败：${err instanceof Error ? err.message : String(err)}`
    setClientList.removeAttribute('aria-busy')
  }
}

btnClientScan?.addEventListener('click', () => {
  if (setClientResult) setClientResult.textContent = ''
  void refreshClients()
})

btnClientSetup?.addEventListener('click', async () => {
  if (!setClientList || !btnClientSetup) return
  const ids = Array.from(setClientList.querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked'))
    .filter((input) => !input.disabled)
    .map((input) => input.dataset['id'] ?? '')
    .filter(Boolean)
  if (!ids.length) {
    if (setClientResult) setClientResult.textContent = '请先勾选要接入的客户端。'
    return
  }
  btnClientSetup.disabled = true
  btnClientSetup.setAttribute('aria-busy', 'true')
  if (setClientResult) setClientResult.textContent = '正在写入接入配置…'
  try {
    const results = await window.aa.clientsSetup(ids)
    if (setClientResult) {
      setClientResult.textContent = results.length
        ? results.map((r) => `${CLIENT_STATUS_BADGE[r.status] ?? '完成'} ${r.name} — ${r.message}`).join('　')
        : '没有可写入的客户端。'
    }
    await refreshClients()
  } catch (err) {
    if (setClientResult) setClientResult.textContent = `写入失败：${err instanceof Error ? err.message : String(err)}`
  } finally {
    btnClientSetup.removeAttribute('aria-busy')
  }
})

btnUpdateCheck?.addEventListener('click', () => { void window.aa.updateCheck() })
btnUpdateAction?.addEventListener('click', () => {
  if (state.update?.status === 'downloaded') void window.aa.updateInstall()
  else void window.aa.updateDownload()
})

/* ── 设置面板 ─────────────────────── */
async function openSettings(): Promise<void> {
  if (!settingsModal) return
  settingsModal.hidden = false
  if (settingsStatus) settingsStatus.textContent = ''
  const view = await window.aa.settingsGet().catch(() => null)
  const agent = await window.aa.agentInfo().catch(() => null)
  if (view && setEngine) {
    setEngine.innerHTML = ''
    for (const p of view.presets) {
      const opt = document.createElement('option')
      opt.value = p.url
      opt.textContent = p.label
      setEngine.appendChild(opt)
    }
    setEngine.value = view.settings.searchEngine
    if (setEngineUrl) setEngineUrl.value = view.settings.searchEngine
    if (setFullSnapshot) setFullSnapshot.checked = view.settings.fullSnapshot
    if (setOpApproval) setOpApproval.checked = !!view.settings.requireOperationApproval
    if (setIsolatedSessions) setIsolatedSessions.checked = !!view.settings.isolatedSessions
    if (setAutoUpdate) setAutoUpdate.checked = view.settings.autoUpdate !== false
    if (setUpdateChannel) setUpdateChannel.value = view.settings.updateChannel || 'stable'
    if (setDownloadDir) setDownloadDir.value = view.settings.downloadDir
    if (setAllowedSites) setAllowedSites.value = view.settings.allowedSites.join('\n')
  }
  if (setAgentInfo) {
    if (agent) {
      setAgentInfo.textContent = `端口 ${agent.port} · 版本 ${agent.version} · 已连接 ${agent.clientCount} · 发现文件 ${agent.discoveryFile}`
      setAgentInfo.title = `token: ${agent.token}`
    } else {
      setAgentInfo.textContent = 'Agent 服务未启动'
    }
  }
  void refreshClients()
  renderUpdate(state.update)
}
btnSettings?.addEventListener('click', () => {
  if (settingsModal?.hidden) void openSettings()
})
document.getElementById('btn-close-settings')?.addEventListener('click', () => {
  if (settingsModal) settingsModal.hidden = true
})
document.getElementById('btn-save-settings')?.addEventListener('click', async () => {
  const patch: Partial<AppSettings> = {}
  if (setEngine) patch.searchEngine = setEngine.value || 'https://www.bing.com/search?q='
  if (setEngineUrl) patch.searchEngine = setEngineUrl.value.trim() || patch.searchEngine
  if (setFullSnapshot) patch.fullSnapshot = setFullSnapshot.checked
  if (setOpApproval) patch.requireOperationApproval = setOpApproval.checked
  if (setIsolatedSessions) patch.isolatedSessions = setIsolatedSessions.checked
  if (setAutoUpdate) patch.autoUpdate = setAutoUpdate.checked
  if (setUpdateChannel) patch.updateChannel = setUpdateChannel.value === 'beta' ? 'beta' : 'stable'
  if (setDownloadDir) patch.downloadDir = setDownloadDir.value
  if (setAllowedSites) patch.allowedSites = setAllowedSites.value.split(/\r?\n/).map((site) => site.trim()).filter(Boolean)
  await window.aa.settingsSet(patch).catch(() => null)
  if (settingsStatus) {
    settingsStatus.textContent = '已保存'
    setTimeout(() => { if (settingsStatus) settingsStatus.textContent = '' }, 1800)
  }
})

omnibox.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    const v = omnibox.value.trim()
    if (v) void window.aa.submit(v)
    hideSuggest()
    omnibox.blur()
  } else if (e.key === 'Escape') {
    hideSuggest()
    omnibox.blur()
  } else if (e.key === 'ArrowDown' && suggestPanel && !suggestPanel.hidden) {
    e.preventDefault()
    const sel = suggestList?.querySelector<HTMLElement>('.suggest-item.selected')
    const items = suggestList?.querySelectorAll<HTMLElement>('.suggest-item') ?? []
    const idx = sel ? Array.from(items).indexOf(sel) : -1
    const next = items[Math.min(idx + 1, items.length - 1)]
    if (next) selectSuggest(next)
  } else if (e.key === 'ArrowUp' && suggestPanel && !suggestPanel.hidden) {
    e.preventDefault()
    const sel = suggestList?.querySelector<HTMLElement>('.suggest-item.selected')
    const items = suggestList?.querySelectorAll<HTMLElement>('.suggest-item') ?? []
    const idx = sel ? Array.from(items).indexOf(sel) : 0
    const next = items[Math.max(idx - 1, 0)]
    if (next) selectSuggest(next)
  }
})
function selectSuggest(el: HTMLElement): void {
  suggestList?.querySelectorAll('.suggest-item').forEach((x) => x.classList.remove('selected'))
  el.classList.add('selected')
  const u = el.querySelector('.suggest-url')?.textContent
  if (u) {
    omnibox.value = u
    omnibox.setSelectionRange(u.length, u.length)
  }
}
omnibox.addEventListener('focus', () => omnibox.select())
omnibox.addEventListener('blur', () => setTimeout(hideSuggest, 120))
omnibox.addEventListener('input', onOmniboxInput)

window.aa.onState(applyState)
window.aa.onFocusOmnibox(() => {
  omnibox.focus()
})

/* 键盘快捷键（chrome UI 焦点时） */
window.addEventListener('keydown', (e) => {
  const ctrl = e.ctrlKey || e.metaKey
  if (ctrl && e.key.toLowerCase() === 't') {
    e.preventDefault()
    void window.aa.tabNew()
  } else if (ctrl && e.key.toLowerCase() === 'w') {
    e.preventDefault()
    const active = activeTab()
    if (active) void window.aa.tabClose(active.id)
  } else if (ctrl && e.key.toLowerCase() === 'l') {
    e.preventDefault()
    omnibox.focus()
  } else if (e.key === 'F5' || (ctrl && e.key.toLowerCase() === 'r')) {
    e.preventDefault()
    void window.aa.reload()
  } else if (ctrl && e.shiftKey && e.key.toLowerCase() === 'i') {
    e.preventDefault()
    void window.aa.devtools()
  }
})

/* 初始化拉取一次状态 */
void window.aa.getState().then(applyState)
