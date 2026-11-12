import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import type { ConnectionInfo, WsRequest } from '@shared/types'
import type { McpToolDef } from './tools'
import type { ApprovalManager } from './approvals'

const CONNECT_DIR = path.join(os.homedir(), '.aabrowser')
const DEFAULT_CONNECT_FILE = path.join(CONNECT_DIR, 'connection.json')

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
  private active = new Map<WebSocket, Map<number, AbortController>>()

  constructor(
    private tools: McpToolDef[],
    private onStatusChange: (count: number, verifiedCount: number) => void,
    private version: string,
    private approvals?: ApprovalManager
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
    fs.mkdirSync(path.dirname(this.ownConnectionFile), { recursive: true })
    fs.writeFileSync(this.ownConnectionFile, JSON.stringify(info, null, 2), 'utf-8')
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
    this.onStatusChange(this.clients.size, this.verifiedClients.size)

    ws.on('message', (raw) => {
      void this.handleMessage(ws, raw.toString())
    })
    ws.on('close', () => {
      const calls = this.active.get(ws)
      for (const controller of calls?.values() ?? []) controller.abort()
      this.active.delete(ws)
      this.clients.delete(ws)
      this.verifiedClients.delete(ws)
      this.onStatusChange(this.clients.size, this.verifiedClients.size)
    })
    ws.on('error', () => {
      const calls = this.active.get(ws)
      for (const controller of calls?.values() ?? []) controller.abort()
      this.active.delete(ws)
      this.clients.delete(ws)
      this.verifiedClients.delete(ws)
      this.onStatusChange(this.clients.size, this.verifiedClients.size)
    })
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
    let calls = this.active.get(ws)
    if (!calls) { calls = new Map(); this.active.set(ws, calls) }
    calls.set(req.id, controller)
    console.log(`[aa-browser] tool request: ${req.tool} (${req.id})`)
    try {
      const result = await tool.handler({ ...(req.args ?? {}), __aaSignal: controller.signal })
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
