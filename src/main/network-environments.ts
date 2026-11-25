import fs from 'node:fs'
import dns from 'node:dns/promises'
import net from 'node:net'
import { performance } from 'node:perf_hooks'
import { writeJsonAtomic } from './atomic-json'

export type NetworkMode = 'system' | 'direct' | 'proxy'
export type ProxyProtocol = 'http' | 'https' | 'socks5'

export interface ProxyEndpoint {
  protocol: ProxyProtocol
  host: string
  port: number
}

export interface WebsiteProxyRule extends ProxyEndpoint {
  /** Exact hostname or *.example.test; URL/path matching is deliberately unsupported. */
  site: string
}

export interface NetworkEnvironment {
  profileId: string
  enabled: boolean
  mode: NetworkMode
  protocol?: ProxyProtocol
  host?: string
  port?: number
  bypass: string[]
  rules: WebsiteProxyRule[]
  hasCredentials: boolean
  appliedAt?: number
  error?: string
}

export interface NetworkEnvironmentInput {
  enabled?: boolean
  mode?: NetworkMode
  protocol?: ProxyProtocol
  host?: string
  port?: number
  bypass?: string[]
  rules?: WebsiteProxyRule[]
  username?: string
  /** null removes the saved credential; omitted preserves it for the same endpoint. */
  password?: string | null
}

interface StoredEnvironment extends Omit<NetworkEnvironment, 'hasCredentials' | 'appliedAt' | 'error'> {
  credential?: string
}

interface SessionProxyApi {
  setProxy(config: { mode: 'system' | 'direct' | 'fixed_servers' | 'pac_script'; proxyRules?: string; proxyBypassRules?: string; pacScript?: string }): Promise<void>
  closeAllConnections(): Promise<void>
  resolveProxy(url: string): Promise<string>
  fetch(input: string, init?: RequestInit): Promise<Response>
  clearAuthCache?(): Promise<void>
  clearHostResolverCache?(): Promise<void>
}

export interface NetworkEnvironmentDependencies {
  filePath: string
  sessionFor: (profileId: string) => SessionProxyApi
  /** Use Electron safeStorage. No credential is accepted without a secure provider. */
  protect?: (plaintext: string) => string | Promise<string>
  unprotect?: (ciphertext: string) => string | Promise<string>
  lookup?: typeof dns.lookup
  now?: () => number
}

const PROFILE_ID = /^(default|p[a-f0-9]{8,64})$/
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i
const MAX_ENVIRONMENTS = 100
const MAX_RULES = 50
const MAX_FILE_BYTES = 512 * 1024

function assertProfileId(value: string): void {
  if (!PROFILE_ID.test(value)) throw new Error('[INVALID_PROFILE] Invalid Profile identifier.')
}

function normalizeHost(value: unknown): string {
  if (typeof value !== 'string') throw new Error('[INVALID_PROXY] Proxy host is required.')
  const raw = value.trim().toLowerCase()
  const host = raw.startsWith('[') && raw.endsWith(']') ? raw.slice(1, -1) : raw
  if (!net.isIP(host) && !HOSTNAME.test(host)) throw new Error('[INVALID_PROXY] Use a hostname or IP address without credentials, scheme or path.')
  return host
}

function endpoint(value: { protocol?: unknown; host?: unknown; port?: unknown }): ProxyEndpoint {
  if (value.protocol !== 'http' && value.protocol !== 'https' && value.protocol !== 'socks5') throw new Error('[INVALID_PROXY] Proxy protocol must be http, https or socks5.')
  if (!Number.isInteger(value.port) || Number(value.port) < 1 || Number(value.port) > 65535) throw new Error('[INVALID_PROXY] Proxy port must be an integer between 1 and 65535.')
  return { protocol: value.protocol, host: normalizeHost(value.host), port: Number(value.port) }
}

function normalizeSite(value: unknown): string {
  if (typeof value !== 'string') throw new Error('[INVALID_PROXY_RULE] Website rule requires a hostname.')
  const site = value.trim().toLowerCase()
  if (site.startsWith('*.')) return `*.${normalizeHost(site.slice(2))}`
  return normalizeHost(site)
}

function proxyAddress(value: ProxyEndpoint): string {
  const host = net.isIP(value.host) === 6 ? `[${value.host}]` : value.host
  return `${value.protocol}://${host}:${value.port}`
}

function pacProxy(value: ProxyEndpoint): string {
  const host = net.isIP(value.host) === 6 ? `[${value.host}]` : value.host
  return `${value.protocol === 'socks5' ? 'SOCKS5' : value.protocol === 'https' ? 'HTTPS' : 'PROXY'} ${host}:${value.port}`
}

/** Only validated host literals enter generated PAC; there is no caller-supplied JavaScript. */
export function buildProfilePac(environment: Pick<StoredEnvironment, 'protocol' | 'host' | 'port' | 'rules' | 'bypass'>): string {
  const root = endpoint(environment)
  const lines = ['function FindProxyForURL(url, host) {', 'host = host.toLowerCase();']
  for (const site of environment.bypass) {
    if (site === '<local>') lines.push('if (isPlainHostName(host)) return "DIRECT";')
    else if (site.startsWith('*.')) lines.push(`if (dnsDomainIs(host, ${JSON.stringify(site.slice(1))})) return "DIRECT";`)
    else lines.push(`if (host === ${JSON.stringify(site)}) return "DIRECT";`)
  }
  for (const rule of environment.rules) {
    const site = normalizeSite(rule.site)
    const target = pacProxy(endpoint(rule))
    lines.push(site.startsWith('*.')
      ? `if (dnsDomainIs(host, ${JSON.stringify(site.slice(1))})) return ${JSON.stringify(target)};`
      : `if (host === ${JSON.stringify(site)}) return ${JSON.stringify(target)};`)
  }
  lines.push(`return ${JSON.stringify(pacProxy(root))};`, '}')
  return lines.join('\n')
}

function normalizeEnvironment(profileId: string, value: NetworkEnvironmentInput, previous?: StoredEnvironment): StoredEnvironment {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('[INVALID_PROXY] Network configuration must be an object.')
  const mode = value.mode ?? previous?.mode ?? 'system'
  if (mode !== 'system' && mode !== 'direct' && mode !== 'proxy') throw new Error('[INVALID_PROXY] Unknown network mode.')
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') throw new Error('[INVALID_PROXY] enabled must be boolean.')
  const result: StoredEnvironment = {
    profileId,
    enabled: value.enabled ?? previous?.enabled ?? true,
    mode,
    bypass: previous?.bypass ? [...previous.bypass] : [],
    rules: previous?.rules ? previous.rules.map((rule) => ({ ...rule })) : []
  }
  if (mode === 'proxy') Object.assign(result, endpoint({
    protocol: value.protocol ?? previous?.protocol,
    host: value.host ?? previous?.host,
    port: value.port ?? previous?.port
  }))
  if (value.bypass !== undefined) {
    if (!Array.isArray(value.bypass) || value.bypass.length > MAX_RULES) throw new Error('[INVALID_PROXY] Too many proxy bypass rules.')
    result.bypass = [...new Set(value.bypass.map((site) => site === '<local>' ? site : normalizeSite(site)))]
  }
  if (value.rules !== undefined) {
    if (!Array.isArray(value.rules) || value.rules.length > MAX_RULES) throw new Error('[INVALID_PROXY] Too many website proxy rules.')
    result.rules = value.rules.map((rule) => ({ site: normalizeSite(rule?.site), ...endpoint(rule ?? {}) }))
  }
  if (result.rules.length && mode !== 'proxy') throw new Error('[INVALID_PROXY] Website rules require proxy mode.')
  return result
}

export class NetworkEnvironmentManager {
  private environments = new Map<string, StoredEnvironment>()
  private runtime = new Map<string, { appliedAt?: number; error?: string }>()
  private applied = new Map<string, StoredEnvironment>()
  private queues = new Map<string, Promise<unknown>>()
  private loaded = false
  private writeBlocked = false

  constructor(private readonly deps: NetworkEnvironmentDependencies) {}

  private load(): void {
    if (this.loaded) {
      if (this.writeBlocked) throw new Error('[NETWORK_STORE_INVALID] Network configuration is read-only until its original file is repaired.')
      return
    }
    this.loaded = true
    try {
      const stat = fs.lstatSync(this.deps.filePath)
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_FILE_BYTES) throw new Error('Invalid network configuration file.')
      const parsed = JSON.parse(fs.readFileSync(this.deps.filePath, 'utf8')) as { version?: unknown; environments?: unknown }
      if (parsed.version !== 1 || !Array.isArray(parsed.environments) || parsed.environments.length > MAX_ENVIRONMENTS) throw new Error('Unsupported network configuration version.')
      for (const raw of parsed.environments) {
        if (!raw || typeof raw !== 'object' || typeof raw.profileId !== 'string') throw new Error('Invalid network configuration record.')
        assertProfileId(raw.profileId)
        const clean = normalizeEnvironment(raw.profileId, raw)
        if (raw.credential !== undefined) {
          if (typeof raw.credential !== 'string' || raw.credential.length > 32768) throw new Error('Invalid protected credential.')
          clean.credential = raw.credential
        }
        this.environments.set(clean.profileId, clean)
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      this.environments.clear()
      // Corrupt/unknown files remain intact. Do not silently replace settings with defaults.
      this.writeBlocked = true
      throw new Error('[NETWORK_STORE_INVALID] Network settings could not be loaded. Preserve the file and restore a valid backup.')
    }
  }

  private store(next: Map<string, StoredEnvironment>): void {
    if (this.writeBlocked) throw new Error('[NETWORK_STORE_INVALID] Network configuration is read-only until its original file is repaired.')
    writeJsonAtomic(this.deps.filePath, { version: 1, environments: [...next.values()] })
    this.environments = next
  }

  get(profileId: string): NetworkEnvironment {
    assertProfileId(profileId)
    this.load()
    const value = this.environments.get(profileId) ?? { profileId, enabled: true, mode: 'system' as const, bypass: [], rules: [] }
    const { credential, ...publicValue } = value as StoredEnvironment
    return { ...publicValue, bypass: [...value.bypass], rules: value.rules.map((rule) => ({ ...rule })), hasCredentials: !!credential, ...this.runtime.get(profileId) }
  }

  list(): NetworkEnvironment[] {
    this.load()
    return [...this.environments.keys()].map((id) => this.get(id))
  }

  private async serialized<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(profileId) ?? Promise.resolve()
    const next = previous.catch(() => {}).then(operation)
    this.queues.set(profileId, next)
    try { return await next } finally { if (this.queues.get(profileId) === next) this.queues.delete(profileId) }
  }

  async set(profileId: string, input: NetworkEnvironmentInput): Promise<NetworkEnvironment> {
    assertProfileId(profileId)
    this.load()
    return this.serialized(profileId, async () => {
      const previous = this.environments.get(profileId)
      const next = normalizeEnvironment(profileId, input, previous)
      const sameEndpoint = previous?.host === next.host && previous?.port === next.port && previous?.protocol === next.protocol
      if (sameEndpoint && input.password === undefined && input.username === undefined) next.credential = previous?.credential
      if (input.password !== undefined && input.password !== null) {
        if (typeof input.password !== 'string' || input.password.length > 4096 || typeof input.username !== 'string' || input.username.length > 1024) throw new Error('[INVALID_PROXY] Invalid proxy credentials.')
        if (next.mode !== 'proxy' || next.protocol === 'socks5') throw new Error('[PROXY_AUTH_UNSUPPORTED] Chromium does not support username/password authentication for SOCKS5 proxies.')
        if (!this.deps.protect || !this.deps.unprotect) throw new Error('[SECURE_STORAGE_UNAVAILABLE] Proxy passwords require operating-system protected storage.')
        next.credential = await this.deps.protect(JSON.stringify({ username: input.username, password: input.password }))
      } else if (input.username !== undefined && input.password === undefined) {
        throw new Error('[INVALID_PROXY] Supply username and password together, or omit both to preserve the credential.')
      }
      if (next.rules.length && next.credential) throw new Error('[PROXY_AUTH_UNSUPPORTED] Authenticated per-website proxy rules are unsupported; use one authenticated endpoint per Profile.')
      const nextMap = new Map(this.environments)
      if (!nextMap.has(profileId) && nextMap.size >= MAX_ENVIRONMENTS) throw new Error('[NETWORK_LIMIT] Too many network environments.')
      nextMap.set(profileId, next)
      const ses = this.deps.sessionFor(profileId)
      try {
        await this.configure(ses, next)
        this.store(nextMap)
      } catch (error) {
        try { await this.configure(ses, previous ?? { profileId, enabled: true, mode: 'system', bypass: [], rules: [] }) } catch {
          this.applied.delete(profileId)
          throw new Error('[PROXY_ROLLBACK_FAILED] Chromium could not restore the previous network environment; close the Profile before continuing.')
        }
        throw error
      }
      this.applied.set(profileId, next)
      this.runtime.set(profileId, { appliedAt: this.deps.now?.() ?? Date.now() })
      return this.get(profileId)
    })
  }

  private async configure(ses: SessionProxyApi, value: StoredEnvironment): Promise<void> {
    try {
      if (!value.enabled || value.mode === 'direct') await ses.setProxy({ mode: 'direct' })
      else if (value.mode === 'system') await ses.setProxy({ mode: 'system' })
      else if (value.rules.length) await ses.setProxy({ mode: 'pac_script', pacScript: `data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(buildProfilePac(value)).toString('base64')}` })
      else await ses.setProxy({ mode: 'fixed_servers', proxyRules: proxyAddress(endpoint(value)), proxyBypassRules: value.bypass.join(';') })
      // Electron documents that old connections may keep using the previous proxy.
      await ses.closeAllConnections()
      await ses.clearAuthCache?.()
    } catch {
      this.runtime.set(value.profileId, { error: '[PROXY_APPLY_FAILED] Chromium could not apply the network environment.' })
      throw new Error('[PROXY_APPLY_FAILED] Chromium could not apply the network environment.')
    }
  }

  /** Must be awaited before a Profile's first navigation. */
  async apply(profileId: string): Promise<NetworkEnvironment> {
    assertProfileId(profileId)
    this.load()
    return this.serialized(profileId, async () => {
      const value = this.environments.get(profileId) ?? { profileId, enabled: true, mode: 'system' as const, bypass: [], rules: [] }
      await this.configure(this.deps.sessionFor(profileId), value)
      this.applied.set(profileId, value)
      this.runtime.set(profileId, { appliedAt: this.deps.now?.() ?? Date.now() })
      return this.get(profileId)
    })
  }

  async resolve(profileId: string, rawUrl: string): Promise<{ url: string; proxy: string }> {
    assertProfileId(profileId)
    const url = diagnosticUrl(rawUrl)
    if (!this.applied.has(profileId)) await this.apply(profileId)
    const proxy = await withTimeout(this.deps.sessionFor(profileId).resolveProxy(url.toString()), 10_000)
    return { url: safeUrl(url), proxy: proxy.replace(/[^\s;]+:[^\s;]+@/g, '[redacted]@').slice(0, 4096) }
  }

  /** Only answer proxy challenges for the exact configured Profile and endpoint. */
  async credentialsFor(profileId: string, host: string, port: number, isProxy = true): Promise<{ username: string; password: string } | null> {
    if (!isProxy) return null
    assertProfileId(profileId)
    this.load()
    const value = this.applied.get(profileId)
    if (!value?.enabled || value.mode !== 'proxy' || !value.credential || value.host !== normalizeHost(host) || value.port !== port || !this.deps.unprotect) return null
    try {
      const decoded = JSON.parse(await this.deps.unprotect(value.credential)) as { username?: unknown; password?: unknown }
      if (typeof decoded.username !== 'string' || typeof decoded.password !== 'string') return null
      return { username: decoded.username, password: decoded.password }
    } catch { return null }
  }

  async test(profileId: string, rawUrl = 'https://api.ipify.org?format=json', signal?: AbortSignal): Promise<{
    ok: boolean; url: string; status?: number; durationMs: number; proxy?: string; exitIp?: string; error?: string
  }> {
    assertProfileId(profileId)
    const url = diagnosticUrl(rawUrl)
    if (!this.applied.has(profileId)) await this.apply(profileId)
    const controller = new AbortController()
    const abort = (): void => controller.abort()
    if (signal?.aborted) controller.abort()
    signal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(abort, 10_000)
    const start = performance.now()
    try {
      const ses = this.deps.sessionFor(profileId)
      const resolution = await this.resolve(profileId, url.toString())
      const response = await ses.fetch(url.toString(), { signal: controller.signal, credentials: 'omit', cache: 'no-store', redirect: 'error' })
      let exitIp: string | undefined
      if (url.hostname === 'api.ipify.org') {
        const body = await boundedBody(response, 4096)
        const parsed = JSON.parse(body) as { ip?: unknown }
        if (typeof parsed.ip === 'string' && net.isIP(parsed.ip)) exitIp = parsed.ip
      } else {
        await response.body?.cancel()
      }
      return { ok: response.ok, status: response.status, url: safeUrl(url), durationMs: Math.round(performance.now() - start), proxy: resolution.proxy, ...(exitIp ? { exitIp } : {}) }
    } catch {
      return { ok: false, url: safeUrl(url), durationMs: Math.round(performance.now() - start), error: controller.signal.aborted ? '[NETWORK_TIMEOUT_OR_CANCELLED]' : '[NETWORK_REQUEST_FAILED] Check proxy connectivity, DNS, TLS and target reachability.' }
    } finally {
      clearTimeout(timer)
      signal?.removeEventListener('abort', abort)
    }
  }

  async diagnose(profileId: string, rawUrl: string, signal?: AbortSignal): Promise<{
    profileId: string; dns: { resolver: 'operating-system'; host: string; addresses: string[]; error?: string }; request: Awaited<ReturnType<NetworkEnvironmentManager['test']>>
  }> {
    const url = diagnosticUrl(rawUrl)
    const lookup = this.deps.lookup ?? dns.lookup
    let addresses: string[] = []
    let error: string | undefined
    try {
      const result = await withTimeout(lookup(url.hostname, { all: true }), 5_000)
      addresses = result.map((item) => item.address).slice(0, 16)
    } catch { error = '[OS_DNS_LOOKUP_FAILED] This result does not represent remote proxy DNS.' }
    return { profileId, dns: { resolver: 'operating-system', host: url.hostname, addresses, ...(error ? { error } : {}) }, request: await this.test(profileId, url.toString(), signal) }
  }

  async reconnect(profileId: string): Promise<NetworkEnvironment> {
    await this.deps.sessionFor(profileId).clearHostResolverCache?.()
    return this.apply(profileId)
  }
}

function diagnosticUrl(rawUrl: string): URL {
  let url: URL
  try { url = new URL(rawUrl) } catch { throw new Error('[INVALID_URL] Use an absolute HTTP or HTTPS URL.') }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('[INVALID_URL] Use HTTP(S) without embedded credentials.')
  url.hash = ''
  return url
}

function safeUrl(url: URL): string {
  const value = new URL(url.toString())
  value.search = ''
  value.hash = ''
  return value.toString()
}

async function boundedBody(response: Response, limit: number): Promise<string> {
  const reader = response.body?.getReader()
  if (!reader) return ''
  let size = 0
  const buffers: Uint8Array[] = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > limit) throw new Error('[RESPONSE_TOO_LARGE]')
      buffers.push(value)
    }
    return Buffer.concat(buffers).toString('utf8')
  } finally { await reader.cancel().catch(() => {}) }
}

async function withTimeout<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), milliseconds) })])
  } finally { if (timer) clearTimeout(timer) }
}
