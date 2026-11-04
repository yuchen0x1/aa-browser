import type { WebContents } from 'electron'
import { ActionError } from './actions'

/** 单条网络请求记录（抓包缓冲区条目） */
export interface NetRequest {
  requestId: string
  url: string
  method: string
  resourceType: string
  status: number
  statusText: string
  mimeType: string
  requestHeaders: Record<string, string>
  responseHeaders: Record<string, string>
  size: number
  durationMs: number | null
  error: string | null
  ts: number
}

const MAX_ENTRIES = 500
const MAX_BODY_CHARS = 50000

/**
 * 基于 CDP Network 域的抓包引擎（每 tab 一个实例，惰性启用）。
 * Attach 会独占调试通道：DevTools 打开时启用会失败，需提示用户先关闭。
 */
export class NetworkCapture {
  private wc: WebContents
  private attached = false
  private entries: NetRequest[] = []
  private byId = new Map<string, NetRequest>()
  private listener: ((_e: unknown, method: string, params: Record<string, unknown>) => void) | null = null

  constructor(wc: WebContents) {
    this.wc = wc
  }

  get enabled(): boolean {
    return this.attached
  }

  /** 惰性启用：attach 调试器并开启 Network 域（幂等） */
  async ensure(): Promise<void> {
    if (this.attached) return
    const dbg = this.wc.debugger
    try {
      dbg.attach('1.3')
    } catch (err) {
      throw new ActionError(
        `无法开启抓包：调试通道被占用（通常是 DevTools 已打开，请先关闭后重试）。(${(err as Error).message})`
      )
    }
    try {
      await dbg.sendCommand('Network.enable', { maxResourceBufferSize: 5000000 })
    } catch (err) {
      try {
        dbg.detach()
      } catch {
        /* 忽略 */
      }
      throw new ActionError(`无法开启抓包：Network.enable 失败。(${(err as Error).message})`)
    }
    this.listener = (_e, method, params) => this.onMessage(method, params)
    dbg.on('message', this.listener)
    this.attached = true
  }

  dispose(): void {
    if (!this.attached) return
    if (this.listener) {
      try {
        this.wc.debugger.removeListener('message', this.listener)
      } catch {
        /* 忽略 */
      }
    }
    try {
      this.wc.debugger.detach()
    } catch {
      /* 忽略 */
    }
    this.attached = false
    this.listener = null
  }

  private push(entry: NetRequest): void {
    this.entries.push(entry)
    this.byId.set(entry.requestId, entry)
    if (this.entries.length > MAX_ENTRIES) {
      const removed = this.entries.splice(0, this.entries.length - MAX_ENTRIES)
      for (const r of removed) this.byId.delete(r.requestId)
    }
  }

  private onMessage(method: string, params: Record<string, unknown>): void {
    try {
      if (method === 'Network.requestWillBeSent') {
        const req = params['request'] as Record<string, unknown> | undefined
        if (!req) return
        this.push({
          requestId: String(params['requestId'] ?? ''),
          url: String(req['url'] ?? ''),
          method: String(req['method'] ?? 'GET'),
          resourceType: String(params['type'] ?? 'Other'),
          status: 0,
          statusText: '',
          mimeType: '',
          requestHeaders: normalizeHeaders(req['headers']),
          responseHeaders: {},
          size: 0,
          durationMs: null,
          error: null,
          ts: Date.now()
        })
      } else if (method === 'Network.responseReceived') {
        const entry = this.byId.get(String(params['requestId'] ?? ''))
        const resp = params['response'] as Record<string, unknown> | undefined
        if (!entry || !resp) return
        entry.status = Number(resp['status'] ?? 0)
        entry.statusText = String(resp['statusText'] ?? '')
        entry.mimeType = String(resp['mimeType'] ?? '')
        entry.responseHeaders = normalizeHeaders(resp['headers'])
        const timing = resp['timing'] as Record<string, unknown> | undefined
        if (timing && typeof timing['receiveHeadersEnd'] === 'number') {
          entry.durationMs = Math.round(Number(timing['receiveHeadersEnd']))
        }
      } else if (method === 'Network.loadingFinished') {
        const entry = this.byId.get(String(params['requestId'] ?? ''))
        if (!entry) return
        const len = Number(params['encodedDataLength'] ?? 0)
        if (len > 0) entry.size = len
        if (entry.durationMs === null) entry.durationMs = Math.max(0, Date.now() - entry.ts)
      } else if (method === 'Network.loadingFailed') {
        const entry = this.byId.get(String(params['requestId'] ?? ''))
        if (!entry) return
        entry.error = String(params['errorText'] ?? 'failed')
        entry.durationMs = Math.max(0, Date.now() - entry.ts)
      }
    } catch {
      /* 单条事件解析失败不影响其他 */
    }
  }

  clear(): void {
    this.entries = []
    this.byId.clear()
  }

  requests(filter: {
    urlContains?: string
    method?: string
    statusMin?: number
    statusMax?: number
    resourceType?: string
  }): NetRequest[] {
    let list = this.entries
    if (filter.urlContains) {
      const needle = filter.urlContains.toLowerCase()
      list = list.filter((e) => e.url.toLowerCase().includes(needle))
    }
    if (filter.method) list = list.filter((e) => e.method.toUpperCase() === filter.method!.toUpperCase())
    if (typeof filter.statusMin === 'number') list = list.filter((e) => e.status >= filter.statusMin!)
    if (typeof filter.statusMax === 'number') list = list.filter((e) => e.status <= filter.statusMax! && e.status > 0)
    if (filter.resourceType) {
      const rt = filter.resourceType.toLowerCase()
      list = list.filter((e) => e.resourceType.toLowerCase() === rt)
    }
    return list
  }

  find(requestId: string): NetRequest | null {
    return this.byId.get(requestId) ?? null
  }

  /** 拉取响应体（仅响应完成后可用） */
  async getResponseBody(requestId: string): Promise<{ content: string; base64Encoded: boolean } | null> {
    if (!this.attached) return null
    try {
      const result = (await this.wc.debugger.sendCommand('Network.getResponseBody', { requestId })) as {
        body?: string
        base64Encoded?: boolean
      } | null
      if (!result || typeof result['body'] !== 'string') return null
      return { content: result['body'], base64Encoded: !!result['base64Encoded'] }
    } catch {
      return null
    }
  }

  /** 导出 HAR 1.2（不含响应体） */
  toHar(version: string): Record<string, unknown> {
    return {
      log: {
        version: '1.2',
        creator: { name: 'Aa Browser', version },
        entries: this.entries.map((e) => ({
          startedDateTime: new Date(e.ts).toISOString(),
          time: e.durationMs ?? 0,
          request: {
            method: e.method,
            url: e.url,
            httpVersion: 'HTTP/1.1',
            headers: toHarHeaders(e.requestHeaders),
            queryString: [],
            headersSize: -1,
            bodySize: -1
          },
          response: {
            status: e.status,
            statusText: e.statusText,
            httpVersion: 'HTTP/1.1',
            headers: toHarHeaders(e.responseHeaders),
            content: { size: e.size, mimeType: e.mimeType || 'unknown' },
            redirectURL: '',
            headersSize: -1,
            bodySize: -1
          },
          cache: {},
          timings: { send: 0, wait: e.durationMs ?? 0, receive: 0 },
          _resourceType: e.resourceType,
          _error: e.error
        }))
      }
    }
  }
}

function normalizeHeaders(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {}
  if (raw && typeof raw === 'object') {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      out[k] = Array.isArray(v) ? v.join(', ') : String(v)
    }
  }
  return out
}

function toHarHeaders(h: Record<string, string>): { name: string; value: string }[] {
  return Object.entries(h).map(([name, value]) => ({ name, value }))
}

/** 截断响应体为 Agent 可读文本 */
export function clipBody(
  body: { content: string; base64Encoded: boolean } | null,
  mimeType: string
): string {
  if (!body) return '（响应体不可用：请求可能未完成，或已被浏览器丢弃）'
  if (body.base64Encoded) {
    return `（二进制响应体，${body.content.length} 字节 base64，mimeType: ${mimeType || 'unknown'}；如需内容请用 browser_har 导出后人工分析）`
  }
  const text = body.content
  if (text.length > MAX_BODY_CHARS) {
    return text.slice(0, MAX_BODY_CHARS) + '\n…（响应体过长已截断）'
  }
  return text
}
