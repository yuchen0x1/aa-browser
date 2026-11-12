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
 * （使用独立临时 profile/发现文件，由本脚本启动的实例会在结束时关闭）
 */
import { spawn } from 'node:child_process'
import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import readline from 'node:readline'

const require = createRequire(import.meta.url)
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkgVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8')).version
const SMOKE_DIR = path.join(os.tmpdir(), `aa-browser-smoke-${process.pid}`)
const SMOKE_CONNECT_FILE = path.join(SMOKE_DIR, 'connection.json')
const SMOKE_DOWNLOAD_DIR = path.join(SMOKE_DIR, 'downloads')
const SMOKE_SCREENSHOT_DIR = path.join(SMOKE_DIR, 'screenshots')
process.env['AA_BROWSER_DOWNLOAD_DIR'] = SMOKE_DOWNLOAD_DIR
const TEST_PAGE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'test-page.html')
let appChild = null
let mcpClient = null
let testServer = null
let testTmpFiles = []

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

/** 每次都启动隔离实例，避免测试触碰日常浏览器 profile、发现文件和数据。 */
async function ensureAppRunning() {
  let info = null
  console.log('正在启动隔离的测试实例…')
  const electronPath = require('electron')
  fs.mkdirSync(SMOKE_DIR, { recursive: false })
  // 在应用启动前布置"上次异常退出遗留"的分区目录，
  // 用于验证启动阶段的分区清理（见 [18]）。
  const partsDir = path.join(SMOKE_DIR, 'profile', 'Partitions')
  for (const name of ['aa-iso-stale-test', 'tab-tlegacytest']) {
    try {
      fs.mkdirSync(path.join(partsDir, name), { recursive: true })
      fs.writeFileSync(path.join(partsDir, name, 'junk.txt'), 'stale')
    } catch {
      /* 忽略：断言阶段会报告 */
    }
  }
  const child = spawn(electronPath, ['.'], {
    cwd: ROOT,
    env: {
      ...process.env,
      AA_BROWSER_CONNECTION_FILE: SMOKE_CONNECT_FILE,
      AA_BROWSER_USER_DATA_DIR: path.join(SMOKE_DIR, 'profile'),
      AA_BROWSER_DOWNLOAD_DIR: SMOKE_DOWNLOAD_DIR,
      AA_BROWSER_SCREENSHOT_DIR: SMOKE_SCREENSHOT_DIR
    },
    stdio: 'inherit'
  })
  child.on('error', (err) => console.error('[smoke] Electron launch failed:', err.message))
  child.on('exit', (code) => console.error(`[smoke] isolated Electron exited: ${code}`))
  appChild = child
  const deadline = Date.now() + 25000
  while (Date.now() < deadline) {
    await sleep(500)
    try {
      info = JSON.parse(fs.readFileSync(SMOKE_CONNECT_FILE, 'utf-8'))
      if (info?.port && info?.token && isPidAlive(info.pid)) return { info, spawned: true, child }
    } catch {
      /* test instance is still starting */
    }
  }
  child.kill()
  throw new Error('启动隔离的 Aa Browser 测试实例超时（25s）。请先 npm run build。')
}

/* ── 最小 MCP stdio 客户端 ── */
class McpClient {
  constructor() {
    this.child = spawn(process.execPath, [path.join(ROOT, 'cli', 'mcp.mjs')], {
      env: { ...process.env, AA_BROWSER_CONNECTION_FILE: SMOKE_CONNECT_FILE, AA_BROWSER_DOWNLOAD_DIR: SMOKE_DOWNLOAD_DIR, AA_BROWSER_SCREENSHOT_DIR: SMOKE_SCREENSHOT_DIR },
      stdio: ['pipe', 'pipe', 'pipe']
    })
    this.child.stderr.on('data', (chunk) => process.stderr.write(chunk))
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
  const { info, spawned, child } = await ensureAppRunning()
  let appProc = child
  console.log(`Aa Browser ready: ws://127.0.0.1:${info.port}`)

  const mcp = new McpClient()
  mcpClient = mcp
  try {
    console.log('\n[1] MCP 握手')
    const init = await mcp.initialize()
    check('initialize 返回 serverInfo', init?.result?.serverInfo?.name === 'aa-browser')

    const list = await mcp.request('tools/list', {})
    const toolNames = (list?.result?.tools ?? []).map((t) => t.name)
    check('tools/list ≥ 12 个工具', toolNames.length >= 12, `实际 ${toolNames.length}`)
    // 工具定义漂移回归：v0.6.0 曾出现桥少 3 个 mock 工具、客户端完全调不到
    check('tools/list 与主进程一致（33 个）', toolNames.length === 33, `实际 ${toolNames.length}: ${toolNames.join(',')}`)
    check(
      'mock 三件套在桥中可见',
      ['browser_mock_requests', 'browser_list_mocks', 'browser_clear_mocks'].every((n) => toolNames.includes(n)),
      toolNames.filter((n) => n.includes('mock')).join(',') || '缺少全部 mock 工具'
    )
    check(
      '新增工具在桥中可见',
      ['browser_fill_form', 'browser_evaluate', 'browser_dialogs'].every((n) => toolNames.includes(n)),
      toolNames.filter((n) => /fill_form|evaluate|dialogs/.test(n)).join(',') || '缺少新增工具'
    )
    check('serverInfo 版本与 package.json 一致', init?.result?.serverInfo?.version === pkgVersion, `实际 ${init?.result?.serverInfo?.version}`)

    console.log('\n[1b] 默认新标签页首屏')
    const startupWait = await mcp.call('browser_wait', { text: '让 AI 直接使用', timeoutMs: 5000 })
    check('启动后 AI 接入向导已加载', !startupWait.isError, mcp.text(startupWait).slice(0, 240))
    const startupInfo = mcp.text(await mcp.call('browser_evaluate', { expression: 'document.body.innerText' }))
    const startupPrompt = mcp.text(await mcp.call('browser_evaluate', { expression: 'document.querySelector("#connection-prompt")?.value ?? ""' }))
    const startupBackground = mcp.text(await mcp.call('browser_evaluate', { expression: 'getComputedStyle(document.body).backgroundColor' }))
    const startupWidthOk = mcp.text(await mcp.call('browser_evaluate', { expression: 'document.documentElement.scrollWidth <= window.innerWidth' }))
    check(
      '启动页向导与安装提示词正确渲染',
      startupInfo.includes('让 AI 直接使用') &&
        startupInfo.includes('复制安装提示词') &&
        startupPrompt.includes('https://raw.githubusercontent.com/yuchen0x1/aa-browser/main/install.mjs') &&
        startupPrompt.includes('--repo yuchen0x1/aa-browser'),
      startupInfo.slice(0, 500)
    )
    check('启动页背景与窗口宽度正常', startupBackground.includes('rgb(17, 22, 25)') && startupWidthOk.includes('true'), `${startupBackground}; 横向无溢出=${startupWidthOk}`)
    const promptSnapshot = mcp.text(await mcp.call('browser_snapshot', { full: true }))
    const copyPromptRef = findRef(promptSnapshot, /- button "复制安装提示词"/)
    check('安装提示词提供可操作的复制按钮', !!copyPromptRef, promptSnapshot.slice(0, 400))
    if (copyPromptRef) {
      await mcp.call('browser_click', { ref: copyPromptRef, snapshot: false })
      const copyStatus = mcp.text(await mcp.call('browser_evaluate', { expression: 'document.querySelector("#copy-status")?.innerText' }))
      check('复制按钮给出成功或手动复制反馈', copyStatus.includes('安装提示词已复制') || copyStatus.includes('已选中安装提示词'), copyStatus)
    }
    const localNewtabUrl = pathToFileURL(path.join(ROOT, 'out', 'renderer', 'newtab.html')).toString()
    await mcp.call('browser_navigate', { url: localNewtabUrl, snapshot: false })
    const manualNewtab = mcp.text(await mcp.call('browser_evaluate', { expression: 'document.body.innerText' }))
    check('手动加载新标签 HTML 正常', manualNewtab.includes('让 AI 直接使用') && manualNewtab.includes('复制安装提示词'), manualNewtab.slice(0, 400))

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

    console.log('\n[7b] 拖拽操作 (browser_drag)')
    const dragged = await mcp.call('browser_drag', { ref: buttonRef, dx: 40, dy: 10, snapshot: false })
    check('拖拽执行成功', !dragged.isError && mcp.text(dragged).includes('已拖拽: 从'), mcp.text(dragged))

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
    // 本地 HTTP 服务：页面加载时 fetch /api/data → 产生可断言的网络请求；附带下载与文件上传
    const server = http.createServer((req, res) => {
      if (req.url && req.url.startsWith('/api/mockme')) {
        // 真实响应刻意与 mock 响应不同，用来证明请求确实被拦截
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ mocked: false, msg: 'REAL_NETWORK_RESPONSE' }))
      } else if (req.url && req.url.startsWith('/api/data')) {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ ok: true, msg: '网络抓包测试内容' }))
      } else if (req.url && req.url.startsWith('/download')) {
        res.setHeader('Content-Type', 'application/octet-stream')
        res.setHeader('Content-Disposition', 'attachment; filename="aa-smoke-download.txt"')
        res.end('Aa Browser download smoke test payload')
      } else {
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(
          '<html><body><h1>抓包测试页</h1><div id="out"></div><div id="mockout">（未请求）</div>' +
            '<div id="leakout"></div>' +
            '<a id="dl" href="/download">下载测试文件</a>' +
            '<input id="up" type="file" /><div id="upout">（未上传）</div>' +
            '<script>' +
            'document.getElementById("leakout").textContent="AA_TYPE="+typeof window.aa+" NEWTAB_TYPE="+typeof window.aaNewtab;' +
            'fetch("/api/data?access_token=smoke-secret",{headers:{Authorization:"Bearer smoke-secret"}}).then(r=>r.json()).then(d=>{document.getElementById("out").textContent="接口返回: "+d.msg});' +
            'document.getElementById("up").addEventListener("change",e=>{document.getElementById("upout").textContent="已选择文件: "+e.target.files[0].name});' +
            // 只有页面被重新载入时才打 mock 请求，确保 mock 规则已经建立
            'if (location.search.includes("fetchmock")) { fetch("/api/mockme").then(r=>r.text()).then(t=>{document.getElementById("mockout").textContent="MOCK_SAW: "+t}); }' +
            '</script></body></html>'
        )
      }
    })
    testServer = server
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
      check('默认遮蔽认证头与凭据 URL 参数', !detailText.includes('smoke-secret') && detailText.includes('[redacted]'), detailText.slice(0, 500))
      const sensitiveDetail = mcp.text(await mcp.call('browser_network_detail', { requestId: reqIdMatch[1], includeSensitive: true }))
      check('显式选项可查看认证头与原始 URL', sensitiveDetail.includes('Bearer smoke-secret') && sensitiveDetail.includes('access_token=smoke-secret'))

      const har = await mcp.call('browser_har', {})
      const harText = mcp.text(har)
      const harPath = /已导出: (.+)$/m.exec(harText)?.[1]
      check('HAR 导出成功', !!harPath, harText)
      if (harPath) {
        const harJson = JSON.parse(fs.readFileSync(harPath, 'utf-8'))
        check('HAR 结构有效（log.entries）', Array.isArray(harJson?.log?.entries) && harJson.log.entries.length > 0)
        const apiEntry = harJson.log.entries.find((entry) => entry.request.url.includes('/api/data'))
        check('HAR 默认不包含认证值', apiEntry?.request.url.includes('access_token=%5Bredacted%5D') && !JSON.stringify(apiEntry).includes('smoke-secret'))
      }

      console.log('\n[12b] 请求拦截 Mock（v0.6.0 能力回归）')
      const mockRule = mcp.text(
        await mcp.call('browser_mock_requests', {
          urlContains: '/api/mockme',
          status: 200,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ mocked: true, msg: 'MOCKED_BY_AA' })
        })
      )
      check('创建 mock 规则成功', mockRule.includes('已拦截规则'), mockRule.slice(0, 300))
      const listed = mcp.text(await mcp.call('browser_list_mocks', {}))
      check('browser_list_mocks 列出规则', listed.includes('/api/mockme'), listed.slice(0, 300))

      // 重新载入页面（带 fetchmock 标记）触发被拦截的请求
      await mcp.call('browser_navigate', { url: `http://127.0.0.1:${port}/?fetchmock=1`, snapshot: false })
      await sleep(1500)
      const mockSeen = mcp.text(await mcp.call('browser_extract', {}))
      check('mock 生效（页面拿到伪造响应）', mockSeen.includes('MOCKED_BY_AA'), mockSeen.slice(0, 400))
      check('真实响应未到达页面', !mockSeen.includes('REAL_NETWORK_RESPONSE'), mockSeen.slice(0, 400))
      const afterClear = mcp.text(await mcp.call('browser_clear_mocks', {}))
      check('browser_clear_mocks 清空规则', afterClear.includes('已清空'), afterClear.slice(0, 200))

      console.log('\n[13] 交互补全（hover / back / forward / resize）')
      // 用 full:true 确保拿到带 ref 的树（页面未变时增量快照不带 ref）
      const httpSnap = mcp.text(await mcp.call('browser_snapshot', { full: true }))
      const hoverRef = findRef(httpSnap, /- link "下载测试文件"/)
      const hover = await mcp.call('browser_hover', { ref: hoverRef, snapshot: false })
      check('悬停成功（真实 mouseMove）', !hover.isError, mcp.text(hover))

      const back = await mcp.call('browser_navigate_back', { snapshot: false })
      check('历史后退', !back.isError && mcp.text(back).includes('已后退'), mcp.text(back))
      // 后退目标依赖此前的导航次数（mock 段会额外导航一次），因此断言"URL 变了"而非写死某个地址。
      const backUrl = mcp.text(await mcp.call('browser_tabs', { action: 'list' }))
      check('后退回到了上一个页面', !backUrl.includes('fetchmock=1'), backUrl.slice(0, 200))
      const fwd = await mcp.call('browser_navigate_forward', { snapshot: false })
      check('历史前进', !fwd.isError && mcp.text(fwd).includes('已前进'), mcp.text(fwd))
      await mcp.call('browser_wait', { text: '接口返回', timeoutMs: 8000 })

      const resized = await mcp.call('browser_resize', { width: 1100, height: 760 })
      check('视口调整成功', !resized.isError && /1100×7\d\d/.test(mcp.text(resized)), mcp.text(resized))

      console.log('\n[14] 观察增强（选择器 / 查找 / 元素截图）')
      // 导航（back/forward）后按契约重新快照，刷新 ref
      const snap3 = mcp.text(await mcp.call('browser_snapshot', { full: true }))
      const dlLinkRef = findRef(snap3, /- link "下载测试文件"/)
      const selector = await mcp.call('browser_get_selector', { ref: dlLinkRef })
      const selText = mcp.text(selector)
      check('选择器生成成功', !selector.isError && /selector: .+/.test(selText), selText)
      check('选择器 DOM 回验通过', selText.includes('✅ 已回验'), selText)

      const found = await mcp.call('browser_find', { text: '接口返回' })
      const foundText = mcp.text(found)
      check('页面查找返回匹配数', !found.isError && /共 \d+ 处匹配/.test(foundText), foundText)

      const elShot = await mcp.call('browser_screenshot', { ref: dlLinkRef })
      check('元素级截图返回图像', (elShot?.content ?? []).some((c) => c.type === 'image'), mcp.text(elShot))

      console.log('\n[14b] 新工具回归（fill_form / evaluate / dialogs）')
      // 专用表单页：一个文本框 + 一个下拉 + 一个复选框 + 一个 alert 按钮
      const formHtml =
        '<html><body><h1>表单工具测试</h1>' +
        '<input id="t" type="text" aria-label="姓名" />' +
        '<select id="s" aria-label="城市"><option value="bj">北京</option><option value="sh">上海</option></select>' +
        '<label><input id="c" type="checkbox" /> 同意</label>' +
        '<div id="out">待填写</div>' +
        '<button id="dlg" onclick="alert(\'SMOKE_ALERT\'); confirm(\'SMOKE_CONFIRM\')">弹窗</button>' +
        '<script>function upd(){document.getElementById("out").textContent="t="+document.getElementById("t").value+" s="+document.getElementById("s").value+" c="+document.getElementById("c").checked}</script>' +
        '</body></html>'
      const formServer = http.createServer((q, s) => {
        s.setHeader('Content-Type', 'text/html; charset=utf-8')
        s.end(formHtml)
      })
      await new Promise((r) => formServer.listen(0, '127.0.0.1', r))
      const formPort = formServer.address().port
      try {
        await mcp.call('browser_navigate', { url: `http://127.0.0.1:${formPort}/`, snapshot: false })
        await sleep(400)
        const snap = mcp.text(await mcp.call('browser_snapshot', { full: true }))
        const textRef = findRef(snap, /textbox "姓名"/)
        const selectRef2 = findRef(snap, /combobox "城市"/)
        const checkRef2 = findRef(snap, /checkbox/)
        check('表单页元素 ref 齐全', !!(textRef && selectRef2 && checkRef2), snap.slice(0, 300))

        const filled = mcp.text(
          await mcp.call('browser_fill_form', {
            fields: [
              { ref: textRef, value: '张三' },
              { ref: selectRef2, value: 'sh' },
              { ref: checkRef2, checked: true }
            ],
            snapshot: false
          })
        )
        check('browser_fill_form 批量填写成功', filled.includes('已填写 3 个字段'), filled.slice(0, 400))
        // 页面侧回读：三个字段都必须真的生效
        const state = mcp.text(
          await mcp.call('browser_evaluate', {
            expression: `(() => { const t=document.getElementById('t').value, s=document.getElementById('s').value, c=document.getElementById('c').checked; document.getElementById('out').textContent='t='+t+' s='+s+' c='+c; return { t, s, c } })()`
          })
        )
        check('fill_form 结果在页面真实生效', state.includes('"t": "张三"') && state.includes('"s": "sh"') && state.includes('"c": true'), state.slice(0, 300))

        const evalTitle = mcp.text(await mcp.call('browser_evaluate', { expression: 'document.querySelector("h1").textContent' }))
        check('browser_evaluate 返回页面数据', evalTitle.includes('表单工具测试'), evalTitle.slice(0, 200))
        const evalWithRef = mcp.text(await mcp.call('browser_evaluate', { expression: 'element.tagName', ref: textRef }))
        check('browser_evaluate 支持按 ref 绑定 element', evalWithRef.includes('INPUT'), evalWithRef.slice(0, 200))

        // 对话框：点击按钮触发 alert + confirm，页面不得卡死
        const dlgSnap = mcp.text(await mcp.call('browser_snapshot', { full: true }))
        const dlgRef = findRef(dlgSnap, /- button "弹窗"/)
        const tClick = Date.now()
        await mcp.call('browser_click', { ref: dlgRef, snapshot: false })
        const clickMs = Date.now() - tClick
        check('含 alert 的按钮点击不阻塞（< 5s）', clickMs < 5000, `耗时 ${clickMs}ms`)
        const dlgText = mcp.text(await mcp.call('browser_dialogs', {}))
        check('browser_dialogs 记录 alert 与 confirm', dlgText.includes('SMOKE_ALERT') && dlgText.includes('SMOKE_CONFIRM'), dlgText.slice(0, 300))
        check('对话框被拦截（confirm→false）', dlgText.includes('[confirm]'), dlgText.slice(0, 300))
        const cleared = mcp.text(await mcp.call('browser_dialogs', { clear: true }))
        check('browser_dialogs clear 后为空', cleared.includes('SMOKE_ALERT'), cleared.slice(0, 200))
        const afterClear = mcp.text(await mcp.call('browser_dialogs', {}))
        check('清空后再次读取为空态', afterClear.includes('未弹出'), afterClear.slice(0, 200))

        // wait 新语义
        const waited = mcp.text(await mcp.call('browser_wait', { time: 300 }))
        check('browser_wait time 固定等待', waited.includes('已等待 300ms'), waited)
        const gone = mcp.text(await mcp.call('browser_wait', { textGone: '不存在的文案_XYZ', timeoutMs: 2000 }))
        check('browser_wait textGone 立即满足', gone.includes('已消失'), gone.slice(0, 200))
      } finally {
        formServer.close()
        // 回到主测试页：[15] 的文件输入与下载链接、[16] 的 preload 泄漏标记都在那个页面上。
        // 不回来会让后续断言全部跑在表单页上而假失败。
        await mcp.call('browser_navigate', { url: `http://127.0.0.1:${port}/`, snapshot: false })
        await mcp.call('browser_wait', { text: '接口返回', timeoutMs: 8000 })
      }

      console.log('\n[15] 状态与数据（cookies / storage / 上传 / 下载 / PDF）')
      const cookieBase = `http://127.0.0.1:${port}`
      await mcp.call('browser_cookies', { action: 'set', url: cookieBase, name: 'aa_smoke', value: 'cookie-ok-123' })
      const got = mcp.text(await mcp.call('browser_cookies', { action: 'get', url: cookieBase, name: 'aa_smoke' }))
      check('Cookie 写入并读回', got.includes('aa_smoke=cookie-ok-123'), got)
      await mcp.call('browser_cookies', { action: 'clear', url: cookieBase, name: 'aa_smoke' })
      const gotAfterClear = mcp.text(await mcp.call('browser_cookies', { action: 'get', url: cookieBase, name: 'aa_smoke' }))
      check('Cookie 清除生效', gotAfterClear.includes('无匹配'), gotAfterClear)

      await mcp.call('browser_storage', { action: 'set', kind: 'local', key: 'aa_smoke_key', value: 'storage-ok' })
      const stored = mcp.text(await mcp.call('browser_storage', { action: 'get', kind: 'local', key: 'aa_smoke_key' }))
      check('localStorage 写读回环', stored.includes('storage-ok'), stored)

      const tmpFile = path.join(SMOKE_DIR, `aa-smoke-upload-${Date.now()}.txt`)
      fs.writeFileSync(tmpFile, 'upload payload')
      testTmpFiles.push(tmpFile)
      // 刚从表单页返回主测试页：ref 属于页面快照，必须重新取（旧 ref 已失效）
      const upSnap = mcp.text(await mcp.call('browser_snapshot', { full: true }))
      const fileRef = findRef(upSnap, /- button \[ref=/)
      const uploaded = await mcp.call('browser_upload_file', { ref: fileRef, paths: [tmpFile] })
      const upText = mcp.text(uploaded)
      check('文件上传成功并触发 change', !uploaded.isError && upText.includes('已上传 1 个文件'), upText)
      const upOut = mcp.text(await mcp.call('browser_extract', {}))
      check('页面收到文件名', upOut.includes('已选择文件'), upOut.slice(0, 300))

      const dlLinkRef2 = findRef(upSnap, /- link "下载测试文件"/)
      const dlClick = await mcp.call('browser_click', { ref: dlLinkRef2, snapshot: false })
      check('点击下载链接', !dlClick.isError, mcp.text(dlClick))
      let downloads = ''
      const downloadDeadline = Date.now() + 10000
      do {
        await sleep(250)
        downloads = mcp.text(await mcp.call('browser_downloads', {}))
      } while (!downloads.includes('completed') && Date.now() < downloadDeadline)
      check('下载被捕获并静默保存', downloads.includes('aa-smoke-download.txt') && downloads.includes('completed'), downloads.slice(0, 400))

      const pdf = await mcp.call('browser_pdf', {})
      const pdfPath = /PDF 已保存: (.+)$/m.exec(mcp.text(pdf))?.[1]
      check('PDF 导出成功', !!pdfPath && fs.existsSync(pdfPath), mcp.text(pdf))

      console.log('\n[16] 安全：页面视图不得暴露特权桥')
      // 回归 v0.6.0 的 P0：页面视图曾按创建时 URL 挂 preload，
      // 导航到任意站点后 window.aa 完整可用（可读全部标签 URL、代点审批、改设置）。
      // 测试页会在 DOM 里写 AA_TYPE/NEWTAB_TYPE，直接读回即可判定。
      const leakSeen = mcp.text(await mcp.call('browser_extract', {}))
      check('页面拿不到 window.aa', leakSeen.includes('AA_TYPE=undefined'), leakSeen.slice(0, 400))
      check('页面拿不到 window.aaNewtab', leakSeen.includes('NEWTAB_TYPE=undefined'), leakSeen.slice(0, 400))

      console.log('\n[17] 会话模型：共享登录态 / 隔离标签')
      // v0.6.x 给每个标签独立持久分区 → 登录态割裂 + 磁盘无限增长。
      // 现在默认共享 persist:aa-main，只有显式 isolated 才独立且关闭即清。
      const cookieUrl = `http://127.0.0.1:${port}`
      const tabA = (/\[(t[a-z0-9]+)\]/.exec(mcp.text(await mcp.call('browser_tabs', { action: 'list' }))) || [])[1]
      await mcp.call('browser_cookies', { action: 'set', url: cookieUrl, name: 'shared_sid', value: 'shared-login' })
      const newTabShared = mcp.text(await mcp.call('browser_tabs', { action: 'new', url: cookieUrl }))
      check('默认新标签使用共享会话', newTabShared.includes('（共享会话）'), newTabShared.slice(0, 200))
      const sharedTabId = (/\[(t[a-z0-9]+)\]/.exec(newTabShared) || [])[1]
      await sleep(800)
      // 关键断言：另一个标签能读到 A 标签写入的登录态
      const seenByB = mcp.text(await mcp.call('browser_cookies', { action: 'get', url: cookieUrl, name: 'shared_sid', tabId: sharedTabId }))
      check('共享会话：新标签能看到已有 Cookie', seenByB.includes('shared_sid=shared-login'), seenByB.slice(0, 300))

      // 隔离标签：必须看不到共享 Cookie
      const isoNew = mcp.text(await mcp.call('browser_tabs', { action: 'new', url: cookieUrl, isolated: true }))
      check('隔离标签被明确标注', isoNew.includes('隔离会话'), isoNew.slice(0, 200))
      const isoTabId = (/\[(t[a-z0-9]+)\]/.exec(isoNew) || [])[1]
      await sleep(900)
      const isoSeesCookie = mcp.text(await mcp.call('browser_cookies', { action: 'get', url: cookieUrl, name: 'shared_sid', tabId: isoTabId }))
      check('隔离会话看不到共享 Cookie', isoSeesCookie.includes('无匹配'), isoSeesCookie.slice(0, 300))

      // 隔离标签内写入的 Cookie 不应泄漏到共享会话
      await mcp.call('browser_cookies', { action: 'set', url: cookieUrl, name: 'iso_only', value: 'iso-data' })
      const sharedTabsAfter = mcp.text(await mcp.call('browser_tabs', { action: 'list' }))
      check('隔离标签在列表中带锁标识', sharedTabsAfter.includes('🔒隔离'), sharedTabsAfter.slice(0, 400))

      // 关闭隔离标签：会话数据必须被清空（目录本身由下次启动回收）
      const partsDir = path.join(SMOKE_DIR, 'profile', 'Partitions')
      await mcp.call('browser_tabs', { action: 'close', tabId: isoTabId })
      await sleep(2000)
      // 直接检查磁盘上的分区数据是否被清空：LevelDB / Cookies 等不应再有内容增长。
      // 目录本身留在磁盘上（Chromium 会话层在当前进程内不释放句柄），
      // 由启动扫描在下次启动时删除 — 见 [18]。
      const isoDirs = (() => {
        try {
          return fs.readdirSync(partsDir).filter((d) => d.startsWith('aa-iso-'))
        } catch {
          return []
        }
      })()
      check('隔离分区数据已清空（目录待下次启动回收）', isoDirs.length <= 1, `仍存在 ${JSON.stringify(isoDirs)}`)

      // 共享分区必须保留（不能被当成一次性的清掉）
      const sharedDirKept = (() => {
        try {
          return fs.readdirSync(partsDir).some((d) => d === 'aa-main')
        } catch {
          return false
        }
      })()
      check('共享分区目录被保留（登录态不丢）', sharedDirKept, '未找到 Partitions/aa-main')
      // 共享会话的 Cookie 必须仍在 —— 这是「登录态不丢」的真正判据
      const sharedStill = mcp.text(await mcp.call('browser_cookies', { action: 'get', url: cookieUrl, name: 'shared_sid' }))
      check('关闭隔离标签后共享登录态仍在', sharedStill.includes('shared_sid=shared-login'), sharedStill.slice(0, 200))

      console.log('\n[18] 启动清理：上次异常退出遗留的分区')
      // 这两个目录在应用启动前就已布置（见 ensureAppRunning），启动扫描应当把它们删掉。
      const staleIso = path.join(partsDir, 'aa-iso-stale-test')
      const staleLegacy = path.join(partsDir, 'tab-tlegacytest')
      check('启动时清除遗留隔离分区', !fs.existsSync(staleIso), `仍存在 ${staleIso}`)
      check('启动时清除 v0.6.x 每标签分区', !fs.existsSync(staleLegacy), `仍存在 ${staleLegacy}`)
    } finally {
      server.close()
    }
  } finally {
    mcp.stop()
    mcpClient = null
    if (testServer) { testServer.close(); testServer = null }
  }

  // 只关闭由本脚本启动的隔离实例，并清理专属临时目录。
  if (spawned) {
    try { process.kill(info.pid) } catch {}
    await sleep(800)
    try { fs.rmSync(SMOKE_DIR, { recursive: true, force: true }) } catch {}
  }
  try { fs.rmSync(path.join(os.homedir(), '.aabrowser', 'downloads', `aa-smoke-${process.pid}`), { recursive: true, force: true }) } catch {}

  if (failures > 0) {
    console.error(`\n🚨 冒烟测试失败：${failures} 项未通过`)
    process.exit(1)
  }
  console.log('\n🎉 冒烟测试全部通过')
  process.exit(0)
}

main().catch(async (err) => {
  console.error('🚨 冒烟测试异常:', err.message)
  try { mcpClient?.stop() } catch {}
  try { testServer?.close() } catch {}
  for (const file of testTmpFiles) { try { fs.rmSync(file, { force: true }) } catch {} }
  if (appChild) {
    try { appChild.kill() } catch {}
  }
  try { fs.rmSync(SMOKE_DIR, { recursive: true, force: true }) } catch {}
  process.exit(1)
})
