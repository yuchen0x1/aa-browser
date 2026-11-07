import type { ToolContent } from '@shared/types'
import { TabManager, normalizeUrl } from './tabs'
import { clipBody } from './network'
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
import {
  ActionError,
  captureSnapshot,
  snapshotText,
  doNavigate,
  doClick,
  doDrag,
  doType,
  doSelectOption,
  doScroll,
  doExtract,
  doWaitForText,
  doPressKey,
  doScreenshot,
  doConsoleLogs,
  resolveWebContents
} from './actions'

export interface McpToolDef {
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

/** 工具结果：文本内容 */
const text = (t: string): ToolContent => ({ type: 'text', text: t })

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
  getSettings?: () => { requireOperationApproval: boolean }
): McpToolDef[] {
  const tools: McpToolDef[] = []

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

  tools.push({
    name: 'browser_navigate',
    title: '导航',
    description:
      'Navigate the browser to a URL in the active tab (or a new tab). ' +
      'Plain text that is not a URL is treated as a search query. ' +
      'Returns a full page snapshot after loading, so you can act immediately ' +
      '(pass snapshot:false to skip it if you only need browser_extract / browser_wait).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL or search query' },
        newTab: { type: 'boolean', description: 'Open in a new tab instead of the active one (default false)' },
        snapshot: { type: 'boolean', description: 'Include a full snapshot in the result (default true)' },
        tabId: { type: 'string', description: 'Operate on a specific tab id (from browser_tabs list)' }
      },
      required: ['url']
    },
    handler: async (args) => {
      approvals?.assertRunning()
      const url = String(args['url'] ?? '')
      if (!url) throw new ActionError('url 不能为空')
      const target = normalizeUrl(url, searchUrl, newtabUrl)
      const r = await doNavigate(tabs, target, { newTab: !!args['newTab'], tabId: args['tabId'] as string | undefined })
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

  tools.push({
    name: 'browser_snapshot',
    title: '页面快照',
    description:
      'Capture a structured accessibility snapshot of the active tab as a YAML-style tree. ' +
      'Interactive elements carry [ref=eN] ids; pass a ref to browser_click / browser_type / ' +
      'browser_select_option to act on them. Snapshots are incremental: if the page is unchanged ' +
      'you get a one-line "no change" reply, and after small changes only the changed region is ' +
      'returned (refs stay stable across snapshots). Pass full:true to force a complete tree ' +
      '(automatic after navigation or large changes).',
    inputSchema: {
      type: 'object',
      properties: {
        full: { type: 'boolean', description: 'Force a full snapshot instead of incremental (default false)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    },
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const snap = await captureSnapshot(tab.view.webContents, args['full'] === true ? { mode: 'full' } : undefined)
      return { content: [text(snapshotText(snap))] }
    }
  })

  tools.push({
    name: 'browser_click',
    title: '点击',
    description:
      'Click an element by its snapshot ref (e.g. "e12"). Supports left click, right click (context menu), ' +
      'double click. A fresh snapshot is returned afterwards so you can see the result and continue.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot, e.g. "e12"' },
        button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button (default "left")' },
        doubleClick: { type: 'boolean', description: 'Perform double click (default false)' },
        snapshot: { type: 'boolean', description: 'Return an incremental snapshot after the action (default true)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['ref']
    },
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

  tools.push({
    name: 'browser_drag',
    title: '拖拽',
    description:
      'Drag an element by ref to another element (toRef) or by a relative pixel offset (dx, dy). ' +
      'Useful for sliders, drag-and-drop sortable lists, and canvas boards.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Source element ref to drag from' },
        toRef: { type: 'string', description: 'Target element ref to drop onto' },
        dx: { type: 'number', description: 'Relative horizontal offset in pixels (e.g. 150)' },
        dy: { type: 'number', description: 'Relative vertical offset in pixels (e.g. -50)' },
        snapshot: { type: 'boolean', description: 'Return an incremental snapshot after the action (default true)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['ref']
    },
    handler: async (args) => {
      approvals?.assertRunning()
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const want = args['snapshot'] !== false
      const r = await doDrag(tab, String(args['ref']), {
        toRef: args['toRef'] as string | undefined,
        dx: args['dx'] as number | undefined,
        dy: args['dy'] as number | undefined,
        wantSnapshot: want
      })
      return { content: [text(withSnap(`已拖拽: ${r.dragged}`, r.snapshot, want))] }
    }
  })

  tools.push({
    name: 'browser_type',
    title: '输入文本',
    description:
      'Type text into a textbox/contenteditable by ref. Use submit:true to press Enter after typing ' +
      '(e.g. submit a search box). Use clear:true to empty the field first.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref of the textbox' },
        text: { type: 'string', description: 'Text to type' },
        submit: { type: 'boolean', description: 'Press Enter after typing (default false)' },
        clear: { type: 'boolean', description: 'Clear the field before typing (default false)' },
        snapshot: { type: 'boolean', description: 'Return an incremental snapshot after the action (default true)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['ref', 'text']
    },
    handler: async (args) => {
      approvals?.assertRunning()
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      if (tabs.activeId !== tab.id) throw new ActionError('敏感输入审批仅支持当前活动标签；请切换到目标标签后重试。')
      const ref = String(args['ref'])
      const target = await inspectTypeTarget(tab, ref)
      if (!target.ok) throw new ActionError(`找不到输入目标 ${ref}；请刷新页面快照后重试。`)
      if (target.sensitive) {
        // Never write or retain an agent-supplied secret. Let the user type directly into the focused page field.
        const wc = tab.view.webContents
        const originalUrl = wc.getURL()
        const originalFrame = await wc.executeJavaScript(`(() => { const e=(window.__aaRefs||{})[${JSON.stringify(ref)}]; if(!e||!e.isConnected) return null; const r=e.getBoundingClientRect(); e.focus(); return {fingerprint:[e.tagName,e.type||'',e.name||'',e.id||'',e.autocomplete||'',e.getAttribute('aria-label')||'',e.labels?Array.from(e.labels).map(x=>x.innerText||x.textContent||'').join(' '):''].join('|'), rect:[Math.round(r.x),Math.round(r.y),Math.round(r.width),Math.round(r.height)]} })()`, false) as { fingerprint?: string; rect?: number[] } | null
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
        await opGate({ site: new URL(tab.view.webContents.getURL()).host || tab.view.webContents.getURL(), tabTitle: tab.title, action: '提交表单/输入后回车' })
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

  tools.push({
    name: 'browser_select_option',
    title: '下拉选择',
    description: 'Select an option in a <select> dropdown by ref, matching by value or visible label.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref of the combobox' },
        value: { type: 'string', description: 'Option value to select' },
        label: { type: 'string', description: 'Option visible label to select' },
        snapshot: { type: 'boolean', description: 'Return an incremental snapshot after the action (default true)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['ref']
    },
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

  tools.push({
    name: 'browser_scroll',
    title: '滚动页面',
    description:
      'Scroll the page (window first, then the largest scrollable area). ' +
      'Useful before re-snapshotting content that is outside the viewport.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction' },
        amount: { type: 'number', description: 'Pixels to scroll (default 700, max 3000)' },
        snapshot: { type: 'boolean', description: 'Return an incremental snapshot after the action (default true)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['direction']
    },
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

  tools.push({
    name: 'browser_extract',
    title: '提取文本',
    description:
      'Extract readable text from the page (or a specific element by ref) as plain text. ' +
      'Better than snapshot when you only need content, not interactive elements.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Extract text of this element only (default: whole page)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    },
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const r = await doExtract(tab, args['ref'] as string | undefined)
      const head = r.title ? `title: ${r.title}\n\n` : ''
      return { content: [text(head + r.text)] }
    }
  })

  tools.push({
    name: 'browser_wait',
    title: '等待',
    description:
      'Wait until the given text appears anywhere on the page (polls every 250ms). ' +
      'Use after submit/navigation to wait for results to render.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to wait for' },
        timeoutMs: { type: 'number', description: 'Timeout in ms (default 10000, max 30000)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['text']
    },
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const timeoutMs = typeof args['timeoutMs'] === 'number' ? args['timeoutMs'] : 10000
      const r = await doWaitForText(tab, String(args['text'] ?? ''), timeoutMs)
      return {
        content: [
          text(
            r.found
              ? `已出现 "${args['text']}"（等待 ${r.elapsedMs}ms）`
              : `超时 ${r.elapsedMs}ms，页面中未出现 "${args['text']}"。可调用 browser_snapshot 查看当前页面。`
          )
        ],
        isError: !r.found
      }
    }
  })

  tools.push({
    name: 'browser_press_key',
    title: '按键',
    description:
      'Press a key on the focused element: Enter, Escape, Tab, Backspace, Delete, ArrowUp/Down/Left/Right, ' +
      'PageUp/PageDown, Home/End, F1-F12, or a single character.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name, e.g. "Enter", "Escape", "ArrowDown"' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['key']
    },
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const r = await doPressKey(tab, String(args['key'] ?? ''))
      return { content: [text(`已按下: ${r.pressed}`)] }
    }
  })

  tools.push({
    name: 'browser_screenshot',
    title: '截图',
    description:
      'Take a PNG screenshot of the active tab, or of a specific element (pass ref — the view is ' +
      'scrolled to it and the image is cropped to its bounding box). Returns the image inline ' +
      '(for vision-capable models) and saves it under ~/.aabrowser/screenshots/.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref: screenshot only this element (default: whole viewport)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    },
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const image = args['ref'] ? await doElementScreenshot(tab, String(args['ref'])) : await doScreenshot(tab)
      const { app } = await import('electron')
        const dir = process.env['AA_BROWSER_SCREENSHOT_DIR'] || `${app.getPath('home')}/.aabrowser/screenshots`
      try {
        const fs = await import('node:fs')
        const path = await import('node:path')
        fs.mkdirSync(dir, { recursive: true })
        const file = path.join(dir, `aa-${Date.now()}.png`)
        fs.writeFileSync(file, Buffer.from(image.data ?? '', 'base64'))
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

  tools.push({
    name: 'browser_hover',
    title: '悬停',
    description:
      'Hover the mouse over an element by ref (triggers hover menus, tooltips, dropdown reveals). ' +
      'Uses the real input path so hover-dependent UI behaves as for a human.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['ref']
    },
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const r = await doHover(tab, String(args['ref']))
      return { content: [text(`已悬停: ${r.hovered}`)] }
    }
  })

  tools.push({
    name: 'browser_navigate_back',
    title: '后退',
    description: 'Go back one page in the active tab history. Returns a fresh incremental snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot: { type: 'boolean', description: 'Return a snapshot after navigation (default true)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    },
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const want = args['snapshot'] !== false
      const r = await doNavigateHistory(tab, 'back', want, (t) => tabs.goBack(t), (t) => tabs.canBack(t))
      return { content: [text(withSnap('已后退', r.snapshot, want))] }
    }
  })

  tools.push({
    name: 'browser_navigate_forward',
    title: '前进',
    description: 'Go forward one page in the active tab history. Returns a fresh incremental snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot: { type: 'boolean', description: 'Return a snapshot after navigation (default true)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    },
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const want = args['snapshot'] !== false
      const r = await doNavigateHistory(tab, 'forward', want, (t) => tabs.goForward(t), (t) => tabs.canForward(t))
      return { content: [text(withSnap('已前进', r.snapshot, want))] }
    }
  })

  tools.push({
    name: 'browser_resize',
    title: '调整视口',
    description:
      'Resize the browser window content area (200–5000). Useful for responsive-design checks; ' +
      'then take browser_snapshot or browser_screenshot to see the adapted layout.',
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'number', description: 'Content width in px (200–5000)' },
        height: { type: 'number', description: 'Content height in px (200–5000)' }
      },
      required: ['width', 'height']
    },
    handler: async (args) => {
      const w = Number(args['width'])
      const h = Number(args['height'])
      const r = await doResize(resolveWebContents(tabs, args['tabId'] as string | undefined), windowCtl.resize, w, h)
      return { content: [text(`视口已调整为 ${r.width}×${r.height}`)] }
    }
  })

  /* ── v0.4.0 新增：观察增强 ── */

  tools.push({
    name: 'browser_get_selector',
    title: '导出选择器',
    description:
      'Generate a CSS selector for a snapshot ref element (verified against the DOM). Use it to reuse ' +
      'the element in scripts, tests, or querySelector-based follow-up work.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['ref']
    },
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const r = await doGetSelector(tab, String(args['ref']))
      const badge = r.verified ? '✅ 已回验' : '⚠️ 未能回验（元素可能在 iframe 内或动态生成）'
      return { content: [text(`${badge}\nselector: ${r.selector}\n元素文本: ${r.text || '（无）'}`)] }
    }
  })

  tools.push({
    name: 'browser_find',
    title: '页面查找',
    description:
      'Find text on the page (native Ctrl+F behavior): highlights every match, scrolls to the first one ' +
      'and reports the match count. Keep the highlight for the user; call with empty text or browser_scroll to move on.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to find' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['text']
    },
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const r = await doFind(tab, String(args['text'] ?? ''))
      return {
        content: [text(`页面共 ${r.matches} 处匹配"${args['text']}"，已高亮并定位到第 ${r.activeOrdinal ?? 1} 处`)]
      }
    }
  })

  /* ── v0.4.0 新增：状态与数据 ── */

  tools.push({
    name: 'browser_cookies',
    title: 'Cookie 管理',
    description:
      'Get / set / clear cookies of the browser session (covers all sites the session has visited). ' +
      'Essential for login-state testing. set requires url + name + value.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'clear'], description: 'Operation' },
        url: { type: 'string', description: '(get/set) Cookie belongs to this URL' },
        name: { type: 'string', description: '(get: filter by name; set: cookie name; clear: only clear this name)' },
        value: { type: 'string', description: '(set) Cookie value' },
        domain: { type: 'string', description: '(set/clear filter) Cookie domain' },
        secure: { type: 'boolean', description: '(set) Secure flag (default: true for https URLs)' },
        httpOnly: { type: 'boolean', description: '(set) HttpOnly flag' },
        expiresSeconds: { type: 'number', description: '(set) Expires in N seconds from now (omit = session cookie)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['action']
    },
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const r = await doCookies(tab, {
        action: String(args['action']) as 'get' | 'set' | 'clear',
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

  tools.push({
    name: 'browser_storage',
    title: '页面存储',
    description: 'Read / write / remove / clear localStorage or sessionStorage of the active page origin.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['get', 'set', 'remove', 'clear'], description: 'Operation (get without key = list all)' },
        kind: { type: 'string', enum: ['local', 'session'], description: 'localStorage (default) or sessionStorage' },
        key: { type: 'string', description: 'Storage key (get without key = list all entries)' },
        value: { type: 'string', description: '(set) Value to store' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['action']
    },
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const r = await doStorage(tab, {
        action: String(args['action']) as 'get' | 'set' | 'remove' | 'clear',
        kind: (args['kind'] as 'local' | 'session') ?? 'local',
        key: args['key'] as string | undefined,
        value: args['value'] as string | undefined
      })
      return { content: [text(r.content)] }
    }
  })

  tools.push({
    name: 'browser_downloads',
    title: '下载列表',
    description:
      'List files captured by the browser (downloads are saved silently under ~/.aabrowser/downloads/, ' +
      'no save dialog). Shows filename, source URL, size and progress/state.',
    inputSchema: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'Max entries (default 20, newest last)' }
      }
    },
    handler: async (args) => {
      const limit = Math.min(100, Math.max(1, (args['limit'] as number) ?? 20))
      const items = downloads.list(limit)
      if (!items.length) return { content: [text('（暂无下载记录）')] }
      const lines = items.map(
        (d) =>
          `[${d.id}] ${d.filename} — ${d.state} ${(d.receivedBytes / 1024).toFixed(1)}/${(d.totalBytes / 1024).toFixed(1)}KB\n    来源: ${d.url.slice(0, 120)}\n    保存: ${d.savePath}`
      )
      return { content: [text(`共 ${items.length} 条下载记录：\n${lines.join('\n')}`)] }
    }
  })

  tools.push({
    name: 'browser_pdf',
    title: '存为 PDF',
    description: 'Render the active page to a PDF (A4, print background on) and save it. Returns the file path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Output file path (default ~/.aabrowser/downloads/aa-page-<ts>.pdf)' },
        landscape: { type: 'boolean', description: 'Landscape orientation (default false)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    },
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const r = await doPdf(tab, args['path'] as string | undefined, !!args['landscape'])
      return { content: [text(`PDF 已保存: ${r.savedPath}`)] }
    }
  })

  tools.push({
    name: 'browser_upload_file',
    title: '上传文件',
    description:
      'Upload local file(s) into a <input type=file> element by ref. Accepts absolute local paths; ' +
      'total size capped at 20MB. Fire-and-forget is enough — the change event fires for the page.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref of the file input' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute local file path(s)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['ref', 'paths']
    },
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const paths = (args['paths'] as unknown[]).map(String)
      if (!paths.length) throw new ActionError('paths 不能为空')
      const r = await doUploadFile(tab, String(args['ref']), paths)
      return { content: [text(r.content)] }
    }
  })

  tools.push({
    name: 'browser_console',
    title: '控制台日志',
    description: 'Read recent console messages of the active tab (useful for debugging pages).',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['all', 'info', 'warning', 'error'], description: 'Filter level (default all)' },
        limit: { type: 'number', description: 'Max entries (default 50)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    },
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

  tools.push({
    name: 'browser_network_requests',
    title: '网络请求列表（抓包）',
    description:
      'List captured network requests of the active tab (HTTP-level packet capture): id, method, ' +
      'status, type, size, duration, URL. Capture starts automatically on first use. Use browser_network_detail ' +
      'with a request id to inspect headers and response body.',
    inputSchema: {
      type: 'object',
      properties: {
        urlContains: { type: 'string', description: 'Only requests whose URL contains this (case-insensitive)' },
        method: { type: 'string', description: 'Filter by HTTP method, e.g. GET/POST' },
        statusMin: { type: 'number', description: 'Minimum HTTP status (e.g. 400 for errors)' },
        statusMax: { type: 'number', description: 'Maximum HTTP status' },
        resourceType: { type: 'string', description: 'Filter by type: Document/Script/XHR/Fetch/Image/Stylesheet/…' },
        limit: { type: 'number', description: 'Max entries (default 50, newest last)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    },
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
          `${e.error ? 'ERROR:' + e.error : ''} ${e.url.slice(0, 160)}`
      )
      return { content: [text(`共 ${list.length} 条（显示最近 ${shown.length} 条）：\n${lines.join('\n')}`)] }
    }
  })

  tools.push({
    name: 'browser_network_detail',
    title: '网络请求详情',
    description:
      'Inspect one captured network request: full request/response headers, status, size, duration, ' +
      'and (with body:true) the response body text. This is how the agent reads API responses for testing.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'Request id from browser_network_requests, e.g. "1234.5"' },
        body: { type: 'boolean', description: 'Include the response body (default false)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['requestId']
    },
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      await tab.net.ensure()
      const entry = tab.net.find(String(args['requestId'] ?? ''))
      if (!entry) throw new ActionError(`找不到请求 ${args['requestId']}（用 browser_network_requests 查看当前抓到的请求）`)
      const parts: string[] = [
        `${entry.method} ${entry.url}`,
        `状态: ${entry.status} ${entry.statusText}${entry.error ? '（失败: ' + entry.error + '）' : ''}`,
        `类型: ${entry.resourceType} | 大小: ${(entry.size / 1024).toFixed(1)}KB | 耗时: ${entry.durationMs ?? '…'}ms`,
        '',
        '请求头:',
        ...Object.entries(entry.requestHeaders).map(([k, v]) => `  ${k}: ${v}`),
        '',
        '响应头:',
        ...Object.entries(entry.responseHeaders).map(([k, v]) => `  ${k}: ${v}`)
      ]
      if (args['body'] === true) {
        const body = await tab.net.getResponseBody(entry.requestId)
        parts.push('', '响应体:', clipBody(body, entry.mimeType))
      }
      return { content: [text(parts.join('\n'))] }
    }
  })

  tools.push({
    name: 'browser_har',
    title: '导出 HAR',
    description:
      'Export all captured network traffic of the active tab as a HAR 1.2 file (headers, timings, sizes; ' +
      'no response bodies) for manual analysis in DevTools/Fiddler. Saved under ~/.aabrowser/har/ by default.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Output file path (default ~/.aabrowser/har/aa-<timestamp>.har)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    },
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      await tab.net.ensure()
      const { app } = await import('electron')
      const fs = await import('node:fs')
      const path = await import('node:path')
      const os = await import('node:os')
      const file =
        (args['path'] as string | undefined) ||
        path.join(os.homedir(), '.aabrowser', 'har', `aa-${Date.now()}.har`)
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(file, JSON.stringify(tab.net.toHar(app.getVersion()), null, 2), 'utf-8')
      return { content: [text(`HAR 已导出: ${file}\n共 ${fs.statSync(file).size} 字节`)] }
    }
  })

  /* ── v0.6.0 新增：请求拦截与 Mock ── */

  tools.push({
    name: 'browser_mock_requests',
    title: '请求拦截 Mock',
    description:
      'Intercept and mock HTTP requests of the active tab. Add or replace a rule that matches a URL ' +
      'substring (and optional method); matched requests are answered with a fake status/headers/body ' +
      'instead of reaching the network. Use to simulate API responses, error states, or stub third-party ' +
      'calls during testing. Pass action:"continue" to just observe (log) a matching request without ' +
      'answering it. Returns the rule id and current rules.',
    inputSchema: {
      type: 'object',
      properties: {
        urlContains: { type: 'string', description: 'Substring of request URL to match (case-insensitive), e.g. "/api/v1/quote"' },
        method: { type: 'string', description: 'Only mock this HTTP method (e.g. GET/POST). Omit to match any.' },
        status: { type: 'number', description: 'Fake response status code (default 200)' },
        headers: { type: 'object', description: 'Fake response headers (optional)' },
        body: { type: 'string', description: 'Fake response body text (default empty)' },
        action: { type: 'string', enum: ['respond', 'continue'], description: 'respond=answer with mock (default); continue=just pass through' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['urlContains']
    },
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

  tools.push({
    name: 'browser_list_mocks',
    title: '列出 Mock 规则',
    description: 'List all active request-mock rules of the active tab (id, matcher, status, hits).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    },
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

  tools.push({
    name: 'browser_clear_mocks',
    title: '清空 Mock 规则',
    description:
      'Remove all (or one, by rule id) request-mock rules of the active tab and stop intercepting. ' +
      'Pass id to remove a single rule. Returns how many were removed.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Rule id to remove (omit to clear all)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    },
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

  tools.push({
    name: 'browser_tabs',
    title: '标签管理',
    description:
      'Manage tabs: "list" shows all tabs with ids; "new" opens a URL in a new tab; ' +
      '"select" makes a tab active; "close" closes a tab.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new', 'select', 'close'], description: 'Tab operation' },
        url: { type: 'string', description: '(action=new) URL to open' },
        tabId: { type: 'string', description: '(action=select/close) target tab id' }
      },
      required: ['action']
    },
    handler: async (args) => {
      approvals?.assertRunning()
      const action = String(args['action'] ?? 'list')
      if (action === 'list') {
        const lines = tabs.infos().map(
          (t, i) =>
            `${i + 1}. [${t.id}]${t.active ? ' ★活动' : ''} ${t.title}\n   ${t.url}`
        )
        return { content: [text(lines.length ? `共 ${lines.length} 个标签页：\n${lines.join('\n')}` : '（无标签页）')] }
      }
      if (action === 'new') {
        const url = String(args['url'] ?? '')
        const target = url ? normalizeUrl(url, searchUrl, newtabUrl) : newtabUrl
        const tab = tabs.createTab(target)
        return { content: [text(`已新建标签页: [${tab.id}] ${target}`)] }
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

  // Interrupt is a central admission gate: no MCP operation starts while paused.
  // Individual handlers retain their own checks around multi-step actions.
  return tools.map((tool) => ({
    ...tool,
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
  }))
}
