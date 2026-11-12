import { contextBridge, ipcRenderer } from 'electron'
import type { DownloadInfo, HistoryEntry, AppSettings, SettingsView, AgentInfo, UpdateState } from '@shared/types'

/** 浏览器外壳 UI 与主进程的桥（chromeView 专用，页面视图不带 preload） */
contextBridge.exposeInMainWorld('aa', {
  getState: (): Promise<unknown> => ipcRenderer.invoke('aa:get-state'),
  tabNew: (url?: string): Promise<void> => ipcRenderer.invoke('aa:tab-new', url),
  tabClose: (id: string): Promise<void> => ipcRenderer.invoke('aa:tab-close', id),
  tabSelect: (id: string): Promise<void> => ipcRenderer.invoke('aa:tab-select', id),
  back: (): Promise<void> => ipcRenderer.invoke('aa:back'),
  forward: (): Promise<void> => ipcRenderer.invoke('aa:forward'),
  reload: (): Promise<void> => ipcRenderer.invoke('aa:reload'),
  submit: (value: string): Promise<void> => ipcRenderer.invoke('aa:omnibox-submit', value),
  devtools: (): Promise<void> => ipcRenderer.invoke('aa:devtools'),
  decideApproval: (id: string, allowed: boolean): Promise<boolean> => ipcRenderer.invoke('aa:approval-decide', id, allowed),
  interruptAgent: (): Promise<boolean> => ipcRenderer.invoke('aa:agent-interrupt'),
  resumeAgent: (): Promise<boolean> => ipcRenderer.invoke('aa:agent-resume'),
  downloadsList: (): Promise<unknown> => ipcRenderer.invoke('aa:downloads-list'),
  downloadOpen: (id: string): Promise<void> => ipcRenderer.invoke('aa:download-open', id),
  downloadShow: (id: string): Promise<void> => ipcRenderer.invoke('aa:download-show', id),
  downloadDir: (): Promise<string> => ipcRenderer.invoke('aa:download-dir'),
  historySuggest: (query: string, limit?: number): Promise<HistoryEntry[]> => ipcRenderer.invoke('aa:history-suggest', query, limit),
  settingsGet: (): Promise<SettingsView | null> => ipcRenderer.invoke('aa:settings-get'),
  settingsSet: (patch: Partial<AppSettings>): Promise<AppSettings | null> => ipcRenderer.invoke('aa:settings-set', patch),
  agentInfo: (): Promise<AgentInfo | null> => ipcRenderer.invoke('aa:agent-info'),
  clientsDetect: (): Promise<unknown> => ipcRenderer.invoke('aa:clients-detect'),
  clientsSetup: (ids: string[]): Promise<unknown> => ipcRenderer.invoke('aa:clients-setup', ids),
  updateCheck: (): Promise<UpdateState> => ipcRenderer.invoke('aa:update-check'),
  updateDownload: (): Promise<UpdateState> => ipcRenderer.invoke('aa:update-download'),
  updateInstall: (): Promise<boolean> => ipcRenderer.invoke('aa:update-install'),
  onState: (cb: (state: unknown) => void): void => {
    ipcRenderer.on('aa:state', (_e, state) => cb(state))
  },
  onFocusOmnibox: (cb: () => void): void => {
    ipcRenderer.on('aa:focus-omnibox', () => cb())
  }
})
