#!/usr/bin/env node
/**
 * End-to-end extension verification against the real app process (isolated profile, no external network).
 *
 * Scenario 1: load a fixture unpacked extension into the running app session via the production
 *             ExtensionManager path used by MCP (session.extensions.loadExtension), verify the
 *             extension is visible in the session and its content script runs on a page.
 * Scenario 2: restart with the same profile and verify the persisted extension is auto-restored.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { WebSocket } from 'ws'

const file = fileURLToPath(import.meta.url)
const root = path.resolve(path.dirname(file), '..')
const require = createRequire(import.meta.url)
const phase = process.argv[2] ?? ''

if (!process.versions.electron) {
  // Parent: prepare fixture + profile, run phase 1, then relaunch for phase 2.
  const runDir = path.join(root, '.local-verification', `extensions-e2e-${Date.now()}-${process.pid}`)
  fs.mkdirSync(path.join(runDir, 'profile'), { recursive: true })

  // Fixture unpacked extension: MV3, injects a marker element into every page.
  const extDir = path.join(runDir, 'fixture-extension')
  fs.mkdirSync(extDir, { recursive: true })
  fs.writeFileSync(path.join(extDir, 'manifest.json'), JSON.stringify({
    name: 'AA Fixture Extension',
    version: '1.0.0',
    manifest_version: 3,
    content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'], run_at: 'document_start' }]
  }))
  fs.writeFileSync(path.join(extDir, 'content.js'), `(() => { const el = document.createElement('div'); el.id = 'aa-fixture-extension-marker'; el.textContent = 'aa-fixture-ok'; document.documentElement.appendChild(el); })()`)

  const env = {
    ...process.env,
    AA_EXTENSIONS_E2E_DIR: runDir,
    AA_EXTENSIONS_E2E_EXT: extDir,
    AA_BROWSER_USER_DATA_DIR: path.join(runDir, 'profile'),
    AA_BROWSER_CONNECTION_FILE: path.join(runDir, 'connection.json'),
    AA_BROWSER_SETTINGS_FILE: path.join(runDir, 'settings.json'),
    AA_BROWSER_SESSION_FILE: path.join(runDir, 'session.json'),
    AA_BROWSER_HISTORY_DIR: path.join(runDir, 'history'),
    AA_BROWSER_DOWNLOAD_DIR: path.join(runDir, 'downloads'),
    AA_BROWSER_EXTENSIONS_FILE: path.join(runDir, 'extensions.json'),
    AA_BROWSER_EVIDENCE_FILE: path.join(runDir, 'evidence.json')
  }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL

  console.log(`Extensions e2e artifacts: ${runDir}`)
  const child = spawn(require('electron'), [file, '1'], { cwd: root, env, stdio: 'inherit' })
  const code = await new Promise((resolve) => child.once('exit', resolve))
  if (code !== 0) {
    console.error('FAIL: phase 1 (load) exited non-zero')
    process.exit(1)
  }
  assert.ok(fs.existsSync(path.join(runDir, 'extensions.json')), 'phase 1 must persist the extension registry')

  // Phase 2: same profile, fresh process → restore path.
  const child2 = spawn(require('electron'), [file, '2'], { cwd: root, env, stdio: 'inherit' })
  const code2 = await new Promise((resolve) => child2.once('exit', resolve))
  process.exit(code2 === 0 ? 0 : 1)
}

// Electron phases.
void (async () => {
  const { app, session, webContents } = await import('electron')
  const mainEntry = path.join(root, 'out', 'main', 'index.js')
  const runDir = process.env.AA_EXTENSIONS_E2E_DIR
  const extDir = process.env.AA_EXTENSIONS_E2E_EXT
  assert.ok(runDir && extDir, 'e2e environment must provide a run directory and extension directory')
  const fail = (message) => {
    console.error(`FAIL: ${message}`)
    app.exit(1)
  }

  // Both phases boot the real main process. Phase 1 exercises the MCP and IPC
  // handlers; phase 2 relies on that same process's startup restore path.
  app.setAppPath(root)
  await import(pathToFileURL(mainEntry).href)
  await app.whenReady()
  const ses = session.fromPartition('persist:aa-main')
  const api = ses.extensions
  /** Local loopback HTTP server: <all_urls> content scripts match http://127.0.0.1 deterministically. */
  async function serveOnce(body) {
    const http = await import('node:http')
    return new Promise((resolve) => {
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html' })
        res.end(body)
        setTimeout(() => server.close(), 1500)
      })
      server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
    })
  }

  async function assertMarker(label) {
    const { server, port } = await serveOnce('<!doctype html><html><body><div id=verify-host>ok</div></body></html>')
    const win = new (await import('electron')).BrowserWindow({
      show: false,
      webPreferences: { partition: 'persist:aa-main' }
    })
    try {
      await win.loadURL(`http://127.0.0.1:${port}/`)
      for (let i = 0; i < 50; i++) {
        await delay(100)
        const marker = await win.webContents.executeJavaScript(`document.getElementById('aa-fixture-extension-marker')?.textContent ?? ''`)
        if (marker === 'aa-fixture-ok') return
      }
      throw new Error(`${label}: extension content script did not inject into a real page of the shared session`)
    } finally {
      win.destroy()
      server.close()
    }
  }

  async function shellRenderer() {
    for (let i = 0; i < 100; i++) {
      const shell = webContents.getAllWebContents().find((wc) => /[\\/]renderer[\\/]index\.html$/.test(wc.getURL()))
      if (shell) {
        const ready = await shell.executeJavaScript('!!window.aa && !!window.aa.extensionLoad', true).catch(() => false)
        if (ready) return shell
      }
      await delay(100)
    }
    throw new Error('production shell renderer did not become ready')
  }

  if (phase === '1') {
    try {
      const shell = await shellRenderer()
      const connection = JSON.parse(fs.readFileSync(process.env.AA_BROWSER_CONNECTION_FILE, 'utf8'))
      const ws = new WebSocket(`ws://127.0.0.1:${connection.port}/?token=${connection.token}`)
      await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
      const mcpLoad = await new Promise((resolve, reject) => {
        const id = 1
        const timer = setTimeout(() => { ws.close(); reject(new Error('MCP extension load timed out')) }, 30_000)
        const onMessage = (raw) => {
          const message = JSON.parse(String(raw))
          if (message.event === 'progress' || message.id !== id) return
          clearTimeout(timer)
          ws.off('message', onMessage)
          if (message.ok) resolve(message.result)
          else reject(new Error(message.error))
        }
        ws.on('message', onMessage)
        ws.send(JSON.stringify({ id, tool: 'browser_extensions', args: { action: 'load', path: extDir } }))
      })
      const mcpText = (mcpLoad?.content ?? []).map((item) => item?.text ?? '').join('\n')
      assert.match(mcpText, /AA Fixture Extension/, 'MCP extension load should report the loaded extension')
      const result = await shell.executeJavaScript(`window.aa.extensionLoad(${JSON.stringify(extDir)})`, true)
      assert.equal(result?.ok, true, `production extension IPC failed: ${result?.error ?? 'unknown error'}`)
      const loaded = result.extension
      const list = api.getAllExtensions()
      assert.ok(list.some((e) => e.id === loaded.id), 'loaded extension must appear in getAllExtensions()')
      assert.equal(list.find((e) => e.id === loaded.id).name, 'AA Fixture Extension')
      assert.deepEqual(JSON.parse(fs.readFileSync(path.join(runDir, 'extensions.json'), 'utf8')), [path.resolve(extDir)], 'manager load must persist the extension registry')
      await assertMarker('phase 1')
      ws.close()
      console.log(`PASS: phase 1 — MCP/UI ExtensionManager loaded (${loaded.id}), persisted the registry and injected content script`)
      app.exit(0)
    } catch (error) {
      fail(`phase 1: ${error.message}`)
    }
  } else if (phase === '2') {
    try {
      // The app's own startup restore should have already replayed extensions.json.
      // Wait briefly for the async restore to complete, then check.
      let restored = false
      for (let i = 0; i < 100 && !restored; i++) {
        await delay(100)
        restored = api.getAllExtensions().length > 0
      }
      const list = api.getAllExtensions()
      assert.equal(list.length, 1, `expected the persisted extension to be auto-restored, got ${list.length}`)
      assert.equal(list[0].name, 'AA Fixture Extension')
      await assertMarker('phase 2')
      console.log('PASS: phase 2 — persisted extension auto-restored on restart and content script injects again')
      app.exit(0)
    } catch (error) {
      fail(`phase 2: ${error.message}`)
    }
  } else {
    fail(`unknown phase: ${phase}`)
  }
})()
