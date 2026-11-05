/** 共享类型定义：主进程 / 渲染进程 / CLI 三方共用的协议契约 */

/** 浏览器外壳 UI 需要的标签信息 */
export interface TabInfo {
  id: string
  title: string
  url: string
  favicon?: string
  loading: boolean
  active: boolean
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
}

export interface UiState {
  tabs: TabInfo[]
  activeId: string | null
  agentCount: number
  bridgeState: 'connected' | 'waiting' | 'disconnected'
  connectionMessage: string
  pendingApprovals: PendingApprovalInfo[]
  agentInterrupted: boolean
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
