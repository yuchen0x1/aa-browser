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
  /** 该跳转响应指向的下一跳 URL（仅重定向条目） */
  redirectUrl?: string
  ts: number
}

const MAX_ENTRIES = 500
export const MAX_RESPONSE_BODY_BYTES = 1024 * 1024
export const MAX_RESPONSE_BODY_CHARS = 50000
const SENSITIVE_HEADER = /^(authorization|proxy-authorization|cookie2?|set-cookie|.*(?:auth|token|secret|api[-_]?key|password|passwd|credential).*)$/i
const SENSITIVE_QUERY = /^(access[-_]?token|refresh[-_]?token|id[-_]?token|token|jwt|bearer|api[-_]?key|key|secret|signature|sig|password|passwd|auth|authorization|session|session[-_]?id|credential|code)$/i
const SENSITIVE_BODY_KEY = /^(?:access[-_]?token|refresh[-_]?token|id[-_]?token|token|jwt|bearer|api[-_]?key|client[-_]?secret|private[-_]?key|secret|signature|sig|password|passwd|auth|authorization|cookie|set[-_]?cookie|session|session[-_]?id|credential|otp|one[-_]?time[-_]?code|security[-_]?code|card[-_]?number|cc[-_]?number|cvv|cvc|expiry|expiration|code)$/i
const BEARER_SECRET = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi
const BODY_KEY_VALUE = /((?:access[-_]?token|refresh[-_]?token|id[-_]?token|token|jwt|bearer|api[-_]?key|client[-_]?secret|private[-_]?key|secret|signature|sig|password|passwd|auth|authorization|cookie|set[-_]?cookie|session|session[-_]?id|credential|otp|one[-_]?time[-_]?code|security[-_]?code|card[-_]?number|cc[-_]?number|cvv|cvc|expiry|expiration|code)\s*[:=]\s*)(["']?)([^"'&\s,}]+)\2/gi

/** 兜底：URL 本身无法解析时，仍按 `?/&/#` 分隔符抹掉明显的凭据参数。 */
function redactRawUrl(raw: string): string {
  return raw.replace(
    /([?&#])((?:access[-_]?token|refresh[-_]?token|id[-_]?token|token|jwt|bearer|api[-_]?key|key|secret|signature|sig|password|passwd|auth|authorization|session|session[-_]?id|credential|code))=([^&#]*)/gi,
    '$1$2=[redacted]'
  )
}

/** Keep captured credentials in memory for debugging, but redact them at MCP output boundaries by default. */
export function safeNetworkUrl(raw: string, includeSensitive = false): string {
  if (includeSensitive) return raw
  try {
    const url = new URL(raw)
    const safeParams = new URLSearchParams()
    url.searchParams.forEach((value, key) => {
      safeParams.append(key, SENSITIVE_QUERY.test(key) ? '[redacted]' : value)
    })
    url.search = safeParams.toString()
    if (url.username) url.username = '[redacted]'
    if (url.password) url.password = '[redacted]'
    // 隐式 OAuth 会把 access_token 放在 fragment 里；旧实现只清洗 search，
    // 导致导出 HAR / 网络列表时 token 原样泄漏。
    const hash = url.hash.slice(1)
    let sensitiveHash = false
    if (hash.includes('=')) {
      try {
        new URLSearchParams(hash).forEach((_value, key) => {
          if (SENSITIVE_QUERY.test(key)) sensitiveHash = true
        })
      } catch {
        /* 非标准 fragment，继续用正则兜底 */
      }
    }
    if (!sensitiveHash && redactRawUrl(`#${hash}`).includes('[redacted]')) sensitiveHash = true
    if (sensitiveHash) url.hash = '#[redacted]'
    return url.toString()
  } catch {
    return redactRawUrl(raw)
  }
}

export function safeNetworkHeaders(headers: Record<string, string>, includeSensitive = false): Record<string, string> {
  if (includeSensitive) return headers
  return Object.fromEntries(Object.entries(headers).map(([name, value]) => [name, SENSITIVE_HEADER.test(name) ? '[redacted]' : value]))
}

/** 一条请求 Mock 规则 */
export interface MockRule {
  id: string
  /** 匹配 URL 子串（大小写不敏感） */
  urlContains: string
  /** 可选：仅匹配指定 HTTP 方法 */
  method?: string
  /** mock 响应状态码（默认 200） */
  status: number
  /** mock 响应头 */
  headers: Record<string, string>
  /** mock 响应体（文本） */
  body: string
  /** 请求拦截后的行为：respond=返回 mock；continue=放行 */
  action: 'respond' | 'continue'
  /** 命中次数 */
  hits: number
}

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
  private generation = 0
  private enabling?: Promise<void>
  private fetchAttached = false
  private fetchEnabling?: Promise<void>
  private mocks: MockRule[] = []
  private mockSeq = 0

  constructor(wc: WebContents) {
    this.wc = wc
  }

  get enabled(): boolean {
    return this.attached
  }

  private assertCurrent(generation: number): void {
    if (generation !== this.generation || this.wc.isDestroyed() || !this.wc.debugger.isAttached()) {
      throw new ActionError('页面已关闭或调试通道已释放，抓包初始化已取消。')
    }
  }

  /** 惰性启用：attach 调试器并开启 Network 域（幂等） */
  async ensure(): Promise<void> {
    if (this.wc.isDestroyed()) throw new ActionError('页面已关闭，无法开启抓包。')
    const dbg = this.wc.debugger
    if (this.attached && dbg.isAttached()) return
    if (this.attached) this.dispose()
    if (this.enabling) return this.enabling
    const generation = this.generation
    const pending = (async () => {
      // 对话框守卫会先一步 attach 同一个 debugger；此时不应再 attach，直接复用。
      const attachedHere = !dbg.isAttached()
      if (attachedHere) {
        try {
          dbg.attach('1.3')
        } catch (err) {
          throw new ActionError(
            `无法开启抓包：调试通道被占用（通常是 DevTools 已打开，请先关闭后重试）。(${(err as Error).message})`
          )
        }
      }
      try {
        await dbg.sendCommand('Network.enable', { maxResourceBufferSize: 5000000 })
      } catch (err) {
        this.assertCurrent(generation)
        if (attachedHere) {
          try { dbg.detach() } catch { /* 调试通道可能已经关闭。 */ }
        }
        throw new ActionError(`无法开启抓包：Network.enable 失败。(${(err as Error).message})`)
      }
      this.assertCurrent(generation)
      this.listener = (_e, method, params) => this.onMessage(method, params)
      dbg.on('message', this.listener)
      this.attached = true
    })()
    this.enabling = pending
    try { await pending }
    finally { if (this.enabling === pending) this.enabling = undefined }
  }

  dispose(): void {
    const wasEnabling = this.attached || this.enabling !== undefined
    // Invalidate pending enables too; this instance may be reused after DevTools closes.
    this.generation++
    this.enabling = undefined
    this.disableMockInterception()
    if (this.listener) {
      try { this.wc.debugger.removeListener('message', this.listener) } catch { /* 页面可能已销毁。 */ }
    }
    this.attached = false
    this.listener = null
    // 只关闭 Network 域，不 detach 对话框守卫共享的调试通道。
    try {
      if (wasEnabling && !this.wc.isDestroyed()) {
        void this.wc.debugger.sendCommand('Network.disable').catch(() => {})
      }
    } catch {
      /* 忽略 */
    }
  }

  /**
   * 彻底释放调试通道（仅在打开 DevTools 前调用）。
   * DevTools 与 debugger 无法同时附着，因此必须先 detach 才能开 DevTools。
   */
  releaseDebugger(): void {
    this.dispose()
    try {
      if (this.wc.debugger.isAttached()) this.wc.debugger.detach()
    } catch {
      /* 忽略 */
    }
  }

  /** 新增/替换一条 mock 规则；urlContains 相同则覆盖。返回规则 id。 */
  setMock(input: { urlContains: string; method?: string; status?: number; headers?: Record<string, string>; body?: string; action?: 'respond' | 'continue' }): string {
    const existing = this.mocks.find((m) => m.urlContains.toLowerCase() === input.urlContains.toLowerCase() && (m.method ?? '').toLowerCase() === (input.method ?? '').toLowerCase())
    if (existing) {
      existing.status = input.status ?? 200
      existing.headers = input.headers ?? {}
      existing.body = input.body ?? ''
      existing.action = input.action ?? 'respond'
      existing.hits = 0
      return existing.id
    }
    const rule: MockRule = {
      id: `mock${Date.now().toString(36)}${this.mockSeq++}`,
      urlContains: input.urlContains,
      method: input.method,
      status: input.status ?? 200,
      headers: input.headers ?? {},
      body: input.body ?? '',
      action: input.action ?? 'respond',
      hits: 0
    }
    this.mocks.push(rule)
    return rule.id
  }

  /** 删除规则；返回是否删除成功 */
  removeMock(id: string): boolean {
    const before = this.mocks.length
    this.mocks = this.mocks.filter((m) => m.id !== id)
    return this.mocks.length < before
  }

  clearMocks(): number {
    const n = this.mocks.length
    this.mocks = []
    return n
  }

  listMocks(): MockRule[] {
    return this.mocks.map((m) => ({ ...m }))
  }

  get mockEnabled(): boolean {
    return this.mocks.length > 0
  }

  /**
   * 开启请求拦截（CDP Fetch 域）。一旦启用：
   *  - 已配置的规则命中 → 直接返回 mock 响应；
   *  - 未命中的请求 → 放行（Fetch.continueRequest）。
   * 仅在存在规则时生效；规则清空后自动放行。
   */
  async ensureMockInterception(): Promise<void> {
    if (!this.mocks.length) {
      if (this.fetchAttached || this.fetchEnabling) this.disableMockInterception()
      return
    }
    const generation = this.generation
    await this.ensure()
    this.assertCurrent(generation)
    if (!this.mocks.length) return
    if (this.fetchAttached) return
    if (this.fetchEnabling) return this.fetchEnabling
    const dbg = this.wc.debugger
    const pending: Promise<void> = Promise.resolve().then(async () => {
      try {
        this.assertCurrent(generation)
        if (this.fetchEnabling !== pending) throw new ActionError('请求拦截初始化已取消。')
        await dbg.sendCommand('Fetch.enable', {
          patterns: [{ urlPattern: '*', requestStage: 'Request' }],
          handleAuthRequests: false
        })
        this.assertCurrent(generation)
        if (this.fetchEnabling !== pending) throw new ActionError('请求拦截初始化已取消。')
        if (!this.mocks.length) { this.disableMockInterception(); return }
        dbg.on('message', this.onFetchMessage)
        this.fetchAttached = true
      } catch (err) {
        throw new ActionError(`无法开启请求拦截：${(err as Error).message}（需先关闭 DevTools）`)
      }
    })
    this.fetchEnabling = pending
    try { await pending }
    finally { if (this.fetchEnabling === pending) this.fetchEnabling = undefined }
  }

  private disableMockInterception(): void {
    const wasEnabling = this.fetchAttached || this.fetchEnabling !== undefined
    this.fetchAttached = false
    this.fetchEnabling = undefined
    try {
      const dbg = this.wc.debugger
      dbg.removeListener('message', this.onFetchMessage)
      if (wasEnabling && !this.wc.isDestroyed()) void dbg.sendCommand('Fetch.disable').catch(() => {})
    } catch {
      /* 忽略 */
    }
  }

  private onFetchMessage = (_e: unknown, method: string, params: Record<string, unknown>): void => {
    if (method !== 'Fetch.requestPaused') return
    const requestId = String(params['requestId'] ?? '')
    const req = params['request'] as Record<string, unknown> | undefined
    const url = String(req?.['url'] ?? '')
    const reqMethod = String(req?.['method'] ?? 'GET')
    const requestHeaders = normalizeHeaders(req?.['headers'])
    const header = (name: string): string =>
      Object.entries(requestHeaders).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1] ?? ''
    const isPreflight = reqMethod.toUpperCase() === 'OPTIONS' && Boolean(header('Access-Control-Request-Method'))
    // 预检不带规则里的方法；按 URL 找到规则后合成 204，否则跨域 mock 会在预检阶段失败。
    const rule = this.matchMock(url, reqMethod) ?? (isPreflight ? this.matchMock(url, reqMethod, true) : null)
    if (!rule || rule.action === 'continue') {
      this.continueRequest(requestId)
      return
    }
    const origin = header('Origin')
    const merged = new Map<string, string>()
    for (const [name, value] of Object.entries(rule.headers)) merged.set(name.toLowerCase(), String(value))
    if (!merged.has('content-type')) merged.set('content-type', 'text/plain; charset=utf-8')
    if (origin && !merged.has('access-control-allow-origin')) merged.set('access-control-allow-origin', origin)
    if (origin && !merged.has('access-control-allow-credentials')) merged.set('access-control-allow-credentials', 'true')
    if (origin && !merged.has('vary')) merged.set('vary', 'Origin')
    if (isPreflight) {
      if (!merged.has('access-control-allow-methods')) {
        merged.set('access-control-allow-methods', header('Access-Control-Request-Method') || '*')
      }
      if (!merged.has('access-control-allow-headers')) {
        merged.set('access-control-allow-headers', header('Access-Control-Request-Headers') || '*')
      }
      merged.set('access-control-max-age', merged.get('access-control-max-age') ?? '600')
      this.respondRequest(requestId, {
        responseCode: 204,
        responseHeaders: [...merged].map(([name, value]) => ({ name, value })),
        body: ''
      })
      return
    }
    rule.hits++
    this.respondRequest(requestId, {
      responseCode: rule.status,
      responseHeaders: [...merged].map(([name, value]) => ({ name, value })),
      body: Buffer.from(rule.body, 'utf-8').toString('base64')
    })
  }

  private matchMock(url: string, method: string, ignoreMethod = false): MockRule | null {
    const u = url.toLowerCase()
    for (const m of [...this.mocks].reverse()) {
      if (!ignoreMethod && m.method && m.method.toUpperCase() !== method.toUpperCase()) continue
      if (u.includes(m.urlContains.toLowerCase())) return m
    }
    return null
  }

  private continueRequest(requestId: string): void {
    void this.wc.debugger.sendCommand('Fetch.continueRequest', { requestId }).catch(() => {})
  }

  private respondRequest(requestId: string, response: { responseCode: number; responseHeaders: { name: string; value: string }[]; body: string }): void {
    void this.wc.debugger.sendCommand('Fetch.fulfillRequest', { requestId, ...response }).catch(() => {})
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
        const id = String(params['requestId'] ?? '')
        const nextUrl = String(req['url'] ?? '')
        // 重定向不会给上一跳发 responseReceived；若不在这里收尾，
        // 列表会留下永远 status=0/duration=null 的幽灵条目，HAR 也丢失跳转链。
        const redirect = params['redirectResponse'] as Record<string, unknown> | undefined
        if (redirect) {
          const prev = this.byId.get(id)
          if (prev) {
            prev.status = Number(redirect['status'] ?? prev.status)
            prev.statusText = String(redirect['statusText'] ?? '')
            prev.mimeType = String(redirect['mimeType'] ?? prev.mimeType)
            prev.responseHeaders = normalizeHeaders(redirect['headers'])
            prev.redirectUrl = nextUrl
            const len = Number(redirect['encodedDataLength'] ?? 0)
            if (len > 0) prev.size = len
            if (prev.durationMs === null) prev.durationMs = Math.max(0, Date.now() - prev.ts)
          }
        }
        this.push({
          requestId: id,
          url: nextUrl,
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

  /** 拉取响应体（仅响应完成后可用），并在主进程边界限制返回体大小。 */
  async getResponseBody(requestId: string): Promise<NetworkResponseBody | null> {
    if (!this.attached) return null
    try {
      const result = (await this.wc.debugger.sendCommand('Network.getResponseBody', { requestId })) as {
        body?: string
        base64Encoded?: boolean
      } | null
      if (!result || typeof result['body'] !== 'string') return null
      const content = result['body']
      if (result['base64Encoded']) {
        const estimatedBytes = Math.floor(Buffer.byteLength(content, 'utf8') * 3 / 4)
        const maxBase64Chars = Math.floor(MAX_RESPONSE_BODY_BYTES / 3) * 4
        if (content.length > maxBase64Chars) {
          return {
            content: content.slice(0, maxBase64Chars),
            base64Encoded: true,
            truncated: true,
            sizeBytes: estimatedBytes
          }
        }
        return { content, base64Encoded: true, truncated: false, sizeBytes: estimatedBytes }
      }
      const sizeBytes = Buffer.byteLength(content, 'utf8')
      if (sizeBytes > MAX_RESPONSE_BODY_BYTES) {
        return {
          content: truncateUtf8(content, MAX_RESPONSE_BODY_BYTES),
          base64Encoded: false,
          truncated: true,
          sizeBytes
        }
      }
      return { content, base64Encoded: false, truncated: false, sizeBytes }
    } catch {
      return null
    }
  }

  /** 导出 HAR 1.2（不含响应体） */
  toHar(version: string, includeSensitive = false): Record<string, unknown> {
    return {
      log: {
        version: '1.2',
        creator: { name: 'Aa Browser', version },
        entries: this.entries.map((e) => ({
          startedDateTime: new Date(e.ts).toISOString(),
          time: e.durationMs ?? 0,
          request: {
            method: e.method,
            url: safeNetworkUrl(e.url, includeSensitive),
            httpVersion: 'HTTP/1.1',
            headers: toHarHeaders(safeNetworkHeaders(e.requestHeaders, includeSensitive)),
            queryString: toHarQuery(safeNetworkUrl(e.url, includeSensitive)),
            headersSize: -1,
            bodySize: -1
          },
          response: {
            status: e.status,
            statusText: e.statusText,
            httpVersion: 'HTTP/1.1',
            headers: toHarHeaders(safeNetworkHeaders(e.responseHeaders, includeSensitive)),
            content: { size: e.size, mimeType: e.mimeType || 'unknown' },
            redirectURL: e.redirectUrl ? safeNetworkUrl(e.redirectUrl, includeSensitive) : '',
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

/**
 * HAR 的 queryString 必须是真实参数列表。此前恒为空数组，
 * 导致导出的 HAR 在 DevTools/Fiddler 里看不到任何查询参数。
 * 传入的 url 已按 includeSensitive 处理过，因此脱敏结果会一并带出。
 */
function toHarQuery(url: string): { name: string; value: string }[] {
  try {
    const out: { name: string; value: string }[] = []
    new URL(url).searchParams.forEach((value, name) => {
      out.push({ name, value })
    })
    return out
  } catch {
    return []
  }
}

interface NetworkResponseBody {
  content: string
  base64Encoded: boolean
  truncated?: boolean
  sizeBytes?: number
}

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  let low = 0
  let high = Math.min(value.length, maxBytes)
  let best = 0
  while (low <= high) {
    const middle = Math.floor((low + high) / 2)
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) {
      best = middle
      low = middle + 1
    } else {
      high = middle - 1
    }
  }
  return value.slice(0, best)
}

interface RedactedJson {
  value: unknown
  changed: boolean
}

function redactJson(value: unknown, depth = 0): RedactedJson {
  if (depth > 32) return { value: '[redacted: nesting limit]', changed: true }
  if (Array.isArray(value)) {
    let changed = false
    const next = value.map((item) => {
      const redacted = redactJson(item, depth + 1)
      changed ||= redacted.changed
      return redacted.value
    })
    return { value: next, changed }
  }
  if (!value || typeof value !== 'object') {
    if (typeof value === 'string') {
      const redacted = redactPlainSecrets(value)
      return { value: redacted, changed: redacted !== value }
    }
    return { value, changed: false }
  }
  let changed = false
  const next: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE_BODY_KEY.test(key)) {
      next[key] = '[redacted]'
      changed = true
      continue
    }
    const redacted = redactJson(item, depth + 1)
    next[key] = redacted.value
    changed ||= redacted.changed
  }
  return { value: next, changed }
}

function redactPlainSecrets(value: string): string {
  return value
    .replace(BEARER_SECRET, '$1 [redacted]')
    .replace(BODY_KEY_VALUE, (_match, prefix: string, quote: string) => `${prefix}${quote}[redacted]${quote}`)
}

interface RedactedBodyText {
  text: string
  changed: boolean
}

function redactBodyText(value: string, mimeType: string): RedactedBodyText {
  const mime = mimeType.toLowerCase()
  if (mime.includes('json')) {
    try {
      const parsed = redactJson(JSON.parse(value))
      if (parsed.changed) return { text: JSON.stringify(parsed.value, null, 2), changed: true }
      return { text: value, changed: false }
    } catch {
      /* malformed JSON still goes through conservative text redaction below */
    }
  }
  const redacted = redactPlainSecrets(value)
  return { text: redacted, changed: redacted !== value }
}

/** 对网络响应体做默认内容级脱敏；显式 includeSensitive 时由调用方跳过。 */
export function redactNetworkBody(value: string, mimeType = ''): string {
  return redactBodyText(value, mimeType).text
}

/** 截断、脱敏响应体为 Agent 可读文本 */
export function clipBody(
  body: NetworkResponseBody | null,
  mimeType: string,
  includeSensitive = false
): string {
  if (!body) return '（响应体不可用：请求可能未完成，或已被浏览器丢弃）'
  if (body.base64Encoded) {
    const size = body.sizeBytes ? `约 ${body.sizeBytes} 字节` : `${body.content.length} 字节 base64`
    const truncated = body.truncated ? `，原始响应超过 ${Math.round(MAX_RESPONSE_BODY_BYTES / 1024)}KB` : ''
    return `（二进制响应体，${size}${truncated}，mimeType: ${mimeType || 'unknown'}；内容未直接返回）`
  }
  const redacted = includeSensitive ? { text: body.content, changed: false } : redactBodyText(body.content, mimeType)
  const text = redacted.text
  const clipped = text.length > MAX_RESPONSE_BODY_CHARS
    ? text.slice(0, MAX_RESPONSE_BODY_CHARS) + '\n…（响应体过长已截断）'
    : text
  const notices = []
  if (redacted.changed) notices.push('响应体中的敏感字段已脱敏')
  if (body.truncated) notices.push(`响应体超过 ${Math.round(MAX_RESPONSE_BODY_BYTES / 1024)}KB，仅返回前 ${Math.round(MAX_RESPONSE_BODY_BYTES / 1024)}KB`)
  if (notices.length) {
    return `${clipped}\n…（${notices.join('；')}）`
  }
  return clipped
}
