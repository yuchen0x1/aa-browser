import type { TabInfo, UiState, DownloadInfo, HistoryEntry, AppSettings, SettingsView, AgentInfo, UpdateState, PagePointerForward, ExtensionInfo, BackgroundMode, MonitorState, AgentTaskRecord } from '@shared/types'
import { resolveLocale, translate, type Locale, type LocaleKey } from '@shared/locale'
import type { PlatformState, PlatformActionResult, PlatformWorkflow, ProfileView, ExtensionUpdateResult } from '@shared/platform-types'
import { APPROVAL_BAND_HEIGHT, CHROME_HEIGHT, FIND_BAR_HEIGHT, UPDATE_NOTICE_HEIGHT } from '@shared/layout'

document.documentElement.style.setProperty('--approval-band', `${APPROVAL_BAND_HEIGHT}px`)

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
  tasks?: AgentTaskRecord[]
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
      platformState: () => Promise<PlatformState>
      platformAction: (action: string, input?: Record<string, unknown>) => Promise<PlatformActionResult>
      tabNew: (url?: string) => Promise<void>
      tabClose: (id: string) => Promise<void>
      tabReopen: () => Promise<boolean>
      findOpen: () => Promise<void>
      find: (query: string, forward?: boolean, next?: boolean) => Promise<void>
      findClose: () => Promise<void>
      overlayHeight: (height: number) => Promise<void>
      forwardPagePointer: (payload: PagePointerForward) => void
      tabSelect: (id: string, focusPage?: boolean) => Promise<void>
      back: () => Promise<void>
      forward: () => Promise<void>
      reload: () => Promise<void>
      submit: (value: string) => Promise<void>
      devtools: () => Promise<void>
      windowMode: (mode?: BackgroundMode) => Promise<BackgroundMode>
      monitorStart: (tabId?: string) => Promise<MonitorState | null>
      monitorStop: () => Promise<MonitorState | null>
      monitorHistoryFrame: (capturedAt: number) => Promise<unknown>
      monitorView: (visible: boolean) => Promise<boolean>
      monitorTakeover: () => Promise<MonitorState | null>
      monitorRelease: () => Promise<MonitorState | null>
      taskAction: (action: 'pause' | 'resume' | 'cancel', id?: number, client?: number) => Promise<boolean>
      decideApproval: (id: string, allowed: boolean, remember?: boolean) => Promise<boolean>
      interruptAgent: () => Promise<boolean>
      takeoverAgent: () => Promise<boolean>
      resumeAgent: () => Promise<boolean>
      cancelAgentCall: (id: number, client?: number) => Promise<boolean>
      downloadsList: () => Promise<DownloadInfo[]>
      downloadOpen: (id: string) => Promise<{ ok: boolean; reason?: string }>
      downloadShow: (id: string) => Promise<void>
      downloadCancel: (id: string) => Promise<boolean>
      downloadRetry: (id: string) => Promise<{ ok: boolean; reason?: string }>
      downloadDir: () => Promise<string>
      historySuggest: (query: string, limit?: number) => Promise<HistoryEntry[]>
      settingsGet: () => Promise<SettingsView | null>
      settingsSet: (patch: Partial<AppSettings>) => Promise<AppSettings | null>
      settingsOpen: (open: boolean) => Promise<void>
      extensionPick: () => Promise<string>
      extensionList: (profileId?: string) => Promise<ExtensionInfo[]>
      extensionLoad: (dir: string, profileId?: string) => Promise<{ ok: boolean; error?: string; extension?: ExtensionInfo }>
      extensionRemove: (key: string, profileId?: string) => Promise<{ ok: boolean; error?: string; extension?: ExtensionInfo }>
      extensionEnable: (key: string, enabled: boolean, profileId?: string) => Promise<{ ok: boolean; error?: string }>
      extensionCheckUpdates: (profileId?: string) => Promise<ExtensionUpdateResult>
      agentInfo: () => Promise<AgentInfo | null>
      copyConnectionDiagnostics: () => Promise<boolean>
      clientsDetect: () => Promise<ClientDetectResult[]>
      clientsSetup: (ids: string[], locale?: Locale) => Promise<ClientSetupResult[]>
      updateCheck: () => Promise<UpdateState>
      updateDownload: () => Promise<UpdateState>
      updateInstall: () => Promise<boolean>
      updateDismiss: () => Promise<void>
      updateRetry: () => Promise<UpdateState>
      updateWake: () => Promise<UpdateState>
      onState: (cb: (state: UiState) => void) => void
      onMonitorFrame: (cb: (frame: unknown) => void) => void
      onFocusOmnibox: (cb: () => void) => void
      onFocusFind: (cb: () => void) => void
      onOpenExtensions: (cb: () => void) => void
        }
  }
}

let state: UiState = { tabs: [], activeId: null, agentCount: 0, agentVerifiedCount: 0, bridgeState: 'waiting', pendingApprovals: [], agentInterrupted: false, agentActivity: { active: false, paused: false } }
/** 用户正在编辑地址栏时，普通状态刷新不能覆盖草稿；真正切换标签仍应换成新地址。 */
let omniboxDirty = false
let omniboxEditTabId: string | null = null
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
const agentActivityTakeover = document.getElementById('agent-activity-takeover') as HTMLButtonElement | null
const agentActivityCalls = document.getElementById('agent-activity-calls') as HTMLElement | null
const approvalPanel = document.getElementById('approval-panel') as HTMLDivElement
const btnFeed = document.getElementById('btn-feed') as HTMLButtonElement | null
const btnMonitor = document.getElementById('btn-monitor') as HTMLButtonElement | null
const btnTasks = document.getElementById('btn-tasks') as HTMLButtonElement | null
const monitorPanel = document.getElementById('monitor-panel') as HTMLDivElement | null
const taskCenterPanel = document.getElementById('task-center-panel') as HTMLDivElement | null
const taskCenterStatus = document.getElementById('task-center-status') as HTMLSpanElement | null
const taskRunningList = document.getElementById('task-running-list') as HTMLDivElement | null
const taskHistoryList = document.getElementById('task-history-list') as HTMLDivElement | null
const btnCloseTasks = document.getElementById('btn-close-tasks') as HTMLButtonElement | null
const btnTaskPause = document.getElementById('btn-task-pause') as HTMLButtonElement | null
const btnTaskResume = document.getElementById('btn-task-resume') as HTMLButtonElement | null
const monitorFrame = document.getElementById('monitor-frame') as HTMLImageElement | null
const monitorMeta = document.getElementById('monitor-meta') as HTMLDivElement | null
const monitorStatus = document.getElementById('monitor-status') as HTMLSpanElement | null
const monitorHistory = document.getElementById('monitor-history') as HTMLDivElement | null
const btnCloseMonitor = document.getElementById('btn-close-monitor') as HTMLButtonElement | null
const btnMonitorTakeover = document.getElementById('btn-monitor-takeover') as HTMLButtonElement | null
const btnMonitorRelease = document.getElementById('btn-monitor-release') as HTMLButtonElement | null
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
const setBackgroundMode = document.getElementById('set-background-mode') as HTMLSelectElement | null
const setDownloadDir = document.getElementById('set-download-dir') as HTMLInputElement | null
const setAllowedSites = document.getElementById('set-allowed-sites') as HTMLTextAreaElement | null
const setAgentInfo = document.getElementById('set-agent-info')
const setAgentStatus = document.getElementById('set-agent-status')
const setAgentGuidance = document.getElementById('set-agent-guidance')
const copyDiagnostics = document.querySelector<HTMLButtonElement>('#btn-copy-connection-diagnostics')
const diagnosticsResult = document.getElementById('connection-diagnostics-result')
let diagnosticsCopying = false
let diagnosticsFeedback: 'copied' | 'failed' | null = null
let agentInfoRequest = 0
let lastClients: ClientDetectResult[] | null = null
/** 最近一次写入配置的结果；切换界面语言时按当前语言重绘状态徽标。 */
let lastClientSetupResults: ClientSetupResult[] | null = null
let lastClientSetupError = ''
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
const extensionList = document.getElementById('extension-list') as HTMLDivElement | null
const btnExtensionLoad = document.getElementById('btn-extension-load') as HTMLButtonElement | null
const btnExtensionRescan = document.getElementById('btn-extension-rescan') as HTMLButtonElement | null
const setExtensionResult = document.getElementById('set-extension-result') as HTMLDivElement | null
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

function cachedAppearance(key: 'aa.theme' | 'aa.locale'): string | null {
  try {
    return localStorage.getItem(key)
  } catch {
    return null
  }
}
function rememberAppearance(key: 'aa.theme' | 'aa.locale', value: string): void {
  try {
    localStorage.setItem(key, value)
  } catch {
    /* 隐私模式 / 存储禁用时仅失去首帧缓存 */
  }
}

const cachedLocale = cachedAppearance('aa.locale')
let savedLocale = cachedLocale === 'zh-CN' || cachedLocale === 'en-US' ? cachedLocale : resolveUiLocale()
let activeLocale = savedLocale
const t = (key: LocaleKey): string => translate(activeLocale, key)
const uiText = (zh: string, en: string): string => activeLocale === 'en-US' ? en : zh

type ThemeSetting = AppSettings['theme']
const cachedTheme = cachedAppearance('aa.theme')
let activeThemeSetting: ThemeSetting = 'dark'
let savedThemeSetting: ThemeSetting =
  cachedTheme === 'light' || cachedTheme === 'dark' || cachedTheme === 'system' ? cachedTheme : 'dark'
const systemThemeMedia = window.matchMedia?.('(prefers-color-scheme: dark)')
function resolveUiTheme(setting: ThemeSetting = 'dark'): 'light' | 'dark' {
  if (setting === 'dark') return 'dark'
  if (setting === 'system') return systemThemeMedia?.matches ? 'dark' : 'light'
  return 'light'
}
function applyTheme(setting: ThemeSetting = 'dark'): void {
  activeThemeSetting = setting
  const resolved = resolveUiTheme(setting)
  document.documentElement.dataset.theme = resolved
  document.documentElement.style.colorScheme = resolved
  rememberAppearance('aa.theme', setting)
}
applyTheme(savedThemeSetting)
systemThemeMedia?.addEventListener('change', () => {
  if (activeThemeSetting === 'system') applyTheme('system')
})

/** 保存基线独立于模态生命周期；迟到响应可更新基线，但不能倒退或覆盖当前预览。 */
function adoptSavedSettings(settings: AppSettings | null | undefined, operation: number): void {
  if (!settings || operation <= adoptedSettingsOperation) return
  adoptedSettingsOperation = operation
  savedLocale = resolveUiLocale(settings.locale)
  savedThemeSetting = settings.theme || 'dark'
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
  rememberAppearance('aa.locale', locale)
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
  setText('settings-nav-extensions', 'settingsNavExtensions')
  setText('settings-nav-update', 'softwareUpdate')
  setText('settings-head-general', 'settingsNavGeneral')
  setText('settings-head-browsing', 'settingsNavBrowsing')
  setText('settings-head-data', 'settingsNavData')
  setText('settings-head-ai', 'settingsNavAi')
  setText('settings-head-extensions', 'settingsNavExtensions')
  setText('settings-desc-general', 'settingsDescGeneral')
  setText('settings-desc-browsing', 'settingsDescBrowsing')
  setText('settings-desc-data', 'settingsDescData')
  setText('settings-desc-ai', 'settingsDescAi')
  setText('settings-desc-extensions', 'settingsDescExtensions')
  setText('settings-desc-update', 'settingsDescUpdate')
  setText('settings-theme-label', 'theme')
  setText('settings-theme-light', 'themeLight')
  setText('settings-theme-dark', 'themeDark')
  setText('settings-theme-system', 'themeSystem')
  const lightTheme = document.getElementById('settings-theme-light'); if (lightTheme) lightTheme.textContent = uiText('浅色', 'Light')
  const darkTheme = document.getElementById('settings-theme-dark'); if (darkTheme) darkTheme.textContent = uiText('深色（默认）', 'Dark (default)')
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
  setText('settings-background-mode-label', 'backgroundMode')
  setText('settings-background-mode-hint', 'backgroundModeHint')
  const taskTitle = document.getElementById('task-center-title')
  const taskHistoryHeading = document.querySelector('.task-history-heading')
  const monitorTitle = document.getElementById('monitor-title')
  if (taskTitle) taskTitle.textContent = uiText('后台任务中心', 'Background tasks')
  if (taskHistoryHeading) taskHistoryHeading.textContent = uiText('最近任务', 'Recent tasks')
  if (taskCenterStatus && !state.agentActivity?.active && !state.agentActivity?.paused) taskCenterStatus.textContent = uiText('空闲', 'Idle')
  if (btnTaskPause) btnTaskPause.textContent = uiText('暂停全部', 'Pause all')
  if (btnTaskResume) btnTaskResume.textContent = uiText('恢复全部', 'Resume all')
  if (monitorTitle) monitorTitle.textContent = uiText('后台实时预览', 'Background preview')
  if (btnMonitorTakeover) btnMonitorTakeover.textContent = uiText('人工接管', 'Take over')
  if (btnMonitorRelease) btnMonitorRelease.textContent = uiText('交还 AI', 'Return to AI')
  if (btnTasks) {
    btnTasks.title = uiText('后台任务', 'Background tasks')
    btnTasks.setAttribute('aria-label', uiText('打开后台任务中心', 'Open background task center'))
  }
  if (btnMonitor) {
    btnMonitor.title = uiText('后台实时预览', 'Background live preview')
    btnMonitor.setAttribute('aria-label', uiText('打开后台实时预览', 'Open background live preview'))
  }
  if (setBackgroundMode) {
    const labels: Record<string, [string, string]> = {
      visible: ['可见（前台）', 'Visible (foreground)'],
      background: ['后台（不抢焦点）', 'Background (no focus steal)'],
      minimized: ['最小化', 'Minimized'],
      hidden: ['隐藏', 'Hidden'],
      'background-visual': ['后台 + 实时预览', 'Background + live preview']
    }
    for (const option of Array.from(setBackgroundMode.options)) option.textContent = labels[option.value]?.[activeLocale === 'en-US' ? 1 : 0] ?? option.value
  }
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
  setText('settings-extensions-label', 'extensionsLabel')
  setText('settings-extensions-hint', 'extensionsHint')
  const extensionHint = document.getElementById('settings-extensions-hint')
  if (extensionHint) extensionHint.textContent = uiText('扩展仅加载到所选配置文件。启用或禁用后，请重新加载受影响的网页。', 'Extensions load only in the selected profile. Reload affected pages after enabling or disabling them.')
  setText('btn-extension-load', 'extensionsLoad')
  setText('btn-extension-rescan', 'extensionsRescan')
  setText('set-agent-details-label', 'connectionDetails')
  setText('btn-copy-connection-diagnostics', 'copyConnectionDiagnostics')
  setText('connection-diagnostics-hint', 'connectionDiagnosticsHint')
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
  if (lastExtensions) renderExtensionList()
  renderToolbar(); renderFind(); renderUpdate(state.update)
  renderDownloads()
  renderAgentActivity()
  renderClientSetupResult()
  const feedTitle = document.getElementById('feed-title')
  if (feedTitle) feedTitle.textContent = uiText('Agent 实时活动日志', 'Agent activity log')
  const downloadTitle = document.getElementById('download-title')
  if (downloadTitle) downloadTitle.textContent = uiText('下载记录', 'Download history')
  const closeFeed = document.getElementById('btn-close-feed')
  if (closeFeed) closeFeed.setAttribute('aria-label', uiText('关闭 Agent 活动记录', 'Close agent activity log'))
  const closeDownloads = document.getElementById('btn-close-dl')
  if (closeDownloads) closeDownloads.setAttribute('aria-label', uiText('关闭下载列表', 'Close download list'))
  renderPlatformLocale()
}

function renderFind(): void {
  const find = state.find
  const wasHidden = findBar.hidden
  const hadFocus = findBar.contains(document.activeElement)
  findBar.hidden = !find?.open
  btnReopen.disabled = !state.canReopenClosed
  document.documentElement.style.setProperty('--find-height', find?.open ? `${FIND_BAR_HEIGHT}px` : '0px')
  document.documentElement.style.setProperty('--page-top', `${CHROME_HEIGHT + (state.update?.noticeVisible ? UPDATE_NOTICE_HEIGHT : 0) + (find?.open ? FIND_BAR_HEIGHT : 0) + (state.pendingApprovals.length ? APPROVAL_BAND_HEIGHT : 0)}px`)
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
    // 预览面板同样挂在外壳视图内；不参与高度上报会被工具栏高度裁切。
    const panels = [suggestPanel, dlPanel, feedDrawer, monitorPanel, taskCenterPanel]
    const extent = Math.ceil(Math.max(0, ...panels.filter((el) => el && !el.hidden).map((el) => el!.getBoundingClientRect().bottom + 8)))
    if (extent !== previousExtent) {
      previousExtent = extent
      void window.aa.overlayHeight(extent)
    }
    btnDownloads?.setAttribute('aria-expanded', String(!dlPanel?.hidden))
    btnFeed?.setAttribute('aria-expanded', String(!feedDrawer?.hidden))
    btnMonitor?.setAttribute('aria-expanded', String(!monitorPanel?.hidden))
  })
}
const overlayObserver = new MutationObserver(syncOverlayExtent)
const overlayResize = new ResizeObserver(syncOverlayExtent)
for (const panel of [suggestPanel, dlPanel, feedDrawer, monitorPanel, taskCenterPanel]) {
  if (!panel) continue
  overlayObserver.observe(panel, { attributes: true, attributeFilter: ['hidden'], childList: true, subtree: true })
  overlayResize.observe(panel)
}
window.addEventListener('resize', syncOverlayExtent)

/* ── 活动 HUD 期间处理页面区域的指针事件 ─────────────────────
 * 活动 HUD 会把外壳视图展开到整窗，透明视图仍参与命中测试，而页面视图在外壳
 * 下面，所以网页收不到点击/滚轮。
 *
 * AI 正在操作时页面默认只读：第一次点击页面不会落到网页上，而是暂停 AI 并把
 * 操作权交给用户，避免误点链接导致整页跳转、打断 Agent。只有接管/中断后
 * （paused）才把页面区域的指针事件转发给网页。主进程校验坐标并换算成页面
 * 视图坐标。 */
let pointerMoveFrame = 0
let pendingPointerMove: { x: number; y: number } | null = null
/** 触发接管的 mousedown 对应的 mouseup 也不能落到网页，否则会形成一次“半击”。 */
let swallowNextMouseUp = false
let swallowMouseUpTimer: number | undefined

function overlayCoversPage(): boolean {
  const activity = state.agentActivity
  const activeOrPaused = !!activity && (activity.active || activity.paused)
  if (!activeOrPaused && !state.agentInterrupted) return false
  return !(settingsModal && !settingsModal.hidden)
}

function pageTopPx(): number {
  const raw = document.documentElement.style.getPropertyValue('--page-top')
  const value = Number.parseFloat(raw)
  return Number.isFinite(value) ? value : 84
}

function isHudCardTarget(target: EventTarget | null): boolean {
  return target instanceof Element && !!target.closest('#agent-activity-card')
}

/** 指针是否落在网页区域（而不是工具栏、HUD 卡片）。 */
function isPagePointer(event: MouseEvent | WheelEvent): boolean {
  return overlayCoversPage() && !isHudCardTarget(event.target) && event.clientY > pageTopPx()
}

/** AI 正在控制页面：点击先接管，避免误触网页。 */
function aiOwnsPage(): boolean {
  const activity = state.agentActivity
  return !!activity && activity.active === true && activity.paused !== true && !state.agentInterrupted
}

function takeOverPage(): void {
  if (swallowNextMouseUp) return
  swallowNextMouseUp = true
  if (swallowMouseUpTimer !== undefined) window.clearTimeout(swallowMouseUpTimer)
  // 1.2 秒内没有等到 mouseup（例如在窗口外松开）就自动解除，避免吞掉下一次点击。
  swallowMouseUpTimer = window.setTimeout(() => {
    swallowNextMouseUp = false
    swallowMouseUpTimer = undefined
  }, 1200)
  void window.aa.takeoverAgent()
}

/** paused 时才把页面事件转发给网页；active 时点击用于接管。 */
function shouldForwardPointer(event: MouseEvent | WheelEvent): boolean {
  return isPagePointer(event) && !aiOwnsPage()
}

function forwardPointer(event: MouseEvent | WheelEvent, type: PagePointerForward['type']): void {
  const payload: PagePointerForward = { type, x: event.clientX, y: event.clientY }
  if (event instanceof WheelEvent) {
    // 主进程按像素投递 wheel；行/页模式的 delta 需要先换算。
    const unit = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? (window.innerHeight || 800) : 1
    payload.deltaX = event.deltaX * unit
    payload.deltaY = event.deltaY * unit
  } else if (type === 'mouseDown' || type === 'mouseUp') {
    payload.button = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left'
    payload.clickCount = Math.max(1, Math.min(3, event.detail || 1))
  }
  window.aa.forwardPagePointer(payload)
}

document.addEventListener('mousedown', (event) => {
  if (!isPagePointer(event)) return
  if (aiOwnsPage()) {
    // 第一次点击只接管，不能落到网页上，否则会误触链接/提交。
    event.preventDefault()
    event.stopImmediatePropagation()
    takeOverPage()
    return
  }
  if (!shouldForwardPointer(event)) return
  event.preventDefault()
  forwardPointer(event, 'mouseDown')
}, true)
document.addEventListener('mouseup', (event) => {
  if (swallowNextMouseUp) {
    event.preventDefault()
    event.stopImmediatePropagation()
    swallowNextMouseUp = false
    if (swallowMouseUpTimer !== undefined) {
      window.clearTimeout(swallowMouseUpTimer)
      swallowMouseUpTimer = undefined
    }
    return
  }
  if (!shouldForwardPointer(event)) return
  event.preventDefault()
  forwardPointer(event, 'mouseUp')
}, true)
document.addEventListener('mousemove', (event) => {
  if (!shouldForwardPointer(event)) return
  pendingPointerMove = { x: event.clientX, y: event.clientY }
  if (pointerMoveFrame) return
  pointerMoveFrame = requestAnimationFrame(() => {
    pointerMoveFrame = 0
    const point = pendingPointerMove
    pendingPointerMove = null
    if (point) window.aa.forwardPagePointer({ type: 'mouseMove', x: point.x, y: point.y })
  })
}, true)
document.addEventListener('wheel', (event) => {
  if (!isPagePointer(event)) return
  if (aiOwnsPage()) {
    // 页面锁定期间也不滚动页面，避免 AI 的坐标基准被用户滚动改变。
    event.preventDefault()
    return
  }
  if (!shouldForwardPointer(event)) return
  event.preventDefault()
  forwardPointer(event, 'mouseWheel')
}, { capture: true, passive: false })

function formatUpdateBytes(value?: number): string {
  if (!value || value < 1024) return value ? `${value} B` : uiText('未知大小', 'Unknown size')
  const units = ['KB', 'MB', 'GB']
  let n = value / 1024
  let i = 0
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++ }
  return `${n.toFixed(n >= 10 ? 0 : 1)} ${units[i]}`
}

function shortUpdateError(error: string | undefined, max = 160): string {
  if (!error) return ''
  const oneLine = error.replace(/\s+/g, ' ').trim()
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine
}

function renderUpdate(update?: UpdateState): void {
  if (!updateStatus || !update) return
  const labels: Record<UpdateState['status'], string> = {
    disabled: activeLocale === 'en-US' ? 'Updates disabled in development' : '开发模式不检查更新', idle: `${t('currentVersion')} ${update.currentVersion}`, checking: activeLocale === 'en-US' ? 'Checking for updates…' : '正在检查更新…',
    'up-to-date': activeLocale === 'en-US' ? `Already up to date (${update.currentVersion})` : `已是最新版本（${update.currentVersion}）`, available: activeLocale === 'en-US' ? `New version ${update.version ?? ''} found` : `发现新版本 ${update.version ?? ''}`,
    downloading: activeLocale === 'en-US' ? `Downloading ${update.version ?? ''} · ${Math.max(0, Math.round(update.progress ?? 0))}%` : `正在下载 ${update.version ?? ''} · ${Math.max(0, Math.round(update.progress ?? 0))}%`,
    downloaded: activeLocale === 'en-US' ? `${update.version ?? ''} downloaded; restart to install` : `已下载 ${update.version ?? ''}，可以重启安装`, error: uiText('更新失败', 'Update failed')
  }
  const shortError = update.status === 'error' ? shortUpdateError(update.error) : ''
  updateStatus.textContent = shortError ? `${labels[update.status]}：${shortError}` : labels[update.status]
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
  document.documentElement.style.setProperty('--notice-height', update.noticeVisible ? `${UPDATE_NOTICE_HEIGHT}px` : '0px')
  updateNotice.classList.toggle('error', update.status === 'error')
  const failedOperation = { check: ['check', '检查'], download: ['download', '下载'], install: ['installation', '安装'] }[update.failedOperation ?? 'check']
  const noticeBase = update.status === 'downloaded' ? (activeLocale === 'en-US' ? `${update.version} downloaded. Restart to install.` : `新版 ${update.version} 已下载完成，重启即可安装。`) : update.status === 'available' ? (activeLocale === 'en-US' ? `Version ${update.version} is available; current version is ${update.currentVersion}.` : `发现新版本 ${update.version}，当前为 ${update.currentVersion}。`) : update.status === 'error' ? (activeLocale === 'en-US' ? `Update ${failedOperation[0]} failed. ${update.retryAt ? 'It will retry automatically.' : 'Retry now or review settings.'}` : `更新${failedOperation[1]}失败，${update.retryAt ? '将自动重试，也可立即重试。' : '点击重试或在设置中查看原因。'}`) : labels[update.status]
  const errorSuffix = update.status === 'error' && shortError ? (activeLocale === 'en-US' ? ` (${shortError})` : `（${shortError}）`) : ''
  updateNoticeText.textContent = `${noticeBase}${errorSuffix}`
  updateNoticeText.title = update.status === 'error' && update.error ? update.error : ''
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

let renderedTabs: readonly TabInfo[] = []
let renderedTabLocale: Locale | undefined

/** 标签条溢出时，新建/激活的标签可能在可视区外；渲染后把它滚进来。 */
function revealActiveTab(): void {
  requestAnimationFrame(() => {
    const active = tabsEl.querySelector<HTMLElement>('.tab.active')
    active?.scrollIntoView({ block: 'nearest', inline: 'nearest' })
  })
}

/** 按 id 复用标签和关闭按钮，迟到的标题/图标更新也不能打断键盘焦点。 */
function renderTabs(): void {
  const next = state.tabs
  const sameTabs = renderedTabLocale === activeLocale && renderedTabs.length === next.length && next.every((tab, i) => {
    const previous = renderedTabs[i]
    return previous.id === tab.id && previous.title === tab.title && previous.url === tab.url &&
      previous.favicon === tab.favicon && previous.loading === tab.loading && previous.isolated === tab.isolated &&
      previous.agentClientId === tab.agentClientId
  })
  const previous = renderedTabs
  renderedTabs = next
  renderedTabLocale = activeLocale
  if (sameTabs) {
    for (const [i, tab] of next.entries()) {
      if (tab.active === previous[i].active) continue
      const el = tabsEl.children[i] as HTMLElement
      el.classList.toggle('active', tab.active)
      el.setAttribute('aria-selected', String(tab.active))
      el.tabIndex = tab.active ? 0 : -1
      const close = el.querySelector<HTMLButtonElement>('.close')
      if (close) close.tabIndex = el.tabIndex
    }
    revealActiveTab()
    return
  }
  const existing = new Map(Array.from(tabsEl.children, (node) => [(node as HTMLElement).dataset.tabId, node as HTMLElement]))
  const previousById = new Map(previous.map((tab) => [tab.id, tab]))
  const keep = new Set(next.map((tab) => tab.id))
  const focused = document.hasFocus() && tabsEl.contains(document.activeElement) ? document.activeElement as HTMLElement : null
  for (const [id, node] of existing) if (!id || !keep.has(id)) node.remove()
  for (const [index, t] of next.entries()) {
    let el = existing.get(t.id)
    if (!el) {
      el = document.createElement('div')
      el.setAttribute('role', 'tab')
      el.dataset.tabId = t.id
      el.dataset.focusKey = `tab:${t.id}`
      const fav = document.createElement('div')
      fav.className = 'favicon'
      const title = document.createElement('span')
      title.className = 'title'
      const close = document.createElement('button')
      close.className = 'close'
      close.dataset.focusKey = `tab-close:${t.id}`
      close.textContent = '×'
      close.addEventListener('click', (e) => {
        e.stopPropagation()
        void window.aa.tabClose(t.id)
      })
      el.append(fav, title, close)
      el.addEventListener('mousedown', (e) => {
        if (e.button === 1) {
          e.preventDefault()
          void window.aa.tabClose(t.id)
        }
      })
      el.addEventListener('click', () => void window.aa.tabSelect(t.id))
    }
    el.className = 'tab' + (t.active ? ' active' : '')
    el.title = `${t.title}\n${t.url}${t.isolated ? `\n${uiText('（隔离会话：不共享登录态）', '(Isolated session: sign-in state is not shared)')}` : ''}${t.agentClientId === undefined ? '' : `\nAgent #${t.agentClientId}`}`
    el.setAttribute('aria-selected', String(t.active))
    el.tabIndex = t.active ? 0 : -1

    const fav = el.querySelector<HTMLElement>('.favicon')
    const title = el.querySelector<HTMLElement>('.title')
    const close = el.querySelector<HTMLButtonElement>('.close')
    if (!fav || !title || !close) throw new Error(`Invalid tab chrome: ${t.id}`)
    const before = previousById.get(t.id)
    if (!before || before.loading !== t.loading || before.favicon !== t.favicon) {
      fav.replaceChildren()
      fav.className = 'favicon'
      if (t.loading) {
        const dot = document.createElement('div')
        dot.className = 'dot'
        fav.appendChild(dot)
      } else if (t.favicon && /^https?:|^data:/i.test(t.favicon)) {
        const img = document.createElement('img')
        img.src = t.favicon
        img.onerror = () => {
          if (img.parentElement !== fav) return
          img.remove()
          fav.textContent = '•'
          fav.classList.add('favicon-fallback')
        }
        fav.appendChild(img)
      } else {
        fav.textContent = '•'
        fav.classList.add('favicon-fallback')
      }
    }

    title.textContent = t.title || uiText('无标题', 'Untitled')
    // 只有活动标签的关闭按钮进入 Tab 顺序；非活动标签仍可鼠标点击。
    close.tabIndex = el.tabIndex
    close.title = uiText('关闭标签页 (Ctrl+W)', 'Close tab (Ctrl+W)')
    close.setAttribute('aria-label', `${uiText('关闭标签页：', 'Close tab: ')}${t.title || uiText('无标题', 'Untitled')}`)

    let owner = el.querySelector<HTMLElement>('.tab-owner')
    if (t.agentClientId !== undefined) {
      owner ??= document.createElement('span')
      owner.className = 'tab-owner'
      owner.textContent = `A${t.agentClientId}`
      owner.title = uiText(`Agent 会话 ${t.agentClientId}`, `Agent session ${t.agentClientId}`)
      owner.setAttribute('aria-label', owner.title)
      if (!owner.parentElement) el.insertBefore(owner, close)
    } else owner?.remove()

    // 隔离会话标签带锁标识：用户必须能一眼看出哪些标签不共享登录态
    let lock = el.querySelector<HTMLElement>('.tab-lock')
    if (t.isolated) {
      lock ??= document.createElement('span')
      lock.className = 'tab-lock'
      lock.textContent = '🔒'
      lock.title = uiText('隔离会话：不共享 Cookie / 登录态，关闭后清除数据', 'Isolated session: cookies and sign-in are not shared and data is cleared on close')
      lock.setAttribute('aria-label', uiText('隔离会话标签', 'Isolated session tab'))
      if (!lock.parentElement) el.insertBefore(lock, close)
      el.classList.add('isolated')
    } else lock?.remove()

    const position = tabsEl.children.item(index)
    if (position !== el) tabsEl.insertBefore(el, position)
  }
  if (focused?.isConnected && document.hasFocus() && document.activeElement === document.body) focused.focus()
  revealActiveTab()
}

let agentActivityTimer: ReturnType<typeof setInterval> | undefined

/** 并发调用列表：每个调用独立显示进度，并可单独停止（不影响其他客户端）。 */
function renderAgentCallList(activity: AgentActivityState, paused: boolean): void {
  if (!agentActivityCalls) return
  const calls = paused ? [] : (activity.calls ?? [])
  agentActivityCalls.hidden = calls.length === 0
  // 按 (client, id) 复用行：进度推送很频繁，整表重建会让用户按下鼠标后
  // 的 click 落到新节点的另一行，从而停止错误的调用。
  const existing = new Map<string, HTMLElement>()
  for (const row of Array.from(agentActivityCalls.querySelectorAll<HTMLElement>('.agent-call-row'))) {
    existing.set(`${row.dataset['client']}:${row.dataset['callId']}`, row)
  }
  agentActivityCalls.querySelectorAll('.agent-call-more').forEach((node) => { node.remove() })
  const keep = new Set<string>()
  let position = 0
  for (const call of calls.slice(0, 6)) {
    const key = `${call.client}:${call.id}`
    keep.add(key)
    let row = existing.get(key)
    if (!row) {
      row = document.createElement('div')
      row.className = 'agent-call-row'
      row.dataset['callId'] = String(call.id)
      row.dataset['client'] = String(call.client)

      const label = document.createElement('span')
      label.className = 'agent-call-label'
      label.textContent = `#${call.id} · ${uiText('客户端', 'Client')} ${call.client} · ${call.tool}`
      row.appendChild(label)

      const detail = document.createElement('span')
      detail.className = 'agent-call-detail'
      row.appendChild(detail)

      const stop = document.createElement('button')
      stop.type = 'button'
      stop.className = 'agent-call-stop'
      stop.dataset['focusKey'] = `call-stop:${call.client}:${call.id}`
      stop.textContent = uiText('停止', 'Stop')
      stop.title = uiText(`只停止客户端 ${call.client} 的调用 #${call.id}`, `Stop client ${call.client} call #${call.id} only`)
      stop.setAttribute('aria-label', stop.title)
      stop.addEventListener('click', () => void window.aa.cancelAgentCall(call.id, call.client))
      row.appendChild(stop)
    }
    const detail = row.querySelector<HTMLElement>('.agent-call-detail')
    if (detail) {
      if (call.message) detail.textContent = call.message
      else if (typeof call.progress === 'number' && typeof call.total === 'number' && call.total > 0) {
        detail.textContent = `${Math.round((call.progress / call.total) * 100)}%`
      } else {
        detail.textContent = ''
      }
    }
    // 顺序未变时不要移动节点：appendChild 会先摘除再插入，正在聚焦的“停止”按钮会因此失焦。
    const target = agentActivityCalls.children[position] ?? null
    if (target !== row) agentActivityCalls.insertBefore(row, target)
    position++
  }
  for (const [key, row] of existing) {
    if (!keep.has(key)) row.remove()
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
  const human = state.monitor?.control === 'human'
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

  if (agentActivityTitle) {
    agentActivityTitle.textContent = paused
      ? human ? uiText('你已接管网页操作', 'You have taken over') : uiText('AI 操作已暂停', 'AI operation paused')
      : uiText('AI 工具正在操作中', 'AI tool is working')
  }
  const callCount = activity.calls?.length ?? 0
  if (agentActivityTool) {
    agentActivityTool.textContent = paused
      ? human ? uiText('AI 已暂停，网页现在可以点击', 'AI paused; the page is yours') : uiText('等待 AI 恢复…', 'Waiting for AI to resume…')
      : activity.tool
        ? `${uiText('工具：', 'Tool: ')}${activity.tool}${callCount > 1 ? uiText(`（共 ${callCount} 个并发调用）`, ` (${callCount} concurrent calls)`) : ''}`
        : uiText('正在准备浏览器操作…', 'Preparing browser action…')
  }
  renderAgentCallList(activity, paused)
  if (agentActivityTakeover) {
    agentActivityTakeover.hidden = paused
    agentActivityTakeover.textContent = uiText('接管页面', 'Take over')
    agentActivityTakeover.title = uiText('暂停 AI，把网页操作权交给你；操作完点「继续 AI」', 'Pause AI and take control of the page; select “Resume AI” when done')
    agentActivityTakeover.setAttribute('aria-label', agentActivityTakeover.title)
  }
  if (agentActivityAction) {
    agentActivityAction.textContent = paused ? uiText('继续 AI', 'Resume AI') : t('interrupt')
    agentActivityAction.title = paused
      ? uiText('恢复 AI 的浏览器操作', 'Resume AI browser actions now')
      : uiText('中断 AI 的当前操作（30 秒后自动继续）', 'Interrupt current AI actions (auto-resume in 30s)')
    agentActivityAction.setAttribute('aria-label', agentActivityAction.title)
  }

  const updateCountdown = (): void => {
    const resumeAt = activity.resumeAt
    const remaining = resumeAt ? Math.max(0, Math.ceil((resumeAt - Date.now()) / 1000)) : 0
    if (agentActivityDetail) {
      agentActivityDetail.textContent = paused
        ? human
          ? uiText('你已接管网页操作 · 完成后点「继续 AI」', 'You have control · select “Resume AI” when done')
          : resumeAt
            ? remaining > 0 ? uiText(`已中断，${remaining} 秒后自动继续`, `Interrupted; continuing in ${remaining}s`) : uiText('已中断，等待自动继续…', 'Interrupted; waiting to continue…')
            : uiText('已暂停，等待手动恢复', 'Paused; resume manually')
        : uiText('AI 正在操作 · 点击网页可接管', 'AI is working · click the page to take over')
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
  const waiting = !connected && (state.bridgeState === 'starting' || state.bridgeState === 'waiting' || state.agentCount > 0)
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

let knownApprovalIds = new Set<string>()

function renderApprovals(): void {
  const pending = state.pendingApprovals ?? []
  approvalPanel.inert = !!settingsModal && !settingsModal.hidden && pending.length === 0
  if (settingsModal) settingsModal.inert = pending.some((item) => item.kind !== 'sensitive')
  approvalPanel.hidden = pending.length === 0
  approvalPanel.textContent = ''
  // 一次只展示最早的一条：按钮固定在底部，不随说明文字滚出视野；处理完自动显示下一条。
  const item = pending[0]
  if (item) {
    const isOp = item.kind === 'operation'
    const isPermission = item.kind === 'permission'
    const body = document.createElement('div')
    body.className = 'approval-body'
    const title = document.createElement('div')
    title.className = 'approval-title'
    title.id = 'approval-title'
    title.textContent = isPermission ? uiText('网站请求设备权限', 'Website requests device permission') : isOp ? uiText('Agent 请求执行高危操作', 'Agent requests a high-risk action') : uiText('需要你亲自填写敏感信息', 'Sensitive information requires your input')
    const meta = document.createElement('div')
    meta.className = 'approval-meta'
    meta.textContent = `${uiText('网站：', 'Site: ')}${item.site} · ${uiText('标签：', 'Tab: ')}${item.tabTitle} · ${uiText('操作：', 'Action: ')}${item.fieldLabel}`
    const help = document.createElement('div')
    help.className = 'approval-help'
    help.id = 'approval-help'
    help.textContent = isPermission
      ? (item.detail || uiText('允许后该站点仅在本次浏览器会话内可使用此权限；拒绝则保持阻断。', 'After allowing, this site may use the permission only in this browser session; denying keeps it blocked.'))
      : isOp
        ? (item.detail || uiText('Agent 即将执行此操作。请确认后点“允许”，拒绝则中止该步骤。', 'The Agent is about to perform this action. Confirm with “Allow”; denying stops the step.'))
        : uiText('请直接在网页输入框中填写内容；敏感内容不会由 Agent 写入或回传。填写完成后再点“允许继续”。', 'Enter the value directly in the webpage; sensitive content is never written or returned by the Agent. Select “Continue” when finished.')
    body.append(title, meta, help)
    if (pending.length > 1) {
      const count = document.createElement('div')
      count.className = 'approval-count'
      count.textContent = uiText(`待确认 1 / ${pending.length}，处理完自动显示下一条`, `1 of ${pending.length} pending; the next request appears after this one`)
      body.appendChild(count)
    }

    const actions = document.createElement('div')
    actions.className = 'approval-actions'
    let remember: HTMLInputElement | null = null
    if (isOp && item.rememberable) {
      const rememberLabel = document.createElement('label')
      rememberLabel.className = 'approval-remember'
      rememberLabel.title = uiText('仅对同一页面上的同一操作生效；浏览器退出后失效。取消勾选则下次仍会询问。', 'Applies only to this exact action on this page for the current browser session. Uncheck to be asked again next time.')
      remember = document.createElement('input')
      remember.type = 'checkbox'
      remember.checked = true
      remember.dataset['focusKey'] = `approval-remember:${item.id}`
      const rememberText = document.createElement('span')
      rememberText.textContent = uiText('本会话内相同操作自动允许', 'Auto-allow this same action for this session')
      rememberLabel.append(remember, rememberText)
      actions.appendChild(rememberLabel)
    }
    const buttons = document.createElement('div')
    buttons.className = 'approval-buttons'
    const deny = document.createElement('button')
    deny.className = 'approval-deny'
    deny.dataset['focusKey'] = `approval-deny:${item.id}`
    deny.textContent = uiText('拒绝', 'Deny')
    deny.addEventListener('click', () => void window.aa.decideApproval(item.id, false))
    const allow = document.createElement('button')
    allow.className = 'approval-allow'
    allow.dataset['focusKey'] = `approval-allow:${item.id}`
    allow.textContent = isOp || isPermission ? uiText('允许', 'Allow') : uiText('允许继续', 'Continue')
    allow.addEventListener('click', () => void window.aa.decideApproval(item.id, true, remember?.checked === true))
    buttons.append(deny, allow)
    actions.appendChild(buttons)
    approvalPanel.append(body, actions)
    // 新审批到达时把焦点移到“允许”按钮，屏幕阅读器可立即读到 alertdialog；
    // 敏感输入例外：焦点应留在网页输入框，由用户亲自填写。队列中后续请求不抢焦点，
    // 避免用户仍按着 Enter 时误批准下一条高危操作。
    if (!knownApprovalIds.has(item.id) && item.kind !== 'sensitive' && document.hasFocus()) {
      requestAnimationFrame(() => {
        approvalPanel
          .querySelector<HTMLButtonElement>(`[data-focus-key="approval-allow:${CSS.escape(item.id)}"]`)
          ?.focus({ preventScroll: true })
      })
    }
  }
  knownApprovalIds = new Set(pending.map((entry) => entry.id))
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

interface MonitorFramePayload {
  tabId: string
  url: string
  title: string
  capturedAt: number
  width: number
  height: number
  image: string
  currentTask?: string
  pointer?: { kind: string; x?: number; y?: number }
}

function renderMonitor(): void {
  if (!monitorPanel) return
  const monitor = state.monitor
  const enabled = !!monitor?.enabled
  btnMonitor?.classList.toggle('is-active', enabled)
  if (monitorStatus) {
    const status = monitor?.control === 'human'
      ? uiText('人工接管中（AI 已锁定）', 'Human takeover (AI locked)')
      : monitor?.status === 'error'
        ? uiText('预览错误', 'Preview error')
        : enabled ? uiText(`预览中 · 标签 ${monitor?.tabId ?? ''}`, `Previewing · tab ${monitor?.tabId ?? ''}`) : uiText('未开启', 'Off')
    monitorStatus.textContent = status
  }
  if (btnMonitorTakeover) btnMonitorTakeover.hidden = monitor?.control === 'human'
  if (btnMonitorRelease) btnMonitorRelease.hidden = monitor?.control !== 'human'
  if (monitorHistory) {
    monitorHistory.textContent = ''
    for (const item of (monitor?.history ?? []).slice(-8).reverse()) {
      const frame = document.createElement('button')
      frame.type = 'button'
      frame.className = 'monitor-history-item'
      frame.textContent = new Date(item.capturedAt).toLocaleTimeString()
      frame.title = `${item.title}\n${item.url}`
      frame.addEventListener('click', () => void openMonitorHistory(item.capturedAt))
      monitorHistory.appendChild(frame)
    }
  }
}

function applyMonitorFrame(raw: unknown): void {
  if (!raw || typeof raw !== 'object') return
  const frame = raw as Partial<MonitorFramePayload>
  if (typeof frame.image !== 'string' || !monitorFrame) return
  monitorFrame.src = `data:image/png;base64,${frame.image}`
  monitorFrame.hidden = false
  if (monitorMeta) {
    const action = frame.pointer?.kind === 'click' ? uiText('点击', 'click') : frame.pointer?.kind === 'input' ? uiText('输入', 'input') : ''
    const pointer = frame.pointer?.x !== undefined && frame.pointer?.y !== undefined
      ? ` · ${action ? `${action} ` : ''}${uiText('鼠标', 'pointer')} (${Math.round(frame.pointer.x)}, ${Math.round(frame.pointer.y)})`
      : action ? ` · ${action}` : ''
    monitorMeta.textContent = `${frame.title ?? ''} · ${frame.url ?? ''} · ${frame.width ?? 0}×${frame.height ?? 0}${pointer}${frame.currentTask ? ` · ${frame.currentTask}` : ''}`
  }
}

function taskStatusLabel(status: AgentTaskRecord['status']): string {
  const labels: Record<AgentTaskRecord['status'], [string, string]> = {
    running: ['运行中', 'Running'],
    cancelling: ['正在取消', 'Cancelling'],
    completed: ['已完成', 'Completed'],
    failed: ['失败', 'Failed'],
    cancelled: ['已取消', 'Cancelled'],
    interrupted: ['已中断', 'Interrupted']
  }
  return labels[status][activeLocale === 'en-US' ? 1 : 0]
}

function renderTaskRow(task: AgentTaskRecord, active: boolean): HTMLDivElement {
  const row = document.createElement('div')
  row.className = 'task-row'
  const head = document.createElement('div')
  head.className = 'task-row-head'
  const name = document.createElement('strong')
  name.className = 'task-row-tool'
  name.textContent = task.tool
  const meta = document.createElement('span')
  meta.className = 'task-row-meta'
  meta.textContent = `#${task.id} · A${task.client} · ${taskStatusLabel(task.status)}`
  head.append(name, meta)
  if (active && task.status !== 'cancelling') {
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'task-row-cancel'
    cancel.textContent = uiText('取消', 'Cancel')
    cancel.setAttribute('aria-label', uiText(`取消客户端 ${task.client} 的任务 ${task.tool}`, `Cancel ${task.tool} from client ${task.client}`))
    cancel.addEventListener('click', () => void window.aa.taskAction('cancel', task.id, task.client))
    head.appendChild(cancel)
  }
  row.appendChild(head)
  const details = task.error || task.message
  if (details) {
    const message = document.createElement('div')
    message.className = `task-row-message${task.status === 'failed' ? ' task-row-error' : ''}`
    message.textContent = details
    row.appendChild(message)
  }
  if (active && typeof task.progress === 'number' && Number.isFinite(task.progress)) {
    const progress = document.createElement('progress')
    progress.className = 'task-row-progress'
    if (typeof task.total === 'number' && task.total > 0) {
      progress.max = task.total
      progress.value = Math.max(0, Math.min(task.total, task.progress))
    } else {
      progress.removeAttribute('max')
      progress.removeAttribute('value')
    }
    progress.setAttribute('aria-label', uiText('任务进度', 'Task progress'))
    row.appendChild(progress)
  }
  return row
}

function renderTaskCenter(): void {
  if (!taskCenterPanel) return
  const activity = state.agentActivity ?? { active: false, paused: state.agentInterrupted, calls: [] }
  const tasks = activity.tasks ?? []
  const running = tasks.filter((task) => task.status === 'running' || task.status === 'cancelling')
  const history = tasks.filter((task) => task.status !== 'running' && task.status !== 'cancelling')
  if (taskCenterStatus) {
    taskCenterStatus.textContent = activity.paused || state.agentInterrupted
      ? uiText('已暂停', 'Paused')
      : running.length ? uiText(`运行中 · ${running.length}`, `Running · ${running.length}`) : uiText('空闲', 'Idle')
  }
  if (btnTaskPause) btnTaskPause.hidden = !!(activity.paused || state.agentInterrupted)
  if (btnTaskResume) btnTaskResume.hidden = !(activity.paused || state.agentInterrupted)
  if (taskRunningList) {
    taskRunningList.replaceChildren(...running.map((task) => renderTaskRow(task, true)))
    if (!running.length) {
      const empty = document.createElement('div')
      empty.className = 'task-empty'
      empty.textContent = uiText('当前没有运行中的任务', 'No running tasks')
      taskRunningList.appendChild(empty)
    }
  }
  if (taskHistoryList) {
    taskHistoryList.replaceChildren(...history.slice(0, 30).map((task) => renderTaskRow(task, false)))
    if (!history.length) {
      const empty = document.createElement('div')
      empty.className = 'task-empty'
      empty.textContent = uiText('暂无任务记录', 'No task history')
      taskHistoryList.appendChild(empty)
    }
  }
}

async function openMonitorHistory(capturedAt: number): Promise<void> {
  const frame = await window.aa.monitorHistoryFrame(capturedAt)
  if (frame) applyMonitorFrame(frame)
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

async function openDownload(id: string): Promise<void> {
  const record = state.downloads?.find((d) => d.id === id)
  const name = record?.filename ? uiText(`，文件：${record.filename}`, ` — ${record.filename}`) : ''
  try {
    const result = await window.aa.downloadOpen(id)
    if (!result?.ok) {
      const reason = result?.reason?.trim() || uiText('未知原因', 'Unknown reason')
      setDownloadStatus(uiText(`打开失败${name}：${reason}`, `Open failed${name}: ${reason}`), 'error')
    }
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    setDownloadStatus(uiText(`打开失败${name}：${reason}`, `Open failed${name}: ${reason}`), 'error')
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
    const completed = d.state === 'completed'
    const open = document.createElement('button')
    open.className = 'dl-act'
    open.dataset['focusKey'] = `download-open:${d.id}`
    open.textContent = uiText('打开', 'Open')
    open.addEventListener('click', () => void openDownload(d.id))
    const show = document.createElement('button')
    show.className = 'dl-act'
    show.dataset['focusKey'] = `download-show:${d.id}`
    show.textContent = uiText('在文件夹中显示', 'Show in folder')
    show.addEventListener('click', () => void window.aa.downloadShow(d.id))
    // 未完成的文件不提供“打开”（可能是半截文件），但可以定位或重试。
    if (completed) actions.append(open)
    if (d.state !== 'progressing') actions.append(show)
    if (d.state === 'progressing') {
      const cancel = document.createElement('button')
      cancel.className = 'dl-act dl-act-danger'
      cancel.dataset['focusKey'] = `download-cancel:${d.id}`
      cancel.textContent = uiText('取消', 'Cancel')
      cancel.addEventListener('click', () => void window.aa.downloadCancel(d.id))
      actions.appendChild(cancel)
    } else if (d.state === 'cancelled' || d.state === 'interrupted') {
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
  omniboxDirty = true
  omniboxEditTabId = state.activeId
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
      const action = [agentActivityAction, agentActivityTakeover, agentStop].find(isFocusable)
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

function renderClientSetupResult(): void {
  if (!setClientResult) return
  if (lastClientSetupError) {
    setClientResult.textContent = `${uiText('写入失败：', 'Write failed: ')}${lastClientSetupError}`
    return
  }
  if (!lastClientSetupResults) return
  setClientResult.textContent = lastClientSetupResults.length
    ? lastClientSetupResults.map((r) => `${clientStatusBadge(r.status)} ${clientDisplayName(r.id, r.name)} — ${r.message}`).join('　')
    : uiText('没有可写入的客户端。', 'No clients available to configure.')
}

function applyState(next: UiState): void {
  // 状态流会重建列表；只恢复外壳内同一业务控件，不能抢走网页的焦点。
  const focused = document.hasFocus() ? document.activeElement as HTMLElement | null : null
  const focusKey = focused?.dataset['focusKey']
  const previous = state
  const activeChanged = previous.activeId !== next.activeId
  const connectionChanged = previous.bridgeState !== next.bridgeState || previous.agentCount !== next.agentCount || previous.agentVerifiedCount !== next.agentVerifiedCount
  state = next
  if (connectionChanged && settingsModal && !settingsModal.hidden) {
    renderAgentInfo()
    if (previous.bridgeState === 'starting' && hasAgentInfo) void refreshAgentInfo()
  }
  if (activeChanged) {
    hideSuggest()
    // 同一标签的迟到状态不能覆盖草稿；已知标签真正切换时才重置地址栏。
    const editingKnownTab = omniboxDirty && omniboxEditTabId !== null && previous.activeId === omniboxEditTabId
    const resetOmnibox = document.activeElement === omnibox && (!omniboxDirty || (editingKnownTab && next.activeId !== omniboxEditTabId))
    if (resetOmnibox) {
      omnibox.value = editableUrl(activeTab()?.url ?? '')
      omnibox.select()
      omniboxDirty = false
      omniboxEditTabId = next.activeId
    }
  }
  if (typeof next.windowHeight === 'number') document.documentElement.style.setProperty('--window-height', `${next.windowHeight}px`)
  renderTabs()
  renderToolbar()
  renderFeed()
  renderMonitor()
  renderTaskCenter()
  schedulePlatformRefresh()
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

// 标签条隐藏了滚动条；用滚轮横向滚动，避免只能拖触控板。
tabsEl.addEventListener('wheel', (e) => {
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return
  const max = tabsEl.scrollWidth - tabsEl.clientWidth
  if (max <= 0) return
  const next = Math.max(0, Math.min(max, tabsEl.scrollLeft + e.deltaY))
  if (next !== tabsEl.scrollLeft) {
    e.preventDefault()
    tabsEl.scrollLeft = next
  }
}, { passive: false })

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
agentActivityTakeover?.addEventListener('click', () => void window.aa.takeoverAgent())
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

type DrawerKind = 'dl' | 'feed' | 'tasks' | 'monitor'
function drawerPanel(kind: DrawerKind): HTMLDivElement | null {
  if (kind === 'dl') return dlPanel
  if (kind === 'feed') return feedDrawer
  return kind === 'tasks' ? taskCenterPanel : monitorPanel
}
function drawerTrigger(kind: DrawerKind): HTMLElement | null {
  if (kind === 'dl') return btnDownloads
  if (kind === 'feed') return btnFeed
  return kind === 'tasks' ? btnTasks : btnMonitor
}
function drawerClose(kind: DrawerKind): HTMLElement | null {
  if (kind === 'dl') return btnCloseDownloads
  if (kind === 'feed') return btnCloseFeed
  return kind === 'tasks' ? btnCloseTasks : btnCloseMonitor
}
function drawerOpen(kind: DrawerKind): boolean {
  const panel = drawerPanel(kind)
  return !!panel && !panel.hidden
}

/** 键盘打开抽屉后把焦点移入（通用聚焦关闭按钮），关闭时再还给触发按钮。 */
function openDrawer(kind: DrawerKind): void {
  const closingMonitor = drawerOpen('monitor') && kind !== 'monitor'
  for (const other of ['dl', 'feed', 'tasks', 'monitor'] as const) {
    const panel = drawerPanel(other)
    if (panel) panel.hidden = other !== kind
  }
  focusIfPossible(drawerClose(kind))
  for (const item of ['dl', 'feed', 'tasks', 'monitor'] as const) {
    drawerTrigger(item)?.setAttribute('aria-expanded', String(item === kind))
  }
  if (closingMonitor) {
    void window.aa.monitorView(false)
    monitorFrame?.removeAttribute('src')
  }
  if (kind === 'monitor') void window.aa.monitorView(true)
  syncOverlayExtent()
}

/** restoreFocus=false 用于外部鼠标点击：只收起面板，不把焦点抢回触发按钮。 */
function closeDrawer(kind: DrawerKind, restoreFocus = true): void {
  const panel = drawerPanel(kind)
  if (!panel || panel.hidden) return
  const hadFocusInside = panel.contains(document.activeElement)
  panel.hidden = true
  drawerTrigger(kind)?.setAttribute('aria-expanded', 'false')
  if (kind === 'monitor') {
    void window.aa.monitorView(false)
    monitorFrame?.removeAttribute('src')
  }
  syncOverlayExtent()
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
  for (const kind of ['dl', 'feed', 'tasks', 'monitor'] as const) {
    const panel = drawerPanel(kind)
    const trigger = drawerTrigger(kind)
    if (panel && !panel.hidden && !trigger?.contains(target) && !panel.contains(target)) closeDrawer(kind, false)
  }
})

btnFeed?.addEventListener('click', () => {
  if (drawerOpen('feed')) closeDrawer('feed')
  else openDrawer('feed')
})
btnCloseFeed?.addEventListener('click', () => closeDrawer('feed'))
btnTasks?.addEventListener('click', () => {
  if (drawerOpen('tasks')) closeDrawer('tasks')
  else openDrawer('tasks')
})
btnCloseTasks?.addEventListener('click', () => closeDrawer('tasks'))
btnTaskPause?.addEventListener('click', async () => {
  await window.aa.taskAction('pause')
  await window.aa.getState().then(applyState)
})
btnTaskResume?.addEventListener('click', async () => {
  await window.aa.taskAction('resume')
  await window.aa.getState().then(applyState)
})
btnMonitor?.addEventListener('click', async () => {
  if (!monitorPanel) return
  if (!monitorPanel.hidden) {
    closeDrawer('monitor')
    return
  }
  openDrawer('monitor')
  if (!state.monitor?.enabled) {
    await window.aa.monitorStart(state.activeId ?? undefined)
  }
  // 等面板完成布局（截图/元数据可能刚填充）后再上报高度，避免原生视图仍停在工具栏高度。
  requestAnimationFrame(() => syncOverlayExtent())
  renderMonitor()
})
btnCloseMonitor?.addEventListener('click', () => {
  closeDrawer('monitor')
  if (monitorFrame) monitorFrame.removeAttribute('src')
})
btnMonitorTakeover?.addEventListener('click', () => void window.aa.monitorTakeover())
btnMonitorRelease?.addEventListener('click', () => void window.aa.monitorRelease())

/* ── 设置面板：连接 AI 客户端 ─────────────── */
/** 路径仅供本机展开查看；可分享的诊断由主进程白名单生成。 */
function renderAgentInfo(): void {
  if (!setAgentInfo || !setAgentStatus || !setAgentGuidance) return
  const agent = lastAgentInfo
  const status = !hasAgentInfo ? 'loading'
    : !agent ? 'unknown'
    : state.bridgeState === 'starting' ? 'starting'
    : state.bridgeState === 'disconnected' ? 'unavailable'
    : state.agentVerifiedCount > 0 ? 'verified'
    : state.agentCount > 0 ? 'authenticated'
    : agent.bridgeFile === 'missing' ? 'missing'
    : agent.bridgeFile === 'needs-setup' ? 'needs-setup' : 'waiting'
  const labels = {
    loading: t('loading'),
    unknown: uiText('无法读取连接状态', 'Connection status unavailable'),
    starting: uiText('正在启动本地服务', 'Starting local service'),
    unavailable: uiText('本地服务未能启动', 'Local service could not start'),
    verified: uiText(`已验证 ${state.agentVerifiedCount} 个客户端`, `${state.agentVerifiedCount} client connection(s) verified`),
    authenticated: uiText('客户端已连接，尚未验证调用', 'Client connected; first call not verified'),
    missing: uiText('当前安装缺少 MCP 桥文件', 'MCP bridge file missing'),
    'needs-setup': uiText('需要完成客户端接入', 'Client setup required'),
    waiting: uiText('本地服务就绪，等待客户端', 'Local service ready; waiting for a client')
  }
  // Avoid repeatedly announcing an unchanged status during Agent progress updates.
  if (setAgentStatus.textContent !== labels[status]) setAgentStatus.textContent = labels[status]
  setAgentStatus.dataset['state'] = status
  setAgentGuidance.textContent = agent?.bridgeFile === 'missing'
    ? uiText('重新安装受支持的正式版，再重新扫描并修复客户端路径。', 'Reinstall a supported release, then rescan and repair the client path.')
    : status === 'unavailable' || status === 'unknown'
      ? uiText('请重启 Aa Browser；仍未恢复时，可复制连接诊断。', 'Restart Aa Browser. If the issue persists, copy the connection diagnostics.')
      : ['waiting', 'authenticated', 'needs-setup'].includes(status)
        ? uiText('完成接入并重启客户端，然后调用 browser_tabs（list）验证。', 'Complete setup, restart the client, then call browser_tabs (list) to verify.')
        : ''
  setAgentInfo.textContent = agent?.port && state.bridgeState !== 'disconnected'
    ? uiText(
      `已认证客户端：${state.agentCount} · 已验证：${state.agentVerifiedCount} · 端口 ${agent.port} · 发现文件 ${agent.discoveryFile}`,
      `Authenticated clients: ${state.agentCount} · verified: ${state.agentVerifiedCount} · port ${agent.port} · discovery file ${agent.discoveryFile}`
    )
    : labels[status]
  if (copyDiagnostics) {
    copyDiagnostics.disabled = !hasAgentInfo
    copyDiagnostics.setAttribute('aria-busy', String(diagnosticsCopying))
  }
  if (diagnosticsResult) {
    diagnosticsResult.textContent = diagnosticsFeedback === 'copied' ? uiText('连接诊断已复制。', 'Connection diagnostics copied.')
      : diagnosticsFeedback === 'failed' ? uiText('复制失败，请重试。', 'Unable to copy. Try again.') : ''
    diagnosticsResult.dataset['state'] = diagnosticsFeedback === 'failed' ? 'error' : diagnosticsFeedback === 'copied' ? 'success' : ''
  }
}

async function refreshAgentInfo(): Promise<void> {
  const request = settingsRequest
  const revision = ++agentInfoRequest
  const info = await window.aa.agentInfo().catch(() => null)
  if (!currentSettingsRequest(request) || revision !== agentInfoRequest) return
  lastAgentInfo = info
  hasAgentInfo = true
  renderAgentInfo()
}

copyDiagnostics?.addEventListener('click', async () => {
  const request = settingsRequest
  if (!settingsReady || !currentSettingsRequest(request) || diagnosticsCopying) return
  diagnosticsCopying = true
  diagnosticsFeedback = null
  renderAgentInfo()
  const copied = await window.aa.copyConnectionDiagnostics().catch(() => false)
  if (!currentSettingsRequest(request)) return
  diagnosticsCopying = false
  diagnosticsFeedback = copied ? 'copied' : 'failed'
  renderAgentInfo()
})

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
    const needsRepair = client.outdated === true
    checkbox.disabled = client.configured && !needsRepair
    checkbox.checked = needsRepair ? true : client.configured ? false : (preserveSelection && existing.length ? checkedIds.has(client.id) : true)
    if (focusedId === client.id) checkbox.dataset['focusPending'] = 'true'
    const name = document.createElement('span')
    name.className = 'client-name'
    name.textContent = clientDisplayName(client.id, client.name)
    const badge = document.createElement('span')
    badge.className = needsRepair ? 'client-pill warn' : client.configured ? 'client-pill ok' : 'client-pill'
    badge.textContent = needsRepair
      ? uiText('路径待修复', 'Path needs repair')
      : client.configured
        ? uiText('已配置', 'Configured')
        : uiText('未配置', 'Not configured')
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
  if (!settingsReady) return
  if (setClientResult) setClientResult.textContent = ''
  void refreshClients()
  void refreshAgentInfo()
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
    const results = await window.aa.clientsSetup(ids, activeLocale)
    if (!currentSettingsRequest(request)) return
    lastClientSetupError = ''
    lastClientSetupResults = results
    renderClientSetupResult()
    await Promise.all([refreshClients(), refreshAgentInfo()])
  } catch (err) {
    if (currentSettingsRequest(request)) {
      lastClientSetupResults = null
      lastClientSetupError = err instanceof Error ? err.message : String(err)
      renderClientSetupResult()
    }
  } finally {
    if (currentSettingsRequest(request)) {
      btnClientSetup.removeAttribute('aria-busy')
      btnClientSetup.disabled = setClientList.getAttribute('aria-busy') === 'true' || setClientList.querySelectorAll('input[type=checkbox]:not(:disabled)').length === 0
    }
  }
})

/* ── 设置面板：已解压扩展 ─────────────── */
let extensionsRequestId = 0
let lastExtensions: ExtensionInfo[] | null = null
let extensionUpdates: NonNullable<ExtensionUpdateResult['updates']> = []
let extensionMutation = false

function extensionProfileId(): string | undefined {
  return (document.getElementById('extension-profile') as HTMLSelectElement | null)?.value || undefined
}

function renderExtensionList(): void {
  if (!extensionList) return
  const list = lastExtensions
  if (list === null) {
    extensionList.textContent = t('loading')
    extensionList.setAttribute('aria-busy', 'true')
    return
  }
  extensionList.removeAttribute('aria-busy')
  if (!list.length) {
    extensionList.textContent = t('extensionsEmpty')
    return
  }
  extensionList.textContent = ''
  for (const ext of list) {
    const row = document.createElement('div')
    row.className = 'extension-row'
    const main = document.createElement('div')
    main.className = 'extension-main'
    const name = document.createElement('span')
    name.className = 'extension-name'
    name.textContent = `${ext.name} v${ext.version}`
    const meta = document.createElement('div')
    meta.className = 'extension-meta'
    meta.textContent = `[${ext.id}] MV${ext.manifestVersion}`
    meta.title = ext.path
    main.appendChild(name)
    main.appendChild(meta)
    const source = document.createElement('div')
    source.className = 'extension-meta'
    source.textContent = `${uiText('来源', 'Source')}: ${ext.source === 'local-unpacked' ? uiText('本地解压目录', 'Local unpacked directory') : ext.source ?? uiText('未知', 'Unknown')} · ${uiText('状态', 'Status')}: ${ext.status ?? uiText('未知', 'Unknown')}`
    main.append(source)
    const permissions = document.createElement('details')
    permissions.className = 'extension-permissions'
    const permissionTitle = document.createElement('summary')
    permissionTitle.textContent = `${uiText('权限', 'Permissions')} (${(ext.permissions?.length ?? 0) + (ext.hostPermissions?.length ?? 0)})`
    const permissionText = document.createElement('div')
    permissionText.className = 'extension-meta'
    permissionText.textContent = [...ext.permissions ?? [], ...ext.hostPermissions ?? []].join(', ') || uiText('无声明权限', 'No declared permissions')
    permissions.append(permissionTitle, permissionText)
    main.append(permissions)
    const update = extensionUpdates.find((item) => item.id === ext.id)
    const error = (ext as ExtensionInfo & { error?: string }).error
    if (update || error) {
      const result = document.createElement('div')
      result.className = update?.error || error ? 'platform-error' : 'extension-meta'
      result.textContent = error ?? update?.error ?? (update?.changed ? `${uiText('本地版本已变化', 'Local version changed')}: ${update.installedVersion} → ${update.localVersion}` : uiText('本地版本一致', 'Local version matches'))
      main.append(result)
    }
    const toggle = document.createElement('label')
    toggle.className = 'settings-switch extension-toggle'
    const enabled = document.createElement('input')
    enabled.type = 'checkbox'
    enabled.checked = ext.enabled !== false
    enabled.disabled = extensionMutation
    enabled.setAttribute('aria-label', `${uiText('启用扩展', 'Enable extension')}: ${ext.name}`)
    const track = document.createElement('span')
    track.className = 'settings-switch-track'
    track.setAttribute('aria-hidden', 'true')
    toggle.append(enabled, track)
    enabled.addEventListener('change', () => { void setExtensionEnabled(ext.id, enabled.checked) })
    const removeBtn = document.createElement('button')
    removeBtn.type = 'button'
    removeBtn.className = 'settings-btn extension-remove'
    removeBtn.dataset['key'] = ext.id
    removeBtn.setAttribute('aria-label', `${uiText('移除扩展', 'Remove extension')}: ${ext.name}`)
    removeBtn.textContent = uiText('移除', 'Remove')
    removeBtn.disabled = extensionMutation
    row.appendChild(main)
    row.appendChild(toggle)
    row.appendChild(removeBtn)
    extensionList.appendChild(row)
  }
}

async function refreshExtensions(): Promise<void> {
  if (!extensionList || !settingsReady) return
  const request = settingsRequest
  const profileId = extensionProfileId()
  const seq = ++extensionsRequestId
  lastExtensions = null
  renderExtensionList()
  try {
    const list = await window.aa.extensionList(profileId)
    if (!currentSettingsRequest(request) || seq !== extensionsRequestId) return
    lastExtensions = Array.isArray(list) ? list : []
    renderExtensionList()
  } catch (err) {
    if (!currentSettingsRequest(request) || seq !== extensionsRequestId) return
    extensionList.textContent = `${uiText('列表读取失败：', 'Failed to list extensions: ')}${err instanceof Error ? err.message : String(err)}`
  }
}

btnExtensionLoad?.addEventListener('click', async () => {
  if (!btnExtensionLoad || !settingsReady || !currentSettingsRequest(settingsRequest) || btnExtensionLoad.getAttribute('aria-busy') === 'true') return
  const request = settingsRequest
  const profileId = extensionProfileId()
  if (setExtensionResult) setExtensionResult.textContent = ''
  btnExtensionLoad.disabled = true
  btnExtensionLoad.setAttribute('aria-busy', 'true')
  try {
    const dir = await window.aa.extensionPick()
    if (!currentSettingsRequest(request)) return
    if (!dir) return // 用户取消选择，不算失败
    if (setExtensionResult) setExtensionResult.textContent = uiText('正在装载扩展…', 'Loading the extension…')
    const result = await window.aa.extensionLoad(dir, profileId)
    if (!currentSettingsRequest(request) || profileId !== extensionProfileId()) return
    if (result.ok && result.extension) {
      if (setExtensionResult) {
        setExtensionResult.textContent = `${uiText('已装载', 'Loaded')}: ${result.extension.name} v${result.extension.version}`
        setExtensionResult.dataset['state'] = 'ok'
      }
    } else {
      if (setExtensionResult) {
        setExtensionResult.textContent = `${uiText('扩展加载失败：', 'Failed to load the extension: ')}${result.error ?? 'unknown'}`
        setExtensionResult.dataset['state'] = 'error'
      }
    }
  } catch (err) {
    if (currentSettingsRequest(request) && setExtensionResult) {
      setExtensionResult.textContent = `${uiText('扩展加载失败：', 'Failed to load the extension: ')}${err instanceof Error ? err.message : String(err)}`
      setExtensionResult.dataset['state'] = 'error'
    }
  } finally {
    if (currentSettingsRequest(request)) {
      btnExtensionLoad.disabled = false
      btnExtensionLoad.removeAttribute('aria-busy')
    }
  }
  void refreshExtensions()
})

btnExtensionRescan?.addEventListener('click', () => {
  if (!settingsReady) return
  if (setExtensionResult) setExtensionResult.textContent = ''
  void refreshExtensions()
})

extensionList?.addEventListener('click', async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>('button.extension-remove')
  if (!button || !settingsReady || !currentSettingsRequest(settingsRequest) || button.disabled) return
  const request = settingsRequest
  const profileId = extensionProfileId()
  const key = button.dataset['key'] ?? ''
  button.disabled = true
  if (setExtensionResult) setExtensionResult.textContent = ''
  try {
    const result = await window.aa.extensionRemove(key, profileId)
    if (!currentSettingsRequest(request) || profileId !== extensionProfileId()) return
    if (setExtensionResult) {
      if (result.ok) setExtensionResult.textContent = uiText('已移除扩展。', 'Extension removed.')
      else {
        setExtensionResult.textContent = `${uiText('移除失败：', 'Failed to remove: ')}${result.error ?? 'unknown'}`
        setExtensionResult.dataset['state'] = 'error'
      }
    }
  } catch (err) {
    if (currentSettingsRequest(request) && setExtensionResult) {
      setExtensionResult.textContent = `${uiText('移除失败：', 'Failed to remove: ')}${err instanceof Error ? err.message : String(err)}`
      setExtensionResult.dataset['state'] = 'error'
    }
  }
  void refreshExtensions()
})

async function setExtensionEnabled(key: string, enabled: boolean): Promise<void> {
  if (extensionMutation || !settingsReady || !currentSettingsRequest(settingsRequest)) return
  extensionMutation = true
  const request = settingsRequest
  const profileId = extensionProfileId()
  const selector = document.getElementById('extension-profile') as HTMLSelectElement
  selector.disabled = true
  renderExtensionList()
  try {
    const result = await window.aa.extensionEnable(key, enabled, profileId)
    if (!currentSettingsRequest(request) || profileId !== extensionProfileId()) return
    if (setExtensionResult) {
      setExtensionResult.textContent = result.ok ? uiText('扩展状态已更新。请重新加载受影响的网页。', 'Extension status updated. Reload affected pages.') : result.error ?? uiText('扩展状态更新失败', 'Unable to change extension state')
      setExtensionResult.dataset['state'] = result.ok ? 'ok' : 'error'
    }
  } catch (error) {
    if (currentSettingsRequest(request) && setExtensionResult) {
      setExtensionResult.textContent = error instanceof Error ? error.message : String(error)
      setExtensionResult.dataset['state'] = 'error'
    }
  } finally {
    extensionMutation = false
    selector.disabled = !settingsReady
    if (currentSettingsRequest(request)) void refreshExtensions()
  }
}

document.getElementById('extension-profile')?.addEventListener('change', () => {
  extensionUpdates = []
  if (setExtensionResult) setExtensionResult.textContent = ''
  void refreshExtensions()
})
document.getElementById('btn-extension-updates')?.addEventListener('click', async () => {
  if (!settingsReady || extensionMutation) return
  const button = document.getElementById('btn-extension-updates') as HTMLButtonElement
  const request = settingsRequest
  const profileId = extensionProfileId()
  button.disabled = true
  button.setAttribute('aria-busy', 'true')
  try {
    const result = await window.aa.extensionCheckUpdates(profileId)
    if (!currentSettingsRequest(request) || profileId !== extensionProfileId()) return
    if (!result.ok) throw new Error(result.error ?? uiText('检查失败', 'Check failed'))
    extensionUpdates = result.updates ?? []
    renderExtensionList()
    if (setExtensionResult) {
      setExtensionResult.textContent = `${uiText('本地文件检查完成', 'Local files checked')}: ${extensionUpdates.filter((item) => item.changed).length} ${uiText('个版本变化', 'version changes')}`
      setExtensionResult.dataset['state'] = 'ok'
    }
  } catch (error) {
    if (currentSettingsRequest(request) && setExtensionResult) {
      setExtensionResult.textContent = error instanceof Error ? error.message : String(error)
      setExtensionResult.dataset['state'] = 'error'
    }
  } finally {
    button.disabled = false
    button.removeAttribute('aria-busy')
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
      sibling.inert = sibling === approvalPanel ? !!approvalPanel.hidden : true
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
  for (const control of [setEngine, setEngineUrl, setLocale, setTheme, setFullSnapshot, setOpApproval, setIsolatedSessions, setRestoreSession, setBackgroundMode, setAutoUpdate, setUpdateChannel, setDownloadDir, setAllowedSites]) {
    if (control) control.disabled = !ready
  }
  for (const control of document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('#settings-body input, #settings-body select, #settings-body textarea')) {
    if (control.id === 'extension-profile' || control.closest('#settings-section-profiles, #settings-section-workflows, #settings-section-network, #settings-section-security, #settings-section-diagnostics')) control.disabled = !ready
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
  hasAgentInfo = false
  lastAgentInfo = null
  diagnosticsCopying = false
  diagnosticsFeedback = null
  renderAgentInfo()
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
    if (setTheme) setTheme.value = view.settings.theme || 'dark'
    if (setFullSnapshot) setFullSnapshot.checked = view.settings.fullSnapshot
    if (setOpApproval) setOpApproval.checked = !!view.settings.requireOperationApproval
    if (setIsolatedSessions) setIsolatedSessions.checked = !!view.settings.isolatedSessions
    if (setRestoreSession) setRestoreSession.checked = view.settings.restoreSession !== false
    if (setBackgroundMode) setBackgroundMode.value = view.settings.backgroundMode || 'visible'
    if (setAutoUpdate) setAutoUpdate.checked = view.settings.autoUpdate !== false
    if (setUpdateChannel) setUpdateChannel.value = view.settings.updateChannel || 'stable'
    if (setDownloadDir) setDownloadDir.value = view.settings.downloadDir
    if (setAllowedSites) setAllowedSites.value = view.settings.allowedSites.join('\n')
  }
  lastAgentInfo = agent
  hasAgentInfo = true
  applyLocale(savedLocale)
  setSettingsReady(true)
  void refreshExtensions()
  // 服务可能在读取初始状态时完成启动，补取一次尚未出现的端口和发现文件。
  if (agent && !agent.port && state.bridgeState !== 'starting' && state.bridgeState !== 'disconnected') void refreshAgentInfo()
  if (settingsStatus) {
    settingsStatus.textContent = ''
    delete settingsStatus.dataset['state']
  }
  void refreshClients()
  renderUpdate(state.update)
  void refreshPlatform()
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
  if (setBackgroundMode) patch.backgroundMode = setBackgroundMode.value as BackgroundMode
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
  omniboxDirty = false
  omniboxEditTabId = state.activeId
  omnibox.value = editableUrl(activeTab()?.url ?? '')
  omnibox.select()
})
omnibox.addEventListener('blur', () => {
  // 只恢复地址；重绘工具栏会在 mousedown 和 click 之间替换审批/停止按钮。
  omniboxDirty = false
  omniboxEditTabId = state.activeId
  omnibox.value = shortenUrl(activeTab()?.url ?? '')
  setTimeout(() => {
    if (document.activeElement !== omnibox) hideSuggest()
  }, 120)
})
omnibox.addEventListener('input', onOmniboxInput)

window.aa.onState(applyState)
window.aa.onMonitorFrame(applyMonitorFrame)
window.aa.onOpenExtensions(() => {
  void openSettings().then((ready) => {
    if (!ready || !settingsModal || settingsModal.hidden) return
    const section = document.getElementById('settings-section-extensions')
    if (section) scrollToSettingsSection(section.id)
  })
})
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
  if (!approvalPanel.hidden && state.pendingApprovals.some((item) => item.kind !== 'sensitive')) {
    if (e.key === 'Tab') {
      const controls = Array.from(approvalPanel.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'))
      const index = controls.indexOf(document.activeElement as HTMLButtonElement)
      const next = controls[e.shiftKey ? (index <= 0 ? controls.length : index) - 1 : (index + 1) % controls.length]
      e.preventDefault()
      next?.focus()
    }
    return
  }
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

/* Platform panels consume the same persisted services as MCP; no UI-only task state. */
let platform: PlatformState | null = null
let platformRefreshing = false
let platformBusy = false
let platformLastRefresh = 0
let platformRefreshTimer: ReturnType<typeof setTimeout> | undefined
const platformElement = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T
const platformInput = (id: string): HTMLInputElement => platformElement<HTMLInputElement>(id)
const profileSelector = platformElement<HTMLSelectElement>('profile-selector')

function renderPlatformLocale(): void {
  for (const element of document.querySelectorAll<HTMLElement>('[data-platform-zh]')) {
    element.textContent = activeLocale === 'en-US' ? element.dataset['platformEn'] ?? '' : element.dataset['platformZh'] ?? ''
  }
  const selector = document.getElementById('profile-selector')
  selector?.setAttribute('aria-label', uiText('当前配置文件', 'Current profile'))
  selector?.setAttribute('title', uiText('当前配置文件', 'Current profile'))
  if (document.getElementById('profile-edit-id') && platformInput('profile-edit-id').value) {
    platformElement('profile-save').textContent = uiText('保存配置文件', 'Save profile')
  }
  if (platform) renderPlatform()
}

function platformMessage(message: string, error = false): void {
  const elements = [document.getElementById('platform-status'), ...document.querySelectorAll<HTMLElement>('[data-platform-status]')]
  const activeSection = document.activeElement?.closest('.settings-section') ?? document.getElementById(document.querySelector<HTMLElement>('.settings-nav-item.is-active')?.dataset['target'] ?? '')
  for (const element of elements) {
    if (!element) continue
    element.textContent = activeSection?.contains(element) ? message : ''
    element.dataset['state'] = error ? 'error' : 'success'
  }
}

function platformEmpty(parent: HTMLElement, text: string): void {
  const empty = document.createElement('p')
  empty.className = 'platform-empty'
  empty.textContent = text
  parent.append(empty)
}

function platformButton(label: string, callback: () => void, symbol?: string): HTMLButtonElement {
  const button = document.createElement('button')
  button.type = 'button'
  button.className = symbol ? 'navbtn platform-icon-button' : 'settings-btn'
  button.textContent = symbol ?? label
  button.title = label
  button.setAttribute('aria-label', label)
  button.disabled = platformBusy
  button.addEventListener('click', callback)
  return button
}

function platformBadge(status: string): HTMLSpanElement {
  const badge = document.createElement('span')
  badge.className = 'platform-badge'
  badge.dataset['status'] = status
  const labels: Record<string, [string, string]> = {
    running: ['运行中', 'Running'], pending: ['待运行', 'Pending'], queued: ['等待中', 'Queued'],
    completed: ['已完成', 'Completed'], succeeded: ['成功', 'Succeeded'], failed: ['失败', 'Failed'],
    paused: ['已暂停', 'Paused'], interrupted: ['已中断', 'Interrupted'], cancelled: ['已取消', 'Cancelled'], waiting: ['等待确认', 'Waiting for confirmation'], draft: ['待运行', 'Draft'],
    skipped: ['已跳过', 'Skipped'], waiting_approval: ['等待审批', 'Awaiting approval'],
    'waiting-approval': ['等待审批', 'Awaiting approval'], stopped: ['已关闭', 'Stopped']
  }
  badge.textContent = labels[status]?.[activeLocale === 'en-US' ? 1 : 0] ?? status
  return badge
}

function selectProfiles(id: string, selected?: string): void {
  if (!platform) return
  const select = platformElement<HTMLSelectElement>(id)
  const wanted = selected ?? select.value ?? platform.activeProfileId
  const signature = platform.profiles.map((profile) => `${profile.id}:${profile.name}:${profile.isDefault}`).join('|')
  if (select.dataset['profiles'] !== signature) {
    select.replaceChildren(...platform.profiles.map((profile) => {
      const option = document.createElement('option')
      option.value = profile.id
      option.textContent = `${profile.name}${profile.isDefault ? ' ★' : ''}`
      return option
    }))
    select.dataset['profiles'] = signature
  }
  select.value = platform.profiles.some((profile) => profile.id === wanted) ? wanted : platform.activeProfileId || platform.defaultProfileId
  select.disabled = platformBusy || !platform.profiles.length || id !== 'profile-selector' && !settingsReady || id === 'extension-profile' && extensionMutation
}

function renderProfiles(): void {
  if (!platform) return
  selectProfiles('profile-selector', platform.activeProfileId)
  for (const id of ['workflow-profile', 'network-profile', 'diagnostics-profile']) selectProfiles(id)
  const extensionProfileBefore = extensionProfileId()
  selectProfiles('extension-profile')
  if (settingsReady && extensionProfileBefore !== extensionProfileId()) void refreshExtensions()
  const list = platformElement('profile-list')
  const signature = JSON.stringify([platform.profiles, platformBusy, activeLocale])
  if (list.dataset['signature'] === signature) return
  list.dataset['signature'] = signature
  list.replaceChildren()
  for (const profile of platform.profiles) {
    const row = document.createElement('article')
    row.className = 'platform-row'
    const dot = document.createElement('span')
    dot.className = 'profile-swatch'
    if (/^#[a-f0-9]{6}$/i.test(profile.color)) dot.style.backgroundColor = profile.color
    const content = document.createElement('div')
    content.className = 'platform-row-content'
    const title = document.createElement('strong')
    title.textContent = `${profile.name}${profile.isDefault ? ' ★' : ''}`
    const detail = document.createElement('span')
    detail.className = 'platform-detail'
    detail.textContent = [profile.description, profile.id, profile.tabCount !== undefined ? `${profile.tabCount} ${uiText('个标签页', 'tabs')}` : ''].filter(Boolean).join(' · ')
    content.append(title, detail)
    if (profile.downloadDir) {
      const directory = document.createElement('span')
      directory.className = 'platform-detail'
      directory.textContent = profile.downloadDir
      content.append(directory)
    }
    const actions = document.createElement('div')
    actions.className = 'platform-row-actions'
    actions.append(platformButton(profile.running ? uiText('关闭', 'Stop') : uiText('启动', 'Start'), () => {
      if (profile.running && !window.confirm(uiText('关闭此配置文件的全部标签页？未保存的网页内容可能丢失。', 'Close all tabs in this profile? Unsaved page content may be lost.'))) return
      void platformAction(profile.running ? 'profile.stop' : 'profile.start', { profileId: profile.id })
    }, profile.running ? '■' : '▶'))
    actions.append(platformButton(uiText('编辑', 'Edit'), () => editProfile(profile), '✎'))
    actions.append(platformButton(uiText('复制配置文件', 'Clone profile'), () => {
      void platformAction('profile.clone', { profileId: profile.id, name: `${profile.name} ${uiText('副本', 'copy')}` })
    }, '⧉'))
    if (!profile.isDefault) actions.append(platformButton(uiText('设为默认', 'Make default'), () => { void platformAction('profile.default', { profileId: profile.id }) }, '☆'))
    actions.append(platformButton(uiText('导出加密备份', 'Export encrypted backup'), () => { void profileArchive('profile.export', profile.id) }, '↓'))
    if (profile.id !== 'default' && !profile.isDefault) actions.append(platformButton(uiText('删除配置文件', 'Delete profile'), () => {
      if (window.confirm(uiText(`永久删除“${profile.name}”及其全部浏览器数据？`, `Permanently delete “${profile.name}” and all its browser data?`))) void platformAction('profile.remove', { profileId: profile.id })
    }, '×'))
    row.append(dot, content, platformBadge(profile.running ? 'running' : 'stopped'), actions)
    list.append(row)
  }
}

function editProfile(profile?: ProfileView): void {
  platformInput('profile-edit-id').value = profile?.id ?? ''
  platformInput('profile-name').value = profile?.name ?? ''
  platformInput('profile-description').value = profile?.description ?? ''
  platformInput('profile-color').value = profile?.color ?? '#78cbb9'
  platformElement<HTMLSelectElement>('profile-icon').value = profile?.icon ?? 'circle'
  platformElement('profile-save').textContent = profile ? uiText('保存配置文件', 'Save profile') : uiText('创建配置文件', 'Create profile')
  platformElement('profile-reset').hidden = !profile
  if (profile) platformInput('profile-name').focus()
}

function renderWorkflows(): void {
  if (!platform) return
  const templates = platformElement<HTMLSelectElement>('workflow-template')
  const selected = templates.value
  const templateSignature = JSON.stringify(platform.templates)
  if (templates.dataset['signature'] !== templateSignature) {
    templates.replaceChildren(...platform.templates.map((template) => {
      const option = document.createElement('option')
      option.value = template.id
      option.textContent = template.name
      if (template.description) option.title = template.description
      return option
    }))
    if (platform.templates.some((template) => template.id === selected)) templates.value = selected
    templates.dataset['signature'] = templateSignature
    renderTemplateParameters()
  }
  const workflows = platform.workflows
  platformElement('workflow-summary').textContent = `${workflows.filter((workflow) => workflow.status === 'running').length} ${uiText('运行中', 'running')} · ${workflows.length} ${uiText('个工作流', 'workflows')}`
  const list = platformElement('workflow-list')
  const signature = JSON.stringify([workflows.map((workflow) => [workflow.id, workflow.updatedAt, workflow.status, workflow.steps]), platformBusy, activeLocale])
  if (list.dataset['signature'] === signature || list.contains(document.activeElement) && document.activeElement?.matches('input,textarea')) return
  const open = new Set(Array.from(list.querySelectorAll<HTMLDetailsElement>('details[open]')).map((detail) => detail.dataset['detailKey']))
  list.replaceChildren()
  list.dataset['signature'] = signature
  if (!workflows.length) platformEmpty(list, uiText('暂无工作流', 'No workflows'))
  for (const workflow of [...workflows].reverse()) list.append(renderWorkflow(workflow))
  for (const detail of list.querySelectorAll<HTMLDetailsElement>('details')) if (open.has(detail.dataset['detailKey'])) detail.open = true
}

function renderTemplateParameters(): void {
  const id = platformElement<HTMLSelectElement>('workflow-template').value
  const multiple = id === 'multi-page' || id === 'compare'
  const parameters = id === 'form' || id === 'page-test'
  platformElement('workflow-url-label').hidden = multiple
  platformInput('workflow-url').required = !multiple
  platformElement('workflow-urls-label').hidden = !multiple
  platformElement<HTMLTextAreaElement>('workflow-urls').required = multiple
  platformElement('workflow-parameters-label').hidden = !parameters
  platformElement<HTMLTextAreaElement>('workflow-parameters').required = parameters
  platformElement('workflow-parameters-title').textContent = id === 'form' ? uiText('表单字段（JSON 数组）', 'Form fields (JSON array)') : uiText('断言（JSON 数组）', 'Assertions (JSON array)')
  platformElement('workflow-schedule-label').hidden = id !== 'scheduled'
  platformInput('workflow-schedule').required = id === 'scheduled'
}

function renderWorkflow(workflow: PlatformWorkflow): HTMLElement {
  const container = document.createElement('article')
  container.className = 'workflow-record'
  const header = document.createElement('div')
  header.className = 'platform-row'
  const content = document.createElement('div')
  content.className = 'platform-row-content'
  const name = document.createElement('strong')
  name.textContent = workflow.name
  const meta = document.createElement('span')
  meta.className = 'platform-detail'
  const profileName = platform?.profiles.find((profile) => profile.id === workflow.profileId)?.name ?? workflow.profileId
  const started = workflow.startedAt ?? workflow.createdAt
  const duration = started ? Math.max(0, ((workflow.finishedAt ?? Date.now()) - started) / 1000).toFixed(1) : null
  const completed = workflow.steps.filter((step) => ['completed', 'succeeded', 'skipped'].includes(step.status)).length
  meta.textContent = `${profileName} · ${completed}/${workflow.steps.length}${duration ? ` · ${duration}s` : ''}`
  content.append(name, meta)
  const actions = document.createElement('div')
  actions.className = 'platform-row-actions'
  const action = (verb: string): void => {
    const stepId = verb === 'retry' ? workflow.steps.find((step) => ['failed', 'interrupted', 'waiting'].includes(step.status))?.id : undefined
    void platformAction(`workflow.${verb}`, { workflowId: workflow.id, id: workflow.id, ...(stepId ? { stepId } : {}) })
  }
  if (['pending', 'draft', 'queued'].includes(workflow.status)) actions.append(platformButton(uiText('运行工作流', 'Run workflow'), () => action('run'), '▶'))
  if (workflow.status === 'running') actions.append(platformButton(uiText('暂停工作流', 'Pause workflow'), () => action('pause'), 'Ⅱ'))
  if (['paused', 'interrupted', 'waiting', 'waiting_approval', 'waiting-approval', 'waiting_confirmation'].includes(workflow.status)) actions.append(platformButton(uiText('继续工作流', 'Resume workflow'), () => action('resume'), '▶'))
  if (workflow.status === 'failed') actions.append(platformButton(uiText('重试失败步骤', 'Retry failed step'), () => action('retry'), '↻'))
  if (!['completed', 'succeeded', 'cancelled'].includes(workflow.status)) actions.append(platformButton(uiText('取消工作流', 'Cancel workflow'), () => action('cancel'), '×'))
  if (['completed', 'cancelled', 'failed'].includes(workflow.status)) actions.append(platformButton(uiText('删除工作流', 'Delete workflow'), () => action('remove'), '×'))
  header.append(content, platformBadge(workflow.status), actions)
  container.append(header)
  const progress = document.createElement('progress')
  progress.max = Math.max(1, workflow.steps.length)
  progress.value = completed
  progress.setAttribute('aria-label', uiText('工作流进度', 'Workflow progress'))
  container.append(progress)
  const steps = document.createElement('ol')
  steps.className = 'workflow-steps'
  for (const step of workflow.steps) {
    const item = document.createElement('li')
    const title = document.createElement('span')
    title.textContent = step.name || step.tool || step.id
    item.append(title, platformBadge(step.status))
    const details = [step.tool, `${uiText('尝试', 'Attempts')}: ${step.attempts ?? 0}`, step.checkpointAt ? uiText('检查点已保存', 'Checkpoint saved') : '', step.requiresApproval ? uiText('需要人工确认', 'Human approval required') : '', step.sideEffect && step.sideEffect !== 'none' ? `${uiText('操作风险', 'Effect risk')}: ${step.sideEffect}` : '', step.error].filter(Boolean)
    if (details.length) {
      const detail = document.createElement('small')
      detail.textContent = details.join(' · ')
      item.append(detail)
    }
    if (['failed', 'waiting', 'interrupted'].includes(step.status)) item.append(platformButton(uiText('重试此步骤', 'Retry this step'), () => {
      void platformAction('workflow.retry', { workflowId: workflow.id, id: workflow.id, stepId: step.id })
    }, '↻'))
    steps.append(item)
    if (step.input || step.result) {
      const detail = document.createElement('details')
      detail.dataset['detailKey'] = `${workflow.id}:${step.id}:result`
      const summary = document.createElement('summary')
      summary.textContent = uiText('输入与结果', 'Input and result')
      const output = document.createElement('pre')
      output.className = 'platform-output'
      output.textContent = JSON.stringify({ input: step.input, result: step.result }, null, 2)
      detail.append(summary, output)
      item.append(detail)
    }
    if (step.needsInput) {
      const field = document.createElement('textarea')
      field.className = 'settings-input workflow-step-input'
      field.rows = 3
      field.placeholder = '{}'
      field.setAttribute('aria-label', uiText('重新提供此步骤的输入参数', 'Provide step input again'))
      const restore = platformButton(uiText('保存步骤输入', 'Save step input'), () => {
        try {
          const input: unknown = JSON.parse(field.value)
          if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error(uiText('步骤输入必须为 JSON 对象', 'Step input must be a JSON object'))
          field.value = ''
          void platformAction('workflow.input', { workflowId: workflow.id, stepId: step.id, input })
        } catch (error) { platformMessage(error instanceof Error ? error.message : String(error), true) }
      })
      item.append(field, restore)
    }
  }
  container.append(steps)
  if (workflow.error) {
    const error = document.createElement('p')
    error.className = 'platform-error'
    error.textContent = workflow.error
    container.append(error)
  }
  if (workflow.logs?.length || workflow.events?.length) {
    const detail = document.createElement('details')
    detail.dataset['detailKey'] = `${workflow.id}:log`
    const summary = document.createElement('summary')
    summary.textContent = uiText('执行日志', 'Execution log')
    const log = document.createElement('pre')
    log.className = 'platform-output'
    const lines = workflow.logs ?? workflow.events?.map((event) => ({ at: event.at, message: `${event.event}${event.stepId ? ` (${event.stepId})` : ''}${event.detail ? `: ${event.detail}` : ''}` })) ?? []
    log.textContent = lines.slice(-50).map((line) => `${line.at ? new Date(line.at).toLocaleTimeString() : ''} ${line.message ?? ''}`).join('\n')
    detail.append(summary, log)
    container.append(detail)
  }
  return container
}

function loadNetworkForm(): void {
  const id = platformElement<HTMLSelectElement>('network-profile').value
  const network = platform?.network[id]
  platformElement<HTMLSelectElement>('network-mode').value = network?.mode === 'proxy' ? 'fixed_servers' : network?.mode ?? 'system'
  platformInput('network-rules').value = network?.host ? `${network.protocol ?? 'http'}://${network.host.includes(':') ? `[${network.host}]` : network.host}:${network.port}` : ''
  platformInput('network-bypass').value = network?.bypass?.join(';') ?? ''
  platformInput('network-enabled').checked = network?.enabled !== false
  platformElement<HTMLTextAreaElement>('network-sites').value = network?.rules?.map((rule) => `${rule.site}=${rule.protocol}://${rule.host.includes(':') ? `[${rule.host}]` : rule.host}:${rule.port}`).join('\n') ?? ''
  platformInput('network-username').value = ''
  platformInput('network-password').value = ''
}

function renderPermissions(): void {
  if (!platform) return
  for (const [id, records] of [['permission-grants', platform.permissions.grants], ['permission-audit', platform.permissions.audit.slice(-40).reverse()]] as const) {
    const list = platformElement(id)
    list.replaceChildren()
    if (!records.length) platformEmpty(list, id === 'permission-grants' ? uiText('暂无有效授权', 'No active grants') : uiText('暂无审批记录', 'No approval records'))
    for (const record of records) {
      const row = document.createElement('div')
      row.className = 'platform-row'
      const content = document.createElement('div')
      content.className = 'platform-row-content'
      const title = document.createElement('strong')
      title.textContent = String(record['level'] ?? record['permission'] ?? record['capability'] ?? record['kind'] ?? record['action'] ?? '')
      const details = document.createElement('span')
      details.className = 'platform-detail'
      details.textContent = ['profileId', 'taskId', 'clientId', 'action', 'allowed', 'remainingUses', 'decision', 'status', 'reason'].filter((key) => record[key] !== undefined).map((key) => `${key}: ${String(record[key])}`).join(' · ')
      if (typeof record['expiresAt'] === 'number') details.textContent += ` · ${uiText('有效期至', 'Expires')}: ${new Date(record['expiresAt']).toLocaleTimeString()}`
      if (typeof record['at'] === 'number') details.textContent += ` · ${new Date(record['at']).toLocaleTimeString()}`
      content.append(title, details)
      row.append(content)
      if (id === 'permission-grants' && typeof record['id'] === 'string') row.append(platformButton(uiText('撤销授权', 'Revoke grant'), () => {
        void platformAction('permission.revoke', { grantId: record['id'], id: record['id'] })
      }, '×'))
      list.append(row)
    }
  }
}

function renderDiagnostics(): void {
  if (!platform) return
  const metrics = platformElement('diagnostics-metrics')
  metrics.replaceChildren()
  const values: Array<[string, string]> = [
    [uiText('MCP 连接', 'MCP clients'), String(state.agentCount)],
    [uiText('运行配置文件', 'Running profiles'), String(platform.profiles.filter((profile) => profile.running).length)],
    [uiText('标签页', 'Tabs'), String(state.tabs.length)],
    [uiText('工作流运行中', 'Running workflows'), String(platform.workflows.filter((workflow) => workflow.status === 'running').length)]
  ]
  for (const [label, value] of values) {
    const metric = document.createElement('div')
    const title = document.createElement('span')
    const number = document.createElement('strong')
    title.textContent = label
    number.textContent = value
    metric.append(title, number)
    metrics.append(metric)
  }
  const details = platformElement('diagnostics-details')
  details.replaceChildren()
  if (Object.keys(platform.diagnostics).length) {
    const output = document.createElement('pre')
    output.className = 'platform-output'
    output.textContent = JSON.stringify(platform.diagnostics, null, 2)
    details.append(output)
  }
  for (const tab of state.tabs) {
    if (!tab.recovery || tab.recovery.status === 'healthy') continue
    const item = document.createElement('p')
    item.className = 'platform-detail'
    item.textContent = `${tab.title}: ${tab.recovery.status} · ${tab.recovery.attempts}${tab.recovery.error ? ` · ${tab.recovery.error}` : ''}`
    details.append(item)
  }
}

function renderPlatform(): void {
  if (!platform) return
  renderProfiles()
  if (!settingsModal?.hidden) {
    renderWorkflows()
    renderPermissions()
    renderDiagnostics()
  }
}

async function refreshPlatform(): Promise<void> {
  if (platformRefreshing) return
  platformRefreshing = true
  try {
    const value = await window.aa.platformState()
    if (!value || !Array.isArray(value.profiles)) throw new Error(uiText('平台服务尚未就绪', 'Platform services are not ready'))
    platform = value
    platformLastRefresh = Date.now()
    renderPlatform()
    if (!platformElement<HTMLSelectElement>('network-profile').dataset['loaded']) {
      loadNetworkForm()
      platformElement<HTMLSelectElement>('network-profile').dataset['loaded'] = 'true'
    }
  } catch (error) {
    platformMessage(error instanceof Error ? error.message : String(error), true)
  } finally {
    platformRefreshing = false
  }
}

function schedulePlatformRefresh(): void {
  const activeProfileId = state.tabs.find((tab) => tab.active)?.profileId
  if (!platform || activeProfileId && activeProfileId !== platform.activeProfileId || (!settingsModal?.hidden && Date.now() - platformLastRefresh > 1500)) {
    clearTimeout(platformRefreshTimer)
    platformRefreshTimer = undefined
    void refreshPlatform()
  } else if (!settingsModal?.hidden && !platformRefreshTimer) {
    platformRefreshTimer = setTimeout(() => {
      platformRefreshTimer = undefined
      void refreshPlatform()
    }, Math.max(50, 1500 - (Date.now() - platformLastRefresh)))
  }
}

async function platformAction(action: string, input: Record<string, unknown> = {}): Promise<PlatformActionResult> {
  if (action !== 'profile.select' && settingsModal && !settingsModal.hidden && !settingsReady) return { ok: false, error: uiText('设置尚未就绪', 'Settings are not ready') }
  if (platformBusy) return { ok: false, error: uiText('操作正在进行', 'An operation is in progress') }
  platformBusy = true
  platformMessage(uiText('正在执行…', 'Working…'))
  for (const section of document.querySelectorAll<HTMLElement>('[id^="settings-section-"]')) {
    if (section.querySelector('.platform-form, .platform-list, .platform-metrics')) section.setAttribute('aria-busy', 'true')
  }
  renderPlatform()
  try {
    const result = await window.aa.platformAction(action, input)
    if (!result?.ok) throw new Error(result?.error ?? uiText('操作失败', 'Operation failed'))
    platformMessage(uiText('操作已完成', 'Done'))
    await refreshPlatform()
    return result
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    platformMessage(message, true)
    return { ok: false, error: message }
  } finally {
    platformBusy = false
    for (const section of document.querySelectorAll<HTMLElement>('[aria-busy="true"][id^="settings-section-"]')) section.removeAttribute('aria-busy')
    renderPlatform()
  }
}

async function profileArchive(action: 'profile.import' | 'profile.export', profileId?: string): Promise<void> {
  const password = platformInput('profile-passphrase')
  const passphrase = password.value
  password.value = ''
  if (passphrase.length < 12) {
    platformMessage(uiText('备份密码至少需要 12 个字符。', 'Backup password must contain at least 12 characters.'), true)
    password.focus()
    return
  }
  await platformAction(action, { profileId, passphrase })
}

for (const section of document.querySelectorAll<HTMLElement>('#settings-section-workflows, #settings-section-network, #settings-section-security, #settings-section-diagnostics')) {
  const message = document.createElement('div')
  message.className = 'platform-status'
  message.dataset['platformStatus'] = ''
  message.setAttribute('role', 'status')
  message.setAttribute('aria-live', 'polite')
  section.prepend(message)
}
profileSelector.addEventListener('change', () => {
  void platformAction('profile.select', { profileId: profileSelector.value })
})
platformElement('profile-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const profileId = platformInput('profile-edit-id').value
  void platformAction(profileId ? 'profile.update' : 'profile.create', {
    profileId: profileId || undefined,
    name: platformInput('profile-name').value.trim(), description: platformInput('profile-description').value.trim(),
    color: platformInput('profile-color').value, icon: platformElement<HTMLSelectElement>('profile-icon').value
  }).then((result) => { if (result.ok) editProfile() })
})
platformElement('profile-reset').addEventListener('click', () => editProfile())
platformElement('profile-import').addEventListener('click', () => { void profileArchive('profile.import') })
platformElement('platform-refresh').addEventListener('click', () => { void refreshPlatform() })
platformElement('workflow-form').addEventListener('submit', (event) => {
  event.preventDefault()
  try {
    const templateId = platformElement<HTMLSelectElement>('workflow-template').value
    const input: Record<string, unknown> = {
      name: platformInput('workflow-name').value.trim(), profileId: platformElement<HTMLSelectElement>('workflow-profile').value,
      templateId, url: platformInput('workflow-url').value.trim()
    }
    if (templateId === 'multi-page' || templateId === 'compare') input['urls'] = platformElement<HTMLTextAreaElement>('workflow-urls').value.split(/\r?\n/).map((url) => url.trim()).filter(Boolean)
    if (templateId === 'form' || templateId === 'page-test') {
      const parameters: unknown = JSON.parse(platformElement<HTMLTextAreaElement>('workflow-parameters').value)
      if (!Array.isArray(parameters)) throw new Error(uiText('模板参数必须为 JSON 数组', 'Template parameters must be a JSON array'))
      input[templateId === 'form' ? 'fields' : 'checks'] = parameters
    }
    if (templateId === 'scheduled') input['scheduleAt'] = new Date(platformInput('workflow-schedule').value).getTime()
    void platformAction('workflow.create', input).then((result) => {
      if (result.ok) {
        platformInput('workflow-name').value = ''
        platformElement<HTMLTextAreaElement>('workflow-parameters').value = ''
      }
    })
  } catch (error) { platformMessage(error instanceof Error ? error.message : String(error), true) }
})
platformElement('workflow-template').addEventListener('change', renderTemplateParameters)
platformElement('network-profile').addEventListener('change', loadNetworkForm)
platformElement('network-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const profileId = platformElement<HTMLSelectElement>('network-profile').value
  const mode = platformElement<HTMLSelectElement>('network-mode').value
  const config: Record<string, unknown> = { enabled: platformInput('network-enabled').checked, mode: mode === 'fixed_servers' ? 'proxy' : mode, bypass: platformInput('network-bypass').value.split(/[;,\n]/).map((item) => item.trim()).filter(Boolean), rules: [] }
  try {
    if (mode === 'fixed_servers') {
      const endpoint = new URL(platformInput('network-rules').value.trim())
      if (!['http:', 'https:', 'socks5:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.pathname !== '/' && endpoint.pathname !== '' || endpoint.search || endpoint.hash) throw new Error(uiText('请输入无凭据的 HTTP、HTTPS 或 SOCKS5 代理地址。', 'Enter an HTTP, HTTPS or SOCKS5 proxy URL without embedded credentials.'))
      config['protocol'] = endpoint.protocol.slice(0, -1)
      config['host'] = endpoint.hostname.replace(/^\[|\]$/g, '')
      config['port'] = Number(endpoint.port || (endpoint.protocol === 'https:' ? 443 : endpoint.protocol === 'http:' ? 80 : 1080))
      config['rules'] = platformElement<HTMLTextAreaElement>('network-sites').value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
        const separator = line.indexOf('=')
        if (separator < 1) throw new Error(uiText('站点规则格式应为：站点=代理网址', 'Use site=proxy URL for each rule'))
        const proxy = new URL(line.slice(separator + 1).trim())
        if (!['http:', 'https:', 'socks5:'].includes(proxy.protocol) || proxy.username || proxy.password || proxy.search || proxy.hash || proxy.pathname !== '/' && proxy.pathname !== '') throw new Error(uiText('站点代理规则无效', 'Invalid per-site proxy URL'))
        return { site: line.slice(0, separator).trim(), protocol: proxy.protocol.slice(0, -1), host: proxy.hostname.replace(/^\[|\]$/g, ''), port: Number(proxy.port || (proxy.protocol === 'https:' ? 443 : proxy.protocol === 'http:' ? 80 : 1080)) }
      })
    }
    const username = platformInput('network-username').value
    const password = platformInput('network-password').value
    if (username || password) { config['username'] = username; config['password'] = password }
    platformInput('network-password').value = ''
    platformInput('network-username').value = ''
    void platformAction('network.set', { profileId, config }).then((result) => { if (result.ok) loadNetworkForm() })
  } catch (error) {
    platformMessage(error instanceof Error ? error.message : String(error), true)
  }
})
for (const action of ['test', 'diagnose'] as const) platformElement(`network-${action}`).addEventListener('click', () => {
  void platformAction(`network.${action}`, { profileId: platformElement<HTMLSelectElement>('network-profile').value }).then((result) => {
    const output = platformElement('network-result')
    output.hidden = false
    output.textContent = result.ok ? JSON.stringify(result.data ?? {}, null, 2) : result.error ?? ''
  })
})
platformElement('diagnostics-refresh').addEventListener('click', () => { void platformAction('diagnostics.refresh') })
platformElement('network-clear-auth').addEventListener('click', () => {
  if (!window.confirm(uiText('移除此配置文件保存的代理凭据？', 'Remove the proxy credentials saved for this profile?'))) return
  void platformAction('network.set', { profileId: platformElement<HTMLSelectElement>('network-profile').value, config: { password: null } })
})
platformElement('diagnostics-repair').addEventListener('click', () => {
  const action = platformElement<HTMLSelectElement>('diagnostics-repair-action').value
  const profileId = platformElement<HTMLSelectElement>('diagnostics-profile').value
  const tab = state.tabs.find((tab) => tab.profileId === profileId && tab.active) ?? state.tabs.find((tab) => tab.profileId === profileId)
  if (action === 'reload' && !window.confirm(uiText('重新加载页面可能丢失未保存的表单。继续？', 'Reloading pages may lose unsaved form data. Continue?'))) return
  void platformAction('diagnostics.repair', { profileId, action, ...(tab ? { tabId: tab.id } : {}) })
})
const workflowShortcut = platformButton(uiText('管理工作流', 'Manage workflows'), () => {
  void openSettings().then((ready) => { if (ready) scrollToSettingsSection('settings-section-workflows') })
})
workflowShortcut.id = 'btn-manage-workflows'
document.querySelector('.task-center-toolbar')?.append(workflowShortcut)
void refreshPlatform()

/* 初始化读取也参与保存基线排序，不因打开/关闭过模态而丢失有效外观。 */
// 先用同步缓存（上次选择或系统语言）套一次文案，避免首帧中文再跳到英文。
applyLocale(savedLocale)
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
