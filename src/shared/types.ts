/** 共享类型定义：主进程 / 渲染进程 / CLI 三方共用的协议契约 */

/** 浏览器外壳 UI 需要的标签信息 */
export interface TabInfo {
  id: string
  title: string
  url: string
  favicon?: string
  loading: boolean
  active: boolean
  /** 是否使用独立会话分区（不与普通标签共享登录态） */
  isolated?: boolean
  canBack: boolean
  canForward: boolean
}

/** 渲染进程（chrome UI）收到的完整状态 */
export interface PendingApprovalInfo {
  id: string
  site: string
  tabTitle: string
  fieldLabel: string
  createdAt: number
  /** sensitive=敏感输入；operation=高危操作确认 */
  kind?: 'sensitive' | 'operation'
  /** operation 类型的说明文案 */
  detail?: string
}

export interface ActionLogItem {
  id: string
  tool: string
  summary: string
  ts: number
  isError?: boolean
}

export interface UiState {
  tabs: TabInfo[]
  activeId: string | null
  agentCount: number
  /** 已成功调用 browser_tabs 的 MCP 客户端数；仅令牌握手不计为已验证连接 */
  agentVerifiedCount: number
  bridgeState: 'connected' | 'waiting' | 'disconnected'
  connectionMessage: string
  pendingApprovals: PendingApprovalInfo[]
  agentInterrupted: boolean
  recentActions?: ActionLogItem[]
  downloads?: DownloadInfo[]
  update?: UpdateState
  find?: FindState
  canReopenClosed?: boolean
}

export interface FindState {
  open: boolean
  query: string
  matches: number
  activeMatch: number
}

export type UpdateStatus = 'disabled' | 'idle' | 'checking' | 'up-to-date' | 'available' | 'downloading' | 'downloaded' | 'error'

export interface UpdateState {
  status: UpdateStatus
  currentVersion: string
  version?: string
  releaseDate?: string
  releaseNotes?: string
  size?: number
  downloaded?: number
  progress?: number
  bytesPerSecond?: number
  error?: string
  checkedAt?: number
  noticeVisible?: boolean
  retryAt?: number
  failedOperation?: 'check' | 'download'
}

/** chrome UI 展示的下载条目（精简自主进程 DownloadRecord，避免前端依赖主进程类型） */
export interface DownloadInfo {
  id: string
  filename: string
  url: string
  savePath: string
  totalBytes: number
  receivedBytes: number
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted'
  ts: number
}

/** omnibox 历史补全建议条目 */
export interface HistoryEntry {
  url: string
  title: string
  ts: number
  count: number
}

/** 用户可调设置（渲染层视图，主进程持久化） */
export interface AppSettings {
  searchEngine: string
  fullSnapshot: boolean
  downloadDir: string
  requireOperationApproval: boolean
  allowedSites: string[]
  /** 新建标签默认使用一次性隔离会话 */
  isolatedSessions: boolean
  autoUpdate: boolean
  updateChannel: 'stable' | 'beta'
}

/** 设置面板返回值 */
export interface SettingsView {
  settings: AppSettings
  presets: { label: string; url: string }[]
}

/** 本地 Agent 服务连接信息（设置面板展示） */
export interface AgentInfo {
  port: number
  token: string
  version: string
  discoveryFile: string
  /** 已通过本机令牌认证的 MCP 桥数量 */
  clientCount: number
  /** 已成功调用 browser_tabs(action=list) 的 MCP 桥数量 */
  verifiedClientCount: number
}

/** 快照里的单个元素（供 Agent 理解与动作引擎定位） */
export interface SnapshotElement {
  ref: string
  role: string
  name: string
  tag: string
  /** 顶层视口坐标下的包围盒（快照时刻） */
  bbox?: [number, number, number, number]
  href?: string
  value?: string
  checked?: boolean
  disabled?: boolean
  expanded?: boolean
  level?: number
  options?: string[]
}

/** 页面结构化快照（注入引擎的返回值，全部可 JSON 序列化） */
export interface PageSnapshot {
  v: number
  /** full=完整树 / unchanged=与上次一致 / patch=仅变更区块 */
  mode: 'full' | 'unchanged' | 'patch'
  url: string
  title: string
  /** Agent 可读文本：完整树或增量块（引擎已拼好头部） */
  tree: string
  elements: SnapshotElement[]
  newRefs?: string[]
  removedRefs?: string[]
  truncated: boolean
  capturedAt: number
}

/** Agent WebSocket 请求/响应协议 */
export interface WsRequest {
  id: number
  tool: string
  args?: Record<string, unknown>
  cancel?: boolean
}
export interface WsResponse {
  id: number
  ok: boolean
  result?: unknown
  error?: string
}

/** 写入 ~/.aabrowser/connection.json，供 MCP CLI 发现本地浏览器实例 */
export interface ConnectionInfo {
  port: number
  token: string
  pid: number
  version: string
  startedAt: number
  instanceId?: string
}

/** MCP 工具返回的内容块 */
export interface ToolContent {
  type: 'text' | 'image'
  text?: string
  data?: string
  mimeType?: string
}
