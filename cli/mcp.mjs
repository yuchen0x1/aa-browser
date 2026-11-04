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

const VERSION = '0.1.0'
const CONNECT_FILE = path.join(os.homedir(), '.aabrowser', 'connection.json')
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
      'Click an element by its snapshot ref (e.g. "e12"). An incremental snapshot is returned afterwards so you can see the result and continue.',
    inputSchema: {
      type: 'object',
      properties: {
        ref: { type: 'string', description: 'Element ref from browser_snapshot, e.g. "e12"' },
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
    description: 'Take a PNG screenshot of the active tab. Returns the image inline (for vision-capable models) and saves it under ~/.aabrowser/screenshots/.',
    inputSchema: {
      type: 'object',
      properties: { tabId: { type: 'string', description: 'Tab id (default: active tab)' } }
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
const pending = new Map() // id -> { resolve, reject, timer }

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
      socket.on('message', (raw) => {
        let msg
        try { msg = JSON.parse(raw.toString()) } catch { return }
        if (typeof msg?.id === 'number' && pending.has(msg.id)) {
          const p = pending.get(msg.id)
          clearTimeout(p.timer)
          pending.delete(msg.id)
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

async function callTool(name, args) {
  const socket = await getWs()
  const id = nextCallId++
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`工具 ${name} 执行超时（${CALL_TIMEOUT_MS / 1000}s）`))
    }, CALL_TIMEOUT_MS)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, tool: name, args: args ?? {} }))
  })
}

/* ──────────────────── MCP stdio 协议 ──────────────────── */

function send(msg) {
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

  // 通知（无 id）
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized' || method === 'notifications/cancelled') return
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
      callTool(name, args)
        .then((result) => rpcResult(id, toolResultForMcp(result)))
        .catch((err) => {
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
