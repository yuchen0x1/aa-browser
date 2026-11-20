/** Focus/rotation/copy regressions: real Electron input, loopback-only pages, no native clipboard access. */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SITE = path.join(ROOT, 'site')
const require = createRequire(import.meta.url)
const TICK = 320
const HOLD = TICK * 2 + 120
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const errorText = (error) => error?.stack || String(error)
const literal = (value) => JSON.stringify(value).replace(/[<>/\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)

if (!process.versions.electron) {
  const label = process.argv.find((arg) => arg.startsWith('--label='))?.slice(8) || 'run'
  assert.match(label, /^[a-z0-9-]+$/i)
  const parent = path.join(ROOT, '.local-verification')
  fs.mkdirSync(parent, { recursive: true })
  const runDir = fs.mkdtempSync(path.join(parent, `site-interactions-${label}-${Date.now()}-`))
  const resultFile = path.join(runDir, 'result.json')
  const env = { ...process.env, AA_SITE_INTERACTIONS_DIR: runDir, AA_SITE_INTERACTIONS_LABEL: label }
  delete env.ELECTRON_RUN_AS_NODE
  fs.writeFileSync(resultFile, JSON.stringify({ status: 'RUNNING', runDir, checks: [] }, null, 2))
  console.log(`Site interaction artifacts: ${runDir}`)
  const child = spawn(require('electron'), [fileURLToPath(import.meta.url), `--user-data-dir=${path.join(runDir, 'profile')}`], {
    cwd: ROOT, env, stdio: ['inherit', 'inherit', 'inherit', 'ipc']
  })
  let done = false
  let failure
  let killTimer
  const stop = (reason) => {
    if (done || failure) return
    failure = reason
    if (child.connected) child.send({ type: 'shutdown', reason }, (error) => { if (error) child.kill() })
    else child.kill()
    killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
  }
  const timeout = setTimeout(() => stop('interaction suite timed out after 120 seconds'), 120_000)
  const interrupt = () => stop('interaction suite interrupted')
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  const finish = (code, error) => {
    if (done) return
    done = true
    clearTimeout(timeout)
    clearTimeout(killTimer)
    process.removeListener('SIGINT', interrupt)
    process.removeListener('SIGTERM', interrupt)
    let report
    try { report = JSON.parse(fs.readFileSync(resultFile, 'utf8')) }
    catch (readError) { report = { checks: [], reportError: errorText(readError) } }
    const exitCode = !failure && !error && code === 0 && report.status === 'PASS' ? 0 : 1
    fs.writeFileSync(resultFile, JSON.stringify({ ...report, status: exitCode ? 'FAIL' : 'PASS', exitCode,
      cleanup: { ...report.cleanup, electronExited: child.exitCode !== null || child.signalCode !== null },
      ...(failure || error ? { launcherError: failure || errorText(error) } : {}) }, null, 2))
    console.log(`${exitCode ? 'FAIL' : 'PASS'}: interaction report ${resultFile}`)
    process.exitCode = exitCode
  }
  child.once('error', (error) => finish(1, error))
  child.once('exit', (code, signal) => finish(code, signal ? new Error(`Electron exited with ${signal}`) : undefined))
} else {
  // Do not await the entry: Electron emits ready only after its ESM entry returns.
  void runElectron().catch((error) => { console.error('FAIL:', errorText(error)); process.exit(1) })
}

// Injected before authored site.js, in the unprivileged renderer. Never retains/calls native clipboard methods.
function installFixture(tick) {
  const probe = { writes: [], copies: [], intervals: [], events: [], inView: false }
  window.__interactions = probe
  const mode = new URL(location.href).searchParams.get('copy') || 'success'
  Object.defineProperty(navigator, 'clipboard', { configurable: false, value: Object.freeze({
    writeText(text) {
      probe.writes.push({ text, source: document.activeElement?.getAttribute('data-copy') })
      if (mode === 'delayed-success') {
        return new Promise((_resolve, reject) => {
          probe.rejectClipboard = () => {
            probe.rejectClipboard = null
            reject(new Error('Fixture delayed clipboard rejection; no system clipboard is used'))
          }
        })
      }
      return Promise.reject(new Error('Fixture rejects clipboard API; no system clipboard is used'))
    }
  }) })
  Object.defineProperty(document, 'execCommand', { configurable: false, writable: false, value(command) {
    if (command !== 'copy') throw new Error(`Unexpected legacy command: ${command}`)
    probe.copies.push({ command, mode, helperFocused: document.activeElement?.tagName === 'TEXTAREA' })
    if (mode === 'throw') throw new Error('Fixture legacy-copy error')
    return mode === 'success' || mode === 'delayed-success'
  } })
  const nativeInterval = window.setInterval.bind(window)
  const nativeClear = window.clearInterval.bind(window)
  const live = new Set()
  window.setInterval = (callback, delay, ...args) => {
    const id = nativeInterval(callback, delay === 8000 ? tick : delay, ...args)
    if (delay === 8000) {
      live.add(id)
      probe.intervals.push({ action: 'start', id, authoredMs: delay, fixtureMs: tick })
    }
    return id
  }
  window.clearInterval = (id) => {
    if (live.delete(id)) probe.intervals.push({ action: 'stop', id })
    nativeClear(id)
  }
  probe.liveTimers = () => live.size
  addEventListener('DOMContentLoaded', () => {
    const demo = document.querySelector('.demo')
    if (!demo) return
    for (const type of ['mouseenter', 'mouseleave', 'focusin', 'focusout']) {
      demo.addEventListener(type, (event) => probe.events.push({ type, trusted: event.isTrusted,
        target: event.target.id || event.target.className, related: event.relatedTarget?.id }))
    }
    new IntersectionObserver((entries) => {
      probe.inView = entries[0]?.isIntersecting ?? false
      probe.events.push({ type: 'intersection', inView: probe.inView })
    }, { threshold: 0.25 }).observe(demo)
  })
}

async function runElectron() {
  const { app, BrowserWindow, session } = await import('electron')
  const runDir = process.env.AA_SITE_INTERACTIONS_DIR
  assert.ok(runDir && path.dirname(runDir) === path.join(ROOT, '.local-verification'), 'launch with Node')
  const report = {
    status: 'RUNNING', label: process.env.AA_SITE_INTERACTIONS_LABEL, runDir, startedAt: new Date().toISOString(),
    source: { file: path.join(SITE, 'assets', 'site.js'), sha256: createHash('sha256').update(fs.readFileSync(path.join(SITE, 'assets', 'site.js'))).digest('hex') },
    timing: { authoredIntervalMs: 8000, fixtureIntervalMs: TICK, holdMs: HOLD,
      note: 'Only 8000ms setInterval calls are accelerated in the page fixture; these are not real eight-second waits.' },
    clipboard: 'Pre-site.js page stubs: writeText always rejects; execCommand returns success/failure or throws. Native clipboard APIs are never called.',
    checks: [], screenshots: [], requests: [], blockedRequests: [], consoleErrors: [], runtimeErrors: [], cleanup: {}
  }
  const resultFile = path.join(runDir, 'result.json')
  const persist = () => fs.writeFileSync(resultFile, JSON.stringify(report, null, 2))
  let win
  let server
  let base
  let page
  let finishing = false
  let watchdog
  const ui = (code) => win.webContents.executeJavaScript(code, true)
  const evaluate = (fn, ...args) => ui(`(${fn.toString()})(${args.map(literal).join(',')})`)
  const settle = () => ui('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  async function until(fn, label, timeout = 5000) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      const value = await fn()
      if (value) return value
      await pause(30)
    }
    throw new Error(`Timed out: ${label}`)
  }
  async function capture(name) {
    await settle()
    const image = await win.webContents.capturePage()
    assert.ok(!image.isEmpty(), `empty screenshot: ${name}`)
    const file = `${name}.png`
    fs.writeFileSync(path.join(runDir, file), image.toPNG(), { flag: 'wx' })
    report.screenshots.push({ file, page, pixels: image.getSize() })
    return file
  }
  async function check(name, test) {
    const item = { name, status: 'RUNNING', details: {} }
    report.checks.push(item)
    persist()
    const start = Date.now()
    try {
      await test(item.details)
      item.status = 'PASS'
    } catch (error) {
      item.status = 'FAIL'
      item.error = errorText(error)
      console.error(`FAIL: ${name}\n${item.error}`)
      if (win && !win.isDestroyed()) {
        try { item.screenshot = await capture(`failure-${report.checks.length}`) }
        catch (captureError) { item.captureError = errorText(captureError) }
      }
    }
    item.durationMs = Date.now() - start
    console.log(`${item.status}: ${name}`)
    persist()
  }
  async function resize(width, height) {
    win.setContentSize(width, height)
    await until(() => ui(`innerWidth === ${width} && innerHeight === ${height}`), `viewport ${width}x${height}`)
    await settle()
  }
  async function load(name = 'index.html') {
    page = name
    win.show()
    await win.loadURL(`${base}/${name}`)
    await ui('document.fonts.ready.then(() => true)')
    await settle()
    assert.equal(await ui('location.origin'), base)
    assert.equal(await ui('getComputedStyle(document.body).marginTop'), '0px', 'real site stylesheet is loaded')
    assert.equal(await ui('isSecureContext && !!navigator.clipboard && !!window.__interactions'), true)
  }
  async function key(keyCode, modifiers = []) {
    win.focus()
    win.webContents.focus()
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    if (keyCode === 'Enter' || keyCode === 'Space') {
      win.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Enter' ? '\r' : ' ', modifiers })
    }
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await pause(25)
    await settle()
  }
  async function move(x, y) {
    win.focus()
    win.webContents.focus()
    win.webContents.sendInputEvent({ type: 'mouseMove', x, y })
    await pause(35)
    await settle()
  }
  async function point(selector) {
    return evaluate((selector) => {
      const el = document.querySelector(selector)
      if (!el) throw new Error(`Missing target: ${selector}`)
      const rect = el.getBoundingClientRect()
      const x = Math.round(rect.x + rect.width / 2)
      const y = Math.round(rect.y + rect.height / 2)
      if (!rect.width || !rect.height || !el.contains(document.elementFromPoint(x, y))) throw new Error(`Covered target: ${selector}`)
      return { x, y }
    }, selector)
  }
  async function click(selector) {
    const target = await point(selector)
    await move(target.x, target.y)
    win.webContents.sendInputEvent({ type: 'mouseDown', ...target, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', ...target, button: 'left', clickCount: 1 })
    await pause(40)
    await settle()
  }
  const navState = () => ui(`({ open: siteHeader.classList.contains('is-open'), locked: document.body.classList.contains('is-locked'),
    expanded: navToggle.getAttribute('aria-expanded'), focus: document.activeElement.id || document.activeElement.className,
    backgroundFocus: !!document.activeElement.closest('main, footer'), navFocused: navLinks.contains(document.activeElement),
    focusTag: document.activeElement.tagName, focusHref: document.activeElement.getAttribute('href'),
    inert: [...document.querySelectorAll('main, footer')].map(el => ({ tag: el.tagName, value: el.getAttribute('inert') })),
    navAncestorInert: !!navToggle.closest('[inert]') || !!navLinks.closest('[inert]'),
    scrollY, overflowY: getComputedStyle(document.body).overflowY })`)
  const demoState = () => ui(`(() => {
    const panel = document.querySelector('.demo__panel.is-active')
    const focused = document.activeElement
    return { active: panel.id, focus: focused.id, focusTag: focused.tagName,
      panelDisplays: Object.fromEntries([...document.querySelectorAll('.demo__panel')].map(el => [el.id, getComputedStyle(el).display])),
      focusedPanelVisible: !focused.matches('.demo__panel') || getComputedStyle(focused).display !== 'none',
      demoFocused: !!focused.closest('.demo'), hovered: document.querySelector('.demo').matches(':hover'), hidden: document.hidden,
      inView: __interactions.inView, timers: __interactions.liveTimers(), intervals: __interactions.intervals.slice(), events: __interactions.events.slice() }
  })()`)
  async function showDemo() {
    await ui(`document.querySelector('.demo').scrollIntoView({ block: 'center', behavior: 'instant' })`)
    await move(5, 5)
    await until(() => ui('__interactions.inView'), 'real demo intersection')
    await until(() => ui(`Number(getComputedStyle(document.querySelector('.demo')).opacity) === 1`), 'demo reveal')
  }
  async function focusPanel() {
    await showDemo()
    await ui(`document.querySelector('.demo__step[aria-selected="true"]').focus({ preventScroll: true })`)
    await key('Tab')
    assert.equal(await ui(`document.activeElement === document.querySelector('.demo__panel.is-active')`), true, 'native Tab focuses the active panel without clicking/pausing a tab')
  }
  async function hoverDemo() {
    const target = await point('.demo__bar')
    await move(target.x, target.y)
    assert.equal(await ui(`document.querySelector('.demo').matches(':hover')`), true)
  }
  async function reenterDemo() {
    await ui('scrollTo({ top: 0, behavior: "instant" })')
    await until(() => ui('!__interactions.inView'), 'demo leaves viewport')
    await showDemo()
  }
  async function finish(error) {
    if (finishing) return
    finishing = true
    clearTimeout(watchdog)
    if (error) report.runtimeErrors.push(errorText(error))
    try {
      if (win && !win.isDestroyed()) {
        if (win.webContents.debugger.isAttached()) win.webContents.debugger.detach()
        win.destroy()
      }
      report.cleanup.windowDestroyed = !win || win.isDestroyed()
    } catch (closeError) { report.runtimeErrors.push(errorText(closeError)) }
    try {
      if (server?.listening) await new Promise((resolve, reject) => {
        server.close((closeError) => closeError ? reject(closeError) : resolve())
        server.closeAllConnections()
      })
      report.cleanup.serverClosed = !server?.listening
    } catch (closeError) { report.runtimeErrors.push(errorText(closeError)) }
    report.finishedAt = new Date().toISOString()
    report.summary = { passed: report.checks.filter((item) => item.status === 'PASS').length,
      failed: report.checks.filter((item) => item.status !== 'PASS').length, screenshots: report.screenshots.length }
    report.status = report.checks.length && !report.summary.failed && !report.runtimeErrors.length && !report.consoleErrors.length && !report.blockedRequests.length ? 'PASS' : 'FAIL'
    persist()
    console.log(`${report.status}: ${report.summary.passed}/${report.checks.length} interaction checks, ${report.summary.screenshots} screenshots`)
    app.exit(report.status === 'PASS' ? 0 : 1)
  }
  process.once('uncaughtException', (error) => { void finish(error) })
  process.once('unhandledRejection', (error) => { void finish(error) })
  process.once('SIGINT', () => { void finish(new Error('Interrupted')) })
  process.once('SIGTERM', () => { void finish(new Error('Terminated')) })
  process.on('message', (message) => { if (message?.type === 'shutdown') void finish(new Error(message.reason)) })
  app.on('window-all-closed', () => {})
  watchdog = setTimeout(() => { void finish(new Error('Electron interaction suite timed out after 100 seconds')) }, 100_000)
  try {
    for (const name of ['profile', 'session', 'logs', 'crashes']) fs.mkdirSync(path.join(runDir, name), { recursive: true })
    app.setPath('userData', path.join(runDir, 'profile'))
    app.setPath('sessionData', path.join(runDir, 'session'))
    app.setPath('crashDumps', path.join(runDir, 'crashes'))
    app.setAppLogsPath(path.join(runDir, 'logs'))
    app.commandLine.appendSwitch('force-device-scale-factor', '1')
    app.commandLine.appendSwitch('disable-background-networking')
    app.commandLine.appendSwitch('no-proxy-server')
    await app.whenReady()
    const injection = `<script>(${installFixture.toString()})(${TICK})</script>`
    const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' }
    server = http.createServer((req, res) => {
      const request = { url: req.url, method: req.method }
      report.requests.push(request)
      try {
        assert.ok(req.method === 'GET' || req.method === 'HEAD', 'read-only fixture server')
        const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname)
        const file = path.resolve(SITE, pathname.slice(1))
        assert.ok(file.startsWith(SITE + path.sep), 'request must stay in site/')
        let data = fs.readFileSync(file)
        if (path.extname(file) === '.html') data = Buffer.from(data.toString('utf8').replace('<head>', `<head>${injection}`))
        request.status = 200
        res.writeHead(200, { 'Content-Type': `${mime[path.extname(file)] || 'application/octet-stream'}; charset=utf-8`, 'Cache-Control': 'no-store' })
        res.end(req.method === 'HEAD' ? undefined : data)
      } catch (error) {
        request.status = 404
        request.error = errorText(error)
        res.writeHead(404)
        res.end('Not found')
      }
    })
    server.on('error', (error) => { void finish(error) })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${server.address().port}`
    report.origin = base
    const isolated = session.fromPartition(`site-interactions-${process.pid}`, { cache: false })
    isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    isolated.setPermissionCheckHandler(() => false)
    isolated.webRequest.onBeforeRequest((details, callback) => {
      const allowed = details.url === 'about:blank' || new URL(details.url).origin === base
      if (!allowed) report.blockedRequests.push({ url: details.url, type: details.resourceType })
      callback({ cancel: !allowed })
    })
    isolated.on('will-download', (event, item) => {
      event.preventDefault()
      report.runtimeErrors.push(`Unexpected download blocked: ${item.getURL()}`)
    })
    win = new BrowserWindow({
      width: 1000, height: 768, minWidth: 1, minHeight: 1, useContentSize: true,
      frame: false, show: true, skipTaskbar: true, enableLargerThanScreen: true, backgroundColor: '#0b0f11',
      webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }
    })
    win.webContents.setZoomFactor(1)
    win.webContents.setWindowOpenHandler(({ url }) => { report.blockedRequests.push({ url, type: 'popup' }); return { action: 'deny' } })
    win.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== base) { event.preventDefault(); report.blockedRequests.push({ url, type: 'navigation' }) }
    })
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error') report.consoleErrors.push({ page, message: event.message, source: event.sourceId, line: event.lineNumber })
    })
    win.webContents.on('render-process-gone', (_event, details) => { void finish(new Error(`Renderer exited: ${JSON.stringify(details)}`)) })
    win.webContents.on('did-fail-load', (_event, code, description, url) => report.runtimeErrors.push(`Load failure ${code}: ${description} (${url})`))

    // executeJavaScript (including resize polling) needs a real loaded renderer document.
    await load()
    for (const name of ['index.html', 'tools.html']) {
      await check(`${name}: compact menu isolates main/footer from native Tab and Shift+Tab`, async (details) => {
        await resize(1000, 768)
        await load(name)
        await click('#navToggle')
        details.open = await navState()
        details.screenshot = await capture(`nav-open-${name.slice(0, -5)}`)
        details.forward = []
        details.backward = []
        for (const [direction, modifiers] of [['forward', []], ['backward', ['shift']]]) {
          await ui(`document.querySelector('#navToggle').focus()`)
          for (let i = 0; i < 18; i++) {
            await key('Tab', modifiers)
            const state = await navState()
            details[direction].push(state)
            if (state.backgroundFocus) {
              details[`${direction}Escape`] = await capture(`nav-escaped-${direction}-${name.slice(0, -5)}`)
              break
            }
          }
        }
        assert.equal(details.open.locked, true)
        assert.equal(details.open.overflowY, 'hidden')
        assert.equal(details.open.navAncestorInert, false, 'navigation ancestors must stay interactive')
        assert.equal([...details.forward, ...details.backward].some((state) => state.backgroundFocus), false, 'Tab must not focus obscured main/footer while the menu locks scrolling')
        await key('Escape')
        details.closed = await navState()
        assert.equal(details.closed.open, false)
        assert.equal(details.closed.focus, 'navToggle')
        assert.equal(details.closed.locked, false)
        assert.deepEqual(details.closed.inert.map((item) => item.value), [null, null])
      })
    }
    await check('menu close paths restore existing inert values without isolating navigation ancestors', async (details) => {
      await load()
      await ui(`document.querySelector('footer').setAttribute('inert', 'fixture-existing')`)
      details.rounds = []
      for (const close of ['escape', 'toggle', 'link', 'desktop']) {
        await resize(1000, 768)
        await click('#navToggle')
        await key('Tab')
        const opened = await navState()
        if (close === 'escape') await key('Escape')
        if (close === 'toggle') await click('#navToggle')
        if (close === 'link') await key('Enter')
        if (close === 'desktop') await resize(1100, 768)
        const closed = await navState()
        details.rounds.push({ close, opened, closed })
        assert.equal(opened.navAncestorInert, false)
        assert.equal(closed.open, false)
        assert.equal(closed.locked, false)
        assert.deepEqual(closed.inert.map((item) => item.value), [null, 'fixture-existing'])
        if (close === 'link') assert.equal(await ui('location.hash'), '#why', 'allow native anchor navigation')
        if (close === 'escape' || close === 'toggle') assert.equal(closed.focus, 'navToggle')
        if (close === 'desktop') assert.equal(closed.navFocused, true, 'visible desktop link retains focus')
      }
      details.screenshot = await capture('nav-restored')
    })

    await resize(1366, 768)
    await load()
    win.webContents.debugger.attach('1.3')
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
    report.motion = 'CDP media emulation: no-preference by default, reduce for the reduced-motion check'
    await check('demo keeps a keyboard-focused panel visible after real mouseleave', async (details) => {
      await load()
      await focusPanel()
      await hoverDemo()
      details.before = await demoState()
      details.beforeScreenshot = await capture('demo-focus-before-mouseleave')
      await move(5, 5)
      await pause(HOLD)
      details.after = await demoState()
      details.screenshot = await capture('demo-focus-mouseleave')
      assert.ok(details.after.events.some((event) => event.type === 'mouseleave' && event.trusted), 'real mouseleave was delivered')
      assert.equal(details.after.hovered, false)
      assert.equal(details.after.demoFocused, true)
      assert.equal(details.after.active, details.before.active)
      assert.equal(details.after.focusedPanelVisible, true)
      assert.equal(details.after.timers, 0)
    })
    await check('demo keeps a keyboard-focused panel visible after real intersection re-entry', async (details) => {
      await load()
      await focusPanel()
      details.before = await demoState()
      await reenterDemo()
      await pause(HOLD)
      details.after = await demoState()
      details.screenshot = await capture('demo-focus-intersection')
      assert.ok(details.after.events.some((event) => event.type === 'intersection' && !event.inView))
      assert.equal(details.after.inView, true)
      assert.equal(details.after.demoFocused, true)
      assert.equal(details.after.active, details.before.active)
      assert.equal(details.after.focusedPanelVisible, true)
      assert.equal(details.after.timers, 0)
    })
    await check('demo focusout does not restart rotation while the pointer still hovers', async (details) => {
      await load()
      await focusPanel()
      await hoverDemo()
      details.before = await demoState()
      await ui(`document.querySelector('.brand').focus({ preventScroll: true })`)
      await pause(HOLD)
      details.after = await demoState()
      details.screenshot = await capture('demo-hover-focusout')
      assert.equal(details.after.demoFocused, false)
      assert.equal(details.after.hovered, true)
      assert.equal(details.after.active, details.before.active)
      assert.equal(details.after.timers, 0)
    })
    await check('unpaused demo rotates and resumes after both focus and hover leave', async (details) => {
      await load()
      await focusPanel()
      details.before = await demoState()
      await ui(`document.querySelector('.brand').focus({ preventScroll: true })`)
      await until(async () => (await demoState()).active !== details.before.active, 'fixture-accelerated normal rotation')
      details.after = await demoState()
      assert.equal(details.after.demoFocused, false)
      assert.equal(details.after.hovered, false)
      assert.equal(details.after.inView, true)
      assert.equal(details.after.timers, 1)
      details.screenshot = await capture('demo-auto-resumed')
    })
    await check('explicit tab selection remains paused after pointer leave and intersection re-entry', async (details) => {
      await load()
      await showDemo()
      await click('#demoTab2')
      await ui(`document.querySelector('.brand').focus({ preventScroll: true })`)
      await move(5, 5)
      await reenterDemo()
      await pause(HOLD)
      details.after = await demoState()
      assert.equal(details.after.active, 'demoPanel2')
      assert.equal(details.after.timers, 0)
      details.screenshot = await capture('demo-user-paused')
    })
    await check('reduced-motion demo never starts a rotation interval', async (details) => {
      try {
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] })
        await load()
        assert.equal(await ui(`matchMedia('(prefers-reduced-motion: reduce)').matches`), true)
        await showDemo()
        details.before = await demoState()
        await hoverDemo()
        await move(5, 5)
        await reenterDemo()
        await pause(HOLD)
        details.after = await demoState()
        assert.equal(details.after.active, details.before.active)
        assert.equal(details.after.timers, 0)
        assert.deepEqual(details.after.intervals, [])
        details.screenshot = await capture('demo-reduced-motion')
      } finally {
        await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }] })
      }
    })
    await check('hidden page stops rotation and a visible unpaused page resumes', async (details) => {
      await load()
      await showDemo()
      // Park the real pointer outside the demo: a leftover hover would pause
      // rotation legitimately and make the visibility assertion flaky.
      await move(5, 5)
      // Electron suppresses visibility changes when backgroundThrottling is false.
      win.webContents.setBackgroundThrottling(true)
      try {
        win.hide()
        await until(() => ui('document.hidden'), 'real BrowserWindow.hide visibility change')
        details.before = await demoState()
        await pause(1350)
        details.hidden = await demoState()
        assert.equal(details.hidden.hidden, true)
        assert.equal(details.hidden.active, details.before.active)
        assert.equal(details.hidden.timers, 0)
        win.show()
        await until(() => ui('!document.hidden && __interactions.liveTimers() === 1'), 'visible page schedules rotation')
        details.shown = await demoState()
        assert.equal(details.shown.timers, 1)
        // Once the native visibility transition has restarted the interval,
        // disable OS-occlusion throttling for the remaining accelerated wait.
        win.webContents.setBackgroundThrottling(false)
        await move(5, 5)
        try {
          await until(async () => (await demoState()).active !== details.before.active, 'visible rotation resumes')
        } finally {
          details.visible = await demoState()
        }
        assert.equal(details.visible.timers, 1)
        details.screenshot = await capture('demo-visible-resumed')
      } finally {
        win.show()
        win.webContents.setBackgroundThrottling(false)
      }
    })

    for (const [mode, activation] of [['success', 'Enter'], ['failure', 'Space'], ['throw', 'pointer']]) {
      await check(`copy legacy ${mode}: restores source focus and scroll (${activation})`, async (details) => {
        await load(`tools.html?copy=${mode}`)
        const selector = '.tool__copy[data-copy="browser_click"]'
        await evaluate((selector) => {
          const button = document.querySelector(selector)
          button.scrollIntoView({ block: 'center', behavior: 'instant' })
          button.focus({ preventScroll: true })
        }, selector)
        await settle()
        details.before = await ui(`({ x: scrollX, y: scrollY, focus: document.activeElement.getAttribute('data-copy') })`)
        assert.ok(details.before.y > 0, 'copy test must exercise a scrolled page')
        if (activation === 'pointer') await click(selector)
        else await key(activation)
        await until(() => ui('__interactions.copies.length === 1 && !!document.querySelector("[role=status]")?.textContent'), 'stubbed fallback and toast')
        details.after = await evaluate((selector) => ({
          x: scrollX, y: scrollY, sourceFocused: document.activeElement === document.querySelector(selector),
          focus: document.activeElement.tagName, copied: document.querySelector(selector).classList.contains('is-copied'),
          toast: document.querySelector('[role=status]').textContent, helpers: document.querySelectorAll('textarea').length,
          writes: __interactions.writes, copies: __interactions.copies
        }), selector)
        details.screenshot = await capture(`copy-fallback-${mode}`)
        assert.equal(details.after.writes.length, 1, 'clipboard rejection must exercise legacy path')
        assert.equal(details.after.copies.length, 1)
        assert.equal(details.after.copies[0].helperFocused, true, 'real helper.select() ran')
        assert.equal(details.after.helpers, 0, 'temporary textarea must be cleaned up')
        assert.equal(details.after.copied, mode === 'success')
        assert.equal(details.after.toast, mode === 'success' ? '已复制到剪贴板' : '复制失败，请手动选择')
        assert.equal(details.after.sourceFocused, true)
        assert.ok(Math.abs(details.after.x - details.before.x) <= 1 && Math.abs(details.after.y - details.before.y) <= 1, 'copy fallback must preserve viewport scroll')
        await key('Tab')
        details.nextFocus = await ui('document.activeElement.getAttribute("data-copy")')
        assert.equal(details.nextFocus, 'browser_type', 'keyboard traversal continues from the source copy control')
      })
    }
    await check('delayed clipboard rejection preserves focus moved by native Tab before fallback', async (details) => {
      await load('tools.html?copy=delayed-success')
      const source = '.tool__copy[data-copy="browser_click"]'
      await evaluate((selector) => {
        const button = document.querySelector(selector)
        button.scrollIntoView({ block: 'center', behavior: 'instant' })
        button.focus({ preventScroll: true })
      }, source)
      await settle()
      await key('Enter')
      await until(() => ui('typeof __interactions.rejectClipboard === "function"'), 'pending stubbed clipboard write')
      assert.equal(await ui('__interactions.copies.length'), 0, 'fallback must wait for the delayed rejection')
      await key('Tab')
      details.before = await ui(`({ x: scrollX, y: scrollY, focus: document.activeElement.getAttribute('data-copy') })`)
      assert.equal(details.before.focus, 'browser_type', 'user moves focus while clipboard write is pending')
      assert.ok(details.before.y > 0)
      // Release the fixture-owned promise only after native Tab has moved focus; no native clipboard call.
      await ui('__interactions.rejectClipboard()')
      await until(() => ui('__interactions.copies.length === 1 && !!document.querySelector("[role=status]")?.textContent'), 'delayed fallback and toast')
      details.after = await evaluate((selector) => ({
        x: scrollX, y: scrollY, focus: document.activeElement.getAttribute('data-copy'),
        sourceFocused: document.activeElement === document.querySelector(selector),
        copied: document.querySelector(selector).classList.contains('is-copied'),
        helpers: document.querySelectorAll('textarea').length, toast: document.querySelector('[role=status]').textContent,
        writes: __interactions.writes, copies: __interactions.copies
      }), source)
      details.screenshot = await capture('copy-fallback-delayed-focus')
      assert.equal(details.after.writes.length, 1)
      assert.equal(details.after.copies.length, 1)
      assert.equal(details.after.copies[0].helperFocused, true)
      assert.equal(details.after.focus, 'browser_type', 'fallback must not steal focus back to the original source')
      assert.equal(details.after.sourceFocused, false)
      assert.equal(details.after.copied, true)
      assert.equal(details.after.helpers, 0)
      assert.equal(details.after.toast, '已复制到剪贴板')
      assert.ok(Math.abs(details.after.x - details.before.x) <= 1 && Math.abs(details.after.y - details.before.y) <= 1, 'delayed fallback preserves current scroll')
      await key('Tab')
      details.nextFocus = await ui('document.activeElement.getAttribute("data-copy")')
      assert.equal(details.nextFocus, 'browser_fill_form', 'Tab continues from the user-selected control')
    })
    await check('fixture isolation: all requested assets local, no external requests or console errors', async (details) => {
      details.requests = report.requests.length
      details.blockedRequests = report.blockedRequests
      details.consoleErrors = report.consoleErrors
      details.runtimeErrors = report.runtimeErrors
      details.localFailures = report.requests.filter((request) => request.status !== 200)
      assert.deepEqual(details.blockedRequests, [])
      assert.deepEqual(details.consoleErrors, [])
      assert.deepEqual(details.runtimeErrors, [])
      assert.deepEqual(details.localFailures, [])
      for (const name of ['index.html', 'tools.html', 'assets/site.js', 'assets/site.css']) {
        assert.ok(report.requests.some((request) => request.url.split('?')[0] === `/${name}` && request.status === 200), `real asset requested: ${name}`)
      }
    })
    await finish()
  } catch (error) {
    await finish(error)
  }
}
