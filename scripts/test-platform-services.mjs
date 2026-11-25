#!/usr/bin/env node
/** Production service regressions: proxy lifecycle, visual freshness and safe repair. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { compileFunction, runInNewContext } from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-platform-services-'))
const compiled = path.join(temporary, 'compiled')
const testProfile = 'p' + 'a'.repeat(24)
const secondProfile = 'p' + 'b'.repeat(24)

function load(name, dependencies = {}) {
  const filename = path.join(compiled, `${name}.js`)
  const module = { exports: {} }
  compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(
    (specifier) => {
      if (specifier.startsWith('node:')) return require(specifier)
      if (specifier === './atomic-json') return load('atomic-json')
      assert.ok(Object.hasOwn(dependencies, specifier), `Unexpected dependency: ${specifier}`)
      return dependencies[specifier]
    }, module, module.exports
  )
  return module.exports
}

let passed = 0
async function check(name, operation) {
  await operation()
  passed++
  console.log(`PASS: ${name}`)
}

try {
  const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc')
  const result = spawnSync(process.execPath, [tsc, '--ignoreConfig', '--noCheck', '--noResolve', '--outDir', compiled, '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--esModuleInterop', ...['network-environments', 'visual-operations', 'browser-diagnostics', 'atomic-json'].map((file) => path.join(root, 'src/main', `${file}.ts`))], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
  const { NetworkEnvironmentManager, buildProfilePac } = load('network-environments')
  const sessions = new Map()
  function sessionFor(id) {
    if (!sessions.has(id)) sessions.set(id, {
      calls: [],
      async setProxy(config) { this.calls.push(['proxy', config]); this.config = config },
      async closeAllConnections() { this.calls.push(['close']) },
      async clearAuthCache() { this.calls.push(['auth']) },
      async clearHostResolverCache() { this.calls.push(['dns']) },
      async resolveProxy() { return this.config?.proxyRules ?? 'DIRECT' },
      async fetch() { return new Response('{"ip":"203.0.113.21"}', { status: 200 }) }
    })
    return sessions.get(id)
  }
  const store = path.join(temporary, 'network.json')
  const manager = new NetworkEnvironmentManager({
    filePath: store, sessionFor,
    protect: (value) => Buffer.from(value).toString('base64'),
    unprotect: (value) => Buffer.from(value, 'base64').toString('utf8'),
    lookup: async () => [{ address: '203.0.113.1', family: 4 }]
  })
  await check('proxy applies real Session settings before reporting success and closes pooled connections', async () => {
    const config = await manager.set(testProfile, { mode: 'proxy', protocol: 'https', host: 'proxy.example.test', port: 8443, bypass: ['localhost'] })
    assert.equal(config.appliedAt > 0, true)
    assert.deepEqual(sessionFor(testProfile).calls.map((call) => call[0]), ['proxy', 'close', 'auth'])
    assert.equal(sessionFor(testProfile).config.proxyRules, 'https://proxy.example.test:8443')
    assert.equal(sessionFor(testProfile).config.proxyBypassRules, 'localhost')
    await manager.set(secondProfile, { mode: 'direct' })
    assert.equal(sessionFor(secondProfile).config.mode, 'direct')
    assert.equal(sessionFor(testProfile).config.mode, 'fixed_servers')
  })
  await check('proxy authentication is encrypted at rest and bound to exact Profile/endpoint challenge', async () => {
    await manager.set(testProfile, { username: 'fixture-user', password: 'fixture-password' })
    assert.doesNotMatch(fs.readFileSync(store, 'utf8'), /fixture-user|fixture-password/)
    assert.doesNotMatch(JSON.stringify(manager.get(testProfile)), /fixture-user|fixture-password|credential"/)
    assert.deepEqual(await manager.credentialsFor(testProfile, 'proxy.example.test', 8443), { username: 'fixture-user', password: 'fixture-password' })
    assert.equal(await manager.credentialsFor(testProfile, 'other.example.test', 8443), null)
    assert.equal(await manager.credentialsFor(secondProfile, 'proxy.example.test', 8443), null)
    assert.equal(await manager.credentialsFor(testProfile, 'proxy.example.test', 8443, false), null)
    await manager.set(testProfile, { enabled: false })
    assert.equal(sessionFor(testProfile).config.mode, 'direct')
    assert.equal(await manager.credentialsFor(testProfile, 'proxy.example.test', 8443), null)
    await manager.set(testProfile, { enabled: true })
  })
  await check('proxy input rejects injection, unauthenticated storage and unsupported SOCKS credentials', async () => {
    await assert.rejects(manager.set(testProfile, { host: 'user:pass@proxy.example.test' }), /INVALID_PROXY/)
    await assert.rejects(manager.set(testProfile, { port: 0 }), /INVALID_PROXY/)
    await assert.rejects(manager.set(testProfile, { protocol: 'socks5', username: 'user', password: 'pw' }), /PROXY_AUTH_UNSUPPORTED/)
    const unprotected = new NetworkEnvironmentManager({ filePath: path.join(temporary, 'no-protection.json'), sessionFor })
    await assert.rejects(unprotected.set('default', { mode: 'proxy', protocol: 'http', host: 'proxy.example.test', port: 80, username: 'user', password: 'pw' }), /SECURE_STORAGE_UNAVAILABLE/)
  })
  await check('website PAC uses validated host rules and never silently falls back to direct', () => {
    const pac = buildProfilePac({ protocol: 'http', host: 'proxy.example.test', port: 8080, bypass: ['localhost'], rules: [{ site: '*.work.test', protocol: 'socks5', host: 'work-proxy.test', port: 1080 }] })
    const sandbox = { dnsDomainIs: (host, suffix) => host.endsWith(suffix), isPlainHostName: (host) => !host.includes('.') }
    runInNewContext(pac, sandbox)
    assert.equal(sandbox.FindProxyForURL('https://a.work.test', 'a.work.test'), 'SOCKS5 work-proxy.test:1080')
    assert.equal(sandbox.FindProxyForURL('https://other.test', 'other.test'), 'PROXY proxy.example.test:8080')
    assert.equal(sandbox.FindProxyForURL('http://localhost', 'localhost'), 'DIRECT')
    assert.throws(() => buildProfilePac({ protocol: 'http', host: 'proxy.example.test', port: 8080, bypass: [], rules: [{ site: '";return DIRECT;', protocol: 'http', host: 'x.test', port: 80 }] }), /INVALID_PROXY/)
  })
  await check('proxy failures preserve saved settings and attempt Chromium rollback', async () => {
    const saved = fs.readFileSync(store, 'utf8')
    const ses = sessionFor(testProfile)
    const original = ses.setProxy
    let failOnce = true
    ses.setProxy = async function (config) {
      if (failOnce) { failOnce = false; throw new Error('fixture password=should-not-appear') }
      return original.call(this, config)
    }
    await assert.rejects(manager.set(testProfile, { host: 'broken.test' }), /PROXY_APPLY_FAILED/)
    assert.equal(fs.readFileSync(store, 'utf8'), saved)
    assert.equal(ses.config.proxyRules, 'https://proxy.example.test:8443')
    ses.setProxy = original
  })
  await check('network diagnostics use Profile fetch without login credentials and distinguish OS DNS', async () => {
    const ses = sessionFor(testProfile)
    let last
    ses.fetch = async (url, options) => { last = { url, options }; return new Response('{"ip":"203.0.113.21"}', { status: 200 }) }
    const test = await manager.test(testProfile)
    assert.equal(test.exitIp, '203.0.113.21')
    assert.equal(last.options.credentials, 'omit')
    assert.equal(last.options.redirect, 'error')
    const diagnostic = await manager.diagnose(testProfile, 'https://service.test/path?token=fixture-secret')
    assert.equal(diagnostic.dns.resolver, 'operating-system')
    assert.deepEqual(diagnostic.dns.addresses, ['203.0.113.1'])
    assert.doesNotMatch(JSON.stringify(diagnostic), /fixture-secret/)
  })
  await check('corrupt network stores remain fail closed and are not overwritten on subsequent access', async () => {
    const file = path.join(temporary, 'corrupt.json')
    fs.writeFileSync(file, '{corrupt')
    const broken = new NetworkEnvironmentManager({ filePath: file, sessionFor })
    assert.throws(() => broken.get('default'), /NETWORK_STORE_INVALID/)
    assert.throws(() => broken.get('default'), /NETWORK_STORE_INVALID/)
    await assert.rejects(broken.set('default', { mode: 'direct' }), /NETWORK_STORE_INVALID/)
    assert.equal(fs.readFileSync(file, 'utf8'), '{corrupt')
  })

  const actionDependencies = {
    throwIfAborted: (signal) => { if (signal?.aborted) throw new Error('aborted') },
    assertTabUsable: (tab) => { if (tab.view.webContents.isDestroyed()) throw new Error('destroyed') },
    withTabLock: async (_tab, _signal, operation) => operation(),
    doReload: async (tab) => { tab.reloads = (tab.reloads ?? 0) + 1 }
  }
  const { VisualOperationManager } = load('visual-operations', { electron: {}, './visual': {}, './actions': actionDependencies, './evidence': { getEvidenceManager: () => ({ record() {} }) } })
  function visualFixture() {
    const wc = new EventEmitter()
    let attached = false
    wc.isDestroyed = () => false
    wc.getZoomFactor = () => 1
    wc.getOSProcessId = () => 123
    wc.geometry = { url: 'https://canvas.test/work?token=fixture-secret', document: 1234, width: 100, height: 100, scrollX: 0, scrollY: 0, deviceScaleFactor: 1 }
    wc.executeJavaScript = async () => ({ ...wc.geometry })
    wc.commands = []
    wc.debugger = {
      isAttached: () => attached,
      attach: () => { attached = true },
      detach: () => { attached = false },
      sendCommand: async (method, args) => { wc.commands.push({ method, args }) }
    }
    const tab = { id: 'visual-tab', profileId: testProfile, title: 'Canvas', url: wc.geometry.url, loading: false, recovery: { status: 'healthy', attempts: 0 }, view: { webContents: wc }, keepRendering: () => () => {}, canUseWindowInput: () => false, net: { enabled: true, requests: () => [] }, consoleBuf: [] }
    let pixels = Buffer.from('fixture-image')
    let approve = async () => true
    const operations = []
    const manager = new VisualOperationManager({ directoryFor: (id) => path.join(temporary, id, 'visual'), approve: (...args) => approve(...args), capture: async () => ({ base64: pixels.toString('base64'), width: 100, height: 100 }), crop: () => Buffer.from('crop'), record: (entry) => operations.push(entry) })
    return { manager, tab, wc, operations, pixels: (value) => { pixels = Buffer.from(value) }, approve: (callback) => { approve = callback } }
  }
  await check('visual capture binds screenshot, CSS viewport, Profile and actual evidence file', async () => {
    const fixture = visualFixture()
    const capture = await fixture.manager.capture(fixture.tab)
    assert.equal(capture.profileId, testProfile)
    assert.deepEqual(capture.viewport, { width: 100, height: 100, deviceScaleFactor: 1, zoom: 1 })
    assert.equal(fs.readFileSync(capture.file, 'utf8'), 'fixture-image')
    assert.equal(capture.sha256.length, 64)
  })
  await check('coordinate clicks require fresh approval and consume the screenshot token', async () => {
    const fixture = visualFixture()
    const capture = await fixture.manager.capture(fixture.tab)
    let approvals = 0
    fixture.approve(async (request) => { approvals++; assert.doesNotMatch(request.url, /fixture-secret/); return true })
    const result = await fixture.manager.act(fixture.tab, { captureId: capture.captureId, action: 'click', x: 99.9, y: 20 })
    assert.equal(approvals, 1)
    assert.equal(result.operation.x, 99)
    assert.equal(result.verification.verificationRequired, true)
    assert.equal(fixture.operations.length, 1)
    assert.equal(fixture.wc.debugger.isAttached(), false, 'debugger attached here must be detached')
    assert.deepEqual(fixture.wc.commands.filter((entry) => entry.method === 'Input.dispatchMouseEvent').map((entry) => entry.args.type), ['mouseMoved', 'mousePressed', 'mouseReleased'])
    await assert.rejects(fixture.manager.act(fixture.tab, { captureId: capture.captureId, action: 'click', x: 1, y: 1 }), /STALE_VISUAL_CAPTURE/)
  })
  await check('stale screenshot pixels, geometry, navigation and cross-Profile targets never dispatch input', async () => {
    for (const mutate of [(fixture) => fixture.pixels('changed'), (fixture) => { fixture.wc.geometry.scrollY = 1 }, (fixture) => fixture.wc.emit('did-start-navigation'), (fixture) => { fixture.tab.profileId = secondProfile }]) {
      const fixture = visualFixture()
      const capture = await fixture.manager.capture(fixture.tab)
      mutate(fixture)
      await assert.rejects(fixture.manager.act(fixture.tab, { captureId: capture.captureId, action: 'click', x: 1, y: 1 }), /STALE_VISUAL_CAPTURE/)
      assert.equal(fixture.wc.commands.length, 0)
    }
  })
  await check('page changes while approval is pending invalidate coordinates; approval denial performs no input', async () => {
    const fixture = visualFixture()
    const capture = await fixture.manager.capture(fixture.tab)
    fixture.approve(async () => { fixture.pixels('changed-during-approval'); return true })
    await assert.rejects(fixture.manager.act(fixture.tab, { captureId: capture.captureId, action: 'drag', x: 1, y: 1, toX: 30, toY: 40 }), /STALE_VISUAL_CAPTURE/)
    assert.equal(fixture.wc.commands.length, 0)
    const denied = visualFixture()
    const deniedCapture = await denied.manager.capture(denied.tab)
    denied.approve(async () => false)
    await assert.rejects(denied.manager.act(denied.tab, { captureId: deniedCapture.captureId, action: 'click', x: 1, y: 1 }), /APPROVAL_DENIED/)
    assert.equal(denied.wc.commands.length, 0)
  })
  await check('invalid coordinates and crop bounds are rejected; cropped image cannot authorize input', async () => {
    const fixture = visualFixture()
    const capture = await fixture.manager.capture(fixture.tab)
    for (const x of [-1, 100, NaN, Infinity]) await assert.rejects(fixture.manager.act(fixture.tab, { captureId: capture.captureId, action: 'click', x, y: 1 }), /INVALID_COORDINATES/)
    await assert.rejects(fixture.manager.act(fixture.tab, { captureId: capture.captureId, action: 'crop', x: 90, y: 90, width: 20, height: 20 }), /INVALID_CROP/)
    const result = await fixture.manager.act(fixture.tab, { captureId: capture.captureId, action: 'crop', x: 1, y: 1, width: 20, height: 20 })
    assert.equal(fs.readFileSync(result.after.file, 'utf8'), 'crop')
    await assert.rejects(fixture.manager.act(fixture.tab, { captureId: result.after.captureId, action: 'click', x: 1, y: 1 }), /STALE_VISUAL_CAPTURE/)
  })
  await check('stopping one Profile invalidates only its visual tokens', async () => {
    const fixture = visualFixture()
    const other = visualFixture()
    other.tab.profileId = secondProfile
    other.tab.id = 'second-visual-tab'
    const first = await fixture.manager.capture(fixture.tab)
    const second = await fixture.manager.capture(other.tab)
    fixture.manager.clearProfile(testProfile)
    await assert.rejects(fixture.manager.act(fixture.tab, { captureId: first.captureId, action: 'click', x: 1, y: 1 }), /STALE_VISUAL_CAPTURE/)
    await fixture.manager.act(other.tab, { captureId: second.captureId, action: 'click', x: 1, y: 1 })
    assert.equal(other.wc.commands.filter((command) => command.method === 'Input.dispatchMouseEvent').length, 3)
  })
  await check('revoking a visual token during approval prevents coordinate dispatch', async () => {
    const fixture = visualFixture()
    const capture = await fixture.manager.capture(fixture.tab)
    fixture.approve(async () => { fixture.manager.clearProfile(testProfile); return true })
    await assert.rejects(fixture.manager.act(fixture.tab, { captureId: capture.captureId, action: 'click', x: 1, y: 1 }), /STALE_VISUAL_CAPTURE/)
    assert.equal(fixture.wc.commands.length, 0)
  })

  const { collectBrowserDiagnostics, repairBrowser } = load('browser-diagnostics', { './actions': actionDependencies })
  await check('diagnostics report real Profile-scoped state with bounded redacted errors and runtime metrics', () => {
    const first = visualFixture().tab
    first.consoleBuf = [{ level: 'error', ts: 1, text: 'password=fixture-secret https://test.test/path?token=fixture-token' }]
    first.net.requests = () => [{ url: 'https://failed.test?token=fixture-token', status: 500, error: 'Bearer fixture-secret' }]
    const second = visualFixture().tab
    second.profileId = secondProfile
    const report = collectBrowserDiagnostics({ app: { getVersion: () => '0.18.0', getAppMetrics: () => [{ pid: 123, type: 'Renderer', cpu: { percentCPUUsage: 2 }, memory: { workingSetSize: 4000 } }] }, tabs: () => [first, second], profiles: () => [{ id: testProfile, name: 'Work', running: true }, { id: secondProfile, name: 'Personal', running: true }], downloads: () => [{ state: 'interrupted', profileId: testProfile }] }, testProfile)
    assert.equal(report.tabs.length, 1)
    assert.equal(report.profiles.length, 1)
    assert.equal(report.resources.memoryWorkingSetKiB, 4000)
    assert.equal(report.downloads.failed, 1)
    assert.doesNotMatch(JSON.stringify(report), /fixture-secret|fixture-token/)
  })
  await check('repairs require approval, reject cross-Profile tabs and never clear Cookie or Storage', async () => {
    const tab = visualFixture().tab
    const calls = []
    const deps = { getTab: () => tab, sessionFor: () => ({ clearCache: async () => calls.push('cache'), clearHostResolverCache: async () => calls.push('dns'), closeAllConnections: async () => calls.push('connections'), clearStorageData: () => { throw new Error('storage must never be cleared') } }), approve: async () => false }
    await assert.rejects(repairBrowser(deps, { action: 'clear-cache', profileId: testProfile }), /APPROVAL_DENIED/)
    assert.deepEqual(calls, [])
    deps.approve = async () => true
    await repairBrowser(deps, { action: 'clear-cache', profileId: testProfile })
    assert.deepEqual(calls, ['cache'])
    await repairBrowser(deps, { action: 'reconnect', profileId: testProfile })
    assert.deepEqual(calls, ['cache', 'dns', 'connections'])
    await assert.rejects(repairBrowser(deps, { action: 'reload', profileId: secondProfile, tabId: tab.id }), /PROFILE_ACCESS_DENIED/)
    await repairBrowser(deps, { action: 'reload', profileId: testProfile, tabId: tab.id })
    assert.equal(tab.reloads, 1)
  })
  console.log(`PASS: ${passed} platform service regression groups`)
} finally {
  fs.rmSync(temporary, { recursive: true, force: true })
}
