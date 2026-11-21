import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import type { ConnectionInfo, WsRequest, WsProgressEvent, AgentActivityState, AgentCallInfo } from '@shared/types'
import type { McpToolDef } from './tools'
import type { ApprovalManager } from './approvals'
import { runWithProgress } from './progress'
import { writeJsonAtomic } from './atomic-json'

const CONNECT_DIR = path.join(os.homedir(), '.aabrowser')
const DEFAULT_CONNECT_FILE = path.join(CONNECT_DIR, 'connection.json')

type ActiveTool = AgentCallInfo

function cloneActivity(state: AgentActivityState): AgentActivityState {
  return { ...state, calls: state.calls?.map((call) => ({ ...call })) }
}

function connectionFile(): string {
  return process.env['AA_BROWSER_CONNECTION_FILE'] || DEFAULT_CONNECT_FILE
}

/** 本地 Agent 接入服务：WS + token 鉴权 + connection.json 发现文件 */
export class AgentServer {
  private server = http.createServer()
  private wss: WebSocketServer
  private clients = new Set<WebSocket>()
  private verifiedClients = new Set<WebSocket>()
  private port = 0
  private token = ''
  private instanceId = crypto.randomUUID()
  private ownConnectionFile = ''
  private activityState: AgentActivityState = { active: false, paused: false }
  private activeTools = new Map<WebSocket, Map<number, ActiveTool>>()
  private active = new Map<WebSocket, Map<number, AbortController>>()
  private clientIds = new Map<WebSocket, number>()
  private clientSeq = 0
  private lastActivityPushAt = 0

  constructor(
    private tools: McpToolDef[],
    private onStatusChange: (count: number, verifiedCount: number) => void,
    private version: string,
    private approvals?: ApprovalManager,
    private onActivityChange: (state: AgentActivityState) => void = () => {}
  ) {
    this.wss = new WebSocketServer({ server: this.server })
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req))
  }

  async start(): Promise<void> {
    this.token = crypto.randomBytes(24).toString('hex')
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address()
        if (addr && typeof addr === 'object') this.port = addr.port
        resolve()
      })
    })
    this.ownConnectionFile = connectionFile()
    const info: ConnectionInfo = {
      port: this.port,
      token: this.token,
      pid: process.pid,
      version: this.version,
      startedAt: Date.now(),
      instanceId: this.instanceId
    }
    const discoveryDir = path.resolve(path.dirname(this.ownConnectionFile))
    fs.mkdirSync(discoveryDir, { recursive: true, mode: 0o700 })
    // Only the application's private directory is ours to tighten. An existing custom
    // parent may be shared with other applications; the token file still uses 0600.
    if (process.platform !== 'win32' && path.resolve(discoveryDir) === path.resolve(CONNECT_DIR)) {
      try {
        if (!fs.lstatSync(discoveryDir).isSymbolicLink()) fs.chmodSync(discoveryDir, 0o700)
      } catch { /* 收紧失败不阻止令牌文件的 0600 保护。 */ }
    }
    writeJsonAtomic(this.ownConnectionFile, info)
  }

  /** 供设置面板展示：本地 Agent 服务的连接信息 */
  info(): { port: number; token: string; version: string; discoveryFile: string; clientCount: number; verifiedClientCount: number } {
    return {
      port: this.port,
      token: this.token,
      version: this.version,
      discoveryFile: this.ownConnectionFile || connectionFile(),
      clientCount: this.clients.size,
      verifiedClientCount: this.verifiedClients.size
    }
  }

  /** 当前活动快照，返回副本避免调用方修改内部状态。 */
  activity(): AgentActivityState {
    return cloneActivity(this.activityState)
  }

  /** 中断当前调用并进入暂停状态；重复调用不会重复广播或产生额外副作用。 */
  pause(resumeAt?: number): void {
    for (const calls of this.active.values()) {
      for (const controller of calls.values()) controller.abort()
    }
    // 调用 finally 仍会清理原 Map 引用；从当前活动集合移除，防止恢复后残留旧调用。
    this.activeTools.clear()
    const next: AgentActivityState = {
      active: false,
      paused: true,
      calls: [],
      ...(resumeAt !== undefined ? { resumeAt } : {})
    }
    const changed = this.activityState.active !== next.active ||
      this.activityState.paused !== next.paused ||
      this.activityState.resumeAt !== next.resumeAt ||
      this.activityState.tool !== next.tool ||
      this.activityState.startedAt !== next.startedAt
    this.activityState = next
    if (changed) this.onActivityChange(cloneActivity(this.activityState))
  }

  /** 清除暂停标记；新的调用会在 handleMessage 中重新成为 active。 */
  resume(): void {
    if (!this.activityState.paused && this.activityState.resumeAt === undefined) return
    this.activityState = { active: false, paused: false }
    this.onActivityChange(cloneActivity(this.activityState))
  }

  private refreshActivity(force = true): void {
    if (this.activityState.paused) return
    const entries: ActiveTool[] = []
    for (const calls of this.activeTools.values()) entries.push(...calls.values())
    entries.sort((a, b) => b.startedAt - a.startedAt)
    const current = entries[0]
    const calls: AgentCallInfo[] = entries.map((entry) => ({ ...entry }))
    const next: AgentActivityState = current
      ? { active: true, paused: false, tool: current.tool, startedAt: current.startedAt, calls }
      : { active: false, paused: false, calls: [] }
    const prev = this.activityState
    const structuralChanged = prev.active !== next.active ||
      prev.tool !== next.tool ||
      prev.startedAt !== next.startedAt ||
      prev.paused !== next.paused ||
      (prev.calls?.length ?? 0) !== calls.length ||
      (prev.calls ?? []).some((call, i) => call.id !== calls[i]?.id || call.client !== calls[i]?.client || call.tool !== calls[i]?.tool)
    const throttled = !force && !structuralChanged && Date.now() - this.lastActivityPushAt < 150
    this.activityState = next
    if (throttled) return
    this.lastActivityPushAt = Date.now()
    this.onActivityChange(cloneActivity(this.activityState))
  }

  /** 把工具上报的进度写回活动状态（限流推送）并发给对应客户端的桥。 */
  private sendProgress(ws: WebSocket, id: number, progress: number, total?: number, message?: string): void {
    const call = this.activeTools.get(ws)?.get(id)
    if (!call || this.activityState.paused) return
    if (Number.isFinite(progress)) call.progress = progress
    if (total !== undefined && Number.isFinite(total)) call.total = total
    if (message !== undefined) call.message = String(message).slice(0, 200)
    const event: WsProgressEvent = {
      id,
      event: 'progress',
      progress: Number.isFinite(progress) ? progress : 0,
      ...(total !== undefined ? { total } : {}),
      ...(message !== undefined ? { message } : {})
    }
    this.reply(ws, event)
    // 进度可能非常密集（等待轮询每 100ms 一次），限流到 ~6fps，完成/取消时再强制推送。
    this.refreshActivity(Date.now() - this.lastActivityPushAt >= 150)
  }

  /** 按 (client, id) 中断一个调用；旧版仅传 id 时必须唯一，否则拒绝猜测。 */
  cancelCall(id: number, client?: number): boolean {
    if (typeof id !== 'number' || !Number.isFinite(id)) return false
    if (client !== undefined && (!Number.isSafeInteger(client) || client < 1)) return false
    let target: AbortController | undefined
    for (const [ws, calls] of this.active) {
      if (client !== undefined && this.clientIds.get(ws) !== client) continue
      const controller = calls.get(id)
      if (!controller) continue
      // 请求 id 是客户端本地序号；不同连接可能都从 1 开始，不得中断首个匹配项。
      if (target) return false
      target = controller
    }
    if (!target) return false
    target.abort()
    return true
  }

  private onConnection(ws: WebSocket, req: http.IncomingMessage): void {
    // 仅允许本机 + token 校验
    const remote = req.socket.remoteAddress ?? ''
    if (!/^127\.0\.0\.1$|^::1$|^::ffff:127\.0\.0\.1$/.test(remote)) {
      ws.close(4403, 'forbidden')
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.searchParams.get('token') !== this.token) {
      ws.close(4401, 'unauthorized')
      return
    }
    this.clients.add(ws)
    this.clientIds.set(ws, ++this.clientSeq)
    this.onStatusChange(this.clients.size, this.verifiedClients.size)

    ws.on('message', (raw) => {
      void this.handleMessage(ws, raw.toString())
    })
    const dropClient = (): void => {
      const calls = this.active.get(ws)
      for (const controller of calls?.values() ?? []) controller.abort()
      this.active.delete(ws)
      this.activeTools.delete(ws)
      this.clients.delete(ws)
      this.clientIds.delete(ws)
      this.verifiedClients.delete(ws)
      this.refreshActivity()
      this.onStatusChange(this.clients.size, this.verifiedClients.size)
    }
    ws.on('close', dropClient)
    ws.on('error', dropClient)
  }

  private async handleMessage(ws: WebSocket, raw: string): Promise<void> {
    let req: WsRequest
    try {
      req = JSON.parse(raw) as WsRequest
    } catch {
      return
    }
    if (typeof req?.id !== 'number') return
    if (req.cancel === true) {
      this.active.get(ws)?.get(req.id)?.abort()
      return
    }
    // 活动 id 的响应权归原调用；忽略同连接的重复请求，既不覆盖 controller，
    // 也不回同 id 的错误（会让桥把原调用误判为失败）。取消帧仍在上面正常处理。
    if (this.active.get(ws)?.has(req.id)) return
    if (this.approvals?.isInterrupted()) {
      this.reply(ws, { id: req.id, ok: false, error: 'Agent 已被用户中断；请在浏览器工具栏点击“恢复”后重试。' })
      return
    }
    if (typeof req.tool !== 'string') return

    const tool = this.tools.find((t) => t.name === req.tool)
    if (!tool) {
      this.reply(ws, { id: req.id, ok: false, error: `未知工具: ${req.tool}` })
      return
    }
    const controller = new AbortController()
    // 中断可能与上面的 admission check 并发发生；在登记调用前再检查一次，
    // 防止暂停后仍把新工具标成 active。
    if (this.activityState.paused || this.approvals?.isInterrupted()) {
      this.reply(ws, { id: req.id, ok: false, error: 'Agent 已被用户中断；请在浏览器工具栏点击“恢复”后重试。' })
      return
    }
    let calls = this.active.get(ws)
    if (!calls) { calls = new Map(); this.active.set(ws, calls) }
    calls.set(req.id, controller)
    let activityCalls = this.activeTools.get(ws)
    if (!activityCalls) { activityCalls = new Map(); this.activeTools.set(ws, activityCalls) }
    activityCalls.set(req.id, {
      id: req.id,
      tool: req.tool,
      startedAt: Date.now(),
      client: this.clientIds.get(ws) ?? 0
    })
    this.refreshActivity()
    console.log(`[aa-browser] tool request: ${req.tool} (${req.id})`)
    try {
      const result = await runWithProgress(
        {
          report: (progress, total, message) => this.sendProgress(ws, req.id, progress, total, message)
        },
        () => tool.handler({ ...(req.args ?? {}), __aaSignal: controller.signal })
      )
      if (controller.signal.aborted || this.approvals?.isInterrupted()) {
        throw new Error('工具调用已被用户中断或取消。')
      }
      const args = req.args ?? {}
      const toolSucceeded = typeof result === 'object' && result !== null && (result as { isError?: boolean }).isError !== true
      if (toolSucceeded && req.tool === 'browser_tabs' && args['action'] === 'list' && !this.verifiedClients.has(ws)) {
        this.verifiedClients.add(ws)
        this.onStatusChange(this.clients.size, this.verifiedClients.size)
      }
      console.log(`[aa-browser] tool complete: ${req.tool} (${req.id})`)
      this.reply(ws, { id: req.id, ok: true, result })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.reply(ws, { id: req.id, ok: false, error: msg })
    } finally {
      calls.delete(req.id)
      if (!calls.size) this.active.delete(ws)
      activityCalls.delete(req.id)
      if (!activityCalls.size) this.activeTools.delete(ws)
      this.refreshActivity()
    }
  }

  private reply(ws: WebSocket, resp: unknown): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(resp))
    }
  }

  /** 清理发现文件（应用退出时调用） */
  stop(): void {
    try {
      const file = this.ownConnectionFile || connectionFile()
      const current = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<ConnectionInfo>
      if (current.instanceId === this.instanceId && current.pid === process.pid) fs.rmSync(file, { force: true })
    } catch {
      /* missing, stale, or owned by another instance */
    }
    try {
      this.wss.close()
      this.server.close()
    } catch {
      /* 忽略 */
    }
  }
}
