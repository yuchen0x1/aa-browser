/** Real Electron desktop regression suite. All mutable state stays inside this repo. */
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import Module, { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import { spawn } from 'node:child_process'

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
    AA_BROWSER_DOWNLOAD_DIR: path.join(runDir, 'downloads'),
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
  const { app, webContents, BaseWindow, Menu } = await import('electron')
  const updateUi = process.argv.includes('--update-ui')
  let updateProvider
  if (updateUi) {
    // Only this isolated test instance acts packaged; the provider never uses a network or installer.
    app.setPath('userData', process.env.AA_BROWSER_USER_DATA_DIR)
    Object.defineProperty(app, 'isPackaged', { value: true })
    app.getVersion = () => '0.0.3'
    updateProvider = new EventEmitter()
    updateProvider.downloads = 0
    updateProvider.installs = 0
    const info = { version: '0.0.4', releaseDate: '2026-11-13', files: [{ size: 100 }] }
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
  const runDir = process.env.AA_DESKTOP_TEST_DIR
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
  const server = http.createServer((req, res) => {
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    if (req.url === '/frame') { res.end('<p>Child frame</p>'); return }
    res.end(`<title>Desktop fixture</title><h1>Aa desktop regression</h1><p>needle needle needle</p><input aria-label="Fixture input"><a href="/popup-private" target="_blank">Open child</a><iframe src="about:blank"></iframe>`)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${server.address().port}`
  let chrome
  const ui = (code) => chrome.executeJavaScript(code, true)
  const state = () => ui('window.aa.getState()')
  async function click(selector) {
    await ui(`document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block:'nearest',inline:'nearest'})`)
    await pause(40)
    const point = await ui(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); const r = el.getBoundingClientRect(); return {x: Math.round(r.x+r.width/2), y: Math.round(r.y+r.height/2)} })()`)
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
    chrome.on('console-message', (_event, details) => {
      if (details?.level === 'error') errors.push(details.message)
    })
    await until(() => fs.existsSync(process.env.AA_BROWSER_CONNECTION_FILE), 'discovery')
    const connection = JSON.parse(fs.readFileSync(process.env.AA_BROWSER_CONNECTION_FILE, 'utf8'))
    ws = new WebSocket(`ws://127.0.0.1:${connection.port}/?token=${connection.token}`)
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    ws.on('message', (raw) => {
      const response = JSON.parse(String(raw))
      const item = pending.get(response.id)
      if (!item) return
      pending.delete(response.id)
      clearTimeout(item.timer)
      if (response.ok) item.resolve(response.result)
      else item.reject(new Error(response.error))
    })
    const initial = await state()
    if (updateUi) {
      await until(async () => (await state()).update?.status === 'downloading', 'automatic update on startup/focus')
      await until(() => ui('!document.querySelector("#update-notice").hidden && document.querySelector("#btn-update-notice").textContent.includes("40%")'), 'visible download notice')
      assert.equal(await ui('document.querySelector("#settings-modal").hidden'), true)
      const window = BaseWindow.getAllWindows()[0]
      const shellView = window.contentView.children.find((view) => view.webContents === chrome)
      await until(() => shellView.getBounds().height === 128, 'update banner native bounds')
      assert.equal(updateProvider.downloads, 1)
      pass('automatic download is visible on the main window without opening settings')
      await click('#btn-find')
      await until(() => shellView.getBounds().height === 176, 'find plus update banner native bounds')
      assert.ok(await ui('document.querySelector("#find-bar").getBoundingClientRect().top >= 128'))
      await click('#find-close')
      pass('find toolbar and page layout reserve separate space for the update banner')
      updateProvider.emit('error', new Error('simulated download interruption'))
      await until(() => ui('document.querySelector("#update-notice-action").textContent === "立即重试"'), 'download error action')
      await click('#update-notice-action')
      await until(() => updateProvider.downloads === 2, 'actual retry IPC')
      pass('visible retry action resumes a failed download')
      await click('#update-notice-dismiss')
      await until(() => shellView.getBounds().height === 84, 'dismiss update banner')
      assert.equal(await ui('document.querySelector("#btn-update-notice").hidden'), false)
      updateProvider.finish()
      await until(() => ui('!document.querySelector("#update-notice").hidden && document.querySelector("#update-notice-action").textContent === "重启安装"'), 'download completion notice')
      assert.equal(updateProvider.installs, 0)
      pass('later keeps the toolbar entry and completion shows a fresh prompt without forcing restart')
      await click('#btn-update-notice')
      assert.equal(await ui('document.querySelector("#settings-modal").hidden'), false)
      assert.ok(await ui('document.querySelector("#update-status").textContent.includes("已下载")'))
      await click('#btn-close-settings')
      await click('#update-notice-action')
      assert.equal(updateProvider.installs, 1)
      pass('toolbar opens update settings and explicit restart action reaches the installer API')
      fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify({ status: 'PASS', simulatedProvider: true, checks: results }, null, 2))
      console.log(`PASS: all ${results.length} update UI checks (simulated provider; no real installer)`)
      ws.close(); server.close(); app.quit()
      return
    }
    assert.ok(initial.update)
    assert.equal(initial.canReopenClosed, false)
    pass('initial UI state includes updater, finder and restore availability')
    await click('#btn-settings')
    await until(() => ui('document.querySelector("#set-engine").options.length > 0'), 'settings ready')
    await ui('document.querySelector("#set-engine").value="https://duckduckgo.com/?q="; document.querySelector("#set-engine").dispatchEvent(new Event("change"))')
    await click('#btn-save-settings')
    assert.equal((await ui('window.aa.settingsGet()')).settings.searchEngine, 'https://duckduckgo.com/?q=')
    pass('search preset selection is saved instead of the old custom URL')
    await click('#btn-close-settings')

    await ui(`window.aa.tabNew(${JSON.stringify(base + '/normal')})`)
    await until(async () => (await state()).tabs.some((t) => t.active && t.url === base + '/normal' && !t.loading), 'normal page')
    const normalId = (await state()).activeId
    const page = await activePage()
    await until(() => page.executeJavaScript('document.body.innerText.includes("needle")'), 'fixture DOM')
    page.focus()
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
    await until(() => ui('document.querySelector("#find-status").textContent === "未找到匹配"'), 'no results')
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
    await ui('document.querySelector("#omnibox").focus(); document.querySelector("#omnibox").value="127"; document.querySelector("#omnibox").dispatchEvent(new Event("input"))')
    await until(() => ui('!document.querySelector("#suggest-panel").hidden'), 'history suggestions')
    await until(async () => shellView.getBounds().height >= await ui('document.querySelector("#suggest-panel").getBoundingClientRect().bottom'), 'suggestions native bounds')
    await ui('document.querySelector("#omnibox").blur()')
    await until(() => shellView.getBounds().height === 84, 'suggestions close')
    pass('history suggestions render beyond toolbar and return view bounds on blur')

    await ui(`window.aa.tabClose(${JSON.stringify(normalId)})`)
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

    await tool('browser_tabs', { action: 'new', url: base + '/private', isolated: true })
    await until(async () => (await state()).tabs.some((t) => t.active && t.url === base + '/private' && !t.loading), 'private page')
    const privatePage = await activePage()
    assert.equal(await privatePage.executeJavaScript('typeof window.aa'), 'undefined')
    const permission = await privatePage.executeJavaScript('navigator.permissions.query({name:"clipboard-read"}).then(p=>p.state)')
    assert.equal(permission, 'denied')
    pass('web page has no privileged bridge and clipboard-read permission is denied')
    await privatePage.executeJavaScript('history.pushState({}, "", "/private-spa")')
    const tabsBefore = (await state()).tabs.length
    await privatePage.executeJavaScript(`window.open(${JSON.stringify(base + '/popup-private')})`)
    await until(async () => (await state()).tabs.length === tabsBefore + 1, 'private popup')
    await until(async () => (await state()).tabs.some((t) => t.active && t.url === base + '/popup-private' && !t.loading), 'private popup load')
    const privateTabs = (await state()).tabs.filter((t) => t.isolated)
    assert.equal(privateTabs.length, 2)
    const history = JSON.parse(fs.readFileSync(historyFile, 'utf8'))
    assert.equal(history.some((e) => /private/.test(e.url)), false)
    for (const tab of privateTabs) await ui(`window.aa.tabClose(${JSON.stringify(tab.id)})`)
    assert.equal((await state()).canReopenClosed, false)
    pass('private navigation/SPA/popup stay isolated and never enter history or restore stack')

    // The right-click route must preserve the same isolation policy.
    await tool('browser_tabs', { action: 'new', url: base + '/private-context', isolated: true })
    await until(async () => (await state()).tabs.some((t) => t.active && t.url === base + '/private-context' && !t.loading), 'context source')
    const contextSource = await activePage()
    const originalPopup = Menu.prototype.popup
    let contextItem
    Menu.prototype.popup = function () { contextItem = this.items.find((item) => item.label === '在新标签页打开链接') }
    try {
      contextSource.emit('context-menu', {}, { linkURL: base + '/private-context-child', selectionText: '', isEditable: false })
      assert.ok(contextItem)
      contextItem.click()
    } finally { Menu.prototype.popup = originalPopup }
    await until(async () => (await state()).tabs.some((t) => t.active && t.url === base + '/private-context-child'), 'context child')
    assert.equal((await state()).tabs.find((t) => t.active).isolated, true)
    pass('context-menu link opening also preserves isolation')

    // Restoring must re-evaluate a newly tightened allowlist.
    await ui(`window.aa.tabNew(${JSON.stringify(base + '/blocked-restore')})`)
    const blockedId = (await state()).activeId
    await until(async () => (await state()).tabs.find((t) => t.id === blockedId)?.url === base + '/blocked-restore', 'restore candidate')
    await ui(`window.aa.tabClose(${JSON.stringify(blockedId)})`)
    await ui('window.aa.settingsSet({allowedSites:["https://example.com"]})')
    assert.equal(await ui('window.aa.tabReopen()'), false)
    await ui('window.aa.settingsSet({allowedSites:[]})')
    pass('reopen applies current site allowlist')
    await click('#btn-settings')
    await until(() => ui('document.querySelector("#set-engine").options.length > 0'), 'settings reopen')
    await ui('document.querySelector("#set-engine-url").value="javascript:alert(1)"')
    await click('#btn-save-settings')
    await until(() => ui('document.querySelector("#settings-status").textContent.includes("保存失败")'), 'save failure feedback')
    assert.equal((await ui('window.aa.settingsGet()')).settings.searchEngine, 'https://duckduckgo.com/?q=')
    pass('invalid settings show an error and preserve the previous value')
    await ui(`document.querySelector('#set-engine-url').value=${JSON.stringify(base + '/search?q=')}; document.querySelector('#set-engine-url').dispatchEvent(new Event('input'))`)
    await click('#btn-save-settings')
    await until(() => ui('document.querySelector("#settings-status").textContent === "已保存"'), 'valid settings save')
    await click('#btn-close-settings')
    await tool('browser_navigate', { url: 'fresh search phrase', snapshot: false })
    await until(async () => (await state()).tabs.some((t) => t.active && t.url === base + '/search?q=fresh%20search%20phrase'), 'Agent search engine refresh')
    await tool('browser_tabs', { action: 'new', url: 'another search phrase' })
    await until(async () => (await state()).tabs.some((t) => t.active && t.url === base + '/search?q=another%20search%20phrase'), 'Agent new-tab search engine refresh')
    pass('both Agent search paths use updated settings without restarting')
    await pause(500)
    await until(() => webContents.getAllWebContents().filter((wc) => wc !== chrome).every((wc) => !wc.isLoading()), 'all pages settle before shutdown')
    assert.equal(errors.length, 0, errors.join('\n'))
    pass('chrome renderer reports no console errors')
    fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify({ status: 'PASS', checks: results, screenshot: process.env.AA_DESKTOP_SCREENSHOTS === '1' ? 'docs/screenshots/page-find-toolbar.png' : undefined }, null, 2))
    console.log(`PASS: all ${results.length} desktop checks; report ${path.join(runDir, 'result.json')}`)
    ws.close()
    server.close()
    app.quit()
  } catch (error) {
    console.error('FAIL:', error)
    fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify({ status: 'FAIL', checks: results, error: error.stack }, null, 2))
    ws?.close()
    server.close()
    app.exit(1)
  }
  })().catch((error) => { console.error(error); process.exit(1) })
}
