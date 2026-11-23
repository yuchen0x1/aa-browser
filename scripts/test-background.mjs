// Real Electron + stdio MCP. The public site probe is opt-in; CI uses a deterministic local page.
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import readline from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket from 'ws'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const live = process.argv.includes('--live')
const soakArgument = process.argv.find((argument) => argument.startsWith('--soak='))?.slice('--soak='.length)
const soakMatch = soakArgument?.match(/^(\d+)(ms|s|m|h)$/)
const soakDurationMs = soakMatch
  ? Number(soakMatch[1]) * ({ ms: 1, s: 1000, m: 60_000, h: 3_600_000 })[soakMatch[2]]
  : 0
if (soakArgument && (!soakMatch || !Number.isSafeInteger(soakDurationMs) || soakDurationMs <= 0)) {
  throw new Error('Use --soak=<duration>, for example --soak=30m')
}
const checks = []

if (!process.versions.electron) {
  const parent = path.join(ROOT, '.local-verification')
  fs.mkdirSync(parent, { recursive: true })
  const run = fs.mkdtempSync(path.join(parent, 'background-'))
  const env = {
    ...process.env,
    AA_BROWSER_START_IN_BACKGROUND: '1',
    AA_BROWSER_TEST_NODE: process.execPath,
    AA_BROWSER_TEST_DIR: run,
    AA_BROWSER_AUTO_LAUNCH: '0',
    AA_BROWSER_USER_DATA_DIR: path.join(run, 'profile'),
    AA_BROWSER_CONNECTION_FILE: path.join(run, 'connection.json'),
    AA_BROWSER_HISTORY_DIR: path.join(run, 'history'),
    AA_BROWSER_SETTINGS_FILE: path.join(run, 'settings.json'),
    AA_BROWSER_SESSION_FILE: path.join(run, 'session.json'),
    AA_BROWSER_DOWNLOAD_DIR: path.join(run, 'downloads'),
    AA_BROWSER_SCREENSHOT_DIR: path.join(run, 'screenshots'),
    AA_BROWSER_BASELINE_DIR: path.join(run, 'baselines'),
    AA_BROWSER_MONITOR_DIR: path.join(run, 'monitor'),
    AA_BROWSER_EVIDENCE_FILE: path.join(run, 'evidence.json')
  }
  delete env.ELECTRON_RUN_AS_NODE
  // 持久化模式必须是 hidden：验证真实冷启动不会在首屏兜底或单实例唤醒时把窗口显示出来。
  fs.writeFileSync(env.AA_BROWSER_SETTINGS_FILE, JSON.stringify({ autoUpdate: false, restoreSession: false, backgroundMode: 'hidden' }))
  const child = spawn(require('electron'), [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { cwd: ROOT, env, stdio: 'inherit' })
  const timer = setTimeout(() => { console.error('Background suite timed out'); child.kill() }, Math.max(110_000, soakDurationMs + 180_000))
  child.on('error', (error) => { clearTimeout(timer); console.error(error); process.exitCode = 1 })
  child.on('exit', (code) => { clearTimeout(timer); process.exitCode = code ?? 1 })
} else {
  // Do not block Electron's ESM entry on app.whenReady().
  void runElectron().catch((error) => { console.error(error); process.exit(1) })
}

async function until(fn, description, ms = 8000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const result = await fn()
    if (result) return result
    await delay(50)
  }
  throw new Error(`Timed out: ${description}`)
}

function findRef(snapshot, pattern) {
  const result = snapshot.split('\n').find((line) => pattern.test(line))?.match(/\[ref=(e\d+)\]/)?.[1]
  assert.ok(result, `Missing snapshot reference for ${pattern}:\n${snapshot.slice(0, 4000)}`)
  return result
}

function pass(message) {
  checks.push(message)
  console.log(`PASS: ${message}`)
}

async function runElectron() {
  const { app, BaseWindow, BrowserWindow, webContents, nativeImage } = await import('electron')
  const run = process.env.AA_BROWSER_TEST_DIR
  const inputPage = `<meta charset=utf-8><title>Background fixture</title>
    <h1>Background fixture</h1><form action="/result"><input aria-label="Search query" name="q"><button>Search</button></form>
    <button id="hover">Hover probe</button><button id="click">Click probe</button><p id="effect">Waiting for click</p>
    <button id="drag-source" draggable="true" style="width:120px;height:60px;background:#2d6cdf">Drag source</button>
    <button id="drag-target" style="width:220px;height:120px;margin-top:20px;background:#dfe9ff">Drag target</button>
    <p id="drag-effect">Waiting for drag</p>
    <div style="height:2200px" aria-hidden="true"></div><p id="deep">Deep content</p>
    <style>#hover:hover { color: rgb(23, 45, 67) }</style>
    <script>let clicks=0; document.querySelector('#click').onclick = (event) => {
      document.querySelector('#effect').textContent = 'Clicks: ' + ++clicks + ' trusted: ' + event.isTrusted;
    };
    const dragSource = document.querySelector('#drag-source')
    dragSource.addEventListener('dragstart', (event) => {
      event.dataTransfer.setData('text/plain', 'drag-probe')
      event.dataTransfer.effectAllowed = 'copy'
      document.querySelector('#drag-effect').textContent = 'dragstart fired'
    })
    document.querySelector('#drag-target').addEventListener('dragover', (event) => {
      event.preventDefault()
      event.dataTransfer.dropEffect = 'copy'
    })
    document.querySelector('#drag-target').addEventListener('drop', (event) => {
      event.preventDefault()
      document.querySelector('#drag-effect').textContent = 'drop:' + event.dataTransfer.getData('text/plain')
    })</script>`
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (req.url === '/result?q=Background+testX') res.end('<title>Background result</title><h1>Background search submitted</h1><button>Result action</button>')
    else if (req.url === '/soak') res.end('<!doctype html><meta charset=utf-8><title>Background soak fixture</title><h1>Background soak fixture</h1><p>Live ticks: <output id="ticks">0</output></p><script>window.soakTicks=0;setInterval(()=>{window.soakTicks++;document.querySelector("#ticks").textContent=String(window.soakTicks);document.title=`Background soak ${window.soakTicks}`},1000)</script>')
    else res.end(inputPage)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  let bridge
  let rl
  const pending = new Map()
  const directPeers = []
  let id = 0
  let exitCode = 1
  let liveResult
  let soakResult
  const duplicateExitSignals = []
  try {
    app.setAppPath(ROOT)
    await import(pathToFileURL(path.join(ROOT, 'out/main/index.js')).href)
    await app.whenReady()
    const win = await until(() => BaseWindow.getAllWindows()[0], 'browser window')
    const chrome = await until(() => webContents.getAllWebContents().find((wc) => wc.getURL().endsWith('/renderer/index.html')), 'browser chrome')
    const ui = (script) => chrome.executeJavaScript(script)
    const state = () => ui('window.aa.getState()')
    const awakened = []
    for (const event of ['show', 'restore', 'focus']) win.on(event, () => awakened.push(event))
    // 第二个实例是否真的把启动意图交给了主实例，用主进程收到的事件判定，
    // 而不是用这个一次性进程的退出方式判定。
    const secondInstanceData = []
    app.on('second-instance', (_event, _argv, _cwd, data) => secondInstanceData.push(data))
    const stillHidden = () => { assert.equal(win.isVisible(), false); assert.equal(win.isFocused(), false); assert.deepEqual(awakened, []) }
    // 程序化最小化在 Windows 上可能保留前台状态；以最小化当时的焦点为基线，
    // 断言工具既没有唤起窗口，也没有把焦点从用户所在窗口抢回来。
    let minimizedFocused = false
    const markMinimized = () => { minimizedFocused = win.isFocused(); awakened.length = 0 }
    const stillMinimized = () => { assert.equal(win.isMinimized(), true); assert.equal(win.isFocused(), minimizedFocused); assert.deepEqual(awakened, []) }
    await until(() => fs.existsSync(process.env.AA_BROWSER_CONNECTION_FILE), 'discovery')
    bridge = spawn(process.env.AA_BROWSER_TEST_NODE, [path.join(ROOT, 'cli/mcp.mjs')], { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] })
    rl = readline.createInterface({ input: bridge.stdout })
    rl.on('line', (line) => {
      const message = JSON.parse(line)
      const waiter = pending.get(message.id)
      if (waiter) { pending.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message) }
    })
    const request = (method, params) => new Promise((resolve, reject) => {
      const requestId = ++id
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`MCP timeout: ${params?.name ?? method}`)) }, 25_000)
      pending.set(requestId, { resolve, timer })
      bridge.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`)
    })
    const call = async (name, args = {}, expectError) => {
      const response = await request('tools/call', { name, arguments: args })
      const result = response.result
      assert.equal(response.error, undefined, JSON.stringify(response.error))
      assert.ok(result, `Missing MCP result for ${name}`)
      const text = result.content.filter((part) => part.type === 'text').map((part) => part.text).join('\n')
      if (expectError) { assert.equal(result.isError, true, text); assert.match(text, expectError) }
      else assert.notEqual(result.isError, true, `${name}: ${text}`)
      return { text, content: result.content }
    }
    const connectDirectAgent = async () => {
      const info = JSON.parse(fs.readFileSync(process.env.AA_BROWSER_CONNECTION_FILE, 'utf8'))
      const endpoint = new URL(`ws://127.0.0.1:${info.port}/`)
      endpoint.searchParams.set('token', info.token)
      const socket = new WebSocket(endpoint)
      const peer = { socket, nextId: 0, pending: new Map() }
      socket.on('message', (raw) => {
        const message = JSON.parse(raw.toString())
        const waiter = peer.pending.get(message.id)
        if (!waiter) return
        peer.pending.delete(message.id)
        clearTimeout(waiter.timer)
        waiter.resolve(message)
      })
      await new Promise((resolve, reject) => {
        socket.once('open', resolve)
        socket.once('error', reject)
      })
      directPeers.push(peer)
      return peer
    }
    const callDirectAgent = (peer, name, args = {}) => new Promise((resolve, reject) => {
      const requestId = ++peer.nextId
      const timer = setTimeout(() => {
        peer.pending.delete(requestId)
        reject(new Error(`Direct MCP timeout: ${name}`))
      }, 25_000)
      peer.pending.set(requestId, { resolve, reject, timer })
      peer.socket.send(JSON.stringify({ id: requestId, tool: name, args }))
    })
    const directText = (result) => result?.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? ''
    const checkImage = (result) => {
      const part = result.content.find((item) => item.type === 'image')
      assert.ok(part, 'MCP screenshot must return image content')
      const image = nativeImage.createFromBuffer(Buffer.from(part.data, 'base64'))
      assert.ok(!image.isEmpty() && image.getSize().width > 20 && image.getSize().height > 20)
      const pixels = image.resize({ width: 64 }).toBitmap()
      assert.ok(pixels.some((value, index) => index % 4 !== 3 && value < 210), 'screenshot is blank/white')
      assert.ok(pixels.some((value, index) => index % 4 !== 3 && value > 235), 'screenshot is blank/dark')
      return part
    }
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'background-test', version: '1' } })
    assert.equal(init.result?.serverInfo?.name, 'aa-browser')
    const nav = await call('browser_navigate', { url: base })
    assert.match(nav.text, /Background fixture/)
    await delay(2600) // Includes the original deferred startup-show deadline.
    const clickRef = findRef(nav.text, /button.*Click probe/)
    await call('browser_click', { ref: clickRef, snapshot: false })
    assert.match((await call('browser_extract')).text, /Clicks: 1 trusted: true/)
    checkImage(await call('browser_screenshot'))
    stillHidden()
    pass('cold-start window stays hidden through navigation, trusted click and capture')

    // 第二个实例只负责把启动意图转交给已有实例并立刻退出。转交是否成功由主进程
    // 收到的 second-instance 数据判断；Linux/Xvfb 下 Chromium 的单例关闭路径偶尔
    // 会用信号终止这个一次性进程（Windows 本地不复现），主实例和转交结果不受影响，
    // 因此信号退出记录在案但不判失败；主动的非零退出码仍然失败。
    const launchAgain = async (background) => {
      const env = { ...process.env }
      if (background) env.AA_BROWSER_START_IN_BACKGROUND = '1'
      const before = secondInstanceData.length
      const child = spawn(process.execPath, [ROOT], { cwd: ROOT, env, stdio: ['ignore', 'ignore', 'pipe'] })
      let stderr = ''
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => { if (stderr.length < 8000) stderr += chunk })
      let timer
      const exited = await new Promise((resolve, reject) => {
        timer = setTimeout(() => { child.kill(); reject(new Error('Second browser instance did not exit')) }, 15_000)
        child.once('error', reject)
        child.once('exit', (code, signal) => resolve({ code, signal }))
      }).finally(() => clearTimeout(timer))
      if (exited.code !== null && exited.code !== 0) {
        throw new Error(`Second browser exit ${exited.code}${stderr.trim() ? `: ${stderr.trim()}` : ''}`)
      }
      if (exited.signal) duplicateExitSignals.push(exited.signal)
      await until(() => secondInstanceData.length > before, 'second-instance handoff', 5000)
      assert.equal(secondInstanceData.at(-1)?.startInBackground, background === true,
        `second-instance did not carry startInBackground=${background}`)
    }
    await launchAgain(true)
    stillHidden()
    await launchAgain(false)
    await until(() => win.isVisible() && !win.isMinimized(), 'manual app launch reveals existing window')

    const primaryTabs = await call('browser_tabs', { action: 'list' })
    const primaryTabId = primaryTabs.text.match(/\[(t[a-z0-9]+)\]/)?.[1]
    assert.ok(primaryTabId, primaryTabs.text)
    // Xvfb 的窗口管理器会在 show()/focus() 之后延迟一拍才稳定 isFocused()；
    // 先等焦点连续几次采样一致，避免把异步到位的焦点误判成“第二客户端抢焦点”。
    let focusSamples = 0
    let focusSample = win.isFocused()
    for (let attempt = 0; attempt < 20 && focusSamples < 3; attempt++) {
      await delay(100)
      const next = win.isFocused()
      focusSamples = next === focusSample ? focusSamples + 1 : 0
      focusSample = next
    }
    const focusBeforeSecondClient = focusSample
    const secondAgent = await connectDirectAgent()
    const secondTabsBefore = await callDirectAgent(secondAgent, 'browser_tabs', { action: 'list' })
    assert.doesNotMatch(directText(secondTabsBefore.result), new RegExp(`\\[${primaryTabId}\\]`))
    const secondNew = await callDirectAgent(secondAgent, 'browser_tabs', { action: 'new', url: base })
    const secondTabId = directText(secondNew.result).match(/\[(t[a-z0-9]+)\]/)?.[1]
    assert.ok(secondTabId && secondTabId !== primaryTabId, directText(secondNew.result))
    const primaryTabsAfter = await call('browser_tabs', { action: 'list' })
    const secondTabsAfter = await callDirectAgent(secondAgent, 'browser_tabs', { action: 'list' })
    assert.doesNotMatch(primaryTabsAfter.text, new RegExp(`\\[${secondTabId}\\]`))
    assert.doesNotMatch(directText(secondTabsAfter.result), new RegExp(`\\[${primaryTabId}\\]`))
    assert.equal((await state()).activeId, primaryTabId, 'Creating another client tab does not change the user-visible active tab')
    assert.equal(win.isFocused(), focusBeforeSecondClient, 'Creating another client tab does not change OS focus')
    const crossClientRead = await callDirectAgent(secondAgent, 'browser_extract', { tabId: primaryTabId })
    assert.equal(crossClientRead.ok, false)
    assert.match(crossClientRead.error, /标签不存在/)
    pass('two MCP sessions see and control only their owned tabs without switching the user-visible tab')

    await call('browser_tasks', { action: 'pause' })
    await call('browser_extract', {}, /此 MCP 客户端已暂停/)
    const secondStillActive = await callDirectAgent(secondAgent, 'browser_tabs', { action: 'list' })
    assert.match(directText(secondStillActive.result), new RegExp(`\\[${secondTabId}\\]`))
    await call('browser_tasks', { action: 'resume' })
    assert.match((await call('browser_extract')).text, /Clicks: 1 trusted: true/)
    pass('per-client pause blocks only its MCP session and allows another session to continue')

    const longWait = call('browser_wait', { text: 'task-center-cancel-probe', timeoutMs: 30000 }, /中断|取消/)
    await until(async () => (await state()).agentActivity?.tasks?.some((task) => task.tool === 'browser_wait' && task.status === 'running'), 'active task record')
    await ui('document.querySelector("#btn-tasks").click()')
    await until(() => ui('!document.querySelector("#task-center-panel").hidden && document.querySelector("#task-running-list .task-row-cancel")'), 'task center active cancel control')
    await ui('document.querySelector("#task-running-list .task-row-cancel").click()')
    await longWait
    await until(async () => (await state()).agentActivity?.tasks?.some((task) => task.tool === 'browser_wait' && task.status === 'cancelled'), 'cancelled task history')
    await ui('document.querySelector("#btn-close-tasks").click()')
    assert.match((await call('browser_extract')).text, /Clicks: 1 trusted: true/)
    pass('task center cancels an active call, records its outcome, and releases the tab queue')
    pass('duplicate MCP startup stays hidden; manual app launch reveals the same window')
    win.minimize()
    await until(() => win.isMinimized(), 'native minimize')
    markMinimized()

    if (live) {
      const site = 'https://www.python.org/'
      const website = await call('browser_navigate', { url: site, newTab: true })
      assert.match(website.text, /Python/)
      await call('browser_wait', { selector: 'input[type="search"]', timeoutMs: 8000 })
      const homepage = await call('browser_snapshot', { full: true })
      // 最小化时渲染器视口曾被压成 0×0，快照会只剩空树；直接盯住这个回归。
      const livePage = webContents.getAllWebContents().find((wc) => wc.getURL() === site)
      const render = await livePage.executeJavaScript('({ w: innerWidth, h: innerHeight })')
      assert.ok(render.w > 200 && render.h > 200, `minimized viewport collapsed: ${JSON.stringify(render)}`)
      const search = findRef(homepage.text, /- (?:textbox|searchbox).*Search/)
      await call('browser_type', { ref: search, text: 'asyncio', clear: true, snapshot: false })
      await call('browser_press_key', { key: 'Enter' })
      assert.match((await call('browser_wait', { urlContains: 'q=asyncio', timeoutMs: 10000 })).text, /已包含/)
      const url = (await state()).tabs.find((tab) => tab.active)?.url
      assert.equal(new URL(url).hostname, 'www.python.org')
      const results = await call('browser_snapshot', { full: true, maxNodes: 250 })
      fs.writeFileSync(path.join(run, 'python-search.txt'), results.text)
      assert.match(results.text, /textbox "Search" \[ref=e\d+\]: asyncio/)
      // 公开站点的排名结果会变；只要页面给出了可点击的真实结果就继续。
      const link = findRef(results.text, /- link "View Release Notes"/)
      await call('browser_click', { ref: link, snapshot: false })
      await until(async () => (await state()).tabs.find((tab) => tab.active)?.url !== url, 'real search result navigation')
      const resultUrl = (await state()).tabs.find((tab) => tab.active)?.url
      const extracted = (await call('browser_extract')).text
      assert.match(extracted, /Release Notes|Python/i)
      const shot = checkImage(await call('browser_screenshot'))
      const screenshot = path.join(run, 'python-minimized.png')
      fs.writeFileSync(screenshot, Buffer.from(shot.data, 'base64'))
      // 整页截图必须真的超过视口高度，否则只是把视口截图误标成整页。
      const full = checkImage(await call('browser_screenshot', { fullPage: true }))
      const fullHeight = nativeImage.createFromBuffer(Buffer.from(full.data, 'base64')).getSize().height
      const viewport = await livePage.executeJavaScript('({ h: innerHeight })')
      assert.ok(fullHeight > (viewport.h ?? 0) + 400, `full-page capture ${fullHeight}px is not taller than viewport ${viewport.h}px`)
      stillMinimized()
      liveResult = { searchUrl: url, resultUrl, screenshot, fullHeight, viewportHeight: viewport.h }
      pass(`Python.org: real search, result click, extraction and capture all while minimized (${resultUrl})`)
    }

    const fixture = await call('browser_navigate', { url: base })
    const input = findRef(fixture.text, /textbox.*Search query/)
    const hover = findRef(fixture.text, /button.*Hover probe/)
    const page = win.contentView.children.find((view) => view.webContents.getURL() === `${base}/`)?.webContents
    assert.ok(page, 'primary user-visible tab is still attached after the second client created its tab')
    await call('browser_hover', { ref: hover })
    assert.equal(await page.executeJavaScript('getComputedStyle(document.querySelector("#hover")).color'), 'rgb(23, 45, 67)')
    await call('browser_type', { ref: input, text: 'Background test', snapshot: false })
    await call('browser_press_key', { key: 'X' })
    assert.equal(await page.executeJavaScript('document.querySelector("input").value'), 'Background testX')
    const beforeScroll = await page.executeJavaScript('({ y: window.scrollY, visibility: document.visibilityState })')
    await call('browser_scroll', { direction: 'down', amount: 900, snapshot: false })
    const afterScroll = await page.executeJavaScript('({ y: window.scrollY, visibility: document.visibilityState })')
    assert.ok(afterScroll.y > beforeScroll.y + 700, `minimized scroll did not move the page: ${JSON.stringify({ beforeScroll, afterScroll })}`)
    await call('browser_scroll', { direction: 'up', amount: 900, snapshot: false })
    assert.equal(await page.executeJavaScript('window.scrollY'), beforeScroll.y)
    await call('browser_navigate', { url: base, snapshot: false })
    assert.equal(await page.executeJavaScript('window.scrollY'), 0)
    const dragFixture = await call('browser_snapshot', { full: true })
    const dragSource = findRef(dragFixture.text, /Drag source/)
    const dragTarget = findRef(dragFixture.text, /Drag target/)
    const dragResult = await call('browser_drag', { ref: dragSource, toRef: dragTarget, snapshot: false })
    // 拖放是否真的落到目标元素上，必须由页面状态证明；不能只看调用是否返回成功。
    assert.doesNotMatch(dragResult.text, /没有在页面侧观测到 drop/, `drag reported no drop: ${dragResult.text}`)
    assert.equal(await page.executeJavaScript('document.querySelector("#drag-effect").textContent'), 'drop:drag-probe')
    // 拖拽后焦点属于可拖动按钮；键盘提交必须先回到目标输入框，才能证明按键进入页面而不是旧焦点。
    const submissionInput = findRef((await call('browser_snapshot', { full: true })).text, /textbox.*Search query/)
    await call('browser_type', { ref: submissionInput, text: 'Background testX', snapshot: false })
    await call('browser_press_key', { key: 'Enter' })
    assert.match((await call('browser_wait', { text: 'Background search submitted' })).text, /已出现/)
    const element = findRef((await call('browser_snapshot', { full: true })).text, /button.*Result action/)
    checkImage(await call('browser_screenshot', { ref: element }))
    checkImage(await call('browser_screenshot', { fullPage: true }))
    // 视觉基线走同一套后台截图策略：最小化时保存与对比都必须完成。
    await call('browser_visual_diff', { action: 'save', name: 'bg-baseline', fullPage: true })
    assert.match((await call('browser_visual_diff', { action: 'compare', name: 'bg-baseline', fullPage: true })).text, /视觉对比「bg-baseline」：通过/)
    stillMinimized()
    pass('minimized: hover, typing, scroll, real drag/drop, keyboard submission, element and full-page screenshots without activation')

    // Notification is a real Electron permission, but only requested by the private fixture.
    const permission = page.executeJavaScript('Notification.requestPermission()')
    const pendingPermission = await until(async () => (await state()).pendingApprovals.find((item) => item.kind === 'permission'), 'permission request')
    await until(() => !win.isMinimized() && win.isVisible(), 'permission restores window')
    await until(() => ui('!document.querySelector("#approval-panel").hidden'), 'approval panel renders')
    // Minimize again before resolving from trusted chrome: resolving a request must not re-open the app.
    win.minimize()
    await until(() => win.isMinimized(), 're-minimize while waiting for approval')
    markMinimized()
    assert.equal(await ui(`window.aa.decideApproval(${JSON.stringify(pendingPermission.id)}, false)`), true)
    assert.equal(await permission, 'denied')
    stillMinimized()
    await launchAgain(false)
    await until(() => win.isVisible() && !win.isMinimized(), 'manual re-launch restores minimized window')
    assert.match((await call('browser_extract')).text, /Background search submitted/)
    pass('new approval restores the browser, denial does not reopen it, and manual restore keeps the same tab')

    // New unified window modes and the independent preview channel. These assertions
    // observe the native window and the actual PNG files, rather than only MCP state.
    const activeForMonitor = (await state()).tabs.find((tab) => tab.active)?.id
    const backgroundMode = await call('browser_window', { action: 'mode', mode: 'background', monitor: false })
    assert.match(backgroundMode.text, /窗口模式: background/)
    assert.equal(win.isVisible(), true)
    if (process.platform === 'win32') {
      const cover = new BrowserWindow({ show: false, frame: true, width: 640, height: 480, webPreferences: { sandbox: true } })
      try {
        await cover.loadURL('data:text/html,<body style="background:#20252b;color:white;font:32px sans-serif">Cover window</body>')
        cover.setAlwaysOnTop(true)
        const bounds = win.getBounds()
        cover.setBounds(bounds)
        cover.show()
        cover.focus()
        await delay(250)
        assert.equal(cover.isFocused(), true)
        await call('browser_window', { action: 'mode', mode: 'minimized' })
        await until(() => win.isMinimized(), 'background-mode transition to minimized')
        assert.equal(win.isFocused(), false, 'Minimizing does not leave the browser focused')
        assert.equal(cover.isVisible(), true, 'Minimizing leaves the covering window available')
        await call('browser_window', { action: 'mode', mode: 'background' })
        await until(() => win.isVisible() && !win.isMinimized(), 'background restore from minimized')
        assert.equal(win.isFocused(), false)
        assert.equal(cover.isVisible(), true)
        const covered = await call('browser_navigate', { url: base, tabId: activeForMonitor, snapshot: false })
        assert.match(covered.text, /Background fixture|导航完成/)
        checkImage(await call('browser_screenshot', { tabId: activeForMonitor }))
        assert.equal(win.isFocused(), false)
        pass('Windows cover window: background navigation and non-empty screenshot do not steal focus')
      } finally {
        cover.close()
      }
    }
    const hiddenMode = await call('browser_window', { action: 'mode', mode: 'hidden', monitor: true, tabId: activeForMonitor })
    assert.match(hiddenMode.text, /实时预览|监控/)
    const monitorState = await until(async () => {
      const value = await state()
      return value.monitor?.enabled && (value.monitor?.frameSeq ?? 0) > 0 ? value.monitor : null
    }, 'hidden live preview frame', 20_000)
    assert.equal(win.isVisible(), false)
    const historyFile = monitorState.history?.at(-1)?.file
    assert.ok(historyFile && fs.existsSync(historyFile), `missing monitor history file: ${historyFile}`)
    const monitorImage = nativeImage.createFromBuffer(fs.readFileSync(historyFile))
    assert.ok(!monitorImage.isEmpty() && monitorImage.getSize().width > 20 && monitorImage.getSize().height > 20)
    const monitorPixels = monitorImage.resize({ width: 64 }).toBitmap()
    assert.ok(monitorPixels.some((value, index) => index % 4 !== 3 && value < 210), 'monitor preview is blank/dark')
    assert.ok(monitorPixels.some((value, index) => index % 4 !== 3 && value > 235), 'monitor preview is blank/white')
    pass('hidden mode keeps an external, non-empty live preview for the selected tab')

    const focusBeforePreview = win.isFocused()
    await call('browser_window', { action: 'mode', mode: 'background' })
    assert.equal(win.isFocused(), focusBeforePreview, 'Showing the preview does not take OS focus')
    await ui('document.querySelector("#btn-monitor").click()')
    await until(() => ui('!document.querySelector("#monitor-panel").hidden && document.querySelector("#monitor-frame").complete && document.querySelector("#monitor-frame").naturalWidth > 0'), 'monitor panel receives a non-empty live frame')
    const historyButtons = await ui('document.querySelectorAll("#monitor-history button").length')
    assert.ok(historyButtons > 0, 'monitor screenshot history is visible in the panel')
    await ui('document.querySelector("#monitor-history button").click()')
    await until(() => ui('document.querySelector("#monitor-frame").complete && document.querySelector("#monitor-frame").naturalWidth > 0'), 'historical preview frame loads')
    await ui('document.querySelector("#btn-close-monitor").click()')
    assert.equal(await ui('document.querySelector("#monitor-panel").hidden'), true)
    pass('preview panel streams only while open, loads bounded screenshot history, and preserves focus')

    await call('browser_window', { action: 'takeover' })
    // 接管是“AI 锁定”，不是“画面停播”：预览必须继续刷新，用户才能看到自己操作的实时结果。
    const takeoverFrame = monitorState.frameSeq
    const liveDuringTakeover = await until(async () => {
      const value = await state()
      return value.monitor?.control === 'human' && (value.monitor?.frameSeq ?? 0) > takeoverFrame ? value.monitor : null
    }, 'live preview frame during human takeover', 20_000)
    assert.ok(liveDuringTakeover.status !== 'error')
    await call('browser_navigate', { url: base, tabId: activeForMonitor }, /人工接管|锁定|暂停/)
    const tasks = await call('browser_tasks', { action: 'list' })
    assert.match(tasks.text, /任务状态: 已暂停|空闲/)
    await call('browser_window', { action: 'release' })
    await ui('document.querySelector("#btn-tasks").click()')
    assert.equal(await ui('!document.querySelector("#task-center-panel").hidden'), true)
    await ui('document.querySelector("#btn-task-pause").click()')
    await until(() => ui('window.aa.getState().then(value => value.agentInterrupted && !document.querySelector("#btn-task-resume").hidden)'), 'task center global pause')
    await call('browser_extract', {}, /Agent 已被用户中断/)
    await ui('document.querySelector("#btn-task-resume").click()')
    await until(() => ui('window.aa.getState().then(value => !value.agentInterrupted)'), 'task center resume')
    await ui('document.querySelector("#btn-close-tasks").click()')
    await call('browser_window', { action: 'mode', mode: 'visible', monitor: false })
    await until(() => win.isVisible() && !win.isMinimized(), 'visible mode restore')
    pass('human takeover pauses AI input, task center reports it, and release restores control')
    if (soakDurationMs) {
      if (process.platform !== 'win32') throw new Error('The extended background soak requires Windows')
      const soakUrl = `${base}/soak`
      const opened = await call('browser_tabs', { action: 'new', url: soakUrl })
      const soakTabId = opened.text.match(/\[(t[a-z0-9]+)\]/)?.[1]
      assert.ok(soakTabId, opened.text)
      await call('browser_wait', { selector: '#ticks', timeoutMs: 10000, tabId: soakTabId })
      const startAt = Date.now()
      const baselineTick = Number(JSON.parse((await call('browser_evaluate', { expression: 'window.soakTicks', tabId: soakTabId })).text))
      const initialMonitor = await state()
      const startFrameSeq = initialMonitor.monitor?.frameSeq ?? 0
      const metricsTotal = (metrics) => metrics.reduce((sum, item) => {
        const memory = item.memory?.privateBytes ?? (item.memory?.workingSetSize ?? 0) * 1024
        return sum + memory
      }, 0)
      const initialPrivateBytes = metricsTotal(app.getAppMetrics())
      await call('browser_window', { action: 'mode', mode: 'minimized', monitor: true, tabId: soakTabId })
      await until(() => win.isMinimized(), 'soak window minimized')
      // 另一个“用户正在使用的应用”。Windows 上仅最小化本应用时，它可能继续保留
      // isFocused 状态；那不能证明后台任务没有抢占正在使用的第三方窗口。这里让
      // 独立的对照窗口持有系统焦点，再断言 soak 期间始终没有把它抢回来。
      const userApp = new BrowserWindow({ show: false, width: 520, height: 360, webPreferences: { sandbox: true } })
      let userAppForeground = false
      try {
        await userApp.loadURL('data:text/html,<body style="font:22px sans-serif">User app foreground</body>')
        userApp.show()
        userApp.focus()
        await until(() => userApp.isFocused(), 'user app holds foreground focus')
        userAppForeground = true
      } catch (error) {
        userApp.close()
        throw error
      }
      // 焦点是系统级共享资源：自动化终端或其他进程可能临时夺走它。这里直接向
      // Win32 查询系统前台 HWND，并与浏览器自身的原生句柄比较，而不是只看
      // Electron 的布尔值或要求对照窗口始终持有焦点。
      const nativeWindowHandle = Number(win.getNativeWindowHandle().readBigUInt64LE(0))
      const foregroundWindowHandle = () => {
        if (process.platform !== 'win32') return null
        try {
          const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            'Add-Type -Namespace W -Name N -MemberDefinition \'[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();\'; [W.N]::GetForegroundWindow().ToInt64()'
          ], { encoding: 'utf8', timeout: 15_000 }).trim()
          return Number(output)
        } catch {
          return null
        }
      }
      let focusCleanSamples = 0
      const assertBackgroundClean = () => {
        assert.equal(win.isMinimized(), true, 'long-running background work must not restore the window')
        assert.equal(win.isFocused(), false, 'long-running background work must not focus the browser')
        if (userAppForeground) {
          // 焦点可能被测试终端等其它进程临时拿走，所以断言“浏览器主进程不是前台”，
          // 而不是要求对照窗口始终持有焦点。
          assert.equal(userApp.isDestroyed(), false, 'the user app must stay usable during background work')
          const foreground = foregroundWindowHandle()
          if (foreground !== null) assert.notEqual(foreground, nativeWindowHandle, 'Win32 foreground window must not be the browser')
          if (foreground !== null) focusCleanSamples++
        }
      }
      const memorySamples = [{ atMs: 0, privateBytes: initialPrivateBytes }]
      let lastHeartbeatAt = 0
      let lastTick = baselineTick
      try {
        while (Date.now() - startAt < soakDurationMs) {
          await delay(Math.min(30_000, soakDurationMs - (Date.now() - startAt)))
          const elapsedMs = Date.now() - startAt
          if (elapsedMs - lastHeartbeatAt < 5 * 60_000 && elapsedMs < soakDurationMs) continue
          const evaluated = Number(JSON.parse((await call('browser_evaluate', { expression: 'window.soakTicks', tabId: soakTabId })).text))
          assert.ok(Number.isFinite(evaluated) && evaluated > lastTick, `page heartbeat stalled at ${evaluated}`)
          lastTick = evaluated
          assertBackgroundClean()
          const monitorState = (await state()).monitor
          assert.ok(monitorState?.frameSeq > startFrameSeq, 'background monitor frame sequence must advance')
          assert.ok(monitorState.history.length <= 20, 'monitor screenshot history must stay bounded')
          const monitorFiles = fs.readdirSync(process.env.AA_BROWSER_MONITOR_DIR).filter((name) => /^frame-\d+-\d+\.png$/.test(name))
          assert.ok(monitorFiles.length <= 20, `monitor disk history exceeded its limit: ${monitorFiles.length}`)
          checkImage(await call('browser_screenshot', { tabId: soakTabId }))
          const privateBytes = metricsTotal(app.getAppMetrics())
          memorySamples.push({ atMs: elapsedMs, privateBytes })
          console.log(`Background soak: ${Math.floor(elapsedMs / 60_000)}m / ${Math.ceil(soakDurationMs / 60_000)}m; ticks=${evaluated}; monitorFrames=${monitorState.frameSeq}; privateMemoryDeltaMB=${Math.round((privateBytes - initialPrivateBytes) / 1024 / 1024)}`)
          lastHeartbeatAt = elapsedMs
        }
      } finally {
        userApp.close()
      }
      const finishedAt = Date.now()
      const finalTicks = Number(JSON.parse((await call('browser_evaluate', { expression: 'window.soakTicks', tabId: soakTabId })).text))
      const finalState = await state()
      const finalPrivateBytes = metricsTotal(app.getAppMetrics())
      const timerDelta = finalTicks - baselineTick
      assert.ok(timerDelta >= Math.floor(soakDurationMs / 1000 * 0.75), `page heartbeat ran only ${timerDelta} times during ${Math.round((finishedAt - startAt) / 1000)} seconds`)
      assert.ok(finalState.monitor.frameSeq - startFrameSeq >= Math.floor(soakDurationMs / 1000 * 0.6), 'monitor frames must continue through the soak')
      assert.ok(finalPrivateBytes - initialPrivateBytes < 512 * 1024 * 1024, 'private process memory grew by more than 512 MiB')
      const frame = checkImage(await call('browser_screenshot', { tabId: soakTabId }))
      soakResult = {
        durationMs: finishedAt - startAt,
        timerDelta,
        monitorFrameDelta: finalState.monitor.frameSeq - startFrameSeq,
        monitorHistoryCount: finalState.monitor.history.length,
        monitorDiskFileCount: fs.readdirSync(process.env.AA_BROWSER_MONITOR_DIR).filter((name) => /^frame-\d+-\d+\.png$/.test(name)).length,
        initialPrivateBytes,
        finalPrivateBytes,
        screenshotBytes: Buffer.from(frame.data, 'base64').length,
        win32ForegroundSamples: focusCleanSamples,
        memorySamples
      }
      await call('browser_window', { action: 'mode', mode: 'visible', monitor: false })
      pass(`Windows background soak ran for ${Math.round(soakResult.durationMs / 60_000)} minutes with live page ticks, non-empty screenshots, bounded history, and stable memory`)
    }
    exitCode = 0
  } finally {
    rl?.close()
    for (const peer of directPeers) peer.socket.close()
    bridge?.kill()
    for (const item of pending.values()) clearTimeout(item.timer)
    server.close()
    fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ exitCode, checks, live: liveResult, soak: soakResult, duplicateExitSignals }, null, 2))
    console.log(`Background verification: ${path.join(run, 'result.json')}`)
    if (exitCode === 0) app.quit()
  }
}
