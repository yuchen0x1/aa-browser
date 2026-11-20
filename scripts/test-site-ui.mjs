/** Marketing-site regression: real Electron input/rendering, local HTTP, isolated artifacts. */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SITE = path.join(ROOT, 'site')
const require = createRequire(import.meta.url)
const VIEWPORTS = [[1920, 1080], [1600, 900], [1366, 768], [1280, 720], [1024, 768], [768, 1024], [390, 844]]
const PAGES = ['index.html', 'tools.html', '404.html']
const SECONDARY = ['.mini-code .c', '.code .tok-punc', '.code .tok-com']
const literal = (value) => JSON.stringify(value).replace(/[<>/\u2028\u2029]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`)
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const errorText = (error) => error?.stack || String(error)

if (!process.versions.electron) {
  const parent = path.join(ROOT, '.local-verification')
  fs.mkdirSync(parent, { recursive: true })
  const runDir = fs.mkdtempSync(path.join(parent, `site-ui-${Date.now()}-`))
  const resultFile = path.join(runDir, 'result.json')
  const env = { ...process.env, AA_SITE_UI_TEST_DIR: runDir }
  delete env.ELECTRON_RUN_AS_NODE
  fs.writeFileSync(resultFile, JSON.stringify({ status: 'RUNNING', checks: [], runDir }, null, 2))
  console.log(`Site UI artifacts: ${runDir}`)
  const child = spawn(require('electron'), [fileURLToPath(import.meta.url), `--user-data-dir=${path.join(runDir, 'profile')}`], {
    cwd: ROOT, env, stdio: ['inherit', 'inherit', 'inherit', 'ipc']
  })
  let stopped = false
  let failure
  let killTimer
  const stop = (reason) => {
    if (stopped || failure) return
    failure = reason
    console.error(`FAIL: ${reason}`)
    if (child.connected) child.send({ type: 'shutdown', reason }, (error) => { if (error) child.kill() })
    else child.kill()
    killTimer = setTimeout(() => child.kill('SIGKILL'), 5000)
  }
  const timer = setTimeout(() => stop('site UI suite timed out after 180 seconds'), 180_000)
  const interrupt = () => stop('site UI suite interrupted')
  process.once('SIGINT', interrupt)
  process.once('SIGTERM', interrupt)
  const finish = (code, error) => {
    if (stopped) return
    stopped = true
    clearTimeout(timer)
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
    console.log(`${exitCode ? 'FAIL' : 'PASS'}: site UI report ${resultFile}`)
    process.exitCode = exitCode
  }
  child.once('error', (error) => finish(1, error))
  child.once('exit', (code, signal) => finish(code, signal ? new Error(`Electron exited with ${signal}`) : undefined))
} else {
  // Electron waits for its ESM entry to finish before emitting ready.
  void runElectron().catch((error) => { console.error('FAIL:', errorText(error)); process.exit(1) })
}

async function runElectron() {
  const { app, BrowserWindow, session } = await import('electron')
  const runDir = process.env.AA_SITE_UI_TEST_DIR
  assert.ok(runDir && path.dirname(runDir) === path.join(ROOT, '.local-verification'), 'launch this suite with Node')
  const report = {
    status: 'RUNNING', startedAt: new Date().toISOString(), runDir,
    viewports: VIEWPORTS.map(([width, height]) => ({ width, height })), pages: PAGES,
    checks: [], screenshots: [], consoleErrors: [], runtimeErrors: [], blockedRequests: [], requests: [], cleanup: {}
  }
  const resultFile = path.join(runDir, 'result.json')
  const persist = () => fs.writeFileSync(resultFile, JSON.stringify(report, null, 2))
  let win
  let server
  let base
  let page
  let viewport
  let finishing = false
  let watchdog
  const ui = (code) => win.webContents.executeJavaScript(code, true)
  const evaluate = (fn, ...args) => ui(`(${fn.toString()})(${args.map(literal).join(',')})`)
  const settle = () => ui('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  async function until(fn, label, timeout = 8000) {
    const end = Date.now() + timeout
    while (Date.now() < end) {
      const value = await fn()
      if (value) return value
      await pause(40)
    }
    throw new Error(`Timed out: ${label}`)
  }
  async function capture(name) {
    await settle()
    const image = await win.webContents.capturePage()
    assert.ok(!image.isEmpty(), `empty screenshot: ${name}`)
    const file = `${name}.png`
    const bytes = image.toPNG()
    fs.writeFileSync(path.join(runDir, file), bytes, { flag: 'wx' })
    report.screenshots.push({ file, page, viewport, pixels: image.getSize(), bytes: bytes.length })
    return file
  }
  async function check(name, test) {
    const item = { name, page, viewport, status: 'RUNNING', details: {} }
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
    return item.status === 'PASS'
  }
  async function resize(width, height) {
    win.setContentSize(width, height)
    await until(() => ui(`innerWidth === ${width} && innerHeight === ${height}`), `real viewport ${width}x${height}`)
    await settle()
    await pause(60)
    viewport = await ui('({ width: innerWidth, height: innerHeight, devicePixelRatio })')
    assert.equal(viewport.devicePixelRatio, 1, 'CSS and screenshot coordinates must use scale 1')
  }
  async function load(name) {
    page = name
    await win.loadURL(`${base}/${name}`)
    await ui('document.fonts.ready.then(() => true)')
    await settle()
    assert.equal(await ui('location.origin'), base)
    assert.ok(await ui('document.querySelector("h1")?.textContent.trim()'), `${name} has real page content`)
    assert.equal(await ui('getComputedStyle(document.body).marginTop'), '0px', 'the real stylesheet loaded')
  }
  async function click(selector) {
    await evaluate((selector) => {
      const el = document.querySelector(selector)
      if (!el) throw new Error(`Missing click target: ${selector}`)
      if (el.closest('[data-copy], [data-copy-target]')) throw new Error('Clipboard actions are excluded')
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' })
    }, selector)
    await until(() => evaluate((selector) => {
      const el = document.querySelector(selector)
      for (let node = el; node; node = node.parentElement) {
        if (Number(getComputedStyle(node).opacity) < 0.999) return false
      }
      return true
    }, selector), `visible click target ${selector}`)
    await settle()
    const point = await evaluate((selector) => {
      const el = document.querySelector(selector)
      const rect = el.getBoundingClientRect()
      const x = Math.round(rect.x + rect.width / 2)
      const y = Math.round(rect.y + rect.height / 2)
      const hit = document.elementFromPoint(x, y)
      if (!rect.width || !rect.height || !hit || !el.contains(hit)) throw new Error(`Click target is hidden or covered: ${selector}`)
      return { x, y }
    }, selector)
    win.focus()
    win.webContents.focus()
    win.webContents.sendInputEvent({ type: 'mouseMove', ...point })
    win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'left', clickCount: 1 })
    win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'left', clickCount: 1 })
    await pause(80)
    await settle()
  }
  async function key(keyCode, modifiers = []) {
    win.focus()
    win.webContents.focus()
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    // Native summary/button activation needs the char phase; arrow handlers only need keyDown.
    if (keyCode === 'Enter' || keyCode === 'Space') {
      win.webContents.sendInputEvent({ type: 'char', keyCode: keyCode === 'Enter' ? '\r' : ' ', modifiers })
    }
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await pause(60)
    await settle()
  }
  async function search(text) {
    await click('#toolSearch')
    await key('A', [process.platform === 'darwin' ? 'meta' : 'control'])
    await key('Backspace')
    if (text) await win.webContents.insertText(text)
    await settle()
    assert.equal(await ui('document.querySelector("#toolSearch").value'), text)
  }
  const layout = () => ui(`(() => {
    const root = document.documentElement
    const body = document.body
    return { width: innerWidth, height: innerHeight, clientWidth: root.clientWidth,
      rootScrollWidth: root.scrollWidth, bodyClientWidth: body.clientWidth, bodyScrollWidth: body.scrollWidth,
      scrollingWidth: document.scrollingElement.scrollWidth,
      horizontalOverflow: Math.max(root.scrollWidth - root.clientWidth, body.scrollWidth - body.clientWidth),
      overflowElements: [...document.querySelectorAll('main, main *')].map(el => {
        const rect = el.getBoundingClientRect()
        return { tag: el.tagName, id: el.id, className: el.className, left: rect.left, right: rect.right, width: rect.width }
      }).filter(rect => rect.width > 0 && (rect.right > root.clientWidth + 1 || rect.left < -1)).slice(0, 20),
      codeScrollers: [...document.querySelectorAll('.code, .tool__example, .cmd')].filter(el => el.scrollWidth > el.clientWidth).length }
  })()`)
  const navState = () => ui(`({ width: innerWidth, height: innerHeight,
    open: document.querySelector('#siteHeader').classList.contains('is-open'),
    expanded: document.querySelector('#navToggle').getAttribute('aria-expanded'),
    locked: document.body.classList.contains('is-locked'), overflowY: getComputedStyle(document.body).overflowY,
    toggleDisplay: getComputedStyle(document.querySelector('#navToggle')).display,
    linksDisplay: getComputedStyle(document.querySelector('#navLinks')).display,
    focus: document.activeElement.id, resizeEvents: window.__siteUIResizeEvents || [] })`)
  const toolState = () => ui(`({ count: Number(document.querySelector('#toolCount').textContent),
    scope: document.querySelector('#toolScope').textContent,
    pressed: [...document.querySelectorAll('.filter[aria-pressed="true"]')].map(el => el.dataset.filter),
    visible: [...document.querySelectorAll('#toolList .tool')].filter(el => !el.hidden && getComputedStyle(el).display !== 'none').map(el => el.id),
    empty: document.querySelector('#toolsEmpty').classList.contains('is-visible'),
    emptyDisplay: getComputedStyle(document.querySelector('#toolsEmpty')).display })`)
  function assertTools(state, expected, category) {
    assert.deepEqual(state.visible, expected)
    assert.equal(state.count, expected.length)
    assert.deepEqual(state.pressed, [category])
    assert.equal(state.empty, expected.length === 0)
    assert.equal(state.emptyDisplay === 'none', expected.length !== 0)
  }
  async function finish(error) {
    if (finishing) return
    finishing = true
    clearTimeout(watchdog)
    if (error) {
      report.runtimeErrors.push(errorText(error))
      console.error('FAIL:', errorText(error))
    }
    try {
      if (win && !win.isDestroyed()) win.destroy()
      report.cleanup.windowDestroyed = !win || win.isDestroyed()
    } catch (closeError) { report.runtimeErrors.push(errorText(closeError)) }
    try {
      if (server?.listening) {
        await new Promise((resolve, reject) => {
          server.close((closeError) => closeError ? reject(closeError) : resolve())
          server.closeAllConnections()
        })
      }
      report.cleanup.serverClosed = !server?.listening
    } catch (closeError) { report.runtimeErrors.push(errorText(closeError)) }
    report.finishedAt = new Date().toISOString()
    report.status = !report.runtimeErrors.length && !report.consoleErrors.length && !report.blockedRequests.length &&
      report.checks.length > 0 && report.checks.every((item) => item.status === 'PASS') ? 'PASS' : 'FAIL'
    report.summary = { passed: report.checks.filter((item) => item.status === 'PASS').length,
      failed: report.checks.filter((item) => item.status !== 'PASS').length, screenshots: report.screenshots.length }
    persist()
    console.log(`${report.status}: ${report.summary.passed}/${report.checks.length} site UI checks, ${report.summary.screenshots} screenshots`)
    app.exit(report.status === 'PASS' ? 0 : 1)
  }
  process.once('uncaughtException', (error) => { void finish(error) })
  process.once('unhandledRejection', (error) => { void finish(error) })
  process.once('SIGINT', () => { void finish(new Error('Interrupted')) })
  process.once('SIGTERM', () => { void finish(new Error('Terminated')) })
  process.on('message', (message) => { if (message?.type === 'shutdown') void finish(new Error(message.reason)) })
  app.on('window-all-closed', () => {})
  watchdog = setTimeout(() => { void finish(new Error('Electron site UI suite timed out after 160 seconds')) }, 160_000)
  try {
    for (const name of ['profile', 'session', 'logs', 'crashes']) fs.mkdirSync(path.join(runDir, name), { recursive: true })
    app.setPath('userData', path.join(runDir, 'profile'))
    app.setPath('sessionData', path.join(runDir, 'session'))
    app.setPath('crashDumps', path.join(runDir, 'crashes'))
    app.setAppLogsPath(path.join(runDir, 'logs'))
    app.commandLine.appendSwitch('force-device-scale-factor', '1')
    app.commandLine.appendSwitch('force-prefers-reduced-motion')
    app.commandLine.appendSwitch('disable-background-networking')
    app.commandLine.appendSwitch('no-proxy-server')
    await app.whenReady()
    const mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.png': 'image/png' }
    server = http.createServer((req, res) => {
      const request = { url: req.url, method: req.method }
      report.requests.push(request)
      try {
        assert.ok(req.method === 'GET' || req.method === 'HEAD', 'static server is read-only')
        const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname)
        const file = path.resolve(SITE, `.${pathname === '/' ? '/index.html' : pathname}`)
        assert.ok(file.startsWith(SITE + path.sep), 'static file must stay inside site/')
        const data = fs.readFileSync(file)
        res.setHeader('Content-Type', `${mime[path.extname(file)] || 'application/octet-stream'}${/\.(html|css|js)$/.test(file) ? '; charset=utf-8' : ''}`)
        res.setHeader('Cache-Control', 'no-store')
        request.status = 200
        res.writeHead(200)
        res.end(req.method === 'HEAD' ? undefined : data)
      } catch (error) {
        request.status = 404
        request.error = errorText(error)
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' })
        res.end('Not found')
      }
    })
    server.on('error', (error) => { void finish(error) })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${server.address().port}`
    report.origin = base
    const isolated = session.fromPartition(`site-ui-${process.pid}`, { cache: false })
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
      width: 1366, height: 768, minWidth: 1, minHeight: 1, useContentSize: true,
      frame: false, show: true, skipTaskbar: true, enableLargerThanScreen: true, backgroundColor: '#0b0f11',
      webPreferences: { session: isolated, nodeIntegration: false, contextIsolation: true, sandbox: true, backgroundThrottling: false }
    })
    win.webContents.setZoomFactor(1)
    win.webContents.setWindowOpenHandler(({ url }) => {
      report.blockedRequests.push({ url, type: 'popup' })
      return { action: 'deny' }
    })
    win.webContents.on('will-navigate', (event, url) => {
      if (new URL(url).origin !== base) {
        event.preventDefault()
        report.blockedRequests.push({ url, type: 'navigation' })
      }
    })
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error') report.consoleErrors.push({ page, message: event.message, source: event.sourceId, line: event.lineNumber })
    })
    win.webContents.on('render-process-gone', (_event, details) => { void finish(new Error(`Renderer exited: ${JSON.stringify(details)}`)) })
    win.webContents.on('did-fail-load', (_event, code, description, url) => {
      report.runtimeErrors.push(`Load failure ${code}: ${description} (${url})`)
    })
    // A fresh BrowserWindow has no loaded renderer document for executeJavaScript yet.
    await load('index.html')

    for (const name of PAGES) {
      for (const [width, height] of VIEWPORTS) {
        page = name
        viewport = { width, height }
        await check(`${name}: no page horizontal overflow at ${width}x${height}`, async (details) => {
          await resize(width, height)
          await load(name)
          Object.assign(details, await layout())
          details.screenshot = await capture(`${name.replace('.html', '')}-${width}x${height}`)
          assert.equal(details.width, width)
          assert.equal(details.height, height)
          assert.ok(details.horizontalOverflow <= 1, JSON.stringify(details))
        })
      }
    }

    await resize(950, 768)
    await load('index.html')
    await ui('window.__siteUIResizeEvents = []\naddEventListener("resize", event => window.__siteUIResizeEvents.push({ width: innerWidth, height: innerHeight, trusted: event.isTrusted }))')
    await check('home navigation opens and locks scrolling at 950px', async (details) => {
      await click('#navToggle')
      Object.assign(details, await navState())
      assert.equal(details.toggleDisplay, 'grid')
      assert.equal(details.open, true)
      assert.equal(details.expanded, 'true')
      assert.equal(details.locked, true)
      assert.equal(details.overflowY, 'hidden')
      details.screenshot = await capture('nav-open-950')
    })
    await check('real 950 -> 1000 resize keeps the compact navigation open', async (details) => {
      await resize(1000, 768)
      Object.assign(details, await navState())
      assert.ok(details.resizeEvents.some((event) => event.width === 1000 && event.trusted))
      assert.equal(details.open, true)
      assert.equal(details.expanded, 'true')
      assert.equal(details.locked, true)
      assert.equal(details.linksDisplay, 'flex')
      details.screenshot = await capture('nav-open-1000')
    })
    await check('real 1100px desktop resize closes navigation and releases scrolling', async (details) => {
      await resize(1100, 768)
      await until(async () => !(await navState()).open, 'desktop navigation reset')
      Object.assign(details, await navState())
      assert.ok(details.resizeEvents.some((event) => event.width === 1100 && event.trusted))
      assert.equal(details.expanded, 'false')
      assert.equal(details.locked, false)
      assert.notEqual(details.overflowY, 'hidden')
      assert.equal(details.toggleDisplay, 'none')
      assert.equal(details.linksDisplay, 'flex')
      details.screenshot = await capture('nav-desktop-1100')
    })
    await check('Escape closes compact navigation and restores toggle focus', async (details) => {
      await resize(1000, 768)
      await click('#navToggle')
      await key('Tab')
      assert.ok(await ui('document.querySelector("#navLinks").contains(document.activeElement)'), 'focus must leave the toggle before Escape')
      await key('Escape')
      Object.assign(details, await navState())
      assert.equal(details.open, false)
      assert.equal(details.expanded, 'false')
      assert.equal(details.locked, false)
      assert.notEqual(details.overflowY, 'hidden')
      assert.equal(details.focus, 'navToggle')
    })

    for (const [width, height] of [[1366, 768], [390, 844]]) {
      await resize(width, height)
      await load('index.html')
      await check(`demo keyboard tabs at ${width}x${height}`, async (details) => {
        details.states = []
        await click('#demoTab1')
        const sequence = [['Right', 2], ['Down', 3], ['Right', 1], ['Left', 3], ['Up', 2], ['Home', 1], ['End', 3]]
        for (const [keyCode, index] of sequence) {
          await key(keyCode)
          const state = await ui(`({ key: ${literal(keyCode)}, selected: [...document.querySelectorAll('.demo__step[aria-selected="true"]')].map(el => el.id),
            tabbable: [...document.querySelectorAll('.demo__step')].filter(el => el.tabIndex === 0).map(el => el.id),
            visiblePanels: [...document.querySelectorAll('.demo__panel')].filter(el => getComputedStyle(el).display !== 'none').map(el => el.id),
            focus: document.activeElement.id })`)
          details.states.push(state)
          assert.deepEqual(state.selected, [`demoTab${index}`])
          assert.deepEqual(state.tabbable, [`demoTab${index}`])
          assert.deepEqual(state.visiblePanels, [`demoPanel${index}`])
          assert.equal(state.focus, `demoTab${index}`)
        }
        details.screenshot = await capture(`demo-keyboard-${width}`)
      })
      await check(`FAQ pointer and keyboard disclosure at ${width}x${height}`, async (details) => {
        details.items = []
        const count = await ui('document.querySelectorAll(".faq__item").length')
        assert.ok(count > 0)
        for (let index = 1; index <= count; index++) {
          const selector = `.faq__item:nth-child(${index})`
          await click(`${selector} summary`)
          const state = await evaluate((selector) => {
            const el = document.querySelector(selector)
            return { open: el.open, answerHeight: el.querySelector('.faq__a').getBoundingClientRect().height,
              answer: el.querySelector('.faq__a').textContent.trim(), focusTag: document.activeElement.tagName }
          }, selector)
          details.items.push({ index, ...state })
          assert.equal(state.open, true)
          assert.equal(state.focusTag, 'SUMMARY', 'the pointer must focus the real disclosure summary')
          assert.ok(state.answerHeight > 0 && state.answer.length > 0)
          if (index === 1) details.screenshot = await capture(`faq-expanded-${width}`)
          await key('Enter')
          assert.equal(await ui(`document.querySelector(${literal(selector)}).open`), false)
          if (index === 1) {
            await key('Space')
            assert.equal(await ui(`document.querySelector(${literal(selector)}).open`), true)
            await key('Space')
            assert.equal(await ui(`document.querySelector(${literal(selector)}).open`), false)
          }
        }
      })

      // Audit every currently authored semantic secondary token, not decorative mock text/line numbers.
      // tok-com currently has no authored nodes: record that explicitly instead of inventing a fixture.
      for (const [container, tab] of [['.mini-code', null], ['#demoPanel1 .code', 1], ['#demoPanel2 .code', 2], ['#demoPanel3 .code', 3]]) {
        await check(`secondary code contrast ${container} at ${width}x${height}`, async (details) => {
          if (tab) await click(`#demoTab${tab}`)
          await evaluate((selector) => document.querySelector(selector).scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' }), container)
          await until(() => evaluate((selector) => {
            for (let el = document.querySelector(selector); el; el = el.parentElement) if (Number(getComputedStyle(el).opacity) < 0.999) return false
            return true
          }, container), 'contrast container revealed')
          await settle()
          try {
            const prepared = await evaluate(prepareContrast, container, SECONDARY)
            details.method = 'computed RGBA layers composited over captured real underlay (including ancestor gradients and backdrop)'
            details.threshold = 4.5
            details.selectorCounts = prepared.counts
            details.samples = []
            assert.ok(prepared.tokens.length > 0, 'semantic secondary tokens must be present')
            await settle()
            const image = await win.webContents.capturePage()
            const size = image.getSize()
            const bitmap = image.toBitmap()
            assert.equal(bitmap.length, size.width * size.height * 4)
            for (const token of prepared.tokens) {
              const x = Math.min(size.width - 1, Math.max(0, Math.floor(token.point.x * size.width / width)))
              const y = Math.min(size.height - 1, Math.max(0, Math.floor(token.point.y * size.height / height)))
              const offset = (y * size.width + x) * 4
              // Electron's native bitmap uses BGRA bytes on supported little-endian desktops.
              const underlay = [bitmap[offset + 2], bitmap[offset + 1], bitmap[offset], bitmap[offset + 3] / 255]
              assert.equal(underlay[3], 1, 'captured background must be opaque')
              let background = underlay
              for (const layer of [...token.layers].reverse()) background = over(layer.rgba, background)
              const foreground = over(token.foreground, background)
              const light = [luminance(foreground), luminance(background)].sort((a, b) => a - b)
              const ratio = (light[1] + 0.05) / (light[0] + 0.05)
              details.samples.push({ ...token, underlay, background, renderedForeground: foreground, ratio })
            }
            details.minimumRatio = Math.min(...details.samples.map((sample) => sample.ratio))
            assert.ok(details.minimumRatio >= 4.5, `secondary code contrast ${details.minimumRatio.toFixed(4)} < 4.5`)
          } finally {
            await ui('window.__siteUIContrast?.restore()')
            await settle()
          }
          details.screenshot = await capture(`contrast-${tab || 'mini'}-${width}`)
        })
      }

      await load('tools.html')
      const tools = await ui('[...document.querySelectorAll("#toolList .tool")].map(el => ({ id: el.id, category: el.dataset.category }))')
      const all = tools.map((tool) => tool.id)
      await check(`tool category filters and counts at ${width}x${height}`, async (details) => {
        details.total = all.length
        details.categories = []
        assert.ok(all.length > 0)
        assertTools(await toolState(), all, 'all')
        for (const category of ['nav', 'interact', 'read', 'network', 'diag', 'all']) {
          await click(`.filter[data-filter="${category}"]`)
          const state = await toolState()
          details.categories.push({ category, ...state })
          const expected = category === 'all' ? all : tools.filter((tool) => tool.category === category).map((tool) => tool.id)
          assert.ok(expected.length > 0)
          assertTools(state, expected, category)
        }
      })
      await check(`typing resets stale category and slash focuses search at ${width}x${height}`, async (details) => {
        await click('.filter[data-filter="network"]')
        await search(' BrOwSeR_ClIcK ')
        details.afterTyping = await toolState()
        assertTools(details.afterTyping, ['tool-click'], 'all')
        assert.equal(details.afterTyping.scope, '全部分类')
        await ui('document.activeElement.blur()')
        await key('/')
        assert.equal(await ui('document.activeElement.id'), 'toolSearch')
        const selection = await ui('({ start: document.activeElement.selectionStart, end: document.activeElement.selectionEnd, length: document.activeElement.value.length })')
        details.selection = selection
        assert.equal(selection.start, 0)
        assert.equal(selection.end, selection.length)
        await win.webContents.insertText('browser_navigate')
        await settle()
        details.prefixSearch = await toolState()
        assertTools(details.prefixSearch, ['tool-navigate', 'tool-navigate-back', 'tool-navigate-forward'], 'all')
        details.screenshot = await capture(`tools-search-${width}`)
      })
      await check(`tool query/filter empty state and full recovery at ${width}x${height}`, async (details) => {
        await search('browser_click')
        await click('.filter[data-filter="network"]')
        details.combinedEmpty = await toolState()
        assertTools(details.combinedEmpty, [], 'network')
        await search('')
        details.categoryRecovered = await toolState()
        assertTools(details.categoryRecovered, tools.filter((tool) => tool.category === 'network').map((tool) => tool.id), 'network')
        await search('site-ui-definitely-no-such-tool-94d2')
        details.noMatch = await toolState()
        assertTools(details.noMatch, [], 'all')
        details.emptyScreenshot = await capture(`tools-empty-${width}`)
        await search('')
        details.recovered = await toolState()
        assertTools(details.recovered, all, 'all')
        details.layout = await layout()
        assert.ok(details.layout.horizontalOverflow <= 1)
        details.screenshot = await capture(`tools-restored-${width}`)
      })
    }
    await check('all pages and local assets load without console errors or external requests', async (details) => {
      await pause(100)
      details.consoleErrors = report.consoleErrors
      details.runtimeErrors = report.runtimeErrors
      details.blockedRequests = report.blockedRequests
      details.requests = report.requests.length
      details.localFailures = report.requests.filter((request) => request.status !== 200)
      assert.deepEqual(details.consoleErrors, [])
      assert.deepEqual(details.runtimeErrors, [])
      assert.deepEqual(details.blockedRequests, [])
      assert.deepEqual(details.localFailures, [])
      for (const name of [...PAGES, 'assets/site.css', 'assets/site.js']) {
        assert.ok(report.requests.some((request) => request.url.split('?')[0] === `/${name}` && request.status === 200), `${name} was really requested`)
      }
      assert.equal(report.checks.filter((item) => item.name.includes('no page horizontal overflow')).length, 21)
    })
    await finish()
  } catch (error) {
    await finish(error)
  }
}

function over(foreground, background) {
  const alpha = foreground[3] + background[3] * (1 - foreground[3])
  return [...foreground.slice(0, 3).map((value, index) => (value * foreground[3] + background[index] * background[3] * (1 - foreground[3])) / alpha), alpha]
}

function luminance(color) {
  return color.slice(0, 3).map((value) => {
    const channel = value / 255
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
  }).reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0)
}

// Runs in the unprivileged page. Capture the real underlay, then restore all runtime-only changes.
// Keeping ancestor gradient/backdrop pixels avoids pretending a transparent code block is opaque.
function prepareContrast(containerSelector, selectors) {
  if (window.__siteUIContrast) throw new Error('Previous contrast sample was not restored')
  const container = document.querySelector(containerSelector)
  const parse = (css) => {
    const match = /^rgba?\(([^)]+)\)$/.exec(css)
    if (!match) throw new Error(`Unsupported computed color: ${css}`)
    const parts = match[1].trim().split(/[\s,/]+/)
    const rgba = parts.slice(0, 3).map((part) => part.endsWith('%') ? Number.parseFloat(part) * 2.55 : Number(part))
    rgba.push(parts[3] === undefined ? 1 : Number.parseFloat(parts[3]) / (parts[3].endsWith('%') ? 100 : 1))
    if (rgba.length !== 4 || rgba.some((value) => !Number.isFinite(value))) throw new Error(`Invalid RGBA: ${css}`)
    return rgba
  }
  const changed = new Map()
  const tokens = []
  const counts = {}
  for (const selector of selectors) {
    const elements = [...container.querySelectorAll(selector)]
    counts[selector] = elements.length
    for (const [index, el] of elements.entries()) {
      const rect = el.getBoundingClientRect()
      let left = Math.max(0, rect.left)
      let right = Math.min(innerWidth, rect.right)
      let top = Math.max(0, rect.top)
      let bottom = Math.min(innerHeight, rect.bottom)
      const layers = []
      let underlayBase
      for (let node = el; node; node = node.parentElement) {
        const style = getComputedStyle(node)
        if (Number(style.opacity) !== 1) throw new Error('Contrast sample has a translucent/revealing ancestor')
        const bounds = node.getBoundingClientRect()
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowX)) {
          left = Math.max(left, bounds.left)
          right = Math.min(right, bounds.left + node.clientWidth)
        }
        if (/^(auto|scroll|hidden|clip)$/.test(style.overflowY)) {
          top = Math.max(top, bounds.top)
          bottom = Math.min(bottom, bounds.top + node.clientHeight)
        }
      }
      if (right <= left || bottom <= top) throw new Error(`Contrast token is clipped: ${selector}[${index}]`)
      for (let node = el; node; node = node.parentElement) {
        const style = getComputedStyle(node)
        const rgba = parse(style.backgroundColor)
        if (style.backgroundImage !== 'none' || rgba[3] === 1) {
          underlayBase = { tag: node.tagName, className: node.className, backgroundColor: style.backgroundColor, backgroundImage: style.backgroundImage }
          break
        }
        layers.push({ tag: node.tagName, className: node.className, css: style.backgroundColor, rgba })
        if (rgba[3] > 0 && !changed.has(node)) changed.set(node, node.getAttribute('style'))
      }
      tokens.push({ selector, index, text: el.textContent.trim(), foregroundCss: getComputedStyle(el).color,
        foreground: parse(getComputedStyle(el).color), layers, underlayBase, point: { x: (left + right) / 2, y: (top + bottom) / 2 } })
    }
  }
  const hideText = document.createElement('style')
  hideText.textContent = `${containerSelector}, ${containerSelector} * { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important }`
  window.__siteUIContrast = { restore() {
    hideText.remove()
    for (const [el, style] of changed) {
      if (style === null) el.removeAttribute('style')
      else el.setAttribute('style', style)
    }
    delete window.__siteUIContrast
  } }
  for (const node of changed.keys()) node.style.setProperty('background-color', 'transparent', 'important')
  document.head.appendChild(hideText)
  return { counts, tokens }
}
