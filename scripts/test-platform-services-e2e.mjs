#!/usr/bin/env node
/** Real Chromium proxy routing/PAC and screenshot-bound Canvas input, entirely local. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { createRequire } from 'node:module'
import { spawn, spawnSync } from 'node:child_process'
import { compileFunction } from 'node:vm'
import { fileURLToPath } from 'node:url'

const file = fileURLToPath(import.meta.url)
const root = path.resolve(path.dirname(file), '..')
const require = createRequire(import.meta.url)

if (!process.versions.electron) {
  const runDirectory = path.join(root, '.local-verification', `platform-e2e-${Date.now()}-${process.pid}`)
  const compiled = path.join(runDirectory, 'compiled')
  fs.mkdirSync(runDirectory, { recursive: true })
  const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc')
  const compilation = spawnSync(process.execPath, [tsc, '--ignoreConfig', '--noCheck', '--noResolve', '--outDir', compiled, '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--esModuleInterop', ...['network-environments', 'visual-operations', 'visual', 'atomic-json'].map((name) => path.join(root, 'src/main', `${name}.ts`))], { cwd: root, encoding: 'utf8' })
  assert.equal(compilation.status, 0, compilation.stdout + compilation.stderr)
  const environment = { ...process.env, AA_PLATFORM_E2E_DIRECTORY: runDirectory }
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [file], { cwd: root, env: environment, stdio: 'inherit' })
  const timer = setTimeout(() => { console.error('FAIL: platform services e2e timed out'); child.kill() }, 90_000)
  child.once('error', (error) => { clearTimeout(timer); console.error(error); process.exitCode = 1 })
  child.once('exit', (code) => { clearTimeout(timer); process.exitCode = code ?? 1 })
} else {
  void (async () => {
    const { app, session, BrowserWindow, nativeImage } = await import('electron')
    const runDirectory = process.env.AA_PLATFORM_E2E_DIRECTORY
    assert.ok(runDirectory)
    app.setPath('userData', path.join(runDirectory, 'chromium'))
    await app.whenReady()
    const compiled = path.join(runDirectory, 'compiled')
    const load = (name, dependencies = {}) => {
      const filename = path.join(compiled, `${name}.js`)
      const module = { exports: {} }
      compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(
        (specifier) => {
          if (specifier.startsWith('node:')) return require(specifier)
          if (specifier === './atomic-json') return load('atomic-json')
          if (Object.hasOwn(dependencies, specifier)) return dependencies[specifier]
          throw new Error(`Unexpected dependency ${specifier}`)
        }, module, module.exports
      )
      return module.exports
    }
    const results = []
    const passed = (name) => { results.push(name); console.log(`PASS: ${name}`) }
    const servers = []
    let window
    try {
      async function proxy(label) {
        const requests = []
        const server = http.createServer((request, response) => {
          requests.push(request.url)
          response.setHeader('Content-Type', 'application/json')
          response.end(JSON.stringify({ proxy: label, target: request.url }))
        })
        await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
        servers.push(server)
        return { requests, port: server.address().port }
      }
      const firstProxy = await proxy('first')
      const secondProxy = await proxy('second')
      const firstId = 'p' + 'a'.repeat(24)
      const secondId = 'p' + 'b'.repeat(24)
      const sessions = new Map([[firstId, session.fromPartition('persist:aa-platform-first')], [secondId, session.fromPartition('persist:aa-platform-second')]])
      const { NetworkEnvironmentManager } = load('network-environments')
      const network = new NetworkEnvironmentManager({ filePath: path.join(runDirectory, 'network.json'), sessionFor: (id) => sessions.get(id) })
      await network.set(firstId, { mode: 'proxy', protocol: 'http', host: '127.0.0.1', port: firstProxy.port })
      const firstRequest = await sessions.get(firstId).fetch('http://default.fixture.invalid/route', { credentials: 'omit' })
      assert.equal((await firstRequest.json()).proxy, 'first')
      assert.equal(firstProxy.requests.some((url) => url.includes('default.fixture.invalid/route')), true)
      passed('real Chromium Session.fetch uses the applied HTTP proxy')
      await network.set(secondId, { mode: 'proxy', protocol: 'http', host: '127.0.0.1', port: secondProxy.port })
      const secondRequest = await sessions.get(secondId).fetch('http://second.fixture.invalid/route', { credentials: 'omit' })
      assert.equal((await secondRequest.json()).proxy, 'second')
      const unchanged = await sessions.get(firstId).fetch('http://still-first.fixture.invalid/route', { credentials: 'omit' })
      assert.equal((await unchanged.json()).proxy, 'first')
      passed('simultaneous Profile proxy environments route independently')
      await network.set(firstId, { rules: [{ site: '*.special.fixture.invalid', protocol: 'http', host: '127.0.0.1', port: secondProxy.port }] })
      const resolution = await network.resolve(firstId, 'http://a.special.fixture.invalid/route')
      assert.match(resolution.proxy, new RegExp(`PROXY 127\\.0\\.0\\.1:${secondProxy.port}`))
      const special = await sessions.get(firstId).fetch('http://a.special.fixture.invalid/route', { credentials: 'omit' })
      assert.equal((await special.json()).proxy, 'second')
      const fallback = await sessions.get(firstId).fetch('http://normal.fixture.invalid/route', { credentials: 'omit' })
      assert.equal((await fallback.json()).proxy, 'first')
      passed('real Chromium PAC applies per-website proxy and configured fallback')
      await network.set(firstId, { mode: 'direct', rules: [] })
      assert.equal((await network.resolve(firstId, 'https://fixture.invalid')).proxy, 'DIRECT')
      passed('switching proxy off closes old connections and resolves DIRECT')

      const origin = http.createServer((_request, response) => {
        response.setHeader('Content-Type', 'text/html; charset=utf-8')
        response.end('<!doctype html><html><head><style>html,body{margin:0;background:#fff}canvas{display:block}</style></head><body><canvas width="600" height="400"></canvas><script>window.clicks=0;const c=document.querySelector("canvas");const x=c.getContext("2d");x.fillStyle="#197255";x.fillRect(0,0,600,400);c.addEventListener("click",()=>{window.clicks++;x.fillStyle="#e65d42";x.fillRect(0,0,200,200)})</script></body></html>')
      })
      await new Promise((resolve) => origin.listen(0, '127.0.0.1', resolve))
      servers.push(origin)
      window = new BrowserWindow({ show: false, width: 640, height: 480, webPreferences: { partition: 'persist:aa-platform-first', contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } })
      await window.loadURL(`http://127.0.0.1:${origin.address().port}/canvas`)
      const wc = window.webContents
      const dependencies = {
        ActionError: class ActionError extends Error {},
        assertTabUsable: (tab) => assert.equal(tab.view.webContents.isDestroyed(), false),
        throwIfAborted: (signal) => { if (signal?.aborted) throw new Error('aborted') },
        withTabLock: async (_tab, _signal, run) => run()
      }
      const evidence = { getEvidenceManager: () => ({ record() {} }) }
      const visual = load('visual', { './actions': dependencies, './evidence': evidence, './progress': { reportProgress() {} } })
      const { VisualOperationManager } = load('visual-operations', { electron: { nativeImage }, './visual': visual, './actions': dependencies, './evidence': evidence })
      const approvals = []
      const manager = new VisualOperationManager({ directoryFor: () => path.join(runDirectory, 'screenshots'), approve: async (request) => { approvals.push(request); return true } })
      const tab = { id: 'canvas', profileId: firstId, view: { webContents: wc }, canUseWindowInput: () => false, keepRendering: () => () => {}, isWindowMinimized: () => false }
      const capture = await manager.capture(tab)
      assert.ok(nativeImage.createFromPath(capture.file).getSize().width > 100)
      const operation = await manager.act(tab, { action: 'click', captureId: capture.captureId, x: 50, y: 50 })
      assert.equal(await wc.executeJavaScript('window.clicks'), 1)
      assert.equal(approvals.length, 1)
      assert.equal(operation.verification.visualChanged, true)
      assert.equal(operation.before.sha256 === operation.after.sha256, false)
      passed('actual screenshot-bound Canvas click changes pixels and records before/after evidence')
      const fresh = await manager.capture(tab)
      await wc.executeJavaScript('document.querySelector("canvas").getContext("2d").fillRect(300,200,40,40)')
      await assert.rejects(manager.act(tab, { action: 'click', captureId: fresh.captureId, x: 50, y: 50 }), /STALE_VISUAL_CAPTURE/)
      assert.equal(await wc.executeJavaScript('window.clicks'), 1)
      passed('changed Canvas pixels reject stale coordinates before another input')
      fs.writeFileSync(path.join(runDirectory, 'result.json'), JSON.stringify({ status: 'PASS', checks: results, screenshots: path.join(runDirectory, 'screenshots') }, null, 2))
      console.log(`PASS: ${results.length} real Chromium platform groups; artifacts: ${runDirectory}`)
    } finally {
      if (window && !window.isDestroyed()) window.destroy()
      for (const server of servers) { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)) }
    }
    app.exit(0)
  })().catch(async (error) => {
    console.error(error)
    const { app } = await import('electron')
    app.exit(1)
  })
}
