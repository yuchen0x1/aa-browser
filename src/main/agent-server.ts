import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import type { ConnectionInfo, WsRequest } from '@shared/types'
import type { McpToolDef } from './tools'

const CONNECT_DIR = path.join(os.homedir(), '.aabrowser')
const CONNECT_FILE = path.join(CONNECT_DIR, 'connection.json')

/** 本地 Agent 接入服务：WS + token 鉴权 + connection.json 发现文件 */
export class AgentServer {
  private server = http.createServer()
  private wss: WebSocketServer
  private clients = new Set<WebSocket>()
  private port = 0
  private token = ''

  constructor(
    private tools: McpToolDef[],
    private onStatusChange: (count: number) => void,
    private version: string
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
    const info: ConnectionInfo = {
      port: this.port,
      token: this.token,
      pid: process.pid,
      version: this.version,
      startedAt: Date.now()
    }
    fs.mkdirSync(CONNECT_DIR, { recursive: true })
    fs.writeFileSync(CONNECT_FILE, JSON.stringify(info, null, 2), 'utf-8')
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
    this.onStatusChange(this.clients.size)

    ws.on('message', (raw) => {
      void this.handleMessage(ws, raw.toString())
    })
    ws.on('close', () => {
      this.clients.delete(ws)
      this.onStatusChange(this.clients.size)
    })
    ws.on('error', () => {
      this.clients.delete(ws)
      this.onStatusChange(this.clients.size)
    })
  }

  private async handleMessage(ws: WebSocket, raw: string): Promise<void> {
    let req: WsRequest
    try {
      req = JSON.parse(raw) as WsRequest
    } catch {
      return
    }
    if (typeof req?.id !== 'number' || typeof req?.tool !== 'string') return

    const tool = this.tools.find((t) => t.name === req.tool)
    if (!tool) {
      this.reply(ws, { id: req.id, ok: false, error: `未知工具: ${req.tool}` })
      return
    }
    try {
      const result = await tool.handler(req.args ?? {})
      this.reply(ws, { id: req.id, ok: true, result })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      this.reply(ws, { id: req.id, ok: false, error: msg })
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
      fs.rmSync(CONNECT_FILE, { force: true })
    } catch {
      /* 忽略 */
    }
    try {
      this.wss.close()
      this.server.close()
    } catch {
      /* 忽略 */
    }
  }
}
