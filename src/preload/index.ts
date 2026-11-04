import { contextBridge, ipcRenderer } from 'electron'

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
  onState: (cb: (state: unknown) => void): void => {
    ipcRenderer.on('aa:state', (_e, state) => cb(state))
  },
  onFocusOmnibox: (cb: () => void): void => {
    ipcRenderer.on('aa:focus-omnibox', () => cb())
  }
})

/** 新标签页专用 API（仅 newtab 页面注入；导航到普通网站时不暴露） */
if (/newtab\.html$/.test(location.pathname)) {
  contextBridge.exposeInMainWorld('aaNewtab', {
    detectClients: (): Promise<unknown> => ipcRenderer.invoke('aa:clients-detect'),
    setupClients: (ids: string[]): Promise<unknown> => ipcRenderer.invoke('aa:clients-setup', ids)
  })
}
