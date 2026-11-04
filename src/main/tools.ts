import type { ToolContent } from '@shared/types'
import { TabManager, normalizeUrl } from './tabs'
import {
  ActionError,
  captureSnapshot,
  snapshotText,
  doNavigate,
  doClick,
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
  searchUrl: string
): McpToolDef[] {
  const tools: McpToolDef[] = []

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
      'Click an element by its snapshot ref (e.g. "e12"). A fresh snapshot is returned afterwards ' +
      'so you can see the result and continue.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot, e.g. "e12"' },
        snapshot: { type: 'boolean', description: 'Return an incremental snapshot after the action (default true)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['ref']
    },
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const want = args['snapshot'] !== false
      const r = await doClick(tab, String(args['ref']), want)
      return { content: [text(withSnap(`已点击: ${r.clicked}`, r.snapshot, want))] }
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
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const want = args['snapshot'] !== false
      const r = await doType(tab, String(args['ref']), String(args['text'] ?? ''), {
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
      'Take a PNG screenshot of the active tab. Returns the image inline (for vision-capable models) ' +
      'and saves it under ~/.aabrowser/screenshots/.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    },
    handler: async (args) => {
      const tab = resolveWebContents(tabs, args['tabId'] as string | undefined)
      const image = await doScreenshot(tab)
      const { app } = await import('electron')
      const dir = `${app.getPath('home')}/.aabrowser/screenshots`
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

  return tools
}
