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
  | 'defaultSearchEngine' | 'customSearchAddress' | 'isolatedSessionsHint' | 'downloadDirPlaceholder'
  | 'siteAllowlistHint' | 'siteAllowlistPlaceholder' | 'updateHint' | 'clientSetupHint'
  | 'restoreSession' | 'restoreSessionHint' | 'backgroundMode' | 'backgroundModeHint' | 'settingsSubtitle' | 'settingsSections'
  | 'settingsNavGeneral' | 'settingsNavBrowsing' | 'settingsNavData' | 'settingsNavAi'
  | 'settingsNavExtensions'
  | 'settingsDescGeneral' | 'settingsDescBrowsing' | 'settingsDescData' | 'settingsDescAi'
  | 'settingsDescExtensions'
  | 'settingsDescUpdate' | 'updateChannel' | 'engineHint'
  | 'extensionsLabel' | 'extensionsHint' | 'extensionsEmpty' | 'extensionsLoad' | 'extensionsRescan'
  | 'extensionsPickFailed' | 'extensionsLoadFailed' | 'extensionsLoaded' | 'extensionsRemoved' | 'extensionsRemoveFailed'
  | 'theme' | 'themeLight' | 'themeDark' | 'themeSystem'
  | 'connectionDetails' | 'copyConnectionDiagnostics' | 'connectionDiagnosticsHint'

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
    saving: '正在保存…', saved: '已保存', saveFailed: '保存失败：', autoLocale: '自动（跟随系统 / 浏览器）',
    defaultSearchEngine: '默认搜索引擎', customSearchAddress: '自定义地址',
    isolatedSessionsHint: '关闭时所有标签共享 Cookie 和登录态。Agent 也可以用 browser_tabs new isolated:true 单独打开隔离标签。',
    downloadDirPlaceholder: '留空以使用默认目录 ~/.aabrowser/downloads',
    siteAllowlistPlaceholder: '每行一个规则，例如：\nhttps://example.com\nhttps://*.example.org:8443',
    siteAllowlistHint: '填写后仅允许匹配的 HTTP/HTTPS 站点。留空表示不启用白名单。支持 *.example.com 子域名与 example.com/admin 路径前缀；不支持查询串或 # 片段。',
    updateHint: '更新来自 GitHub Releases。下载完成并通过 electron-updater 校验后才会安装。',
    clientSetupHint: '写入前自动备份，只改 aa-browser 一个键。写入后请在客户端确认工具已加载。',
    restoreSession: '重启后恢复上次打开的标签页',
    restoreSessionHint: '只恢复普通网页标签，不恢复隔离标签、内部页和 file/data 地址。关闭后下次启动打开新标签页。',
    backgroundMode: '后台运行模式',
    backgroundModeHint: '只改变窗口显示方式；Cookie、Storage 与登录态保持不变。',
    settingsSubtitle: '调整浏览、快照与 AI 连接行为', settingsSections: '设置分区',
    settingsNavGeneral: '通用', settingsNavBrowsing: '浏览与快照', settingsNavData: '数据与下载', settingsNavAi: 'AI 集成',
    settingsNavExtensions: '扩展',
    settingsDescGeneral: '界面语言与默认搜索引擎', settingsDescBrowsing: '快照输出、人工确认与标签页行为',
    settingsDescData: '下载落盘位置与可访问站点范围', settingsDescAi: '连接本机 AI 客户端与 Agent 本地服务',
    settingsDescExtensions: '加载已解压的扩展程序（开发者模式扩展）',
    settingsDescUpdate: '更新通道、下载与安装', updateChannel: '更新通道',
    extensionsLabel: '已解压扩展',
    extensionsHint: '选择包含 manifest.json 的文件夹。扩展装载到共享会话并跨重启保留，对之后打开或刷新的页面生效；隔离标签不装载扩展。',
    extensionsEmpty: '尚未加载任何扩展',
    extensionsLoad: '加载已解压的扩展程序…', extensionsRescan: '刷新列表',
    extensionsPickFailed: '无法打开目录选择对话框。',
    extensionsLoadFailed: '扩展加载失败：',
    extensionsLoaded: '已装载', extensionsRemoved: '已移除', extensionsRemoveFailed: '移除失败：',
    engineHint: '浏览器与 Agent 共用；也可直接填写自定义搜索基址。',
    theme: '主题', themeLight: '浅色（默认）', themeDark: '深色', themeSystem: '跟随系统',
    connectionDetails: '本机连接详情', copyConnectionDiagnostics: '复制连接诊断',
    connectionDiagnosticsHint: '只复制版本、平台、服务状态、桥文件状态和连接数量；不包含路径、令牌或浏览数据。'
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
    saving: 'Saving…', saved: 'Saved', saveFailed: 'Save failed: ', autoLocale: 'Automatic (follow system / browser)',
    defaultSearchEngine: 'Default search engine', customSearchAddress: 'Custom address',
    isolatedSessionsHint: 'When off, tabs share cookies and sign-in state. Agents can open an isolated tab with browser_tabs new isolated:true.',
    downloadDirPlaceholder: 'Leave blank to use ~/.aabrowser/downloads',
    siteAllowlistPlaceholder: 'One rule per line, for example:\nhttps://example.com\nhttps://*.example.org:8443',
    siteAllowlistHint: 'Only matching HTTP/HTTPS sites are allowed when configured. Leave blank to allow all HTTP/HTTPS sites. Supports *.example.com subdomains and example.com/admin path prefixes; query strings and # fragments are not supported.',
    updateHint: 'Updates come from GitHub Releases. electron-updater verifies the downloaded update before installation.',
    clientSetupHint: 'Aa Browser backs up the configuration and changes only the aa-browser entry. Confirm in the client that it loaded the tools.',
    restoreSession: 'Restore the tabs from the last session on restart',
    restoreSessionHint: 'Only regular web tabs are restored; isolated tabs, internal pages and file/data URLs are skipped. When off, the next launch starts with a new tab.',
    backgroundMode: 'Background run mode',
    backgroundModeHint: 'Changes only how the window is shown; cookies, Storage and sign-in state are preserved.',
    settingsSubtitle: 'Tune browsing, snapshots and AI connection behavior', settingsSections: 'Settings sections',
    settingsNavGeneral: 'General', settingsNavBrowsing: 'Browsing', settingsNavData: 'Data', settingsNavAi: 'AI integration',
    settingsNavExtensions: 'Extensions',
    settingsDescGeneral: 'Interface language and the default search provider', settingsDescBrowsing: 'Snapshot output, confirmations and tab behavior',
    settingsDescData: 'Where downloads go and which sites are reachable', settingsDescAi: 'Connect local AI clients and the Agent service',
    settingsDescExtensions: 'Load unpacked extensions (developer-mode extensions)',
    settingsDescUpdate: 'Update channel, download and install', updateChannel: 'Update channel',
    extensionsLabel: 'Unpacked extensions',
    extensionsHint: 'Pick a folder that contains manifest.json. Extensions load into the shared session, survive restarts and apply to pages opened or reloaded afterwards; isolated tabs do not get extensions.',
    extensionsEmpty: 'No extensions loaded yet',
    extensionsLoad: 'Load unpacked extension…', extensionsRescan: 'Refresh list',
    extensionsPickFailed: 'Could not open the folder picker.',
    extensionsLoadFailed: 'Failed to load the extension: ',
    extensionsLoaded: 'Loaded', extensionsRemoved: 'Removed', extensionsRemoveFailed: 'Failed to remove: ',
    engineHint: 'Shared by you and the Agent. You can also type a custom search base directly.',
    theme: 'Theme', themeLight: 'Light (default)', themeDark: 'Dark', themeSystem: 'System',
    connectionDetails: 'Local connection details', copyConnectionDiagnostics: 'Copy connection diagnostics',
    connectionDiagnosticsHint: 'Copies only version, platform, service status, bridge file status and connection counts—not paths, tokens or browsing data.'
  }
}

export function translate(locale: Locale, key: LocaleKey): string {
  return catalogs[locale][key] ?? catalogs['zh-CN'][key] ?? key
}
