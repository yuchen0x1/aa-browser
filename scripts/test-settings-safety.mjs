/** Settings/IME regression: real compiled renderer + preload, mocked IPC, isolated profile, no external network. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const file = fileURLToPath(import.meta.url)
const root = path.resolve(path.dirname(file), '..')
const page = path.join(root, 'out/renderer/index.html')
const preload = path.join(root, 'out/preload/index.js')
const profileVariable = 'AA_SETTINGS_SAFETY_PROFILE'

if (!process.versions.electron) {
  assert.ok(fs.existsSync(page) && fs.existsSync(preload), 'Build the renderer/preload before running this regression')
  const artifacts = path.join(root, '.local-verification')
  fs.mkdirSync(artifacts, { recursive: true })
  const directory = fs.mkdtempSync(path.join(artifacts, 'settings-safety-'))
  const env = { ...process.env, [profileVariable]: directory }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.ELECTRON_RENDERER_URL
  console.log(`Settings safety artifacts: ${directory}`)
  const electron = createRequire(import.meta.url)('electron')
  const result = spawnSync(electron, [file], { cwd: root, env, stdio: 'inherit', timeout: 120_000 })
  if (result.error) throw result.error
  assert.equal(result.status, 0, `Electron regression exited (${result.signal ?? 'no signal'})`)
  const report = JSON.parse(fs.readFileSync(path.join(directory, 'result.json'), 'utf8'))
  assert.equal(report.status, 'PASS', 'Electron must write a successful report, not merely exit')
  assert.ok(report.checks.length >= 27, 'Expected settings, IME, stale client setup and canonical appearance assertions to execute')
} else {
  void testRenderer()
}

async function testRenderer() {
  const { app, BrowserWindow, ipcMain, session } = createRequire(import.meta.url)('electron')
  const directory = process.env[profileVariable]
  let win
  const pending = new Set()
  const report = {
    status: 'RUNNING',
    fixture: 'Compiled renderer and production preload; in-memory IPC only; no real main, client configuration, clipboard or external requests.',
    imeBoundary: 'Composition/key events exercise real renderer handlers; this is not a physical Windows IME acceptance test.',
    checks: [], errors: [], blockedRequests: []
  }
  let stage = 'profile setup'
  try {
    assert.ok(directory, 'Launch through Node to create a disposable profile')
    const profile = path.join(directory, 'profile')
    fs.mkdirSync(profile, { recursive: true })
    app.setPath('userData', profile)
    app.setPath('sessionData', profile)
    stage = 'Electron startup'
    await app.whenReady()
    session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
      const allowed = /^(file:|data:|about:)/.test(details.url)
      if (!allowed) report.blockedRequests.push(details.url)
      callback({ cancel: !allowed })
    })
    const initial = {
      searchEngine: 'https://search.fixture.test/?q=', locale: 'en-US', theme: 'dark',
      fullSnapshot: true, requireOperationApproval: true, isolatedSessions: true,
      restoreSession: true, backgroundMode: 'background', autoUpdate: false, updateChannel: 'beta',
      downloadDir: 'X:/fixture-downloads', allowedSites: ['https://allowed.fixture.test']
    }
    let settings = structuredClone(initial)
    const presets = [
      { label: 'Fixture search', url: initial.searchEngine },
      { label: '必应 (Bing)', url: 'https://www.bing.com/search?q=' }
    ]
    const view = (overrides = {}) => ({ settings: { ...structuredClone(settings), ...overrides }, presets })
    const state = {
      tabs: [{ id: 'fixture', title: 'Settings safety fixture', url: 'about:blank', active: true, canBack: false, canForward: false, loading: false }],
      activeId: 'fixture', agentCount: 0, agentVerifiedCount: 0, bridgeState: 'waiting',
      pendingApprovals: [], agentInterrupted: false, agentActivity: { active: false, paused: false },
      canReopenClosed: false, find: { open: false, query: '', matches: 0, activeMatch: 0 },
      update: { status: 'disabled', currentVersion: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, noticeVisible: false },
      windowHeight: 800, downloads: [], recentActions: []
    }
    const calls = []
    const queues = new Map()
    let detectedClients = []
    const count = (channel) => calls.filter((call) => call.channel === channel).length
    function hold(channel, { commit = false } = {}) {
      let resolve, reject
      const promise = new Promise((yes, no) => { resolve = yes; reject = no })
      // Install rejection handling immediately, even before the renderer invokes this channel.
      promise.catch(() => {})
      const gate = {
        entered: false, promise, commit, committed: undefined,
        resolve(value = gate.committed) { pending.delete(gate); resolve(value) },
        reject(message = 'Fixture IPC rejection') { pending.delete(gate); reject(new Error(message)) }
      }
      const queue = queues.get(channel) ?? []
      queue.push(gate)
      queues.set(channel, queue)
      pending.add(gate)
      return gate
    }
    const handlers = {
      'aa:get-state': () => state,
      'aa:platform-state': () => ({ profiles: [], defaultProfileId: 'default', activeProfileId: 'default', workflows: [], templates: [], network: {}, permissions: { grants: [], audit: [] }, diagnostics: {} }),
      'aa:platform-action': () => ({ ok: false, error: 'Platform actions are outside this settings race fixture' }),
      'aa:settings-open': () => undefined,
      'aa:settings-get': () => view(),
      'aa:settings-set': (patch) => { settings = { ...settings, ...patch }; return structuredClone(settings) },
      'aa:agent-info': () => null,
      'aa:clients-detect': () => structuredClone(detectedClients),
      'aa:clients-setup': () => [],
      'aa:extension-pick': () => '',
      'aa:extension-list': () => [],
      'aa:extension-load': () => ({ ok: false, error: 'fixture does not load extensions' }),
      'aa:extension-remove': () => ({ ok: false, error: 'fixture does not remove extensions' }),
      'aa:history-suggest': () => [
        { url: 'https://suggest.fixture.test/one', title: 'Fixture one', lastVisit: 1, count: 1 },
        { url: 'https://suggest.fixture.test/two', title: 'Fixture two', lastVisit: 2, count: 1 }
      ],
      'aa:find-open': () => { state.find.open = true; win.webContents.send('aa:state', state) },
      'aa:find-close': () => { state.find.open = false; win.webContents.send('aa:state', state) },
      'aa:find': () => undefined,
      'aa:omnibox-submit': () => undefined,
      'aa:overlay-height': () => undefined,
      'aa:tab-new': () => undefined,
      'aa:tab-select': () => undefined
    }
    for (const [channel, handler] of Object.entries(handlers)) {
      ipcMain.handle(channel, async (_event, ...args) => {
        calls.push({ channel, args })
        const gate = queues.get(channel)?.shift()
        if (gate) {
          if (gate.commit) gate.committed = handler(...args)
          gate.entered = true
          return await gate.promise
        }
        return handler(...args)
      })
    }
    const boot = hold('aa:settings-get')
    stage = 'create renderer window'
    win = new BrowserWindow({
      width: 1200, height: 800, show: true,
      webPreferences: { preload, contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false }
    })
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.webContents.on('console-message', (event) => {
      if (event.level === 'error') report.errors.push(event.message)
    })
    win.webContents.on('render-process-gone', (_event, details) => report.errors.push(`Renderer gone: ${details.reason}`))
    const run = (fn, ...args) => win.webContents.executeJavaScript(`(${fn})(${args.map((arg) => JSON.stringify(arg)).join(',')})`, true)
    async function until(fn, label) {
      const end = Date.now() + 8_000
      while (Date.now() < end) { if (await fn()) return; await delay(20) }
      throw new Error(`Timed out: ${label}`)
    }
    const flush = () => run(() => new Promise((resolve) => setTimeout(resolve, 40)))
    function record(name) { report.checks.push(name); console.log(`PASS: ${name}`) }
    async function captureEvidence(name) {
      await delay(400)
      const image = await win.webContents.capturePage()
      assert.ok(!image.isEmpty(), `${name}: compositor returned an empty screenshot`)
      fs.writeFileSync(path.join(directory, name), image.toPNG())
    }
    async function click(selector) {
      const point = await run((value) => {
        const element = document.querySelector(value)
        if (!element) throw new Error(`Missing click target: ${value}`)
        element.scrollIntoView({ block: 'nearest' })
        const rect = element.getBoundingClientRect()
        return { x: Math.round(rect.x + rect.width / 2), y: Math.round(rect.y + rect.height / 2) }
      }, selector)
      win.focus()
      win.webContents.focus()
      for (const type of ['mouseMove', 'mouseDown', 'mouseUp']) {
        win.webContents.sendInputEvent({ type, ...point, ...(type === 'mouseMove' ? {} : { button: 'left', clickCount: 1 }) })
      }
      await flush()
    }
    function key(keyCode, modifiers = []) {
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    }
    const snapshot = () => run(() => ({
      hidden: document.querySelector('#settings-modal').hidden,
      locked: document.querySelector('#settings-body').inert,
      busy: document.querySelector('#settings-body').getAttribute('aria-busy'),
      disabled: document.querySelector('#btn-save-settings').disabled,
      controlsDisabled: [...document.querySelectorAll('#settings-body input:not([data-id]), #settings-body select, #settings-body textarea')].every((element) => element.disabled),
      status: document.querySelector('#settings-status').textContent,
      statusState: document.querySelector('#settings-status').dataset.state ?? '',
      locale: document.documentElement.lang, theme: document.documentElement.dataset.theme,
      engine: document.querySelector('#set-engine-url').value,
      downloadDir: document.querySelector('#set-download-dir').value,
      approval: document.querySelector('#set-op-approval').checked,
      isolated: document.querySelector('#set-isolated-sessions').checked,
      restore: document.querySelector('#set-restore-session').checked,
      backgroundMode: document.querySelector('#set-background-mode').value,
      allowedSites: document.querySelector('#set-allowed-sites').value,
      clientText: document.querySelector('#set-client-list').textContent,
      clientResult: document.querySelector('#set-client-result').textContent,
      clientBusy: document.querySelector('#btn-client-setup').getAttribute('aria-busy'),
      clientDisabled: document.querySelector('#btn-client-setup').disabled,
      clientSelection: [...document.querySelectorAll('#set-client-list input:checked')].map((input) => input.dataset.id)
    }))
    const waitReady = () => until(async () => {
      const ui = await snapshot()
      return !ui.hidden && !ui.disabled && !ui.locked && ui.busy === 'false'
    }, 'settings ready')
    async function close() {
      await click('#btn-close-settings')
      assert.equal((await snapshot()).hidden, true)
    }
    async function open() { await click('#btn-settings'); await waitReady() }
    async function assertLocked(label) {
      const ui = await snapshot()
      assert.equal(ui.hidden, false, label)
      assert.equal(ui.disabled, true, label)
      assert.equal(ui.locked, true, label)
      assert.equal(ui.busy, 'true', label)
      assert.equal(ui.controlsDisabled, true, label)
      const before = count('aa:settings-set')
      await click('#btn-save-settings')
      // Programmatic dispatch deliberately bypasses native disabled-click suppression.
      await run(() => {
        const button = document.querySelector('#btn-save-settings')
        button.disabled = false
        button.dispatchEvent(new MouseEvent('click', { bubbles: true }))
        button.disabled = true
      })
      await flush()
      assert.equal(count('aa:settings-set'), before, `${label}: no premature IPC patch`)
    }
    async function preview(locale, theme) {
      await run((language, color) => {
        for (const [selector, value] of [['#set-locale', language], ['#set-theme', color]]) {
          const element = document.querySelector(selector)
          element.value = value
          element.dispatchEvent(new Event('change', { bubbles: true }))
        }
      }, locale, theme)
    }
    stage = 'load compiled renderer'
    await win.loadFile(page)
    await until(() => boot.entered, 'startup settings request')
    await run(() => {
      window.__settingsSafetyErrors = []
      window.addEventListener('unhandledrejection', (event) => window.__settingsSafetyErrors.push(String(event.reason)))
      window.addEventListener('error', (event) => window.__settingsSafetyErrors.push(event.message))
    })

    const opened = hold('aa:settings-open')
    const loaded = hold('aa:settings-get')
    const agent = hold('aa:agent-info')
    await click('#btn-settings')
    await until(() => opened.entered, 'held settings-open')
    await assertLocked('settings-open pending')
    const openCount = count('aa:settings-open')
    await run(() => { document.querySelector('#btn-settings').click(); document.querySelector('#btn-update-notice').click() })
    await flush()
    assert.equal(count('aa:settings-open'), openCount, 'Duplicate open does not start a second session')
    opened.resolve()
    await until(() => loaded.entered, 'held settings-get')
    await assertLocked('settings-get pending')
    loaded.resolve(view())
    await until(() => agent.entered, 'held agent-info')
    await assertLocked('agent-info pending')
    stage = 'capture settings loading screen'
    await captureEvidence('settings-loading.png')
    agent.resolve(null)
    await waitReady()
    const populated = await snapshot()
    assert.equal(populated.engine, initial.searchEngine)
    assert.equal(populated.approval, true)
    assert.equal(populated.isolated, true)
    assert.equal(populated.restore, true)
    assert.equal(populated.backgroundMode, 'background')
    assert.equal(populated.allowedSites, initial.allowedSites.join('\n'))
    stage = 'capture settings ready screen'
    await captureEvidence('settings-ready.png')
    record('Immediate lock across settings-open/settings-get/agent-info; forced and native early saves blocked')
    record('Duplicate opening while loading starts only one IPC lifecycle')

    await preview('zh-CN', 'light')
    const beforeBoot = await snapshot()
    boot.resolve(view({ locale: 'en-US', theme: 'dark' }))
    await flush()
    assert.deepEqual(await snapshot(), beforeBoot, 'Late startup settings cannot overwrite an active preview')
    await run(() => { document.querySelector('#set-download-dir').value = 'X:/unsaved-edit'; document.querySelector('#btn-update-notice').click() })
    await flush()
    assert.equal((await snapshot()).downloadDir, 'X:/unsaved-edit')
    assert.equal(count('aa:settings-open'), openCount)
    record('Late startup and duplicate ready-open preserve locale/theme preview and unsaved edits')
    await close()
    assert.equal((await snapshot()).locale, 'en-US')
    assert.equal((await snapshot()).theme, 'dark')
    record('Cancel restores saved language and theme')

    for (const outcome of ['resolve', 'reject']) {
      const gate = hold('aa:settings-open')
      await click('#btn-settings')
      await until(() => gate.entered, 'delayed open entered')
      await close()
      const getCount = count('aa:settings-get')
      if (outcome === 'resolve') gate.resolve()
      else gate.reject('Late settings-open failure')
      await flush()
      assert.equal((await snapshot()).hidden, true)
      assert.equal(count('aa:settings-get'), getCount, 'Closed open must not fetch or reopen settings')
      await open()
      await close()
    }
    record('Closing during delayed open ignores late success/rejection and permits reopening')

    for (const channel of ['aa:settings-get', 'aa:agent-info']) {
      for (const outcome of ['resolve', 'reject']) {
        const gate = hold(channel)
        await click('#btn-settings')
        await until(() => gate.entered, `delayed ${channel}`)
        await close()
        await open()
        await preview('zh-CN', 'light')
        const before = await snapshot()
        if (outcome === 'resolve') gate.resolve(channel === 'aa:settings-get' ? view({ downloadDir: 'X:/stale', theme: 'dark' }) : null)
        else gate.reject(`Late ${channel} failure`)
        await flush()
        assert.deepEqual(await snapshot(), before, 'Old completion must not populate, translate, unlock or report into a new session')
        await close()
      }
    }
    record('Closed/reopened sessions ignore stale settings and agent success/rejection')

    for (const [channel, outcome] of [['aa:settings-open', 'reject'], ['aa:settings-get', 'reject'], ['aa:settings-get', 'null']]) {
      const gate = hold(channel)
      await click('#btn-settings')
      await until(() => gate.entered, `failing ${channel}`)
      if (outcome === 'null') gate.resolve(null)
      else gate.reject('Current load failure')
      await until(async () => (await snapshot()).statusState === 'error', 'recoverable load error')
      await assertLocked('failed settings load')
      assert.match((await snapshot()).status, /Unable to load settings.*reopen/)
      await close()
      await open()
      await close()
    }
    settings.locale = 'zh-CN'
    await open()
    await close()
    const chineseFailure = hold('aa:settings-get')
    await click('#btn-settings')
    await until(() => chineseFailure.entered, 'Chinese load failure')
    chineseFailure.reject()
    await until(async () => (await snapshot()).statusState === 'error', 'Chinese error status')
    assert.match((await snapshot()).status, /设置加载失败.*重新打开/)
    await close()
    settings.locale = 'en-US'
    await open()
    await close()
    record('Open/get rejection and null view stay locked; bilingual errors recover on reopening')

    const agentFailure = hold('aa:agent-info')
    await click('#btn-settings')
    await until(() => agentFailure.entered, 'optional agent failure')
    agentFailure.reject('Agent unavailable')
    await waitReady()
    await close()
    record('Optional agent-info failure preserves settings availability')

    const scan = hold('aa:clients-detect')
    await open()
    await until(() => scan.entered, 'held client scan')
    await close()
    await open()
    const beforeScan = await snapshot()
    scan.reject('Late client scan failure')
    await flush()
    assert.deepEqual(await snapshot(), beforeScan)
    record('Closed-session client scan error cannot overwrite the next session')

    await click('#btn-save-settings')
    await until(async () => (await snapshot()).statusState === 'success', 'successful normal save')
    const savedPatch = calls.filter((call) => call.channel === 'aa:settings-set').at(-1).args[0]
    assert.deepEqual(savedPatch, initial, 'Saving loaded, non-default settings must preserve every field')
    await close()
    record('Normal save preserves all original non-default configuration values')

    for (const outcome of ['resolve', 'reject']) {
      await open()
      const save = hold('aa:settings-set')
      await click('#btn-save-settings')
      await until(() => save.entered, 'delayed save')
      await close()
      const nextLoad = hold('aa:settings-get')
      await click('#btn-settings')
      await until(() => nextLoad.entered, 'new load while old save pending')
      const before = await snapshot()
      if (outcome === 'resolve') save.resolve(structuredClone(initial))
      else save.reject('Late save failure')
      await flush()
      assert.deepEqual(await snapshot(), before, 'Old save finally/error/success must not unlock or change the new load')
      nextLoad.resolve(view())
      await waitReady()
      await close()
    }
    record('Late save success/rejection/finally cannot mutate or unlock a new settings load')

    await open()
    const saveFailure = hold('aa:settings-set')
    await click('#btn-save-settings')
    await until(() => saveFailure.entered, 'current failed save')
    saveFailure.reject('Retryable save failure')
    await until(async () => (await snapshot()).statusState === 'error' && !(await snapshot()).disabled, 'save retry enabled')
    await click('#btn-save-settings')
    await until(async () => (await snapshot()).statusState === 'success', 'save retry succeeds')
    await close()
    record('Current save errors remain retryable')

    // Synthetic composition signals are intentional: Electron sendInputEvent has no isComposing flag.
    const composition = (selector, type) => run((target, eventType) => {
      document.querySelector(target).dispatchEvent(new CompositionEvent(eventType, { bubbles: true, data: '中文' }))
    }, selector, type)
    const composingKey = (selector, name, mode, ctrlKey = false) => run((target, keyName, signal, ctrl) => {
      const event = new KeyboardEvent('keydown', {
        key: keyName, bubbles: true, cancelable: true, ctrlKey: ctrl,
        isComposing: signal === 'isComposing', keyCode: signal === '229' ? 229 : 0
      })
      document.querySelector(target).dispatchEvent(event)
      return event.defaultPrevented
    }, selector, name, mode, ctrlKey)
    for (const mode of ['isComposing', '229', 'compositionstart']) {
      await run(() => {
        const input = document.querySelector('#omnibox')
        input.focus(); input.value = 'zhongwen'
        input.dispatchEvent(new Event('input', { bubbles: true }))
      })
      await until(() => run(() => !document.querySelector('#suggest-panel').hidden && document.querySelectorAll('.suggest-item').length >= 2), 'suggestions shown')
      if (mode === 'compositionstart') await composition('#omnibox', 'compositionstart')
      const submitCount = count('aa:omnibox-submit')
      const tabCount = count('aa:tab-new')
      for (const name of ['Enter', 'ArrowDown', 'ArrowUp', 'Escape']) {
        assert.equal(await composingKey('#omnibox', name, mode), false, `${mode}/${name}: IME retains default handling`)
      }
      await composingKey('#omnibox', 't', mode, true)
      await flush()
      assert.equal(count('aa:omnibox-submit'), submitCount)
      assert.equal(count('aa:tab-new'), tabCount)
      assert.deepEqual(await run(() => ({
        focus: document.activeElement.id, value: document.querySelector('#omnibox').value,
        hidden: document.querySelector('#suggest-panel').hidden,
        selected: document.querySelectorAll('.suggest-item.selected').length
      })), { focus: 'omnibox', value: 'zhongwen', hidden: false, selected: 0 })
      if (mode === 'compositionstart') await composition('#omnibox', 'compositionend')
      key('Enter')
      await until(() => count('aa:omnibox-submit') === submitCount + 1, 'ordinary Enter submits once')
      await flush()
      assert.equal(count('aa:omnibox-submit'), submitCount + 1)
      assert.equal(calls.filter((call) => call.channel === 'aa:omnibox-submit').at(-1).args[0], 'zhongwen')
    }
    record('isComposing/229/compositionstart protect omnibox Enter/arrows/Escape and global shortcuts')
    record('Composition completion restores ordinary native Enter with exactly one submission')

    await run(() => {
      const input = document.querySelector('#omnibox')
      input.focus()
      input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }))
      input.blur(); input.focus(); input.value = 'after-blur'
    })
    const submitCount = count('aa:omnibox-submit')
    key('Enter')
    await until(() => count('aa:omnibox-submit') === submitCount + 1, 'blur clears composition fallback')
    record('Blur clears fallback composition state without a compositionend event')

    await click('#btn-find')
    await until(() => run(() => !document.querySelector('#find-bar').hidden), 'find opens')
    await run(() => { document.querySelector('#find-query').value = '中文' })
    for (const mode of ['isComposing', '229', 'compositionstart']) {
      if (mode === 'compositionstart') await composition('#find-query', 'compositionstart')
      const finds = count('aa:find')
      const closes = count('aa:find-close')
      await composingKey('#find-query', 'Enter', mode)
      await composingKey('#find-query', 'Escape', mode)
      await flush()
      assert.equal(count('aa:find'), finds)
      assert.equal(count('aa:find-close'), closes)
      assert.equal(await run(() => document.activeElement.id), 'find-query')
      if (mode === 'compositionstart') await composition('#find-query', 'compositionend')
    }
    const finds = count('aa:find')
    key('Enter')
    await until(() => count('aa:find') === finds + 1, 'ordinary find Enter')
    assert.deepEqual(calls.filter((call) => call.channel === 'aa:find').at(-1).args, ['中文', true, true])
    key('Escape')
    await until(() => run(() => document.querySelector('#find-bar').hidden), 'ordinary find Escape')
    record('IME Enter/Escape leave finder intact; ordinary find navigation and Escape still work')

    await open()
    await run(() => { document.querySelector('#set-engine-url').focus() })
    for (const mode of ['isComposing', '229', 'compositionstart']) {
      if (mode === 'compositionstart') await composition('#set-engine-url', 'compositionstart')
      const closeCount = count('aa:settings-open')
      await composingKey('#set-engine-url', 'Escape', mode)
      await flush()
      assert.equal((await snapshot()).hidden, false)
      assert.equal(count('aa:settings-open'), closeCount)
      if (mode === 'compositionstart') await composition('#set-engine-url', 'compositionend')
    }
    key('Tab')
    await flush()
    assert.equal(await run(() => document.querySelector('#settings-modal').contains(document.activeElement)), true)
    key('Escape')
    await until(async () => (await snapshot()).hidden, 'ordinary settings Escape')
    record('IME Escape cannot close settings; normal modal Tab and Escape remain functional')

    // A previous setup must not write a result, rescan a new selection, or clear a newer write's busy state.
    detectedClients = ['zcode', 'cursor'].map((id) => ({
      id, name: `Fixture ${id}`, file: `X:/fixture/${id}.json`, installed: true, configured: false, outdated: false
    }))
    const waitClients = () => until(() => run(() =>
      document.querySelectorAll('#set-client-list input').length === 2 &&
      document.querySelector('#set-client-list').getAttribute('aria-busy') !== 'true' &&
      !document.querySelector('#btn-client-setup').disabled
    ), 'fresh client selection and setup available')
    for (const outcome of ['resolve', 'reject']) {
      await open()
      await waitClients()
      const oldSetup = hold('aa:clients-setup')
      await click('#btn-client-setup')
      await until(() => oldSetup.entered, 'old client setup pending')
      await close()
      await open()
      await waitClients()
      await click('#set-client-list input[data-id="cursor"]')
      assert.deepEqual((await snapshot()).clientSelection, ['zcode'])
      const newSetup = hold('aa:clients-setup')
      await click('#btn-client-setup')
      await until(() => newSetup.entered, 'new session can start its own client setup')
      const before = await snapshot()
      assert.equal(before.clientBusy, 'true')
      assert.equal(before.clientDisabled, true)
      const scans = count('aa:clients-detect')
      if (outcome === 'resolve') oldSetup.resolve([{ id: 'zcode', name: 'Fixture zcode', status: 'added', message: 'OLD-SESSION-RESULT' }])
      else oldSetup.reject('OLD-SESSION-ERROR')
      await flush()
      assert.deepEqual(await snapshot(), before, `Old setup ${outcome}/finally must not touch the new session`)
      assert.equal(count('aa:clients-detect'), scans, 'Old setup must not trigger a scan under the new generation')
      newSetup.resolve([{ id: 'zcode', name: 'Fixture zcode', status: 'added', message: 'NEW-SESSION-RESULT' }])
      await until(async () => {
        const ui = await snapshot()
        return ui.clientResult.includes('NEW-SESSION-RESULT') && ui.clientBusy === null
      }, 'current setup result and finally still work')
      await close()
      record(`Client setup stale ${outcome}/finally preserves new result, selection and in-flight write`)
    }
    detectedClients = []

    // Reload the real renderer so each startup race begins with its actual default appearance.
    async function reloadRenderer() {
      assert.deepEqual(await run(() => window.__settingsSafetyErrors), [], 'No unhandled errors before renderer reload')
      await win.loadFile(page)
      // Electron/Windows may retain a hidden visualization surface after a file reload;
      // keep this fixture visible for the diagnostic screenshots without stealing focus.
      win.showInactive()
      await run(() => {
        window.__settingsSafetyErrors = []
        window.addEventListener('unhandledrejection', (event) => window.__settingsSafetyErrors.push(String(event.reason)))
        window.addEventListener('error', (event) => window.__settingsSafetyErrors.push(event.message))
      })
    }
    async function assertAppearance(locale, theme, hidden = true) {
      await until(async () => {
        const ui = await snapshot()
        return ui.locale === locale && ui.theme === theme && ui.hidden === hidden
      }, `canonical appearance ${locale}/${theme}, hidden=${hidden}`)
    }
    for (const order of ['boot-first', 'modal-first', 'boot-reject']) {
      settings = structuredClone(initial)
      const startup = hold('aa:settings-get')
      await reloadRenderer()
      await until(() => startup.entered, 'new startup read held')
      const modalRead = hold('aa:settings-get')
      await click('#btn-settings')
      await until(() => modalRead.entered, 'modal read held before ready')
      await close()
      // bootstrap.js reuses the last committed appearance before the held IPC read;
      // this profile has already adopted the dark fixture during the preceding session.
      assert.equal((await snapshot()).theme, 'dark')
      if (order === 'boot-first') {
        startup.resolve(view())
        await assertAppearance('en-US', 'dark')
        modalRead.resolve(view())
      } else {
        modalRead.resolve(view())
        await assertAppearance('en-US', 'dark')
        if (order === 'boot-reject') startup.reject('Older startup failed after a valid modal read')
        else startup.resolve(view({ locale: 'zh-CN', theme: 'light' }))
      }
      await flush()
      await assertAppearance('en-US', 'dark')
      assert.equal((await snapshot()).disabled, true, 'Canonical adoption must not populate or unlock a closed modal')
      record(`Startup read + close-before-ready adopts saved appearance without reopening (${order})`)
    }

    settings = structuredClone(initial)
    const olderStartup = hold('aa:settings-get')
    await reloadRenderer()
    await until(() => olderStartup.entered, 'startup held behind a later save')
    await open()
    await preview('zh-CN', 'light')
    const savedAfterClose = hold('aa:settings-set', { commit: true })
    await click('#btn-save-settings')
    await until(() => savedAfterClose.entered, 'main committed save but acknowledgement held')
    assert.deepEqual([settings.locale, settings.theme], ['zh-CN', 'light'], 'The fixture main has really committed the patch before close')
    await close()
    await assertAppearance('en-US', 'dark')
    const closedStatus = (await snapshot()).status
    savedAfterClose.resolve()
    await assertAppearance('zh-CN', 'light')
    assert.equal((await snapshot()).status, closedStatus, 'Late save updates canonical appearance, not closed-modal status')
    olderStartup.resolve(view({ locale: 'en-US', theme: 'dark' }))
    await flush()
    await assertAppearance('zh-CN', 'light')
    await captureEvidence('settings-late-save.png')
    record('Save committed before close adopts late acknowledgement while hidden; older startup cannot undo it')

    // A newer valid response establishes the baseline; older save acknowledgements cannot move it backwards.
    for (const newer of ['read', 'save']) {
      settings = structuredClone(initial)
      await open()
      await preview('zh-CN', 'light')
      const oldSave = hold('aa:settings-set', { commit: true })
      await click('#btn-save-settings')
      await until(() => oldSave.entered, 'old save committed with held acknowledgement')
      await close()
      if (newer === 'read') settings = structuredClone(initial)
      await open()
      if (newer === 'save') {
        await preview('en-US', 'dark')
        await click('#btn-save-settings')
        await until(async () => (await snapshot()).statusState === 'success', 'newer save acknowledged')
      }
      await preview('zh-CN', 'light')
      const before = await snapshot()
      oldSave.resolve()
      await flush()
      assert.deepEqual(await snapshot(), before, 'Late old save must not overwrite an active preview or modal state')
      await close()
      await assertAppearance('en-US', 'dark')
      record(`Late old save preserves newer ${newer} baseline and active preview; cancel uses newer baseline`)
    }

    // Even when a valid old save is the newest adopted baseline, it must leave a newer modal preview alone.
    settings = structuredClone(initial)
    await open()
    await preview('zh-CN', 'light')
    const previewSave = hold('aa:settings-set', { commit: true })
    await click('#btn-save-settings')
    await until(() => previewSave.entered, 'save pending while user continues previewing')
    await preview('en-US', 'dark')
    previewSave.resolve()
    await until(async () => (await snapshot()).statusState === 'success', 'save status resolved without replacing preview')
    await assertAppearance('en-US', 'dark', false)
    await close()
    await assertAppearance('zh-CN', 'light')
    record('Current preview survives an accepted save baseline; cancel restores the acknowledged baseline')

    await flush()
    assert.deepEqual(await run(() => window.__settingsSafetyErrors), [], 'No renderer errors or unhandled IPC rejections')
    assert.deepEqual(report.errors, [], 'No renderer console errors')
    assert.deepEqual(report.blockedRequests, [], 'Fixture must not attempt public network access')
    assert.equal(pending.size, 0, 'All deferred fixture IPC requests settled')
    record('No renderer errors, unhandled rejections, unsettled fixture calls or external requests')
    report.status = 'PASS'
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2))
    win.destroy()
    console.log(`PASS: ${report.checks.length} settings/IME regression groups (production preload, isolated Electron)`)
    app.exit(0)
  } catch (error) {
    report.status = 'FAIL'
    report.stage = stage
    report.error = error.stack ?? String(error)
    console.error(error)
    if (directory) fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify(report, null, 2))
    if (win && !win.isDestroyed()) win.destroy()
    app.exit(1)
  }
}
