import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import WebSocket from 'ws'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
if (!process.versions.electron) {
  const directory = fs.mkdtempSync(path.join(root, '.local-verification', 'profiles-e2e-'))
  const env = { ...process.env, AA_PROFILE_E2E_DIR: directory, AA_BROWSER_USER_DATA_DIR: path.join(directory, 'userData'), AA_BROWSER_SETTINGS_FILE: path.join(directory, 'settings.json'), AA_BROWSER_DATA_DIR: directory, AA_BROWSER_PROFILES_FILE: path.join(directory, 'profiles.json'), AA_BROWSER_SESSION_FILE: path.join(directory, 'session.json'), AA_BROWSER_CONNECTION_FILE: path.join(directory, 'connection.json'), AA_BROWSER_TASK_CENTER_FILE: path.join(directory, 'task-center.json'), AA_BROWSER_HISTORY_DIR: path.join(directory, 'history'), AA_BROWSER_DOWNLOAD_DIR: path.join(directory, 'downloads'), AA_BROWSER_EXTENSIONS_FILE: path.join(directory, 'extensions.json'), AA_BROWSER_EVIDENCE_FILE: path.join(directory, 'evidence.json'), AA_BROWSER_START_IN_BACKGROUND: '1' }
  fs.writeFileSync(env.AA_BROWSER_SETTINGS_FILE, JSON.stringify({ autoUpdate: false, restoreSession: true, backgroundMode: 'visible', theme: 'dark' }))
  delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL
  const child = spawn(require('electron'), [fileURLToPath(import.meta.url)], { cwd: root, env, stdio: 'inherit' })
  const timer = setTimeout(() => { console.error('FAIL: profile E2E timed out'); child.kill() }, 240_000)
  child.once('error', (error) => { clearTimeout(timer); console.error(error); process.exitCode = 1 })
  child.once('exit', (code) => { clearTimeout(timer); process.exitCode = code ?? 1; console.log(`Profile E2E artifacts: ${directory}`) })
} else {
  void run().catch((error) => { console.error(error); process.exit(1) })
}

async function run() {
  const { app, webContents, BaseWindow, session } = await import('electron')
  const directory = process.env.AA_PROFILE_E2E_DIR
  const checks = [], sockets = [], pending = new Set()
  const errors = []
  const crashDiagnostics = { events: [] }
  process.on('unhandledRejection', (error) => { errors.push(String(error?.stack ?? error)); console.error(error) })
  let nextId = 0, proxyRequests = 0, chrome
  const pass = (label) => { checks.push(label); console.log(`PASS: ${label}`) }
  async function until(operation, label, timeout = 20_000) {
    const end = Date.now() + timeout
    while (Date.now() < end) { const value = await operation(); if (value) return value; await delay(40) }
    throw new Error(`Timed out: ${label}`)
  }
  const ui = (code) => chrome.executeJavaScript(code, true)
  const state = () => ui('window.aa.getState()')
  const text = (result) => (result?.content ?? []).filter((item) => item.type === 'text').map((item) => item.text).join('\n')
  const parse = (result) => JSON.parse(text(result))
  async function approved(operation) {
    let settled = false, outcome, failure
    operation.then((value) => { outcome = value; settled = true }, (error) => { failure = error; settled = true })
    const end = Date.now() + 60_000
    while (!settled && Date.now() < end) {
      for (const request of (await state()).pendingApprovals ?? []) await ui(`window.aa.decideApproval(${JSON.stringify(request.id)}, true)`)
      await delay(30)
    }
    if (!settled) throw new Error('Approved fixture operation timed out')
    if (failure) throw failure
    return outcome
  }
  async function connect(connection) {
    const ws = new WebSocket(`ws://127.0.0.1:${connection.port}/?token=${connection.token}`)
    sockets.push(ws)
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    const requests = new Map()
    ws.on('message', (raw) => {
      const response = JSON.parse(String(raw)); if (response.event) return
      const item = requests.get(response.id); if (!item) return
      requests.delete(response.id); pending.delete(item); clearTimeout(item.timer)
      if (!response.ok) item.reject(new Error(response.error))
      else if (response.result?.isError) item.reject(new Error(text(response.result)))
      else item.resolve(response.result)
    })
    return (tool, args = {}) => new Promise((resolve, reject) => {
      const id = ++nextId
      const item = { resolve, reject, timer: setTimeout(() => { requests.delete(id); pending.delete(item); reject(new Error(`Tool timeout: ${tool}`)) }, 60_000) }
      requests.set(id, item); pending.add(item)
      ws.send(JSON.stringify({ id, tool, args, idempotencyKey: `profile-fixture-${process.pid}-${id}` }))
    })
  }
  const server = http.createServer((request, response) => {
    const url = new URL(request.url, 'http://fixture')
    if (url.pathname === '/download') { response.writeHead(200, { 'Content-Disposition': 'attachment; filename="same-name.txt"', 'Content-Type': 'text/plain' }); response.end('profile download fixture'); return }
    const login = /^\/login\/([a-z]+)$/.exec(url.pathname)?.[1]
    if (login) response.setHeader('Set-Cookie', `fixture_identity=${login}; Path=/; HttpOnly; SameSite=Lax`)
    const identity = login ?? /fixture_identity=([a-z]+)/.exec(request.headers.cookie ?? '')?.[1] ?? 'anonymous'
    response.setHeader('Content-Type', 'text/html; charset=utf-8')
    response.end(`<!doctype html><title>Profile fixture</title><h1>Signed in as ${identity}</h1><label>Upload fixture <input type="file" id="upload"></label><button id="noop">Inspect fixture</button><script>
      window.fixtureReady = (async () => {
        const id = ${JSON.stringify(identity)};
        ${login ? "localStorage.setItem('identity', id); sessionStorage.setItem('identity', id);" : ''}
        const db = await new Promise((resolve,reject) => { const req=indexedDB.open('identity',1); req.onupgradeneeded=()=>req.result.createObjectStore('accounts'); req.onsuccess=()=>resolve(req.result); req.onerror=()=>reject(req.error); });
        ${login ? "await new Promise((resolve,reject)=>{const tx=db.transaction('accounts','readwrite');tx.objectStore('accounts').put(id,'current');tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});" : ''}
        db.close(); return true;
      })();
    </script>`)
  })
  const proxy = http.createServer((_request, response) => { proxyRequests++; response.setHeader('Content-Type', 'text/html'); response.end('<title>Proxy fixture</title><h1>Profile proxy reached</h1>') })
  let success = false
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${server.address().port}`
    app.setAppPath(root)
    await import(pathToFileURL(path.join(root, 'out/main/index.js')).href)
    await app.whenReady()
    chrome = await until(() => webContents.getAllWebContents().find((wc) => wc.getURL().endsWith('/renderer/index.html')), 'privileged chrome view')
    await until(() => ui('!!window.aa'), 'preload')
    BaseWindow.getAllWindows()[0].show()
    await until(() => fs.existsSync(process.env.AA_BROWSER_CONNECTION_FILE), 'MCP discovery')
    const connection = JSON.parse(fs.readFileSync(process.env.AA_BROWSER_CONNECTION_FILE, 'utf8'))
    const a = await connect(connection), b = await connect(connection)
    const denied = assert.rejects(a('browser_profiles', { action: 'create', name: 'Denied fixture' }), /APPROVAL_DENIED|取消|denied|approved/i)
    await until(async () => (await state()).pendingApprovals?.length, 'native profile approval')
    for (const request of (await state()).pendingApprovals) await ui(`window.aa.decideApproval(${JSON.stringify(request.id)}, false)`)
    await denied
    const one = parse(await approved(a('browser_profiles', { action: 'create', name: 'Fixture work' })))
    const two = parse(await approved(b('browser_profiles', { action: 'create', name: 'Fixture personal' })))
    await approved(a('browser_profiles', { action: 'bind', profileId: one.id }))
    await approved(b('browser_profiles', { action: 'bind', profileId: two.id }))
    pass('profile creation and client identity binding require native approval; denial grants nothing')
    await Promise.all([a('browser_navigate', { url: `${base}/login/alice`, newTab: true, snapshot: false }), b('browser_navigate', { url: `${base}/login/bob`, newTab: true, snapshot: false })])
    const sesA = session.fromPartition(`persist:aa-profile-${one.id}`), sesB = session.fromPartition(`persist:aa-profile-${two.id}`)
    const pageFor = (ses, suffix) => webContents.getAllWebContents().find((wc) => wc !== chrome && wc.session === ses && wc.getURL().endsWith(suffix))
    let pageA = await until(() => pageFor(sesA, '/login/alice'), 'work account page')
    let pageB = await until(() => pageFor(sesB, '/login/bob'), 'personal account page')
    await Promise.all([pageA.executeJavaScript('window.fixtureReady'), pageB.executeJavaScript('window.fixtureReady')])
    const identity = async (page) => page.executeJavaScript(`(async()=>({local:localStorage.getItem('identity'),session:sessionStorage.getItem('identity'),indexed:await new Promise((resolve,reject)=>{const r=indexedDB.open('identity',1);r.onsuccess=()=>{const db=r.result;const tx=db.transaction('accounts');const get=tx.objectStore('accounts').get('current');get.onsuccess=()=>{resolve(get.result);db.close()};get.onerror=()=>reject(get.error)};r.onerror=()=>reject(r.error)})}))()`)
    assert.deepEqual(await identity(pageA), { local: 'alice', session: 'alice', indexed: 'alice' })
    assert.deepEqual(await identity(pageB), { local: 'bob', session: 'bob', indexed: 'bob' })
    assert.equal((await sesA.cookies.get({ url: base })).find((cookie) => cookie.name === 'fixture_identity').value, 'alice')
    assert.equal((await sesB.cookies.get({ url: base })).find((cookie) => cookie.name === 'fixture_identity').value, 'bob')
    pass('real Chromium Cookie, LocalStorage, SessionStorage and IndexedDB remain isolated for two local simulated accounts')
    await Promise.all([a('browser_navigate', { url: `${base}/account`, snapshot: false }), b('browser_navigate', { url: `${base}/account`, snapshot: false })])
    pageA = await until(() => pageFor(sesA, '/account'), 'work account reload'); pageB = await until(() => pageFor(sesB, '/account'), 'personal account reload')
    assert.match(text(await a('browser_extract')), /alice/)
    assert.match(text(await b('browser_extract')), /bob/)
    const tabs = (await state()).tabs
    const tabA = tabs.find((tab) => tab.profileId === one.id && tab.url === `${base}/account`)
    const tabB = tabs.find((tab) => tab.profileId === two.id && tab.url === `${base}/account`)
    assert.ok(tabA && tabB)
    await assert.rejects(() => a('browser_snapshot', { tabId: tabB.id }), /不存在|not found|TARGET|NO_TAB|标签|profile/i)
    assert.equal(text(await a('browser_cookies', { action: 'get' })).includes('alice'), false)
    pass('concurrent MCP clients use their bound Profile, redact ordinary Cookie reads, and reject foreign tab ids')
    await pageA.executeJavaScript(`window.open(${JSON.stringify(`${base}/popup`)}, '_blank')`, true)
    await until(() => pageFor(sesA, '/popup'), 'profile-owned popup')
    assert.equal(pageFor(sesB, '/popup'), undefined)
    assert.equal((await state()).tabs.find((tab) => tab.url === `${base}/popup`).profileId, one.id)
    assert.equal(text(await b('browser_tabs', { action: 'list' })).includes('/popup'), false)
    pass('window.open inherits the source Profile and MCP client ownership')
    const extensionDir = path.join(directory, 'fixture-extension')
    fs.mkdirSync(extensionDir, { recursive: true })
    fs.writeFileSync(path.join(extensionDir, 'manifest.json'), JSON.stringify({ name: 'Profile isolation fixture', version: '1.0.0', manifest_version: 3, content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'], run_at: 'document_end' }] }))
    fs.writeFileSync(path.join(extensionDir, 'content.js'), 'document.body.dataset.profileExtension = "active"')
    await approved(a('browser_extensions', { action: 'load', path: extensionDir }))
    await Promise.all([a('browser_reload', { tabId: tabA.id, snapshot: false }), b('browser_reload', { tabId: tabB.id, snapshot: false })])
    await until(() => pageA.executeJavaScript('document.body.dataset.profileExtension === "active"'), 'work extension content script')
    assert.equal(await pageB.executeJavaScript('document.body.dataset.profileExtension'), undefined)
    assert.equal(sesA.extensions.getAllExtensions().length, 1)
    assert.equal(sesB.extensions.getAllExtensions().length, 0)
    const extensionId = sesA.extensions.getAllExtensions()[0].id
    await approved(a('browser_extensions', { action: 'disable', id: extensionId }))
    await a('browser_reload', { tabId: tabA.id, snapshot: false })
    assert.equal(await pageA.executeJavaScript('document.body.dataset.profileExtension'), undefined)
    pass('extension installation, content scripts and disable are isolated to the selected Profile')
    const uploads = path.join(directory, 'profiles', one.id, 'files')
    fs.mkdirSync(uploads, { recursive: true }); const uploadFile = path.join(uploads, 'fixture.txt'); fs.writeFileSync(uploadFile, 'private work fixture')
    const refFor = async (client, tabId) => {
      const snapshot = text(await client('browser_snapshot', { tabId, full: true }))
      const line = snapshot.split('\n').find((line) => /Upload fixture/i.test(line) && /ref=/.test(line))
      assert.ok(line, snapshot); return line.match(/ref=(e\d+)/)[1]
    }
    await approved(a('browser_upload_file', { tabId: tabA.id, ref: await refFor(a, tabA.id), paths: [uploadFile] }))
    assert.equal(await pageA.executeJavaScript('document.querySelector("#upload").files[0].name'), 'fixture.txt')
    const personalRef = await refFor(b, tabB.id)
    await assert.rejects(() => approved(b('browser_upload_file', { tabId: tabB.id, ref: personalRef, paths: [uploadFile] })), /file|profile|权限|PERMISSION|文件/i)
    pageA.downloadURL(`${base}/download`); pageB.downloadURL(`${base}/download`)
    const downloads = await until(async () => { const items = (await state()).downloads ?? []; return items.filter((item) => item.state === 'completed').length >= 2 ? items : null }, 'profile downloads')
    const firstDownload = downloads.find((item) => item.profileId === one.id), secondDownload = downloads.find((item) => item.profileId === two.id)
    assert.ok(firstDownload && secondDownload)
    assert.notEqual(path.dirname(firstDownload.savePath), path.dirname(secondDownload.savePath))
    assert.equal(text(await b('browser_downloads', { action: 'list' })).includes(firstDownload.id), false)
    pass('real file upload and same-name downloads use separate Profile directories and scoped MCP records')
    const personalProxyBefore = await sesB.resolveProxy('http://aa-profile-proxy.test/')
    await approved(a('browser_network', { action: 'set', config: { mode: 'proxy', protocol: 'http', host: '127.0.0.1', port: proxy.address().port } }))
    assert.match(await sesA.resolveProxy('http://aa-profile-proxy.test/'), /PROXY|127\.0\.0\.1/)
    assert.equal(await sesB.resolveProxy('http://aa-profile-proxy.test/'), personalProxyBefore)
    await a('browser_navigate', { tabId: tabA.id, url: 'http://aa-profile-proxy.test/probe', snapshot: false })
    assert.match(text(await a('browser_extract', { tabId: tabA.id })), /Profile proxy reached/)
    assert.ok(proxyRequests > 0)
    await approved(a('browser_network', { action: 'set', config: { mode: 'direct' } }))
    await a('browser_navigate', { tabId: tabA.id, url: `${base}/account`, snapshot: false })
    pass('actual Chromium HTTP proxy routing applies to one Profile and switching back restores direct connections')
    const siblingPid = pageB.getOSProcessId()
    const targetPid = pageA.getOSProcessId()
    assert.equal(pageA.session, sesA, 'crash injection must target the work Profile Session')
    assert.equal(pageA.getURL(), `${base}/account`, 'crash injection must target the restored account page')
    assert.ok(targetPid > 0 && siblingPid > 0, 'both Profile renderers must have live OS process ids')
    assert.notEqual(targetPid, siblingPid, 'independent Profile Sessions must use separate renderer processes')
    assert.notEqual(targetPid, process.pid, 'crash injection must never target the main process')
    assert.notEqual(targetPid, chrome.getOSProcessId(), 'crash injection must never target the privileged renderer')
    Object.assign(crashDiagnostics, { targetPid, siblingPid, method: process.platform === 'linux' ? 'SIGKILL' : 'forcefullyCrashRenderer' })
    let gone
    const observeGone = (source, details) => {
      const record = { source, reason: details.reason, exitCode: details.exitCode, at: Date.now() }
      crashDiagnostics.events.push(record)
      gone ??= record
    }
    const onContentsGone = (_event, details) => observeGone('webContents', details)
    const onAppGone = (_event, crashed, details) => { if (crashed === pageA) observeGone('app', details) }
    pageA.on('render-process-gone', onContentsGone)
    app.on('render-process-gone', onAppGone)
    const recoveryState = async () => {
      const tabs = (await state()).tabs
      const target = tabs.find((tab) => tab.id === tabA.id)
      const sibling = tabs.find((tab) => tab.id === tabB.id)
      const summarize = (tab) => tab ? { id: tab.id, profileId: tab.profileId, loading: tab.loading, recovery: tab.recovery } : null
      return { target: summarize(target), sibling: summarize(sibling), targetPid: pageA.isDestroyed() ? null : pageA.getOSProcessId(), siblingPid: pageB.isDestroyed() ? null : pageB.getOSProcessId() }
    }
    try {
      // Match the Linux injection already exercised by test-renderer-crash:
      // forcefullyCrashRenderer can enter Chromium's hung-crash path there.
      if (process.platform === 'linux') process.kill(targetPid, 'SIGKILL')
      else pageA.forcefullyCrashRenderer()
      await until(() => gone, 'target renderer render-process-gone event', 12_000)
      assert.ok(['crashed', 'killed', 'abnormal-exit'].includes(gone.reason), `unexpected target renderer exit: ${JSON.stringify(gone)}`)
      await until(async () => {
        const current = await recoveryState()
        crashDiagnostics.lastState = current
        assert.notEqual(current.target?.recovery?.status, 'failed', `renderer recovery failed: ${JSON.stringify(current)}`)
        return current.target?.recovery?.status === 'recovered' ? current : null
      }, 'renderer crash recovery', 30_000)
      assert.equal(crashDiagnostics.lastState.target.recovery.reason, 'crash')
      assert.equal(crashDiagnostics.lastState.target.recovery.attempts, 1)
      assert.ok(crashDiagnostics.lastState.targetPid > 0, 'recovered renderer must have a live process')
      assert.notEqual(crashDiagnostics.lastState.targetPid, targetPid, 'recovery must replace the crashed renderer process')
      assert.equal(pageA.getURL(), `${base}/account`, 'recovery must preserve the account URL')
    } catch (error) {
      crashDiagnostics.lastState = await recoveryState().catch((failure) => ({ error: String(failure) }))
      console.error(`Profile renderer crash diagnostics: ${JSON.stringify(crashDiagnostics)}`)
      throw error
    } finally {
      pageA.removeListener('render-process-gone', onContentsGone)
      app.removeListener('render-process-gone', onAppGone)
    }
    assert.equal(pageB.getOSProcessId(), siblingPid)
    assert.match(text(await a('browser_extract', { tabId: tabA.id })), /alice/)
    assert.match(text(await b('browser_extract', { tabId: tabB.id })), /bob/)
    assert.equal((await sesA.cookies.get({ url: base })).find((cookie) => cookie.name === 'fixture_identity').value, 'alice')
    pass('a renderer crash recovers without changing the other Profile renderer or clearing either login')
    const sessionSnapshot = await until(() => { try { const value = JSON.parse(fs.readFileSync(process.env.AA_BROWSER_SESSION_FILE, 'utf8')); return value.version === 3 && value.tabs.some((tab) => tab.profileId === one.id) && value.tabs.some((tab) => tab.profileId === two.id) ? value : null } catch { return null } }, 'profile restore snapshot')
    assert.equal(sessionSnapshot.tabs.filter((tab) => tab.url === `${base}/account`).length, 2)
    pass('session persistence records both Profiles when they show the same URL')
    await approved(a('browser_extensions', { action: 'enable', id: extensionId }))
    assert.equal(sesA.extensions.getAllExtensions().length, 1)
    await approved(a('browser_profiles', { action: 'stop', profileId: one.id }))
    assert.equal((await state()).tabs.some((tab) => tab.profileId === one.id), false)
    assert.equal(sesA.extensions.getAllExtensions().length, 0)
    assert.equal((await sesA.cookies.get({ url: base })).find((cookie) => cookie.name === 'fixture_identity').value, 'alice')
    assert.equal(pageB.getOSProcessId(), siblingPid)
    assert.match(text(await b('browser_extract', { tabId: tabB.id })), /bob/)
    await approved(a('browser_profiles', { action: 'start', profileId: one.id }))
    await a('browser_navigate', { url: `${base}/account`, newTab: true, snapshot: false })
    pageA = await until(() => pageFor(sesA, '/account'), 'work account after Profile restart')
    await until(() => pageA.executeJavaScript('document.body.dataset.profileExtension === "active"'), 'enabled extension after Profile restart')
    assert.match(text(await a('browser_extract')), /alice/)
    assert.equal(sesA.extensions.getAllExtensions().length, 1)
    assert.equal(sesB.extensions.getAllExtensions().length, 0)
    pass('Profile stop closes owned pages and unloads extensions; restart restores enabled extensions and login without disturbing another Profile')
    assert.deepEqual(errors, [])
    success = true
  } finally {
    for (const item of pending) { clearTimeout(item.timer); item.reject(new Error('Fixture shutdown')) }
    for (const socket of sockets) socket.terminate()
    server.closeAllConnections(); proxy.closeAllConnections(); server.close(); proxy.close()
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ status: success ? 'PASS' : 'FAIL', checks, errors, crashDiagnostics }, null, 2))
    app.exit(success ? 0 : 1)
  }
}
