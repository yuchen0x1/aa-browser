// Real Electron renderer crash injection. Plain Node spawns the Electron child;
// the child imports the production main process and drives it through MCP.
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import readline from 'node:readline'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket from 'ws'
import { startOperationApprovalDriver } from './trusted-approval-driver.mjs'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)

if (!process.versions.electron) {
  const parent = path.join(ROOT, '.local-verification')
  fs.mkdirSync(parent, { recursive: true })
  const run = fs.mkdtempSync(path.join(parent, 'renderer-crash-'))
  const env = {
    ...process.env,
    AA_BROWSER_TEST_NODE: process.execPath,
    AA_BROWSER_TEST_DIR: run,
    AA_BROWSER_AUTO_LAUNCH: '0',
    AA_BROWSER_START_IN_BACKGROUND: '1',
    AA_BROWSER_USER_DATA_DIR: path.join(run, 'profile'),
    AA_BROWSER_CONNECTION_FILE: path.join(run, 'connection.json'),
    AA_BROWSER_HISTORY_DIR: path.join(run, 'history'),
    AA_BROWSER_SETTINGS_FILE: path.join(run, 'settings.json'),
    AA_BROWSER_SESSION_FILE: path.join(run, 'session.json'),
    AA_BROWSER_DOWNLOAD_DIR: path.join(run, 'downloads'),
    AA_BROWSER_TASK_CENTER_FILE: path.join(run, 'task-center.json')
  }
  delete env.ELECTRON_RUN_AS_NODE
  fs.mkdirSync(env.AA_BROWSER_HISTORY_DIR, { recursive: true })
  fs.writeFileSync(env.AA_BROWSER_SETTINGS_FILE, JSON.stringify({ autoUpdate: false, restoreSession: false, backgroundMode: 'hidden' }))
  const child = spawn(require('electron'), [fileURLToPath(import.meta.url)], { cwd: ROOT, env, stdio: 'inherit' })
  const timer = setTimeout(() => { console.error('Renderer crash suite timed out'); child.kill() }, 300_000)
  child.on('exit', (code) => { clearTimeout(timer); process.exitCode = code ?? 1 })
} else {
  void run().catch((error) => { console.error(error); process.exit(1) })
}

async function until(fn, description, ms = 12_000) {
  const deadline = Date.now() + ms
  for (;;) {
    const value = await fn()
    if (value) return value
    if (Date.now() >= deadline) throw new Error(`Timed out: ${description}`)
    await delay(50)
  }
}

function findRef(text, pattern) {
  const ref = text.split('\n').find((line) => pattern.test(line))?.match(/\[ref=(e\d+)\]/)?.[1]
  assert.ok(ref, `Missing ref for ${pattern}`)
  return ref
}

async function run() {
  const { app, BaseWindow, webContents } = await import('electron')
  const runDir = process.env.AA_BROWSER_TEST_DIR
  const checks = []
  const skips = []
  const pass = (message) => { checks.push(message); console.log(`PASS: ${message}`) }
  const skip = (message) => { skips.push(message); console.warn(`SKIP: ${message}`) }
  let server
  let secondServer
  let child
  let rl
  let approvalDriver
  const pending = new Map()
  const sockets = []
  let id = 0
  let exitCode = 1
  try {
    app.setAppPath(ROOT)
    const htmlFor = (pathname) => {
      const head = `<!doctype html><meta charset=utf-8><title>Renderer crash fixture</title><h1>Renderer crash fixture</h1>`
      if (pathname === '/second') return `${head}<p id="sibling">sibling tab</p>`
      return `${head}
<button id="probe">Probe</button>
<button id="disabled" disabled>Disabled action</button>
<label>Readonly <input id="readonly" readonly value="fixed"></label>
<label>Editable <input id="editable" value=""></label>
<label>First <input id="first" value="keep"></label>
<div id="trapped-wrap"><label>Trapped <input id="trapped" value="safe"></label></div>
<button id="moving">Moving target</button>
<button id="hide">Hide me</button>
<button id="detach">Detach me</button>
<script>document.querySelector('#probe').onclick=()=>{document.title='clicked'}</script>`
    }
    server = http.createServer((req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      const body = htmlFor(new URL(req.url, 'http://fixture').pathname)
      if (['/slow-crash', '/delayed-nav'].includes(new URL(req.url, 'http://fixture').pathname)) setTimeout(() => res.end(body), 1500)
      else res.end(body)
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}/`
    secondServer = http.createServer((_req, res) => {
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.end(htmlFor(new URL(_req.url, 'http://fixture').pathname))
    })
    await new Promise((resolve) => secondServer.listen(0, resolve))
    const secondBase = `http://localhost:${secondServer.address().port}/`
    await import(pathToFileURL(path.join(ROOT, 'out/main/index.js')).href)
    await app.whenReady()
    await until(() => fs.existsSync(process.env.AA_BROWSER_CONNECTION_FILE), 'discovery')
    child = spawn(process.env.AA_BROWSER_TEST_NODE, [path.join(ROOT, 'cli/mcp.mjs')], { cwd: ROOT, stdio: ['pipe', 'pipe', 'inherit'] })
    rl = readline.createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      const message = JSON.parse(line)
      const waiter = pending.get(message.id)
      if (!waiter) return
      pending.delete(message.id)
      clearTimeout(waiter.timer)
      waiter.resolve(message)
    })
    const request = (method, params) => new Promise((resolve, reject) => {
      const requestId = ++id
      const timer = setTimeout(() => { pending.delete(requestId); reject(new Error(`MCP timeout: ${method}`)) }, 25_000)
      pending.set(requestId, { resolve, timer })
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`)
    })
    const call = async (name, args = {}, expectError) => {
      const response = await request('tools/call', { name, arguments: args })
      const result = response.result
      assert.equal(response.error, undefined, JSON.stringify(response.error))
      const text = result?.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? ''
      if (expectError) assert.match(text, expectError)
      else assert.notEqual(result?.isError, true, `${name}: ${text}`)
      return { text, result }
    }
    await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'renderer-crash-test', version: '1' } })
    const nav = await call('browser_navigate', { url: base })
    const ref = findRef(nav.text, /button.*Probe/)
    const info = JSON.parse(fs.readFileSync(process.env.AA_BROWSER_CONNECTION_FILE, 'utf8'))
    const endpoint = new URL(`ws://127.0.0.1:${info.port}/`)
    endpoint.searchParams.set('token', info.token)
    const ws = new WebSocket(endpoint)
    sockets.push(ws)
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    const chrome = await until(() => webContents.getAllWebContents().find((wc) => wc.getURL().endsWith('/renderer/index.html')), 'chrome')
    const state = () => chrome.executeJavaScript('window.aa.getState()')
    approvalDriver = startOperationApprovalDriver((script) => chrome.executeJavaScript(script, true))

    const pageWc = (prefix = base) => webContents.getAllWebContents().find((wc) => !wc.isDestroyed() && wc.getURL().startsWith(prefix))
    const target = await until(() => pageWc(), 'page webContents')
    const oldPid = target.getProcessId()
    const window = BaseWindow.getAllWindows()[0]
    assert.ok(window, 'browser window exists')
    assert.ok(oldPid > 0, 'renderer process id is available')

    const crash = async (wc) => {
      // Linux 上 Electron 可能只通过 app 级通道送达 render-process-gone；
      // 两路都观察，但只接受同一个 webContents，避免把其它 Renderer 当成目标。
      let cleanup = () => {}
      const gone = new Promise((resolve) => {
        const onGone = (details) => {
          cleanup()
          resolve(details)
        }
        const onWebContents = (_event, details) => onGone(details)
        const onApp = (_event, crashed, details) => {
          if (crashed === wc) onGone(details)
        }
        cleanup = () => {
          wc.removeListener('render-process-gone', onWebContents)
          app.removeListener('render-process-gone', onApp)
        }
        wc.once('render-process-gone', onWebContents)
        app.on('render-process-gone', onApp)
      })
      if (process.platform === 'linux') {
        const pid = wc.getOSProcessId()
        assert.ok(pid > 0, 'renderer OS process id before Linux crash injection')
        process.kill(pid, 'SIGKILL')
      } else {
        wc.forcefullyCrashRenderer()
      }
      const details = await Promise.race([gone, delay(12_000).then(() => null)])
      if (!details) cleanup()
      assert.ok(details, 'render-process-gone event')
      assert.ok(['crashed', 'killed', 'abnormal-exit'].includes(details.reason), `unexpected crash reason: ${JSON.stringify(details)}`)
    }
    await crash(target)
    const tabA = (await state()).tabs.find((tab) => tab.url.startsWith(base))
    assert.ok(tabA, 'tab A is present')
    await until(async () => ['recovering', 'recovered'].includes((await state()).tabs.find((tab) => tab.id === tabA.id)?.recovery?.status), 'recovery state')
    const during = (await state()).tabs.find((tab) => tab.id === tabA.id)
    assert.equal(during.recovery.reason, 'crash')
    assert.equal(during.recovery.attempts, 1)
    await until(async () => (await state()).tabs.find((tab) => tab.id === tabA.id)?.recovery?.status === 'recovered', 'recovered state')
    const recovered = (await state()).tabs.find((tab) => tab.id === tabA.id)
    assert.equal(recovered.id, during.id, 'tab id survives renderer restart')
    assert.equal(new URL(recovered.url).origin, new URL(base).origin, 'URL survives renderer restart')
    assert.ok(recovered.recovery.recoveredAt > during.recovery.lastAttemptAt)
    const recoveredPid = target.getProcessId()
    assert.ok(recoveredPid > 0, 'recovered renderer has a process id')
    pass('a real renderer crash injection triggers render-process-gone and bounded reload recovery')

    await call('browser_click', { ref, snapshot: false }, /reason=renderer_restarted/)
    const fresh = await call('browser_snapshot', { full: true })
    assert.match(fresh.text, /Renderer crash fixture/)
    pass('old ref is rejected and a fresh snapshot restores control after restart')

    await call('browser_tabs', { action: 'new', url: `${secondBase}second` })
    const tabB = await until(async () => {
      const tab = (await state()).tabs.find((entry) => entry.url.startsWith(secondBase))
      return tab && !tab.loading ? tab : null
    }, 'second tab state')
    const targetB = await until(() => pageWc(secondBase), 'second tab webContents')
    const siblingPid = target.getProcessId()
    if (targetB.getProcessId() === siblingPid) {
      console.warn('SKIP: sibling tab shares a renderer process; same-process crash isolation is not observable')
    } else {
      await crash(targetB)
      await until(async () => (await state()).tabs.find((tab) => tab.id === tabB.id)?.recovery?.status === 'recovered', 'sibling tab recovery')
      const siblingAfter = (await state()).tabs.find((tab) => tab.id === tabA.id)
      assert.ok(['healthy', 'recovered'].includes(siblingAfter.recovery.status), 'crashing one renderer must not mark another tab crashed')
      assert.equal(siblingAfter.recovery.attempts, 1, 'the sibling tab must not gain a recovery attempt')
      assert.equal(target.getProcessId(), siblingPid, 'crashing one renderer must not replace another tab renderer')
      assert.equal(new URL(siblingAfter.url).origin, new URL(base).origin)
      pass('one crashed renderer does not disturb a sibling tab in a separate renderer process')
    }
    await call('browser_tabs', { action: 'close', tabId: tabB.id })
    await until(async () => (await state()).tabs.length === 1, 'sibling tab closes')

    const waiting = request('tools/call', { name: 'browser_wait', arguments: { text: 'never-appears-xyz', timeoutMs: 5000 } })
    await delay(400)
    await crash(target)
    const waitResponse = await waiting
    const waitText = waitResponse.result?.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? ''
    assert.equal(waitResponse.error, undefined, JSON.stringify(waitResponse.error))
    assert.equal(waitResponse.result?.isError, true, `wait during crash must fail cleanly: ${waitText}`)
    assert.match(waitText, /超时|恢复|页面|崩溃|渲染|target|frame/i)
    const tasks = await call('browser_tasks', { action: 'list' })
    assert.match(tasks.text, /browser_wait.*failed/)
    assert.match(tasks.text, /来源 mcp:renderer-crash-test/)
    assert.match(tasks.text, /标签 t/)
    assert.match(tasks.text, /当前步骤/)
    const taskId = tasks.text.match(/任务 (\S+)/)?.[1]
    assert.ok(taskId, 'task list exposes a durable task id')
    const taskDetail = await call('browser_tasks', { action: 'get', taskId })
    assert.match(taskDetail.text, /恢复策略:/)
    assert.match(taskDetail.text, /副作用:/)
    assert.match(taskDetail.text, /步骤/)
    await until(async () => (await state()).tabs.find((tab) => tab.id === tabA.id)?.recovery?.attempts === 2, 'second recovery attempt')
    await until(async () => (await state()).tabs.find((tab) => tab.id === tabA.id)?.recovery?.status === 'recovered', 'second recovery completes')
    pass('a tool call in flight during a real renderer crash fails with a task record instead of hanging')

    await crash(target)
    await until(async () => (await state()).tabs.find((tab) => tab.id === tabA.id)?.recovery?.status === 'failed', 'retry limit')
    const exhausted = (await state()).tabs.find((tab) => tab.id === tabA.id)
    assert.equal(exhausted.recovery.attempts, 2)
    assert.equal(exhausted.recovery.reason, 'crash')
    assert.equal(exhausted.recovery.error, '已达到最大自动恢复次数')
    await call('browser_click', { ref, snapshot: false }, /RENDERER_CRASH.*reason=recovery_failed|页面恢复失败|最大自动恢复次数/)
    pass('recovery stops at the configured limit and exposes an actionable terminal error')

    await call('browser_tabs', { action: 'new', url: `${base}slow-crash` })
    const slowTab = await until(async () => {
      const tab = (await state()).tabs.find((entry) => entry.url === `${base}slow-crash`)
      return tab && !tab.loading ? tab : null
    }, 'slow recovery tab')
    const slowTarget = await until(() => pageWc(`${base}slow-crash`), 'slow recovery webContents')
    await crash(slowTarget)
    await until(async () => {
      const tab = (await state()).tabs.find((entry) => entry.id === slowTab.id)
      return tab?.recovery?.status === 'recovering' && tab.loading
    }, 'slow recovery navigation starts')
    await delay(150)
    await crash(slowTarget)
    await until(async () => (await state()).tabs.find((tab) => tab.id === slowTab.id)?.recovery?.attempts === 2, 'second crash during recovery is counted')
    await until(async () => (await state()).tabs.find((tab) => tab.id === slowTab.id)?.recovery?.status === 'recovered', 'second recovery succeeds')
    pass('a renderer crash during an active recovery consumes another bounded attempt instead of stalling')
    await call('browser_tabs', { action: 'close', tabId: slowTab.id })

    await call('browser_tabs', { action: 'new', url: `${base}unexpected` })
    const unexpectedTab = await until(async () => {
      const tab = (await state()).tabs.find((entry) => entry.url === `${base}unexpected`)
      return tab && !tab.loading ? tab : null
    }, 'unexpected-exit tab')
    const unexpectedTarget = await until(() => pageWc(`${base}unexpected`), 'unexpected-exit webContents')
    const unexpectedPid = await until(() => {
      try {
        const pid = unexpectedTarget.getOSProcessId()
        return pid > 0 ? pid : null
      } catch {
        return null
      }
    }, 'unexpected-exit renderer pid')
    if (process.platform === 'win32') {
      const killed = spawnSync('taskkill', ['/PID', String(unexpectedPid), '/F'], { encoding: 'utf8' })
      assert.equal(killed.status, 0, `taskkill failed: ${killed.stdout}${killed.stderr}`)
    } else {
      process.kill(unexpectedPid, 'SIGKILL')
    }
    await until(async () => (await state()).tabs.find((tab) => tab.id === unexpectedTab.id)?.recovery?.status === 'recovered', 'unexpected-exit recovery')
    assert.equal((await state()).tabs.find((tab) => tab.id === unexpectedTab.id)?.recovery?.attempts, 1)
    pass('an unexpected renderer crash is recovered as a bounded, observable state')
    await call('browser_tabs', { action: 'close', tabId: unexpectedTab.id })

    await call('browser_tabs', { action: 'new', url: `${base}normal-close` })
    const normalTab = await until(async () => {
      const tab = (await state()).tabs.find((entry) => entry.url === `${base}normal-close`)
      return tab && !tab.loading ? tab : null
    }, 'normal-close tab')
    const normalTarget = await until(() => pageWc(`${base}normal-close`), 'normal-close webContents')
    await call('browser_tabs', { action: 'close', tabId: normalTab.id })
    await until(() => normalTarget.isDestroyed(), 'closed renderer destruction')
    await call('browser_click', { tabId: normalTab.id, ref: 'e1', snapshot: false }, /TARGET_CLOSED|标签不存在/)
    pass('a normally closed tab destroys its renderer and returns TARGET_CLOSED for stale tab targets')

    await call('browser_tabs', { action: 'new', url: `${base}navigation-crash` })
    const navTab = await until(async () => {
      const tab = (await state()).tabs.find((entry) => entry.url === `${base}navigation-crash`)
      return tab && !tab.loading ? tab : null
    }, 'navigation-crash tab')
    const navTarget = await until(() => pageWc(`${base}navigation-crash`), 'navigation-crash webContents')
    const navigating = request('tools/call', {
      name: 'browser_navigate',
      arguments: { url: `${base}delayed-nav`, snapshot: false }
    })
    await delay(250)
    await crash(navTarget)
    const navResponse = await navigating
    const navText = navResponse.result?.content?.filter((part) => part.type === 'text').map((part) => part.text).join('\n') ?? ''
    assert.equal(navResponse.error, undefined, JSON.stringify(navResponse.error))
    assert.equal(navResponse.result?.isError, true, `navigation during crash must fail cleanly: ${navText}`)
    await until(async () => (await state()).tabs.find((tab) => tab.id === navTab.id)?.recovery?.status === 'recovered', 'navigation crash recovery')
    const recoveredNav = (await state()).tabs.find((tab) => tab.id === navTab.id)
    assert.ok(recoveredNav.url.startsWith(base), 'recovery must stay on a supported fixture URL')
    assert.ok([`${base}navigation-crash`, `${base}delayed-nav`].includes(recoveredNav.url), `unexpected recovered URL: ${recoveredNav.url}`)
    const recoveredSnapshot = await call('browser_snapshot', { tabId: navTab.id, full: true })
    assert.match(recoveredSnapshot.text, /Renderer crash fixture/)
    pass('a renderer crash during page navigation fails the in-flight tool, preserves a supported URL and restores snapshots')
    await call('browser_tabs', { action: 'close', tabId: navTab.id })

    await call('browser_tabs', { action: 'new', url: `${base}unresponsive` })
    const unresponsiveTab = await until(async () => {
      const tab = (await state()).tabs.find((entry) => entry.url === `${base}unresponsive`)
      return tab && !tab.loading ? tab : null
    }, 'unresponsive tab')
    const unresponsiveTarget = await until(() => pageWc(`${base}unresponsive`), 'unresponsive webContents')
    // hidden 模式下 Agent 标签保持后台可用性，但对应 WebContentsView 不参与
    // 桌面合成，Chromium 不会启动输入 ACK hang monitor。通过产品自身的窗口
    // 模式 API 切到 visible，再选择标签，确保测的是可见页面的真实生命周期。
    await chrome.executeJavaScript('window.aa.windowMode("visible")')
    const selected = await call('browser_tabs', { action: 'select', tabId: unresponsiveTab.id, bringToFront: true })
    unresponsiveTarget.focus()
    assert.ok(window.isVisible(), 'window visible for unresponsive injection')
    assert.ok(
      window.contentView.children.some((child) => child.webContents === unresponsiveTarget),
      'unresponsive tab view is attached to the composited window'
    )
    assert.match(selected.text, /windowFocused: true/, 'window focused before unresponsive injection')
    const selectedTab = (await state()).tabs.find((tab) => tab.id === unresponsiveTab.id)
    assert.equal(selectedTab.active, true, 'unresponsive tab is the active composited tab')
    await until(
      () => unresponsiveTarget.executeJavaScript('document.visibilityState === "visible"', false),
      'composited page visibility'
    )
    await delay(750)
    let unresponsiveFired = false
    unresponsiveTarget.once('unresponsive', () => { unresponsiveFired = true })
    const hangExecution = unresponsiveTarget.executeJavaScript(
      '(() => { const deadline = Date.now() + 40_000; while (Date.now() < deadline) {} return true })()',
      false
    )
    await delay(250)
    unresponsiveTarget.sendInputEvent({ type: 'mouseDown', x: 40, y: 80, button: 'left', clickCount: 1 })
    unresponsiveTarget.sendInputEvent({ type: 'mouseUp', x: 40, y: 80, button: 'left', clickCount: 1 })
    await hangExecution.catch(() => {})
    if (!unresponsiveFired) {
      skip('Electron emitted no real unresponsive event after a 40s Renderer main-thread hang on this runtime; no recovery pass is claimed')
    } else {
      await until(async () => {
        const tab = (await state()).tabs.find((entry) => entry.id === unresponsiveTab.id)
        return tab?.recovery?.reason === 'unresponsive' &&
          ['recovering', 'recovered'].includes(tab.recovery.status)
      }, 'unresponsive recovery state', 20_000)
      await until(async () => (await state()).tabs.find((tab) => tab.id === unresponsiveTab.id)?.recovery?.status === 'recovered', 'unresponsive recovery', 20_000)
      const recoveredUnresponsive = (await state()).tabs.find((tab) => tab.id === unresponsiveTab.id)
      assert.equal(recoveredUnresponsive.recovery.attempts, 1)
      const afterUnresponsive = await call('browser_snapshot', { tabId: unresponsiveTab.id, full: true })
      assert.match(afterUnresponsive.text, /Renderer crash fixture/)
      pass('a hung Renderer emits Electron unresponsive, recovers within its retry bound and restores snapshots')
    }
    await call('browser_tabs', { action: 'close', tabId: unresponsiveTab.id })

    await call('browser_tabs', { action: 'new', url: `${base}forms` })
    await until(async () => {
      const tab = (await state()).tabs.find((entry) => entry.url === `${base}forms`)
      return tab && !tab.loading
    }, 'forms tab')
    const forms = await call('browser_snapshot', { full: true })
    assert.match(forms.text, /forms/)
    const probeRef = findRef(forms.text, /button.*Probe/)
    const disabledRef = findRef(forms.text, /Disabled action/)
    const readonlyRef = findRef(forms.text, /Readonly/)
    const trappedRef = findRef(forms.text, /Trapped/)
    const movingRef = findRef(forms.text, /Moving target/)
    const hideRef = findRef(forms.text, /Hide me/)
    const detachRef = findRef(forms.text, /Detach me/)

    await call('browser_click', { ref: disabledRef, snapshot: false }, /reason=element_disabled|已禁用/)
    await call('browser_type', { ref: readonlyRef, text: 'x', snapshot: false }, /OPERATION_REJECTED|只读/)
    await call('browser_evaluate', { expression: "document.querySelector('#hide').style.display='none'" })
    await call('browser_click', { ref: hideRef, snapshot: false }, /reason=element_not_visible|不可见/)
    await call('browser_evaluate', { expression: "document.querySelector('#detach').remove()" })
    await call('browser_click', { ref: detachRef, snapshot: false }, /reason=element_detached|DOM 移除/)
    await call('browser_evaluate', {
      expression: "(() => { document.querySelector('#first').focus(); document.querySelector('#trapped-wrap').inert=true; return true })()"
    })
    await call('browser_type', { ref: trappedRef, text: 'misplaced', snapshot: false }, /OPERATION_REJECTED|无法获得焦点/)
    const focusValues = await call('browser_evaluate', {
      expression: "(() => ({first:document.querySelector('#first').value,trapped:document.querySelector('#trapped').value,active:document.activeElement.id}))()"
    })
    assert.match(focusValues.text, /"first": "keep"/)
    assert.match(focusValues.text, /"trapped": "safe"/)
    // 隐藏窗口中的合成器动画不会推进，因此用确定性的坐标变化验证稳定性预检：
    // 每次布局查询都把元素报告的位置移动 7px，模拟持续移动的目标。
    await call('browser_evaluate', {
      expression:
        "(() => { const el=document.querySelector('#moving'); window.__movingClicks=0; el.addEventListener('click',()=>window.__movingClicks++); const original=el.getBoundingClientRect.bind(el); let shift=0; el.getBoundingClientRect=()=>{ const r=original(); shift=(shift+7)%56; return new DOMRect(r.x+shift,r.y,r.width,r.height) }; return true })()"
    })
    const movingFailure = await call('browser_click', { ref: movingRef, snapshot: false }, /reason=element_not_stable|持续移动/)
    assert.match(movingFailure.text, /^\[OPERATION_REJECTED\]/, 'unstable target has an operation-rejected category')
    const movingClicks = await call('browser_evaluate', { expression: 'window.__movingClicks' })
    assert.match(movingClicks.text, /\b0\b/)
    pass('disabled, readonly, hidden and detached targets fail with typed actionable errors')
    pass('an inert focus trap cannot redirect typed text into a previously focused field')
    pass('a target with continuously changing coordinates is rejected before any click is dispatched')

    await call('browser_navigate', { url: `${base}second`, snapshot: false })
    await call('browser_click', { ref: probeRef, snapshot: false }, /reason=navigation_changed|页面在快照后已导航/)
    const afterNavigation = await call('browser_snapshot', { full: true })
    assert.match(afterNavigation.text, /sibling tab/)
    pass('a ref from before navigation is rejected instead of being mapped to another element')

    approvalDriver.assertHealthy()
    assert.ok(approvalDriver.approved > 0, 'script execution requires a real desktop decision')
    exitCode = 0
  } finally {
    await approvalDriver?.stop()
    rl?.close()
    for (const socket of sockets) socket.close()
    child?.kill()
    server?.close()
    secondServer?.close()
    fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify({ exitCode, checks, skips }, null, 2))
    console.log(`Renderer crash verification: ${path.join(runDir, 'result.json')}`)
    if (exitCode === 0) app.quit()
  }
}
