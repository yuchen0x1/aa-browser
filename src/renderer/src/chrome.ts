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
      tabSelect: (id: string, focusPage?: boolean) => Promise<void>
      back: () => Promise<void>
      forward: () => Promise<void>
      reload: () => Promise<void>
      submit: (value: string) => Promise<void>
      devtools: () => Promise<void>
      decideApproval: (id: string, allowed: boolean) => Promise<boolean>
      interruptAgent: () => Promise<boolean>
      resumeAgent: () => Promise<boolean>
      cancelAgentCall: (id: number, client?: number) => Promise<boolean>
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

let state: UiState = { tabs: [], activeId: null, agentCount: 0, agentVerifiedCount: 0, bridgeState: 'waiting', pendingApprovals: [], agentInterrupted: false, agentActivity: { active: false, paused: false } }

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
const btnCloseDownloads = document.getElementById('btn-close-dl') as HTMLButtonElement | null
const dlList = document.getElementById('download-list') as HTMLDivElement | null
const downloadStatus = document.getElementById('download-status')
const pendingDownloadRetries = new Set<string>()
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
let lastClients: ClientDetectResult[] | null = null
let lastAgentInfo: AgentInfo | null = null
let hasAgentInfo = false
const settingsStatus = document.getElementById('settings-status') as HTMLSpanElement | null
let settingsStatusTimer: ReturnType<typeof setTimeout> | undefined
let settingsReturnFocus: HTMLElement | null = null
let settingsRequest = 0
let settingsReady = false
let settingsOperation = 0
let adoptedSettingsOperation = 0
let clientScanRequest = 0
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
const btnFind = document.getElementById('btn-find') as HTMLButtonElement
const findQuery = document.getElementById('find-query') as HTMLInputElement
const findStatus = document.getElementById('find-status') as HTMLSpanElement

function resolveUiLocale(setting: AppSettings['locale'] = 'auto'): Locale {
  return resolveLocale(setting, navigator.languages?.length ? navigator.languages : [navigator.language])
}

let savedLocale = resolveUiLocale()
let activeLocale = savedLocale
const t = (key: LocaleKey): string => translate(activeLocale, key)
const uiText = (zh: string, en: string): string => activeLocale === 'en-US' ? en : zh

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

/** 保存基线独立于模态生命周期；迟到响应可更新基线，但不能倒退或覆盖当前预览。 */
function adoptSavedSettings(settings: AppSettings | null | undefined, operation: number): void {
  if (!settings || operation <= adoptedSettingsOperation) return
  adoptedSettingsOperation = operation
  savedLocale = resolveUiLocale(settings.locale)
  savedThemeSetting = settings.theme || 'light'
  if (!settingsModal || settingsModal.hidden || !settingsReady) {
    applyTheme(savedThemeSetting)
    applyLocale(savedLocale)
  }
}

function setText(id: string, key: LocaleKey): void {
  const element = document.getElementById(id)
  if (element) element.textContent = t(key)
}

function setAttr(id: string, name: string, key: LocaleKey): void {
  const element = document.getElementById(id)
  if (element) element.setAttribute(name, t(key))
}

/** 外壳内的可见可聚焦控件；隐藏抽屉、禁用项和模态背景都不算。 */
function isFocusable(element: HTMLElement | null | undefined): element is HTMLElement {
  return !!element && element !== document.body && element !== document.documentElement &&
    element.isConnected && element.getClientRects().length > 0 &&
    !element.matches(':disabled, [aria-disabled="true"]') && !element.closest('[inert], [aria-hidden="true"]')
}
function focusIfPossible(element: HTMLElement | null | undefined): boolean {
  if (!isFocusable(element)) return false
  element.focus({ preventScroll: true })
  return true
}

/** 部分输入法的确认键不带 isComposing；按输入目标记录合成，失焦时清理。 */
const composingTargets = new WeakSet<EventTarget>()
document.addEventListener('compositionstart', (event) => { if (event.target) composingTargets.add(event.target) })
document.addEventListener('compositionend', (event) => { if (event.target) composingTargets.delete(event.target) })
document.addEventListener('focusout', (event) => { if (event.target) composingTargets.delete(event.target) })
function isComposingKey(event: KeyboardEvent): boolean {
  return event.isComposing || event.keyCode === 229 || !!(event.target && composingTargets.has(event.target))
}

function renderSearchPresetLabels(): void {
  const englishLabels: Record<string, string> = { '必应 (Bing)': 'Bing', '百度': 'Baidu' }
  for (const option of Array.from(setEngine?.options ?? [])) {
    const label = option.dataset['presetLabel']
    if (label) option.textContent = activeLocale === 'en-US' ? englishLabels[label] ?? label : label
  }
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
  renderSearchPresetLabels()
  const updateCheck = document.getElementById('btn-update-check'); if (updateCheck) updateCheck.textContent = t('checkUpdate')
  const updateAction = document.getElementById('btn-update-action'); if (updateAction && !updateAction.hidden) updateAction.textContent = t('downloadUpdate')
  renderAgentInfo()
  // 语言预览只翻译已缓存的数据，不重新扫描客户端，也不写任何配置。
  if (lastClients && setClientList && setClientList.getAttribute('aria-busy') !== 'true') renderClients(lastClients, true)
  renderToolbar(); renderFind(); renderUpdate(state.update)
}

function renderFind(): void {
  const find = state.find
  const wasHidden = findBar.hidden
  const hadFocus = findBar.contains(document.activeElement)
  findBar.hidden = !find?.open
  btnReopen.disabled = !state.canReopenClosed
  document.documentElement.style.setProperty('--find-height', find?.open ? '48px' : '0px')
  document.documentElement.style.setProperty('--page-top', `${84 + (state.update?.noticeVisible ? 44 : 0) + (find?.open ? 48 : 0) + (state.pendingApprovals.length ? 180 : 0)}px`)
  if (!find?.open) {
    // 查找条被关闭（Esc/按钮/主进程）后焦点不能留在隐藏输入框；仅当焦点原本就在查找条内时回收。
    if (!wasHidden && document.hasFocus() && hadFocus) {
      const target = findReturnFocus
      findReturnFocus = null
      if (!focusIfPossible(target)) focusIfPossible(btnFind)
    }
    return
  }
  if (wasHidden && !(settingsModal && !settingsModal.hidden)) {
    findQuery.value = find.query
    findQuery.focus()
  } else if (wasHidden) {
    findQuery.value = find.query
  }
  findStatus.textContent = !find.query ? t('findPlaceholder') : find.matches ? `${find.activeMatch} / ${find.matches}` : (activeLocale === 'en-US' ? 'No matches' : '未找到匹配')
  findQuery.setAttribute('aria-invalid', String(!!find.query && !find.matches))
}

let findReturnFocus: HTMLElement | null = null

async function openFind(): Promise<void> {
  // 设置是模态层：打开期间不允许把焦点移出到查找条。
  if (settingsModal && !settingsModal.hidden) return
  const previous = document.activeElement
  if (previous instanceof HTMLElement && previous !== document.body && !findBar.contains(previous)) findReturnFocus = previous
  await window.aa.findOpen()
  findQuery.focus()
  findQuery.select()
}

/** Esc / 关闭按钮退出查找：焦点回到打开查找前的位置，不留在隐藏的输入框里。 */
function closeFind(): void {
  // renderFind 在状态确认关闭后回收焦点；不跨 IPC 等待抢回用户已主动移动的焦点。
  void window.aa.findClose()
}

document.getElementById('btn-find')?.addEventListener('click', () => void openFind())
btnReopen.addEventListener('click', () => void window.aa.tabReopen())
findQuery.addEventListener('input', () => void window.aa.find(findQuery.value))
findQuery.addEventListener('keydown', (event) => {
  if (isComposingKey(event)) return
  if (event.key === 'Enter') {
    event.preventDefault()
    void window.aa.find(findQuery.value, !event.shiftKey, true)
  }
})
document.getElementById('find-prev')?.addEventListener('click', () => void window.aa.find(findQuery.value, false, true))
document.getElementById('find-next')?.addEventListener('click', () => void window.aa.find(findQuery.value, true, true))
document.getElementById('find-close')?.addEventListener('click', () => closeFind())
window.aa.onFocusFind(() => {
  if (settingsModal && !settingsModal.hidden) return
  findQuery.focus()
  findQuery.select()
})

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
  if (!value || value < 1024) return value ? `${value} B` : uiText('未知大小', 'Unknown size')
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
    downloaded: activeLocale === 'en-US' ? `${update.version ?? ''} downloaded; restart to install` : `已下载 ${update.version ?? ''}，可以重启安装`, error: uiText('更新失败', 'Update failed')
  }
  updateStatus.textContent = labels[update.status]
  const navVersion = document.getElementById('settings-nav-version')
  if (navVersion) navVersion.textContent = `v${update.currentVersion}`
  const releaseNotesLabel = uiText('发行说明（发布者原文）', 'Release notes (publisher original language)')
  const errorDetailsLabel = uiText('错误详情（来源语言）', 'Error details (source language)')
  updateStatus.title = [update.checkedAt ? `${uiText('上次检查：', 'Last checked: ')}${new Date(update.checkedAt).toLocaleString()}` : '', update.retryAt ? `${uiText('自动重试：', 'Auto retry: ')}${new Date(update.retryAt).toLocaleTimeString()}` : '', update.releaseDate ? `${uiText('发布时间：', 'Release date: ')}${update.releaseDate}` : '', update.size ? `${uiText('大小：', 'Size: ')}${formatUpdateBytes(update.size)}` : '', update.error ? `${errorDetailsLabel}:\n${update.error}` : '', update.releaseNotes ? `${releaseNotesLabel}:\n${update.releaseNotes}` : ''].filter(Boolean).join('\n')
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

function editableUrl(u: string): string {
  try {
    const url = new URL(u)
    if (url.username || url.password) {
      url.username = ''
      url.password = ''
      return url.href
    }
  } catch { /* 非 URL 输入保持原样。 */ }
  return u
}

function shortenUrl(u: string): string {
  if (/^file:\/\//i.test(u)) return u.replace(/^file:\/\/\/?/, uiText('本地文件 ', 'Local file '))
  try {
    const url = new URL(u)
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.host + url.pathname + url.search + url.hash
    return editableUrl(u)
  } catch {
    return u
  }
}

function focusOmnibox(): void {
  omnibox.focus()
  omnibox.select()
}

/** 渲染标签条 */
function renderTabs(): void {
  tabsEl.textContent = ''
  for (const t of state.tabs) {
    const el = document.createElement('div')
    el.className = 'tab' + (t.active ? ' active' : '')
    el.title = `${t.title}\n${t.url}${t.isolated ? `\n${uiText('（隔离会话：不共享登录态）', '(Isolated session: sign-in state is not shared)')}` : ''}`
    el.setAttribute('role', 'tab')
    el.setAttribute('aria-selected', String(t.active))
    el.tabIndex = t.active ? 0 : -1
    el.dataset['tabId'] = t.id
    el.dataset['focusKey'] = `tab:${t.id}`

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
        fav.classList.add('favicon-fallback')
      }
      fav.appendChild(img)
    } else {
      fav.textContent = '•'
      fav.classList.add('favicon-fallback')
    }
    el.appendChild(fav)

    const title = document.createElement('span')
    title.className = 'title'
    title.textContent = t.title || uiText('无标题', 'Untitled')
    el.appendChild(title)

    // 隔离会话标签带锁标识：用户必须能一眼看出哪些标签不共享登录态
    if (t.isolated) {
      const lock = document.createElement('span')
      lock.className = 'tab-lock'
      lock.textContent = '🔒'
      lock.title = uiText('隔离会话：不共享 Cookie / 登录态，关闭后清除数据', 'Isolated session: cookies and sign-in are not shared and data is cleared on close')
      lock.setAttribute('aria-label', uiText('隔离会话标签', 'Isolated session tab'))
      el.appendChild(lock)
      el.classList.add('isolated')
    }

    const close = document.createElement('button')
    close.className = 'close'
    close.dataset['focusKey'] = `tab-close:${t.id}`
    // 只有活动标签的关闭按钮进入 Tab 顺序；非活动标签仍可鼠标点击，方向键切换后自然轮到它。
    close.tabIndex = t.active ? 0 : -1
    close.title = uiText('关闭标签页 (Ctrl+W)', 'Close tab (Ctrl+W)')
    close.setAttribute('aria-label', `${uiText('关闭标签页：', 'Close tab: ')}${t.title || uiText('无标题', 'Untitled')}`)
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
    row.dataset['client'] = String(call.client)

    const label = document.createElement('span')
    label.className = 'agent-call-label'
    label.textContent = `#${call.id} · ${uiText('客户端', 'Client')} ${call.client} · ${call.tool}`
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
    stop.dataset['focusKey'] = `call-stop:${call.client}:${call.id}`
    stop.textContent = uiText('停止', 'Stop')
    stop.title = uiText(`只停止客户端 ${call.client} 的调用 #${call.id}`, `Stop client ${call.client} call #${call.id} only`)
    stop.setAttribute('aria-label', stop.title)
    stop.addEventListener('click', () => void window.aa.cancelAgentCall(call.id, call.client))
    row.appendChild(stop)
    agentActivityCalls.appendChild(row)
  }
  if (calls.length > 6) {
    const more = document.createElement('div')
    more.className = 'agent-call-more'
    more.textContent = uiText(`还有 ${calls.length - 6} 个调用…`, `${calls.length - 6} more calls…`)
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

  if (agentActivityTitle) agentActivityTitle.textContent = paused ? uiText('AI 操作已暂停', 'AI operation paused') : uiText('AI 工具正在操作中', 'AI tool is working')
  const callCount = activity.calls?.length ?? 0
  if (agentActivityTool) {
    agentActivityTool.textContent = activity.tool
      ? `${uiText('工具：', 'Tool: ')}${activity.tool}${callCount > 1 ? uiText(`（共 ${callCount} 个并发调用）`, ` (${callCount} concurrent calls)`) : ''}`
      : (paused ? uiText('等待 AI 恢复…', 'Waiting for AI to resume…') : uiText('正在准备浏览器操作…', 'Preparing browser action…'))
  }
  renderAgentCallList(activity, paused)
  if (agentActivityAction) {
    agentActivityAction.textContent = paused ? t('resume') : t('interrupt')
    agentActivityAction.title = paused ? uiText('立即恢复 AI 的浏览器操作', 'Resume AI browser actions now') : uiText('立即中断 AI 的后续浏览器操作', 'Interrupt further AI browser actions now')
  }

  const updateCountdown = (): void => {
    const resumeAt = activity.resumeAt
    const remaining = resumeAt ? Math.max(0, Math.ceil((resumeAt - Date.now()) / 1000)) : 0
    if (agentActivityDetail) {
      agentActivityDetail.textContent = paused
        ? remaining > 0 ? uiText(`已中断，${remaining} 秒后自动继续`, `Interrupted; continuing in ${remaining}s`) : uiText('已中断，等待自动继续…', 'Interrupted; waiting to continue…')
        : uiText('浏览器由 AI 控制', 'Browser controlled by AI')
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
  agentPill.title = connected
    ? uiText(`${state.agentVerifiedCount} 个 MCP 客户端已验证连接。点击打开 AI 客户端连接设置。`, `${state.agentVerifiedCount} MCP client(s) verified. Click to open AI client connection settings.`)
    : waiting
      ? uiText(state.agentCount > 0 ? `${state.agentCount} 个 MCP 桥已认证，等待 AI 首次调用。点击打开设置。` : '等待 AI 客户端连接。点击打开连接设置。', state.agentCount > 0 ? `${state.agentCount} MCP bridge(s) authenticated; waiting for the first AI call. Click to open settings.` : 'Waiting for an AI client connection. Click to open connection settings.')
      : uiText('Agent 服务未连接。请打开连接设置检查服务状态。', 'Agent service is disconnected. Open connection settings to check its status.')
  agentPill.setAttribute('aria-label', activeLocale === 'en-US' ? `${statusText}. Click to open connection settings` : `${statusText}。点击打开连接设置`)
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
    title.textContent = isPermission ? uiText('网站请求设备权限', 'Website requests device permission') : isOp ? uiText('Agent 请求执行高危操作', 'Agent requests a high-risk action') : uiText('需要你亲自填写敏感信息', 'Sensitive information requires your input')
    const meta = document.createElement('div')
    meta.className = 'approval-meta'
    meta.textContent = `${uiText('网站：', 'Site: ')}${item.site} · ${uiText('标签：', 'Tab: ')}${item.tabTitle} · ${uiText('操作：', 'Action: ')}${item.fieldLabel}`
    const help = document.createElement('div')
    help.className = 'approval-help'
    help.textContent = isPermission
      ? (item.detail || uiText('允许后该站点仅在本次浏览器会话内可使用此权限；拒绝则保持阻断。', 'After allowing, this site may use the permission only in this browser session; denying keeps it blocked.'))
      : isOp
        ? (item.detail || uiText('Agent 即将执行此操作。请确认后点“允许”，拒绝则中止该步骤。', 'The Agent is about to perform this action. Confirm with “Allow”; denying stops the step.'))
        : uiText('请直接在网页输入框中填写内容；敏感内容不会由 Agent 写入或回传。填写完成后再点“允许继续”。', 'Enter the value directly in the webpage; sensitive content is never written or returned by the Agent. Select “Continue” when finished.')
    const actions = document.createElement('div')
    actions.className = 'approval-actions'
    const deny = document.createElement('button')
    deny.className = 'approval-deny'
    deny.dataset['focusKey'] = `approval-deny:${item.id}`
    deny.textContent = uiText('拒绝', 'Deny')
    deny.addEventListener('click', () => void window.aa.decideApproval(item.id, false))
    const allow = document.createElement('button')
    allow.className = 'approval-allow'
    allow.dataset['focusKey'] = `approval-allow:${item.id}`
    allow.textContent = isOp || isPermission ? uiText('允许', 'Allow') : uiText('允许继续', 'Continue')
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
    empty.textContent = uiText('暂无 Agent 操作记录', 'No Agent activity yet')
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
    case 'progressing': return uiText('下载中', 'Downloading')
    case 'completed': return uiText('完成', 'Completed')
    case 'cancelled': return uiText('已取消', 'Cancelled')
    case 'interrupted': return uiText('已中断', 'Interrupted')
    default: return s
  }
}

/** 下载重试结果反馈：面板内可见 + aria-live 播报，不静默吞掉失败。 */
function setDownloadStatus(message: string, state: 'pending' | 'success' | 'error'): void {
  if (!downloadStatus) return
  downloadStatus.textContent = message
  downloadStatus.dataset['state'] = state
}

function syncDownloadRetryButtons(): void {
  dlList?.querySelectorAll<HTMLButtonElement>('[data-focus-key^="download-retry:"]').forEach((button) => {
    button.disabled = pendingDownloadRetries.size > 0
  })
}

async function retryDownload(id: string): Promise<void> {
  // 面板共用一个结果区，串行提交避免其他文件的成功覆盖尚未读完的失败。
  if (pendingDownloadRetries.size > 0) return
  const focusedKey = document.activeElement instanceof HTMLElement ? document.activeElement.dataset['focusKey'] : undefined
  pendingDownloadRetries.add(id)
  // 禁用聚焦中的按钮会把焦点丢给 body；先移到面板内稳定控件。
  if (focusedKey?.startsWith('download-retry:')) focusIfPossible(btnCloseDownloads)
  syncDownloadRetryButtons()
  const record = state.downloads?.find((d) => d.id === id)
  const name = record?.filename ? uiText(`，文件：${record.filename}`, ` — ${record.filename}`) : ''
  setDownloadStatus(uiText(`正在重新发起下载${name}…`, `Restarting download${name}…`), 'pending')
  try {
    const result = await window.aa.downloadRetry(id)
    if (result?.ok) {
      setDownloadStatus(uiText(`已重新发起下载${name}。可在列表中查看进度。`, `Download restarted${name}. Check its progress in this list.`), 'success')
    } else {
      const reason = result?.reason?.trim() || uiText('未知原因', 'Unknown reason')
      setDownloadStatus(uiText(`重试失败${name}：${reason}`, `Retry failed${name}: ${reason}`), 'error')
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    setDownloadStatus(uiText(`重试失败${name}：${reason}`, `Retry failed${name}: ${reason}`), 'error')
  } finally {
    pendingDownloadRetries.delete(id)
    // 状态流可能已经重建按钮；解锁当前列表而不是旧 DOM 引用。
    syncDownloadRetryButtons()
    // 只有外壳仍持有焦点且用户没有主动移焦时才归还，避免抢走新的操作位置。
    if (focusedKey && document.hasFocus() && document.activeElement === btnCloseDownloads) {
      focusIfPossible(document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(focusedKey)}"]`))
    }
  }
}

function renderDownloads(): void {
  if (!dlList) return
  const items = state.downloads || []
  const hasActive = items.some((d) => d.state === 'progressing')
  if (btnDownloads) {
    btnDownloads.classList.toggle('has-active', hasActive)
    btnDownloads.title = items.length ? uiText(`下载（${items.length}）`, `Downloads (${items.length})`) : t('downloads')
  }
  if (!items.length) {
    dlList.innerHTML = `<div class="empty-feed">${uiText('暂无下载记录', 'No downloads yet')}</div>`
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
    open.dataset['focusKey'] = `download-open:${d.id}`
    open.textContent = uiText('打开', 'Open')
    open.addEventListener('click', () => void window.aa.downloadOpen(d.id))
    const show = document.createElement('button')
    show.className = 'dl-act'
    show.dataset['focusKey'] = `download-show:${d.id}`
    show.textContent = uiText('在文件夹中显示', 'Show in folder')
    show.addEventListener('click', () => void window.aa.downloadShow(d.id))
    actions.append(open, show)
    if (d.state === 'progressing') {
      const cancel = document.createElement('button')
      cancel.className = 'dl-act dl-act-danger'
      cancel.dataset['focusKey'] = `download-cancel:${d.id}`
      cancel.textContent = uiText('取消', 'Cancel')
      cancel.addEventListener('click', () => void window.aa.downloadCancel(d.id))
      actions.appendChild(cancel)
    } else {
      const retry = document.createElement('button')
      retry.className = 'dl-act'
      retry.dataset['focusKey'] = `download-retry:${d.id}`
      retry.textContent = uiText('重试', 'Retry')
      retry.disabled = pendingDownloadRetries.size > 0
      retry.addEventListener('click', () => void retryDownload(d.id))
      actions.appendChild(retry)
    }
    el.appendChild(actions)

    dlList.appendChild(el)
  }
}

let suggestTimer: ReturnType<typeof setTimeout> | undefined
let suggestRequest = 0

function hideSuggest(): void {
  clearTimeout(suggestTimer)
  suggestRequest++
  if (suggestPanel) suggestPanel.hidden = true
  omnibox.removeAttribute('aria-activedescendant')
  omnibox.setAttribute('aria-expanded', 'false')
}

function renderSuggest(items: HistoryEntry[]): void {
  if (!suggestPanel || !suggestList) return
  if (!items.length) {
    hideSuggest()
    return
  }
  // 列表每次重建，旧的 activedescendant 可能指向已销毁的节点，先清掉再按需设置。
  omnibox.removeAttribute('aria-activedescendant')
  suggestList.innerHTML = ''
  for (const [index, it] of items.entries()) {
    const el = document.createElement('div')
    el.className = 'suggest-item'
    el.id = `suggestion-${index}`
    el.setAttribute('role', 'option')
    el.setAttribute('aria-selected', 'false')
    el.tabIndex = -1
    el.addEventListener('click', () => {
      void window.aa.submit(it.url)
      hideSuggest()
    })
    el.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        void window.aa.submit(it.url)
        hideSuggest()
      }
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
  omnibox.setAttribute('aria-expanded', 'true')
}

function onOmniboxInput(): void {
  const request = ++suggestRequest
  const q = omnibox.value.trim()
  if (!q) {
    hideSuggest()
    return
  }
  clearTimeout(suggestTimer)
  suggestTimer = setTimeout(() => {
    void window.aa.historySuggest(q).then((items) => {
      if (request === suggestRequest && document.activeElement === omnibox && omnibox.value.trim() === q) renderSuggest(items)
    })
  }, 140)
}

/** 重建列表后为消失的焦点控件找同业务域内的就近替代，避免焦点掉回 body 或跑到网页。 */
function findFocusFallback(key: string): HTMLElement | null {
  const byKey = (value: string): HTMLElement | null =>
    document.querySelector<HTMLElement>(`[data-focus-key="${CSS.escape(value)}"]`)
  const direct = byKey(key)
  if (isFocusable(direct)) return direct

  const separator = key.indexOf(':')
  const kind = separator === -1 ? key : key.slice(0, separator)
  const id = separator === -1 ? '' : key.slice(separator + 1)

  switch (kind) {
    case 'download-cancel':
    case 'download-retry':
    case 'download-open':
    case 'download-show':
      for (const action of ['download-open', 'download-show', 'download-retry']) {
        const candidate = byKey(`${action}:${id}`)
        if (isFocusable(candidate)) return candidate
      }
      break
    case 'approval-allow':
    case 'approval-deny': {
      // 不把持续按下的 Enter 转交给下一条高危操作的「允许」。
      const activeTabEl = document.querySelector<HTMLElement>('.tab.active')
      return isFocusable(activeTabEl) ? activeTabEl : omnibox
    }
    case 'call-stop': {
      const nextCall = document.querySelector<HTMLElement>('[data-focus-key^="call-stop:"]')
      if (isFocusable(nextCall)) return nextCall
      const action = [agentActivityAction, agentStop].find(isFocusable)
      if (action) return action
      break
    }
    case 'tab':
    case 'tab-close': {
      const activeTabEl = document.querySelector<HTMLElement>('.tab.active')
      if (isFocusable(activeTabEl)) return activeTabEl
      const anyTab = document.querySelector<HTMLElement>('[role="tab"]')
      return isFocusable(anyTab) ? anyTab : omnibox
    }
  }
  // 记录整体消失时，停留在仍打开的抽屉内，而不是把焦点甩给网页。
  if (dlPanel && !dlPanel.hidden) return [btnCloseDownloads, btnDownloads].find(isFocusable) ?? null
  if (feedDrawer && !feedDrawer.hidden) return [btnCloseFeed, btnFeed].find(isFocusable) ?? null
  return isFocusable(btnFeed) ? btnFeed : omnibox
}

function applyState(next: UiState): void {
  // 状态流会重建列表；只恢复外壳内同一业务控件，不能抢走网页的焦点。
  const focused = document.hasFocus() ? document.activeElement as HTMLElement | null : null
  const focusKey = focused?.dataset['focusKey']
  const activeChanged = state.activeId !== next.activeId
  state = next
  if (activeChanged) {
    hideSuggest()
    if (document.activeElement === omnibox) {
      omnibox.value = editableUrl(activeTab()?.url ?? '')
      omnibox.select()
    }
  }
  if (typeof next.windowHeight === 'number') document.documentElement.style.setProperty('--window-height', `${next.windowHeight}px`)
  renderTabs()
  renderToolbar()
  renderFeed()
  renderDownloads()
  renderUpdate(next.update)
  renderFind()
  if (focusKey && focused && !isFocusable(focused) && (document.activeElement === document.body || document.activeElement === focused)) {
    focusIfPossible(findFocusFallback(focusKey))
  }
  syncOverlayExtent()
  if (document.activeElement !== omnibox) hideSuggest()
}

/* ── 事件绑定 ─────────────────────── */

btnBack.addEventListener('click', () => void window.aa.back())
btnForward.addEventListener('click', () => void window.aa.forward())
btnReload.addEventListener('click', () => void window.aa.reload())
agentPill.addEventListener('click', () => {
  if (settingsModal?.hidden) {
    void openSettings().then((ready) => {
      if (ready && !settingsModal?.hidden) setClientList?.closest('.settings-group')?.scrollIntoView({ block: 'center' })
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
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return
  const tabs = Array.from(tabsEl.querySelectorAll<HTMLElement>('[role="tab"]'))
  if (!tabs.length) return
  const focusedTab = (event.target as HTMLElement).closest<HTMLElement>('[role="tab"]')
  if (!focusedTab) return
  const current = tabs.indexOf(focusedTab)
  if (current < 0) return
  const direction = event.key === 'ArrowRight' ? 1 : -1
  const index = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (current + direction + tabs.length) % tabs.length
  const next = tabs[index]
  event.preventDefault()
  next.focus()
  const id = next.dataset['tabId']
  if (id) void window.aa.tabSelect(id, false)
})

type DrawerKind = 'dl' | 'feed'
function drawerPanel(kind: DrawerKind): HTMLDivElement | null {
  return kind === 'dl' ? dlPanel : feedDrawer
}
function drawerTrigger(kind: DrawerKind): HTMLElement | null {
  return kind === 'dl' ? btnDownloads : btnFeed
}
function drawerClose(kind: DrawerKind): HTMLElement | null {
  return kind === 'dl' ? btnCloseDownloads : btnCloseFeed
}
function drawerOpen(kind: DrawerKind): boolean {
  const panel = drawerPanel(kind)
  return !!panel && !panel.hidden
}

/** 键盘打开抽屉后把焦点移入（通用聚焦关闭按钮），关闭时再还给触发按钮。 */
function openDrawer(kind: DrawerKind): void {
  if (kind === 'dl') {
    if (feedDrawer) feedDrawer.hidden = true
    if (dlPanel) dlPanel.hidden = false
  } else {
    if (dlPanel) dlPanel.hidden = true
    if (feedDrawer) feedDrawer.hidden = false
  }
  focusIfPossible(drawerClose(kind))
  drawerTrigger('dl')?.setAttribute('aria-expanded', String(kind === 'dl'))
  drawerTrigger('feed')?.setAttribute('aria-expanded', String(kind === 'feed'))
}

/** restoreFocus=false 用于外部鼠标点击：只收起面板，不把焦点抢回触发按钮。 */
function closeDrawer(kind: DrawerKind, restoreFocus = true): void {
  const panel = drawerPanel(kind)
  if (!panel || panel.hidden) return
  const hadFocusInside = panel.contains(document.activeElement)
  panel.hidden = true
  drawerTrigger(kind)?.setAttribute('aria-expanded', 'false')
  if (!restoreFocus) {
    if (hadFocusInside && document.activeElement instanceof HTMLElement) document.activeElement.blur()
    return
  }
  focusIfPossible(drawerTrigger(kind))
}

btnDownloads?.addEventListener('click', () => {
  if (drawerOpen('dl')) closeDrawer('dl')
  else openDrawer('dl')
})
btnCloseDownloads?.addEventListener('click', () => closeDrawer('dl'))
document.addEventListener('click', (e) => {
  const target = e.target as Node
  if (drawerOpen('feed') && !btnFeed?.contains(target) && !feedDrawer?.contains(target)) closeDrawer('feed', false)
  if (drawerOpen('dl') && !btnDownloads?.contains(target) && !dlPanel?.contains(target)) closeDrawer('dl', false)
})

btnFeed?.addEventListener('click', () => {
  if (drawerOpen('feed')) closeDrawer('feed')
  else openDrawer('feed')
})
btnCloseFeed?.addEventListener('click', () => closeDrawer('feed'))

/* ── 设置面板：连接 AI 客户端 ─────────────── */
/** 设置里的 Agent 服务信息：语言切换时用缓存值即时重渲染，不重新请求。 */
function renderAgentInfo(): void {
  if (!setAgentInfo) return
  if (!hasAgentInfo) {
    setAgentInfo.textContent = t('loading')
    return
  }
  const agent = lastAgentInfo
  if (agent) {
    setAgentInfo.textContent = activeLocale === 'en-US'
      ? `MCP bridge: ${agent.clientCount} · verified calls: ${agent.verifiedClientCount} · port ${agent.port} · discovery file ${agent.discoveryFile}`
      : `MCP 桥：${agent.clientCount} 个 · 已验证调用：${agent.verifiedClientCount} 个 · 端口 ${agent.port} · 发现文件 ${agent.discoveryFile}`
    setAgentInfo.removeAttribute('title')
  } else {
    setAgentInfo.textContent = uiText('Agent 服务未启动', 'Agent service is not running')
  }
}

/** 客户端注册表里的显示名带中文说明；英文界面按稳定 id 换用英文名，未知 id 保留原名。 */
const clientEnglishNames: Record<string, string> = {
  zcode: 'ZCode',
  claude: 'Claude Code',
  cursor: 'Cursor',
  windsurf: 'Windsurf',
  cline: 'Cline (VS Code extension)',
  vscode: 'VS Code (native MCP)',
  gemini: 'Gemini CLI',
  qwen: 'Qwen Code',
  opencode: 'OpenCode (open source)',
  'deepseek-harness': 'DeepSeek Harness (manual install from the plugin marketplace)',
  codex: 'Codex (Desktop / CLI / IDE)',
  workbuddy: 'WorkBuddy'
}
function clientDisplayName(id: string, fallback: string): string {
  return activeLocale === 'en-US' ? clientEnglishNames[id] ?? fallback : fallback
}

function clientStatusBadge(status: ClientSetupResult['status']): string {
  const label = {
    added: uiText('已写入', 'Written'),
    updated: uiText('已更新', 'Updated'),
    skipped: uiText('已配置', 'Already configured'),
    manual: uiText('需手动', 'Manual action'),
    error: uiText('失败', 'Failed')
  }[status] ?? uiText('完成', 'Done')
  return `${status === 'added' || status === 'updated' ? '✅' : status === 'skipped' ? 'ℹ️' : status === 'manual' ? '⚠️' : '❌'} ${label}`
}

function renderClients(clients: ClientDetectResult[], preserveSelection = false): void {
  if (!setClientList) return
  lastClients = clients
  // 语言切换等重渲染要保留用户勾选和当前焦点，不能把选择重置回默认。
  const existing = setClientList.querySelectorAll<HTMLInputElement>('input[type=checkbox]')
  const checkedIds = new Set(Array.from(existing).filter((input) => input.checked && !input.disabled).map((input) => input.dataset['id'] ?? ''))
  const focusedId = preserveSelection && setClientList.contains(document.activeElement) ? (document.activeElement as HTMLElement).dataset['id'] : undefined
  const installed = clients.filter((c) => c.installed)
  if (!installed.length) {
    const empty = document.createElement('span')
    empty.className = 'settings-hint'
    empty.textContent = uiText('未检测到已安装的 AI 客户端。安装后点「重新扫描」。', 'No installed AI clients detected. Install one and select “Rescan”.')
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
    checkbox.checked = client.configured ? false : (preserveSelection && existing.length ? checkedIds.has(client.id) : true)
    if (focusedId === client.id) checkbox.dataset['focusPending'] = 'true'
    const name = document.createElement('span')
    name.className = 'client-name'
    name.textContent = clientDisplayName(client.id, client.name)
    const badge = document.createElement('span')
    badge.className = client.configured ? 'client-pill ok' : client.outdated ? 'client-pill warn' : 'client-pill'
    badge.textContent = client.configured ? uiText('已配置', 'Configured') : client.outdated ? uiText('路径待修复', 'Path needs repair') : uiText('未配置', 'Not configured')
    label.append(checkbox, name, badge)
    fragment.appendChild(label)
  }
  setClientList.replaceChildren(fragment)
  setClientList.removeAttribute('aria-busy')
  if (focusedId) setClientList.querySelector<HTMLInputElement>(`input[data-focus-pending="true"]`)?.focus({ preventScroll: true })
  if (btnClientSetup) {
    btnClientSetup.disabled = btnClientSetup.getAttribute('aria-busy') === 'true' || setClientList.querySelectorAll('input[type=checkbox]:not(:disabled)').length === 0
  }
}

async function refreshClients(): Promise<void> {
  if (!setClientList || !btnClientSetup || !settingsReady) return
  const request = settingsRequest
  const scan = ++clientScanRequest
  setClientList.setAttribute('aria-busy', 'true')
  setClientList.textContent = t('scanningClients')
  btnClientSetup.disabled = true
  try {
    const clients = await window.aa.clientsDetect()
    if (!currentSettingsRequest(request) || scan !== clientScanRequest) return
    renderClients(clients)
  } catch (err) {
    if (!currentSettingsRequest(request) || scan !== clientScanRequest) return
    lastClients = null
    setClientList.textContent = `${uiText('扫描失败：', 'Scan failed: ')}${err instanceof Error ? err.message : String(err)}`
    setClientList.removeAttribute('aria-busy')
  }
}

btnClientScan?.addEventListener('click', () => {
  if (setClientResult) setClientResult.textContent = ''
  void refreshClients()
})

btnClientSetup?.addEventListener('click', async () => {
  if (!setClientList || !btnClientSetup || !settingsReady || !currentSettingsRequest(settingsRequest) || btnClientSetup.getAttribute('aria-busy') === 'true') return
  const request = settingsRequest
  const ids = Array.from(setClientList.querySelectorAll<HTMLInputElement>('input[type=checkbox]:checked'))
    .filter((input) => !input.disabled)
    .map((input) => input.dataset['id'] ?? '')
    .filter(Boolean)
  if (!ids.length) {
    if (setClientResult) setClientResult.textContent = uiText('请先勾选要接入的客户端。', 'Select at least one client to connect.')
    return
  }
  btnClientSetup.disabled = true
  btnClientSetup.setAttribute('aria-busy', 'true')
  if (setClientResult) setClientResult.textContent = uiText('正在写入接入配置…', 'Writing connection configuration…')
  try {
    const results = await window.aa.clientsSetup(ids)
    if (!currentSettingsRequest(request)) return
    if (setClientResult) {
      setClientResult.textContent = results.length
        ? results.map((r) => `${clientStatusBadge(r.status)} ${clientDisplayName(r.id, r.name)} — ${r.message}`).join('　')
        : uiText('没有可写入的客户端。', 'No clients available to configure.')
    }
    await refreshClients()
  } catch (err) {
    if (currentSettingsRequest(request) && setClientResult) setClientResult.textContent = `${uiText('写入失败：', 'Write failed: ')}${err instanceof Error ? err.message : String(err)}`
  } finally {
    if (currentSettingsRequest(request)) {
      btnClientSetup.removeAttribute('aria-busy')
      btnClientSetup.disabled = setClientList.getAttribute('aria-busy') === 'true' || setClientList.querySelectorAll('input[type=checkbox]:not(:disabled)').length === 0
    }
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
  void openSettings().then((ready) => { if (ready && !settingsModal?.hidden) document.getElementById('software-update-settings')?.scrollIntoView({ block: 'center' }) })
})
window.addEventListener('online', () => { void window.aa.updateWake() })

/* ── 设置面板 ─────────────────────── */
const settingsBackground = new Map<HTMLElement, boolean>()
function isolateSettings(open: boolean): void {
  if (open) {
    for (const sibling of Array.from(settingsModal?.parentElement?.children ?? [])) {
      if (!(sibling instanceof HTMLElement) || sibling === settingsModal) continue
      if (!settingsBackground.has(sibling)) settingsBackground.set(sibling, sibling.inert)
      sibling.inert = true
    }
  } else {
    for (const [element, inert] of settingsBackground) element.inert = inert
    settingsBackground.clear()
  }
}
function currentSettingsRequest(request: number): boolean {
  return request === settingsRequest && !!settingsModal && !settingsModal.hidden
}

/** 先锁定再发 IPC；inert 也隔离更新/客户端按钮，不改它们自身的禁用规则。 */
function setSettingsReady(ready: boolean): void {
  settingsReady = ready
  for (const control of [setEngine, setEngineUrl, setLocale, setTheme, setFullSnapshot, setOpApproval, setIsolatedSessions, setRestoreSession, setAutoUpdate, setUpdateChannel, setDownloadDir, setAllowedSites]) {
    if (control) control.disabled = !ready
  }
  if (settingsBody) {
    settingsBody.inert = !ready
    settingsBody.setAttribute('aria-busy', String(!ready))
  }
  const save = document.getElementById('btn-save-settings') as HTMLButtonElement | null
  if (save) save.disabled = !ready
}

async function openSettings(): Promise<boolean> {
  if (!settingsModal) return false
  if (!settingsModal.hidden) return settingsReady
  const request = ++settingsRequest
  settingsReturnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : btnSettings
  setSettingsReady(false)
  btnClientSetup?.removeAttribute('aria-busy')
  if (setClientResult) setClientResult.textContent = ''
  clearTimeout(settingsStatusTimer)
  hideSuggest()
  if (dlPanel) dlPanel.hidden = true
  if (feedDrawer) feedDrawer.hidden = true
  settingsModal.hidden = false
  isolateSettings(true)
  document.getElementById('btn-close-settings')?.focus()
  if (settingsBody) settingsBody.scrollTop = 0
  if (settingsSections[0]) setActiveSettingsSection(settingsSections[0].id)
  if (settingsStatus) {
    settingsStatus.textContent = t('loading')
    settingsStatus.dataset['state'] = 'pending'
  }
  let view: SettingsView | null
  let agent: AgentInfo | null
  try {
    await window.aa.settingsOpen(true)
    if (!currentSettingsRequest(request)) return false
    const operation = ++settingsOperation
    view = await window.aa.settingsGet()
    adoptSavedSettings(view?.settings, operation)
    if (!currentSettingsRequest(request)) return false
    if (!view) throw new Error('Settings unavailable')
    agent = await window.aa.agentInfo().catch(() => null)
    if (!currentSettingsRequest(request)) return false
  } catch {
    if (currentSettingsRequest(request) && settingsStatus) {
      settingsStatus.textContent = uiText('设置加载失败，请关闭后重新打开。', 'Unable to load settings. Close and reopen to retry.')
      settingsStatus.dataset['state'] = 'error'
    }
    return false
  }
  if (setEngine) {
    setEngine.innerHTML = ''
    for (const p of view.presets) {
      const opt = document.createElement('option')
      opt.value = p.url
      opt.dataset['presetLabel'] = p.label
      opt.textContent = p.label
      setEngine.appendChild(opt)
    }
    const custom = document.createElement('option')
    custom.id = 'settings-engine-custom'
    custom.value = ''
    custom.textContent = t('customSearchAddress')
    setEngine.appendChild(custom)
    renderSearchPresetLabels()
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
  lastAgentInfo = agent
  hasAgentInfo = true
  applyLocale(savedLocale)
  setSettingsReady(true)
  if (settingsStatus) {
    settingsStatus.textContent = ''
    delete settingsStatus.dataset['state']
  }
  void refreshClients()
  renderUpdate(state.update)
  return true
}
function closeSettings(): void {
  if (!settingsModal || settingsModal.hidden) return
  ++settingsRequest
  clearTimeout(settingsStatusTimer)
  setSettingsReady(false)
  settingsModal.hidden = true
  isolateSettings(false)
  if (activeLocale !== savedLocale) applyLocale(savedLocale)
  if (activeThemeSetting !== savedThemeSetting) applyTheme(savedThemeSetting)
  void window.aa.settingsOpen(false).catch(() => { /* 关闭失败不阻止下次重新打开。 */ })
  const returnFocus = settingsReturnFocus
  settingsReturnFocus = null
  if (!focusIfPossible(returnFocus)) focusIfPossible(btnSettings)
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
  if (button.disabled || !settingsReady || !settingsModal || settingsModal.hidden) return
  const request = settingsRequest
  button.disabled = true
  clearTimeout(settingsStatusTimer)
  if (settingsStatus) {
    settingsStatus.textContent = t('saving')
    settingsStatus.dataset['state'] = 'pending'
  }
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
    const operation = ++settingsOperation
    const saved = await window.aa.settingsSet(patch)
    adoptSavedSettings(saved, operation)
    if (!currentSettingsRequest(request)) return
    if (!saved) throw new Error(uiText('设置未保存，请重试。', 'Settings were not saved. Please retry.'))
    if (settingsStatus) {
      settingsStatus.textContent = t('saved')
      settingsStatus.dataset['state'] = 'success'
      settingsStatusTimer = setTimeout(() => {
        if (currentSettingsRequest(request) && settingsStatus) {
          settingsStatus.textContent = ''
          delete settingsStatus.dataset['state']
        }
      }, 1800)
    }
  } catch (error) {
    if (currentSettingsRequest(request) && settingsStatus) {
      settingsStatus.textContent = `${t('saveFailed')}${error instanceof Error ? error.message : String(error)}`
      settingsStatus.dataset['state'] = 'error'
    }
  } finally {
    if (currentSettingsRequest(request) && settingsReady) button.disabled = false
  }
})

omnibox.addEventListener('keydown', (e) => {
  if (isComposingKey(e)) return
  if (e.key === 'Enter') {
    const v = omnibox.value.trim()
    if (v) void window.aa.submit(v)
    hideSuggest()
    omnibox.blur()
  } else if (e.key === 'Escape') {
    // 只有展开的建议消费 Esc；否则交给上层抽屉/查找条处理。
    if (suggestPanel && !suggestPanel.hidden) {
      e.preventDefault()
      e.stopPropagation()
      hideSuggest()
    } else {
      hideSuggest()
      omnibox.blur()
    }
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
  suggestList?.querySelectorAll<HTMLElement>('.suggest-item').forEach((x) => {
    x.classList.remove('selected')
    x.setAttribute('aria-selected', 'false')
  })
  el.classList.add('selected')
  el.setAttribute('aria-selected', 'true')
  el.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  omnibox.setAttribute('aria-activedescendant', el.id)
  const u = el.querySelector('.suggest-url')?.textContent
  if (u) {
    omnibox.value = u
    omnibox.setSelectionRange(u.length, u.length)
  }
}
omnibox.addEventListener('focus', () => {
  // 缩略显示不能作为导航输入；编辑时恢复协议、查询与 hash，但不暴露 URL 凭证。
  omnibox.value = editableUrl(activeTab()?.url ?? '')
  omnibox.select()
})
omnibox.addEventListener('blur', () => {
  // 只恢复地址；重绘工具栏会在 mousedown 和 click 之间替换审批/停止按钮。
  omnibox.value = shortenUrl(activeTab()?.url ?? '')
  setTimeout(() => {
    if (document.activeElement !== omnibox) hideSuggest()
  }, 120)
})
omnibox.addEventListener('input', onOmniboxInput)

window.aa.onState(applyState)
window.aa.onFocusOmnibox(() => {
  if (settingsModal && !settingsModal.hidden) return
  focusOmnibox()
})

/* 键盘快捷键（chrome UI 焦点时） */
window.addEventListener('keydown', (e) => {
  if (isComposingKey(e)) return
  const ctrl = e.ctrlKey || e.metaKey
  const modal = settingsModal
  const target = e.target instanceof HTMLElement ? e.target : null
  if (modal && !modal.hidden) {
    // 设置打开时快捷键留在模态内：只处理 Tab 环与 Esc 关闭，不触发背景标签操作。
    if (e.key === 'Escape') {
      e.preventDefault()
      closeSettings()
      return
    }
    if (e.key !== 'Tab') return
    const focusable = Array.from(modal.querySelectorAll<HTMLElement>('button, input, select, textarea, [tabindex]:not([tabindex="-1"])'))
      .filter((element) => element.tabIndex >= 0 && !element.matches(':disabled, [aria-disabled="true"]') && !element.closest('[hidden], [inert], [aria-hidden="true"]') && element.offsetParent !== null)
    if (focusable.length) {
      const current = focusable.indexOf(document.activeElement as HTMLElement)
      const next = e.shiftKey
        ? focusable[(current <= 0 ? focusable.length : current) - 1]
        : focusable[(current + 1) % focusable.length]
      e.preventDefault()
      next?.focus()
    }
    return
  }
  if (e.key === 'Escape') {
    hideSuggest()
    // Esc 只关最顶层浮层：抽屉 > 查找条，其余层级不动。
    if (drawerOpen('feed')) closeDrawer('feed')
    else if (drawerOpen('dl')) closeDrawer('dl')
    else if (state.find?.open) closeFind()
    return
  }
  // 普通编辑控件里的按键交给控件本身，避免 Ctrl+W/T/L 等改变背景浏览器状态。
  const editing = target?.closest('input, textarea, select, [contenteditable="true"]')
  if (editing && target !== omnibox && target !== findQuery) return
  if (ctrl && e.shiftKey && e.key.toLowerCase() === 't') {
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
    focusOmnibox()
  } else if (e.key === 'F5' || (ctrl && e.key.toLowerCase() === 'r')) {
    e.preventDefault()
    void window.aa.reload()
  } else if (ctrl && e.shiftKey && e.key.toLowerCase() === 'i') {
    e.preventDefault()
    void window.aa.devtools()
  }
})

/* 初始化读取也参与保存基线排序，不因打开/关闭过模态而丢失有效外观。 */
setSettingsReady(false)
const initialSettingsOperation = ++settingsOperation
void window.aa.settingsGet().then((view) => {
  adoptSavedSettings(view?.settings, initialSettingsOperation)
  if (!adoptedSettingsOperation) applyLocale(savedLocale)
}).catch(() => {
  if (adoptedSettingsOperation) return
  applyTheme(savedThemeSetting)
  applyLocale(savedLocale)
})
void window.aa.getState().then(applyState)
