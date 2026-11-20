import type { TabInfo, UiState, DownloadInfo, HistoryEntry, AppSettings, SettingsView, AgentInfo, UpdateState } from '@shared/types'
import { resolveLocale, translate, type Locale, type LocaleKey } from '@shared/locale'

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

interface AgentActivityState {
  active: boolean
  paused: boolean
  tool?: string
  startedAt?: number
  resumeAt?: number
  calls?: {
    id: number
    tool: string
    startedAt: number
    client: number
    progress?: number
    total?: number
    message?: string
  }[]
}

declare global {
  interface Window {
    aa: {
      getState: () => Promise<UiState>
      tabNew: (url?: string) => Promise<void>
      tabClose: (id: string) => Promise<void>
      tabReopen: () => Promise<boolean>
      findOpen: () => Promise<void>
      find: (query: string, forward?: boolean, next?: boolean) => Promise<void>
      findClose: () => Promise<void>
      overlayHeight: (height: number) => Promise<void>
      tabSelect: (id: string) => Promise<void>
      back: () => Promise<void>
      forward: () => Promise<void>
      reload: () => Promise<void>
      submit: (value: string) => Promise<void>
      devtools: () => Promise<void>
      decideApproval: (id: string, allowed: boolean) => Promise<boolean>
      interruptAgent: () => Promise<boolean>
      resumeAgent: () => Promise<boolean>
      cancelAgentCall: (id: number) => Promise<boolean>
      downloadsList: () => Promise<DownloadInfo[]>
      downloadOpen: (id: string) => Promise<void>
      downloadShow: (id: string) => Promise<void>
      downloadCancel: (id: string) => Promise<boolean>
      downloadRetry: (id: string) => Promise<{ ok: boolean; reason?: string }>
      downloadDir: () => Promise<string>
      historySuggest: (query: string, limit?: number) => Promise<HistoryEntry[]>
      settingsGet: () => Promise<SettingsView | null>
      settingsSet: (patch: Partial<AppSettings>) => Promise<AppSettings | null>
      settingsOpen: (open: boolean) => Promise<void>
      agentInfo: () => Promise<AgentInfo | null>
      clientsDetect: () => Promise<ClientDetectResult[]>
      clientsSetup: (ids: string[]) => Promise<ClientSetupResult[]>
      updateCheck: () => Promise<UpdateState>
      updateDownload: () => Promise<UpdateState>
      updateInstall: () => Promise<boolean>
      updateDismiss: () => Promise<void>
      updateRetry: () => Promise<UpdateState>
      updateWake: () => Promise<UpdateState>
      onState: (cb: (state: UiState) => void) => void
      onFocusOmnibox: (cb: () => void) => void
      onFocusFind: (cb: () => void) => void
    }
  }
}

let state: UiState = { tabs: [], activeId: null, agentCount: 0, agentVerifiedCount: 0, bridgeState: 'waiting', connectionMessage: '等待 AI 客户端连接 MCP 桥', pendingApprovals: [], agentInterrupted: false, agentActivity: { active: false, paused: false } }

const tabsEl = document.getElementById('tabs') as HTMLDivElement
const omnibox = document.getElementById('omnibox') as HTMLInputElement
const agentPill = document.getElementById('agent-pill') as HTMLButtonElement
const btnBack = document.getElementById('btn-back') as HTMLButtonElement
const btnForward = document.getElementById('btn-forward') as HTMLButtonElement
const btnReload = document.getElementById('btn-reload') as HTMLButtonElement
const agentStop = document.getElementById('agent-stop') as HTMLButtonElement
const agentActivityOverlay = document.getElementById('agent-activity-overlay') as HTMLDivElement | null
const agentActivityTitle = document.getElementById('agent-activity-title') as HTMLElement | null
const agentActivityTool = document.getElementById('agent-activity-tool') as HTMLElement | null
const agentActivityDetail = document.getElementById('agent-activity-detail') as HTMLElement | null
const agentActivityAction = document.getElementById('agent-activity-action') as HTMLButtonElement | null
const agentActivityCalls = document.getElementById('agent-activity-calls') as HTMLElement | null
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
const setLocale = document.getElementById('set-locale') as HTMLSelectElement | null
const setTheme = document.getElementById('set-theme') as HTMLSelectElement | null
const setEngineUrl = document.getElementById('set-engine-url') as HTMLInputElement | null
const setFullSnapshot = document.getElementById('set-full-snapshot') as HTMLInputElement | null
const setOpApproval = document.getElementById('set-op-approval') as HTMLInputElement | null
const setIsolatedSessions = document.getElementById('set-isolated-sessions') as HTMLInputElement | null
const setRestoreSession = document.getElementById('set-restore-session') as HTMLInputElement | null
const setDownloadDir = document.getElementById('set-download-dir') as HTMLInputElement | null
const setAllowedSites = document.getElementById('set-allowed-sites') as HTMLTextAreaElement | null
const setAgentInfo = document.getElementById('set-agent-info') as HTMLDivElement | null
const settingsStatus = document.getElementById('settings-status') as HTMLSpanElement | null
let settingsStatusTimer: ReturnType<typeof setTimeout> | undefined
const setClientList = document.getElementById('set-client-list') as HTMLDivElement | null
const btnClientScan = document.getElementById('btn-client-scan') as HTMLButtonElement | null
const btnClientSetup = document.getElementById('btn-client-setup') as HTMLButtonElement | null
const setClientResult = document.getElementById('set-client-result') as HTMLDivElement | null
const setAutoUpdate = document.getElementById('set-auto-update') as HTMLInputElement | null
const setUpdateChannel = document.getElementById('set-update-channel') as HTMLSelectElement | null
const updateStatus = document.getElementById('update-status') as HTMLDivElement | null
const btnUpdateCheck = document.getElementById('btn-update-check') as HTMLButtonElement | null
const btnUpdateAction = document.getElementById('btn-update-action') as HTMLButtonElement | null
const updatePill = document.getElementById('btn-update-notice') as HTMLButtonElement
const updateNotice = document.getElementById('update-notice') as HTMLDivElement
const updateNoticeText = document.getElementById('update-notice-text') as HTMLSpanElement
const updateNoticeProgress = document.getElementById('update-notice-progress') as HTMLProgressElement
const updateNoticeAction = document.getElementById('update-notice-action') as HTMLButtonElement
const btnReopen = document.getElementById('btn-reopen') as HTMLButtonElement
const findBar = document.getElementById('find-bar') as HTMLDivElement
const findQuery = document.getElementById('find-query') as HTMLInputElement
const findStatus = document.getElementById('find-status') as HTMLSpanElement

function resolveUiLocale(setting: AppSettings['locale'] = 'auto'): Locale {
  return resolveLocale(setting, navigator.languages?.length ? navigator.languages : [navigator.language])
}

let savedLocale = resolveUiLocale()
let activeLocale = savedLocale
const t = (key: LocaleKey): string => translate(activeLocale, key)

type ThemeSetting = AppSettings['theme']
let activeThemeSetting: ThemeSetting = 'light'
let savedThemeSetting: ThemeSetting = 'light'
const systemThemeMedia = window.matchMedia?.('(prefers-color-scheme: dark)')
function resolveUiTheme(setting: ThemeSetting = 'light'): 'light' | 'dark' {
  if (setting === 'dark') return 'dark'
  if (setting === 'system') return systemThemeMedia?.matches ? 'dark' : 'light'
  return 'light'
}
function applyTheme(setting: ThemeSetting = 'light'): void {
  activeThemeSetting = setting
  const resolved = resolveUiTheme(setting)
  document.documentElement.dataset.theme = resolved
  document.documentElement.style.colorScheme = resolved
}
applyTheme('light')
systemThemeMedia?.addEventListener('change', () => {
  if (activeThemeSetting === 'system') applyTheme('system')
})

function setText(id: string, key: LocaleKey): void {
  const element = document.getElementById(id)
  if (element) element.textContent = t(key)
}

function setAttr(id: string, name: string, key: LocaleKey): void {
  const element = document.getElementById(id)
  if (element) element.setAttribute(name, t(key))
}

function applyLocale(locale: Locale): void {
  activeLocale = locale
  document.documentElement.lang = locale
  document.title = t('appTitle')
  setAttr('tabs', 'aria-label', 'tabs')
  setAttr('btn-newtab', 'title', 'newTab'); setAttr('btn-newtab', 'aria-label', 'newTab')
  setAttr('btn-back', 'title', 'back'); setAttr('btn-back', 'aria-label', 'back')
  setAttr('btn-forward', 'title', 'forward'); setAttr('btn-forward', 'aria-label', 'forward')
  setAttr('btn-reload', 'title', 'reload'); setAttr('btn-reload', 'aria-label', 'reload')
  setAttr('omnibox', 'aria-label', 'searchOrUrl'); setAttr('omnibox', 'placeholder', 'searchOrUrl')
  setAttr('btn-reopen', 'title', 'reopenTab'); setAttr('btn-reopen', 'aria-label', 'reopenTab')
  setAttr('btn-find', 'title', 'findInPage'); setAttr('btn-find', 'aria-label', 'findInPage')
  setAttr('btn-feed', 'title', 'activity'); setAttr('btn-feed', 'aria-label', 'activity')
  setAttr('btn-downloads', 'title', 'downloads'); setAttr('btn-downloads', 'aria-label', 'downloads')
  setAttr('btn-settings', 'title', 'settings'); setAttr('btn-settings', 'aria-label', 'settings')
  setText('agent-stop', state.agentInterrupted ? 'resume' : 'interrupt')
  setText('settings-title', 'settingsTitle')
  setText('settings-subtitle', 'settingsSubtitle')
  setAttr('settings-nav', 'aria-label', 'settingsSections')
  setText('settings-nav-general', 'settingsNavGeneral')
  setText('settings-nav-browsing', 'settingsNavBrowsing')
  setText('settings-nav-data', 'settingsNavData')
  setText('settings-nav-ai', 'settingsNavAi')
  setText('settings-nav-update', 'softwareUpdate')
  setText('settings-head-general', 'settingsNavGeneral')
  setText('settings-head-browsing', 'settingsNavBrowsing')
  setText('settings-head-data', 'settingsNavData')
  setText('settings-head-ai', 'settingsNavAi')
  setText('settings-desc-general', 'settingsDescGeneral')
  setText('settings-desc-browsing', 'settingsDescBrowsing')
  setText('settings-desc-data', 'settingsDescData')
  setText('settings-desc-ai', 'settingsDescAi')
  setText('settings-desc-update', 'settingsDescUpdate')
  setText('settings-theme-label', 'theme')
  setText('settings-theme-light', 'themeLight')
  setText('settings-theme-dark', 'themeDark')
  setText('settings-theme-system', 'themeSystem')
  setText('settings-update-channel-label', 'updateChannel')
  setText('settings-engine-hint', 'engineHint')
  setAttr('btn-close-settings', 'aria-label', 'close')
  setText('settings-engine-label', 'defaultSearchEngine')
  setText('settings-engine-custom', 'customSearchAddress')
  setText('settings-full-snapshot-label', 'fullSnapshot')
  setText('settings-approval-label', 'approval')
  setText('settings-isolated-label', 'isolatedSessions')
  setText('settings-isolated-hint', 'isolatedSessionsHint')
  setText('settings-restore-label', 'restoreSession')
  setText('settings-restore-hint', 'restoreSessionHint')
  setText('settings-download-dir-label', 'downloadDir')
  setAttr('set-download-dir', 'placeholder', 'downloadDirPlaceholder')
  setText('settings-allowlist-label', 'siteAllowlist')
  setText('settings-allowlist-hint', 'siteAllowlistHint')
  setAttr('set-allowed-sites', 'placeholder', 'siteAllowlistPlaceholder')
  setText('software-update-settings', 'softwareUpdate')
  setText('settings-auto-update-label', 'autoUpdate')
  setText('settings-update-stable', 'stable')
  setText('settings-update-beta', 'beta')
  setText('settings-update-hint', 'updateHint')
  setText('settings-client-label', 'connectClient')
  setText('btn-client-scan', 'rescan')
  setText('btn-client-setup', 'writeClients')
  setText('settings-client-hint', 'clientSetupHint')
  setText('settings-agent-label', 'agentService')
  setText('btn-save-settings', 'save')
  setAttr('find-bar', 'aria-label', 'findInPage')
  const findLabel = document.querySelector<HTMLLabelElement>('#find-bar label'); if (findLabel) findLabel.textContent = t('findLabel')
  setAttr('find-query', 'placeholder', 'findPlaceholder')
  setAttr('find-prev', 'aria-label', 'previousMatch'); setAttr('find-next', 'aria-label', 'nextMatch')
  setAttr('find-close', 'aria-label', 'close')
  const localeOption = setLocale?.querySelector<HTMLOptionElement>('option[value="auto"]'); if (localeOption) localeOption.textContent = t('autoLocale')
  const engineUrl = document.getElementById('set-engine-url') as HTMLInputElement | null; if (engineUrl) engineUrl.placeholder = t('customSearch')
  const updateCheck = document.getElementById('btn-update-check'); if (updateCheck) updateCheck.textContent = t('checkUpdate')
  const updateAction = document.getElementById('btn-update-action'); if (updateAction && !updateAction.hidden) updateAction.textContent = t('downloadUpdate')
  renderToolbar(); renderFind(); renderUpdate(state.update)
}

function renderFind(): void {
  const find = state.find
  const wasHidden = findBar.hidden
  findBar.hidden = !find?.open
  btnReopen.disabled = !state.canReopenClosed
  document.documentElement.style.setProperty('--find-height', find?.open ? '48px' : '0px')
  document.documentElement.style.setProperty('--page-top', `${84 + (state.update?.noticeVisible ? 44 : 0) + (find?.open ? 48 : 0) + (state.pendingApprovals.length ? 180 : 0)}px`)
  if (!find?.open) return
  if (wasHidden) {
    findQuery.value = find.query
    findQuery.focus()
  }
  findStatus.textContent = !find.query ? t('findPlaceholder') : find.matches ? `${find.activeMatch} / ${find.matches}` : (activeLocale === 'en-US' ? 'No matches' : '未找到匹配')
  findQuery.setAttribute('aria-invalid', String(!!find.query && !find.matches))
}

async function openFind(): Promise<void> {
  await window.aa.findOpen()
  findQuery.focus()
  findQuery.select()
}

document.getElementById('btn-find')?.addEventListener('click', () => void openFind())
btnReopen.addEventListener('click', () => void window.aa.tabReopen())
findQuery.addEventListener('input', () => void window.aa.find(findQuery.value))
findQuery.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    void window.aa.find(findQuery.value, !event.shiftKey, true)
  }
})
document.getElementById('find-prev')?.addEventListener('click', () => void window.aa.find(findQuery.value, false, true))
document.getElementById('find-next')?.addEventListener('click', () => void window.aa.find(findQuery.value, true, true))
document.getElementById('find-close')?.addEventListener('click', () => void window.aa.findClose())
window.aa.onFocusFind(() => { findQuery.focus(); findQuery.select() })

/** DOM 浮层的实际高度同步给原生视图，避免被 84px 工具栏裁切。 */
let extentFrame = 0
let previousExtent = -1
function syncOverlayExtent(): void {
  cancelAnimationFrame(extentFrame)
  extentFrame = requestAnimationFrame(() => {
    const panels = [suggestPanel, dlPanel, feedDrawer]
    const extent = Math.ceil(Math.max(0, ...panels.filter((el) => el && !el.hidden).map((el) => el!.getBoundingClientRect().bottom + 8)))
    if (extent !== previousExtent) {
      previousExtent = extent
      void window.aa.overlayHeight(extent)
    }
    btnDownloads?.setAttribute('aria-expanded', String(!dlPanel?.hidden))
    btnFeed?.setAttribute('aria-expanded', String(!feedDrawer?.hidden))
  })
}
const overlayObserver = new MutationObserver(syncOverlayExtent)
const overlayResize = new ResizeObserver(syncOverlayExtent)
for (const panel of [suggestPanel, dlPanel, feedDrawer]) {
  if (!panel) continue
  overlayObserver.observe(panel, { attributes: true, attributeFilter: ['hidden'], childList: true, subtree: true })
  overlayResize.observe(panel)
}
window.addEventListener('resize', syncOverlayExtent)

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
    disabled: activeLocale === 'en-US' ? 'Updates disabled in development' : '开发模式不检查更新', idle: `${t('currentVersion')} ${update.currentVersion}`, checking: activeLocale === 'en-US' ? 'Checking for updates…' : '正在检查更新…',
    'up-to-date': activeLocale === 'en-US' ? `Already up to date (${update.currentVersion})` : `已是最新版本（${update.currentVersion}）`, available: activeLocale === 'en-US' ? `New version ${update.version ?? ''} found` : `发现新版本 ${update.version ?? ''}`,
    downloading: activeLocale === 'en-US' ? `Downloading ${update.version ?? ''} · ${Math.max(0, Math.round(update.progress ?? 0))}%` : `正在下载 ${update.version ?? ''} · ${Math.max(0, Math.round(update.progress ?? 0))}%`,
    downloaded: activeLocale === 'en-US' ? `${update.version ?? ''} downloaded; restart to install` : `已下载 ${update.version ?? ''}，可以重启安装`, error: activeLocale === 'en-US' ? `Update failed: ${update.error ?? 'Unknown error'}` : `更新失败：${update.error ?? '未知错误'}`
  }
  updateStatus.textContent = labels[update.status]
  const navVersion = document.getElementById('settings-nav-version')
  if (navVersion) navVersion.textContent = `v${update.currentVersion}`
  updateStatus.title = [update.checkedAt ? `上次检查：${new Date(update.checkedAt).toLocaleString()}` : '', update.retryAt ? `自动重试：${new Date(update.retryAt).toLocaleTimeString()}` : '', update.releaseDate ? `发布时间：${update.releaseDate}` : '', update.size ? `大小：${formatUpdateBytes(update.size)}` : '', update.releaseNotes ?? ''].filter(Boolean).join('\n')
  if (btnUpdateCheck) btnUpdateCheck.disabled = update.failedOperation === 'install' || ['checking', 'downloading', 'downloaded'].includes(update.status)
  if (btnUpdateAction) {
    btnUpdateAction.hidden = !['available', 'downloaded', 'error'].includes(update.status)
    btnUpdateAction.disabled = update.status === 'downloading'
    btnUpdateAction.textContent = update.status === 'downloaded' ? (activeLocale === 'en-US' ? 'Restart and install' : '重启并安装') : update.status === 'error' ? (activeLocale === 'en-US' ? 'Retry update' : '重试更新') : t('downloadUpdate')
  }
  updatePill.hidden = !['available', 'downloading', 'downloaded', 'error'].includes(update.status)
  updatePill.textContent = update.status === 'downloaded' ? (activeLocale === 'en-US' ? 'Restart update' : '重启更新') : update.status === 'downloading' ? `${activeLocale === 'en-US' ? 'Update' : '更新'} ${Math.max(0, Math.min(100, Math.round(update.progress ?? 0)))}%` : update.status === 'error' ? (activeLocale === 'en-US' ? 'Update failed' : '更新失败') : (activeLocale === 'en-US' ? 'Update available' : '发现更新')
  updatePill.title = labels[update.status]
  updatePill.classList.toggle('error', update.status === 'error')
  updateNotice.hidden = !update.noticeVisible
  document.documentElement.style.setProperty('--notice-height', update.noticeVisible ? '44px' : '0px')
  updateNotice.classList.toggle('error', update.status === 'error')
  const failedOperation = { check: ['check', '检查'], download: ['download', '下载'], install: ['installation', '安装'] }[update.failedOperation ?? 'check']
  updateNoticeText.textContent = update.status === 'downloaded' ? (activeLocale === 'en-US' ? `${update.version} downloaded. Restart to install.` : `新版 ${update.version} 已下载完成，重启即可安装。`) : update.status === 'available' ? (activeLocale === 'en-US' ? `Version ${update.version} is available; current version is ${update.currentVersion}.` : `发现新版本 ${update.version}，当前为 ${update.currentVersion}。`) : update.status === 'error' ? (activeLocale === 'en-US' ? `Update ${failedOperation[0]} failed. ${update.retryAt ? 'It will retry automatically.' : 'Retry now or review settings.'}` : `更新${failedOperation[1]}失败，${update.retryAt ? '将自动重试，也可立即重试。' : '点击重试或在设置中查看原因。'}`) : labels[update.status]
  updateNoticeProgress.hidden = update.status !== 'downloading'
  updateNoticeProgress.value = Math.max(0, Math.min(100, update.progress ?? 0))
  updateNoticeAction.hidden = !['available', 'downloaded', 'error'].includes(update.status)
  updateNoticeAction.textContent = update.status === 'downloaded' ? (activeLocale === 'en-US' ? 'Restart and install' : '重启安装') : update.status === 'error' ? (activeLocale === 'en-US' ? 'Retry now' : '立即重试') : t('downloadUpdate')
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

let agentActivityTimer: ReturnType<typeof setInterval> | undefined

/** 并发调用列表：每个调用独立显示进度，并可单独停止（不影响其他客户端）。 */
function renderAgentCallList(activity: AgentActivityState, paused: boolean): void {
  if (!agentActivityCalls) return
  const calls = paused ? [] : (activity.calls ?? [])
  agentActivityCalls.hidden = calls.length === 0
  agentActivityCalls.replaceChildren()
  for (const call of calls.slice(0, 6)) {
    const row = document.createElement('div')
    row.className = 'agent-call-row'
    row.dataset['callId'] = String(call.id)

    const label = document.createElement('span')
    label.className = 'agent-call-label'
    label.textContent = `#${call.id} · 客户端 ${call.client} · ${call.tool}`
    row.appendChild(label)

    const detail = document.createElement('span')
    detail.className = 'agent-call-detail'
    if (call.message) detail.textContent = call.message
    else if (typeof call.progress === 'number' && typeof call.total === 'number' && call.total > 0) {
      detail.textContent = `${Math.round((call.progress / call.total) * 100)}%`
    }
    if (detail.textContent) row.appendChild(detail)

    const stop = document.createElement('button')
    stop.type = 'button'
    stop.className = 'agent-call-stop'
    stop.textContent = '停止'
    stop.title = `只停止调用 #${call.id}`
    stop.addEventListener('click', () => void window.aa.cancelAgentCall(call.id))
    row.appendChild(stop)
    agentActivityCalls.appendChild(row)
  }
  if (calls.length > 6) {
    const more = document.createElement('div')
    more.className = 'agent-call-more'
    more.textContent = `还有 ${calls.length - 6} 个调用…`
    agentActivityCalls.appendChild(more)
  }
}

function renderAgentActivity(): void {
  if (!agentActivityOverlay) return
  const activity: AgentActivityState = state.agentActivity ?? {
    active: false,
    paused: state.agentInterrupted
  }
  const paused = activity.paused || state.agentInterrupted
  const visible = activity.active || paused
  agentActivityOverlay.hidden = !visible
  agentActivityOverlay.setAttribute('aria-hidden', String(!visible))
  agentActivityOverlay.classList.toggle('paused', paused)
  if (!visible) {
    if (agentActivityCalls) agentActivityCalls.hidden = true
    if (agentActivityTimer) clearInterval(agentActivityTimer)
    agentActivityTimer = undefined
    return
  }

  if (agentActivityTitle) agentActivityTitle.textContent = paused ? 'AI 操作已暂停' : 'AI 工具正在操作中'
  const callCount = activity.calls?.length ?? 0
  if (agentActivityTool) {
    agentActivityTool.textContent = activity.tool
      ? `工具：${activity.tool}${callCount > 1 ? `（共 ${callCount} 个并发调用）` : ''}`
      : (paused ? '等待 AI 恢复…' : '正在准备浏览器操作…')
  }
  renderAgentCallList(activity, paused)
  if (agentActivityAction) {
    agentActivityAction.textContent = paused ? '恢复' : '中断'
    agentActivityAction.title = paused ? '立即恢复 AI 的浏览器操作' : '立即中断 AI 的后续浏览器操作'
  }

  const updateCountdown = (): void => {
    const resumeAt = activity.resumeAt
    const remaining = resumeAt ? Math.max(0, Math.ceil((resumeAt - Date.now()) / 1000)) : 0
    if (agentActivityDetail) {
      agentActivityDetail.textContent = paused
        ? remaining > 0 ? `已中断，${remaining} 秒后自动继续` : '已中断，等待自动继续…'
        : '浏览器由 AI 控制'
    }
    if (remaining <= 0 && agentActivityTimer) {
      clearInterval(agentActivityTimer)
      agentActivityTimer = undefined
    }
  }
  if (agentActivityTimer) clearInterval(agentActivityTimer)
  agentActivityTimer = paused && activity.resumeAt ? setInterval(updateCountdown, 1000) : undefined
  updateCountdown()
}
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
  const connected = state.agentVerifiedCount > 0
  const waiting = !connected && (state.bridgeState === 'waiting' || state.agentCount > 0)
  const statusText = connected
    ? (activeLocale === 'en-US' ? `AI connected ×${state.agentVerifiedCount}` : `AI 已连接 ×${state.agentVerifiedCount}`)
    : waiting
      ? state.agentCount > 0 ? (activeLocale === 'en-US' ? 'Waiting for first AI call' : '等待 AI 首次调用') : t('agentWaiting')
      : (activeLocale === 'en-US' ? 'AI bridge disconnected' : 'AI 桥未连接')
  agentPill.classList.toggle('connected', connected)
  agentPill.classList.toggle('waiting', waiting)
  agentPill.classList.toggle('disconnected', !connected && !waiting)
  agentPill.textContent = statusText
  agentPill.title = `${state.connectionMessage}。点击打开“连接 AI 客户端”设置。`
  agentPill.setAttribute('aria-label', `${statusText}。点击打开连接设置`)
  agentStop.textContent = state.agentInterrupted ? t('resume') : t('interrupt')
  agentStop.disabled = !connected && !state.agentInterrupted && !state.agentActivity?.active
   agentStop.classList.toggle('active', state.agentInterrupted)
  agentStop.title = agentStop.disabled
     ? (activeLocale === 'en-US' ? 'Waiting for an AI connection' : '等待 AI 连接')
     : state.agentInterrupted ? (activeLocale === 'en-US' ? 'Resume Agent browser actions' : '恢复 Agent 浏览器操作') : (activeLocale === 'en-US' ? 'Interrupt further Agent browser actions' : '中断 Agent 的后续浏览器操作')
  renderAgentActivity()
  renderApprovals()
}

function renderApprovals(): void {
  const pending = state.pendingApprovals ?? []
  approvalPanel.hidden = pending.length === 0
  approvalPanel.textContent = ''
  for (const item of pending) {
    const isOp = item.kind === 'operation'
    const isPermission = item.kind === 'permission'
    const title = document.createElement('div')
    title.className = 'approval-title'
    title.textContent = isPermission ? '网站请求设备权限' : isOp ? 'Agent 请求执行高危操作' : '需要你亲自填写敏感信息'
    const meta = document.createElement('div')
    meta.className = 'approval-meta'
    meta.textContent = `网站：${item.site} · 标签：${item.tabTitle} · 操作：${item.fieldLabel}`
    const help = document.createElement('div')
    help.className = 'approval-help'
    help.textContent = isPermission
      ? (item.detail || '允许后该站点仅在本次浏览器会话内可使用此权限；拒绝则保持阻断。')
      : isOp
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
    allow.textContent = isOp || isPermission ? '允许' : '允许继续'
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
    if (d.state === 'progressing') {
      const cancel = document.createElement('button')
      cancel.className = 'dl-act dl-act-danger'
      cancel.textContent = '取消'
      cancel.addEventListener('click', () => void window.aa.downloadCancel(d.id))
      actions.appendChild(cancel)
    } else {
      const retry = document.createElement('button')
      retry.className = 'dl-act'
      retry.textContent = '重试'
      retry.addEventListener('click', () => void window.aa.downloadRetry(d.id))
      actions.appendChild(retry)
    }
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
    clearTimeout(suggestTimer)
    hideSuggest()
    return
  }
  clearTimeout(suggestTimer)
  suggestTimer = setTimeout(() => {
    void window.aa.historySuggest(q).then((items) => {
      if (document.activeElement === omnibox && omnibox.value.trim() === q) renderSuggest(items)
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
  renderFind()
  syncOverlayExtent()
  if (document.activeElement !== omnibox) hideSuggest()
}

/* ── 事件绑定 ─────────────────────── */

btnBack.addEventListener('click', () => void window.aa.back())
btnForward.addEventListener('click', () => void window.aa.forward())
btnReload.addEventListener('click', () => void window.aa.reload())
agentPill.addEventListener('click', () => {
  if (settingsModal?.hidden) {
    void openSettings().then(() => {
      setClientList?.closest('.settings-group')?.scrollIntoView({ block: 'center' })
    })
  }
})
agentStop.addEventListener('click', () => void (state.agentInterrupted ? window.aa.resumeAgent() : window.aa.interruptAgent()))
agentActivityAction?.addEventListener('click', () => {
  const paused = state.agentInterrupted || !!state.agentActivity?.paused
  void (paused ? window.aa.resumeAgent() : window.aa.interruptAgent())
})
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
  if (feedDrawer && !feedDrawer.hidden && !btnFeed?.contains(e.target as Node) && !feedDrawer.contains(e.target as Node)) feedDrawer.hidden = true
  if (!dlPanel || dlPanel.hidden) return
  if (btnDownloads?.contains(e.target as Node) || dlPanel.contains(e.target as Node)) return
  dlPanel.hidden = true
})

btnFeed?.addEventListener('click', () => {
  if (!feedDrawer) return
  feedDrawer.hidden = !feedDrawer.hidden
  if (dlPanel) dlPanel.hidden = true
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
  else if (state.update?.status === 'error') void window.aa.updateRetry()
  else void window.aa.updateDownload()
})
updateNoticeAction.addEventListener('click', () => {
  if (state.update?.status === 'downloaded') void window.aa.updateInstall()
  else if (state.update?.status === 'error') void window.aa.updateRetry()
  else void window.aa.updateDownload()
})
document.getElementById('update-notice-dismiss')?.addEventListener('click', () => void window.aa.updateDismiss())
updatePill.addEventListener('click', () => {
  void openSettings().then(() => document.getElementById('software-update-settings')?.scrollIntoView({ block: 'center' }))
})
window.addEventListener('online', () => { void window.aa.updateWake() })

/* ── 设置面板 ─────────────────────── */
async function openSettings(): Promise<void> {
  if (!settingsModal) return
  hideSuggest()
  if (dlPanel) dlPanel.hidden = true
  if (feedDrawer) feedDrawer.hidden = true
  await window.aa.settingsOpen(true)
  settingsModal.hidden = false
  if (settingsBody) settingsBody.scrollTop = 0
  if (settingsSections[0]) setActiveSettingsSection(settingsSections[0].id)
  if (settingsStatus) settingsStatus.textContent = ''
  const view = await window.aa.settingsGet().catch(() => null)
  const agent = await window.aa.agentInfo().catch(() => null)
  if (view && setEngine) {
    savedLocale = resolveUiLocale(view.settings.locale)
    savedThemeSetting = view.settings.theme
    applyTheme(view.settings.theme)
    setEngine.innerHTML = ''
    for (const p of view.presets) {
      const opt = document.createElement('option')
      opt.value = p.url
      opt.textContent = p.label
      setEngine.appendChild(opt)
    }
    const custom = document.createElement('option')
    custom.id = 'settings-engine-custom'
    custom.value = ''
    custom.textContent = t('customSearchAddress')
    setEngine.appendChild(custom)
    setEngine.value = view.presets.some((preset) => preset.url === view.settings.searchEngine) ? view.settings.searchEngine : ''
    if (setEngineUrl) setEngineUrl.value = view.settings.searchEngine
    if (setLocale) setLocale.value = view.settings.locale || 'auto'
    if (setTheme) setTheme.value = view.settings.theme || 'light'
    if (setFullSnapshot) setFullSnapshot.checked = view.settings.fullSnapshot
    if (setOpApproval) setOpApproval.checked = !!view.settings.requireOperationApproval
    if (setIsolatedSessions) setIsolatedSessions.checked = !!view.settings.isolatedSessions
    if (setRestoreSession) setRestoreSession.checked = view.settings.restoreSession !== false
    if (setAutoUpdate) setAutoUpdate.checked = view.settings.autoUpdate !== false
    if (setUpdateChannel) setUpdateChannel.value = view.settings.updateChannel || 'stable'
    if (setDownloadDir) setDownloadDir.value = view.settings.downloadDir
    if (setAllowedSites) setAllowedSites.value = view.settings.allowedSites.join('\n')
  }
  if (setAgentInfo) {
    if (agent) {
      setAgentInfo.textContent = `MCP 桥：${agent.clientCount} 个 · 已验证调用：${agent.verifiedClientCount} 个 · 端口 ${agent.port} · 发现文件 ${agent.discoveryFile}`
      setAgentInfo.title = `token: ${agent.token}`
    } else {
      setAgentInfo.textContent = 'Agent 服务未启动'
    }
  }
  void refreshClients()
  renderUpdate(state.update)
}
function closeSettings(): void {
  if (!settingsModal) return
  settingsModal.hidden = true
  if (activeLocale !== savedLocale) applyLocale(savedLocale)
  if (activeThemeSetting !== savedThemeSetting) applyTheme(savedThemeSetting)
  void window.aa.settingsOpen(false)
}
btnSettings?.addEventListener('click', () => {
  if (settingsModal?.hidden) void openSettings()
})
document.getElementById('btn-close-settings')?.addEventListener('click', () => {
  closeSettings()
})

/* ── 设置面板：左侧分区导航 ─────────────── */
const settingsBody = document.getElementById('settings-body') as HTMLDivElement | null
const settingsNavItems = Array.from(document.querySelectorAll<HTMLButtonElement>('.settings-nav-item'))
const settingsSections = settingsNavItems
  .map((item) => document.getElementById(item.dataset['target'] ?? ''))
  .filter((section): section is HTMLElement => section !== null)

function setActiveSettingsSection(id: string): void {
  for (const item of settingsNavItems) {
    const active = item.dataset['target'] === id
    item.classList.toggle('is-active', active)
    if (active) item.setAttribute('aria-current', 'true')
    else item.removeAttribute('aria-current')
  }
}

function scrollToSettingsSection(id: string): void {
  const target = document.getElementById(id)
  if (!target || !settingsBody) return
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  settingsBody.scrollTo({ top: Math.max(0, target.offsetTop - 16), behavior: reduceMotion ? 'auto' : 'smooth' })
}

for (const item of settingsNavItems) {
  item.addEventListener('click', () => {
    const id = item.dataset['target']
    if (id) scrollToSettingsSection(id)
  })
}

settingsBody?.addEventListener('scroll', () => {
  if (!settingsBody || !settingsSections.length) return
  const last = settingsSections[settingsSections.length - 1]
  if (settingsBody.scrollTop + settingsBody.clientHeight >= settingsBody.scrollHeight - 4) {
    if (last) setActiveSettingsSection(last.id)
    return
  }
  const line = settingsBody.scrollTop + 28
  let current = settingsSections[0]
  for (const section of settingsSections) if (section.offsetTop <= line) current = section
  if (current) setActiveSettingsSection(current.id)
}, { passive: true })
setEngine?.addEventListener('change', () => {
  if (setEngineUrl && setEngine.value) setEngineUrl.value = setEngine.value
  else setEngineUrl?.focus()
})
setEngineUrl?.addEventListener('input', () => {
  if (!setEngine) return
  const value = setEngineUrl.value.trim()
  setEngine.value = Array.from(setEngine.options).some((option) => option.value === value) ? value : ''
})
setLocale?.addEventListener('change', () => {
  const setting = setLocale.value === 'zh-CN' || setLocale.value === 'en-US' ? setLocale.value : 'auto'
  applyLocale(resolveUiLocale(setting))
})
setTheme?.addEventListener('change', () => {
  const value = setTheme.value
  applyTheme(value === 'dark' || value === 'system' ? value : 'light')
})
document.getElementById('btn-save-settings')?.addEventListener('click', async () => {
  const button = document.getElementById('btn-save-settings') as HTMLButtonElement
  if (button.disabled) return
  button.disabled = true
  clearTimeout(settingsStatusTimer)
  if (settingsStatus) settingsStatus.textContent = t('saving')
  const patch: Partial<AppSettings> = {}
  if (setEngine) patch.searchEngine = setEngine.value || 'https://www.bing.com/search?q='
  if (setEngineUrl) patch.searchEngine = setEngineUrl.value.trim() || patch.searchEngine
  if (setLocale) patch.locale = setLocale.value === 'zh-CN' || setLocale.value === 'en-US' ? setLocale.value : 'auto'
  if (setFullSnapshot) patch.fullSnapshot = setFullSnapshot.checked
  if (setTheme) patch.theme = setTheme.value === 'dark' || setTheme.value === 'system' ? setTheme.value : 'light'
  if (setOpApproval) patch.requireOperationApproval = setOpApproval.checked
  if (setIsolatedSessions) patch.isolatedSessions = setIsolatedSessions.checked
  if (setRestoreSession) patch.restoreSession = setRestoreSession.checked
  if (setAutoUpdate) patch.autoUpdate = setAutoUpdate.checked
  if (setUpdateChannel) patch.updateChannel = setUpdateChannel.value === 'beta' ? 'beta' : 'stable'
  if (setDownloadDir) patch.downloadDir = setDownloadDir.value
  if (setAllowedSites) patch.allowedSites = setAllowedSites.value.split(/\r?\n/).map((site) => site.trim()).filter(Boolean)
  try {
    const saved = await window.aa.settingsSet(patch)
    if (!saved) throw new Error('设置未保存，请重试。')
    savedLocale = resolveUiLocale(saved.locale)
    savedThemeSetting = saved.theme
    applyTheme(saved.theme)
    applyLocale(savedLocale)
    if (settingsStatus) {
      settingsStatus.textContent = t('saved')
      settingsStatusTimer = setTimeout(() => { if (settingsStatus) settingsStatus.textContent = '' }, 1800)
    }
  } catch (error) {
    if (settingsStatus) settingsStatus.textContent = `${t('saveFailed')}${error instanceof Error ? error.message : String(error)}`
  } finally {
    button.disabled = false
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
  if (e.key === 'Escape') {
    hideSuggest()
    if (dlPanel) dlPanel.hidden = true
    if (feedDrawer) feedDrawer.hidden = true
    if (!settingsModal?.hidden) closeSettings()
    else if (state.find?.open) void window.aa.findClose()
  } else if (ctrl && e.shiftKey && e.key.toLowerCase() === 't') {
    e.preventDefault()
    void window.aa.tabReopen()
  } else if (ctrl && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    void openFind()
  } else if (ctrl && e.key.toLowerCase() === 't') {
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
void window.aa.settingsGet().then((view) => {
  savedLocale = resolveUiLocale(view?.settings.locale)
  savedThemeSetting = view?.settings.theme || 'light'
  applyTheme(view?.settings.theme || 'light')
  applyLocale(savedLocale)
}).catch(() => { applyTheme('light'); applyLocale(activeLocale) })
void window.aa.getState().then(applyState)
