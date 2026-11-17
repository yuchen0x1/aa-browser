export type Locale = 'zh-CN' | 'en-US'
export type LocaleSetting = 'auto' | Locale

export function resolveLocale(setting: LocaleSetting | undefined, candidates: readonly string[] = []): Locale {
  if (setting === 'zh-CN' || setting === 'en-US') return setting
  const values = candidates.length ? candidates : ['zh-CN']
  for (const value of values) {
    const normalized = String(value).toLowerCase()
    if (normalized === 'en' || normalized.startsWith('en-')) return 'en-US'
    if (normalized === 'zh' || normalized.startsWith('zh-')) return 'zh-CN'
  }
  return 'zh-CN'
}

export const localeLabels: Record<Locale, string> = { 'zh-CN': '简体中文', 'en-US': 'English' }

export type LocaleKey =
  | 'appTitle' | 'tabs' | 'newTab' | 'back' | 'forward' | 'reload' | 'agentWaiting'
  | 'searchOrUrl' | 'reopenTab' | 'findInPage' | 'activity' | 'downloads' | 'settings'
  | 'interrupt' | 'resume' | 'update' | 'updateProgress' | 'findLabel' | 'findPlaceholder'
  | 'previousMatch' | 'nextMatch' | 'close' | 'settingsTitle' | 'customSearch'
  | 'fullSnapshot' | 'approval' | 'isolatedSessions' | 'downloadDir' | 'siteAllowlist'
  | 'softwareUpdate' | 'autoUpdate' | 'stable' | 'beta' | 'currentVersion' | 'checkUpdate'
  | 'downloadUpdate' | 'connectClient' | 'scanningClients' | 'rescan' | 'writeClients'
  | 'agentService' | 'loading' | 'save' | 'saving' | 'saved' | 'saveFailed' | 'autoLocale'

const catalogs: Record<Locale, Record<LocaleKey, string>> = {
  'zh-CN': {
    appTitle: 'aa-browser', tabs: '浏览器标签页', newTab: '新建标签页 (Ctrl+T)', back: '后退 (Alt+←)',
    forward: '前进 (Alt+→)', reload: '刷新页面 (F5)', agentWaiting: '等待 AI 连接', searchOrUrl: '搜索或输入网址 (Ctrl+L)',
    reopenTab: '恢复关闭的标签页 (Ctrl+Shift+T)', findInPage: '在页面中查找 (Ctrl+F)', activity: '查看 Agent 活动记录',
    downloads: '下载', settings: '设置', interrupt: '中断', resume: '恢复', update: '软件更新', updateProgress: '更新下载进度',
    findLabel: '页面查找', findPlaceholder: '输入查找内容', previousMatch: '上一个匹配 (Shift+Enter)',
    nextMatch: '下一个匹配 (Enter)', close: '关闭', settingsTitle: '设置', customSearch: '自定义搜索基址（以 = 结尾）',
    fullSnapshot: '快照默认全量输出（关闭=增量省 token）', approval: '提交表单或输入后回车前弹人工确认',
    isolatedSessions: '新建标签默认使用隔离会话（不共享登录态，关闭即清除）', downloadDir: '下载保存目录',
    siteAllowlist: '站点白名单', softwareUpdate: '软件更新', autoUpdate: '自动检查并下载更新（安装前通知）',
    stable: '稳定版', beta: 'Beta 测试版', currentVersion: '当前版本', checkUpdate: '检查更新', downloadUpdate: '下载更新',
    connectClient: '连接 AI 客户端', scanningClients: '正在扫描已安装的 AI 客户端…', rescan: '重新扫描',
    writeClients: '写入所选客户端', agentService: 'Agent 本地服务', loading: '加载中…', save: '保存设置',
    saving: '正在保存…', saved: '已保存', saveFailed: '保存失败：', autoLocale: '自动（跟随系统 / 浏览器）'
  },
  'en-US': {
    appTitle: 'aa-browser', tabs: 'Browser tabs', newTab: 'New tab (Ctrl+T)', back: 'Back (Alt+←)',
    forward: 'Forward (Alt+→)', reload: 'Reload page (F5)', agentWaiting: 'Waiting for AI connection', searchOrUrl: 'Search or enter address (Ctrl+L)',
    reopenTab: 'Reopen closed tab (Ctrl+Shift+T)', findInPage: 'Find in page (Ctrl+F)', activity: 'Agent activity',
    downloads: 'Downloads', settings: 'Settings', interrupt: 'Interrupt', resume: 'Resume', update: 'Software update', updateProgress: 'Update download progress',
    findLabel: 'Find in page', findPlaceholder: 'Search text', previousMatch: 'Previous match (Shift+Enter)',
    nextMatch: 'Next match (Enter)', close: 'Close', settingsTitle: 'Settings', customSearch: 'Custom search base (must end with =)',
    fullSnapshot: 'Use full snapshot by default (off = incremental, saves tokens)', approval: 'Ask for confirmation before submitting forms or pressing Enter',
    isolatedSessions: 'Use isolated sessions for new tabs (no shared login; cleared on close)', downloadDir: 'Download directory',
    siteAllowlist: 'Site allowlist', softwareUpdate: 'Software update', autoUpdate: 'Check for and download updates automatically (notify before install)',
    stable: 'Stable', beta: 'Beta', currentVersion: 'Current version', checkUpdate: 'Check for updates', downloadUpdate: 'Download update',
    connectClient: 'Connect AI clients', scanningClients: 'Scanning installed AI clients…', rescan: 'Rescan',
    writeClients: 'Write to selected clients', agentService: 'Agent local service', loading: 'Loading…', save: 'Save settings',
    saving: 'Saving…', saved: 'Saved', saveFailed: 'Save failed: ', autoLocale: 'Automatic (follow system / browser)'
  }
}

export function translate(locale: Locale, key: LocaleKey): string {
  return catalogs[locale][key] ?? catalogs['zh-CN'][key] ?? key
}
