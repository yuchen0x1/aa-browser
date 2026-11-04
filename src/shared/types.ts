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
export interface UiState {
  tabs: TabInfo[]
  activeId: string | null
  agentCount: number
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
  url: string
  title: string
  /** YAML 风格线性树，交互元素带 [ref=eN] */
  tree: string
  elements: SnapshotElement[]
  truncated: boolean
  capturedAt: number
}

/** Agent WebSocket 请求/响应协议 */
export interface WsRequest {
  id: number
  tool: string
  args?: Record<string, unknown>
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
}

/** MCP 工具返回的内容块 */
export interface ToolContent {
  type: 'text' | 'image'
  text?: string
  data?: string
  mimeType?: string
}
