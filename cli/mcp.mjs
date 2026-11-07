#!/usr/bin/env node
/**
 * aa-browser-mcp —— MCP stdio 桥。
 *
 * 把 MCP（stdio 上的 JSON-RPC）连接转发到正在运行的 Aa Browser 桌面应用
 * （通过 ~/.aabrowser/connection.json 发现，走本地 WebSocket）。
 *
 * 协议：MCP stdio 为换行分隔的 JSON-RPC 2.0。实现最小子集：
 *   initialize / notifications/* / tools/list / tools/call / ping
 * 零依赖，直接 `node cli/mcp.mjs` 运行。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import process from 'node:process'
import WebSocket from 'ws'

const VERSION = '0.6.0'
const CONNECT_FILE = process.env['AA_BROWSER_CONNECTION_FILE'] || path.join(os.homedir(), '.aabrowser', 'connection.json')
const CALL_TIMEOUT_MS = 60000

const log = (...a) => console.error('[aa-browser-mcp]', ...a)

/* ──────────────────── 工具定义 ──────────────────── */

const TOOL_DEFS = [
  {
    name: 'browser_navigate',
    title: '导航',
    description:
      'Navigate the browser to a URL in the active tab (or a new tab). Plain text that is not a URL is treated as a search query. Returns a full page snapshot after loading, so you can act immediately (pass snapshot:false to skip it if you only need browser_extract / browser_wait).',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL or search query' },
        newTab: { type: 'boolean', description: 'Open in a new tab instead of the active one (default false)' },
        snapshot: { type: 'boolean', description: 'Include a full snapshot in the result (default true)' },
        tabId: { type: 'string', description: 'Operate on a specific tab id (from browser_tabs list)' }
      },
      required: ['url']
    }
  },
  {
    name: 'browser_snapshot',
    title: '页面快照',
    description:
      'Capture a structured accessibility snapshot of the active tab as a YAML-style tree. Interactive elements carry [ref=eN] ids; pass a ref to browser_click / browser_type / browser_select_option to act on them. Snapshots are incremental: unchanged page returns a one-line reply, small changes return only the changed region, and refs stay stable across snapshots. Pass full:true to force a complete tree (automatic after navigation or large changes).',
    inputSchema: {
      type: 'object',
      properties: {
        full: { type: 'boolean', description: 'Force a full snapshot instead of incremental (default false)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    }
  },
  {
    name: 'browser_click',
    title: '点击',
    description:
      'Click an element by its snapshot ref (e.g. "e12"). Supports left click, right click (context menu), double click. An incremental snapshot is returned afterwards so you can see the result and continue.',
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
    }
  },
  {
    name: 'browser_drag',
    title: '拖拽',
    description:
      'Drag an element by ref to another element (toRef) or by a relative pixel offset (dx, dy). Useful for sliders, drag-and-drop sortable lists, and canvas boards.',
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
    }
  },
  {
    name: 'browser_type',
    title: '输入文本',
    description:
      'Type text into a textbox/contenteditable by ref. Use submit:true to press Enter after typing (e.g. submit a search box). Use clear:true to empty the field first.',
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
    }
  },
  {
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
    }
  },
  {
    name: 'browser_scroll',
    title: '滚动页面',
    description: 'Scroll the page (window first, then the largest scrollable area). Useful before re-snapshotting content outside the viewport.',
    inputSchema: {
      type: 'object',
      properties: {
        direction: { type: 'string', enum: ['up', 'down', 'left', 'right'], description: 'Scroll direction' },
        amount: { type: 'number', description: 'Pixels to scroll (default 700, max 3000)' },
        snapshot: { type: 'boolean', description: 'Return an incremental snapshot after the action (default true)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['direction']
    }
  },
  {
    name: 'browser_extract',
    title: '提取文本',
    description: 'Extract readable text from the page (or a specific element by ref) as plain text. Better than snapshot when you only need content, not interactive elements.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Extract text of this element only (default: whole page)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    }
  },
  {
    name: 'browser_wait',
    title: '等待',
    description: 'Wait until the given text appears anywhere on the page (polls every 250ms). Use after submit/navigation to wait for results to render.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to wait for' },
        timeoutMs: { type: 'number', description: 'Timeout in ms (default 10000, max 30000)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['text']
    }
  },
  {
    name: 'browser_press_key',
    title: '按键',
    description: 'Press a key on the focused element: Enter, Escape, Tab, Backspace, Delete, ArrowUp/Down/Left/Right, PageUp/PageDown, Home/End, F1-F12, or a single character.',
    inputSchema: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Key name, e.g. "Enter", "Escape", "ArrowDown"' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['key']
    }
  },
  {
    name: 'browser_screenshot',
    title: '截图',
    description:
      'Take a PNG screenshot of the active tab, or of a specific element (pass ref — the view is scrolled to it and the image is cropped to its bounding box). Returns the image inline (for vision-capable models) and saves it under ~/.aabrowser/screenshots/.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref: screenshot only this element (default: whole viewport)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    }
  },
  {
    name: 'browser_hover',
    title: '悬停',
    description:
      'Hover the mouse over an element by ref (triggers hover menus, tooltips, dropdown reveals). Uses the real input path so hover-dependent UI behaves as for a human.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['ref']
    }
  },
  {
    name: 'browser_navigate_back',
    title: '后退',
    description: 'Go back one page in the active tab history. Returns a fresh incremental snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot: { type: 'boolean', description: 'Return a snapshot after navigation (default true)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    }
  },
  {
    name: 'browser_navigate_forward',
    title: '前进',
    description: 'Go forward one page in the active tab history. Returns a fresh incremental snapshot.',
    inputSchema: {
      type: 'object',
      properties: {
        snapshot: { type: 'boolean', description: 'Return a snapshot after navigation (default true)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    }
  },
  {
    name: 'browser_resize',
    title: '调整视口',
    description:
      'Resize the browser window content area (200–5000). Useful for responsive-design checks; then take browser_snapshot or browser_screenshot to see the adapted layout.',
    inputSchema: {
      type: 'object',
      properties: {
        width: { type: 'number', description: 'Content width in px (200–5000)' },
        height: { type: 'number', description: 'Content height in px (200–5000)' }
      },
      required: ['width', 'height']
    }
  },
  {
    name: 'browser_get_selector',
    title: '导出选择器',
    description:
      'Generate a CSS selector for a snapshot ref element (verified against the DOM). Use it to reuse the element in scripts, tests, or querySelector-based follow-up work.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['ref']
    }
  },
  {
    name: 'browser_find',
    title: '页面查找',
    description:
      'Find text on the page (native Ctrl+F behavior): highlights every match, scrolls to the first one and reports the match count. Keep the highlight for the user; call with browser_scroll to move on.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Text to find' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['text']
    }
  },
  {
    name: 'browser_cookies',
    title: 'Cookie 管理',
    description:
      'Get / set / clear cookies of the browser session (covers all sites the session has visited). Essential for login-state testing. set requires url + name + value.',
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
    }
  },
  {
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
    }
  },
  {
    name: 'browser_downloads',
    title: '下载列表',
    description:
      'List files captured by the browser (downloads are saved silently under ~/.aabrowser/downloads/, no save dialog). Shows filename, source URL, size and progress/state.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Max entries (default 20, newest last)' } }
    }
  },
  {
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
    }
  },
  {
    name: 'browser_upload_file',
    title: '上传文件',
    description:
      'Upload local file(s) into a <input type=file> element by ref. Accepts absolute local paths; total size capped at 20MB. Fire-and-forget is enough — the change event fires for the page.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref of the file input' },
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute local file path(s)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['ref', 'paths']
    }
  },
  {
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
    }
  },
  {
    name: 'browser_network_requests',
    title: '网络请求列表（抓包）',
    description:
      'List captured network requests of the active tab (HTTP-level packet capture): id, method, status, type, size, duration, URL. Capture starts automatically on first use. Use browser_network_detail with a request id to inspect headers and response body.',
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
    }
  },
  {
    name: 'browser_network_detail',
    title: '网络请求详情',
    description:
      'Inspect one captured network request: full request/response headers, status, size, duration, and (with body:true) the response body text. This is how the agent reads API responses for testing.',
    inputSchema: {
      type: 'object',
      properties: {
        requestId: { type: 'string', description: 'Request id from browser_network_requests, e.g. "1234.5"' },
        body: { type: 'boolean', description: 'Include the response body (default false)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      },
      required: ['requestId']
    }
  },
  {
    name: 'browser_har',
    title: '导出 HAR',
    description:
      'Export all captured network traffic of the active tab as a HAR 1.2 file (headers, timings, sizes; no response bodies) for manual analysis in DevTools/Fiddler. Saved under ~/.aabrowser/har/ by default.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Output file path (default ~/.aabrowser/har/aa-<timestamp>.har)' },
        tabId: { type: 'string', description: 'Tab id (default: active tab)' }
      }
    }
  },
  {
    name: 'browser_tabs',
    title: '标签管理',
    description: 'Manage tabs: "list" shows all tabs with ids; "new" opens a URL in a new tab; "select" makes a tab active; "close" closes a tab.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new', 'select', 'close'], description: 'Tab operation' },
        url: { type: 'string', description: '(action=new) URL to open' },
        tabId: { type: 'string', description: '(action=select/close) target tab id' }
      },
      required: ['action']
    }
  }
]

/* ──────────────────── WS 连接管理 ──────────────────── */

let ws = null
let nextCallId = 1
const pending = new Map() // id -> { resolve, reject, timer, mcpId }
const mcpToBridge = new Map()

function readConnection() {
  try {
    const info = JSON.parse(fs.readFileSync(CONNECT_FILE, 'utf-8'))
    if (!info.port || !info.token) throw new Error('invalid')
    return info
  } catch {
    return null
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function connectWs() {
  return new Promise((resolve, reject) => {
    const info = readConnection()
    if (!info) {
      reject(new Error('未找到 Aa Browser：请先启动 Aa Browser 桌面应用（npm run dev 或 npm start）。'))
      return
    }
    if (!isPidAlive(info.pid)) {
      reject(new Error('Aa Browser 进程已退出但发现文件残留：请重新启动 Aa Browser。'))
      return
    }
    const socket = new WebSocket(`ws://127.0.0.1:${info.port}/?token=${info.token}`)
    const timer = setTimeout(() => {
      try { socket.terminate() } catch {}
      reject(new Error('连接 Aa Browser 超时（3s）。'))
    }, 3000)

    socket.on('open', () => {
      clearTimeout(timer)
      ws = socket
      log('connected to browser bridge', info.pid, info.port)
      socket.on('message', (raw) => {
        let msg
        try { msg = JSON.parse(raw.toString()) } catch { return }
        if (typeof msg?.id === 'number' && pending.has(msg.id)) {
          const p = pending.get(msg.id)
          clearTimeout(p.timer)
          pending.delete(msg.id)
          log('received browser tool response', msg.id, !!msg.ok)
          if (msg.ok) p.resolve(msg.result)
          else p.reject(new Error(msg.error || '工具执行失败'))
        }
      })
      socket.on('close', () => {
        ws = null
        for (const [, p] of pending) {
          clearTimeout(p.timer)
          p.reject(new Error('与 Aa Browser 的连接已断开。'))
        }
        pending.clear()
      })
      socket.on('error', (err) => {
        log('ws error:', err.message)
      })
      resolve(socket)
    })
    socket.on('error', (err) => {
      clearTimeout(timer)
      reject(new Error(`无法连接 Aa Browser: ${err.message}`))
    })
  })
}

async function getWs() {
  if (ws && ws.readyState === WebSocket.OPEN) return ws
  return connectWs()
}

/**
 * 启动即连接（带重试）：桥被 AI 客户端拉起时立刻连上浏览器，
 * 让桌面端"Agent 已连接"指示灯在会话开始时就点亮；
 * 浏览器未启动/正在重启时静默重试，浏览器重启（换端口）后也会自动重连。
 */
const CONNECT_RETRY_MS = 5000
function startEagerConnect() {
  const timer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) return
    connectWs().catch(() => {
      /* 浏览器未运行等原因：静默等待下一轮重试 */
    })
  }, CONNECT_RETRY_MS)
  timer.unref?.()
}

startEagerConnect()

async function callTool(name, args) {
  const socket = await getWs()
  const id = nextCallId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      const p = pending.get(id)
      pending.delete(id)
      if (p?.mcpId !== undefined) mcpToBridge.delete(p.mcpId)
      try { socket.send(JSON.stringify({ id, cancel: true })) } catch {}
      reject(new Error(`工具 ${name} 执行超时（${CALL_TIMEOUT_MS / 1000}s）`))
    }, CALL_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer, mcpId: args?.__mcpId })
    if (args?.__mcpId !== undefined) mcpToBridge.set(args.__mcpId, id)
    const cleanArgs = { ...(args ?? {}) }
    delete cleanArgs.__mcpId
    socket.send(JSON.stringify({ id, tool: name, args: cleanArgs }))
  })
}

/* ──────────────────── MCP stdio 协议 ──────────────────── */

function send(msg) {
  log('stdio response', msg.id, msg.error ? 'error' : 'result')
  process.stdout.write(JSON.stringify(msg) + '\n')
}

function rpcResult(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function rpcError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function toolResultForMcp(result) {
  // result: { content: [{type:'text'|'image', ...}], isError? }
  const content = (result?.content ?? []).map((c) => {
    if (c.type === 'image') {
      return { type: 'image', data: c.data, mimeType: c.mimeType || 'image/png' }
    }
    return { type: 'text', text: String(c.text ?? '') }
  })
  return { content, isError: !!result?.isError }
}

const rl = readline.createInterface({ input: process.stdin, terminal: false })

rl.on('line', (line) => {
  const s = line.trim()
  if (!s) return
  let msg
  try {
    msg = JSON.parse(s)
  } catch {
    return
  }
  if (msg.jsonrpc !== '2.0') return
  const { id, method, params } = msg
  if (method === 'notifications/cancelled') {
    const requestId = params?.requestId
    const bridgeId = mcpToBridge.get(requestId)
    if (bridgeId !== undefined) {
      const p = pending.get(bridgeId)
      if (p) {
        clearTimeout(p.timer)
        pending.delete(bridgeId)
        p.reject(new Error('MCP 请求已取消。'))
      }
      try { ws?.send(JSON.stringify({ id: bridgeId, cancel: true })) } catch {}
      mcpToBridge.delete(requestId)
    }
    return
  }

  // 通知（无 id）
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') return
    if (method === 'notifications/roots/list') return
    return
  }

  switch (method) {
    case 'initialize':
      rpcResult(id, {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'aa-browser', title: 'Aa Browser', version: VERSION }
      })
      break
    case 'ping':
      rpcResult(id, {})
      break
    case 'tools/list':
      rpcResult(id, {
        tools: TOOL_DEFS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { title: t.title }
        }))
      })
      break
    case 'tools/call': {
      const name = params?.name
      const args = params?.arguments ?? {}
      const def = TOOL_DEFS.find((t) => t.name === name)
      if (!def) {
        rpcError(id, -32602, `未知工具: ${name}`)
        break
      }
      callTool(name, { ...args, __mcpId: id })
        .then((result) => {
          if (mcpToBridge.has(id)) {
            mcpToBridge.delete(id)
            rpcResult(id, toolResultForMcp(result))
          }
        })
        .catch((err) => {
          if (!mcpToBridge.has(id)) return
          mcpToBridge.delete(id)
          // 工具级错误按 MCP 规范放在结果里（isError: true）
          rpcResult(id, {
            content: [{ type: 'text', text: String(err?.message ?? err) }],
            isError: true
          })
        })
      break
    }
    case 'resources/list':
      rpcResult(id, { resources: [] })
      break
    case 'prompts/list':
      rpcResult(id, { prompts: [] })
      break
    case 'completion/complete':
      rpcResult(id, { completion: { values: [] } })
      break
    default:
      rpcError(id, -32601, `方法不支持: ${method}`)
  }
})

rl.on('close', () => {
  try { ws?.close() } catch {}
  process.exit(0)
})

process.on('SIGINT', () => {
  try { ws?.close() } catch {}
  process.exit(0)
})

log(`stdio MCP bridge started (waiting for client initialize)`)
