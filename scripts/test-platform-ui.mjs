/** Platform desktop integration: real main/preload/UI, local pages, disposable stores. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const file = fileURLToPath(import.meta.url)
const root = path.resolve(path.dirname(file), '..')
const require = createRequire(import.meta.url)
if (!process.versions.electron) {
  const directory = path.join(root, '.local-verification', `platform-ui-${Date.now()}-${process.pid}`)
  fs.mkdirSync(directory, { recursive: true })
  const environment = {
    ...process.env,
    AA_PLATFORM_UI_DIRECTORY: directory,
    AA_BROWSER_USER_DATA_DIR: path.join(directory, 'chromium'),
    AA_BROWSER_DATA_DIR: path.join(directory, 'data'),
    AA_BROWSER_SETTINGS_FILE: path.join(directory, 'settings.json'),
    AA_BROWSER_CONNECTION_FILE: path.join(directory, 'connection.json'),
    AA_BROWSER_HISTORY_DIR: path.join(directory, 'history'),
    AA_BROWSER_SESSION_FILE: path.join(directory, 'session.json'),
    AA_BROWSER_DOWNLOAD_DIR: path.join(directory, 'downloads'),
    AA_BROWSER_EVIDENCE_FILE: path.join(directory, 'evidence.json'),
    AA_BROWSER_TASK_CENTER_FILE: path.join(directory, 'tasks.json')
  }
  fs.writeFileSync(environment.AA_BROWSER_SETTINGS_FILE, JSON.stringify({ theme: 'dark', locale: 'en-US', autoUpdate: false, restoreSession: false }))
  delete environment.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron'), [file], { cwd: root, env: environment, stdio: 'inherit' })
  const timer = setTimeout(() => { console.error('FAIL: platform UI timed out'); child.kill() }, 100_000)
  child.once('error', (error) => { clearTimeout(timer); console.error(error); process.exitCode = 1 })
  child.once('exit', (code) => { clearTimeout(timer); process.exitCode = code ?? 1 })
} else {
  void run().catch((error) => { fs.writeSync(2, `${error.stack ?? error}\n`); process.exit(1) })
}

async function run() {
  const { app, webContents, BaseWindow, session } = await import('electron')
  const directory = process.env.AA_PLATFORM_UI_DIRECTORY
  assert.ok(directory)
  const checks = []
  const errors = []
  const pass = (label) => { checks.push(label); console.log(`PASS: ${label}`) }
  const pause = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds))
  async function until(probe, label) {
    const end = Date.now() + 15_000
    while (Date.now() < end) { const value = await probe(); if (value) return value; await pause(35) }
    throw new Error(`Timed out: ${label}`)
  }
  let server
  try {
    app.setAppPath(root)
    app.getVersion = () => JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version
    server = http.createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html; charset=utf-8')
      response.end('<!doctype html><html><head><title>Platform UI local fixture</title></head><body><h1>Inspection fixture</h1><p>Browser workflow completed on a local test page.</p></body></html>')
    })
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
    const url = `http://127.0.0.1:${server.address().port}/inspection`
    const extensionDirectory = path.join(directory, 'fixture-extension')
    const extensionManifest = {
      name: 'AA Platform UI Fixture',
      version: '1.0.0',
      manifest_version: 3,
      permissions: ['storage'],
      host_permissions: ['http://127.0.0.1/*'],
      content_scripts: [{ matches: ['http://127.0.0.1/*'], js: ['content.js'], run_at: 'document_idle' }]
    }
    fs.mkdirSync(extensionDirectory, { recursive: true })
    fs.writeFileSync(path.join(extensionDirectory, 'manifest.json'), JSON.stringify(extensionManifest))
    fs.writeFileSync(path.join(extensionDirectory, 'content.js'), 'document.documentElement.dataset.aaPlatformExtension = "active"')
    await import(pathToFileURL(path.join(root, 'out/main/index.js')).href)
    await app.whenReady()
    const chrome = await until(() => webContents.getAllWebContents().find((item) => item.getURL().endsWith('/renderer/index.html') && !item.isLoading()), 'shell')
    chrome.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
    const ui = (fn, ...args) => chrome.executeJavaScript(`(${fn})(${args.map((arg) => JSON.stringify(arg)).join(',')})`, true)
    const click = (selector) => ui((target) => document.querySelector(target).click(), selector)
    const platform = () => ui(() => window.aa.platformState())
    const state = () => ui(() => window.aa.getState())
    const window = BaseWindow.getAllWindows()[0]
    window.show()
    chrome.setBackgroundThrottling(false)
    await until(async () => (await platform()).profiles.length === 1, 'default Profile')
    assert.equal((await platform()).profiles[0].id, 'default')
    const defaultHistoryUrl = new URL('/default-profile-history', url).href
    await ui((target) => window.aa.submit(target), defaultHistoryUrl)
    await until(async () => (await ui(() => window.aa.historySuggest('127.0.0.1'))).some((entry) => entry.url === defaultHistoryUrl), 'default history recorded')
    await click('#btn-settings')
    await until(() => ui(() => !document.querySelector('#settings-body').inert), 'settings ready')
    async function section(id) {
      await click(`[data-target="settings-section-${id}"]`)
      await ui((name) => document.querySelector(`#settings-section-${name}`).scrollIntoView({ block: 'start' }), id)
    }
    async function approve() {
      await until(async () => (await state()).pendingApprovals.length > 0, 'approval')
      const accessibility = await ui(() => ({
        visible: !document.querySelector('#approval-panel').hidden,
        enabled: !document.querySelector('#approval-panel').inert,
        aboveSettings: Number(getComputedStyle(document.querySelector('#approval-panel')).zIndex) > Number(getComputedStyle(document.querySelector('#settings-modal')).zIndex),
        settingsBlocked: document.querySelector('#settings-modal').inert
      }))
      assert.deepEqual(accessibility, { visible: true, enabled: true, aboveSettings: true, settingsBlocked: true })
      await click('.approval-allow')
      await until(async () => (await state()).pendingApprovals.length === 0, 'approval resolved')
    }
    await section('profiles')
    await ui(() => {
      document.querySelector('#profile-name').value = 'UI work account'
      document.querySelector('#profile-description').value = 'Disposable integration profile'
      document.querySelector('#profile-form').requestSubmit()
    })
    await approve()
    const work = await until(async () => (await platform()).profiles.find((item) => item.name === 'UI work account'), 'created Profile')
    await until(() => ui(() => document.querySelector('#profile-list').textContent.includes('UI work account')), 'Profile row')
    pass('Profile creation uses the real form and accessible approval above settings')
    await click('#btn-close-settings')
    await ui((profileId) => {
      const select = document.querySelector('#profile-selector')
      select.value = profileId
      select.dispatchEvent(new Event('change'))
    }, work.id)
    await until(async () => (await state()).tabs.some((tab) => tab.profileId === work.id && tab.active), 'Profile switch')
    assert.equal((await platform()).activeProfileId, work.id)
    pass('Toolbar Profile selection opens a browser tab in that persistent Profile')
    assert.equal((await platform()).defaultProfileId, 'default')
    const existingTabIds = (await state()).tabs.map((tab) => tab.id)
    await click('#btn-newtab')
    const newWorkTab = await until(async () => (await state()).tabs.find((tab) => tab.active && !existingTabIds.includes(tab.id)), 'new work Profile tab')
    assert.equal(newWorkTab.profileId, work.id)
    pass('New tab button preserves the active nondefault Profile')
    const workHistoryUrl = new URL('/work-profile-history', url).href
    await ui((target) => window.aa.submit(target), workHistoryUrl)
    await until(async () => (await ui(() => window.aa.historySuggest('127.0.0.1'))).some((entry) => entry.url === workHistoryUrl), 'work history recorded')
    const history = await ui(() => window.aa.historySuggest('127.0.0.1'))
    assert.equal(history.some((entry) => entry.url === defaultHistoryUrl), false)
    await ui(() => {
      const input = document.querySelector('#omnibox')
      input.focus()
      input.value = '127.0.0.1'
      input.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await until(() => ui(() => !document.querySelector('#suggest-panel').hidden && document.querySelector('#suggest-list').textContent.includes('/work-profile-history')), 'work history suggestion UI')
    assert.equal(await ui(() => document.querySelector('#suggest-list').textContent.includes('/default-profile-history')), false)
    pass('Address bar suggestions include only the active Profile history')
    await click('#btn-settings')
    await until(() => ui(() => !document.querySelector('#settings-body').inert), 'settings reopened')
    await section('workflows')
    await until(() => ui(() => document.querySelector('#workflow-template').options.length === 8), 'all templates')
    await ui((profileId, target) => {
      document.querySelector('#workflow-name').value = 'UI inspection'
      document.querySelector('#workflow-profile').value = profileId
      document.querySelector('#workflow-template').value = 'inspection'
      document.querySelector('#workflow-template').dispatchEvent(new Event('change'))
      document.querySelector('#workflow-url').value = target
      document.querySelector('#workflow-form').requestSubmit()
    }, work.id, url)
    const workflow = await until(async () => (await platform()).workflows.find((item) => item.name === 'UI inspection'), 'workflow created')
    await until(() => ui(() => !!document.querySelector('#workflow-list [aria-label="Run workflow"]')), 'run button')
    assert.equal(await ui(() => !!document.querySelector('#workflow-list [aria-label="Delete workflow"]')), false, 'draft workflows must be cancelled before deletion')
    await click('#workflow-list [aria-label="Run workflow"]')
    await approve()
    await until(async () => (await platform()).workflows.find((item) => item.id === workflow.id)?.status === 'completed', 'workflow completion')
    await until(() => ui(() => document.querySelector('#workflow-list progress')?.value === document.querySelector('#workflow-list progress')?.max), 'rendered progress')
    assert.equal((await platform()).workflows.find((item) => item.id === workflow.id).profileId, work.id)
    pass('Workflow form, execution controls, steps and progress reflect the real Profile-bound engine')
    for (const [template, expected] of [['multi-page', 'workflow-urls-label'], ['form', 'workflow-parameters-label'], ['page-test', 'workflow-parameters-label'], ['scheduled', 'workflow-schedule-label']]) {
      await ui((id) => {
        document.querySelector('#workflow-template').value = id
        document.querySelector('#workflow-template').dispatchEvent(new Event('change'))
      }, template)
      assert.equal(await ui((id) => document.getElementById(id).hidden, expected), false)
    }
    pass('Multi-page, form, assertion and scheduled templates expose their required parameters')
    const screenshot = async (name) => {
      await pause(180)
      const image = await chrome.capturePage()
      assert.equal(image.isEmpty(), false)
      const pixels = image.toBitmap()
      assert.ok(pixels.some((value) => value !== pixels[0]), 'screenshot must have rendered pixels')
      fs.writeFileSync(path.join(directory, name), image.toPNG())
    }
    await screenshot('workflows.png')
    await until(() => ui(() => !!document.querySelector('#workflow-list [aria-label="Delete workflow"]:not(:disabled)')), 'completed workflow delete control')
    await click('#workflow-list [aria-label="Delete workflow"]')
    await until(async () => (await state()).pendingApprovals.some((item) => item.fieldLabel === 'Delete workflow'), 'workflow deletion native confirmation')
    await click('.approval-deny')
    await until(() => ui(() => !!document.querySelector('#workflow-list [aria-label="Delete workflow"]:not(:disabled)')), 'denied workflow deletion settles')
    assert.equal((await platform()).workflows.some((item) => item.id === workflow.id), true)
    await click('#workflow-list [aria-label="Delete workflow"]')
    await approve()
    await until(async () => !(await platform()).workflows.some((item) => item.id === workflow.id), 'approved workflow removal')
    await until(() => ui(() => !document.querySelector('#workflow-list [aria-label="Delete workflow"]')), 'deleted workflow row removed')
    pass('Only terminal workflows expose deletion; native denial preserves records and approval removes them')
    await section('network')
    await ui((id) => {
      document.querySelector('#network-profile').value = id
      document.querySelector('#network-profile').dispatchEvent(new Event('change'))
      document.querySelector('#network-mode').value = 'direct'
      document.querySelector('#network-form').requestSubmit()
    }, work.id)
    await approve()
    await until(async () => (await platform()).network[work.id].mode === 'direct', 'network applied')
    assert.equal((await platform()).network.default.mode, 'system')
    pass('Network form applies to the selected Profile and preserves the other Profile environment')
    await section('security')
    await until(() => ui(() => document.querySelector('#permission-audit').textContent.includes('high-risk')), 'permission audit')
    assert.equal(await ui(() => document.querySelector('#permission-audit').textContent.includes('allowed: true')), true)
    pass('Security center shows actual approval decisions')
    await section('diagnostics')
    await click('#diagnostics-refresh')
    await until(() => ui(() => document.querySelector('#diagnostics-details').textContent.includes('memoryWorkingSetKiB')), 'resource diagnostics')
    pass('Diagnostics bind to Electron process resources and live browser state')
    const extension = await ui((folder, profileId) => window.aa.extensionLoad(folder, profileId), extensionDirectory, work.id)
    assert.equal(extension.ok, true, extension.error)
    const workExtensions = session.fromPartition(`persist:aa-profile-${work.id}`).extensions
    assert.ok(workExtensions.getAllExtensions().some((entry) => entry.id === extension.extension.id))
    await section('extensions')
    await ui((id) => {
      document.querySelector('#extension-profile').value = id
      document.querySelector('#extension-profile').dispatchEvent(new Event('change'))
    }, work.id)
    await until(() => ui(() => document.querySelector('#extension-list').textContent.includes('AA Platform UI Fixture')), 'Profile extension row')
    const extensionDetails = await ui(() => {
      const row = document.querySelector('#extension-list .extension-row')
      return { text: row.textContent, enabled: row.querySelector('input[type="checkbox"]').checked }
    })
    assert.match(extensionDetails.text, /Local unpacked directory/)
    assert.match(extensionDetails.text, /Status: running/)
    assert.match(extensionDetails.text, /storage/)
    assert.match(extensionDetails.text, /http:\/\/127\.0\.0\.1\/\*/)
    assert.equal(extensionDetails.enabled, true)
    pass('Extension management shows real Profile-bound source, running state and declared permissions')
    await ui(() => {
      document.querySelector('#extension-profile').value = 'default'
      document.querySelector('#extension-profile').dispatchEvent(new Event('change'))
    })
    await until(() => ui(() => !document.querySelector('#extension-list').hasAttribute('aria-busy')), 'default extension list')
    assert.equal(await ui(() => document.querySelector('#extension-list .extension-row') === null), true)
    assert.deepEqual(await ui(() => window.aa.extensionList('default')), [])
    assert.deepEqual(session.fromPartition('persist:aa-main').extensions.getAllExtensions(), [])
    await ui((id) => {
      document.querySelector('#extension-profile').value = id
      document.querySelector('#extension-profile').dispatchEvent(new Event('change'))
    }, work.id)
    await until(() => ui(() => !!document.querySelector('#extension-list input[type="checkbox"]')), 'work extension restored')
    pass('Extension Profile selector keeps the default and work Profile registries isolated')
    await click('#extension-list input[type="checkbox"]')
    await until(async () => (await ui((id) => window.aa.extensionList(id), work.id))[0]?.status === 'disabled', 'extension disabled')
    assert.equal(workExtensions.getAllExtensions().length, 0)
    await until(() => ui(() => document.querySelector('#extension-list').textContent.includes('Status: disabled') && !document.querySelector('#extension-list input[type="checkbox"]').disabled), 'disabled extension row')
    await click('#extension-list input[type="checkbox"]')
    await until(async () => (await ui((id) => window.aa.extensionList(id), work.id))[0]?.status === 'running', 'extension enabled')
    assert.equal(workExtensions.getAllExtensions().length, 1)
    await until(() => ui(() => document.querySelector('#extension-list').textContent.includes('Status: running')), 'enabled extension row')
    pass('Extension switches disable and re-enable the actual Chromium extension')
    await click('#btn-extension-updates')
    await until(() => ui(() => document.querySelector('#extension-list').textContent.includes('Local version matches')), 'matching local extension version')
    fs.writeFileSync(path.join(extensionDirectory, 'manifest.json'), JSON.stringify({ ...extensionManifest, version: '1.0.1' }))
    await until(() => ui(() => !document.querySelector('#btn-extension-updates').disabled), 'local update check complete')
    await click('#btn-extension-updates')
    await until(() => ui(() => document.querySelector('#extension-list').textContent.includes('Local version changed: 1.0.0')), 'changed local extension version')
    assert.match(await ui(() => document.querySelector('#extension-list').textContent), /1\.0\.1/)
    pass('Local extension update checks compare the installed version with the real local manifest')
    await screenshot('extensions.png')
    for (const size of [[1280, 840], [960, 640]]) {
      window.setSize(...size)
      await pause(120)
      await section('profiles')
      const overflow = await ui(() => {
        const body = document.querySelector('#settings-body')
        return { body: body.scrollWidth > body.clientWidth + 1, page: document.documentElement.scrollWidth > innerWidth + 1 }
      })
      assert.deepEqual(overflow, { body: false, page: false })
      await screenshot(`profiles-${size[0]}.png`)
    }
    pass('Platform panels fit desktop and minimum window widths without horizontal overflow')
    assert.deepEqual(errors, [])
    pass('Platform UI completes without renderer console errors')
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ status: 'PASS', checks, screenshots: ['workflows.png', 'extensions.png', 'profiles-1280.png', 'profiles-960.png'] }, null, 2))
    console.log(`Platform UI evidence: ${directory}`)
    server.close()
    app.exit(0)
  } catch (error) {
    fs.writeFileSync(path.join(directory, 'result.json'), JSON.stringify({ status: 'FAIL', checks, error: error.stack }, null, 2))
    server?.close()
    throw error
  }
}
