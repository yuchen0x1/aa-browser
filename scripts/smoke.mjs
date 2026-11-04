#!/usr/bin/env node
/**
 * Aa Browser 端到端冒烟测试。
 *
 * 流程：
 *   1. 确认/启动 Aa Browser 桌面应用（读 ~/.aabrowser/connection.json）
 *   2. 启动 MCP stdio 桥（cli/mcp.mjs），按 MCP 协议握手
 *   3. 在本地测试页上执行：导航 → 快照 → 输入 → 点击 → 断言 → 下拉选择 → 提取 → 截图
 *
 * 用法：npm run build && npm run smoke
 * （若 Aa Browser 已在运行则复用；由本脚本启动的实例会在结束时关闭）
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import readline from 'node:readline'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const CONNECT_FILE = path.join(os.homedir(), '.aabrowser', 'connection.json')
const TEST_PAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'test-page.html')

let failures = 0
function check(name, cond, detail = '') {
  const ok = !!cond
  console.log(`${ok ? '  ✅' : '  ❌'} ${name}${ok || !detail ? '' : ' —— ' + detail}`)
  if (!ok) failures++
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readConnection() {
  try {
    const info = JSON.parse(fs.readFileSync(CONNECT_FILE, 'utf-8'))
    if (!info.port || !info.token || !info.pid) return null
    if (!isPidAlive(info.pid)) return null
    return info
  } catch {
    return null
  }
}

/** 若 Aa Browser 未运行，用已构建的产物启动它 */
async function ensureAppRunning() {
  let info = readConnection()
  if (info) {
    console.log(`发现运行中的 Aa Browser (pid=${info.pid})，直接复用`)
    return { info, spawned: false }
  }
  console.log('未发现运行中的 Aa Browser，正在启动…')
  const electronPath = require('electron')
  const child = spawn(electronPath, ['.'], { cwd: ROOT, detached: true, stdio: 'ignore' })
  child.unref()
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    await sleep(500)
    info = readConnection()
    if (info) return { info, spawned: true }
  }
  throw new Error('启动 Aa Browser 超时（25s）。请先 npm run build。')
}

/* ── 最小 MCP stdio 客户端 ── */
class McpClient {
  constructor() {
    this.child = spawn(process.execPath, [path.join(ROOT, 'cli', 'mcp.mjs')], { stdio: ['pipe', 'pipe', 'pipe'] })
    this.child.stderr.on('data', () => {}) // 丢弃桥的日志
    this.nextId = 1
    this.buffer = ''
    this.pending = new Map()
    const rl = readline.createInterface({ input: this.child.stdout })
    rl.on('line', (line) => {
      const s = line.trim()
      if (!s) return
      let msg
      try {
        msg = JSON.parse(s)
      } catch {
        return
      }
      if (typeof msg.id === 'number' && this.pending.has(msg.id)) {
        const { resolve } = this.pending.get(msg.id)
        this.pending.delete(msg.id)
        resolve(msg)
      }
    })
  }

  request(method, params, timeoutMs = 90000) {
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP 请求超时: ${method}`))
      }, timeoutMs)
      this.pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v) }, })
      this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    })
  }

  async initialize() {
    const res = await this.request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'aa-smoke', version: '0.0.1' }
    })
    this.request('notifications/initialized', undefined).catch(() => {})
    return res
  }

  async call(name, args) {
    const res = await this.request('tools/call', { name, arguments: args ?? {} })
    if (res.error) throw new Error(`工具 ${name} 协议错误: ${res.error.message}`)
    return res.result
  }

  text(result) {
    const t = (result?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')
    return t
  }

  stop() {
    try {
      this.child.stdin.end()
      this.child.kill()
    } catch {}
  }
}

/** 从快照文本里提取某个元素行的 ref */
function findRef(snapshotText, pattern) {
  const lines = snapshotText.split('\n').filter((l) => l.includes('['))
  for (const l of lines) {
    if (pattern.test(l)) {
      const m = /\[ref=(e\d+)\]/.exec(l)
      if (m) return m[1]
    }
  }
  return null
}

async function main() {
  const { info, spawned } = await ensureAppRunning()
  let appProc = null
  console.log(`Aa Browser ready: ws://127.0.0.1:${info.port}`)

  const mcp = new McpClient()
  try {
    console.log('\n[1] MCP 握手')
    const init = await mcp.initialize()
    check('initialize 返回 serverInfo', init?.result?.serverInfo?.name === 'aa-browser')

    const list = await mcp.request('tools/list', {})
    const toolNames = (list?.result?.tools ?? []).map((t) => t.name)
    check('tools/list ≥ 12 个工具', toolNames.length >= 12, `实际 ${toolNames.length}`)

    console.log('\n[2] 导航到本地测试页（内嵌完整快照）')
    const fileUrl = 'file:///' + TEST_PAGE.replace(/\\/g, '/')
    const nav = await mcp.call('browser_navigate', { url: fileUrl })
    check('导航成功', !nav.isError, mcp.text(nav).slice(0, 200))
    const navText = mcp.text(nav)
    check('导航结果内嵌完整快照', navText.includes('页面快照（完整）') && navText.includes('Aa 快照引擎测试页'), navText.slice(0, 200))

    console.log('\n[3] refs 来自导航内嵌快照')
    const inputRef = findRef(navText, /textbox/)
    check('找到输入框 ref', !!inputRef, navText.slice(0, 400))
    const buttonRef = findRef(navText, /- button/)
    check('找到按钮 ref', !!buttonRef)
    const selectRef = findRef(navText, /combobox/)
    check('找到下拉框 ref', !!selectRef)
    const checkRef = findRef(navText, /checkbox/)
    check('找到复选框 ref', !!checkRef)

    console.log('\n[3b] 增量：导航后立即快照')
    const snap2 = await mcp.call('browser_snapshot', {})
    const snap2Text = mcp.text(snap2)
    check('页面未变 → 一行回复', snap2Text.includes('页面快照（无变化）'), snap2Text.slice(0, 200))
    check('无变化回复极短（降 token）', snap2Text.length < 400, `实际 ${snap2Text.length} 字符`)

    console.log('\n[4] 输入文本')
    const typed = await mcp.call('browser_type', { ref: inputRef, text: '你好 Aa' })
    check('输入成功', !typed.isError, mcp.text(typed).slice(0, 120))

    console.log('\n[5] 点击搜索按钮')
    const clicked = await mcp.call('browser_click', { ref: buttonRef })
    check('点击成功', !clicked.isError, mcp.text(clicked).slice(0, 160))
    const clickSnap = mcp.text(clicked)
    check('点击后结果出现（端到端闭环）', clickSnap.includes('已搜索: 你好 Aa'), clickSnap.slice(0, 400))
    check('点击返回增量快照（仅变更区块）', clickSnap.includes('页面快照（增量）'), clickSnap.slice(0, 200))

    console.log('\n[6] 下拉选择（复用首次快照的 ref → 验证 ref 跨快照稳定）')
    const sel = await mcp.call('browser_select_option', { ref: selectRef, label: 'English' })
    check('ref 跨快照仍然有效且选择成功', !sel.isError, mcp.text(sel).slice(0, 160))

    console.log('\n[7] 复选框点击')
    const chk = await mcp.call('browser_click', { ref: checkRef, snapshot: false })
    check('复选框点击成功', !chk.isError, mcp.text(chk).slice(0, 120))

    console.log('\n[8] 文本提取')
    const ext = await mcp.call('browser_extract', {})
    const extText = mcp.text(ext)
    check('提取包含搜索结果', extText.includes('已搜索: 你好 Aa'), extText.slice(0, 300))
    check('提取包含语言状态', extText.includes('English'))

    console.log('\n[9] 等待与截图')
    const wait = await mcp.call('browser_wait', { text: '已搜索', timeoutMs: 5000 })
    check('等待文本出现', !wait.isError, mcp.text(wait))
    const shot = await mcp.call('browser_screenshot', {})
    const hasImage = (shot?.content ?? []).some((c) => c.type === 'image')
    check('截图返回图像', hasImage, mcp.text(shot))

    console.log('\n[10] 标签管理')
    const tabs = await mcp.call('browser_tabs', { action: 'list' })
    check('列出标签页', mcp.text(tabs).includes('★活动'), mcp.text(tabs).slice(0, 200))

    console.log('\n[11] 强制完整快照')
    const fullSnap = await mcp.call('browser_snapshot', { full: true })
    const fullText = mcp.text(fullSnap)
    check('full:true 返回完整树', fullText.includes('页面快照（完整）'), fullText.slice(0, 160))
    check('完整树与增量内容一致', fullText.includes('已搜索: 你好 Aa'))

    console.log('\n[12] 网络抓包')
    // 本地 HTTP 服务：页面加载时 fetch /api/data → 产生可断言的网络请求
    const server = http.createServer((req, res) => {
      if (req.url && req.url.startsWith('/api/data')) {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true, msg: '网络抓包测试内容' }))
      } else {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(
          '<html><body><h1>抓包测试页</h1><div id="out"></div><script>' +
            'fetch("/api/data").then(r=>r.json()).then(d=>{document.getElementById("out").textContent="接口返回: "+d.msg})' +
            '</script></body></html>'
        )
      }
    })
    await new Promise((r) => server.listen(0, '127.0.0.1', r))
    const port = server.address().port
    try {
      const nav2 = await mcp.call('browser_navigate', { url: `http://127.0.0.1:${port}/`, snapshot: false })
      check('导航到抓包测试页', !nav2.isError, mcp.text(nav2))
      await mcp.call('browser_wait', { text: '接口返回', timeoutMs: 8000 })

      const reqs = await mcp.call('browser_network_requests', { urlContains: '/api/' })
      const reqText = mcp.text(reqs)
      check('抓到 /api/data 请求', reqText.includes('/api/data'), reqText.slice(0, 300))
      check('请求状态 200', reqText.includes(' 200 '), reqText.slice(0, 300))
      const reqIdMatch = /\[(\d+(?:\.\d+)?)\]/.exec(reqText)
      check('拿到请求 id', !!reqIdMatch, reqText.slice(0, 200))

      const detail = await mcp.call('browser_network_detail', { requestId: reqIdMatch[1], body: true })
      const detailText = mcp.text(detail)
      check('详情含响应头', detailText.toLowerCase().includes('content-type'), detailText.slice(0, 300))
      check('详情含响应体（Agent 可读 API 响应）', detailText.includes('网络抓包测试内容'), detailText.slice(0, 400))

      const har = await mcp.call('browser_har', {})
      const harText = mcp.text(har)
      const harPath = /已导出: (.+)$/m.exec(harText)?.[1]
      check('HAR 导出成功', !!harPath, harText)
      if (harPath) {
        const harJson = JSON.parse(fs.readFileSync(harPath, 'utf-8'))
        check('HAR 结构有效（log.entries）', Array.isArray(harJson?.log?.entries) && harJson.log.entries.length > 0)
      }
    } finally {
      server.close()
    }
  } finally {
    mcp.stop()
  }

  // 只关闭由本脚本启动的浏览器实例
  if (spawned) {
    try {
      process.kill(info.pid)
      await sleep(800)
    } catch {}
  }

  if (failures > 0) {
    console.error(`\n🚨 冒烟测试失败：${failures} 项未通过`)
    process.exit(1)
  }
  console.log('\n🎉 冒烟测试全部通过')
  process.exit(0)
}

main().catch((err) => {
  console.error('🚨 冒烟测试异常:', err.message)
  process.exit(1)
})
