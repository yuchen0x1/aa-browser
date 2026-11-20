/** UI/UX regression: real Electron renderers, isolated profile, no external services. */
import fs from 'node:fs'
import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const baseline = process.argv.includes('--baseline')

if (!process.versions.electron) {
  const runDir = path.join(ROOT, '.local-verification', `ui-ux-${baseline ? 'before' : 'after'}-${Date.now()}-${process.pid}`)
  fs.mkdirSync(runDir, { recursive: true })
  fs.mkdirSync(path.join(runDir, 'history'))
  fs.writeFileSync(path.join(runDir, 'history/history.json'), JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ url: `https://ui-suggestion.test/${i}`, title: `UI suggestion ${i}`, ts: Date.now(), count: 8-i }))))
  const env = { ...process.env, AA_UI_UX_DIR: runDir,
    AA_BROWSER_USER_DATA_DIR: path.join(runDir, 'profile'),
    AA_BROWSER_CONNECTION_FILE: path.join(runDir, 'connection.json'),
    AA_BROWSER_HISTORY_DIR: path.join(runDir, 'history'),
    AA_BROWSER_SETTINGS_FILE: path.join(runDir, 'settings.json'),
    AA_BROWSER_SESSION_FILE: path.join(runDir, 'session.json'),
    AA_BROWSER_DOWNLOAD_DIR: path.join(runDir, 'downloads'),
    AA_BROWSER_EVIDENCE_FILE: path.join(runDir, 'evidence.json') }
  delete env.ELECTRON_RUN_AS_NODE
  console.log(`UI/UX artifacts: ${runDir}`)
  const child = spawn(require('electron'), [fileURLToPath(import.meta.url), ...process.argv.slice(2)], { cwd: ROOT, env, stdio: 'inherit' })
  const timer = setTimeout(() => { console.error('FAIL: UI/UX suite timed out'); child.kill() }, 120_000)
  child.once('error', (error) => { clearTimeout(timer); console.error(error); process.exitCode = 1 })
  child.once('exit', (code) => {
    clearTimeout(timer)
    const resultFile = path.join(runDir, 'result.json')
    let result
    try { result = JSON.parse(fs.readFileSync(resultFile, 'utf8')) } catch {}
    const accepted = result?.status === 'PASS' || (baseline && result?.status === 'BASELINE')
    process.exitCode = code === 0 && accepted ? 0 : 1
  })
} else {
  void (async () => {
    const { app, webContents, BaseWindow, nativeTheme } = await import('electron')
    const runDir = process.env.AA_UI_UX_DIR
    const checks = []
    const errors = []
    const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
    const literal = (value) => JSON.stringify(value).replace(/</g, '\\u003c')
    async function until(fn, label) {
      const end = Date.now() + 15_000
      while (Date.now() < end) { if (await fn()) return; await pause(40) }
      throw new Error(`Timed out: ${label}`)
    }
    function check(name, passed, details) {
      checks.push({ name, passed: !!passed, details })
      console.log(`${passed ? 'PASS' : baseline ? 'BASELINE FAIL' : 'FAIL'}: ${name}${details ? ' ' + JSON.stringify(details) : ''}`)
    }
    app.setAppPath(ROOT)
    await import(pathToFileURL(path.join(ROOT, 'out/main/index.js')).href)
    await app.whenReady()
    let chrome
    await until(() => (chrome = webContents.getAllWebContents().find((wc) => wc.getURL().endsWith('/renderer/index.html'))), 'shell')
    const ui = (code) => chrome.executeJavaScript(code, true)
    await until(() => ui('!!window.aa && !!document.querySelector("#btn-settings")'), 'renderer ready')
    chrome.on('console-message', (event) => { if (event.level === 'error') errors.push(event.message) })
    const win = BaseWindow.getAllWindows()[0]
    win.show()
    chrome.setBackgroundThrottling(false)
    const click = (selector) => ui(`document.querySelector(${literal(selector)}).click()`)
    const key = async (keyCode, modifiers = []) => {
      const target = webContents.getFocusedWebContents() ?? chrome
      target.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
      target.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
      await pause(100)
    }
    const openSettings = async () => {
      await ui('document.querySelector("#set-engine").replaceChildren(); document.querySelector("#set-client-list").setAttribute("aria-busy", "true")')
      await click('#btn-settings')
      await until(() => ui('!document.querySelector("#settings-modal").hidden && document.querySelector("#set-engine").options.length > 0 && document.querySelector("#set-client-list").getAttribute("aria-busy") !== "true"'), 'settings ready')
    }
    const saveTheme = async (theme) => {
      await ui(`document.querySelector('#set-theme').value=${literal(theme)}; document.querySelector('#set-theme').dispatchEvent(new Event('change'))`)
      await click('#btn-save-settings')
      await until(() => ui(`window.aa.settingsGet().then(v => v.settings.theme === ${literal(theme)} && !document.querySelector('#btn-save-settings').disabled)`), 'theme saved')
      await pause(100)
    }
    const capture = async (name, wc = chrome) => {
      await pause(200)
      fs.writeFileSync(path.join(runDir, name + '.png'), (await wc.capturePage()).toPNG())
    }
    const contrastExpr = `(() => {
      const e = document.querySelector('.dl-item.done .dl-state');
      const parse = s => s.match(/[\\d.]+/g).map(Number);
      let bg = [17,22,25];
      const ancestors = []; for (let a=e; a; a=a.parentElement) ancestors.unshift(a);
      for (const a of ancestors) { const c=parse(getComputedStyle(a).backgroundColor); const alpha=c[3] ?? 1; bg=bg.map((v,i)=>c[i]*alpha+v*(1-alpha)); }
      const fg=parse(getComputedStyle(e).color);
      const lum = c => c.slice(0,3).map(v => { v/=255; return v<=.04045?v/12.92:((v+.055)/1.055)**2.4 }).reduce((v,c,i)=>v+c*[.2126,.7152,.0722][i],0);
      const l=[lum(fg),lum(bg)].sort((a,b)=>a-b);
      return { foreground: fg, background: bg, ratio: (l[1]+.05)/(l[0]+.05) };
    })()`

    // Reproduce a real disabled action state without scanning/writing any client configuration.
    await openSettings()
    const setupDisabled = await ui('document.querySelector("#btn-client-setup").disabled')
    await ui('document.querySelector("#btn-client-setup").disabled=true; document.querySelector("#btn-client-scan").focus()')
    chrome.focus()
    await key('Tab')
    const tabFocus = await ui('document.activeElement.id')
    check('settings Tab skips disabled actions', tabFocus === 'set-auto-update', { tabFocus })
    await ui(`document.querySelector('#btn-client-setup').disabled=${literal(setupDisabled)}`)
    for (const id of ['set-engine', 'set-engine-url', 'set-download-dir', 'set-allowed-sites']) {
      const label = await ui(`(() => {
        const e=document.getElementById(${literal(id)});
        const refs=(e.getAttribute('aria-labelledby') || '').split(/\\s+/).filter(Boolean);
        const described=(e.getAttribute('aria-describedby') || '').split(/\\s+/).filter(Boolean);
        const referencesResolve=[...refs,...described].every(id=>!!document.getElementById(id)?.textContent.trim());
        const name=refs.length ? refs.map(id=>document.getElementById(id)?.textContent.trim() || '').join(' ') : e.getAttribute('aria-label') || Array.from(e.labels || []).map(l=>l.textContent.trim()).join(' ');
        return {name,referencesResolve};
      })()`)
      check(`${id} has a persistent accessible label`, !!label.name.trim() && label.referencesResolve, label)
    }
    await click('#btn-close-settings')

    const initial = await ui('window.aa.getState()')
    await ui('window.aa.tabNew(); window.aa.tabNew()')
    await until(() => ui(`window.aa.getState().then(s=>s.tabs.length === ${initial.tabs.length + 2} && s.tabs.every(t=>!t.loading))`), 'three tabs')
    const tabs = (await ui('window.aa.getState()')).tabs
    await ui(`window.aa.tabSelect(${literal(tabs[0].id)})`)
    chrome.focus()
    await ui(`document.querySelector('[data-tab-id="${tabs[0].id}"]').focus()`)
    await key('Right')
    await until(() => ui(`window.aa.getState().then(s=>s.activeId === ${literal(tabs[1].id)})`), 'arrow-selected tab')
    const arrowFocus = webContents.getFocusedWebContents() === chrome
    const focusedAfterFirstArrow = webContents.getFocusedWebContents()
    check('tab arrow selection retains shell keyboard focus', arrowFocus, { focusedURL: focusedAfterFirstArrow?.getURL(), activeId: (await ui('window.aa.getState()')).activeId, expectedId: tabs[1].id })
    await key('Right')
    const secondArrow = (await ui('window.aa.getState()')).activeId
    check('two consecutive arrows select two successive tabs', secondArrow === tabs[2].id, { secondArrow, focusedURL: webContents.getFocusedWebContents()?.getURL(), expectedId: tabs[2].id })
    for (const [keyCode,index,label] of [['Left',1,'Left selects the previous tab'],['Home',0,'Home selects the first tab'],['Left',2,'Left wraps from the first to last tab'],['Right',0,'Right wraps from the last to first tab'],['End',2,'End selects the last tab']]) {
      await key(keyCode)
      const selected = (await ui('window.aa.getState()')).activeId
      check(label, selected === tabs[index].id && webContents.getFocusedWebContents() === chrome, {selected,expectedId:tabs[index].id})
    }
    chrome.focus()
    chrome.sendInputEvent({ type: 'mouseMove', x: 5, y: 90 })
    await ui('document.querySelector(".tab:not(.active) .close").focus()')
    await pause(200)
    check('inactive tab close button is visible when keyboard focused', await ui('Number(getComputedStyle(document.activeElement).opacity) > 0'))
    await ui('document.querySelector("#omnibox").focus(); document.querySelector("#omnibox").value="ui-suggestion"; document.querySelector("#omnibox").dispatchEvent(new Event("input"))')
    await until(() => ui('document.querySelectorAll(".suggest-item").length === 8 && !document.querySelector("#suggest-panel").hidden'), 'history suggestions')
    for (let i=0; i<8; i++) await key('Down')
    const suggestion = await ui(`(() => { const p=document.querySelector('#suggest-panel').getBoundingClientRect(); const r=document.querySelector('.suggest-item.selected').getBoundingClientRect(); return {visible:r.top>=p.top&&r.bottom<=p.bottom,top:r.top,bottom:r.bottom,panelBottom:p.bottom}; })()`)
    check('keyboard-selected history suggestion stays visible', suggestion.visible, suggestion)
    await capture('history-selected-last')
    await key('Escape')

    // Synthetic state fixtures exercise real renderers; business/API behavior is tested in test:desktop.
    const live = await ui('window.aa.getState()')
    const fixture = { ...live,
      downloads: [{ id: 'ui-download', filename: 'UI regression — completed.txt', url: 'https://example.com/fixture', state: 'completed', receivedBytes: 2048, totalBytes: 2048, startedAt: Date.now() }],
      pendingApprovals: [{ id: 'ui-approval', kind: 'operation', site: 'https://example.com', tabTitle: 'UI regression', fieldLabel: 'Submit test form', detail: 'Isolated UI fixture — no action will be submitted.' }],
      agentActivity: { active: true, paused: false, tool: 'browser_wait', startedAt: Date.now(), calls: [{ id: 999, client: 1, tool: 'browser_wait', startedAt: Date.now(), progress: 1, total: 10, message: 'UI regression progress' }] }
    }
    const send = async (value) => { chrome.send('aa:state', value); await pause(100) }
    await send(fixture)
    await click('#btn-downloads')
    for (const selector of ['.tab.active .close', '.approval-allow', '.dl-act', '.agent-call-stop']) {
      chrome.focus()
      await ui(`document.querySelector(${literal(selector)}).focus()`)
      await send({ ...fixture, downloads: fixture.downloads.map(d=>({ ...d, receivedBytes: 2049 })) })
      const focused = await ui(`document.activeElement.matches(${literal(selector)})`)
      check(`state refresh preserves focus: ${selector}`, focused)
    }
    // Opening the finder is an intentional focus change, not a lost-list focus.
    chrome.focus()
    await ui('document.querySelector(".tab.active .close").focus()')
    await send({ ...fixture, find: {open:true,query:'',matches:0,activeMatch:0} })
    check('opening finder takes priority over restoring old list focus', await ui('document.activeElement.id === "find-query"'))
    await send(fixture)
    // A background page must not lose focus just because shell state changes.
    const page = win.contentView.children.map(view=>view.webContents).find(wc=>wc !== chrome && /newtab\.html/.test(wc.getURL()))
    assert.ok(page, 'real internal page must exist')
    page.focus()
    await send(fixture)
    check('state refresh does not steal focus from webpage', webContents.getFocusedWebContents() === page)

    for (const theme of ['light', 'dark']) {
      await click('#btn-downloads') // close before settings
      await openSettings()
      await saveTheme(theme)
      for (const section of ['general', 'browsing', 'data', 'ai', 'update']) {
        await ui(`document.getElementById('settings-section-${section}').scrollIntoView({block:'start'})`)
        await capture(`${theme}-settings-${section}`)
      }
      const labels = await ui(`Array.from(document.querySelectorAll('.settings-label,.settings-hint,.settings-section-desc')).filter(e=>e.scrollWidth>e.clientWidth+1).map(e=>e.id)`)
      check(`${theme} settings text has no horizontal clipping`, labels.length === 0, labels)
      await click('#btn-close-settings')
      await send({ ...live, downloads: fixture.downloads })
      await click('#btn-downloads')
      const contrast = await ui(contrastExpr)
      check(`${theme} completed download text meets 4.5:1`, contrast.ratio >= 4.5, contrast)
      await capture(`${theme}-downloads`)
      await click('#btn-downloads')
      await send({ ...live, pendingApprovals: fixture.pendingApprovals })
      await capture(`${theme}-approval`)
      await send({ ...live, agentActivity: fixture.agentActivity })
      await capture(`${theme}-agent-progress`)
      await send(live)
      await click('#btn-feed')
      await capture(`${theme}-activity-feed`)
      await click('#btn-feed')
      await capture(`${theme}-newtab`, page)
      const noteContrast = await page.executeJavaScript(`(() => {
        const rgb=s=>s.match(/[\\d.]+/g).map(Number);
        const lum=c=>c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((v,c,i)=>v+c*[.2126,.7152,.0722][i],0);
        const n=document.querySelector('.prompt-note'); const f=lum(rgb(getComputedStyle(n).color)); const b=lum(rgb(getComputedStyle(n.closest('.prompt-panel')).backgroundColor)); return (Math.max(f,b)+.05)/(Math.min(f,b)+.05);
      })()`)
      check(`${theme} newtab note meets 4.5:1`, noteContrast >= 4.5, { ratio: noteContrast })
    }
    await send(live)
    win.setContentSize(960, 640)
    await pause(150)
    const crowded = { ...live, windowHeight: win.getContentBounds().height, pendingApprovals: fixture.pendingApprovals,
      downloads: Array.from({length:10},(_,i)=>({...fixture.downloads[0],id:`ui-download-${i}`})),
      recentActions: Array.from({length:20},(_,i)=>({id:i,tool:'browser_snapshot',summary:'UI regression activity',ts:Date.now()})),
      update: {...live.update,status:'downloading',noticeVisible:true,progress:40}, find:{open:true,query:'',matches:0,activeMatch:0} }
    await send(crowded)
    for (const [button,panel] of [['#btn-downloads','#download-panel'],['#btn-feed','#action-feed-drawer']]) {
      await click(button)
      await pause(300)
      const rect = await ui(`(() => {const e=document.querySelector(${literal(panel)}); const r=e.getBoundingClientRect(); const c=e.querySelector('.drawer-content'); return {bottom:r.bottom,top:r.top,height:r.height,scrollable:c.scrollHeight>c.clientHeight};})()`)
      check(`${panel} fits minimum window with all notification bars`, rect.bottom <= win.getContentBounds().height && rect.height>80 && rect.scrollable, rect)
      await capture(`crowded-${panel.slice(1)}`)
    }
    await click('#btn-feed')
    await send(live)

    for (const [width,height] of [[1920,1080],[1600,900],[1366,768],[1280,720],[1024,768],[960,640]]) {
      win.setContentSize(width,height)
      await pause(150)
      await openSettings()
      const geometry = await ui(`(() => { const c=document.querySelector('.settings-card').getBoundingClientRect(); const b=document.querySelector('#settings-body'); const f=document.querySelector('#btn-save-settings').getBoundingClientRect(); return {width:innerWidth,height:innerHeight,overflow:b.scrollWidth-b.clientWidth,cardFits:c.left>=0&&c.top>=0&&c.right<=innerWidth+1&&c.bottom<=innerHeight+1,saveFits:f.bottom<=innerHeight&&f.right<=innerWidth}; })()`)
      check(`desktop layout ${width}x${height}`, geometry.overflow <= 1 && geometry.cardFits && geometry.saveFits, geometry)
      if (width === 960 || width === 1920) await capture(`layout-${width}x${height}`)
      await click('#btn-close-settings')
    }
    win.maximize()
    await pause(150)
    check('maximized shell has no horizontal overflow', await ui('document.documentElement.scrollWidth <= innerWidth+1'))
    win.unmaximize()
    await openSettings()
    await saveTheme('system')
    await click('#btn-close-settings')
    const oldSource = nativeTheme.themeSource
    for (const source of ['dark','light']) {
      nativeTheme.themeSource = source
      await until(() => ui(`document.documentElement.dataset.theme === ${literal(source)}`), `system ${source} shell`)
      await until(() => page.executeJavaScript(`document.documentElement.dataset.theme === ${literal(source)}`), `system ${source} newtab`)
      check(`system theme change follows ${source} in shell and newtab`, true)
    }
    nativeTheme.themeSource = oldSource
    check('renderer console has no errors', errors.length === 0, errors)
    const failed = checks.filter(c=>!c.passed)
    fs.writeFileSync(path.join(runDir,'result.json'), JSON.stringify({ mode: baseline ? 'baseline' : 'regression', status: failed.length ? baseline ? 'BASELINE' : 'FAIL' : 'PASS', checks, failed: failed.length, errors }, null, 2))
    console.log(`UI/UX: ${checks.length-failed.length}/${checks.length} passed; ${failed.length} failed; ${runDir}`)
    process.exitCode = baseline || failed.length === 0 ? 0 : 1
    app.quit()
  })().catch(async (error) => {
    console.error(error)
    const { app } = await import('electron')
    app.exit(1)
  })
}
