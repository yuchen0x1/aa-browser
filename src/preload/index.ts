import { contextBridge, ipcRenderer } from 'electron'
import type { DownloadInfo, HistoryEntry, AppSettings, SettingsView, AgentInfo, UpdateState, PagePointerForward, ExtensionInfo, BackgroundMode, MonitorState } from '@shared/types'
import type { PlatformState, PlatformActionResult, ExtensionUpdateResult } from '@shared/platform-types'

/** 浏览器外壳 UI 与主进程的桥（chromeView 专用，页面视图不带 preload） */
contextBridge.exposeInMainWorld('aa', {
  getState: (): Promise<unknown> => ipcRenderer.invoke('aa:get-state'),
  platformState: (): Promise<PlatformState> => ipcRenderer.invoke('aa:platform-state'),
  platformAction: (action: string, input: Record<string, unknown> = {}): Promise<PlatformActionResult> => ipcRenderer.invoke('aa:platform-action', action, input),
  tabNew: (url?: string): Promise<void> => ipcRenderer.invoke('aa:tab-new', url),
  tabClose: (id: string): Promise<void> => ipcRenderer.invoke('aa:tab-close', id),
  tabReopen: (): Promise<boolean> => ipcRenderer.invoke('aa:tab-reopen'),
  findOpen: (): Promise<void> => ipcRenderer.invoke('aa:find-open'),
  find: (query: string, forward = true, next = false): Promise<void> => ipcRenderer.invoke('aa:find', query, forward, next),
  findClose: (): Promise<void> => ipcRenderer.invoke('aa:find-close'),
  overlayHeight: (height: number): Promise<void> => ipcRenderer.invoke('aa:overlay-height', height),
  forwardPagePointer: (payload: PagePointerForward): void => ipcRenderer.send('aa:page-pointer', payload),
  tabSelect: (id: string, focusPage = true): Promise<void> => ipcRenderer.invoke('aa:tab-select', id, focusPage),
  back: (): Promise<void> => ipcRenderer.invoke('aa:back'),
  forward: (): Promise<void> => ipcRenderer.invoke('aa:forward'),
  reload: (): Promise<void> => ipcRenderer.invoke('aa:reload'),
  submit: (value: string): Promise<void> => ipcRenderer.invoke('aa:omnibox-submit', value),
  devtools: (): Promise<void> => ipcRenderer.invoke('aa:devtools'),
  windowMode: (mode?: BackgroundMode): Promise<BackgroundMode> => ipcRenderer.invoke('aa:window-mode', mode),
  monitorStart: (tabId?: string): Promise<MonitorState | null> => ipcRenderer.invoke('aa:monitor-start', tabId),
  monitorStop: (): Promise<MonitorState | null> => ipcRenderer.invoke('aa:monitor-stop'),
  monitorHistoryFrame: (capturedAt: number): Promise<unknown> => ipcRenderer.invoke('aa:monitor-history-frame', capturedAt),
  monitorView: (visible: boolean): Promise<boolean> => ipcRenderer.invoke('aa:monitor-view', visible),
  monitorTakeover: (): Promise<MonitorState | null> => ipcRenderer.invoke('aa:monitor-takeover'),
  monitorRelease: (): Promise<MonitorState | null> => ipcRenderer.invoke('aa:monitor-release'),
  taskAction: (action: 'pause' | 'resume' | 'cancel', id?: number, client?: number): Promise<boolean> => ipcRenderer.invoke('aa:tasks-control', action, id, client),
  decideApproval: (id: string, allowed: boolean, remember = false): Promise<boolean> => ipcRenderer.invoke('aa:approval-decide', id, allowed, remember),
  interruptAgent: (): Promise<boolean> => ipcRenderer.invoke('aa:agent-interrupt'),
  takeoverAgent: (): Promise<boolean> => ipcRenderer.invoke('aa:agent-takeover'),
  resumeAgent: (): Promise<boolean> => ipcRenderer.invoke('aa:agent-resume'),
  cancelAgentCall: (id: number, client?: number): Promise<boolean> => ipcRenderer.invoke('aa:agent-cancel-call', id, client),
  downloadsList: (): Promise<DownloadInfo[]> => ipcRenderer.invoke('aa:downloads-list'),
  downloadOpen: (id: string): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('aa:download-open', id),
  downloadShow: (id: string): Promise<void> => ipcRenderer.invoke('aa:download-show', id),
  downloadCancel: (id: string): Promise<boolean> => ipcRenderer.invoke('aa:download-cancel', id),
  downloadRetry: (id: string): Promise<{ ok: boolean; reason?: string }> => ipcRenderer.invoke('aa:download-retry', id),
  downloadDir: (): Promise<string> => ipcRenderer.invoke('aa:download-dir'),
  historySuggest: (query: string, limit?: number): Promise<HistoryEntry[]> => ipcRenderer.invoke('aa:history-suggest', query, limit),
  settingsGet: (): Promise<SettingsView | null> => ipcRenderer.invoke('aa:settings-get'),
  settingsSet: (patch: Partial<AppSettings>): Promise<AppSettings | null> => ipcRenderer.invoke('aa:settings-set', patch),
  settingsOpen: (open: boolean): Promise<void> => ipcRenderer.invoke('aa:settings-open', open),
  extensionPick: (): Promise<string> => ipcRenderer.invoke('aa:extension-pick'),
  extensionList: (profileId?: string): Promise<ExtensionInfo[]> => ipcRenderer.invoke('aa:extension-list', profileId),
  extensionLoad: (dir: string, profileId?: string): Promise<{ ok: boolean; error?: string; extension?: ExtensionInfo }> => ipcRenderer.invoke('aa:extension-load', dir, profileId),
  extensionRemove: (key: string, profileId?: string): Promise<{ ok: boolean; error?: string; extension?: ExtensionInfo }> => ipcRenderer.invoke('aa:extension-remove', key, profileId),
  extensionEnable: (key: string, enabled: boolean, profileId?: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke('aa:extension-enable', key, enabled, profileId),
  extensionCheckUpdates: (profileId?: string): Promise<ExtensionUpdateResult> => ipcRenderer.invoke('aa:extension-check-updates', profileId),
  agentInfo: (): Promise<AgentInfo | null> => ipcRenderer.invoke('aa:agent-info'),
  copyConnectionDiagnostics: (): Promise<boolean> => ipcRenderer.invoke('aa:connection-diagnostics-copy'),
  clientsDetect: (): Promise<unknown> => ipcRenderer.invoke('aa:clients-detect'),
  clientsSetup: (ids: string[], locale?: string): Promise<unknown> => ipcRenderer.invoke('aa:clients-setup', ids, locale),
  updateCheck: (): Promise<UpdateState> => ipcRenderer.invoke('aa:update-check'),
  updateDownload: (): Promise<UpdateState> => ipcRenderer.invoke('aa:update-download'),
  updateInstall: (): Promise<boolean> => ipcRenderer.invoke('aa:update-install'),
  updateDismiss: (): Promise<void> => ipcRenderer.invoke('aa:update-dismiss'),
  updateRetry: (): Promise<UpdateState> => ipcRenderer.invoke('aa:update-retry'),
  updateWake: (): Promise<UpdateState> => ipcRenderer.invoke('aa:update-wake'),
  onState: (cb: (state: unknown) => void): void => {
    ipcRenderer.on('aa:state', (_e, state) => cb(state))
  },
  onMonitorFrame: (cb: (frame: unknown) => void): void => {
    ipcRenderer.on('aa:monitor-frame', (_e, frame) => cb(frame))
  },
  onFocusOmnibox: (cb: () => void): void => {
    ipcRenderer.on('aa:focus-omnibox', () => cb())
  },
  onFocusFind: (cb: () => void): void => {
    ipcRenderer.on('aa:focus-find', () => cb())
  },
  onOpenExtensions: (cb: () => void): void => {
    ipcRenderer.on('aa:open-extensions', () => cb())
  }
})
