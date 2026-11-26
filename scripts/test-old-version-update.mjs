#!/usr/bin/env node
/**
 * Verify the real v0.17.0 packaged client can discover the current stable release.
 * Preparation only: node scripts/test-old-version-update.mjs
 * Live check:       node scripts/test-old-version-update.mjs --run-live
 * Never downloads an update or launches an installer. The preserved package is read-only.
 */
import assert from 'node:assert/strict'
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { extractFile } from '@electron/asar'
import { load } from 'js-yaml'
import { WebSocket } from 'ws'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageDirectory = path.join(root, '.local-verification', 'old-v017')
const archive = path.join(packageDirectory, 'resources', 'app.asar')
const executable = path.join(packageDirectory, 'Aa Browser.exe')
const oldVersion = '0.17.0'
const expectedVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
const live = process.argv.includes('--run-live')
assert.ok(process.argv.slice(2).every((arg) => arg === '--run-live'), 'Only --run-live is supported')
assert.equal(process.platform, 'win32', 'This check uses the preserved Windows package')

function hash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

function inspectPackage() {
  assert.ok(fs.statSync(executable).isFile(), 'Preserved old executable is missing')
  const manifest = JSON.parse(extractFile(archive, 'package.json').toString('utf8'))
  assert.equal(manifest.name, 'aa-browser')
  assert.equal(manifest.version, oldVersion, 'Never substitute the newly built package for the old client')
  const provider = load(fs.readFileSync(path.join(packageDirectory, 'resources', 'app-update.yml'), 'utf8'))
  assert.equal(provider.provider, 'github')
  assert.equal(provider.owner, 'yuchen0x1')
  assert.equal(provider.repo, 'aa-browser')
  assert.equal(provider.releaseType, 'release')
  return {
    version: manifest.version,
    archiveSha256: hash(archive),
    executableSha256: hash(executable),
    provider: { provider: provider.provider, owner: provider.owner, repo: provider.repo, releaseType: provider.releaseType }
  }
}

function isolate(directory) {
  const environment = { ...process.env }
  for (const key of Object.keys(environment)) {
    if (key.startsWith('AA_BROWSER_') || key.startsWith('ELECTRON_')) delete environment[key]
  }
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN']) delete environment[key]
  const isolatedHome = path.join(directory, 'home')
  const locations = {
    HOME: isolatedHome,
    USERPROFILE: isolatedHome,
    APPDATA: path.join(directory, 'appdata'),
    LOCALAPPDATA: path.join(directory, 'localappdata'),
    TEMP: path.join(directory, 'temp'),
    TMP: path.join(directory, 'temp'),
    AA_BROWSER_USER_DATA_DIR: path.join(directory, 'chromium'),
    AA_BROWSER_CONNECTION_FILE: path.join(directory, 'data', 'connection.json'),
    AA_BROWSER_SETTINGS_FILE: path.join(directory, 'data', 'settings.json'),
    AA_BROWSER_HISTORY_DIR: path.join(directory, 'data', 'history'),
    AA_BROWSER_SESSION_FILE: path.join(directory, 'data', 'session.json'),
    AA_BROWSER_DOWNLOAD_DIR: path.join(directory, 'data', 'downloads'),
    AA_BROWSER_EVIDENCE_FILE: path.join(directory, 'data', 'evidence.json'),
    AA_BROWSER_TASK_CENTER_FILE: path.join(directory, 'data', 'tasks.json'),
    AA_BROWSER_IDEMPOTENCY_FILE: path.join(directory, 'data', 'idempotency.json'),
    AA_BROWSER_EXTENSIONS_FILE: path.join(directory, 'data', 'extensions.json'),
    AA_BROWSER_MONITOR_DIR: path.join(directory, 'data', 'monitor'),
    AA_BROWSER_SCREENSHOT_DIR: path.join(directory, 'data', 'screenshots'),
    AA_BROWSER_BASELINE_DIR: path.join(directory, 'data', 'baselines'),
    AA_BROWSER_EXPORT_DIR: path.join(directory, 'data', 'exports')
  }
  for (const [key, value] of Object.entries(locations)) {
    environment[key] = value
    fs.mkdirSync(key.endsWith('_FILE') ? path.dirname(value) : value, { recursive: true })
  }
  environment.HOMEDRIVE = path.parse(isolatedHome).root.slice(0, 2)
  environment.HOMEPATH = isolatedHome.slice(2)
  fs.writeFileSync(environment.AA_BROWSER_SETTINGS_FILE, JSON.stringify({
    autoUpdate: false, updateChannel: 'stable', restoreSession: false, locale: 'en-US', theme: 'dark'
  }))
  return environment
}

async function reservePort() {
  const server = net.createServer()
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const port = server.address().port
  await new Promise((resolve) => server.close(resolve))
  return port
}

async function connectShell(port, expectedUrl, alive) {
  const deadline = Date.now() + 30_000
  let endpoint
  while (!endpoint && Date.now() < deadline) {
    assert.ok(alive(), 'The owned old application exited before exposing its shell')
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(2000) })
      const pages = await response.json()
      endpoint = pages.find((page) => page.type === 'page' && page.url === expectedUrl)?.webSocketDebuggerUrl
    } catch { /* The dedicated Chromium debugging endpoint may still be starting. */ }
    if (!endpoint) await delay(100)
  }
  assert.ok(endpoint, 'The exact preserved package shell was not found')
  const endpointUrl = new URL(endpoint)
  assert.equal(endpointUrl.protocol, 'ws:')
  assert.equal(endpointUrl.hostname, '127.0.0.1')
  assert.equal(endpointUrl.port, String(port))
  const socket = new WebSocket(endpoint)
  const pending = new Map()
  let nextId = 0
  const rejectPending = (error) => {
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(error) }
    pending.clear()
  }
  socket.on('error', rejectPending)
  socket.on('close', () => rejectPending(new Error('The owned old shell debugging connection closed')))
  socket.on('message', (raw) => {
    const message = JSON.parse(raw.toString())
    const item = pending.get(message.id)
    if (!item) return
    pending.delete(message.id)
    clearTimeout(item.timer)
    if (message.error) item.reject(new Error(message.error.message))
    else if (message.result?.exceptionDetails) item.reject(new Error(message.result.exceptionDetails.text))
    else item.resolve(message.result)
  })
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject) })
  const call = (method, params = {}, timeout = 15_000) => new Promise((resolve, reject) => {
    const id = ++nextId
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`${method} timed out`)) }, timeout)
    pending.set(id, { resolve, reject, timer })
    socket.send(JSON.stringify({ id, method, params }))
  })
  return {
    call,
    async evaluate(expression, timeout) {
      const response = await call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, timeout)
      return response.result?.value
    },
    close() { rejectPending(new Error('Old shell verification stopped')); socket.close() }
  }
}

function payloads(directory, rootDirectory = directory) {
  const found = []
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name)
    if (entry.isDirectory()) found.push(...payloads(file, rootDirectory))
    else if (/\.(?:exe|appimage|zip|7z|dmg|blockmap)$/i.test(entry.name)) found.push(path.relative(rootDirectory, file))
  }
  return found
}

async function run() {
  const preserved = inspectPackage()
  const verificationRoot = path.join(root, '.local-verification')
  fs.mkdirSync(verificationRoot, { recursive: true })
  const directory = fs.mkdtempSync(path.join(verificationRoot, 'old-version-update-'))
  const environment = isolate(directory)
  const result = { mode: live ? 'live' : 'preparation', status: 'prepared', expectedVersion, preserved }
  const resultFile = path.join(directory, 'result.json')
  let child
  let exited = false
  let shell
  try {
    assert.deepEqual(payloads(directory), [], 'The isolated environment must start without installer payloads')
    if (!live) {
      console.log(`PREPARED: preserved v${oldVersion}, official GitHub provider, isolated settings; no application launched.`)
      return
    }
    const port = await reservePort()
    const expectedUrl = pathToFileURL(path.join(packageDirectory, 'resources', 'app.asar', 'out', 'renderer', 'index.html')).href
    child = spawn(executable, [`--remote-debugging-address=127.0.0.1`, `--remote-debugging-port=${port}`], {
      cwd: directory, env: environment, windowsHide: true, stdio: 'ignore'
    })
    child.once('error', () => { exited = true })
    child.once('exit', () => { exited = true })
    shell = await connectShell(port, expectedUrl, () => !exited)
    const initial = await shell.evaluate(`(async () => {
      if (location.href !== ${JSON.stringify(expectedUrl)}) throw new Error('Unexpected shell location');
      const deadline = Date.now() + 25000;
      let info;
      while (Date.now() < deadline) {
        info = await window.aa?.agentInfo?.();
        if (info?.port > 0 && info.discoveryFile) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      if (!info?.discoveryFile) throw new Error('Old client discovery did not become ready');
      const view = await window.aa.settingsGet();
      if (!view?.settings) throw new Error('Old client settingsGet must return a SettingsView');
      const state = await window.aa.getState();
      return { version: info.version, discoveryFile: info.discoveryFile,
        currentVersion: state.update?.currentVersion, status: state.update?.status,
        autoUpdate: view.settings.autoUpdate, updateChannel: view.settings.updateChannel };
    })()`, 30_000)
    assert.equal(initial.version, oldVersion, 'The running application must actually identify itself as the old version')
    assert.equal(initial.currentVersion, oldVersion)
    assert.equal(initial.autoUpdate, false, 'Automatic update downloads must remain disabled')
    assert.equal(initial.updateChannel, 'stable')
    assert.equal(fs.realpathSync(initial.discoveryFile), fs.realpathSync(environment.AA_BROWSER_CONNECTION_FILE))
    assert.equal(JSON.parse(fs.readFileSync(initial.discoveryFile, 'utf8')).pid, child.pid, 'Only the owned process may be inspected')
    result.runningVersion = initial.version
    result.initialStatus = initial.status
    const checked = await shell.evaluate(`(async () => {
      const update = await window.aa.updateCheck();
      return { currentVersion: update?.currentVersion, version: update?.version, status: update?.status,
        noticeVisible: update?.noticeVisible, errorPresent: Boolean(update?.error) };
    })()`, 120_000)
    result.update = checked
    assert.equal(checked.currentVersion, oldVersion)
    assert.equal(checked.version, expectedVersion, `The real stable release must be v${expectedVersion}`)
    assert.equal(checked.status, 'available', 'The real updater must discover the release without downloading it')
    assert.equal(checked.noticeVisible, true)
    let notice
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      notice = await shell.evaluate(`(() => {
        const notice = document.getElementById('update-notice');
        const text = document.getElementById('update-notice-text');
        const pill = document.getElementById('btn-update-notice');
        const action = document.getElementById('update-notice-action');
        const rect = notice.getBoundingClientRect();
        const style = getComputedStyle(notice);
        return { visible: !notice.hidden && style.display !== 'none' && style.visibility !== 'hidden',
          text: text.textContent, pillVisible: !pill.hidden, actionVisible: !action.hidden,
          inBounds: rect.width > 0 && rect.height > 0 && rect.x >= 0 && rect.y >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
          bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
          viewport: { width: innerWidth, height: innerHeight, devicePixelRatio } };
      })()`)
      if (notice.visible && notice.inBounds && notice.text.includes(expectedVersion)) break
      await delay(100)
    }
    result.notice = notice
    assert.equal(notice.visible, true, 'The actual old shell update notice must be visible')
    assert.equal(notice.inBounds, true, 'The update notice must fit the actual shell viewport')
    assert.equal(notice.pillVisible, true)
    assert.equal(notice.actionVisible, true)
    assert.ok(notice.text.includes(expectedVersion), 'The visible notice must name the new version')
    const screenshot = await shell.call('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false })
    fs.writeFileSync(path.join(directory, 'update-notice.png'), Buffer.from(screenshot.data, 'base64'))
    result.screenshot = 'update-notice.png'
    const finalSettings = await shell.evaluate('window.aa.settingsGet().then(view => ({ autoUpdate: view?.settings?.autoUpdate }))')
    assert.equal(finalSettings.autoUpdate, false)
    result.status = 'passed'
    console.log(`PASS: real v${oldVersion} client found v${expectedVersion}; its update notice and action are visible.`)
  } catch (error) {
    result.status = 'failed'
    result.failure = error instanceof Error ? error.message : String(error)
    process.exitCode = 1
    console.error(`FAIL: ${result.failure}`)
  } finally {
    if (child && !exited) {
      try { await shell?.call('Browser.close', {}, 3000) } catch { /* The browser may close before acknowledging. */ }
      const deadline = Date.now() + 5000
      while (!exited && Date.now() < deadline) await delay(100)
      if (!exited) {
        const stopped = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { encoding: 'utf8', windowsHide: true, timeout: 10_000 })
        result.forcedOwnedProcessCleanup = stopped.status === 0
        if (stopped.status !== 0) { result.status = 'failed'; result.cleanupFailure = 'Owned application process tree could not be stopped'; process.exitCode = 1 }
      }
    }
    shell?.close()
    result.downloadPayloads = payloads(directory)
    if (result.downloadPayloads.length) { result.status = 'failed'; result.downloadFailure = 'Unexpected update payload appeared'; process.exitCode = 1 }
    if (hash(archive) !== preserved.archiveSha256 || hash(executable) !== preserved.executableSha256) {
      result.status = 'failed'; result.packageFailure = 'Preserved package changed during verification'; process.exitCode = 1
    }
    fs.writeFileSync(resultFile, `${JSON.stringify(result, null, 2)}\n`)
    console.log(`Evidence: ${resultFile}`)
  }
}

await run()
