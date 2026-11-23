/** Real Electron desktop regression suite. All mutable state stays inside this repo. */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Module, { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'
import { BOUNDS_TOLERANCE, MIN_WINDOW_HEIGHT, MIN_WINDOW_WIDTH, fitWindowToDisplay } from './display-fit.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

if (!process.versions.electron) {
  const runDir = path.join(ROOT, '.local-verification', `desktop-${Date.now()}-${process.pid}`)
  fs.mkdirSync(runDir, { recursive: true })
  const env = {
    ...process.env,
    AA_BROWSER_USER_DATA_DIR: path.join(runDir, 'profile'),
    AA_BROWSER_CONNECTION_FILE: path.join(runDir, 'connection.json'),
    AA_BROWSER_HISTORY_DIR: path.join(runDir, 'history'),
    AA_BROWSER_SETTINGS_FILE: path.join(runDir, 'settings.json'),
    AA_BROWSER_SESSION_FILE: path.join(runDir, 'session.json'),
    AA_BROWSER_DOWNLOAD_DIR: path.join(runDir, 'downloads'),
    AA_BROWSER_EVIDENCE_FILE: path.join(runDir, 'evidence-registry.json'),
    AA_DESKTOP_TEST_DIR: runDir
  }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { cwd: ROOT, env, stdio: 'inherit' })
  const timer = setTimeout(() => { console.error('FAIL: desktop suite timed out'); child.kill() }, 120_000)
  child.once('error', (error) => { clearTimeout(timer); console.error(error); process.exitCode = 1 })
  child.once('exit', (code) => {
    clearTimeout(timer)
    const exitCode = code ?? 1
    const resultFile = path.join(runDir, 'result.json')
    const result = fs.existsSync(resultFile) ? JSON.parse(fs.readFileSync(resultFile, 'utf8')) : { checks: [] }
    fs.writeFileSync(resultFile, JSON.stringify({ ...result, status: exitCode === 0 ? 'PASS' : 'FAIL', exitCode }, null, 2))
    process.exitCode = exitCode
  })
} else {
  // Do not await app.whenReady() at module top level: Electron waits for its
  // ESM entry to finish evaluating before it can emit ready.
  void (async () => {
  const { app, webContents, BaseWindow, Menu, screen, clipboard } = await import('electron')
  const runDir = process.env.AA_DESKTOP_TEST_DIR
  const displayOnly = process.argv.includes('--display-only')
  const displayScale = Number(process.env.AA_DISPLAY_MATRIX_SCALE || 1)
  if (displayOnly && Number.isFinite(displayScale) && displayScale > 0) {
    app.commandLine.appendSwitch('disable-gpu')
    app.commandLine.appendSwitch('force-device-scale-factor', String(displayScale))
  }
  const updateUi = process.argv.includes('--update-ui')
  let updateProvider
  if (updateUi) {
    // Only this isolated test instance acts packaged; the provider never uses a network or installer.
    app.setPath('userData', process.env.AA_BROWSER_USER_DATA_DIR)
    Object.defineProperty(app, 'isPackaged', { value: true })
    app.getVersion = () => '0.0.3'
    if (process.platform === 'linux') {
      process.env.APPIMAGE = path.join(runDir, 'aa-browser-test.AppImage')
      fs.writeFileSync(process.env.APPIMAGE, 'previous-release-fixture')
    }
    updateProvider = new EventEmitter()
    updateProvider.downloads = 0
    updateProvider.installs = 0
    const info = { version: '0.0.4', releaseDate: '2026-11-13', releaseNotes: [{ version: '0.0.4', note: 'Fixture publisher release note' }], files: [{ size: 100 }] }
    updateProvider.checkForUpdates = async () => {
      updateProvider.emit('checking-for-update')
      updateProvider.emit('update-available', info)
      return { downloadPromise: updateProvider.autoDownload ? updateProvider.downloadUpdate() : null }
    }
    updateProvider.downloadUpdate = async () => {
      updateProvider.downloads++
      updateProvider.emit('download-progress', { percent: 40, transferred: 40, total: 100, bytesPerSecond: 10 })
      return new Promise((resolve) => { updateProvider.finish = () => { updateProvider.emit('update-downloaded', info); resolve([]) } })
    }
    updateProvider.quitAndInstall = () => { updateProvider.installs++ }
  }
  const { WebSocket } = await import('ws')
  const results = []
  const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
  async function until(fn, label, timeout = 12_000) {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const value = await fn()
      if (value) return value
      await pause(60)
    }
    throw new Error(`Timed out: ${label}`)
  }
  function pass(label) { results.push(label); console.log(`PASS: ${label}`) }
  let ws
  let newTabRequests = 0
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (req.url === '/new-tab') newTabRequests++
    if (req.url === '/frame') { res.end('<p>Child frame</p>'); return }
    if (req.url === '/hud-pointer') {
      res.end(`<title>HUD pointer</title><button id="hud-target" style="margin:40px;padding:20px">HUD target</button>
        <div style="height:3000px"></div>
        <script>window.__hudClicks = 0; document.querySelector('#hud-target').addEventListener('click', () => { window.__hudClicks++ })</script>`)
      return
    }
    if (req.url === '/ref-fixture') {
      res.end(`<title>Ref fixture</title><ul id="ref-list"><li><button>One</button></li><li><button>Two</button></li><li><button>Three</button></li></ul>
        <button id="hidden-target" onclick="window.__hiddenClicks = (window.__hiddenClicks || 0) + 1">Hidden target</button>`)
      return
    }
    res.end(`<title>Desktop fixture</title><h1>Aa desktop regression</h1><p>needle needle needle</p><input aria-label="Fixture input"><a href="/popup-private" target="_blank">Open child</a><iframe src="about:blank"></iframe>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  // Cross-session restore regression: seed a previous session before the main
  // process starts, then assert it is restored instead of a blank new tab.
  const sessionFile = process.env.AA_BROWSER_SESSION_FILE
  assert.ok(sessionFile, 'desktop suite needs AA_BROWSER_SESSION_FILE')
  // v2 记录带标签 id：更新重启后 Agent 缓存的 tabId 必须继续有效。
  fs.writeFileSync(sessionFile, JSON.stringify({
    version: 2,
    savedAt: Date.now(),
    activeIndex: 1,
    tabs: [
      { url: base + '/restored-a', title: 'Restored A', id: 'trestoreda' },
      { url: base + '/restored-b', title: 'Restored B', id: 'trestoredb' }
    ]
  }))
  let chrome
  const ui = (code) => chrome.executeJavaScript(code, true)
  const state = () => ui('window.aa.getState()')
  // 注入脚本里的数据字面量统一走 jsLiteral：JSON.stringify 之外再转义 `<` `>` `/` 与
  // U+2028/U+2029（CodeQL js/bad-code-sanitization 的建议），避免选择器截断脚本。
  const UNSAFE_CHARS = { '<': '\\u003C', '>': '\\u003E', '/': '\\u002F', '\u2028': '\\u2028', '\u2029': '\\u2029' }
  const jsLiteral = (value) => JSON.stringify(value).replace(/[<>/\u2028\u2029]/g, (ch) => UNSAFE_CHARS[ch])
  async function click(selector) {
    await ui(`document.querySelector(${jsLiteral(selector)}).scrollIntoView({block:'nearest',inline:'nearest'})`)
    await pause(40)
    const point = await ui(`(() => { const el = document.querySelector(${jsLiteral(selector)}); const r = el.getBoundingClientRect(); return {x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)} })()`)
    chrome.focus()
    chrome.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    chrome.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    await pause(100)
  }
  let callId = 0
  const pending = new Map()
  function tool(toolName, args) {
    const id = ++callId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Tool timeout: ${toolName}`)) }, 15_000)
      pending.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ id, tool: toolName, args }))
    })
  }
  const toolText = (result) => (result?.content ?? []).filter((item) => item?.type === 'text').map((item) => item.text).join('\n')
  const activePage = async () => {
    const s = await state()
    const tab = s.tabs.find((t) => t.active)
    return webContents.getAllWebContents().find((wc) => wc !== chrome && wc.getURL() === tab?.url)
  }
  try {
    app.setAppPath(ROOT)
    const load = Module._load
    if (updateUi) Module._load = function (name, ...args) { return name === 'electron-updater' ? { autoUpdater: updateProvider } : load.call(this, name, ...args) }
    try { await import(pathToFileURL(path.join(ROOT, 'out/main/index.js')).href) }
    finally { Module._load = load }
    await app.whenReady()
    chrome = await until(() => webContents.getAllWebContents().find((wc) => wc.getURL().endsWith('/renderer/index.html')), 'chrome view')
    await until(() => ui('!!window.aa && !!document.querySelector("#btn-find")'), 'preload + renderer')
    chrome.setBackgroundThrottling(false)
    BaseWindow.getAllWindows()[0].show()
    const errors = []
    chrome.on('console-message', (event) => {
      if (event?.level === 'error') errors.push(event.message)
    })
    await until(() => fs.existsSync(process.env.AA_BROWSER_CONNECTION_FILE), 'discovery')
    const connection = JSON.parse(fs.readFileSync(process.env.AA_BROWSER_CONNECTION_FILE, 'utf8'))
    ws = new WebSocket(`ws://127.0.0.1:${connection.port}/?token=${connection.token}`)
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    ws.on('message', (raw) => {
      const response = JSON.parse(String(raw))
      // 进度事件与响应共用 WS 通道，不能当成工具结果（否则会把在途调用误判为失败）
      if (response.event === 'progress') return
      const item = pending.get(response.id)
      if (!item) return
      pending.delete(response.id)
      clearTimeout(item.timer)
      if (response.ok) item.resolve(response.result)
      else item.reject(new Error(response.error))
    })
    const initial = await until(async () => {
      const current = await state()
      const urls = current.tabs.map((tab) => tab.url)
      return urls.includes(base + '/restored-a') && urls.includes(base + '/restored-b') ? current : null
    }, 'restored session tabs', 20_000)
    assert.equal(initial.tabs.length, 2)

    if (displayOnly) {
      const currentWindow = BaseWindow.getAllWindows()[0]
      const displays = screen.getAllDisplays()
      const dpr = await ui('window.devicePixelRatio')
      assert.ok(Math.abs(dpr - displayScale) < 0.02, `devicePixelRatio ${dpr} should match forced scale ${displayScale}`)
      const viewport = await ui('({width: innerWidth, height: innerHeight, minWidth: document.documentElement.scrollWidth})')
      // Even on a small screen the app retains its minimum window. Only allow
      // native frame rounding (observed as 959 CSS px at forced 2x on Windows),
      // never lower the renderer's minimum to the display work area.
      const contentBounds = currentWindow.getContentBounds()
      assert.ok(viewport.width >= MIN_WINDOW_WIDTH - BOUNDS_TOLERANCE, `renderer viewport too narrow at ${displayScale}: ${JSON.stringify({ viewport, contentBounds })}`)
      assert.ok(Math.abs(viewport.width - contentBounds.width) <= BOUNDS_TOLERANCE, `renderer must fill the native content width: ${JSON.stringify({ viewport, contentBounds })}`)
      assert.ok(viewport.minWidth <= viewport.width + 1, `renderer overflows horizontally: ${JSON.stringify(viewport)}`)
      await click('#btn-settings')
      assert.equal(await ui('document.querySelector("#settings-modal").hidden'), false)
      const navState = await ui('({width: innerWidth, display: getComputedStyle(document.querySelector(".settings-nav")).display})')
      assert.equal(navState.display, navState.width <= 1000 ? 'none' : 'flex', `unexpected settings navigation at CSS viewport ${navState.width}`)
      await click('#btn-close-settings')
      pass(`renderer layout remains usable at ${Math.round(displayScale * 100)}% device scale`)

      const originalBounds = currentWindow.getBounds()
      const placements = []
      for (const [index, display] of displays.entries()) {
        const area = display.workArea
        const { fits, ...target } = fitWindowToDisplay(originalBounds, area)
        currentWindow.setBounds(target)
        await pause(100)
        const bounds = currentWindow.getBounds()
        const details = JSON.stringify({ bounds, area, target })
        assert.ok(bounds.x >= area.x - BOUNDS_TOLERANCE && bounds.y >= area.y - BOUNDS_TOLERANCE && bounds.x < area.x + area.width && bounds.y < area.y + area.height, `window origin outside display ${index}: ${details}`)
        assert.ok(Math.abs(bounds.width - target.width) <= BOUNDS_TOLERANCE && Math.abs(bounds.height - target.height) <= BOUNDS_TOLERANCE, `window size differs from requested minimum-constrained bounds on display ${index}: ${details}`)
        if (fits) {
          assert.ok(bounds.x + bounds.width <= area.x + area.width + BOUNDS_TOLERANCE && bounds.y + bounds.height <= area.y + area.height + BOUNDS_TOLERANCE, `window exceeds display ${index} work area: ${details}`)
        } else {
          console.log(`[display-matrix] display ${index} work area ${area.width}×${area.height} cannot contain the ${MIN_WINDOW_WIDTH}×${MIN_WINDOW_HEIGHT} minimum window; origin and minimum size verified, full containment not possible`)
        }
        placements.push({ display: index, area, target, bounds, containment: fits ? 'verified' : 'constrained' })
      }
      currentWindow.setBounds(originalBounds)
      if (displays.length < 2) console.log('[display-matrix] multiple physical displays unavailable; single-display placement verified, multi-display iteration skipped')
      const constrained = placements.filter((placement) => placement.containment === 'constrained').length
      pass(`window placement verified on ${displays.length} display(s): ${displays.length - constrained} contained, ${constrained} below minimum window size`)
      ws.close()
      await new Promise((resolve) => server.close(resolve))
      await new Promise((resolve) => { app.once('will-quit', resolve); app.quit() })
      fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify({ status: 'PASS', scale: displayScale, devicePixelRatio: dpr, viewport, contentBounds, placements, displays: displays.map((display) => ({ bounds: display.bounds, workArea: display.workArea, scaleFactor: display.scaleFactor })), checks: results }, null, 2))
      console.log(`PASS: display matrix at ${Math.round(displayScale * 100)}%`)
      return
    }
    assert.equal(initial.tabs.length, 2)
    assert.ok(initial.tabs.some((tab) => tab.url === base + '/restored-a'), `restored tabs: ${JSON.stringify(initial.tabs.map((tab) => tab.url))}`)
    assert.ok(initial.tabs.some((tab) => tab.url === base + '/restored-b'))
    assert.equal(initial.tabs.find((tab) => tab.active)?.url, base + '/restored-b')
    assert.deepEqual(
      initial.tabs.map((tab) => tab.id),
      ['trestoreda', 'trestoredb'],
      `restored tab ids must survive the restart: ${JSON.stringify(initial.tabs)}`
    )
    pass('startup restores the previous session tabs, saved active tab and stable tab ids')
    const initialSettings = await ui('window.aa.settingsGet()')
    assert.equal(initialSettings.settings.theme, 'light')
    assert.equal(await ui('document.documentElement.dataset.theme'), 'light')
    pass('new desktop profiles default to the light browser shell theme')

    // Agent activity HUD: a live MCP call expands the chrome view over the window,
    // interrupt pauses/aborts the call, and explicit resume releases the overlay.
    // 用“等一个永远不出现的文案”而不是固定 sleep，才能证明中断真的取消了长操作。
    const interruptStart = Date.now()
    const activityProbe = tool('browser_wait', { text: '中断测试_永远不会出现的文案', timeoutMs: 8000 }).then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error })
    )
    await until(async () => (await state()).agentActivity?.active === true, 'agent activity HUD active', 5000)
    const browserWindow = BaseWindow.getAllWindows()[0]
    const activityShellView = browserWindow.contentView.children.find((view) => view.webContents === chrome)
    assert.ok(activityShellView)
    assert.equal(activityShellView.getBounds().height, browserWindow.getContentBounds().height)
    await ui('window.aa.interruptAgent()')
    await until(async () => (await state()).agentActivity?.paused === true, 'agent activity paused', 5000)
    assert.equal((await state()).agentActivity?.active, false)
    assert.equal(activityShellView.getBounds().height, browserWindow.getContentBounds().height)
    const probeOutcome = await Promise.race([
      activityProbe,
      new Promise((resolve) => setTimeout(() => resolve({ ok: true, timedOut: true }), 4000))
    ])
    assert.equal(probeOutcome.timedOut, undefined, 'interrupted wait must not keep running')
    assert.equal(probeOutcome.ok, false, `interrupted wait should fail, got ${JSON.stringify(probeOutcome)}`)
    assert.match(String(probeOutcome.error?.message ?? ''), /中断/, `unexpected error: ${probeOutcome.error?.message}`)
    const interruptElapsed = Date.now() - interruptStart
    assert.ok(interruptElapsed < 6000, `interrupt took too long: ${interruptElapsed}ms`)
    await ui('window.aa.resumeAgent()')
    await until(async () => (await state()).agentActivity?.paused === false, 'agent activity resumed', 5000)
    pass('AI activity HUD tracks tool calls, and interrupt cancels a running wait instead of letting it finish')

    // 多客户端并发：HUD 必须列出所有调用（而非只显示最近一次），且可以只停止其中一个。
    const ws2 = new WebSocket(`ws://127.0.0.1:${connection.port}/?token=${connection.token}`)
    await new Promise((resolve, reject) => { ws2.once('open', resolve); ws2.once('error', reject) })
    // Independent bridges can reuse the same wire id. Keep both next ids equal.
    let callId2 = callId
    const pending2 = new Map()
    const progress2 = []
    ws2.on('message', (raw) => {
      const msg = JSON.parse(String(raw))
      if (msg.event === 'progress') { progress2.push(msg); return }
      const item = pending2.get(msg.id)
      if (!item) return
      pending2.delete(msg.id)
      clearTimeout(item.timer)
      if (msg.ok) item.resolve(msg.result)
      else item.reject(new Error(msg.error))
    })
    const call2 = (name, args, progressToken) => {
      const id = ++callId2
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { pending2.delete(id); reject(new Error(`Tool2 timeout: ${name}`)) }, 15_000)
        pending2.set(id, { resolve, reject, timer })
        ws2.send(JSON.stringify({ id, tool: name, args, ...(progressToken !== undefined ? { progressToken } : {}) }))
      })
    }
    const settle = (promise) => promise.then((value) => ({ ok: true, value }), (error) => ({ ok: false, error }))
    // 每个 MCP 客户端只能看到自己的标签；先为客户端 2 建立独立标签，避免越权调用快速结束。
    const client2Tab = await call2('browser_tabs', { action: 'new', url: base })
    const client2TabText = (client2Tab.content ?? []).filter((item) => item?.type === 'text').map((item) => item.text).join('\n')
    const client2TabId = client2TabText.match(/\[(t[a-z0-9]+)\]/)?.[1]
    assert.ok(client2TabId, client2TabText)
    callId2 = callId
    // HUD 并发在不同客户端的独立标签上验证；同标签等待按队列串行。
    const concurrentA = settle(call2('browser_wait', { tabId: client2TabId, text: '并发A_永不出现', timeoutMs: 9000 }, 'desktop-progress'))
    const concurrentB = settle(tool('browser_wait', { tabId: initial.tabs[1].id, text: '并发B_永不出现', timeoutMs: 9000 }))
    await until(async () => ((await state()).agentActivity?.calls?.length ?? 0) >= 2, 'concurrent calls visible in activity', 5000)
    const visibleCalls = (await state()).agentActivity.calls
    assert.equal(new Set(visibleCalls.map((c) => c.client)).size, 2, `expected two distinct clients, got ${JSON.stringify(visibleCalls)}`)
    assert.equal(new Set(visibleCalls.map((c) => c.id)).size, 1, `regression requires colliding request ids: ${JSON.stringify(visibleCalls)}`)
    assert.ok(visibleCalls.every((c) => c.tool === 'browser_wait' && c.id > 0))
    await until(async () => (await ui('document.querySelectorAll("#agent-activity-calls .agent-call-row").length')) >= 2, 'HUD renders a row per concurrent call', 5000)
    await until(() => progress2.length > 0, 'long operation reports progress over WS', 5000)
    const secondClient = visibleCalls.find((c) => c.client === 2)
    assert.ok(secondClient, `second client call missing: ${JSON.stringify(visibleCalls)}`)
    assert.ok(progress2.some((p) => p.id === secondClient.id && p.progress > 0), `progress for second call missing: ${JSON.stringify(progress2)}`)
    const ambiguousCancel = await ui(`window.aa.cancelAgentCall(${secondClient.id})`)
    assert.equal(ambiguousCancel, false, 'legacy cancellation must reject an ambiguous id without stopping either client')
    const stopSelector = `[data-focus-key="call-stop:${secondClient.client}:${secondClient.id}"]`
    assert.match(await ui(`document.querySelector(${jsLiteral(stopSelector)}).getAttribute('aria-label')`), new RegExp(`(?:客户端|client) ${secondClient.client}`, 'i'))
    await click('#omnibox')
    assert.equal(await ui('document.activeElement.id'), 'omnibox')
    await click(stopSelector)
    const aOutcome = await Promise.race([concurrentA, pause(4000).then(() => ({ ok: true, timedOut: true }))])
    assert.equal(aOutcome.timedOut, undefined, 'cancelled call must not keep running')
    assert.equal(aOutcome.ok, false, `cancelled call should fail, got ${JSON.stringify(aOutcome)}`)
    await until(async () => ((await state()).agentActivity?.calls?.length ?? 0) === 1, 'the other call keeps running', 3000)
    const remainingCall = (await state()).agentActivity.calls[0]
    assert.equal(remainingCall.client, 1, 'stopping client 2 must not abort client 1 with the same request id')
    assert.equal(remainingCall.id, secondClient.id)
    await ui('window.aa.interruptAgent()')
    await until(async () => (await state()).agentActivity?.paused === true, 'global pause still works with concurrent calls', 5000)
    await Promise.race([concurrentB, pause(4000)])
    await ui('window.aa.resumeAgent()')
    await until(async () => (await state()).agentActivity?.paused === false, 'resume after concurrency test', 5000)
    ws2.close()
    pass('multi-client activity HUD lists every call, relays progress, and cancels only the selected call')

    if (updateUi) {
      await until(async () => (await state()).update?.status === 'downloading', 'automatic update on startup/focus')
      await until(() => ui('!document.querySelector("#update-notice").hidden && document.querySelector("#btn-update-notice").textContent.includes("40%")'), 'visible download notice')
      assert.equal(await ui('document.querySelector("#settings-modal").hidden'), true)
      const notesMeta = await ui('({title: document.querySelector("#update-status").title, locale: document.documentElement.lang})')
      assert.ok(notesMeta.title.includes(notesMeta.locale === 'en-US' ? 'Release notes (publisher original language)' : '发行说明（发布者原文）'))
      assert.ok(notesMeta.title.includes('Fixture publisher release note'))
      const window = BaseWindow.getAllWindows()[0]
      const shellView = window.contentView.children.find((view) => view.webContents === chrome)
      await until(() => shellView.getBounds().height === 128, 'update banner native bounds')
      assert.equal(updateProvider.downloads, 1)
      pass('automatic download is visible on the main window without opening settings')
      await click('#btn-find')
      await until(() => shellView.getBounds().height === 176, 'find plus update banner native bounds')
      await until(() => ui(`(() => {
        const find = document.querySelector('#find-bar').getBoundingClientRect();
        const notice = document.querySelector('#update-notice').getBoundingClientRect();
        return find.height > 0 && notice.height > 0 && find.top >= notice.bottom - 0.5;
      })()`), 'find toolbar starts below the update banner')
      await click('#find-close')
      pass('find toolbar and page layout reserve separate space for the update banner')
      updateProvider.emit('error', new Error('simulated download interruption'))
      await until(() => ui('document.querySelector("#update-notice-action").textContent === (document.documentElement.lang === "en-US" ? "Retry now" : "立即重试")'), 'download error action')
      await click('#update-notice-action')
      await until(() => updateProvider.downloads === 2, 'actual retry IPC')
      pass('visible retry action resumes a failed download')
      await click('#update-notice-dismiss')
      await until(() => shellView.getBounds().height === 84, 'dismiss update banner')
      assert.equal(await ui('document.querySelector("#btn-update-notice").hidden'), false)
      updateProvider.finish()
      await until(() => ui('!document.querySelector("#update-notice").hidden && document.querySelector("#update-notice-action").textContent === (document.documentElement.lang === "en-US" ? "Restart and install" : "重启安装")'), 'download completion notice')
      assert.equal(updateProvider.installs, 0)
      pass('later keeps the toolbar entry and completion shows a fresh prompt without forcing restart')
      await click('#btn-update-notice')
      assert.equal(await ui('document.querySelector("#settings-modal").hidden'), false)
      assert.ok(await ui('document.querySelector("#update-status").textContent.includes(document.documentElement.lang === "en-US" ? "downloaded" : "已下载")'))
      await click('#btn-close-settings')
      await click('#update-notice-action')
      assert.equal(updateProvider.installs, 1)
      if (process.platform === 'linux') {
        const backup = path.join(app.getPath('userData'), 'previous-versions', '0.0.3.AppImage')
        assert.equal(fs.readFileSync(backup, 'utf8'), 'previous-release-fixture')
        pass('AppImage recovery copy is ready before the installer receives control')
      }
      pass('toolbar opens update settings and explicit restart action reaches the installer API')
      fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify({ status: 'PASS', simulatedProvider: true, checks: results }, null, 2))
      console.log(`PASS: all ${results.length} update UI checks (simulated provider; no real installer)`)
      ws.close(); server.close(); app.quit()
      return
    }
    assert.ok(initial.update)
    assert.equal(initial.canReopenClosed, false)
    assert.equal(await ui('document.querySelector("#agent-stop").disabled'), false, 'connected agents can be paused before their next tool call')
    pass('initial UI state includes updater, finder and restore availability')
    await click('#btn-settings')
    await until(() => ui('document.querySelector("#set-engine").options.length > 0'), 'settings ready')
     assert.equal(await ui('document.activeElement?.id'), 'btn-close-settings')
    assert.equal(await ui('document.querySelector("#set-agent-info")?.getAttribute("title")'), null)
    const info = await ui('window.aa.agentInfo()')
    assert.equal(Object.hasOwn(info, 'token'), false)
    assert.equal(info.bridgeFile, 'present')
    await until(() => ui('document.querySelector("#set-agent-status").dataset.state === "authenticated"'), 'authenticated connection status')
    await tool('browser_tabs', { action: 'list' })
    await until(() => ui('document.querySelector("#set-agent-status").dataset.state === "verified"'), 'verified connection status')
    assert.equal(await ui('document.querySelector(".connection-details").open'), false)
    const originalWriteText = clipboard.writeText
    const copied = []
    let clipboardUnavailable = false
    clipboard.writeText = (value) => {
      if (clipboardUnavailable) throw new Error('Fixture clipboard failure')
      copied.push(value)
    }
    try {
      await click('#btn-copy-connection-diagnostics')
      await until(() => ui('document.querySelector("#connection-diagnostics-result").dataset.state === "success"'), 'copy diagnostic success')
      assert.deepEqual(copied, [[
        `Aa Browser ${info.version} (${process.platform}-${process.arch})`,
        'Local service: connected', 'Bridge file: present', 'Authenticated clients: 1', 'Verified clients: 1'
      ].join('\n')], 'diagnostics use exactly the shareable fields, not the discovery file, token, URL or configs')
      clipboardUnavailable = true
      await click('#btn-copy-connection-diagnostics')
      await until(() => ui('document.querySelector("#connection-diagnostics-result").dataset.state === "error"'), 'copy diagnostic failure')
      assert.equal(copied.length, 1)
    } finally {
      clipboard.writeText = originalWriteText
    }
    pass('connection diagnostics follow live verification and copy only shareable fields (clipboard stub)')
    await ui('document.querySelector("#set-engine").value="https://duckduckgo.com/?q="; document.querySelector("#set-engine").dispatchEvent(new Event("change"))')
    await click('#btn-save-settings')
    assert.equal((await ui('window.aa.settingsGet()')).settings.searchEngine, 'https://duckduckgo.com/?q=')
    pass('search preset selection is saved instead of the old custom URL')
    await ui('document.querySelector("#set-theme").value="dark"; document.querySelector("#set-theme").dispatchEvent(new Event("change"))')
    await until(() => ui('document.documentElement.dataset.theme === "dark"'), 'dark theme preview')
     assert.match(await ui('getComputedStyle(document.documentElement).getPropertyValue("--surface-settings").trim()'), /#171b20/)
    await click('#btn-close-settings')
    await until(() => ui('document.documentElement.dataset.theme === "light"'), 'unsaved theme rollback')
     assert.match(await ui('getComputedStyle(document.documentElement).getPropertyValue("--surface-settings").trim()'), /#ffffff/)
     assert.equal(await ui('document.activeElement?.id'), 'btn-settings')
     const originalWindowSize = browserWindow.getSize()
     browserWindow.setSize(960, 720)
     await pause(160)
     await click('#btn-settings')
     await until(() => ui('document.querySelector("#set-engine").options.length > 0'), 'narrow settings ready')
     assert.equal(await ui('getComputedStyle(document.querySelector(".settings-nav")).display'), 'none')
     await click('#btn-close-settings')
     browserWindow.setSize(originalWindowSize[0], originalWindowSize[1])
     await pause(80)
     pass('settings remain usable at the 960px desktop minimum and collapse the side navigation')
    pass('theme preview rolls back when settings close without saving')
    await click('#btn-settings')
    await until(() => ui('document.querySelector("#set-theme").value === "light"'), 'theme setting reopened')
    await ui('document.querySelector("#set-theme").value="dark"; document.querySelector("#set-theme").dispatchEvent(new Event("change"))')
    await click('#btn-save-settings')
    await until(() => ui('document.documentElement.dataset.theme === "dark"'), 'saved dark theme')
    await ui('document.querySelector("#set-theme").value="light"; document.querySelector("#set-theme").dispatchEvent(new Event("change"))')
    await click('#btn-save-settings')
    await until(() => ui('document.documentElement.dataset.theme === "light"'), 'saved light theme')
    pass('theme setting persists explicit dark and light choices')
    // 原生标题栏覆盖层不受 CSS 控制，切换主题时必须同步更新颜色
    const originalOverlay = BaseWindow.prototype.setTitleBarOverlay
    const overlayCalls = []
    BaseWindow.prototype.setTitleBarOverlay = function (opts) {
      overlayCalls.push(opts)
      return originalOverlay.call(this, opts)
    }
    try {
      await ui('window.aa.settingsSet({theme:"dark"})')
      await ui('window.aa.settingsSet({theme:"light"})')
      const darkOverlay = overlayCalls.find((o) => o.color === '#0a0b10')
      const lightOverlay = overlayCalls.find((o) => o.color === '#ebf1f4')
      assert.ok(darkOverlay && lightOverlay, `title bar overlay did not follow theme: ${JSON.stringify(overlayCalls)}`)
      assert.equal(lightOverlay.symbolColor, '#1d2a2f')
    } finally {
      BaseWindow.prototype.setTitleBarOverlay = originalOverlay
    }
    pass('native title bar overlay follows the light/dark theme setting')
    await click('#btn-close-settings')

    const restoredA = initial.tabs.find(tab => tab.url === base + '/restored-a')
    const restoredB = initial.tabs.find(tab => tab.url === base + '/restored-b')
    // Map by the distinct fixture URLs without consulting which view is attached.
    const restoredContents = (tab) => until(() => webContents.getAllWebContents().find(wc => wc.getURL() === tab.url), `WebContents for ${tab.url}`)
    const [pageA, pageB] = await Promise.all([restoredContents(restoredA), restoredContents(restoredB)])
    const assertSelectedView = async (tab, expectedPage, expectedFocus) => {
      assert.equal((await state()).activeId, tab.id)
      assert.deepEqual(browserWindow.contentView.children.map(view => view.webContents?.id), [expectedPage.id, chrome.id], `${tab.url} must be the only page view, below the shell`)
      assert.equal(webContents.getFocusedWebContents()?.id, expectedFocus.id, `unexpected native focus after selecting ${tab.url}`)
    }
    await click(`[data-tab-id="${restoredA.id}"]`)
    await until(() => webContents.getFocusedWebContents() === pageA, 'default tab click focuses restored-a')
    await assertSelectedView(restoredA, pageA, pageA)
    pass('clicking a tab attaches only its native page below the shell and focuses it')

    // visible 模式保留旧行为：客户端在自己的标签间切换页面，但不抢外壳焦点。
    chrome.focus()
    await until(() => webContents.getFocusedWebContents() === chrome, 'shell focus before MCP tab selection')
    await tool('browser_tabs', { action: 'select', tabId: restoredB.id })
    await assertSelectedView(restoredB, pageB, chrome)
    pass('MCP tab selection attaches only the requested native page below the shell and retains shell focus')

    // Native non-client dragging requires OS input, not DOM MouseEvent dispatch.
    // Check layout here; actual dragging/maximize is a separate desktop acceptance.
    const dragRegion = await ui(`(() => {
      const el = document.querySelector('#window-drag-region')
      const r = el.getBoundingClientRect()
      const controls = Array.from(document.querySelectorAll('#tabstrip button, #tabstrip .tab')).map((node) => node.getBoundingClientRect())
      return { width: r.width, height: r.height, appRegion: getComputedStyle(el).getPropertyValue('-webkit-app-region'), overlaps: controls.some((b) => r.left < b.right && r.right > b.left && r.top < b.bottom && r.bottom > b.top) }
    })()`)
    assert.ok(dragRegion.width >= 64 && dragRegion.height >= 24)
    assert.equal(dragRegion.appRegion, 'drag')
    assert.equal(dragRegion.overlaps, false)
    pass('title bar reserves a native drag region separate from tabs and buttons (layout only)')

    const beforeTabPress = browserWindow.getBounds()
    await click(`[data-tab-id="${restoredA.id}"]`)
    await until(() => webContents.getFocusedWebContents() === pageA, 'reselecting restored-a focuses its page')
    await assertSelectedView(restoredA, pageA, pageA)
    assert.deepEqual(browserWindow.getBounds(), beforeTabPress)
    assert.equal(await ui(`getComputedStyle(document.querySelector('.tab')).getPropertyValue('-webkit-app-region')`), 'no-drag')
    pass('clicking a tab selects its page without moving the window')

    // ── P1-1：活动 HUD 把外壳视图铺满整窗时，页面区域仍必须能点 ──
    const hudTabId = (await state()).activeId
    await tool('browser_navigate', { url: base + '/hud-pointer', tabId: hudTabId, snapshot: false })
    const hudPage = await until(
      () => webContents.getAllWebContents().find((wc) => wc !== chrome && wc.getURL() === base + '/hud-pointer'),
      'hud pointer fixture page'
    )
    await until(() => hudPage.executeJavaScript('!!document.querySelector("#hud-target")', false), 'hud pointer fixture DOM')
    const hudWait = tool('browser_wait', { tabId: hudTabId, text: 'HUD指针测试_永不出现', timeoutMs: 6000 }).catch(() => undefined)
    await until(async () => (await state()).agentActivity?.active === true, 'activity HUD active for pointer forwarding', 5000)
    const hudView = BaseWindow.getAllWindows()[0].contentView.children.find((view) => view.webContents === hudPage)
    assert.ok(hudView, 'activity HUD still keeps the page view attached')
    const hudPageTop = hudView.getBounds().y
    assert.equal(parseFloat(await ui('document.documentElement.style.getPropertyValue("--page-top")')), hudPageTop, 'renderer page-top mirrors the native page bounds')
    const hudPoint = await hudPage.executeJavaScript(`(() => {
      const r = document.querySelector('#hud-target').getBoundingClientRect()
      return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }
    })()`, false)
    chrome.focus()
    let forwarded = false
    for (let attempt = 0; attempt < 4 && !forwarded; attempt++) {
      chrome.sendInputEvent({ type: 'mouseMove', x: hudPoint.x, y: hudPoint.y + hudPageTop })
      chrome.sendInputEvent({ type: 'mouseDown', x: hudPoint.x, y: hudPoint.y + hudPageTop, button: 'left', clickCount: 1 })
      chrome.sendInputEvent({ type: 'mouseUp', x: hudPoint.x, y: hudPoint.y + hudPageTop, button: 'left', clickCount: 1 })
      await pause(200)
      forwarded = await hudPage.executeJavaScript('window.__hudClicks >= 1', false)
    }
    assert.equal(forwarded, true, 'click in the page area must be forwarded through the full-window HUD shell')
    // 页面内的 DOM wheel（deltaY 正 = 向下）也应被转发；直接派发可绕开原生输入的符号不确定性。
    await chrome.executeJavaScript(`(() => {
      const x = 40, y = ${hudPageTop + 300}
      const event = new WheelEvent('wheel', { deltaY: 300, clientX: x, clientY: y, bubbles: true, cancelable: true })
      document.elementFromPoint(x, y)?.dispatchEvent(event) ?? document.body.dispatchEvent(event)
    })()`, true)
    await until(() => hudPage.executeJavaScript('window.scrollY > 0', false), 'wheel forwarded through the activity HUD', 5000)
    await hudWait
    pass('activity HUD forwards page-area mouse clicks and wheel scrolling instead of swallowing them')
    // 恢复原地址：后续地址栏用例按会话记录里的 restored-a URL 断言。
    await tool('browser_navigate', { url: base + '/restored-a', tabId: hudTabId, snapshot: false })
    await until(() => hudPage.getURL() === base + '/restored-a', 'hud fixture tab restored to its session URL')

    // ── F12 / Ctrl+Shift+I：当前网页 DevTools（v0.8.0）──
    const activePageNow = await until(async () => {
      const s = await state()
      const tab = s.tabs.find((t) => t.active)
      return webContents.getAllWebContents().find((wc) => wc !== chrome && wc.getURL() === tab?.url) ?? null
    }, 'active webpage webContents')
    activePageNow.focus()
    activePageNow.sendInputEvent({ type: 'keyDown', keyCode: 'F12' })
    activePageNow.sendInputEvent({ type: 'keyUp', keyCode: 'F12' })
    await until(() => activePageNow.isDevToolsOpened(), 'F12 opens the current webpage DevTools')
    pass('F12 opens DevTools for the current webpage')
    activePageNow.sendInputEvent({ type: 'keyDown', keyCode: 'F12' })
    activePageNow.sendInputEvent({ type: 'keyUp', keyCode: 'F12' })
    await until(() => !activePageNow.isDevToolsOpened(), 'F12 closes the DevTools again')
    pass('F12 received by the webpage toggles its DevTools closed')

    chrome.focus()
    chrome.sendInputEvent({ type: 'keyDown', keyCode: 'I', modifiers: ['control', 'shift'] })
    chrome.sendInputEvent({ type: 'keyUp', keyCode: 'I', modifiers: ['control', 'shift'] })
    await until(() => activePageNow.isDevToolsOpened(), 'shell Ctrl+Shift+I opens the active webpage DevTools')
    pass('Ctrl+Shift+I from the shell targets the active webpage')
    chrome.sendInputEvent({ type: 'keyDown', keyCode: 'I', modifiers: ['control', 'shift'] })
    chrome.sendInputEvent({ type: 'keyUp', keyCode: 'I', modifiers: ['control', 'shift'] })
    await until(() => !activePageNow.isDevToolsOpened(), 'shell Ctrl+Shift+I closes the DevTools again')
    pass('Ctrl+Shift+I from the shell toggles DevTools closed')
    assert.equal(chrome.isDevToolsOpened(), false)

    // ── P1-2：DevTools 断开调试通道后，守卫必须自动重新挂载 ──
    await until(() => activePageNow.debugger.isAttached(), 'debugger reattaches after DevTools closes', 10_000)
    await activePageNow.reload()
    await until(
      () => activePageNow.executeJavaScript(
        '!!window.__aaDialogGuardInstalled && typeof window[Symbol.for("aa.closedRoots")] === "function"',
        false
      ).catch(() => false),
      'dialog and closed-shadow guards restored for a new document',
      10_000
    )
    pass('DevTools close reinstalls dialog/closed-shadow guards for subsequent documents')
    await click('#btn-settings')
    await until(() => ui('document.activeElement?.id === "btn-close-settings"'), 'settings focus before DevTools guard')
    let modalDevToolsOpened = 0
    const onModalDevToolsOpened = () => { modalDevToolsOpened++ }
    activePageNow.on('devtools-opened', onModalDevToolsOpened)
    chrome.on('devtools-opened', onModalDevToolsOpened)
    try {
      chrome.sendInputEvent({ type: 'keyDown', keyCode: 'F12' })
      chrome.sendInputEvent({ type: 'keyUp', keyCode: 'F12' })
      await pause(100)
      assert.equal(modalDevToolsOpened, 0, 'modal F12 must never open DevTools')
      assert.equal(activePageNow.isDevToolsOpened(), false)
      assert.equal(webContents.getFocusedWebContents()?.id, chrome.id)
      await ui('window.aa.devtools()')
      await pause(100)
      assert.equal(modalDevToolsOpened, 0, 'modal IPC must never open DevTools')
      assert.equal(activePageNow.isDevToolsOpened(), false)
      assert.equal(chrome.isDevToolsOpened(), false)
      assert.equal(webContents.getFocusedWebContents()?.id, chrome.id)
      assert.equal(await ui('document.activeElement?.id'), 'btn-close-settings')
    } finally {
      activePageNow.removeListener('devtools-opened', onModalDevToolsOpened)
      chrome.removeListener('devtools-opened', onModalDevToolsOpened)
    }
    await click('#btn-close-settings')
    pass('settings modal blocks both F12 and shell DevTools IPC without moving focus')

    await ui(`window.aa.tabNew(${jsLiteral(base + '/normal')})`)
    await until(async () => (await state()).tabs.some((t) => t.active && t.url === base + '/normal' && !t.loading), 'normal page')
    const normalId = (await state()).activeId
    const page = await activePage()
    await until(() => page.executeJavaScript('document.body.innerText.includes("needle")'), 'fixture DOM')
    assert.equal((await state()).tabs.find((tab) => tab.id === normalId).canBack, false)
    assert.deepEqual(page.navigationHistory.getAllEntries().map(({ url }) => url), [base + '/normal'])
    pass('first page in a new desktop tab has no synthetic blank history entry')

    // ── P1-4：ref 单调递增、失连元素按 DOM 顺序复用、隐藏目标拒绝点击 ──
    await tool('browser_navigate', { url: base + '/ref-fixture', tabId: normalId, snapshot: false })
    const refPage = await until(
      () => webContents.getAllWebContents().find((wc) => wc !== chrome && wc.getURL() === base + '/ref-fixture'),
      'ref fixture page'
    )
    await until(() => refPage.executeJavaScript('!!document.querySelector("#ref-list")', false), 'ref fixture DOM')
    const refsNow = async () => Object.fromEntries(JSON.parse(await refPage.executeJavaScript(
      'JSON.stringify((window.__aaSnapState?.elements || []).map((el) => [el.name, el.ref]))',
      false
    )))
    await tool('browser_snapshot', { tabId: normalId, full: true })
    const refsA = await refsNow()
    assert.deepEqual(
      ['One', 'Two', 'Three', 'Hidden target'].map((name) => refsA[name]),
      ['e1', 'e2', 'e3', 'e4'],
      `initial full snapshot must allocate refs in DOM order: ${JSON.stringify(refsA)}`
    )
    await tool('browser_snapshot', { tabId: normalId, full: true })
    const refsB = await refsNow()
    assert.ok(
      Object.values(refsB).every((ref) => Number(ref.slice(1)) > 4),
      `a forced full snapshot must keep the ref counter monotonic: ${JSON.stringify(refsB)}`
    )
    await refPage.executeJavaScript('document.querySelector("#hidden-target").style.display = "none"', false)
    await assert.rejects(
      tool('browser_click', { tabId: normalId, ref: refsB['Hidden target'], snapshot: false }),
      /hidden|not-visible/,
      'a hidden snapshot target must be rejected instead of clicked at a stale position'
    )
    assert.equal(await refPage.executeJavaScript('window.__hiddenClicks || 0', false), 0)
    await refPage.executeJavaScript(
      `document.querySelector('#ref-list').innerHTML = '<li><button>One</button></li><li><button>Two</button></li><li><button>Three</button></li>'`,
      false
    )
    await tool('browser_snapshot', { tabId: normalId })
    const refsC = await refsNow()
    for (const name of ['One', 'Two', 'Three']) {
      assert.equal(refsC[name], refsB[name], `disconnected refs must be reused FIFO for ${name}: ${JSON.stringify({ refsB, refsC })}`)
    }
    const pointed = await refPage.executeJavaScript(`(() => {
      const out = {}
      for (const [ref, el] of Object.entries(window.__aaRefs || {})) if (el && el.textContent) out[ref] = el.textContent.trim()
      return out
    })()`, false)
    for (const name of ['One', 'Two', 'Three']) assert.equal(pointed[refsC[name]], name, `${refsC[name]} must point at ${name}`)
    pass('snapshot refs stay monotonic, reuse disconnected refs in DOM order, and reject hidden targets')

    const roundTripUrl = base + '/address-roundtrip?encoded=%2F%23&query=one%20two#route/part?mode=edit'
    await ui(`window.aa.submit(${jsLiteral(roundTripUrl)})`)
    await until(async () => (await state()).tabs.some((t) => t.active && t.url === roundTripUrl && !t.loading), 'address round-trip fixture')
    await click('#omnibox')
    const addressSelection = () => ui('({value:document.querySelector("#omnibox").value,start:document.querySelector("#omnibox").selectionStart,end:document.querySelector("#omnibox").selectionEnd})')
    assert.deepEqual(await addressSelection(), { value: roundTripUrl, start: 0, end: roundTripUrl.length })
    pass('focusing the address bar selects the complete URL including HTTP scheme, query and hash route')
    if (process.env.AA_DESKTOP_SCREENSHOTS === '1') {
      fs.writeFileSync(path.join(runDir, 'omnibox-edit.png'), (await chrome.capturePage()).toPNG())
    }
    chrome.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    chrome.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await until(() => ui('document.activeElement.id !== "omnibox"'), 'address submit blur')
    await until(async () => (await state()).tabs.some((t) => t.active && !t.loading), 'address submit completion')
    assert.equal(page.getURL(), roundTripUrl)
    pass('address-bar Enter without edits preserves the HTTP origin and hash route')

    page.focus()
    page.sendInputEvent({ type: 'keyDown', keyCode: 'L', modifiers: ['control'] })
    page.sendInputEvent({ type: 'keyUp', keyCode: 'L', modifiers: ['control'] })
    await until(() => ui('document.activeElement.id === "omnibox"'), 'full URL Ctrl+L')
    assert.deepEqual(await addressSelection(), { value: roundTripUrl, start: 0, end: roundTripUrl.length })
    await ui('document.querySelector("#omnibox").setSelectionRange(5, 8)')
    chrome.sendInputEvent({ type: 'keyDown', keyCode: 'L', modifiers: ['control'] })
    chrome.sendInputEvent({ type: 'keyUp', keyCode: 'L', modifiers: ['control'] })
    assert.deepEqual(await addressSelection(), { value: roundTripUrl, start: 0, end: roundTripUrl.length })
    pass('Ctrl+L selects the complete address both from the page and while already editing')

    const editedUrl = base + '/address-edited?encoded=%2F%23&query=one%20two#route/part?mode=edit'
    await ui(`document.querySelector("#omnibox").value=${jsLiteral(editedUrl)}`)
    chrome.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    chrome.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await until(async () => (await state()).tabs.some((t) => t.active && t.url === editedUrl && !t.loading), 'edited URL navigation')
    assert.equal(page.getURL(), editedUrl)
    pass('editing a path preserves its HTTP origin, encoded query and hash route')

    await click('#omnibox')
    const draft = base + '/address-'
    await ui(`document.querySelector("#omnibox").value=${jsLiteral(draft)}; document.querySelector("#omnibox").dispatchEvent(new Event("input"))`)
    await ui('window.aa.settingsSet({fullSnapshot:true})')
    assert.equal((await addressSelection()).value, draft)
    await until(() => ui('!document.querySelector("#suggest-panel").hidden'), 'draft suggestions')
    chrome.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    chrome.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await until(() => ui('document.querySelector("#suggest-panel").hidden'), 'first Escape closes suggestions')
    assert.equal((await addressSelection()).value, draft)
    assert.equal(await ui('document.activeElement.id'), 'omnibox')
    chrome.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    chrome.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' })
    await until(() => ui('document.activeElement.id !== "omnibox"'), 'second Escape cancels address editing')
    assert.equal((await addressSelection()).value, new URL(editedUrl).host + new URL(editedUrl).pathname + new URL(editedUrl).search + new URL(editedUrl).hash)
    assert.equal(page.getURL(), editedUrl)
    pass('background state preserves a draft; Escape closes suggestions first and then restores the current address without navigation')
    await click('#omnibox')
    assert.equal((await addressSelection()).value, editedUrl)
    await ui(`document.querySelector("#omnibox").value=${jsLiteral(draft)}`)
    await click('#btn-reload')
    assert.equal((await addressSelection()).value, new URL(editedUrl).host + new URL(editedUrl).pathname + new URL(editedUrl).search + new URL(editedUrl).hash)
    pass('blur immediately replaces an unsubmitted draft with the current compact address')

    await click('#omnibox')
    await ui(`document.querySelector("#omnibox").value=${jsLiteral(draft)}; document.querySelector("#omnibox").dispatchEvent(new Event("input"))`)
    await until(() => ui('!document.querySelector("#suggest-panel").hidden'), 'suggestions before tab switch')
    const otherTab = initial.tabs[0]
    await ui(`window.aa.tabSelect(${jsLiteral(otherTab.id)}, false)`)
    await until(async () => (await addressSelection()).value === otherTab.url, 'focused address follows tab switch')
    assert.equal(await ui('document.activeElement.id'), 'omnibox')
    assert.deepEqual(await addressSelection(), { value: otherTab.url, start: 0, end: otherTab.url.length })
    assert.equal(await ui('document.querySelector("#suggest-panel").hidden'), true)
    await ui(`window.aa.tabSelect(${jsLiteral(normalId)}, false)`)
    await until(async () => (await addressSelection()).value === editedUrl, 'focused address follows original tab')
    pass('switching tabs while editing resets the address and stale suggestions to the newly active tab')

    await ui(`document.querySelector("#omnibox").value=${jsLiteral(draft)}; document.querySelector("#omnibox").dispatchEvent(new Event("input"))`)
    await until(() => ui('!document.querySelector("#suggest-panel").hidden'), 'keyboard history suggestions')
    const suggestedUrl = await ui('document.querySelector("#suggestion-0 .suggest-url").textContent')
    chrome.sendInputEvent({ type: 'keyDown', keyCode: 'Down' })
    chrome.sendInputEvent({ type: 'keyUp', keyCode: 'Down' })
    assert.equal((await addressSelection()).value, suggestedUrl)
    chrome.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    chrome.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
    await until(async () => (await state()).tabs.some((t) => t.active && t.url === suggestedUrl && !t.loading), 'keyboard suggestion navigation')
    await click('#omnibox')
    await ui(`document.querySelector("#omnibox").value=${jsLiteral(draft)}; document.querySelector("#omnibox").dispatchEvent(new Event("input"))`)
    await until(() => ui('!document.querySelector("#suggest-panel").hidden'), 'mouse history suggestions')
    const clickedUrl = await ui('document.querySelector("#suggestion-0 .suggest-url").textContent')
    await click('#suggestion-0')
    await until(async () => (await state()).tabs.some((t) => t.active && t.url === clickedUrl && !t.loading), 'mouse suggestion navigation')
    pass('keyboard and mouse history suggestions still navigate to their complete URL')

    // Renderer-only fixture: Chromium normally strips userinfo. Exercise the
    // state boundary without sending credentials or navigating to external URLs.
    const rendererState = await state()
    chrome.send('aa:state', { ...rendererState, tabs: rendererState.tabs.map((t) => t.active ? { ...t, url: 'https://fixture-user:fixture-secret@example.test/path?x=1#route' } : t) })
    await click('#omnibox')
    assert.equal((await addressSelection()).value, 'https://example.test/path?x=1#route')
    await ui('document.querySelector("#omnibox").blur()')
    chrome.send('aa:state', rendererState)
    pass('renderer URL editing strips embedded username and password rather than revealing them')

    await ui(`window.aa.submit(${jsLiteral(base + '/normal')})`)
    await until(async () => (await state()).tabs.some((t) => t.active && t.url === base + '/normal' && !t.loading), 'restore normal fixture after address checks')
    await ui('window.aa.settingsSet({requireOperationApproval:true})')
    const captured = await tool('browser_network_requests', { tabId: normalId })
    const capturedId = /\[([^\]]+)\]/.exec(toolText(captured))?.[1]
    assert.ok(capturedId, 'desktop fixture should have a captured request')
    const sensitiveCall = tool('browser_network_detail', { tabId: normalId, requestId: capturedId, includeSensitive: true }).then(
      () => null,
      (error) => error
    )
    await until(async () => (await state()).pendingApprovals.length === 1, 'sensitive network approval')
    const approvalId = (await state()).pendingApprovals[0].id
    await click('#omnibox')
    await click(`[data-focus-key="approval-deny:${approvalId}"]`)
    const denied = await sensitiveCall
    assert.match(denied?.message ?? '', /高危操作已取消/)
    await ui('window.aa.settingsSet({requireOperationApproval:false})')
    pass('sensitive network disclosure is blocked until the user approves it')
    const reloadResult = await tool('browser_reload', { tabId: normalId, snapshot: false })
    assert.match(toolText(reloadResult), /已刷新:/)
    await until(() => page.executeJavaScript('document.body.innerText.includes("needle")'), 'reloaded fixture DOM')
    await tool('browser_press_key', { tabId: normalId, key: 'Ctrl+Shift+R' })
    await until(() => page.executeJavaScript('document.body.innerText.includes("needle")'), 'browser_press_key Ctrl+Shift+R')
    page.focus()
    pass('browser_reload and browser_press_key support tab targeting and Ctrl combinations')
    page.sendInputEvent({ type: 'keyDown', keyCode: 'F', modifiers: ['control'] })
    page.sendInputEvent({ type: 'keyUp', keyCode: 'F', modifiers: ['control'] })
    await until(() => ui('!document.querySelector("#find-bar").hidden && document.activeElement.id === "find-query"'), 'Ctrl+F')
    chrome.insertText('needle')
    await until(async () => (await state()).find?.matches === 3, 'native match count')
    pass('Ctrl+F from webpage focuses native page search; finds all 3 matches')
    await page.executeJavaScript(`new Promise(resolve => {
      const frame = document.querySelector('iframe');
      frame.onload = () => { frame.onload = null; frame.contentWindow.history.pushState({}, '', '/frame-spa'); resolve(); };
      frame.src = '/frame';
    })`)
    assert.equal((await state()).tabs.find((t) => t.id === normalId).url, base + '/normal')
    pass('iframe SPA navigation cannot overwrite the top-level tab URL')
    const firstMatch = (await state()).find.activeMatch
    await click('#find-next')
    await until(async () => (await state()).find.activeMatch !== firstMatch, 'next match')
    await click('#find-prev')
    await until(async () => (await state()).find.activeMatch === firstMatch, 'previous match')
    pass('find next/previous move the native selection')
    // Screenshot export needs a visible Windows compositor; opt in for visual QA.
    if (process.env.AA_DESKTOP_SCREENSHOTS === '1') {
      BaseWindow.getAllWindows()[0].show()
      chrome.setBackgroundThrottling(false)
      await pause(400)
      fs.mkdirSync(path.join(ROOT, 'docs/screenshots'), { recursive: true })
      fs.writeFileSync(path.join(ROOT, 'docs/screenshots/page-find-toolbar.png'), (await chrome.capturePage()).toPNG())
    }
    await ui('window.aa.find("definitely-absent")')
    await until(() => ui('document.querySelector("#find-status").textContent === (document.documentElement.lang === "en-US" ? "No matches" : "未找到匹配")'), 'no results')
    await ui('window.aa.find("")')
    assert.equal((await state()).find.matches, 0)
    await click('#find-close')
    assert.equal((await state()).find.open, false)
    pass('empty/no-match/close states clear the native search')

    page.focus()
    page.sendInputEvent({ type: 'keyDown', keyCode: 'L', modifiers: ['control'] })
    page.sendInputEvent({ type: 'keyUp', keyCode: 'L', modifiers: ['control'] })
    await until(() => ui('document.activeElement.id === "omnibox"'), 'Ctrl+L from webpage')
    const countBeforeShortcut = (await state()).tabs.length
    page.focus()
    page.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: ['control'] })
    page.sendInputEvent({ type: 'keyUp', keyCode: 'T', modifiers: ['control'] })
    await until(async () => (await state()).tabs.length === countBeforeShortcut + 1, 'Ctrl+T from webpage')
    page.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['control'] })
    page.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers: ['control'] })
    await until(async () => (await state()).tabs.length === countBeforeShortcut, 'Ctrl+W from webpage')
    pass('Ctrl+L/T/W work through the page keyboard handler')

    await click('#btn-downloads')
    await until(() => ui('!document.querySelector("#download-panel").hidden'), 'downloads open')
    let window = BaseWindow.getAllWindows()[0]
    let shellView = window.contentView.children.find((v) => v.webContents === chrome)
    await until(async () => shellView.getBounds().height >= await ui('document.querySelector("#download-panel").getBoundingClientRect().bottom'), 'downloads native bounds')
    await click('#btn-close-dl')
    await until(() => shellView.getBounds().height === 84, 'downloads native bounds reset')
    await click('#btn-feed')
    await until(async () => shellView.getBounds().height >= await ui('document.querySelector("#action-feed-drawer").getBoundingClientRect().bottom'), 'feed native bounds')
    await click('#btn-close-feed')
    await until(() => shellView.getBounds().height === 84, 'feed native bounds reset')
    pass('downloads and action feed fit native view bounds and release area on close')

    const historyFile = path.join(process.env.AA_BROWSER_HISTORY_DIR, 'history.json')
    await until(() => fs.existsSync(historyFile), 'history file')
    assert.ok(JSON.parse(fs.readFileSync(historyFile)).some((e) => e.url === base + '/normal'))
    // This standalone panel-sizing fixture needs native shell focus before its DOM setup.
    chrome.focus()
    await ui('document.querySelector("#omnibox").focus(); document.querySelector("#omnibox").value="127"; document.querySelector("#omnibox").dispatchEvent(new Event("input"))')
    await until(() => ui('!document.querySelector("#suggest-panel").hidden'), 'history suggestions')
    await until(async () => shellView.getBounds().height >= await ui('document.querySelector("#suggest-panel").getBoundingClientRect().bottom'), 'suggestions native bounds')
    await ui('document.querySelector("#omnibox").blur()')
    await until(() => shellView.getBounds().height === 84, 'suggestions close')
    pass('history suggestions render beyond toolbar and return view bounds on blur')

    await ui(`window.aa.tabClose(${jsLiteral(normalId)})`)
    assert.equal((await state()).canReopenClosed, true)
    chrome.sendInputEvent({ type: 'keyDown', keyCode: 'T', modifiers: ['control', 'shift'] })
    chrome.sendInputEvent({ type: 'keyUp', keyCode: 'T', modifiers: ['control', 'shift'] })
    await until(async () => (await state()).tabs.some((t) => t.active && t.url === base + '/normal'), 'Ctrl+Shift+T')
    assert.equal((await state()).tabs.find((t) => t.active).isolated, false)
    pass('Ctrl+Shift+T restores normal URL as a normal tab')
    await ui('window.aa.findOpen()')
    await ui('window.aa.tabNew()')
    assert.equal((await state()).find.open, false)
    pass('tab switch closes search and isolates asynchronous results')

    // 站点权限请求：不再静默拒绝，而是进入人工审批；允许后同会话内查询为 granted
    await tool('browser_tabs', { action: 'new', url: base + '/perm-fixture' })
    await until(async () => (await state()).tabs.some((t) => t.active && t.url.startsWith(base) && !t.loading), 'permission fixture page')
    const permPage = await until(
      () => webContents.getAllWebContents().find((wc) => wc !== chrome && wc.getURL().startsWith(base)) ?? null,
      'permission fixture webContents'
    )
    assert.ok(permPage)
    const permPromise = permPage.executeJavaScript('Notification.requestPermission()').then(
      (value) => ({ ok: true, value }),
      (error) => ({ ok: false, error })
    )
    await until(async () => (await state()).pendingApprovals?.some((p) => p.kind === 'permission'), 'permission approval visible', 5000)
    const permApproval = (await state()).pendingApprovals.find((p) => p.kind === 'permission')
    assert.equal(permApproval.permission, 'notifications')
    await ui(`window.aa.decideApproval(${jsLiteral(permApproval.id)}, true)`)
    const permOutcome = await Promise.race([permPromise, pause(4000).then(() => ({ ok: false, timedOut: true }))])
    assert.equal(permOutcome.timedOut, undefined, 'permission promise must settle after approval')
    assert.equal(permOutcome.ok, true, `permission request failed: ${permOutcome.error?.message}`)
    assert.equal(permOutcome.value, 'granted')
    const permQuery = await permPage.executeJavaScript('navigator.permissions.query({name:"notifications"}).then(p=>p.state)')
    assert.equal(permQuery, 'granted')
    pass('site permission prompts use the approval panel and grants persist in the session')

    await tool('browser_tabs', { action: 'new', url: base + '/private', isolated: true })
    await until(async () => (await state()).tabs.some((t) => t.active && t.url === base + '/private' && !t.loading), 'private page')
    const privatePage = await activePage()
    assert.equal(await privatePage.executeJavaScript('typeof window.aa'), 'undefined')
    const permission = await privatePage.executeJavaScript('navigator.permissions.query({name:"clipboard-read"}).then(p=>p.state)')
    assert.equal(permission, 'denied')
    pass('web page has no privileged bridge and clipboard-read permission is denied')
    await privatePage.executeJavaScript('history.pushState({}, "", "/private-spa")')
    const tabsBefore = (await state()).tabs.length
    await privatePage.executeJavaScript(`window.open(${jsLiteral(base + '/popup-private')})`)
    await until(async () => (await state()).tabs.length === tabsBefore + 1, 'private popup')
    await until(async () => (await state()).tabs.some((t) => t.active && t.url === base + '/popup-private' && !t.loading), 'private popup load')
    const privateTabs = (await state()).tabs.filter((t) => t.isolated)
    assert.equal(privateTabs.length, 2)
    const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'))
    assert.equal(history.some((e) => /private/.test(e.url)), false)
    for (const tab of privateTabs) await ui(`window.aa.tabClose(${jsLiteral(tab.id)})`)
    assert.equal((await state()).canReopenClosed, false)
    pass('private navigation/SPA/popup stay isolated and never enter history or restore stack')
    await until(() => {
      try {
        const persisted = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
        return persisted.tabs.some((tab) => tab.url === base + '/normal') && !persisted.tabs.some((tab) => /private/.test(tab.url))
      } catch {
        return false
      }
    }, 'session record excludes isolated tabs')
    pass('session record persists normal tabs and never persists isolated ones')

    // The right-click route must preserve the same isolation policy.
    await tool('browser_tabs', { action: 'new', url: base + '/private-context', isolated: true })
    await until(async () => (await state()).tabs.some((t) => t.active && t.url === base + '/private-context' && !t.loading), 'context source')
    const contextSource = await activePage()
    const originalPopup = Menu.prototype.popup
    const originalMenuLocale = (await ui('window.aa.settingsGet()')).settings.locale
    // 'auto' 会跟随系统语言，CI  runner 通常是英文；固定中文后再断言中文菜单项
    await ui('window.aa.settingsSet({locale:"zh-CN"})')
    let contextItem
    let contextLabels = []
    Menu.prototype.popup = function () {
      contextLabels = this.items.map((item) => item.label)
      // 图片菜单里没有链接项；保留第一次捕获的链接项，供最后点击使用。
      contextItem = this.items.find((item) => item.label === '在新标签页打开链接') ?? contextItem
    }
    try {
      contextSource.emit('context-menu', {}, { linkURL: base + '/private-context-child', selectionText: '', isEditable: false })
      assert.ok(contextItem)
      // 右键菜单的图片项与打印项（原有测试只覆盖了链接项）。
      // 原生菜单只服务活动页，因此必须在切走标签前完成这几项检查。
      contextSource.emit('context-menu', {}, { mediaType: 'image', srcURL: base + '/pic.png', selectionText: '', isEditable: false })
      assert.ok(contextLabels.includes('复制图片地址') && contextLabels.includes('图片另存为') && contextLabels.includes('打印'),
        `missing image/print items: ${JSON.stringify(contextLabels)}`)
      // 语言设置驱动原生菜单文案
      await ui('window.aa.settingsSet({locale:"en-US"})')
      contextSource.emit('context-menu', {}, { mediaType: 'image', srcURL: base + '/pic2.png', selectionText: '', isEditable: false })
      assert.ok(contextLabels.includes('Copy Image Address') && contextLabels.includes('Print'),
        `English menu labels missing: ${JSON.stringify(contextLabels)}`)
      // 最后点击链接项会把子标签变为活动页，后面的隔离断言依赖这一点。
      contextItem.click()
    } finally {
      Menu.prototype.popup = originalPopup
      await ui(`window.aa.settingsSet({locale:${jsLiteral(originalMenuLocale)}})`)
    }
    await until(async () => (await state()).tabs.some((t) => t.active && t.url === base + '/private-context-child'), 'context child')
    assert.equal((await state()).tabs.find((t) => t.active).isolated, true)
    pass('context-menu link opening also preserves isolation')

    // Restoring must re-evaluate a newly tightened allowlist.
    await ui(`window.aa.tabNew(${jsLiteral(base + '/blocked-restore')})`)
    const blockedId = (await state()).activeId
    await until(async () => (await state()).tabs.find((t) => t.id === blockedId)?.url === base + '/blocked-restore', 'restore candidate')
    await ui(`window.aa.tabClose(${jsLiteral(blockedId)})`)
    await ui('window.aa.settingsSet({allowedSites:["https://example.com"]})')
    assert.equal(await ui('window.aa.tabReopen()'), false)
    await ui('window.aa.settingsSet({allowedSites:[]})')
    pass('reopen applies current site allowlist')
    for (const unsafeUrl of ['file:///C:/Windows/win.ini', 'data:text/html,<h1>unsafe</h1>', `view-source:${base}/blocked-source`]) {
      assert.equal(await ui(`window.aa.tabNew(${jsLiteral(unsafeUrl)})`), false, `rejects non-web navigation: ${unsafeUrl}`)
    }
    pass('navigation rejects local, data and view-source schemes while preserving the internal new-tab page')
    await click('#btn-settings')
    await until(() => ui('document.querySelector("#set-engine").options.length > 0'), 'settings reopen')
    await ui('document.querySelector("#set-engine-url").value="javascript:alert(1)"')
    await click('#btn-save-settings')
    await until(() => ui('document.querySelector("#settings-status").textContent.includes(document.documentElement.lang === "en-US" ? "Save failed" : "保存失败")'), 'save failure feedback')
    assert.equal((await ui('window.aa.settingsGet()')).settings.searchEngine, 'https://duckduckgo.com/?q=')
    pass('invalid settings show an error and preserve the previous value')
    await ui(`document.querySelector('#set-engine-url').value=${jsLiteral(base + '/search?q=')}; document.querySelector('#set-engine-url').dispatchEvent(new Event('input'))`)
    await click('#btn-save-settings')
    await until(() => ui('document.querySelector("#settings-status").textContent === (document.documentElement.lang === "en-US" ? "Saved" : "已保存")'), 'valid settings save')
    await click('#btn-close-settings')
    await tool('browser_navigate', { url: 'fresh search phrase', snapshot: false })
    await until(async () => (await state()).tabs.some((t) => t.active && t.url === base + '/search?q=fresh%20search%20phrase'), 'Agent search engine refresh')
    await tool('browser_tabs', { action: 'new', url: 'another search phrase' })
    await until(async () => (await state()).tabs.some((t) => t.active && t.url === base + '/search?q=another%20search%20phrase'), 'Agent new-tab search engine refresh')
    pass('both Agent search paths use updated settings without restarting')

    const newTabUrl = base + '/new-tab'
    const opened = await tool('browser_navigate', { url: newTabUrl, newTab: true, snapshot: false })
    assert.ok(toolText(opened).startsWith(`已导航: ${newTabUrl}\n`))
    assert.equal(newTabRequests, 1)
    assert.equal((await state()).tabs.find((tab) => tab.active).canBack, false)
    pass('MCP new-tab navigation loads the requested page once')

    const savedChoice = (await ui('window.aa.settingsGet()')).settings.locale
    const originalLanguage = await ui('document.documentElement.lang')
    const previewLanguage = originalLanguage === 'en-US' ? 'zh-CN' : 'en-US'
    async function selectLanguage(value) {
      await ui(`(() => {
        const select = document.querySelector('#set-locale');
        select.value = ${jsLiteral(value)};
        select.dispatchEvent(new Event('change'));
      })()`)
    }
    await click('#btn-settings')
    await selectLanguage(previewLanguage)
    assert.equal(await ui('document.documentElement.lang'), previewLanguage)
    await click('#btn-close-settings')
    assert.equal(await ui('document.documentElement.lang'), originalLanguage)
    await click('#btn-settings')
    await until(async () => (await ui('document.querySelector("#set-locale").value')) === savedChoice, 'saved locale displayed')
    pass('closing a language preview restores the language saved in settings')

    await selectLanguage('en-US')
    assert.equal(await ui('document.querySelector("#settings-engine-custom").textContent'), 'Custom address')
    assert.equal(await ui('document.querySelector("#settings-auto-update-label").textContent'), 'Check for and download updates automatically (notify before install)')
    await click('#btn-save-settings')
    await until(() => ui('document.querySelector("#settings-status").textContent === "Saved"'), 'save English locale')
    await click('#btn-close-settings')
    assert.equal(await ui('document.documentElement.lang'), 'en-US')
    assert.equal(JSON.parse(fs.readFileSync(process.env.AA_BROWSER_SETTINGS_FILE, 'utf8')).locale, 'en-US')
    pass('English settings controls translate live and saving persists the choice')
    await pause(500)
    await until(() => webContents.getAllWebContents().filter((wc) => wc !== chrome).every((wc) => !wc.isLoading()), 'all pages settle before shutdown')
    assert.equal(errors.length, 0, errors.join('\n'))
    pass('chrome renderer reports no console errors')

    const finalUrl = base + '/shutdown-final'
    await ui(`window.aa.tabNew(${jsLiteral(finalUrl)})`)
    await until(async () => (await state()).tabs.some((tab) => tab.active && tab.url === finalUrl), 'final shutdown tab')
    const persistedBeforeClose = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
    assert.equal(persistedBeforeClose.tabs.some((tab) => tab.url === finalUrl), false, 'shutdown fixture must observe the debounced save before close')
    const beforeClose = await state()
    const orderedUrls = [...new Set(beforeClose.tabs.filter((tab) => !tab.isolated && tab.url.startsWith(base + '/')).map((tab) => tab.url))]
    const activeUrl = beforeClose.tabs.find((tab) => tab.active)?.url
    assert.ok(orderedUrls.indexOf(activeUrl) > 0, 'shutdown fixture must have a non-first active tab')
    await new Promise((resolve) => { app.once('will-quit', resolve); window.close() })
    const saved = JSON.parse(fs.readFileSync(sessionFile, 'utf8'))
    assert.deepEqual(saved.tabs.map((tab) => tab.url), orderedUrls)
    assert.equal(saved.tabs[saved.activeIndex].url, activeUrl)
    pass('closing the native window preserves tab order and active tab in the session record')

    fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify({ status: 'PASS', checks: results, screenshot: process.env.AA_DESKTOP_SCREENSHOTS === '1' ? 'docs/screenshots/page-find-toolbar.png' : undefined }, null, 2))
    console.log(`PASS: all ${results.length} desktop checks; report ${path.join(runDir, 'result.json')}`)
    ws.close()
    server.close()
  } catch (error) {
    console.error('FAIL:', error)
    fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify({ status: 'FAIL', checks: results, error: error.stack }, null, 2))
    ws?.close()
    server.close()
    app.exit(1)
  }
  })().catch((error) => { console.error(error); process.exit(1) })
}
