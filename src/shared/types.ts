/** 共享类型定义：主进程 / 渲染进程 / CLI 三方共用的协议契约 */

/** 浏览器外壳 UI 需要的标签信息 */
export type TabRecoveryStatus = 'healthy' | 'recovering' | 'recovered' | 'failed'

export interface TabRecoveryInfo {
  status: TabRecoveryStatus
  attempts: number
  reason?: 'crash' | 'unresponsive'
  lastAttemptAt?: number
  recoveredAt?: number
  error?: string
}

export interface TabInfo {
  id: string
  /** 标签创建时间（毫秒时间戳） */
  createdAt?: number
  title: string
  url: string
  favicon?: string
  loading: boolean
  active: boolean
  /** 是否使用独立会话分区（不与普通标签共享登录态） */
  isolated?: boolean
  /** 是否由跨会话恢复重建（沿用上次的标签 id） */
  restored?: boolean
  /** 当前 MCP 连接拥有的标签；未归属标签可由第一个使用它的 Agent 认领。 */
  agentClientId?: number
  recovery?: TabRecoveryInfo
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
  /** sensitive=敏感输入；operation=高危操作确认；permission=站点权限请求 */
  kind?: 'sensitive' | 'operation' | 'permission'
  /** operation / permission 类型的说明文案 */
  detail?: string
  /** permission 类型的权限名 */
  permission?: string
}

export interface ActionLogItem {
  id: string
  tool: string
  summary: string
  ts: number
  isError?: boolean
}

/** 单个正在执行的 MCP 调用（多客户端并发时 HUD 需要逐个展示与取消） */
export interface AgentCallInfo {
  /** 原始 WS 调用 id，仅在同一客户端内唯一；HUD 用 (client, id) 定位“停止此调用”。 */
  id: number
  tool: string
  startedAt: number
  /** 服务端分配的客户端序号（1 起）；同一连接内稳定，服务端生命周期内不复用。 */
  client: number
  /** 进度（0–1 或原始进度值），由工具在长操作中上报。 */
  progress?: number
  total?: number
  message?: string
}

export interface AgentActivityState {
  /** 当前是否有工具调用正在执行；中断/暂停时为 false。 */
  active: boolean
  /** 当前（或最近开始的）MCP 工具名称；保留字段以兼容旧版 HUD。 */
  tool?: string
  /** 当前工具调用开始时间（Unix ms）。 */
  startedAt?: number
  /** 是否处于用户中断后的暂停窗口。 */
  paused: boolean
  /** 自动恢复时间（Unix ms）；非暂停状态省略。 */
  resumeAt?: number
  /** 所有正在执行的调用，按开始时间排序；无并发时可能只有一项。 */
  calls?: AgentCallInfo[]
  /** 最近任务记录（不包含调用参数或页面正文）。 */
  tasks?: AgentTaskRecord[]
}

export interface AgentTaskRecord extends AgentCallInfo {
  status: 'running' | 'cancelling' | 'completed' | 'failed' | 'cancelled' | 'interrupted'
  finishedAt?: number
  error?: string
  /** 跨进程唯一的任务标识，格式 client:callId:startedAt；旧客户端可以忽略。 */
  taskId?: string
  tabId?: string
  source?: string
  /** 创建该任务的浏览器进程实例；进程重启后 numeric client id 不能单独作为所有权证明。 */
  browserInstanceId?: string
  /** MCP 桥会话标识；应用重启后同一桥仍可用它查询原任务。 */
  clientSession?: string
  updatedAt?: number
  retryCount?: number
  steps?: Array<{ at: number; label: string; status?: string; detail?: string }>
  recovery?: {
    automaticReplay: false
    resumable: boolean
    requiresConfirmation: boolean
    reason: string
    lastAttemptAt?: number
  }
  sideEffect?: {
    risk: 'none' | 'possible' | 'committed' | 'uncertain'
    destructive: boolean
    updatedAt?: number
  }
}

export interface UiState {
  tabs: TabInfo[]
  activeId: string | null
  agentCount: number
  /** 已成功调用 browser_tabs 的 MCP 客户端数；仅令牌握手不计为已验证连接 */
  agentVerifiedCount: number
  bridgeState: 'starting' | 'connected' | 'waiting' | 'disconnected'
  pendingApprovals: PendingApprovalInfo[]
  agentInterrupted: boolean
  /** Agent 工具调用活动状态，供外壳显示操作中的高亮/状态提示。 */
  agentActivity?: AgentActivityState
  recentActions?: ActionLogItem[]
  downloads?: DownloadInfo[]
  update?: UpdateState
  find?: FindState
  canReopenClosed?: boolean
  /** 原生窗口完整内容高度（外壳 WebContentsView 可能只覆盖工具栏和浮层）。 */
  windowHeight?: number
  /** 当前窗口运行策略。 */
  backgroundMode?: BackgroundMode
  /** 实时后台预览与人工接管状态。 */
  monitor?: MonitorState
}

/** Electron 窗口的真实运行策略，不改变浏览器会话、Cookie 或 Storage。 */
export type BackgroundMode = 'visible' | 'background' | 'minimized' | 'hidden' | 'background-visual'

export interface MonitorState {
  enabled: boolean
  tabId?: string
  control: 'ai' | 'human'
  status: 'idle' | 'capturing' | 'paused' | 'error'
  currentTask?: string
  lastError?: string
  lastFrameAt?: number
  frameSeq: number
  history: { file: string; capturedAt: number; tabId: string; title: string; url: string; width: number; height: number }[]
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
  failedOperation?: 'check' | 'download' | 'install'
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

/** 已加载的已解压扩展（设置面板与 browser_extensions 工具共用） */
export interface ExtensionInfo {
  /** Chromium 分配的扩展 id */
  id: string
  name: string
  version: string
  manifestVersion: number
  /** 本机绝对路径（诊断展示用；可分享的诊断不含此字段） */
  path: string
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
  locale: 'auto' | 'zh-CN' | 'en-US'
  theme: 'light' | 'dark' | 'system'
  searchEngine: string
  fullSnapshot: boolean
  downloadDir: string
  requireOperationApproval: boolean
  allowedSites: string[]
  /** 新建标签默认使用一次性隔离会话 */
  isolatedSessions: boolean
  autoUpdate: boolean
  updateChannel: 'stable' | 'beta'
  /** 重启后恢复上次打开的普通标签页 */
  restoreSession: boolean
  /** 窗口运行策略；切换不会破坏登录态。 */
  backgroundMode: BackgroundMode
}

/** 设置面板返回值 */
export interface SettingsView {
  settings: AppSettings
  presets: { label: string; url: string }[]
}

export type BridgeFileState = 'present' | 'needs-setup' | 'missing'

/** 本地 Agent 服务连接信息（设置面板展示；不含连接令牌） */
export interface AgentInfo {
  port: number
  version: string
  discoveryFile: string
  bridgeFile: BridgeFileState
  /** 已通过本机令牌认证的 MCP 桥数量 */
  clientCount: number
  /** 已至少成功执行过一次工具调用的 MCP 桥数量 */
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
  /** full=完整树 / unchanged=与上次一致 / patch=仅变更区块 / page=分页片段 */
  mode: 'full' | 'unchanged' | 'patch' | 'page'
  url: string
  title: string
  /** Agent 可读文本：完整树或增量块（引擎已拼好头部） */
  tree: string
  elements: SnapshotElement[]
  newRefs?: string[]
  removedRefs?: string[]
  /** 是否有可渲染节点被省略（文本/选项裁剪不计入，见下面各原因位）。 */
  truncated: boolean
  nodeLimitReached?: boolean
  depthLimitReached?: boolean
  textClipped?: boolean
  optionsClipped?: boolean
  /** 本快照分配到的最大 ref 序号；主进程用它推进跨文档单调底线。 */
  refSeq?: number
  /** 分页模式：总行数 / 当前游标 / 下一页游标 / 是否还有后续页 */
  totalLines?: number
  cursor?: number
  nextCursor?: number | null
  hasMore?: boolean
  capturedAt: number
}

/** MCP 文本路径无需跨进程传输元素明细；页面仍持有完整 ref 和增量状态。 */
export type SnapshotSummary = Omit<PageSnapshot, 'elements'>

/** Agent WebSocket 请求/响应协议 */
export interface WsRequest {
  id: number
  tool: string
  args?: Record<string, unknown>
  cancel?: boolean
  /** 桥在同一 MCP 请求重连后保持不变；用于阻止高危操作被重复执行。 */
  idempotencyKey?: string
  /** MCP tools/call 的 _meta.progressToken，由桥透传，用于回传 notifications/progress */
  progressToken?: string | number
}
export interface WsResponse {
  id: number
  ok: boolean
  result?: unknown
  error?: string
}
/** 长操作进度事件（与响应共用 WS 通道，靠 event 字段区分） */
export interface WsProgressEvent {
  id: number
  event: 'progress'
  progress: number
  total?: number
  message?: string
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

/**
 * 活动 HUD 展开成整窗外壳视图时，页面区域被透明但仍参与命中测试的外壳覆盖。
 * 外壳把落在页面区域的指针事件转发给活动页，坐标使用窗口内容区 DIP。
 */
export interface PagePointerForward {
  type: 'mouseDown' | 'mouseUp' | 'mouseMove' | 'mouseWheel'
  x: number
  y: number
  button?: 'left' | 'right' | 'middle'
  clickCount?: number
  deltaX?: number
  deltaY?: number
}
