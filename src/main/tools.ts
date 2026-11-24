import type { ToolContent, BackgroundMode, MonitorState, AgentActivityState, AgentTaskRecord } from '@shared/types'
import { TOOL_DEFS, TOOL_ANNOTATIONS } from '@shared/tool-defs.mjs'
export { TOOL_ANNOTATIONS }
import { checkedStateScript, fingerprintScript, jsLiteral, refLiteral, tagNameScript } from '@snapshot/scripts'
import { TabManager, normalizeUrl } from './tabs'
import { clipBody, safeNetworkHeaders, safeNetworkUrl } from './network'
import type { DownloadTracker } from './downloads'
import {
  doHover,
  doNavigateHistory,
  doFind,
  doResize,
  doElementScreenshot,
  doCookies,
  doStorage,
  doUploadFile,
  doPdf,
  doGetSelector,
  resolveExportFile,
  inspectTypeTarget
} from './actions'
import type { ApprovalManager } from './approvals'
import { readDialogs, clearDialogs, setDialogPolicy, clearDialogPolicy, dialogGuardReady } from './dialogs'
import { runAssertions, formatAssertions, type AssertCheck } from './assertions'
import { listFrames, frameText, frameElements, frameEvaluate, frameClick, frameType, frameSelect } from './frames'
import { visualSave, visualCompare, visualList, visualDelete, formatDiff } from './visual'
import { getEvidenceManager } from './evidence'
import { getExtensionManager } from './extensions'
import { auditContrast, formatContrast } from './contrast'
import { captureViewportMatrix, VIEWPORT_PRESETS, formatViewportMatrix, type ViewportSpec } from './viewport'
import { clickCloudflareControl, formatCloudflareStatus, inspectCloudflare, waitForCloudflare } from './cloudflare'
import {
  ActionError,
  captureSnapshot,
  snapshotText,
  doNavigate,
  doReload,
  doClick,
  doDrag,
  doType,
  doSelectOption,
  doScroll,
  doPageState,
  doExtract,
  doWaitForText,
  doWaitForCondition,
  doWaitForDom,
  doWaitForAny,
  doPressKey,
  doScreenshot,
  doConsoleLogs,
  raceAbort,
  resolveWebContents,
  assertRefContext,
  assertTabUsable,
  throwIfAborted,
  withTabLock
} from './actions'

interface McpToolDefBase {
  name: string
  title: string
  description: string
  inputSchema: {
    type: 'object'
    properties: Record<string, unknown>
    required?: string[]
  }
  handler: (args: Record<string, unknown>) => Promise<{ content: ToolContent[]; isError?: boolean }>
}

/** MCP tool annotations exposed to hosts before a tool is called. */
export interface McpToolAnnotations {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

export interface McpToolDef extends McpToolDefBase {
  annotations: McpToolAnnotations
}

/** 工具结果：文本内容 */
const text = (t: string): ToolContent => ({ type: 'text', text: t })
const callSignal = (args: Record<string, unknown>): AbortSignal | undefined =>
  args['__aaSignal'] instanceof AbortSignal ? args['__aaSignal'] : undefined

interface PerformanceResourceEntry {
  name: string
  type: string
  duration: number
  transfer: number
  decoded: number
}

interface PerformanceSummary {
  url: string
  title: string
  readyState: string
  nav: { ttfb: number; domContentLoaded: number; load: number; transfer: number } | null
  paints: Record<string, number>
  resources: PerformanceResourceEntry[]
  memory: { used: number; total: number; limit: number } | null
  dom: { elements: number; images: number; pendingImages: number; scripts: number; stylesheets: number }
}

/** 在页面主世界采集 Performance API 指标（只读、单次表达式）。 */
const PERFORMANCE_SCRIPT = `(() => {
  const nav = performance.getEntriesByType('navigation')[0] || null;
  const paints = {};
  for (const entry of performance.getEntriesByType('paint')) paints[entry.name] = Math.round(entry.startTime);
  let resources = [];
  try {
    resources = performance.getEntriesByType('resource').map((entry) => ({
      name: entry.name,
      type: entry.initiatorType || 'other',
      duration: Math.round(entry.duration || 0),
      transfer: Number(entry.transferSize || 0),
      decoded: Number(entry.decodedBodySize || 0)
    }));
  } catch {}
  let memory = null;
  try {
    if (performance.memory) memory = {
      used: Number(performance.memory.usedJSHeapSize || 0),
      total: Number(performance.memory.totalJSHeapSize || 0),
      limit: Number(performance.memory.jsHeapSizeLimit || 0)
    };
  } catch {}
  let dom = { elements: 0, images: 0, pendingImages: 0, scripts: 0, stylesheets: 0 };
  try {
    const images = Array.from(document.images || []);
    dom = {
      elements: document.getElementsByTagName('*').length,
      images: images.length,
      pendingImages: images.filter((image) => !image.complete).length,
      scripts: document.scripts?.length || 0,
      stylesheets: document.styleSheets?.length || 0
    };
  } catch {}
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    nav: nav ? {
      ttfb: Math.round(nav.responseStart || 0),
      domContentLoaded: Math.round(nav.domContentLoadedEventEnd || 0),
      load: Math.round(nav.loadEventEnd || 0),
      transfer: Number(nav.transferSize || 0)
    } : null,
    paints,
    resources,
    memory,
    dom
  };
})()`

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0B'
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(2)}MB`
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${Math.round(bytes)}B`
}

/** 把可选快照拼接到结果文本后 */
function withSnap(base: string, snapshot: unknown, wantSnapshot: boolean): string {
  if (!wantSnapshot) return base
  if (!snapshot) return base + '\n\n（快照获取失败：页面可能正在跳转，请单独调用 browser_snapshot）'
  return base + '\n\n' + snapshotText(snapshot as Parameters<typeof snapshotText>[0])
}

export interface BrowserRuntimeInfo {
  instanceId?: string
  pid: number
  version?: string
  startedAt?: number
}

export interface WindowControl {
  resize: (w: number, h: number) => Promise<{ width: number; height: number }>
  /** 把浏览器窗口带到前台（最小化时先恢复）。 */
  focus?: () => void
  state?: () => { focused: boolean; visible: boolean; minimized: boolean }
  mode?: () => BackgroundMode
  setMode?: (mode: BackgroundMode) => BackgroundMode
  monitorStart?: (tabId?: string) => MonitorState
  monitorStop?: () => MonitorState
  monitorState?: () => MonitorState
  takeover?: () => MonitorState
  releaseToAi?: () => MonitorState
  assertAiControl?: () => void
  taskState?: (clientId?: number, sessionId?: string) => AgentActivityState
  taskDetail?: (taskId: string, clientId?: number, sessionId?: string) => AgentTaskRecord | null
  cancelTask?: (id: number, client?: number) => boolean
  pauseTasks?: (clientId?: number, exceptCallId?: number) => void
  resumeTasks?: (clientId?: number) => void
}

export function buildTools(
  tabs: TabManager,
  newtabUrl: string,
  searchUrl: string,
  windowCtl: WindowControl,
  downloads: DownloadTracker,
  approvals?: ApprovalManager,
  onAction?: (item: import('@shared/types').ActionLogItem) => void,
  getSettings?: () => { requireOperationApproval: boolean; fullSnapshot?: boolean; searchEngine?: string },
  browserInfo?: () => BrowserRuntimeInfo,
  /** 共享会话提供者：browser_extensions 装载扩展用；注入以保持本模块不直接依赖 electron。 */
  getSharedSession?: () => unknown
): McpToolDef[] {
  const tools: McpToolDefBase[] = []
  /** title / description / inputSchema 来自单一来源，主进程只保留 name 与 handler。 */
  const schemaByName = new Map(TOOL_DEFS.map((def) => [def.name, def]))
  function pushTool(tool: { name: string; handler: McpToolDefBase['handler'] }): void {
    const def = schemaByName.get(tool.name)
    if (!def) throw new Error(`工具 ${tool.name} 缺少共享 schema（src/shared/tool-defs.mjs）`)
    tools.push({
      name: tool.name,
      title: def.title,
      description: def.description,
      inputSchema: def.inputSchema,
      handler: tool.handler
    })
  }

  /** 单次调用取消与全局暂停是独立的，跨 await 后执行下一步前同时检查。 */
  function assertToolRunning(signal?: AbortSignal): void {
    if (signal) throwIfAborted(signal)
    approvals?.assertRunning()
  }

  /** 受保护的页面操作按标签排队；不提供项目所有权或跨调用事务。
   * 标签管理、窗口及会话级资源不由这把锁隔离。 */
  function onTab<T>(
    tab: ReturnType<typeof resolveWebContents>,
    signal: unknown,
    run: () => Promise<T>
  ): Promise<T> {
    const sig = signal instanceof AbortSignal ? signal : undefined
    return withTabLock(tab, sig, async () => {
      assertToolRunning(sig)
      assertTabUsable(tab)
      windowCtl.assertAiControl?.()
      return run()
    })
  }

  /** 若开启"高危操作人工确认"，请求一次人工批准；未开启直接放行。 */
  async function opGate(desc: { site: string; tabTitle: string; action: string; detail?: string }, signal?: unknown): Promise<void> {
    if (!approvals) return
    if (!getSettings?.().requireOperationApproval) return
    const sig = signal instanceof AbortSignal ? signal : undefined
    const allowed = await approvals.opRequest(
      { site: desc.site, tabTitle: desc.tabTitle, fieldLabel: desc.action, detail: desc.detail },
      sig
    )
    if (!allowed) throw new ActionError(`高危操作已取消：${desc.action}`)
  }

  /** 当前标签的站点标签（审批面板显示用；URL 异常时退回原始串） */
  function siteOf(tab: { view: { webContents: { getURL(): string } } }): string {
    const raw = tab.view.webContents.getURL()
    try {
      const url = new URL(raw)
      return url.host || url.protocol
    } catch {
      return raw
    }
  }

  /** Sensitive fields are always filled by the user, never from an agent-supplied value. */
  async function approveSensitiveType(
    tab: ReturnType<typeof resolveWebContents>,
    ref: string,
    target: { sensitive?: boolean; label?: string },
    signal?: AbortSignal
  ): Promise<void> {
    assertToolRunning(signal)
    if (tabs.activeId !== tab.id) throw new ActionError('敏感输入审批仅支持当前活动标签；请切换到目标标签后重试。')
    const wc = tab.view.webContents
    const originalUrl = wc.getURL()
    const originalFrame = await wc.executeJavaScript(fingerprintScript(ref), false) as { fingerprint?: string; rect?: number[] } | null
    assertToolRunning(signal)
    if (!originalFrame) throw new ActionError('敏感输入目标已失效；请刷新快照后重试。')
    const url = new URL(originalUrl)
    const allowed = approvals
      ? await approvals.request(
          { site: url.host || url.protocol, tabTitle: tab.title, fieldLabel: target.label || '敏感输入框', kind: 'sensitive' },
          signal
        )
      : false
    assertToolRunning(signal)
    if (!allowed) throw new ActionError('敏感输入已取消或超时；Agent 提供的文本未写入。')
    if (wc.isDestroyed() || wc.getURL() !== originalUrl || tabs.activeId !== tab.id) throw new ActionError('页面或活动标签在等待确认期间已变化；请重新获取快照后再继续。')
    const rechecked = await inspectTypeTarget(tab, ref)
    assertToolRunning(signal)
    if (!rechecked.ok || !rechecked.sensitive || rechecked.fingerprint !== originalFrame.fingerprint) throw new ActionError('敏感输入目标已变化；请重新获取快照后再继续。')
  }

  /** Inspect an iframe input without reading its value; selector is embedded as data. */
  async function inspectFrameTypeTarget(wc: Electron.WebContents, frameId: string, selector: string, signal?: AbortSignal): Promise<{
    ok: boolean; sensitive?: boolean; label?: string; fingerprint?: string; url?: string
  }> {
    const source = `(() => {
      const el = document.querySelector(${jsLiteral(selector)});
      if (!el) return { ok: false };
      const type = String(el.type || '').toLowerCase();
      const editable = el.isContentEditable === true;
      const label = String(el.labels && Array.from(el.labels).map(x => x.innerText || x.textContent).join(' ') || '');
      const autocomplete = String(el.autocomplete || '').toLowerCase();
      const meta = [label, el.name, el.id, autocomplete, el.placeholder, el.getAttribute('aria-label'), el.getAttribute('data-testid')].join(' ').toLowerCase();
      const pattern = /(token|secret|api.?key|access.?key|private.?key|password|passwd|credential|验证码|密钥|令牌|密码|otp|one.?time.?code|security.?code|auth.?code|card.?number|cc.?number|cvv|cvc|expiry|expiration)/i;
      const sensitive = type === 'password' || /^(current-password|new-password|one-time-code|cc-csc|cc-number|cc-exp|cc-exp-month|cc-exp-year)$/.test(autocomplete) || pattern.test(meta);
      const fingerprint = [el.tagName, type, el.name || '', el.id || '', autocomplete, el.getAttribute('aria-label') || '', label, editable ? 'contenteditable' : ''].join('|');
      if (sensitive) el.focus();
      return { ok: true, sensitive, editable, fingerprint, label: (label || el.getAttribute('aria-label') || el.name || el.id || type || el.tagName).slice(0, 120), url: String(location.href) };
    })()`
    return await frameEvaluate(wc, frameId, source, signal) as { ok: boolean; sensitive?: boolean; label?: string; fingerprint?: string; url?: string }
  }

  /** Gate iframe sensitive input while keeping the supplied text out of page execution. */
  async function approveSensitiveFrameType(
    tab: ReturnType<typeof resolveWebContents>,
    frameId: string,
    selector: string,
    signal?: AbortSignal
  ): Promise<void> {
    assertToolRunning(signal)
    if (tabs.activeId !== tab.id) throw new ActionError('敏感输入审批仅支持当前活动标签；请切换到目标标签后重试。')
    const wc = tab.view.webContents
    const original = await inspectFrameTypeTarget(wc, frameId, selector, signal)
    assertToolRunning(signal)
    if (!original.ok || !original.sensitive) throw new ActionError('敏感输入目标已变化；请重新获取 frame 元素后再继续。')
    const originalUrl = original.url || wc.getURL()
    let site = originalUrl
    try {
      const parsed = new URL(originalUrl)
      site = parsed.host || parsed.protocol
    } catch {
      /* 保留原始 frame URL */
    }
    const allowed = approvals
      ? await approvals.request(
          { site, tabTitle: tab.title, fieldLabel: original.label || '敏感输入框', kind: 'sensitive' },
          signal
        )
      : false
    assertToolRunning(signal)
    if (!allowed) throw new ActionError('敏感输入已取消或超时；Agent 提供的文本未写入。')
    if (wc.isDestroyed() || tabs.activeId !== tab.id) throw new ActionError('页面或活动标签在等待确认期间已变化；请重新获取 frame 元素后再继续。')
    const rechecked = await inspectFrameTypeTarget(wc, frameId, selector, signal)
    assertToolRunning(signal)
    if (!rechecked.ok || !rechecked.sensitive || rechecked.fingerprint !== original.fingerprint || rechecked.url !== original.url) {
      throw new ActionError('敏感输入目标已变化；请重新获取 frame 元素后再继续。')
    }
  }

  pushTool({
    name: 'browser_navigate',
    handler: async (args) => {
      approvals?.assertRunning()
      const url = String(args['url'] ?? '')
      if (!url) throw new ActionError('url 不能为空')
      const target = normalizeUrl(url, getSettings?.().searchEngine || searchUrl, newtabUrl)
      const signal = callSignal(args)
      const rawWait = args['waitFor']
      const waitFor = rawWait && typeof rawWait === 'object' && !Array.isArray(rawWait) ? (rawWait as Record<string, unknown>) : null
      const waitSelector = typeof waitFor?.['selector'] === 'string' && waitFor['selector'] ? String(waitFor['selector']) : ''
      const waitText = typeof waitFor?.['text'] === 'string' && waitFor['text'] ? String(waitFor['text']) : ''
      const waitUrl = typeof waitFor?.['urlContains'] === 'string' && waitFor['urlContains'] ? String(waitFor['urlContains']) : ''
      if (waitFor && !waitSelector && !waitText && !waitUrl) {
        throw new ActionError('waitFor 需要 selector、text 或 urlContains 之一')
      }
      const waitTimeoutMs = typeof waitFor?.['timeoutMs'] === 'number'
        ? Math.min(30000, Math.max(1000, waitFor['timeoutMs'] as number))
        : 10000
      type WaitOutcome = { found: boolean; elapsedMs: number; condition: string }
      const waitState: { outcome: WaitOutcome | null } = { outcome: null }
      let snapshot = ''
      const r = await doNavigate(tabs, target, {
        newTab: !!args['newTab'],
        tabId: args['tabId'] as string | undefined,
        signal,
        onComplete: async (tab, navSignal) => {
          assertToolRunning(signal)
          // 等待条件在标签锁内完成：SPA 渲染期间不会有其他 MCP 操作插进来。
          if (waitFor) {
            const condition = waitSelector ? `selector=${waitSelector}` : waitText ? `text=${waitText}` : `urlContains=${waitUrl}`
            if (waitSelector) {
              const w = await doWaitForDom(tab, { selector: waitSelector, timeoutMs: waitTimeoutMs, signal: navSignal })
              waitState.outcome = { found: w.found, elapsedMs: w.elapsedMs, condition }
            } else if (waitText) {
              const w = await doWaitForCondition(tab, { text: waitText, timeoutMs: waitTimeoutMs, signal: navSignal })
              waitState.outcome = { found: w.found, elapsedMs: w.elapsedMs, condition }
            } else {
              const w = await doWaitForDom(tab, { urlContains: waitUrl, timeoutMs: waitTimeoutMs, signal: navSignal })
              waitState.outcome = { found: w.found, elapsedMs: w.elapsedMs, condition }
            }
            assertToolRunning(signal)
          }
          if (args['snapshot'] === false) return
          try {
            const snap = await captureSnapshot(tab.view.webContents)
            assertToolRunning(signal)
            snapshot = '\n\n' + snapshotText(snap)
          } catch {
            assertToolRunning(signal)
            snapshot = '\n\n（快照获取失败：页面可能仍在跳转，请单独调用 browser_snapshot）'
          }
        }
      })
      const waitOutcome = waitState.outcome
      const waitNote = waitOutcome
        ? `\n等待条件 ${waitOutcome.condition}: ${waitOutcome.found ? `已满足（${waitOutcome.elapsedMs}ms）` : `超时（${waitOutcome.elapsedMs}ms）`}`
        : ''
      return {
        content: [text(`已导航: ${r.url}\ntitle: ${r.title}${waitNote}${snapshot}`)],
        ...(waitOutcome && !waitOutcome.found ? { isError: true } : {})
      }
    }
  })

  pushTool({
    name: 'browser_reload',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const want = args['snapshot'] !== false
      const signal = args['__aaSignal'] instanceof AbortSignal ? args['__aaSignal'] : undefined
      const body = await onTab(tab, signal, async () => {
        const r = await doReload(tab, args['hard'] === true, signal)
        let out = `已刷新: ${r.url}\ntitle: ${r.title}`
        if (want) {
          try {
            out += '\n\n' + snapshotText(await captureSnapshot(tab.view.webContents))
          } catch {
            out += '\n\n（刷新完成但快照获取失败，请单独调用 browser_snapshot）'
          }
        }
        return out
      })
      return { content: [text(body)] }
    }
  })
  pushTool({
    name: 'browser_snapshot',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      // 设置「快照默认全量」此前只存在配置里、从未被读取；这里让 full 参数真正回退到该设置。
      const forceFull = args['full'] === true || (args['full'] === undefined && getSettings?.().fullSnapshot === true)
      const maxNodes = typeof args['maxNodes'] === 'number' ? args['maxNodes'] : undefined
      const cursor = typeof args['cursor'] === 'number' ? args['cursor'] : undefined
      // 快照与页面操作同队列，保证读到的树不会落在其他客户端导航的中间状态。
      const snap = await onTab(tab, callSignal(args), () => captureSnapshot(tab.view.webContents, {
        ...(forceFull ? { mode: 'full' as const } : {}),
        ...(maxNodes !== undefined ? { maxNodes } : {}),
        ...(cursor !== undefined ? { cursor } : {})
      }))
      return { content: [text(snapshotText(snap))] }
    }
  })

  pushTool({
    name: 'browser_click',
    handler: async (args) => {
      approvals?.assertRunning()
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const want = args['snapshot'] !== false
      const button = (args['button'] as 'left' | 'right' | 'middle') || 'left'
      const clickCount = args['doubleClick'] ? 2 : 1
      const signal = callSignal(args)
      const r = await onTab(tab, signal, () => doClick(tab, String(args['ref']), want, { button, clickCount, signal }))
      return { content: [text(withSnap(`已点击: ${r.clicked}`, r.snapshot, want))] }
    }
  })

  pushTool({
    name: 'browser_drag',
    handler: async (args) => {
      approvals?.assertRunning()
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const want = args['snapshot'] !== false
      const signal = args['__aaSignal'] instanceof AbortSignal ? args['__aaSignal'] : undefined
      const r = await onTab(tab, signal, () => doDrag(tab, String(args['ref']), {
        toRef: args['toRef'] as string | undefined,
        dx: args['dx'] as number | undefined,
        dy: args['dy'] as number | undefined,
        wantSnapshot: want,
        signal
      }))
      // 拖放是否真的被页面接收必须如实回报：命令成功但页面没有 drop
      // 是后台拖拽最典型的静默失败。
      const verdict = r.dropped ? '' : '\n注意：没有在页面侧观测到 drop 事件，目标元素可能不支持该拖放。'
      return { content: [text(withSnap(`已拖拽: ${r.dragged}${verdict}`, r.snapshot, want))] }
    }
  })

  pushTool({
    name: 'browser_type',
    handler: async (args) => {
      const signal = callSignal(args)
      assertToolRunning(signal)
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      // 检查、审批与实际输入在同一把标签页锁内完成，避免并发客户端改写目标元素。
      return onTab(tab, signal, async (): Promise<{ content: ToolContent[] }> => {
        const ref = String(args['ref'])
        const target = await inspectTypeTarget(tab, ref)
        assertToolRunning(signal)
        if (!target.ok) throw new ActionError(`找不到输入目标 ${ref}；请刷新页面快照后重试。`)
        if (target.sensitive) {
          // Never write or retain an agent-supplied secret. Let the user type directly into the focused page field.
          await approveSensitiveType(tab, ref, target, signal)
          if (args['submit']) throw new ActionError('敏感字段已填写，但 Agent 不会自动提交；请由你在网页中亲自确认提交。')
          return { content: [text('已允许继续。敏感字段内容由你在网页中输入；Agent 提供的文本未写入、读取或回传。请继续后续步骤。')] }
        }
        if (args['submit']) {
          await opGate(
            { site: new URL(tab.view.webContents.getURL()).host || tab.view.webContents.getURL(), tabTitle: tab.title, action: '提交表单/输入后回车' },
            signal
          )
          assertToolRunning(signal)
        }
        const want = args['snapshot'] !== false
        const r = await doType(tab, ref, String(args['text'] ?? ''), {
          submit: !!args['submit'],
          clear: !!args['clear'],
          wantSnapshot: want,
          signal
        })
        return { content: [text(withSnap(`已输入: ${r.typed}`, r.snapshot, want))] }
      })
    }
  })

  pushTool({
    name: 'browser_select_option',
    handler: async (args) => {
      approvals?.assertRunning()
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const want = args['snapshot'] !== false
      const signal = callSignal(args)
      const r = await onTab(tab, signal, () => doSelectOption(tab, String(args['ref']), {
        value: args['value'] as string | undefined,
        label: args['label'] as string | undefined,
        wantSnapshot: want,
        signal
      }))
      return { content: [text(withSnap(`已选择: ${r.selected}`, r.snapshot, want))] }
    }
  })

  pushTool({
    name: 'browser_scroll',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const want = args['snapshot'] !== false
      const dir = String(args['direction'] ?? 'down')
      if (!['up', 'down', 'left', 'right'].includes(dir)) throw new ActionError('direction 必须是 up/down/left/right')
      const amount = typeof args['amount'] === 'number' ? args['amount'] : 700
      const { result, snapshot } = await onTab(tab, callSignal(args), () => doScroll(tab, dir, amount, want))
      const reasonText =
        result.reason === 'at-limit' ? '已到该方向的可滚动边界'
          : result.reason === 'not-scrollable' ? '页面内容不足一屏，无法滚动'
            : result.reason === 'no-scrollable-area' ? '未找到可滚动区域（页面可能尚未完成渲染）'
              : '页面位置未变化'
      const vertical = dir === 'up' || dir === 'down'
      const effective = result.requested
        ? Math.abs(vertical ? result.requested.y : result.requested.x)
        : Math.max(50, Math.min(3000, Math.round(amount)))
      const moved = result.moved ? Math.abs(vertical ? result.moved.y : result.moved.x) : null
      const head = result.didScroll
        ? `已滚动: ${dir} 实际 ${moved ?? effective}px（请求 ${amount}px，生效 ${effective}px；作用区域: ${result.where}）`
        : `未发生滚动: ${dir} 请求 ${amount}px（${reasonText}）`
      const pos = result.before && result.after
        ? `位置: (${result.before.x}, ${result.before.y}) → (${result.after.x}, ${result.after.y})`
        : ''
      const hint = result.didScroll
        ? ''
        : '如果页面确实还有未读内容，先 browser_wait 等待选择器出现，或 browser_page_state 确认滚动高度与可见性。'
      const visibilityHint = result.hidden
        ? `页面处于后台（visibilityState=${result.visibilityState ?? 'hidden'}）；滚动仍会执行，但定时器与网络上报可能被节流。`
        : ''
      const details = { ...result, tabId: tab.id, activeTab: tabs.activeId === tab.id }
      const base = [head, pos, visibilityHint, hint, JSON.stringify(details, null, 2)].filter(Boolean).join('\n')
      return { content: [text(withSnap(base, snapshot, want))] }
    }
  })

  pushTool({
    name: 'browser_extract',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const r = await onTab(tab, callSignal(args), () => doExtract(tab, args['ref'] as string | undefined))
      const head = r.title ? `title: ${r.title}\n\n` : ''
      return { content: [text(head + r.text)] }
    }
  })

  pushTool({
    name: 'browser_page_state',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const page = await onTab(tab, callSignal(args), () => doPageState(tab))
      const info = browserInfo?.()
      const win = windowCtl.state?.()
      const state = {
        browser: info ?? { pid: process.pid },
        window: win ?? null,
        tabId: tab.id,
        activeTab: tabs.activeId === tab.id,
        tabTitle: tab.title,
        isolated: tab.isolated,
        restored: tab.restored,
        loading: tab.loading,
        createdAt: tab.createdAt,
        ...page,
        ready: page['readyState'] === 'complete' && !tab.loading
      }
      return { content: [text(JSON.stringify(state, null, 2))] }
    }
  })

  pushTool({
    name: 'browser_cloudflare',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const action = String(args['action'] ?? 'inspect')
      if (!['inspect', 'click', 'wait'].includes(action)) {
        throw new ActionError('Cloudflare 操作必须为 inspect、click 或 wait。')
      }
      const signal = callSignal(args)
      return onTab(tab, signal, async (): Promise<{ content: ToolContent[]; isError?: boolean }> => {
        if (action === 'inspect') {
          const status = await inspectCloudflare(tab)
          return { content: [text(formatCloudflareStatus(status))] }
        }
        if (action === 'wait') {
          const timeoutMs = typeof args['timeoutMs'] === 'number' ? args['timeoutMs'] : undefined
          const result = await waitForCloudflare(tab, timeoutMs, signal)
          const body = JSON.stringify({ completed: result.completed, elapsedMs: result.elapsedMs, status: JSON.parse(formatCloudflareStatus(result.status)) }, null, 2)
          return { content: [text(body)], ...(result.completed ? {} : { isError: true }) }
        }
        if (args['confirm'] !== true) {
          throw new ActionError('Cloudflare click 是真实鼠标操作；确认页面上的复选框属于你要访问的站点后，传入 confirm:true。滑块或图片挑战必须由用户手动完成。')
        }
        await opGate(
          {
            site: siteOf(tab),
            tabTitle: tab.title,
            action: '点击 Cloudflare 验证复选框',
            detail: '仅发送一次可见复选框的真实鼠标事件，不读取或修改挑战令牌。'
          },
          signal
        )
        assertToolRunning(signal)
        const result = await clickCloudflareControl(tab, {
          frameId: typeof args['frameId'] === 'string' ? args['frameId'] : undefined,
          candidateIndex: typeof args['candidateIndex'] === 'number' ? args['candidateIndex'] : undefined,
          focus: windowCtl.focus
        })
        assertToolRunning(signal)
        const body = {
          clicked: { frameId: result.frameId, control: result.control, point: result.point },
          status: JSON.parse(formatCloudflareStatus(result.status))
        }
        return { content: [text(JSON.stringify(body, null, 2))] }
      })
    }
  })

  pushTool({
    name: 'browser_wait',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const wantText = typeof args['text'] === 'string' && args['text'] !== ''
      const wantGone = typeof args['textGone'] === 'string' && args['textGone'] !== ''
      const wantSelector = typeof args['selector'] === 'string' && args['selector'] !== ''
      const wantSelectorGone = typeof args['selectorGone'] === 'string' && args['selectorGone'] !== ''
      const wantUrl = typeof args['urlContains'] === 'string' && args['urlContains'] !== ''
      const fixed = typeof args['time'] === 'number' ? Math.min(30000, Math.max(0, args['time'])) : null
      if (!wantText && !wantGone && !wantSelector && !wantSelectorGone && !wantUrl && fixed === null) {
        throw new ActionError('请提供 text、textGone、selector、selectorGone、urlContains 或 time 之一')
      }
      if (fixed !== null && !wantText && !wantGone && !wantSelector && !wantSelectorGone && !wantUrl) {
        const signal = args['__aaSignal'] instanceof AbortSignal ? args['__aaSignal'] : undefined
        await raceAbort(new Promise((r) => setTimeout(r, fixed)), signal)
        return { content: [text(`已等待 ${fixed}ms`)] }
      }
      const timeoutMs = typeof args['timeoutMs'] === 'number' ? args['timeoutMs'] : 10000
      const wants: string[] = []
      if (wantText) wants.push(`"${args['text']}" 出现`)
      if (wantGone) wants.push(`"${args['textGone']}" 消失`)
      if (wantSelector) wants.push(`${args['selector']} 出现`)
      if (wantSelectorGone) wants.push(`${args['selectorGone']} 消失`)
      if (wantUrl) wants.push(`URL 含 "${args['urlContains']}"`)
      // 条件等待期间持有标签页队列：等待不会与其他客户端对同一标签的导航/点击穿插。
      return onTab(tab, args['__aaSignal'], async (): Promise<{ content: ToolContent[]; isError?: boolean }> => {
        const r = await doWaitForAny(tab, {
          text: wantText ? String(args['text']) : undefined,
          textGone: wantGone ? String(args['textGone']) : undefined,
          selector: wantSelector ? String(args['selector']) : undefined,
          selectorGone: wantSelectorGone ? String(args['selectorGone']) : undefined,
          urlContains: wantUrl ? String(args['urlContains']) : undefined,
          timeoutMs,
          signal: args['__aaSignal'] instanceof AbortSignal ? args['__aaSignal'] : undefined
        })
        if (!r.found) {
          return {
            content: [text(`超时 ${r.elapsedMs}ms，未等到 ${wants.join(' 或 ')}。可调用 browser_snapshot 查看当前页面。`)],
            isError: true
          }
        }
        const label =
          r.which === 'appeared'
            ? `"${args['text']}" 已出现`
            : r.which === 'gone'
              ? `"${args['textGone']}" 已消失`
              : r.which === 'selector'
                ? `${args['selector']} 已出现`
                : r.which === 'selectorGone'
                  ? `${args['selectorGone']} 已消失`
                  : `URL 已包含 "${args['urlContains']}"`
        return { content: [text(`${label}（等待 ${r.elapsedMs}ms）`)] }
      })
    }
  })

  pushTool({
    name: 'browser_press_key',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const r = await onTab(tab, callSignal(args), () => doPressKey(tab, String(args['key'] ?? ''), Array.isArray(args['modifiers']) ? args['modifiers'].map(String) : []))
      const suffix = r.modifiers.length ? ` + ${r.modifiers.join('+')}` : ''
      return { content: [text(`已按下: ${r.pressed}${suffix}`)] }
    }
  })

  pushTool({
    name: 'browser_screenshot',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const signal = args['__aaSignal'] instanceof AbortSignal ? args['__aaSignal'] : undefined
      const image = await onTab(tab, signal, () =>
        args['ref']
          ? doElementScreenshot(tab, String(args['ref']))
          : doScreenshot(tab, signal, { fullPage: args['fullPage'] === true })
      )
      assertToolRunning(signal)
      const { app } = await import('electron')
      const dir = process.env['AA_BROWSER_SCREENSHOT_DIR'] || `${app.getPath('home')}/.aabrowser/screenshots`
      try {
        const fs = await import('node:fs')
        const path = await import('node:path')
        assertToolRunning(signal)
        fs.mkdirSync(dir, { recursive: true })
        const file = path.join(dir, `aa-${Date.now()}.png`)
        fs.writeFileSync(file, Buffer.from(image.data ?? '', 'base64'))
        getEvidenceManager().record(file, 'screenshot')
        return {
          content: [
            image,
            text(`截图已保存: ${file}\n页面: ${tab.url}`)
          ]
        }
      } catch {
        return { content: [image] }
      }
    }
  })

  /* ── v0.4.0 新增：交互补全 ── */

  pushTool({
    name: 'browser_hover',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const r = await onTab(tab, callSignal(args), () => doHover(tab, String(args['ref'])))
      return { content: [text(`已悬停: ${r.hovered}`)] }
    }
  })

  pushTool({
    name: 'browser_navigate_back',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const want = args['snapshot'] !== false
      const r = await onTab(tab, callSignal(args), () => doNavigateHistory(tab, 'back', want, (t) => tabs.goBack(t), (t) => tabs.canBack(t)))
      return { content: [text(withSnap('已后退', r.snapshot, want))] }
    }
  })

  pushTool({
    name: 'browser_navigate_forward',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const want = args['snapshot'] !== false
      const r = await onTab(tab, callSignal(args), () => doNavigateHistory(tab, 'forward', want, (t) => tabs.goForward(t), (t) => tabs.canForward(t)))
      return { content: [text(withSnap('已前进', r.snapshot, want))] }
    }
  })

  pushTool({
    name: 'browser_resize',
    handler: async (args) => {
      const w = Number(args['width'])
      const h = Number(args['height'])
      const r = await doResize(resolveWebContents(tabs, args['tabId'] as string | undefined), windowCtl.resize, w, h)
      return { content: [text(`视口已调整为 ${r.width}×${r.height}`)] }
    }
  })

  /* ── v0.4.0 新增：观察增强 ── */

  pushTool({
    name: 'browser_get_selector',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const r = await onTab(tab, callSignal(args), () => doGetSelector(tab, String(args['ref'])))
      const badge = r.verified ? '✅ 已回验' : '⚠️ 未能回验（元素可能在 iframe 内或动态生成）'
      return { content: [text(`${badge}\nselector: ${r.selector}\n元素文本: ${r.text || '（无）'}`)] }
    }
  })

  pushTool({
    name: 'browser_find',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const r = await onTab(tab, callSignal(args), () => doFind(tab, String(args['text'] ?? '')))
      const summary =
        r.matches === 0
          ? `页面未找到"${String(args['text'] ?? '')}"（共 0 处匹配），没有可定位的文本`
          : `页面共 ${r.matches} 处匹配"${args['text']}"，已高亮并定位到第 ${r.activeOrdinal ?? 1} 处`
      return { content: [text(summary)] }
    }
  })

  /* ── v0.4.0 新增：状态与数据 ── */

  pushTool({
    name: 'browser_cookies',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const action = args['action']
      if (action !== 'get' && action !== 'set' && action !== 'clear') {
        throw new ActionError('Cookie 操作必须为 get、set 或 clear。')
      }
      if (action === 'set' || action === 'clear') {
        await opGate(
          {
            site: siteOf(tab),
            tabTitle: tab.title,
            action: action === 'set' ? '写入 Cookie（会改变登录态）' : '清除 Cookie（可能导致登出）',
            detail:
              (args['url'] ? `来源: ${String(args['url'])}` : `域名: ${String(args['domain'] ?? '全部')}`) +
              ` · 名称: ${String(args['name'] ?? '全部')}`
          },
          args['__aaSignal']
        )
      }
      const r = await doCookies(tab, {
        action,
        url: args['url'] as string | undefined,
        name: args['name'] as string | undefined,
        value: args['value'] as string | undefined,
        domain: args['domain'] as string | undefined,
        secure: args['secure'] as boolean | undefined,
        httpOnly: args['httpOnly'] as boolean | undefined,
        expiresSeconds: args['expiresSeconds'] as number | undefined
      })
      return { content: [text(r.content)] }
    }
  })

  pushTool({
    name: 'browser_storage',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const action = String(args['action'])
      const r = await onTab(tab, args['__aaSignal'], async () => {
        if (action === 'set' || action === 'remove' || action === 'clear') {
          await opGate(
            {
              site: siteOf(tab),
              tabTitle: tab.title,
              action: action === 'set' ? '写入页面存储' : action === 'remove' ? '删除页面存储' : '清空页面存储',
              detail: `${(args['kind'] as string) === 'session' ? 'sessionStorage' : 'localStorage'} · 键: ${String(args['key'] ?? '全部')}`
            },
            args['__aaSignal']
          )
        }
        assertToolRunning(callSignal(args))
        return await doStorage(tab, {
          action: action as 'get' | 'set' | 'remove' | 'clear',
          kind: (args['kind'] as 'local' | 'session') ?? 'local',
          key: args['key'] as string | undefined,
          value: args['value'] as string | undefined
        })
      })
      return { content: [text(r.content)] }
    }
  })

  pushTool({
    name: 'browser_downloads',
    handler: async (args) => {
      const action = String(args['action'] ?? 'list')
      if (action === 'cancel' || action === 'retry') {
        const id = String(args['id'] ?? '')
        if (!id) throw new ActionError('cancel / retry 需要提供 id（用 action=list 查看）')
        if (action === 'cancel') {
          const ok = downloads.cancel(id)
          if (!ok) throw new ActionError(`下载 ${id} 不在进行中，无法取消`)
          return { content: [text(`已取消下载 ${id}；文件不会继续使用。`)] }
        }
        const r = await downloads.retry(id)
        if (!r.ok) throw new ActionError(r.reason ?? '重试失败')
        return { content: [text(`已重新发起下载（来源记录 ${id}）。用 action=list 查看新记录。`)] }
      }
      if (action !== 'list') throw new ActionError(`未知 action: ${action}（支持 list/cancel/retry）`)
      const limit = Math.min(100, Math.max(1, (args['limit'] as number) ?? 20))
      const items = downloads.list(limit)
      if (!items.length) return { content: [text('（暂无下载记录）')] }
      const lines = items.map(
        (d) =>
          `[${d.id}] ${d.filename} — ${d.state} ${(d.receivedBytes / 1024).toFixed(1)}/${(d.totalBytes / 1024).toFixed(1)}KB${d.retriedFrom ? `（重试自 ${d.retriedFrom}）` : ''}\n    来源: ${d.url.slice(0, 120)}\n    保存: ${d.savePath}`
      )
      return { content: [text(`共 ${items.length} 条下载记录：\n${lines.join('\n')}`)] }
    }
  })

  pushTool({
    name: 'browser_pdf',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const r = await onTab(tab, callSignal(args), () => doPdf(tab, args['path'] as string | undefined, !!args['landscape'], callSignal(args)))
      return { content: [text(`PDF 已保存: ${r.savedPath}`)] }
    }
  })

  pushTool({
    name: 'browser_upload_file',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const paths = (args['paths'] as unknown[]).map(String)
      if (!paths.length) throw new ActionError('paths 不能为空')
      const r = await onTab(tab, args['__aaSignal'], async () => {
        await opGate(
          {
            site: siteOf(tab),
            tabTitle: tab.title,
            action: '把本机文件上传到网页',
            detail: paths.map((p) => p.slice(-90)).join('、')
          },
          args['__aaSignal']
        )
        assertToolRunning(callSignal(args))
        return await doUploadFile(tab, String(args['ref']), paths)
      })
      return { content: [text(r.content)] }
    }
  })

  pushTool({
    name: 'browser_console',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const r = doConsoleLogs(tab, {
        level: args['level'] as string | undefined,
        limit: args['limit'] as number | undefined
      })
      if (!r.logs.length) return { content: [text('（无控制台日志）')] }
      const body = r.logs
        .map((l) => `[${l.level}] ${l.text.replace(/\s+/g, ' ').slice(0, 500)}`)
        .join('\n')
      return { content: [text(`共 ${r.logs.length} 条：\n${body}`)] }
    }
  })

  pushTool({
    name: 'browser_performance',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const wc = tab.view.webContents
      if (wc.isDestroyed()) throw new ActionError('reason=target_closed 页面已关闭', 'TARGET_CLOSED')
      const limit = Math.min(20, Math.max(1, Math.floor(Number(args['slowest'] ?? 5)) || 5))
      const summary = (await onTab(tab, callSignal(args), () => wc.executeJavaScript(PERFORMANCE_SCRIPT, true))) as PerformanceSummary
      const lines: string[] = ['页面性能摘要', `url: ${String(summary?.url ?? tab.url)}`]
      if (summary?.title) lines.push(`title: ${summary.title}`)
      lines.push(`文档状态: ${summary?.readyState ?? '未知'}`)
      if (summary?.nav) {
        lines.push(`导航: TTFB ${summary.nav.ttfb}ms | DOMContentLoaded ${summary.nav.domContentLoaded}ms | load ${summary.nav.load}ms | 文档传输 ${formatSize(summary.nav.transfer)}`)
      } else {
        lines.push('导航: 无 navigation timing（页面可能尚未完成导航）')
      }
      const paints = Object.entries(summary?.paints ?? {}).map(([name, value]) => `${name} ${value}ms`).join(' | ')
      lines.push(`绘制: ${paints || '暂不可用'}`)
      const resources = Array.isArray(summary?.resources) ? summary.resources : []
      const transfer = resources.reduce((sum, entry) => sum + (Number(entry.transfer) || 0), 0)
      const decoded = resources.reduce((sum, entry) => sum + (Number(entry.decoded) || 0), 0)
      lines.push(`资源: ${resources.length} 个 | 传输 ${formatSize(transfer)} | 解码 ${formatSize(decoded)}`)
      if (resources.length) {
        const slowest = [...resources].sort((a, b) => (Number(b.duration) || 0) - (Number(a.duration) || 0)).slice(0, limit)
        lines.push('慢资源:')
        for (const entry of slowest) {
          lines.push(`  ${Number(entry.duration) || 0}ms ${formatSize(Number(entry.transfer) || 0)} ${String(entry.type ?? 'other')} ${String(entry.name ?? '').slice(0, 160)}`)
        }
      }
      if (summary?.memory) lines.push(`JS 堆: 使用 ${formatSize(summary.memory.used)} / 上限 ${formatSize(summary.memory.limit)}`)
      const dom = summary?.dom ?? { elements: 0, images: 0, pendingImages: 0, scripts: 0, stylesheets: 0 }
      lines.push(`DOM: 元素 ${dom.elements} | 图片 ${dom.images}（未完成 ${dom.pendingImages}）| 脚本 ${dom.scripts} | 样式表 ${dom.stylesheets}`)
      return { content: [text(lines.join('\n'))] }
    }
  })

  pushTool({
    name: 'browser_network_requests',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      await tab.net.ensure()
      const list = tab.net.requests({
        urlContains: args['urlContains'] as string | undefined,
        method: args['method'] as string | undefined,
        statusMin: args['statusMin'] as number | undefined,
        statusMax: args['statusMax'] as number | undefined,
        resourceType: args['resourceType'] as string | undefined
      })
      const limit = Math.min(200, Math.max(1, (args['limit'] as number) ?? 50))
      const shown = list.slice(-limit)
      if (!shown.length) {
        return { content: [text('（暂无匹配的网络请求。页面需要先产生网络活动；抓包自首次调用起生效）')] }
      }
      const lines = shown.map(
        (e) =>
          `[${e.requestId}] ${e.method} ${e.status || '…'} ${e.resourceType} ` +
          `${(e.size / 1024).toFixed(1)}KB 耗时:${e.durationMs != null ? e.durationMs + 'ms' : '…'} ` +
          `${e.error ? 'ERROR:' + e.error : ''} ${safeNetworkUrl(e.url).slice(0, 160)}`
      )
      // 机器可读副本：Agent 需要按耗时/状态排序或筛别时不必解析中文散文。
      const structured = shown.map((e) => ({
        requestId: e.requestId,
        method: e.method,
        url: safeNetworkUrl(e.url),
        status: e.status,
        resourceType: e.resourceType,
        size: e.size,
        durationMs: e.durationMs,
        error: e.error,
        ...(e.redirectUrl ? { redirectUrl: safeNetworkUrl(e.redirectUrl) } : {})
      }))
      return {
        content: [
          text(
            `共 ${list.length} 条（显示最近 ${shown.length} 条）：\n${lines.join('\n')}\n\n结构化数据:\n${JSON.stringify(structured)}`
          )
        ]
      }
    }
  })

  pushTool({
    name: 'browser_network_detail',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const includeSensitive = args['includeSensitive'] === true
      if (includeSensitive) {
        await opGate({
          site: tab.url,
          tabTitle: tab.title,
          action: '查看敏感网络数据',
          detail: '将把认证头、凭据参数或其他可能包含秘密的网络数据返回给 Agent。'
        }, args['__aaSignal'])
      }
      await tab.net.ensure()
      const entry = tab.net.find(String(args['requestId'] ?? ''))
      if (!entry) throw new ActionError(`找不到请求 ${args['requestId']}（用 browser_network_requests 查看当前抓到的请求）`)
      const parts: string[] = [
        `${entry.method} ${safeNetworkUrl(entry.url, includeSensitive)}`,
        `状态: ${entry.status} ${entry.statusText}${entry.error ? '（失败: ' + entry.error + '）' : ''}`,
        `类型: ${entry.resourceType} | 大小: ${(entry.size / 1024).toFixed(1)}KB | 耗时: ${entry.durationMs != null ? entry.durationMs + 'ms' : '未完成或未知'}`,
        '',
        '请求头:',
        ...Object.entries(safeNetworkHeaders(entry.requestHeaders, includeSensitive)).map(([k, v]) => `  ${k}: ${v}`),
        '',
        '响应头:',
        ...Object.entries(safeNetworkHeaders(entry.responseHeaders, includeSensitive)).map(([k, v]) => `  ${k}: ${v}`)
      ]
      if (args['body'] === true) {
        const body = await tab.net.getResponseBody(entry.requestId)
        parts.push('', '响应体:', clipBody(body, entry.mimeType, includeSensitive))
      }
      const structured = {
        requestId: entry.requestId,
        method: entry.method,
        url: safeNetworkUrl(entry.url, includeSensitive),
        status: entry.status,
        statusText: entry.statusText,
        resourceType: entry.resourceType,
        mimeType: entry.mimeType,
        size: entry.size,
        durationMs: entry.durationMs,
        error: entry.error,
        ...(entry.redirectUrl ? { redirectUrl: safeNetworkUrl(entry.redirectUrl, includeSensitive) } : {}),
        requestHeaders: safeNetworkHeaders(entry.requestHeaders, includeSensitive),
        responseHeaders: safeNetworkHeaders(entry.responseHeaders, includeSensitive)
      }
      parts.push('', '结构化数据:', JSON.stringify(structured))
      return { content: [text(parts.join('\n'))] }
    }
  })

  pushTool({
    name: 'browser_har',
    handler: async (args) => {
      const signal = callSignal(args)
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const includeSensitive = args['includeSensitive'] === true
      if (includeSensitive) {
        await opGate({
          site: tab.url,
          tabTitle: tab.title,
          action: '导出敏感网络数据',
          detail: '将把认证头、凭据参数或其他可能包含秘密的网络数据写入本地 HAR 文件。'
        }, signal)
      }
      assertToolRunning(signal)
      await tab.net.ensure()
      assertToolRunning(signal)
      const [{ app }, fs, path, os] = await Promise.all([
        import('electron'), import('node:fs'), import('node:path'), import('node:os')
      ])
      assertToolRunning(signal)
      const defaultFile = path.join(os.homedir(), '.aabrowser', 'har', `aa-${Date.now()}.har`)
      const { file, explicit } = await resolveExportFile(args['path'] as string | undefined, '.har', defaultFile)
      const data = JSON.stringify(tab.net.toHar(app.getVersion(), includeSensitive), null, 2)
      // 创建目录也是副作用；取消时不得创建目录、写文件或登记证据。
      assertToolRunning(signal)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, data, 'utf-8')
      getEvidenceManager().record(file, 'har', { managed: !explicit })
      return { content: [text(`HAR 已导出: ${file}\n共 ${fs.statSync(file).size} 字节`)] }
    }
  })

  /* ── v0.6.0 新增：请求拦截与 Mock ── */

  pushTool({
    name: 'browser_mock_requests',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      return onTab(tab, callSignal(args), async () => {
        const id = tab.net.setMock({
          urlContains: String(args['urlContains'] ?? ''),
          method: args['method'] as string | undefined,
          status: args['status'] as number | undefined,
          headers: (args['headers'] as Record<string, string> | undefined) ?? {},
          body: args['body'] as string | undefined,
          action: (args['action'] as 'respond' | 'continue') ?? 'respond'
        })
        await tab.net.ensureMockInterception()
        const list = tab.net.listMocks()
        const lines = list.map(
          (m) => `[${m.id}] ${m.method ?? '*'}: ${m.urlContains} → ${m.status} (${m.action}, 命中${m.hits}次)`
        )
        return { content: [text(`已拦截规则 ${id}\n当前 ${lines.length} 条：\n${lines.join('\n') || '（无）'}`)] }
      })
    }
  })

  pushTool({
    name: 'browser_list_mocks',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const list = tab.net.listMocks()
      if (!list.length) return { content: [text('（当前无 mock 规则）')] }
      const lines = list.map(
        (m) => `[${m.id}] ${m.method ?? '*'}: ${m.urlContains} → ${m.status} (${m.action}, 命中${m.hits}次)`
      )
      return { content: [text(`共 ${lines.length} 条规则：\n${lines.join('\n')}`)] }
    }
  })

  pushTool({
    name: 'browser_clear_mocks',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      return onTab(tab, callSignal(args), async () => {
        const id = args['id'] as string | undefined
        if (id) {
          const ok = tab.net.removeMock(String(id))
          if (!ok) throw new ActionError(`找不到规则 ${id}`)
          await tab.net.ensureMockInterception()
          return { content: [text(`已删除规则 ${id}`)] }
        }
        const n = tab.net.clearMocks()
        await tab.net.ensureMockInterception()
        return { content: [text(`已清空 ${n} 条 mock 规则`)] }
      })
    }
  })

  pushTool({
    name: 'browser_extensions',
    handler: async (args) => {
      approvals?.assertRunning()
      const manager = getExtensionManager()
      const ses = getSharedSession?.() as import('./extensions').ExtensionsSession | undefined
      if (!ses?.extensions) throw new ActionError('浏览器会话未就绪，无法管理扩展；请稍后重试。')
      const action = String(args['action'] ?? 'list')
      if (action === 'list') {
        const list = manager.list()
        if (!list.length) {
          return { content: [text('（尚未加载任何已解压扩展。用 action=load 传入包含 manifest.json 的目录绝对路径。）')] }
        }
        const lines = list.map((e) => `[${e.id}] ${e.name} v${e.version} (MV${e.manifestVersion})\n    ${e.path}`)
        return { content: [text(`共 ${list.length} 个已解压扩展：\n${lines.join('\n')}`)] }
      }
      if (action === 'load') {
        const dir = String(args['path'] ?? '').trim()
        if (!dir) throw new ActionError('action=load 需要提供扩展目录的绝对路径 path（目录内须有 manifest.json）')
        assertToolRunning(callSignal(args))
        const entry = await manager.load(ses, dir)
        return {
          content: [
            text(
              `已装载扩展: [${entry.id}] ${entry.name} v${entry.version} (MV${entry.manifestVersion})\n路径: ${entry.path}\n` +
                '扩展对已打开的页面不会自动生效；请刷新目标标签页或重新导航后验证。'
            )
          ]
        }
      }
      if (action === 'remove') {
        const key = String(args['id'] ?? args['path'] ?? '').trim()
        if (!key) throw new ActionError('action=remove 需要提供扩展 id（action=list 可查）或路径 path')
        assertToolRunning(callSignal(args))
        const removed = manager.remove(ses, key)
        return { content: [text(`已卸载并移除: [${removed.id}] ${removed.name} v${removed.version}`)] }
      }
      throw new ActionError(`未知 action: ${action}。可用 action：list、load、remove。`)
    }
  })

  pushTool({
    name: 'browser_tabs',
    handler: async (args) => {
      approvals?.assertRunning()
      const action = String(args['action'] ?? 'list')
      if (action === 'list') {
        const info = browserInfo?.()
        const win = windowCtl.state?.()
        const header: string[] = []
        if (info) {
          const started = typeof info.startedAt === 'number' ? new Date(info.startedAt).toISOString() : ''
          header.push(
            `浏览器实例: ${info.instanceId ? info.instanceId.slice(0, 8) : 'unknown'} · PID ${info.pid}` +
              (info.version ? ` · v${info.version}` : '') +
              (started ? ` · 启动 ${started}` : '')
          )
        }
        if (win) {
          header.push(`窗口: ${win.minimized ? '最小化' : win.visible ? '可见' : '隐藏'} · ${win.focused ? '前台' : '后台'}`)
        }
        const lines = tabs.infos().map((t, i) => {
          const created = typeof t.createdAt === 'number' ? ` · 创建 ${new Date(t.createdAt).toISOString().slice(11, 19)}Z` : ''
          const owner = t.agentClientId === undefined ? '' : ` · Agent #${t.agentClientId}`
          return `${i + 1}. [${t.id}]${t.active ? ' ★活动' : ''}${t.isolated ? ' 🔒隔离' : ''}${t.restored ? ' ♻恢复' : ''}${owner} ${t.title}${created}\n   ${t.url}`
        })
        const body = lines.length ? `共 ${lines.length} 个标签页：\n${lines.join('\n')}` : '（无标签页）'
        return { content: [text(header.length ? `${header.join('\n')}\n${body}` : body)] }
      }
      if (action === 'new') {
        const url = String(args['url'] ?? '')
        const target = url ? normalizeUrl(url, getSettings?.().searchEngine || searchUrl, newtabUrl) : newtabUrl
        const isolated = typeof args['isolated'] === 'boolean' ? args['isolated'] : undefined
        const tab = tabs.createTab(target, true, isolated)
        const note = tab.isolated ? '（隔离会话，关闭时清除数据）' : '（共享会话）'
        return { content: [text(`已新建标签页: [${tab.id}] ${target} ${note}`)] }
      }
      if (action === 'select') {
        const id = String(args['tabId'] ?? '')
        const t = tabs.get(id)
        if (!t) throw new ActionError(`标签不存在: ${id}（用 action=list 查看）`)
        const bringToFront = args['bringToFront'] === true
        tabs.selectTab(id, bringToFront)
        if (bringToFront) {
          try {
            windowCtl.focus?.()
          } catch {
            /* 窗口可能正在销毁 */
          }
          try {
            t.view.webContents.focus()
          } catch {
            /* 页面可能正在导航 */
          }
        }
        let visibilityState = 'unknown'
        try {
          visibilityState = String(await t.view.webContents.executeJavaScript('String(document.visibilityState || "unknown")', false))
        } catch {
          /* 页面尚未就绪 */
        }
        const win = windowCtl.state?.()
        const focusNote = win && !win.focused && !bringToFront
          ? '\n（窗口当前不在前台；select 只切换标签，需要系统级焦点请传 bringToFront: true）'
          : ''
        return {
          content: [
            text(
              `已切换到: [${id}] ${t.title}\nwindowFocused: ${win?.focused === true}\nvisibilityState: ${visibilityState}${focusNote}`
            )
          ]
        }
      }
      if (action === 'close') {
        const id = String(args['tabId'] ?? '')
        const t = tabs.get(id)
        if (!t) throw new ActionError(`标签不存在: ${id}`)
        tabs.closeTab(id)
        return { content: [text(`已关闭: [${id}] ${t.title}`)] }
      }
      throw new ActionError(`未知 action: ${action}。可用 action：list、new、select、close。`)
    }
  })

  pushTool({
    name: 'browser_window',
    handler: async (args) => {
      const action = String(args['action'] ?? 'mode')
      if (action === 'mode') {
        if (args['mode'] !== undefined) {
          const mode = String(args['mode']) as BackgroundMode
          if (!['visible', 'background', 'minimized', 'hidden', 'background-visual'].includes(mode)) {
            throw new ActionError(`未知窗口模式: ${mode}`)
          }
          const applied = windowCtl.setMode?.(mode) ?? mode
          if (args['monitor'] === true || mode === 'background-visual') windowCtl.monitorStart?.(args['tabId'] as string | undefined)
          if (args['monitor'] === false) windowCtl.monitorStop?.()
          return { content: [text(`窗口模式: ${applied}\n监控: ${windowCtl.monitorState?.().enabled ? '已开启' : '未开启'}`)] }
        }
        const win = windowCtl.state?.()
        const monitor = windowCtl.monitorState?.()
        return { content: [text(`窗口模式: ${windowCtl.mode?.() ?? (win?.minimized ? 'minimized' : win?.visible ? 'visible' : 'hidden')}\n窗口: ${win?.minimized ? '最小化' : win?.visible ? '可见' : '隐藏'} · ${win?.focused ? '前台' : '后台'}\n监控: ${monitor?.enabled ? '已开启' : '未开启'}${monitor?.control === 'human' ? ' · 人工接管' : ''}`)] }
      }
      if (action === 'monitor') {
        if (args['monitor'] === false) {
          windowCtl.monitorStop?.()
          return { content: [text(`实时预览已停止。`)] }
        }
        const monitor = windowCtl.monitorStart?.(args['tabId'] as string | undefined)
        if (!monitor) throw new ActionError('实时预览服务未就绪')
        return { content: [text(`实时预览已开启，标签 [${monitor.tabId}]，画面由独立预览通道推送。`)] }
      }
      if (action === 'takeover') {
        const monitor = windowCtl.takeover?.()
        if (!monitor) throw new ActionError('人工接管服务未就绪')
        return { content: [text('已暂停 AI 输入并锁定操作权，请直接操作浏览器；完成后调用 browser_window action=release。')] }
      }
      if (action === 'release') {
        const monitor = windowCtl.releaseToAi?.()
        if (!monitor) throw new ActionError('人工接管服务未就绪')
        return { content: [text('已将操作权交还 AI；后续工具调用可以继续。')] }
      }
      throw new ActionError(`未知 action: ${action}。可用 action：mode、monitor、takeover、release。`)
    }
  })

  pushTool({
    name: 'browser_tasks',
    handler: async (args) => {
      const action = String(args['action'] ?? 'list')
      const clientId = Number.isSafeInteger(args['__aaClientId']) ? Number(args['__aaClientId']) : tabs.currentAgentClientId()
      const sessionId = typeof args['__aaClientSession'] === 'string' ? args['__aaClientSession'] : undefined
      const formatTask = (task: AgentTaskRecord): string => {
        const progress = typeof task.progress === 'number'
          ? ` · 进度 ${task.progress}${typeof task.total === 'number' ? `/${task.total}` : ''}`
          : ''
        const detail = task.error ? ` · 失败原因: ${task.error}` : task.message ? ` · ${task.message}` : ''
        const recovery = task.recovery
          ? ` · 恢复 ${task.recovery.resumable ? '可显式恢复' : '不可自动恢复'}${task.recovery.requiresConfirmation ? '（需确认）' : ''} [${task.recovery.reason}]`
          : typeof task.retryCount === 'number' && task.retryCount > 0
            ? ` · 恢复 ${task.retryCount} 次`
            : ''
        const source = task.source ? ` · 来源 ${task.source}` : ''
        const tab = task.tabId ? ` · 标签 ${task.tabId}` : ''
        const taskId = task.taskId ? ` · 任务 ${task.taskId}` : ''
        const sideEffect = task.sideEffect && task.sideEffect.risk !== 'none'
          ? ` · 副作用 ${task.sideEffect.risk}${task.sideEffect.destructive ? '(高危)' : ''}`
          : ''
        const lastStep = task.steps?.at(-1)
        const step = lastStep ? ` · 当前步骤 ${lastStep.label}${lastStep.status ? ` (${lastStep.status})` : ''}` : ''
        return `#${task.id} · 客户端 ${task.client} · ${task.tool} · ${task.status}${progress}${recovery}${source}${tab}${step}${sideEffect}${taskId}${detail}`
      }
      const formatDetail = (task: AgentTaskRecord): string => {
        const timestamp = (value?: number): string => value ? new Date(value).toISOString() : '—'
        const steps = (task.steps ?? []).slice(-50).map((step) => {
          const status = step.status ? ` [${step.status}]` : ''
          const detail = step.detail ? ` — ${step.detail}` : ''
          return `${timestamp(step.at)}${status} ${step.label}${detail}`
        })
        const recovery = task.recovery
          ? JSON.stringify({ ...task.recovery })
          : `{"automaticReplay":false,"resumable":false,"reason":"not_recorded"}`
        return [
          `任务 ${task.taskId ?? `#${task.id}`}`,
          `工具: ${task.tool}`,
          `状态: ${task.status}`,
          `客户端: ${task.client}${task.clientSession ? ` · 会话 ${task.clientSession}` : ''}`,
          `来源: ${task.source ?? 'unknown'}`,
          `标签: ${task.tabId ?? '—'}`,
          `开始: ${timestamp(task.startedAt)}`,
          `更新: ${timestamp(task.updatedAt)}`,
          `完成: ${timestamp(task.finishedAt)}`,
          `恢复次数: ${task.retryCount ?? 0}`,
          `恢复策略: ${recovery}`,
          `副作用: ${task.sideEffect ? JSON.stringify(task.sideEffect) : 'not_recorded'}`,
          `当前步骤: ${task.steps?.at(-1)?.label ?? '—'}`,
          ...(task.error ? [`错误: ${task.error}`] : []),
          `步骤 (${steps.length}):`,
          ...(steps.length ? steps : ['（无）'])
        ].join('\n')
      }
      if (action === 'list') {
        const activity = windowCtl.taskState?.(clientId, sessionId) ?? { active: false, paused: false, calls: [] }
        const limit = Math.max(1, Math.min(50, Math.floor(Number(args['limit']) || 20)))
        const tasks = activity.tasks?.slice(0, limit) ?? []
        const lines = tasks.length
          ? tasks.map(formatTask).join('\n')
          : (activity.calls ?? []).map((call) => `#${call.id} · 客户端 ${call.client} · ${call.tool} · running`).join('\n') || '（暂无任务记录）'
        return { content: [text(`任务状态: ${activity.paused ? '已暂停' : activity.active ? '运行中' : '空闲'}\n${lines}`)] }
      }
      if (action === 'get') {
        const taskId = String(args['taskId'] ?? '').trim()
        if (!taskId) throw new ActionError('get 需要提供 taskId；可先调用 browser_tasks action=list。')
        const task = windowCtl.taskDetail?.(taskId, clientId, sessionId)
        if (!task) throw new ActionError('任务不存在，或不属于当前 MCP 会话。')
        return { content: [text(formatDetail(task))] }
      }
      if (action === 'cancel') {
        const id = Number(args['id'])
        const requestedClient = args['client'] === undefined ? undefined : Number(args['client'])
        if (clientId !== undefined && requestedClient !== undefined && requestedClient !== clientId) {
          throw new ActionError('只能取消当前 MCP 客户端自己的任务。')
        }
        const client = clientId ?? requestedClient
        if (!windowCtl.cancelTask?.(id, client)) throw new ActionError('未找到唯一匹配的任务，请先调用 browser_tasks action=list。')
        return { content: [text(`已请求取消任务 #${id}${client === undefined ? '' : `（客户端 ${client}）`}`)] }
      }
      if (action === 'pause') {
        windowCtl.pauseTasks?.(clientId, Number.isSafeInteger(args['__aaCallId']) ? Number(args['__aaCallId']) : undefined)
        return { content: [text('当前 MCP 客户端的后台任务已暂停；在途任务已安全中断且不会自动重放，其它客户端不受影响。')] }
      }
      if (action === 'resume') {
        windowCtl.resumeTasks?.(clientId)
        return { content: [text('当前 MCP 客户端的后台任务已恢复。')] }
      }
      throw new ActionError(`未知 action: ${action}。可用 action：list、get、cancel、pause、resume。`)
    }
  })

  pushTool({
    name: 'browser_fill_form',
    handler: async (args) => {
      const signal = callSignal(args)
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const fields = Array.isArray(args['fields']) ? (args['fields'] as Record<string, unknown>[]) : []
      if (!fields.length) throw new ActionError('fields 不能为空')
      // 整张表单在一次标签页锁内完成：并发客户端不能在逐字段填写之间穿插其他操作。
      return onTab(tab, signal, async (): Promise<{ content: ToolContent[] }> => {
        assertRefContext(tab.view.webContents)
        const done: string[] = []
        for (const field of fields) {
          assertToolRunning(signal)
          const ref = String(field['ref'] ?? '')
          if (!ref) throw new ActionError('每个字段都必须提供 ref')
          if (typeof field['checked'] === 'boolean') {
            // 复选框/单选框：仅在状态不一致时点击，避免把已勾选的又取消
            const state = (await tab.view.webContents.executeJavaScript(checkedStateScript(ref), false)) as {
              ok: boolean
              checked?: boolean
              type?: string
            }
            assertToolRunning(signal)
            if (!state?.ok) throw new ActionError(`找不到元素 ${ref}；请刷新页面快照后重试。`)
            if (state.type !== 'checkbox' && state.type !== 'radio') {
              throw new ActionError(`元素 ${ref} 不是复选框/单选框（是 ${state.type || 'unknown'}）`)
            }
            if (state.checked !== field['checked']) {
              await doClick(tab, ref, false, { signal })
            }
            done.push(`${ref} = ${field['checked'] ? '已勾选' : '未勾选'}`)
            continue
          }
          if (field['label'] !== undefined || (field['value'] !== undefined && !field['submit'])) {
            // <select> 走下拉选择
            const probe = (await tab.view.webContents.executeJavaScript(tagNameScript(ref), false)) as string
            assertToolRunning(signal)
            if (probe === 'select') {
              const r = await doSelectOption(tab, ref, {
                value: field['value'] as string | undefined,
                label: field['label'] as string | undefined,
                wantSnapshot: false,
                signal
              })
              done.push(`${ref} → ${r.selected}`)
              continue
            }
          }
          const target = await inspectTypeTarget(tab, ref)
          assertToolRunning(signal)
          if (!target.ok) throw new ActionError(`找不到输入目标 ${ref}；请刷新页面快照后重试。`)
          if (target.sensitive) {
            await approveSensitiveType(tab, ref, target, signal)
            if (field['submit']) throw new ActionError('敏感字段由你在网页中输入；Agent 不会自动提交。')
            done.push(`${ref} ← [敏感字段请由你输入]`)
            continue
          }
          if (field['submit']) {
            await opGate(
              { site: siteOf(tab), tabTitle: tab.title, action: '提交表单/输入后回车' },
              signal
            )
            assertToolRunning(signal)
          }
          await doType(tab, ref, String(field['value'] ?? ''), {
            submit: !!field['submit'],
            wantSnapshot: false,
            signal
          })
          done.push(`${ref} ← [已填写]`)
        }
        assertToolRunning(signal)
        const want = args['snapshot'] !== false
        const snapshot = want ? await captureSnapshot(tab.view.webContents) : undefined
        return {
          content: [text(withSnap(`已填写 ${done.length} 个字段：\n${done.join('\n')}`, snapshot, want))]
        }
      })
    }
  })

  pushTool({
    name: 'browser_dialogs',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const list = await onTab(tab, callSignal(args), async () => {
        const records = await readDialogs(tab.view.webContents)
        assertToolRunning(callSignal(args))
        if (args['clear'] === true) await clearDialogs(tab.view.webContents)
        return records
      })
      if (!list.length) return { content: [text('（页面未弹出任何对话框）')] }
      const lines = list.map((d, i) => {
        const def = d.type === 'prompt' && d.defaultValue != null ? ` [默认值: ${d.defaultValue}]` : ''
        const answer = 'accepted' in d ? ` → 返回 ${String(d.accepted)}` : 'answered' in d ? ` → 返回 ${d.answered === null ? 'null' : JSON.stringify(d.answered)}` : ''
        return `${i + 1}. [${d.type}] ${d.message}${def}${answer}`
      })
      return {
        content: [
          text(
            `共 ${list.length} 条对话框记录（已拦截，未阻塞页面）：\n${lines.join('\n')}`
          )
        ]
      }
    }
  })

  pushTool({
    name: 'browser_dialog_respond',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const wc = tab.view.webContents
      if (args['reset'] === true) {
        await onTab(tab, callSignal(args), () => clearDialogPolicy(wc))
        return { content: [text('已清除对话框策略：confirm→false，prompt→null。')] }
      }
      const policy: { confirm?: boolean; prompt?: string; once?: boolean } = { once: args['once'] !== false }
      if (typeof args['confirm'] === 'boolean') policy.confirm = args['confirm']
      if (typeof args['prompt'] === 'string') policy.prompt = args['prompt']
      if (policy.confirm === undefined && policy.prompt === undefined) {
        throw new ActionError('至少提供 confirm、prompt 或 reset:true 之一')
      }
      const ready = await onTab(tab, callSignal(args), async () => {
        const ok = await setDialogPolicy(wc, policy)
        assertToolRunning(callSignal(args))
        return ok || (await dialogGuardReady(wc))
      })
      const parts: string[] = []
      if (policy.confirm !== undefined) parts.push(`confirm→${policy.confirm}`)
      if (policy.prompt !== undefined) parts.push(`prompt→${JSON.stringify(policy.prompt)}`)
      const scope = policy.once ? '下一次匹配的 confirm/prompt' : '之后每次匹配的 confirm/prompt'
      if (!ready) {
        return {
          content: [text(`已记录策略（${parts.join('，')}，作用于${scope}），但当前页面未安装对话框守卫；若点击后仍卡住，请先重新打开该页面再试。`)]
        }
      }
      return { content: [text(`已设置对话框策略：${parts.join('，')}（作用于${scope}）。现在可以点击会触发该对话框的按钮，再用 browser_dialogs 核对结果。`)] }
    }
  })

  pushTool({
    name: 'browser_evaluate',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const expression = String(args['expression'] ?? '')
      if (!expression.trim()) throw new ActionError('expression 不能为空')
      return onTab(tab, args['__aaSignal'], async (): Promise<{ content: ToolContent[] }> => {
        if (args['ref']) assertRefContext(tab.view.webContents)
        await opGate(
          {
            site: siteOf(tab),
            tabTitle: tab.title,
            action: '在网页中执行 JavaScript',
            detail: expression.replace(/\s+/g, ' ').slice(0, 120)
          },
          args['__aaSignal']
        )
        const ref = args['ref'] ? String(args['ref']) : ''
        // expression 是 browser_evaluate 的语义本身（在页面内求值的代码），刻意不转义；
        // 数据部分（ref 与错误文案）一律走白名单字面量，避免 ref 破坏注入脚本的结构。
        const refKey = ref ? refLiteral(ref) : ''
        const source = ref
          ? `(() => { const element = (window.__aaRefs || {})[${refKey}]; if (!element) return { __aaError: '找不到元素 ' + ${refKey} }; return (${expression}) })()`
          : `(() => { return (${expression}) })()`
        assertToolRunning(callSignal(args))
        let value: unknown
        try {
          value = await raceAbort(
            tab.view.webContents.executeJavaScript(source, false),
            args['__aaSignal'] instanceof AbortSignal ? args['__aaSignal'] : undefined
          )
        } catch (err) {
          throw new ActionError(`执行失败：${(err as Error).message}`)
        }
        if (value && typeof value === 'object' && '__aaError' in (value as Record<string, unknown>)) {
          throw new ActionError(String((value as Record<string, unknown>)['__aaError']))
        }
        let rendered: string | undefined
        const valueType = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value
        try {
          rendered = JSON.stringify(value, null, 2)
        } catch (err) {
          // 循环引用、BigInt 等无法直接 JSON 化：给出结构化诊断，而不是丢弃类型信息。
          let preview = ''
          try {
            preview = String(value).slice(0, 300)
          } catch {
            /* 极少数宿主对象连 String 都会抛错 */
          }
          rendered = JSON.stringify(
            {
              serializationError: {
                code: 'EVALUATE_RESULT_SERIALIZATION_FAILED',
                valueType,
                message: err instanceof Error ? err.message : String(err),
                preview
              }
            },
            null,
            2
          )
        }
        if (rendered === undefined) {
          let preview = ''
          try {
            preview = String(value).slice(0, 300)
          } catch {
            /* ignore */
          }
          rendered = JSON.stringify(
            { valueType, preview, note: '表达式结果无法直接序列化为 JSON（undefined / function / symbol）' },
            null,
            2
          )
        }
        const MAX = 20000
        if (rendered.length > MAX) rendered = rendered.slice(0, MAX) + '\n…（结果过长已截断）'
        return { content: [text(rendered)] }
      })
    }
  })

  pushTool({
    name: 'browser_assert',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const raw = Array.isArray(args['checks']) ? (args['checks'] as Record<string, unknown>[]) : []
      if (!raw.length) throw new ActionError('checks 不能为空')
      if (raw.length > 20) throw new ActionError('一次最多 20 条断言，请分批校验')
      const checks: AssertCheck[] = raw.map((item) => ({
        kind: String(item['kind'] ?? '') as AssertCheck['kind'],
        target: item['target'] === undefined ? undefined : String(item['target']),
        match: item['match'] === undefined ? undefined : (String(item['match']) as AssertCheck['match']),
        expected: item['expected'] as AssertCheck['expected'],
        message: item['message'] === undefined ? undefined : String(item['message']),
        attribute: item['attribute'] === undefined ? undefined : String(item['attribute']),
        level: item['level'] === undefined ? undefined : (String(item['level']) as AssertCheck['level']),
        since: typeof item['since'] === 'number' ? item['since'] : undefined,
        urlContains: item['urlContains'] === undefined ? undefined : String(item['urlContains']),
        method: item['method'] === undefined ? undefined : String(item['method']),
        status: typeof item['status'] === 'number' ? item['status'] : undefined,
        statusMin: typeof item['statusMin'] === 'number' ? item['statusMin'] : undefined,
        statusMax: typeof item['statusMax'] === 'number' ? item['statusMax'] : undefined
      }))
      const outcome = await onTab(tab, callSignal(args), () => runAssertions(tab, checks))
      const body = formatAssertions(outcome)
      return { content: [text(body)], ...(outcome.failed > 0 ? { isError: true } : {}) }
    }
  })

  pushTool({
    name: 'browser_frame',
    handler: async (args) => {
      const signal = callSignal(args)
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const wc = tab.view.webContents
      const action = String(args['action'] ?? '')
      if (action === 'list') {
        const frames = listFrames(wc)
        if (!frames.length) return { content: [text('（当前页面没有可访问的 frame）')] }
        const lines = frames.map((f) => {
          const indent = '  '.repeat(f.depth)
          const badge = f.depth === 0 ? '[主文档]' : f.crossOrigin ? '[跨域]' : '[同源]'
          const name = f.name ? ` name="${f.name}"` : ''
          return `${indent}[${f.id}] ${badge}${name} ${f.url || '(about:blank)'}`
        })
        return { content: [text(`共 ${frames.length} 个 frame：\n${lines.join('\n')}`)] }
      }
      const frameId = String(args['frameId'] ?? '')
      if (!frameId) throw new ActionError('缺少 frameId；先调用 action=list 查看可用 frame')
      // frame 内的读写与主文档操作同队列，避免并发客户端在 frame 操作之间穿插导航。
      return onTab(tab, signal, async (): Promise<{ content: ToolContent[] }> => {
        try {
          if (action === 'text') {
            const r = await frameText(wc, frameId, typeof args['maxChars'] === 'number' ? args['maxChars'] : 4000)
            if (!r.text) return { content: [text(`[${frameId}] 内没有可见文本（${r.url}）`)] }
            return { content: [text(`[${frameId}] ${r.url}\n${r.text}${r.truncated ? '\n…（文本已截断）' : ''}`)] }
          }
          if (action === 'elements') {
            const items = await frameElements(wc, frameId, typeof args['limit'] === 'number' ? args['limit'] : 80)
            if (!items.length) return { content: [text(`[${frameId}] 内没有可见的可交互元素`) ] }
            const lines = items.map((item, i) => `${i + 1}. ${item.description}\n   选择器: ${item.selector}`)
            return { content: [text(`[${frameId}] 共 ${items.length} 个可交互元素：\n${lines.join('\n')}`)] }
          }
          if (action === 'evaluate') {
            const expression = String(args['expression'] ?? '')
            if (!expression.trim()) throw new ActionError('expression 不能为空')
            await opGate(
              { site: siteOf(tab), tabTitle: tab.title, action: '在网页中执行 JavaScript', detail: `frame ${frameId} · ${expression.replace(/\s+/g, ' ').slice(0, 120)}` },
              signal
            )
            assertToolRunning(signal)
            const value = await raceAbort(frameEvaluate(wc, frameId, expression, signal), signal)
            let rendered: string
            try {
              rendered = JSON.stringify(value, null, 2)
            } catch {
              rendered = String(value)
            }
            if (rendered === undefined) rendered = String(value)
            const MAX = 20000
            if (rendered.length > MAX) rendered = rendered.slice(0, MAX) + '\n…（结果过长已截断）'
            return { content: [text(rendered)] }
          }
          const selector = String(args['selector'] ?? '')
          if (!selector) throw new ActionError(`${action} 需要提供 selector`)
          if (action === 'click') {
            const r = await frameClick(wc, frameId, selector, typeof args['index'] === 'number' ? args['index'] : 0, signal)
            return { content: [text(`已在 [${frameId}] 内点击: ${r.clicked}`)] }
          }
          if (action === 'type') {
            const target = await inspectFrameTypeTarget(wc, frameId, selector, signal)
            assertToolRunning(signal)
            if (!target.ok) throw new ActionError(`在 ${frameId} 内找不到输入元素: ${selector}`)
            if (target.sensitive) {
              await approveSensitiveFrameType(tab, frameId, selector, signal)
              return { content: [text('已允许继续。敏感字段内容由你在网页中输入；Agent 提供的文本未写入、读取或回传。请继续后续步骤。')] }
            }
            await frameType(wc, frameId, selector, String(args['text'] ?? ''), signal)
            return { content: [text(`已在 [${frameId}] 内输入（内容未记录）。`)] }
          }
          if (action === 'select') {
            const r = await frameSelect(wc, frameId, selector, {
              value: args['value'] === undefined ? undefined : String(args['value']),
              label: args['label'] === undefined ? undefined : String(args['label'])
            }, signal)
            return { content: [text(`已在 [${frameId}] 内选择: ${r.selected}`)] }
          }
          throw new ActionError(`未知 action: ${action}`)
        } catch (error) {
          if (signal) throwIfAborted(signal)
          throw error instanceof ActionError ? error : new ActionError((error as Error).message)
        }
      })
    }
  })

  /* ── v0.7.0 新增：视觉评审闭环 ── */

  pushTool({
    name: 'browser_visual_diff',
    handler: async (args) => {
      const action = String(args['action'] ?? '')
      if (action === 'list') {
        const list = visualList()
        if (!list.length) return { content: [text('（暂无视觉基线；先用 action=save 保存一条）')] }
        const lines = list.map(
          (b) => `[${b.name}] ${b.width}×${b.height}${b.fullPage ? ' 整页' : ''} · ${b.bytes}B · ${new Date(b.createdAt).toISOString()}\n    ${b.url}\n    ${b.file}`
        )
        return { content: [text(`共 ${list.length} 条视觉基线：\n${lines.join('\n')}`)] }
      }
      const name = String(args['name'] ?? '')
      if (!name) throw new ActionError('save / compare / delete 需要提供 name')
      if (action === 'delete') {
        const removed = visualDelete(name)
        if (!removed) throw new ActionError(`找不到基线 ${name}（用 action=list 查看）`)
        return { content: [text(`已删除视觉基线 ${name}`)] }
      }
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const fullPage = args['fullPage'] === true
      if (action === 'save') {
        const meta = await onTab(tab, callSignal(args), () => visualSave(tab, name, { fullPage }))
        return { content: [text(`已保存视觉基线 [${name}]：${meta.width}×${meta.height}${fullPage ? '（整页）' : ''}\n页面: ${meta.url}\n文件: ${meta.file}\n\n之后用 action=compare 对比当前页面。`)] }
      }
      if (action === 'compare') {
        const r = await onTab(tab, callSignal(args), () => visualCompare(tab, name, {
          fullPage,
          pixelThreshold: typeof args['pixelThreshold'] === 'number' ? args['pixelThreshold'] : undefined,
          maxDiffPercent: typeof args['maxDiffPercent'] === 'number' ? args['maxDiffPercent'] : undefined,
          writeDiff: args['writeDiff'] !== false
        }))
        return { content: [text(formatDiff(r))], ...(r.ok ? {} : { isError: true }) }
      }
      throw new ActionError(`未知 action: ${action}（支持 save/compare/list/delete）`)
    }
  })

  pushTool({
    name: 'browser_contrast_audit',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const level = (args['level'] === 'AAA' ? 'AAA' : 'AA') as 'AA' | 'AAA'
      const report = await onTab(tab, callSignal(args), () => auditContrast(tab, {
        level,
        maxResults: typeof args['maxResults'] === 'number' ? args['maxResults'] : undefined,
        signal: callSignal(args)
      }))
      const ok = report.violations.length === 0
      const failOnViolation = args['failOnViolation'] !== false
      return { content: [text(formatContrast(report, ok))], ...(failOnViolation && !ok ? { isError: true } : {}) }
    }
  })

  pushTool({
    name: 'browser_viewport_matrix',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      let specs: ViewportSpec[]
      if (Array.isArray(args['viewports']) && (args['viewports'] as unknown[]).length) {
        specs = (args['viewports'] as Record<string, unknown>[]).map((v) => ({
          name: v['name'] === undefined ? undefined : String(v['name']),
          width: Number(v['width']),
          height: Number(v['height']),
          deviceScaleFactor: typeof v['deviceScaleFactor'] === 'number' ? v['deviceScaleFactor'] : undefined,
          mobile: v['mobile'] === true
        }))
      } else {
        const preset = String(args['preset'] ?? 'all')
        specs = VIEWPORT_PRESETS[preset] ?? VIEWPORT_PRESETS['all'] ?? []
      }
      const results = await onTab(tab, callSignal(args), () => captureViewportMatrix(tab, specs, {
        signal: callSignal(args),
        isMinimized: () => windowCtl.state?.().minimized === true
      }))
      const content: import('@shared/types').ToolContent[] = [text(formatViewportMatrix(results))]
      if (args['includeImages'] === true) {
        try {
          const fs = await import('node:fs')
          for (const r of results.slice(0, 4)) {
            content.push({ type: 'image', data: fs.readFileSync(r.file).toString('base64'), mimeType: 'image/png' })
          }
        } catch {
          /* 图片是可选增强；文件已保存，文本里仍给出路径 */
        }
      }
      return { content }
    }
  })

  pushTool({
    name: 'browser_evidence',
    handler: async (args) => {
      const ev = getEvidenceManager()
      const action = String(args['action'] ?? 'list')
      if (action === 'sweep') {
        const r = ev.sweep()
        return {
          content: [
            text(
              `证据清理完成：删除 ${r.removed.length} 个文件，释放 ${(r.bytesFreed / 1024).toFixed(1)}KB，保留 ${r.kept} 条登记。\n` +
                (r.removed.length ? r.removed.join('\n') : '（无需清理）')
            )
          ]
        }
      }
      if (action === 'hash' || action === 'forget') {
        const file = String(args['file'] ?? '')
        if (!file) throw new ActionError(`${action} 需要提供 file`)
        if (action === 'hash') {
          const hash = ev.hash(file)
          return { content: [text(`sha256: ${hash}\n文件: ${file}`)] }
        }
        const removed = ev.forget(file)
        if (!removed) throw new ActionError(`登记表中没有该文件: ${file}`)
        return { content: [text(`已从证据登记表移除（文件本身未删除）: ${file}`)] }
      }
      if (action !== 'list') throw new ActionError(`未知 action: ${action}（支持 list/sweep/hash/forget）`)
      const limit = Math.min(500, Math.max(1, (args['limit'] as number) ?? 50))
      const entries = ev.list(limit)
      if (!entries.length) return { content: [text('（暂无证据登记；生成截图 / HAR / PDF / 基线后会自动登记）')] }
      const lines = entries.map(
        (e) =>
          `[${e.kind}] ${e.bytes}B · ${e.hash.slice(0, 16)}… · ${e.ttlMs ? `TTL ${Math.round(e.ttlMs / 86400000)}d` : '保留'}\n    ${e.file}`
      )
      return { content: [text(`共 ${entries.length} 条证据登记：\n${lines.join('\n')}`)] }
    }
  })

  // Interrupt is a central admission gate: no MCP operation starts while paused.
  // Individual handlers retain their own checks around multi-step actions.
  const canControlPaused = (toolName: string, args: Record<string, unknown>): boolean =>
    (toolName === 'browser_window' && args['action'] === 'release') ||
    (toolName === 'browser_tasks' && ['list', 'get', 'cancel', 'resume'].includes(String(args['action'] ?? 'list')))
  return tools.map((tool) => {
    const annotations = TOOL_ANNOTATIONS[tool.name]
    if (!annotations) throw new Error(`工具缺少 MCP annotations：${tool.name}`)
    return {
      ...tool,
      annotations,
      handler: async (args: Record<string, unknown>) => {
        if (!canControlPaused(tool.name, args)) approvals?.assertRunning()
        const startTime = Date.now()
        const signal = callSignal(args)
        try {
          if (signal) throwIfAborted(signal)
          const result = await tool.handler(args)
          if (!canControlPaused(tool.name, args)) assertToolRunning(signal)
          let summary = ''
          const first = result.content?.[0]
          if (first?.type === 'text' && first.text) {
            summary = first.text.split('\n')[0].slice(0, 100)
          } else if (first?.type === 'image') {
            summary = '已捕获截图'
          }
          onAction?.({
            id: Math.random().toString(36).slice(2, 9),
            tool: tool.name,
            summary: summary || `${tool.title || tool.name} 成功 (${Date.now() - startTime}ms)`,
            ts: Date.now(),
            isError: !!result.isError
          })
          return result
        } catch (err) {
          onAction?.({
            id: Math.random().toString(36).slice(2, 9),
            tool: tool.name,
            summary: `错误: ${err instanceof Error ? err.message : String(err)}`,
            ts: Date.now(),
            isError: true
          })
          throw err
        }
      }
    }
  })
}
