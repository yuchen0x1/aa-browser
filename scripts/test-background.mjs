// Real Electron + stdio MCP. The public site probe is opt-in; CI uses a deterministic local page.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import readline from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const live = process.argv.includes('--live')
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
    AA_BROWSER_EVIDENCE_FILE: path.join(run, 'evidence.json')
  }
  delete env.ELECTRON_RUN_AS_NODE
  fs.writeFileSync(env.AA_BROWSER_SETTINGS_FILE, JSON.stringify({ autoUpdate: false, restoreSession: false }))
  const child = spawn(require('electron'), [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { cwd: ROOT, env, stdio: 'inherit' })
  const timer = setTimeout(() => { console.error('Background suite timed out'); child.kill() }, 110_000)
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
  const { app, BaseWindow, webContents, nativeImage } = await import('electron')
  const run = process.env.AA_BROWSER_TEST_DIR
  const inputPage = `<meta charset=utf-8><title>Background fixture</title>
    <h1>Background fixture</h1><form action="/result"><input aria-label="Search query" name="q"><button>Search</button></form>
    <button id="hover">Hover probe</button><button id="click">Click probe</button><p id="effect">Waiting for click</p>
    <style>#hover:hover { color: rgb(23, 45, 67) }</style>
    <script>let clicks=0; document.querySelector('#click').onclick = (event) => {
      document.querySelector('#effect').textContent = 'Clicks: ' + ++clicks + ' trusted: ' + event.isTrusted;
    }</script>`
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (req.url === '/result?q=Background+testX') res.end('<title>Background result</title><h1>Background search submitted</h1><button>Result action</button>')
    else res.end(inputPage)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  let bridge
  let rl
  const pending = new Map()
  let id = 0
  let exitCode = 1
  let liveResult
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
    const page = webContents.getAllWebContents().find((wc) => wc.getURL() === `${base}/`)
    await call('browser_hover', { ref: hover })
    assert.equal(await page.executeJavaScript('getComputedStyle(document.querySelector("#hover")).color'), 'rgb(23, 45, 67)')
    await call('browser_type', { ref: input, text: 'Background test', snapshot: false })
    await call('browser_press_key', { key: 'X' })
    assert.equal(await page.executeJavaScript('document.querySelector("input").value'), 'Background testX')
    await call('browser_press_key', { key: 'Enter' })
    assert.match((await call('browser_wait', { text: 'Background search submitted' })).text, /已出现/)
    const element = findRef((await call('browser_snapshot', { full: true })).text, /button.*Result action/)
    checkImage(await call('browser_screenshot', { ref: element }))
    checkImage(await call('browser_screenshot', { fullPage: true }))
    // 视觉基线走同一套后台截图策略：最小化时保存与对比都必须完成。
    await call('browser_visual_diff', { action: 'save', name: 'bg-baseline', fullPage: true })
    assert.match((await call('browser_visual_diff', { action: 'compare', name: 'bg-baseline', fullPage: true })).text, /视觉对比「bg-baseline」：通过/)
    stillMinimized()
    pass('minimized: hover, typing, keyboard submission, element and full-page screenshots without activation')

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
    exitCode = 0
  } finally {
    rl?.close()
    bridge?.kill()
    for (const item of pending.values()) clearTimeout(item.timer)
    server.close()
    fs.writeFileSync(path.join(run, 'result.json'), JSON.stringify({ exitCode, checks, live: liveResult, duplicateExitSignals }, null, 2))
    console.log(`Background verification: ${path.join(run, 'result.json')}`)
    if (exitCode === 0) app.quit()
  }
}
