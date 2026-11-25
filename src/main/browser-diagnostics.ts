import type { App, Session } from 'electron'
import type { Tab } from './tabs'
import { doReload, throwIfAborted, withTabLock } from './actions'

export interface BrowserDiagnosticDependencies {
  app: Pick<App, 'getAppMetrics' | 'getVersion'>
  tabs: () => Tab[]
  profiles: () => Array<{ id: string; name: string; running: boolean; isDefault?: boolean; leased?: boolean }>
  agent?: () => { connected: boolean; clientCount: number; activeCalls: number; paused: boolean }
  workflows?: () => Array<{ id: string; status?: string; state?: string; profileId?: string }>
  downloads?: () => Array<{ state: string; profileId?: string }>
  extensions?: (profileId: string) => Array<{ id: string; name: string; version: string; enabled?: boolean; error?: string }>
  redact?: (text: string) => string
}

export interface BrowserDiagnosticReport {
  capturedAt: number
  version: string
  pid: number
  platform: string
  uptimeSeconds: number
  mcp: { connected: boolean; clientCount: number; activeCalls: number; paused: boolean } | null
  resources: { processCount: number; memoryWorkingSetKiB: number; cpuPercent: number; processes: Array<{ pid: number; type: string; cpuPercent: number; memoryWorkingSetKiB: number }> }
  profiles: Array<{ id: string; name: string; running: boolean; isDefault?: boolean; leased?: boolean; tabs: number; extensions: Array<{ id: string; name: string; version: string; enabled?: boolean; error?: string }> }>
  tabs: Array<{
    id: string; profileId: string; url: string; title: string; loading: boolean; rendererPid: number | null;
    destroyed: boolean; recovery: Tab['recovery']; networkCaptureEnabled: boolean;
    requestCount: number; failures: Array<{ url: string; status: number; error: string | null }>;
    consoleErrors: Array<{ at: number; message: string }>
  }>
  workflows: Array<{ id: string; status: string; profileId?: string }>
  downloads: { total: number; active: number; failed: number }
}

function safeUrl(raw: string): string {
  try {
    const value = new URL(raw)
    value.username = ''
    value.password = ''
    value.search = ''
    value.hash = ''
    return value.toString()
  } catch { return '[unavailable]' }
}

function redactMessage(value: string): string {
  return value
    .replace(/\b(Bearer|Basic)\s+[^\s,;]+/gi, '$1 [redacted]')
    .replace(/((?:password|passwd|token|secret|api[_-]?key|authorization|cookie)\s*[=:]\s*)(["']?)[^\s,"';}\]]+/gi, '$1[redacted]')
    .replace(/https?:\/\/[^\s"'<>]+/gi, (url) => safeUrl(url))
    .slice(0, 400)
}

/** A bounded snapshot of live runtime data, with no page body, Cookie or Storage reads. */
export function collectBrowserDiagnostics(deps: BrowserDiagnosticDependencies, profileId?: string): BrowserDiagnosticReport {
  const tabs = deps.tabs().filter((tab) => !profileId || tab.profileId === profileId).slice(0, 100)
  const redact = deps.redact ?? redactMessage
  const metrics = deps.app.getAppMetrics().slice(0, 100).map((metric) => ({
    pid: metric.pid,
    type: metric.type,
    cpuPercent: Math.max(0, Number(metric.cpu?.percentCPUUsage ?? 0)),
    memoryWorkingSetKiB: Math.max(0, Number(metric.memory?.workingSetSize ?? 0))
  }))
  const downloads = (deps.downloads?.() ?? []).filter((download) => !profileId || download.profileId === profileId)
  return {
    capturedAt: Date.now(), version: deps.app.getVersion(), pid: process.pid, platform: process.platform,
    uptimeSeconds: Math.round(process.uptime()), mcp: deps.agent?.() ?? null,
    resources: { processCount: metrics.length, memoryWorkingSetKiB: metrics.reduce((sum, metric) => sum + metric.memoryWorkingSetKiB, 0), cpuPercent: metrics.reduce((sum, metric) => sum + metric.cpuPercent, 0), processes: metrics },
    profiles: deps.profiles().filter((profile) => !profileId || profile.id === profileId).map((profile) => ({
      ...profile, tabs: tabs.filter((tab) => tab.profileId === profile.id).length,
      extensions: (deps.extensions?.(profile.id) ?? []).slice(0, 20).map((extension) => ({ ...extension, ...(extension.error ? { error: redact(extension.error) } : {}) }))
    })),
    tabs: tabs.map((tab) => {
      const wc = tab.view.webContents
      const destroyed = wc.isDestroyed()
      let rendererPid: number | null = null
      if (!destroyed) { try { rendererPid = wc.getOSProcessId() || null } catch { /* Renderer may exit while collecting. */ } }
      const requests = tab.net.requests({})
      return {
        id: tab.id, profileId: tab.profileId ?? 'default', url: safeUrl(tab.url), title: redact(tab.title), loading: tab.loading, rendererPid,
        destroyed, recovery: { ...tab.recovery, ...(tab.recovery.error ? { error: redact(tab.recovery.error) } : {}) },
        networkCaptureEnabled: tab.net.enabled, requestCount: requests.length,
        failures: requests.filter((request) => request.error || request.status >= 400).slice(-10).map((request) => ({ url: safeUrl(request.url), status: request.status, error: request.error ? redact(request.error) : null })),
        consoleErrors: tab.consoleBuf.filter((item) => item.level === 'error' || item.level === '3').slice(-10).map((item) => ({ at: item.ts, message: redact(item.text) }))
      }
    }),
    workflows: (deps.workflows?.() ?? []).filter((workflow) => !profileId || workflow.profileId === profileId).slice(-100).map((workflow) => ({ id: workflow.id, status: workflow.status ?? workflow.state ?? 'unknown', ...(workflow.profileId ? { profileId: workflow.profileId } : {}) })),
    downloads: { total: downloads.length, active: downloads.filter((item) => item.state === 'progressing').length, failed: downloads.filter((item) => item.state === 'interrupted').length }
  }
}

export type BrowserRepairAction = 'reload' | 'reconnect' | 'clear-cache' | 'disable-extension'

export interface BrowserRepairDependencies {
  getTab: (id: string) => Tab | null
  sessionFor: (profileId: string) => Pick<Session, 'clearCache' | 'closeAllConnections' | 'clearHostResolverCache'>
  reconnect?: (profileId: string) => Promise<unknown>
  disableExtension?: (profileId: string, extensionId: string) => Promise<unknown> | unknown
  approve: (request: { action: BrowserRepairAction; profileId: string; tabId?: string; extensionId?: string; risk: string }, signal?: AbortSignal) => Promise<boolean>
}

/** Repairs are explicit and approved; no automatic Cookie/Storage/file deletion exists. */
export async function repairBrowser(
  deps: BrowserRepairDependencies,
  input: { action: BrowserRepairAction; profileId: string; tabId?: string; extensionId?: string },
  signal?: AbortSignal
): Promise<{ ok: true; action: BrowserRepairAction; profileId: string; completedAt: number }> {
  if (!['reload', 'reconnect', 'clear-cache', 'disable-extension'].includes(input.action)) throw new Error('[INVALID_REPAIR] Unsupported repair action.')
  if (!/^(default|p[a-f0-9]{8,64})$/.test(input.profileId)) throw new Error('[INVALID_PROFILE] Invalid Profile identifier.')
  const tab = input.tabId ? deps.getTab(input.tabId) : null
  if (input.tabId && !tab) throw new Error('[TAB_NOT_FOUND] Repair target was not found.')
  if (tab && (tab.profileId ?? 'default') !== input.profileId) throw new Error('[PROFILE_ACCESS_DENIED] Repair target belongs to another Profile.')
  if (input.action === 'reload' && !tab) throw new Error('[INVALID_REPAIR] reload requires tabId.')
  if (input.action === 'disable-extension' && (!input.extensionId || !deps.disableExtension)) throw new Error('[INVALID_REPAIR] disable-extension requires an installed extension.')
  const risk = input.action === 'reload' ? 'Reload can discard unsaved forms or repeat a form submission. Check the page before approving.'
    : input.action === 'reconnect' ? 'Reconnect closes in-flight connections for this Profile. Active requests may fail.'
      : input.action === 'clear-cache' ? 'Clear only HTTP cache for this Profile. Cookie, Storage and login state are preserved.'
        : 'Disable this extension for this Profile. Reload affected pages to remove injected scripts.'
  throwIfAborted(signal)
  if (await deps.approve({ ...input, risk }, signal) !== true) throw new Error('[APPROVAL_DENIED] Repair was not approved.')
  throwIfAborted(signal)
  if (input.action === 'reload') {
    await withTabLock(tab!, signal, async () => {
      throwIfAborted(signal)
      await doReload(tab!, false, signal)
    })
  } else if (input.action === 'reconnect') {
    if (deps.reconnect) await deps.reconnect(input.profileId)
    else {
      const ses = deps.sessionFor(input.profileId)
      await ses.clearHostResolverCache()
      throwIfAborted(signal)
      await ses.closeAllConnections()
    }
  } else if (input.action === 'clear-cache') {
    await deps.sessionFor(input.profileId).clearCache()
  } else {
    await deps.disableExtension!(input.profileId, input.extensionId!)
  }
  throwIfAborted(signal)
  return { ok: true, action: input.action, profileId: input.profileId, completedAt: Date.now() }
}
