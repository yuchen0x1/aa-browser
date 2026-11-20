/** App i18n: built main/preload/renderers, real IPC, disposable profile, loopback fixture only. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'

const file = fileURLToPath(import.meta.url)
const root = path.resolve(path.dirname(file), '..')
const main = path.join(root, 'out/main/index.js')
const renderer = (name) => pathToFileURL(path.join(root, `out/renderer/${name}.html`)).href
const require = createRequire(import.meta.url)
const testRootVar = 'AA_APP_I18N_TEST_ROOT'

if (!process.versions.electron) {
  assert.ok(fs.existsSync(main), 'Build the application with npm run build first')
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-app-i18n-'))
  const p = (name) => path.join(tmp, name)
  try {
    for (const name of ['home', 'app-data', 'local-app-data', 'xdg-config', 'xdg-data', 'xdg-cache', 'profile', 'session-data', 'history', 'downloads']) {
      fs.mkdirSync(p(name))
    }
    const env = {
      ...process.env,
      [testRootVar]: tmp,
      HOME: p('home'), USERPROFILE: p('home'), APPDATA: p('app-data'), LOCALAPPDATA: p('local-app-data'),
      XDG_CONFIG_HOME: p('xdg-config'), XDG_DATA_HOME: p('xdg-data'), XDG_CACHE_HOME: p('xdg-cache'),
      AA_BROWSER_USER_DATA_DIR: p('profile'), AA_BROWSER_CONNECTION_FILE: p('connection.json'),
      AA_BROWSER_HISTORY_DIR: p('history'), AA_BROWSER_SETTINGS_FILE: p('settings.json'),
      AA_BROWSER_SESSION_FILE: p('session.json'), AA_BROWSER_DOWNLOAD_DIR: p('downloads'),
      AA_BROWSER_EVIDENCE_FILE: p('evidence.json'), AA_BROWSER_SCREENSHOT_DIR: p('screenshots'),
      AA_BROWSER_BASELINE_DIR: p('baselines')
    }
    delete env.ELECTRON_RUN_AS_NODE
    delete env.ELECTRON_RENDERER_URL
    delete env.APPIMAGE
    fs.writeFileSync(env.AA_BROWSER_SETTINGS_FILE, JSON.stringify({
      locale: 'en-US', theme: 'dark', autoUpdate: false, restoreSession: false
    }))
    const result = spawnSync(require('electron'), [file, '--lang=zh-CN'], {
      cwd: root, env, stdio: 'inherit', timeout: 75_000
    })
    if (result.error) throw result.error
    assert.equal(result.status, 0, `Electron app test exited (${result.signal ?? 'no signal'})`)
    assert.equal(fs.readFileSync(p('passed'), 'utf8'), 'ok')
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
  }
} else {
  void testApplication()
}

async function until(probe, label) {
  const end = Date.now() + 10_000
  while (Date.now() < end) {
    const result = await probe()
    if (result) return result
    await delay(35)
  }
  throw new Error(`Timed out: ${label}`)
}

// Serialize only fixture inputs to the actual preload/renderer; never replace their API or hooks.
function evaluate(wc, fn, ...args) {
  return wc.executeJavaScript(`(${fn})(${args.map((arg) => JSON.stringify(arg)).join(',')})`)
}

async function testApplication() {
  const { app, nativeTheme, session, webContents } = require('electron')
  let server
  try {
    const tmp = process.env[testRootVar]
    assert.ok(tmp, 'Run this test through Node to create disposable stores')
    app.setAppPath(root)
    app.getVersion = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
    app.setPath('home', path.join(tmp, 'home'))
    app.setPath('appData', path.join(tmp, 'app-data'))
    app.setPath('sessionData', path.join(tmp, 'session-data'))
    // Make the default language/theme oppose the saved en-US/dark values so skipped startup sync cannot pass.
    const setBrowserDefaults = () => {
      nativeTheme.themeSource = 'light'
      const browserSession = session.defaultSession
      browserSession.setUserAgent(browserSession.getUserAgent(), 'zh-CN,zh')
    }
    if (app.isReady()) setBrowserDefaults()
    else app.once('ready', setBrowserDefaults)
    await import(pathToFileURL(main).href)
    await app.whenReady()

    const at = (url) => webContents.getAllWebContents().filter((wc) => wc.getURL() === url && !wc.isLoadingMainFrame())
    const chrome = await until(() => at(renderer('index'))[0], 'compiled shell')
    const ui = (fn, ...args) => evaluate(chrome, fn, ...args)
    const settings = () => ui(() => window.aa.settingsGet().then((view) => view.settings))
    const save = (patch) => ui((value) => window.aa.settingsSet(value), patch)
    const newtabs = () => at(renderer('newtab'))
    const readAppearance = (wc) => evaluate(wc, () => ({
      locale: document.documentElement.lang,
      theme: document.documentElement.dataset.theme,
      copyButton: document.querySelector('#copy-prompt')?.textContent
    }))
    const expectAppearance = (pages, locale, theme, label) => until(async () => {
      const states = await Promise.all(pages.map(readAppearance))
      const copyButton = locale === 'en-US' ? 'Copy the connection prompt' : '复制接入提示词'
      return states.every((state) => state.locale === locale && state.theme === theme && state.copyButton === copyButton)
    }, label)
    const addNewtab = async () => {
      const oldIds = new Set(newtabs().map((wc) => wc.id))
      await ui(() => window.aa.tabNew())
      return until(() => newtabs().find((wc) => !oldIds.has(wc.id)), 'new tab through IPC')
    }
    const first = await until(() => newtabs()[0], 'startup new tab')
    await until(() => ui(() => !!window.aa && document.documentElement.lang === 'en-US'), 'shell loaded saved English')
    assert.equal((await settings()).locale, 'en-US')
    assert.equal(await evaluate(first, () => navigator.languages[0]), 'zh-CN', 'the renderer auto-language fixture must be Chinese')
    await expectAppearance([first], 'en-US', 'dark', 'startup applies saved English and dark theme')
    const missingId = 'app-i18n-no-such-download'
    assert.deepEqual(await ui((id) => window.aa.downloadRetry(id), missingId), {
      ok: false, reason: `Download record not found: ${missingId}`
    }, 'real IPC reports the saved English diagnostic for a missing record')
    const second = await addNewtab()
    await expectAppearance([second], 'en-US', 'dark', 'second tab uses the same saved appearance')

    // Same path suffix as the internal page, but a different URL. Hooks exist before DOM ready.
    let releasePendingNavigation
    server = http.createServer((req, res) => {
      const reply = () => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(`<!doctype html><html lang="fr"><title>External newtab fixture</title><script>
          window.appearanceCalls = [];
          window.__aaApplyTheme = value => window.appearanceCalls.push(['theme', value]);
          window.__aaApplyLocale = value => window.appearanceCalls.push(['locale', value]);
        </script><p>External fixture</p></html>`)
      }
      if (req.url === '/renderer/newtab.html?pending=1') releasePendingNavigation = reply
      else reply()
    })
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
    const externalUrl = `http://127.0.0.1:${server.address().port}/renderer/newtab.html`
    await ui((url) => window.aa.tabNew(url), externalUrl)
    const external = await until(() => at(externalUrl)[0], 'external loopback renderer')
    const externalCalls = () => evaluate(external, () => window.appearanceCalls)
    assert.deepEqual(await externalCalls(), [], 'external DOM ready must not call either hook')

    await ui(() => document.querySelector('#btn-settings').click())
    await until(() => ui(() => !document.querySelector('#settings-modal').hidden
      && document.querySelector('#set-locale').value === 'en-US'), 'settings opened with saved locale')
    await ui(() => {
      const select = document.querySelector('#set-locale')
      select.value = 'zh-CN'
      select.dispatchEvent(new Event('change', { bubbles: true }))
    })
    assert.equal(await ui(() => document.documentElement.lang), 'zh-CN', 'preview changes the shell')
    assert.equal((await settings()).locale, 'en-US', 'preview does not save to main')
    await expectAppearance([first, second], 'en-US', 'dark', 'preview does not change existing new tabs')
    await ui(() => document.querySelector('#btn-close-settings').click())
    assert.deepEqual(await ui(() => ({
      hidden: document.querySelector('#settings-modal').hidden,
      locale: document.documentElement.lang
    })), { hidden: true, locale: 'en-US' }, 'cancel restores the shell locale')
    const afterCancel = await addNewtab()
    const openPages = [first, second, afterCancel]
    await expectAppearance(openPages, 'en-US', 'dark', 'cancelled preview never reaches existing or future new tabs')

    assert.equal((await save({ locale: 'zh-CN' })).locale, 'zh-CN')
    await expectAppearance(openPages, 'zh-CN', 'dark', 'real locale-only settings IPC updates active and inactive new tabs')
    const inherited = await addNewtab()
    await expectAppearance([inherited], 'zh-CN', 'dark', 'a subsequent new tab inherits the saved locale')
    openPages.push(inherited)
    assert.deepEqual(await externalCalls(), [], 'locale update must not invoke either external hook')

    // The real appearance sync writes data-theme even when the value is unchanged.
    // Watch its side effect rather than replacing either internal page hook.
    await Promise.all(openPages.map((wc) => evaluate(wc, () => {
      const mutations = []
      const observer = new MutationObserver((records) => mutations.push(...records.map((record) => record.attributeName)))
      observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'lang'] })
      window.readAppearanceMutations = () => [...mutations]
    })))
    const pathToSettings = process.env.AA_BROWSER_SETTINGS_FILE
    const persisted = fs.readFileSync(pathToSettings, 'utf8')
    assert.equal(await save({ locale: 'en-US', theme: 'light', searchEngine: 'not a URL' }), null)
    assert.equal(fs.readFileSync(pathToSettings, 'utf8'), persisted, 'rejected settings do not modify the store')
    const afterInvalid = await addNewtab()
    await expectAppearance([...openPages, afterInvalid], 'zh-CN', 'dark', 'rejected settings do not affect existing or future new tabs')
    const appearanceMutations = () => Promise.all(openPages.map((wc) => evaluate(wc, () => window.readAppearanceMutations())))
    assert.deepEqual(await appearanceMutations(), openPages.map(() => []), 'rejected IPC never triggers internal appearance sync')

    assert.equal((await save({ theme: 'light' })).theme, 'light')
    await expectAppearance([...openPages, afterInvalid], 'zh-CN', 'light', 'valid theme-only IPC still syncs appearance')
    assert.ok((await appearanceMutations()).every((records) => records.includes('data-theme')), 'observers detect confirmed sync')
    assert.deepEqual(await externalCalls(), [], 'neither hook was called on the external page during any settings update')

    // Renderer-initiated navigation keeps the old committed URL visible while the response is held.
    // Electron queues executeJavaScript during a main-frame load, so the actual execution can land
    // in the external document even though the main-side URL check passed when settings were saved.
    const racedTabId = afterInvalid.id
    const pendingUrl = `${externalUrl}?pending=1`
    await evaluate(afterInvalid, (url) => { location.assign(url) }, pendingUrl)
    await until(() => releasePendingNavigation, 'same new tab sends the delayed loopback request')
    assert.equal(afterInvalid.isLoadingMainFrame(), true, 'external navigation must be pending before save')
    assert.equal(afterInvalid.getURL(), renderer('newtab'), 'outer URL guard must still see the internal URL')
    const savedWhilePending = await save({ locale: 'en-US', theme: 'dark' })
    assert.deepEqual([savedWhilePending?.locale, savedWhilePending?.theme], ['en-US', 'dark'])
    assert.equal(afterInvalid.isLoadingMainFrame(), true, 'keep the response held through the settings IPC')
    const settledDocument = evaluate(afterInvalid, () => ({ url: location.href, calls: window.appearanceCalls }))
    releasePendingNavigation()
    await until(() => at(pendingUrl).some((wc) => wc.id === racedTabId), 'the original WebContents commits the external page')
    assert.deepEqual(await settledDocument, { url: pendingUrl, calls: [] }, 'queued appearance injection must not call external hooks')
    await expectAppearance(openPages, 'en-US', 'dark', 'pending-navigation settings save still reaches internal tabs')
    assert.deepEqual(await evaluate(afterInvalid, () => window.appearanceCalls), [], 'the navigated WebContents remains untouched after queued scripts settle')

    fs.writeFileSync(path.join(tmp, 'passed'), 'ok')
    console.log('PASS: app locale, preview/cancel, rejected settings, external URL isolation (including pending navigation) and download diagnosis')
    server.close()
    app.quit()
  } catch (error) {
    console.error(error)
    server?.close()
    app.exit(1)
  }
}
