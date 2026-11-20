import type { ToolContent } from '@shared/types'
import { TOOL_DEFS, TOOL_ANNOTATIONS } from '@shared/tool-defs.mjs'
export { TOOL_ANNOTATIONS }
import { checkedStateScript, fingerprintScript, refLiteral, tagNameScript } from '@snapshot/scripts'
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
  inspectTypeTarget
} from './actions'
import type { ApprovalManager } from './approvals'
import { readDialogs, clearDialogs, setDialogPolicy, clearDialogPolicy, dialogGuardReady } from './dialogs'
import { runAssertions, formatAssertions, type AssertCheck } from './assertions'
import { listFrames, frameText, frameElements, frameEvaluate, frameClick, frameType, frameSelect } from './frames'
import { visualSave, visualCompare, visualList, visualDelete, formatDiff } from './visual'
import { getEvidenceManager } from './evidence'
import { auditContrast, formatContrast } from './contrast'
import { captureViewportMatrix, VIEWPORT_PRESETS, formatViewportMatrix, type ViewportSpec } from './viewport'
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
  doExtract,
  doWaitForText,
  doWaitForCondition,
  doWaitForDom,
  doPressKey,
  doScreenshot,
  doConsoleLogs,
  raceAbort,
  resolveWebContents
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

export function buildTools(
  tabs: TabManager,
  newtabUrl: string,
  searchUrl: string,
  windowCtl: { resize: (w: number, h: number) => Promise<{ width: number; height: number }> },
  downloads: DownloadTracker,
  approvals?: ApprovalManager,
  onAction?: (item: import('@shared/types').ActionLogItem) => void,
  getSettings?: () => { requireOperationApproval: boolean; fullSnapshot?: boolean; searchEngine?: string }
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

  pushTool({
    name: 'browser_navigate',
    handler: async (args) => {
      approvals?.assertRunning()
      const url = String(args['url'] ?? '')
      if (!url) throw new ActionError('url 不能为空')
      const target = normalizeUrl(url, getSettings?.().searchEngine || searchUrl, newtabUrl)
      const r = await doNavigate(tabs, target, {
        newTab: !!args['newTab'],
        tabId: args['tabId'] as string | undefined,
        signal: args['__aaSignal'] instanceof AbortSignal ? args['__aaSignal'] : undefined
      })
      let body = `已导航: ${r.url}\ntitle: ${r.title}`
      if (args['snapshot'] !== false) {
        const tab = tabs.get(r.tabId)
        if (tab) {
          try {
            const snap = await captureSnapshot(tab.view.webContents)
            body += '\n\n' + snapshotText(snap)
          } catch {
            body += '\n\n（快照获取失败：页面可能仍在跳转，请单独调用 browser_snapshot）'
          }
        }
      }
      return { content: [text(body)] }
    }
  })

  pushTool({
    name: 'browser_reload',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const want = args['snapshot'] !== false
      const r = await doReload(tab, args['hard'] === true, args['__aaSignal'] instanceof AbortSignal ? args['__aaSignal'] : undefined)
      let body = `已刷新: ${r.url}\ntitle: ${r.title}`
      if (want) {
        try {
          body += '\n\n' + snapshotText(await captureSnapshot(tab.view.webContents))
        } catch {
          body += '\n\n（刷新完成但快照获取失败，请单独调用 browser_snapshot）'
        }
      }
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
      const snap = await captureSnapshot(tab.view.webContents, {
        ...(forceFull ? { mode: 'full' as const } : {}),
        ...(maxNodes !== undefined ? { maxNodes } : {}),
        ...(cursor !== undefined ? { cursor } : {})
      })
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
      const r = await doClick(tab, String(args['ref']), want, { button, clickCount })
      return { content: [text(withSnap(`已点击: ${r.clicked}`, r.snapshot, want))] }
    }
  })

  pushTool({
    name: 'browser_drag',
    handler: async (args) => {
      approvals?.assertRunning()
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const want = args['snapshot'] !== false
      const r = await doDrag(tab, String(args['ref']), {
        toRef: args['toRef'] as string | undefined,
        dx: args['dx'] as number | undefined,
        dy: args['dy'] as number | undefined,
        wantSnapshot: want,
        signal: args['__aaSignal'] instanceof AbortSignal ? args['__aaSignal'] : undefined
      })
      return { content: [text(withSnap(`已拖拽: ${r.dragged}`, r.snapshot, want))] }
    }
  })

  pushTool({
    name: 'browser_type',
    handler: async (args) => {
      approvals?.assertRunning()
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const ref = String(args['ref'])
      const target = await inspectTypeTarget(tab, ref)
      if (!target.ok) throw new ActionError(`找不到输入目标 ${ref}；请刷新页面快照后重试。`)
      if (target.sensitive) {
        if (tabs.activeId !== tab.id) throw new ActionError('敏感输入审批仅支持当前活动标签；请切换到目标标签后重试。')
        // Never write or retain an agent-supplied secret. Let the user type directly into the focused page field.
        const wc = tab.view.webContents
        const originalUrl = wc.getURL()
        const originalFrame = await wc.executeJavaScript(fingerprintScript(ref), false) as { fingerprint?: string; rect?: number[] } | null
        if (!originalFrame) throw new ActionError('敏感输入目标已失效；请刷新快照后重试。')
        const url = new URL(originalUrl)
        const signal = args['__aaSignal'] instanceof AbortSignal ? args['__aaSignal'] : undefined
        const allowed = approvals ? await approvals.request({ site: url.host || url.protocol, tabTitle: tab.title, fieldLabel: target.label || '敏感输入框' }, signal) : false
        if (!allowed) throw new ActionError('敏感输入已取消或超时；Agent 提供的文本未写入。')
        if (wc.isDestroyed() || wc.getURL() !== originalUrl || tabs.activeId !== tab.id) throw new ActionError('页面或活动标签在等待确认期间已变化；请重新获取快照后再继续。')
        const rechecked = await inspectTypeTarget(tab, ref)
        if (!rechecked.ok || !rechecked.sensitive || rechecked.fingerprint !== originalFrame.fingerprint) throw new ActionError('敏感输入目标已变化；请重新获取快照后再继续。')
        if (args['submit']) throw new ActionError('敏感字段已填写，但 Agent 不会自动提交；请由你在网页中亲自确认提交。')
        return { content: [text('已允许继续。敏感字段内容由你在网页中输入；Agent 提供的文本未写入、读取或回传。请继续后续步骤。')] }
      }
      if (args['submit']) {
        await opGate(
          { site: new URL(tab.view.webContents.getURL()).host || tab.view.webContents.getURL(), tabTitle: tab.title, action: '提交表单/输入后回车' },
          args['__aaSignal']
        )
      }
      const want = args['snapshot'] !== false
      const r = await doType(tab, ref, String(args['text'] ?? ''), {
        submit: !!args['submit'],
        clear: !!args['clear'],
        wantSnapshot: want
      })
      return { content: [text(withSnap(`已输入: ${r.typed}`, r.snapshot, want))] }
    }
  })

  pushTool({
    name: 'browser_select_option',
    handler: async (args) => {
      approvals?.assertRunning()
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const want = args['snapshot'] !== false
      const r = await doSelectOption(tab, String(args['ref']), {
        value: args['value'] as string | undefined,
        label: args['label'] as string | undefined,
        wantSnapshot: want
      })
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
      const r = await doScroll(tab, dir, amount, want)
      return { content: [text(withSnap(`已滚动: ${dir} ${amount}px（作用区域: ${r.where}）`, r.snapshot, want))] }
    }
  })

  pushTool({
    name: 'browser_extract',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const r = await doExtract(tab, args['ref'] as string | undefined)
      const head = r.title ? `title: ${r.title}\n\n` : ''
      return { content: [text(head + r.text)] }
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
        await new Promise((r) => setTimeout(r, fixed))
        return { content: [text(`已等待 ${fixed}ms`)] }
      }
      const timeoutMs = typeof args['timeoutMs'] === 'number' ? args['timeoutMs'] : 10000
      const wants: string[] = []
      if (wantText) wants.push(`"${args['text']}" 出现`)
      if (wantGone) wants.push(`"${args['textGone']}" 消失`)
      if (wantSelector) wants.push(`${args['selector']} 出现`)
      if (wantSelectorGone) wants.push(`${args['selectorGone']} 消失`)
      if (wantUrl) wants.push(`URL 含 "${args['urlContains']}"`)
      if (wantText || wantGone) {
        const r = await doWaitForCondition(tab, {
          text: wantText ? String(args['text']) : undefined,
          textGone: wantGone ? String(args['textGone']) : undefined,
          timeoutMs,
          signal: args['__aaSignal'] instanceof AbortSignal ? args['__aaSignal'] : undefined
        })
        if (r.found) {
          const what = r.which === 'gone' ? `"${args['textGone']}" 已消失` : `"${args['text']}" 已出现`
          return { content: [text(`${what}（等待 ${r.elapsedMs}ms）`)] }
        }
        if (!wantSelector && !wantSelectorGone && !wantUrl) {
          return {
            content: [text(`超时 ${r.elapsedMs}ms，未等到 ${wants.join(' 或 ')}。可调用 browser_snapshot 查看当前页面。`)],
            isError: true
          }
        }
      }
      const dom = await doWaitForDom(tab, {
        selector: wantSelector ? String(args['selector']) : undefined,
        selectorGone: wantSelectorGone ? String(args['selectorGone']) : undefined,
        urlContains: wantUrl ? String(args['urlContains']) : undefined,
        timeoutMs,
        signal: args['__aaSignal'] instanceof AbortSignal ? args['__aaSignal'] : undefined
      })
      if (!dom.found) {
        return {
          content: [text(`超时 ${dom.elapsedMs}ms，未等到 ${wants.join(' 或 ')}。可调用 browser_snapshot 查看当前页面。`)],
          isError: true
        }
      }
      const label =
        dom.which === 'selector'
          ? `${args['selector']} 已出现`
          : dom.which === 'selectorGone'
            ? `${args['selectorGone']} 已消失`
            : `URL 已包含 "${args['urlContains']}"`
      return { content: [text(`${label}（等待 ${dom.elapsedMs}ms）`)] }
    }
  })

  pushTool({
    name: 'browser_press_key',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const r = await doPressKey(tab, String(args['key'] ?? ''), Array.isArray(args['modifiers']) ? args['modifiers'].map(String) : [])
      const suffix = r.modifiers.length ? ` + ${r.modifiers.join('+')}` : ''
      return { content: [text(`已按下: ${r.pressed}${suffix}`)] }
    }
  })

  pushTool({
    name: 'browser_screenshot',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const signal = args['__aaSignal'] instanceof AbortSignal ? args['__aaSignal'] : undefined
      const image = args['ref']
        ? await doElementScreenshot(tab, String(args['ref']))
        : await doScreenshot(tab, signal, { fullPage: args['fullPage'] === true })
      const { app } = await import('electron')
        const dir = process.env['AA_BROWSER_SCREENSHOT_DIR'] || `${app.getPath('home')}/.aabrowser/screenshots`
      try {
        const fs = await import('node:fs')
        const path = await import('node:path')
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
      const r = await doHover(tab, String(args['ref']))
      return { content: [text(`已悬停: ${r.hovered}`)] }
    }
  })

  pushTool({
    name: 'browser_navigate_back',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const want = args['snapshot'] !== false
      const r = await doNavigateHistory(tab, 'back', want, (t) => tabs.goBack(t), (t) => tabs.canBack(t))
      return { content: [text(withSnap('已后退', r.snapshot, want))] }
    }
  })

  pushTool({
    name: 'browser_navigate_forward',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const want = args['snapshot'] !== false
      const r = await doNavigateHistory(tab, 'forward', want, (t) => tabs.goForward(t), (t) => tabs.canForward(t))
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
      const r = await doGetSelector(tab, String(args['ref']))
      const badge = r.verified ? '✅ 已回验' : '⚠️ 未能回验（元素可能在 iframe 内或动态生成）'
      return { content: [text(`${badge}\nselector: ${r.selector}\n元素文本: ${r.text || '（无）'}`)] }
    }
  })

  pushTool({
    name: 'browser_find',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const r = await doFind(tab, String(args['text'] ?? ''))
      return {
        content: [text(`页面共 ${r.matches} 处匹配"${args['text']}"，已高亮并定位到第 ${r.activeOrdinal ?? 1} 处`)]
      }
    }
  })

  /* ── v0.4.0 新增：状态与数据 ── */

  pushTool({
    name: 'browser_cookies',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const action = String(args['action'])
      if (action === 'set' || action === 'clear') {
        await opGate(
          {
            site: siteOf(tab),
            tabTitle: tab.title,
            action: action === 'set' ? '写入 Cookie（会改变登录态）' : '清除 Cookie（可能导致登出）',
            detail: `域名: ${String(args['domain'] ?? args['url'] ?? '全部')} · 名称: ${String(args['name'] ?? '全部')}`
          },
          args['__aaSignal']
        )
      }
      const r = await doCookies(tab, {
        action: action as 'get' | 'set' | 'clear',
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
      const r = await doStorage(tab, {
        action: action as 'get' | 'set' | 'remove' | 'clear',
        kind: (args['kind'] as 'local' | 'session') ?? 'local',
        key: args['key'] as string | undefined,
        value: args['value'] as string | undefined
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
        const r = downloads.retry(id)
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
      const r = await doPdf(tab, args['path'] as string | undefined, !!args['landscape'])
      return { content: [text(`PDF 已保存: ${r.savedPath}`)] }
    }
  })

  pushTool({
    name: 'browser_upload_file',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const paths = (args['paths'] as unknown[]).map(String)
      if (!paths.length) throw new ActionError('paths 不能为空')
      await opGate(
        {
          site: siteOf(tab),
          tabTitle: tab.title,
          action: '把本机文件上传到网页',
          detail: paths.map((p) => p.slice(-90)).join('、')
        },
        args['__aaSignal']
      )
      const r = await doUploadFile(tab, String(args['ref']), paths)
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
      if (wc.isDestroyed()) throw new ActionError('页面已关闭')
      const limit = Math.min(20, Math.max(1, Math.floor(Number(args['slowest'] ?? 5)) || 5))
      const summary = (await wc.executeJavaScript(PERFORMANCE_SCRIPT, true)) as PerformanceSummary
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
          `${(e.size / 1024).toFixed(1)}KB ${e.durationMs != null ? e.durationMs + 'ms' : '…'} ` +
          `${e.error ? 'ERROR:' + e.error : ''} ${safeNetworkUrl(e.url).slice(0, 160)}`
      )
      return { content: [text(`共 ${list.length} 条（显示最近 ${shown.length} 条）：\n${lines.join('\n')}`)] }
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
        `类型: ${entry.resourceType} | 大小: ${(entry.size / 1024).toFixed(1)}KB | 耗时: ${entry.durationMs ?? '…'}ms`,
        '',
        '请求头:',
        ...Object.entries(safeNetworkHeaders(entry.requestHeaders, includeSensitive)).map(([k, v]) => `  ${k}: ${v}`),
        '',
        '响应头:',
        ...Object.entries(safeNetworkHeaders(entry.responseHeaders, includeSensitive)).map(([k, v]) => `  ${k}: ${v}`)
      ]
      if (args['body'] === true) {
        const body = await tab.net.getResponseBody(entry.requestId)
        parts.push('', '响应体:', clipBody(body, entry.mimeType))
      }
      return { content: [text(parts.join('\n'))] }
    }
  })

  pushTool({
    name: 'browser_har',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const includeSensitive = args['includeSensitive'] === true
      if (includeSensitive) {
        await opGate({
          site: tab.url,
          tabTitle: tab.title,
          action: '导出敏感网络数据',
          detail: '将把认证头、凭据参数或其他可能包含秘密的网络数据写入本地 HAR 文件。'
        }, args['__aaSignal'])
      }
      await tab.net.ensure()
      const { app } = await import('electron')
      const fs = await import('node:fs')
      const path = await import('node:path')
      const os = await import('node:os')
      const file =
        (args['path'] as string | undefined) ||
        path.join(os.homedir(), '.aabrowser', 'har', `aa-${Date.now()}.har`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(file, JSON.stringify(tab.net.toHar(app.getVersion(), includeSensitive), null, 2), 'utf-8')
        getEvidenceManager().record(file, 'har')
      return { content: [text(`HAR 已导出: ${file}\n共 ${fs.statSync(file).size} 字节`)] }
    }
  })

  /* ── v0.6.0 新增：请求拦截与 Mock ── */

  pushTool({
    name: 'browser_mock_requests',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
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
    }
  })

  pushTool({
    name: 'browser_tabs',
    handler: async (args) => {
      approvals?.assertRunning()
      const action = String(args['action'] ?? 'list')
      if (action === 'list') {
        const lines = tabs.infos().map(
          (t, i) =>
            `${i + 1}. [${t.id}]${t.active ? ' ★活动' : ''}${t.isolated ? ' 🔒隔离' : ''} ${t.title}\n   ${t.url}`
        )
        return { content: [text(lines.length ? `共 ${lines.length} 个标签页：\n${lines.join('\n')}` : '（无标签页）')] }
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
        if (!tabs.get(id)) throw new ActionError(`标签不存在: ${id}（用 action=list 查看）`)
        tabs.selectTab(id)
        const t = tabs.get(id)
        return { content: [text(`已切换到: [${id}] ${t?.title ?? ''}`)] }
      }
      if (action === 'close') {
        const id = String(args['tabId'] ?? '')
        const t = tabs.get(id)
        if (!t) throw new ActionError(`标签不存在: ${id}`)
        tabs.closeTab(id)
        return { content: [text(`已关闭: [${id}] ${t.title}`)] }
      }
      throw new ActionError(`未知 action: ${action}`)
    }
  })

pushTool({
    name: 'browser_fill_form',
    handler: async (args) => {
      approvals?.assertRunning()
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const fields = Array.isArray(args['fields']) ? (args['fields'] as Record<string, unknown>[]) : []
      if (!fields.length) throw new ActionError('fields 不能为空')
      const done: string[] = []
      for (const field of fields) {
        approvals?.assertRunning()
        const ref = String(field['ref'] ?? '')
        if (!ref) throw new ActionError('每个字段都必须提供 ref')
        if (typeof field['checked'] === 'boolean') {
          // 复选框/单选框：仅在状态不一致时点击，避免把已勾选的又取消
          const state = (await tab.view.webContents.executeJavaScript(checkedStateScript(ref), false)) as {
            ok: boolean
            checked?: boolean
            type?: string
          }
          if (!state?.ok) throw new ActionError(`找不到元素 ${ref}；请刷新页面快照后重试。`)
          if (state.type !== 'checkbox' && state.type !== 'radio') {
            throw new ActionError(`元素 ${ref} 不是复选框/单选框（是 ${state.type || 'unknown'}）`)
          }
          if (state.checked !== field['checked']) {
            await doClick(tab, ref, false)
          }
          done.push(`${ref} = ${field['checked'] ? '已勾选' : '未勾选'}`)
          continue
        }
        if (field['label'] !== undefined || (field['value'] !== undefined && !field['submit'])) {
          // <select> 走下拉选择
          const probe = (await tab.view.webContents.executeJavaScript(tagNameScript(ref), false)) as string
          if (probe === 'select') {
            const r = await doSelectOption(tab, ref, {
              value: field['value'] as string | undefined,
              label: field['label'] as string | undefined,
              wantSnapshot: false
            })
            done.push(`${ref} → ${r.selected}`)
            continue
          }
        }
        const r = await doType(tab, ref, String(field['value'] ?? ''), {
          submit: !!field['submit'],
          wantSnapshot: false
        })
        done.push(`${ref} ← ${String(field['value'] ?? '').slice(0, 40)}`)
      }
      const want = args['snapshot'] !== false
      const snapshot = want ? await captureSnapshot(tab.view.webContents) : undefined
      return {
        content: [text(withSnap(`已填写 ${done.length} 个字段：\n${done.join('\n')}`, snapshot, want))]
      }
    }
  })

  pushTool({
    name: 'browser_dialogs',
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const list = await readDialogs(tab.view.webContents)
      if (args['clear'] === true) await clearDialogs(tab.view.webContents)
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
        await clearDialogPolicy(wc)
        return { content: [text('已清除对话框策略：confirm→false，prompt→null。')] }
      }
      const policy: { confirm?: boolean; prompt?: string; once?: boolean } = { once: args['once'] !== false }
      if (typeof args['confirm'] === 'boolean') policy.confirm = args['confirm']
      if (typeof args['prompt'] === 'string') policy.prompt = args['prompt']
      if (policy.confirm === undefined && policy.prompt === undefined) {
        throw new ActionError('至少提供 confirm、prompt 或 reset:true 之一')
      }
      const ok = await setDialogPolicy(wc, policy)
      const ready = ok || (await dialogGuardReady(wc))
      const parts: string[] = []
      if (policy.confirm !== undefined) parts.push(`confirm→${policy.confirm}`)
      if (policy.prompt !== undefined) parts.push(`prompt→${JSON.stringify(policy.prompt)}`)
      const scope = policy.once ? '下一次对话框' : '之后每次对话框'
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
      const outcome = await runAssertions(tab, checks)
      const body = formatAssertions(outcome)
      return { content: [text(body)], ...(outcome.failed > 0 ? { isError: true } : {}) }
    }
  })

  pushTool({
    name: 'browser_frame',
    handler: async (args) => {
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
          const value = await raceAbort(
            frameEvaluate(wc, frameId, expression),
            args['__aaSignal'] instanceof AbortSignal ? args['__aaSignal'] : undefined
          )
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
          const r = await frameClick(wc, frameId, selector, typeof args['index'] === 'number' ? args['index'] : 0)
          return { content: [text(`已在 [${frameId}] 内点击: ${r.clicked}`)] }
        }
        if (action === 'type') {
          const r = await frameType(wc, frameId, selector, String(args['text'] ?? ''))
          return { content: [text(`已在 [${frameId}] 内输入: ${r.typed} = ${JSON.stringify(String(args['text'] ?? ''))}`)] }
        }
        if (action === 'select') {
          const r = await frameSelect(wc, frameId, selector, {
            value: args['value'] === undefined ? undefined : String(args['value']),
            label: args['label'] === undefined ? undefined : String(args['label'])
          })
          return { content: [text(`已在 [${frameId}] 内选择: ${r.selected}`)] }
        }
        throw new ActionError(`未知 action: ${action}`)
      } catch (error) {
        throw error instanceof ActionError ? error : new ActionError((error as Error).message)
      }
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
        const meta = await visualSave(tab, name, { fullPage })
        return { content: [text(`已保存视觉基线 [${name}]：${meta.width}×${meta.height}${fullPage ? '（整页）' : ''}\n页面: ${meta.url}\n文件: ${meta.file}\n\n之后用 action=compare 对比当前页面。`)] }
      }
      if (action === 'compare') {
        const r = await visualCompare(tab, name, {
          fullPage,
          pixelThreshold: typeof args['pixelThreshold'] === 'number' ? args['pixelThreshold'] : undefined,
          maxDiffPercent: typeof args['maxDiffPercent'] === 'number' ? args['maxDiffPercent'] : undefined,
          writeDiff: args['writeDiff'] !== false
        })
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
      const report = await auditContrast(tab, {
        level,
        maxResults: typeof args['maxResults'] === 'number' ? args['maxResults'] : undefined,
        signal: args['__aaSignal'] instanceof AbortSignal ? args['__aaSignal'] : undefined
      })
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
      const results = await captureViewportMatrix(tab, specs, {
        signal: args['__aaSignal'] instanceof AbortSignal ? args['__aaSignal'] : undefined
      })
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
  return tools.map((tool) => {
    const annotations = TOOL_ANNOTATIONS[tool.name]
    if (!annotations) throw new Error(`工具缺少 MCP annotations：${tool.name}`)
    return {
      ...tool,
      annotations,
      handler: async (args: Record<string, unknown>) => {
        approvals?.assertRunning()
        const startTime = Date.now()
        try {
          const result = await tool.handler(args)
          approvals?.assertRunning()
          if (args['__aaSignal'] instanceof AbortSignal && args['__aaSignal'].aborted) throw new ActionError('工具调用已取消。')
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
