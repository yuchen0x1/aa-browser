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
  fs.writeFileSync(path.join(runDir, 'history/history.json'), JSON.stringify(Array.from({ length: 8 }, (_, i) => ({ url: `https://ui-suggestion.test/${i}`, title: `UI suggestion ${i} ${'LongUnbrokenHistoryTitle'.repeat(12)}`, ts: Date.now(), count: 8-i }))))
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
    const { app, webContents, BaseWindow, nativeTheme, ipcMain } = await import('electron')
    if (process.env.AA_UI_UX_SCALE) {
      const scale = Number(process.env.AA_UI_UX_SCALE)
      assert.ok(Number.isFinite(scale) && scale > 0, 'UI scale must be positive')
      app.commandLine.appendSwitch('force-device-scale-factor', String(scale))
    }
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
    app.getVersion = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
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
      if (keyCode === 'Enter' || keyCode === 'Space') target.sendInputEvent({ type: 'char', keyCode: keyCode === 'Space' ? ' ' : '\r', modifiers })
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
      const view = win.contentView.children.find(view => view.webContents === wc)
      assert.ok(view, `${name}: capture target must be attached to the native window`)
      let originalBounds
      try {
        // State-only HUD fixtures bypass main-process activity; reproduce its full-window view bounds for evidence.
        let clip
        if (wc === chrome && name.endsWith('-agent-progress') && await ui('!document.querySelector("#agent-activity-overlay").hidden')) {
          const content = win.getContentBounds()
          originalBounds = view.getBounds()
          view.setBounds({x:0,y:0,width:content.width,height:content.height})
          // Crop to the HUD itself: capturing transparent gaps can return unrelated compositor output.
          clip = await ui(`(() => {const r=document.querySelector('#agent-activity-card').getBoundingClientRect();return {x:Math.floor(r.x),y:Math.floor(r.y),width:Math.ceil(r.width),height:Math.ceil(r.height)};})()`)
        }
        await pause(400)
        const image = await wc.capturePage(clip)
        assert.ok(!image.isEmpty(), `${name}: compositor returned an empty screenshot`)
        fs.writeFileSync(path.join(runDir, name + '.png'), image.toPNG())
      } catch (error) {
        const visibility = !wc.isDestroyed()
          ? await wc.executeJavaScript('document.visibilityState').catch(() => 'unavailable')
          : 'destroyed'
        const details = {
          attached: win.contentView.children.includes(view), bounds: view.getBounds(),
          shellBounds: win.contentView.children.find(child => child.webContents === chrome)?.getBounds(),
          viewVisible: view.getVisible(), windowVisible: win.isVisible(), windowFocused: win.isFocused(),
          targetFocused: webContents.getFocusedWebContents() === wc, visibility
        }
        throw new Error(`Capture ${name}: ${String(error)} ${JSON.stringify(details)}`, { cause: error })
      } finally {
        if (originalBounds) view.setBounds(originalBounds)
      }
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

    // Boundary states must be measured with real input, not forced pseudo-classes.
    const systemSource = nativeTheme.themeSource
    const systemDark = nativeTheme.shouldUseDarkColors
    for (const theme of ['light', 'dark']) {
      await openSettings()
      await saveTheme(theme)
      check(`${theme} shell theme does not override external webpage system preference`, nativeTheme.themeSource === systemSource && nativeTheme.shouldUseDarkColors === systemDark, { source: nativeTheme.themeSource })
      const point = await ui(`(() => { const r=document.querySelector('#btn-save-settings').getBoundingClientRect(); return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}; })()`)
      // Modal bounds reach main via IPC; at forced DPI the renderer can be ready before its native view.
      await until(() => win.contentView.children.find(view=>view.webContents === chrome)?.getBounds().height > point.y, 'native modal bounds before hover')
      win.focus()
      chrome.focus()
      chrome.sendInputEvent({type:'mouseMove',x:5,y:90})
      await pause(250)
      let hover
      // Accept the first hovered style sample, not an earlier hover check followed by a separate measurement.
      await until(async () => {
        chrome.sendInputEvent({type:'mouseMove',...point})
        hover = await ui(`(() => { const e=document.querySelector('#btn-save-settings'); const s=getComputedStyle(e); const rgb=value=>(value.match(/[\\d.]+/g)||[]).map(Number).slice(0,3); const lum=color=>color.map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0); const brightness=Number(s.filter.match(/brightness\\(([\\d.]+)\\)/)?.[1]||1); const light=value=>lum(rgb(value).map(v=>Math.min(255,v*brightness))); const fg=light(s.color); const ratios=(s.backgroundImage.match(/rgba?\\([^)]+\\)/g)||[]).map(value=>{const bg=light(value);return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05)}); return {hovered:e.matches(':hover'),image:s.backgroundImage,color:s.color,background:s.backgroundColor,minimumContrast:ratios.length?Math.min(...ratios):0}; })()`)
        return hover.hovered
      }, 'real primary hover')
      check(`${theme} primary button preserves its accent surface and 4.5:1 text on hover`, hover.hovered && hover.image.includes('linear-gradient') && hover.minimumContrast >= 4.5, hover)
      // Later captures are supplementary; the sampled computed style above is the hover evidence.
      await capture(`${theme}-primary-hover`)
      chrome.sendInputEvent({type:'mouseMove',x:5,y:90})
      await click('#btn-close-settings')
    }
    await openSettings()
    const isolatedSettings = await ui(`(() => {const modal=document.querySelector('#settings-modal');const before=document.activeElement;document.querySelector('#omnibox').focus();return {backgroundIsolated:Array.from(modal.parentElement.children).filter(e=>e instanceof HTMLElement&&e!==modal).every(e=>e.inert),focusRetained:document.activeElement===before};})()`)
    check('settings modal makes its background inert and blocks programmatic background focus', isolatedSettings.backgroundIsolated && isolatedSettings.focusRetained, isolatedSettings)
    let modalPrintRequests = 0
    const originalPrints = new Map()
    const stubPrint = (wc) => {
      originalPrints.set(wc, wc.print)
      wc.print = (_options, callback) => { modalPrintRequests++; callback?.(true, '') }
    }
    const onPrintTargetCreated = (_event, wc) => stubPrint(wc)
    app.on('web-contents-created', onPrintTargetCreated)
    webContents.getAllWebContents().forEach(stubPrint)
    // Count requests without ever submitting a native print job, even if the modal guard regresses.
    for (const keyCode of ['L','F','T','W','P']) {
      const tabIds = (await ui('window.aa.getState()')).tabs.map(tab=>tab.id)
      chrome.focus()
      await ui('document.querySelector("#set-engine-url").focus()')
      await key(keyCode,['control'])
      const modalFocus = await ui('window.aa.getState().then(s=>({inside:document.querySelector("#settings-modal").contains(document.activeElement),id:document.activeElement.id,tabs:s.tabs.map(t=>t.id)}))')
      check(`settings modal contains Ctrl+${keyCode} without changing background tabs`, modalFocus.inside && JSON.stringify(modalFocus.tabs) === JSON.stringify(tabIds) && modalPrintRequests === 0, { ...modalFocus, printRequests: modalPrintRequests })
    }
    app.removeListener('web-contents-created', onPrintTargetCreated)
    for (const [wc, print] of originalPrints) if (!wc.isDestroyed()) wc.print = print
    await click('#btn-close-settings')
    check('closing settings restores background focusability', await ui(`(() => {const e=document.querySelector('#omnibox');e.focus();return !e.closest('[inert]')&&document.activeElement===e;})()`))
    await ui('window.aa.findClose()')
    await openSettings()
    const selections = await ui('Array.from(document.querySelectorAll("#set-client-list input")).map(e=>[e.dataset.id,e.checked])')
    await ui('document.querySelector("#set-locale").value="en-US"; document.querySelector("#set-locale").dispatchEvent(new Event("change"))')
    const dynamicLocale = await ui(`({badges:Array.from(document.querySelectorAll('.client-pill')).map(e=>e.textContent),names:Array.from(document.querySelectorAll('.client-name')).map(e=>e.textContent),engines:Array.from(document.querySelectorAll('#set-engine option')).map(e=>e.textContent),agent:document.querySelector('#set-agent-info').textContent,selections:Array.from(document.querySelectorAll('#set-client-list input')).map(e=>[e.dataset.id,e.checked])})`)
    // User data (including a Unicode discovery-file path) is not interface copy to translate.
    const translatedAgent = dynamicLocale.agent.split(' · discovery file ')[0]
    check('English preview translates dynamic client badges and service details without losing selections', !/[\u3400-\u9fff]/.test(dynamicLocale.badges.join(' ') + dynamicLocale.names.join(' ') + dynamicLocale.engines.join(' ') + translatedAgent) && JSON.stringify(dynamicLocale.selections) === JSON.stringify(selections), dynamicLocale)
    await ui('document.querySelector("#settings-section-ai").scrollIntoView({block:"start"})')
    await capture('english-dynamic-clients')
    await ui('document.querySelector("#set-engine-url").value="not-a-valid-search-url"')
    await click('#btn-save-settings')
    await until(() => ui('!document.querySelector("#btn-save-settings").disabled && !!document.querySelector("#settings-status").textContent.trim()'), 'invalid settings feedback')
    const saveError = await ui(`(() => {const e=document.querySelector('#settings-status'); const marker=document.createElement('span');marker.style.color='var(--danger-ink)';document.body.append(marker);const danger=getComputedStyle(marker).color;marker.remove();return {state:e.dataset.state,text:e.textContent,color:getComputedStyle(e).color,danger};})()`)
    check('failed settings save has error semantics and a readable error color', saveError.state === 'error' && saveError.color === saveError.danger && !!saveError.text, saveError)
    await capture('settings-save-error')
    await click('#btn-close-settings')

    // Reproduce a real disabled action state without scanning/writing any client configuration.
    await openSettings()
    const setupDisabled = await ui('document.querySelector("#btn-client-setup").disabled')
    await ui('document.querySelector("#btn-client-setup").disabled=true; document.querySelector("#btn-client-scan").focus()')
    chrome.focus()
    await key('Tab')
    const tabFocus = await ui('document.activeElement.id')
    check('settings Tab skips disabled setup and reaches the connection details', tabFocus === 'set-agent-details-label', { tabFocus })
    // A failed focus assertion must not activate the copy button or touch the system clipboard.
    if (tabFocus === 'set-agent-details-label') await key('Enter')
    check('local connection details can be opened with the keyboard', await ui('document.querySelector(".connection-details").open'))
    await key('Tab')
    const diagnosticsFocus = await ui('document.activeElement.id')
    check('copy diagnostics is next in the keyboard order', diagnosticsFocus === 'btn-copy-connection-diagnostics', { diagnosticsFocus })
    await key('Tab')
    // The extensions section sits between AI integration and software update; the load button must be reachable here.
    check('one Tab continues from connection diagnostics into the extensions section', await ui('document.activeElement.id === "btn-extension-load"'))
    await key('Tab')
    check('the next Tab reaches the extensions rescan button', await ui('document.activeElement.id === "btn-extension-rescan"'))
    await key('Tab')
    check('Tab continues from extensions to update settings', await ui('document.activeElement.id === "set-auto-update"'))
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
    const initialPage = win.contentView.children.find(view => view.webContents !== chrome)?.webContents
    assert.ok(initialPage, 'initial page must be attached')
    const tabContentsIds = new Map([[initial.activeId, initialPage.id]])
    const assertTabView = (id) => {
      assert.ok(tabContentsIds.has(id), `missing WebContents mapping for tab ${id}`)
      assert.deepEqual(win.contentView.children.map(view => view.webContents?.id), [tabContentsIds.get(id), chrome.id], `tab ${id} must be the only page view, below the shell`)
    }
    assertTabView(initial.activeId)
    // All fixture pages use the same URL. Pair each newly created tab with its new WebContents independently of attachment.
    for (let i = 0; i < 2; i++) {
      const known = new Set(webContents.getAllWebContents().map(wc => wc.id))
      assert.equal(await ui('window.aa.tabNew()'), true)
      const [newTab, ...otherTabs] = (await ui('window.aa.getState()')).tabs.filter(tab => !tabContentsIds.has(tab.id))
      const [newContents, ...otherContents] = webContents.getAllWebContents().filter(wc => !known.has(wc.id))
      assert.ok(newTab && newContents && !otherTabs.length && !otherContents.length, 'tabNew must create exactly one tab and WebContents')
      tabContentsIds.set(newTab.id, newContents.id)
    }
    await until(() => ui(`window.aa.getState().then(s=>s.tabs.length === ${initial.tabs.length + 2} && s.tabs.every(t=>!t.loading))`), 'three tabs')
    const tabs = (await ui('window.aa.getState()')).tabs
    const inactiveClose = await ui('Array.from(document.querySelectorAll(".tab:not(.active) .close")).map(e=>e.tabIndex)')
    check('inactive tab close buttons stay outside sequential Tab navigation', inactiveClose.every(value=>value === -1), inactiveClose)
    await ui(`window.aa.tabSelect(${literal(tabs[0].id)}, false)`)
    await until(async () => (await ui(`window.aa.getState().then(s=>s.activeId === ${literal(tabs[0].id)})`)) && webContents.getFocusedWebContents() === chrome, 'initial keyboard tab selection')
    assertTabView(tabs[0].id)
    chrome.focus()
    await ui(`document.querySelector('[data-tab-id="${tabs[0].id}"]').focus(); window.__nextTabProbe = document.querySelector('[data-tab-id="${tabs[1].id}"]')`)
    // 切换标签后原生窗口焦点短暂悬空（focusedURL=null）；等外壳重新拿到焦点再发键，避免按键落空。
    await until(() => webContents.getFocusedWebContents() === chrome, 'chrome focused before arrow key')
    await key('Right')
    try {
      await until(async () => (await ui(`window.aa.getState().then(s=>s.activeId === ${literal(tabs[1].id)})`)) && (await ui(`document.querySelector('[data-tab-id="${tabs[1].id}"]')?.getAttribute('aria-selected') === 'true'`)) && webContents.getFocusedWebContents() === chrome, 'arrow-selected tab, rendered selection and native shell focus')
    } catch (error) {
      // Dump the exact keyboard-relevant state so runner-specific focus races
      // are diagnosable from CI logs instead of a bare timeout.
      const state = await ui('window.aa.getState()')
      const diagnostics = {
        activeId: state.activeId,
        expectedId: tabs[1].id,
        tabs: state.tabs.map((t) => ({ id: t.id, url: t.url, loading: t.loading, active: t.active })),
        focusedURL: webContents.getFocusedWebContents()?.getURL() ?? null,
        focusedIsChrome: webContents.getFocusedWebContents() === chrome,
        allWebContents: webContents.getAllWebContents().map((wc) => wc.getURL()),
        dom: await ui('({hasFocus:document.hasFocus(),focusKey:document.activeElement?.dataset.focusKey,tabRetained:window.__nextTabProbe?.isConnected})'),
      }
      throw new Error(`${error.message} ${JSON.stringify(diagnostics)}`, { cause: error })
    }
    assertTabView(tabs[1].id)
    // arrow selection already proves DOM focus retention on the first run; a second
    // pass after the rAF-driven reveal settles removes the reveal-timing flake.
    await pause(80)
    check('changing the active tab does not replace its focused DOM node', await ui('document.activeElement === window.__nextTabProbe && window.__nextTabProbe.getAttribute("aria-selected") === "true"'))
    await ui('delete window.__nextTabProbe')
    const arrowFocus = webContents.getFocusedWebContents() === chrome
    const focusedAfterFirstArrow = webContents.getFocusedWebContents()
    check('tab arrow selection retains shell keyboard focus', arrowFocus, { focusedURL: focusedAfterFirstArrow?.getURL(), activeId: (await ui('window.aa.getState()')).activeId, expectedId: tabs[1].id })
    await key('Right')
    await until(async () => (await ui(`window.aa.getState().then(s=>s.activeId === ${literal(tabs[2].id)})`)) && webContents.getFocusedWebContents() === chrome, 'second keyboard tab and native shell focus')
    assertTabView(tabs[2].id)
    const secondArrow = (await ui('window.aa.getState()')).activeId
    check('two consecutive arrows select two successive tabs', secondArrow === tabs[2].id, { secondArrow, focusedURL: webContents.getFocusedWebContents()?.getURL(), expectedId: tabs[2].id })
    for (const [keyCode,index,label] of [['Left',1,'Left selects the previous tab'],['Home',0,'Home selects the first tab'],['Left',2,'Left wraps from the first to last tab'],['Right',0,'Right wraps from the last to first tab'],['End',2,'End selects the last tab']]) {
      await key(keyCode)
      await until(async () => (await ui(`window.aa.getState().then(s=>s.activeId === ${literal(tabs[index].id)})`)) && webContents.getFocusedWebContents() === chrome, label)
      assertTabView(tabs[index].id)
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
    const combo = await ui(`(() => { const e=document.querySelector('#omnibox'); const list=document.getElementById(e.getAttribute('aria-controls')); return {role:e.getAttribute('role'),expanded:e.getAttribute('aria-expanded'),listRole:list?.getAttribute('role')}; })()`)
    check('history suggestions expose an expanded combobox controlling a listbox', combo.role === 'combobox' && combo.expanded === 'true' && combo.listRole === 'listbox', combo)
    const suggestionWidth = await ui('({scroll:document.querySelector("#suggest-panel").scrollWidth,client:document.querySelector("#suggest-panel").clientWidth})')
    check('long history titles truncate inside the suggestion panel', suggestionWidth.scroll <= suggestionWidth.client + 1, suggestionWidth)
    for (let i=0; i<8; i++) await key('Down')
    const suggestion = await ui(`(() => {
      const input = document.querySelector('#omnibox');
      const selected = document.querySelector('.suggest-item.selected[aria-selected="true"]');
      const p = document.querySelector('#suggest-panel').getBoundingClientRect();
      const r = selected?.getBoundingClientRect();
      return {focused:document.hasFocus() && document.activeElement === input,
        selected:!!selected && input.getAttribute('aria-activedescendant') === selected.id,
        visible:!!r && r.top>=p.top && r.bottom<=p.bottom,top:r?.top,bottom:r?.bottom,panelBottom:p.bottom};
    })()`)
    check('keyboard-selected history suggestion stays visible', suggestion.visible, suggestion)
    const nativeFocus = webContents.getFocusedWebContents() === chrome
    check('omnibox keeps native and DOM focus and a selected option before narrowing', nativeFocus && suggestion.focused && suggestion.selected, {nativeFocus, ...suggestion})
    await ui('(() => {const input=document.querySelector("#omnibox");input.value="https://ui-suggestion.test/0";input.dispatchEvent(new Event("input"));})()')
    await until(() => ui('document.querySelectorAll(".suggest-item").length === 1 && !document.querySelector("#suggest-panel").hidden'), 'narrowed history results')
    const activeDescendant = await ui(`(() => {const e=document.querySelector('#omnibox');const id=e.getAttribute('aria-activedescendant');return {id,resolves:!id||!!document.getElementById(id)};})()`)
    check('rebuilt suggestions never reference a removed active option', activeDescendant.resolves, activeDescendant)
    await capture('history-narrowed-results')
    await ui('window.aa.findOpen()')
    await until(() => ui('!document.querySelector("#find-bar").hidden'), 'finder before suggestion Escape')
    chrome.focus()
    await ui('document.querySelector("#omnibox").focus(); document.querySelector("#omnibox").value="ui-suggestion"; document.querySelector("#omnibox").dispatchEvent(new Event("input"))')
    await until(() => ui('!document.querySelector("#suggest-panel").hidden'), 'suggestions above finder')
    await key('Escape')
    const suggestEscape = await ui('window.aa.getState().then(s=>({finder:s.find.open,hidden:document.querySelector("#suggest-panel").hidden,expanded:document.querySelector("#omnibox").getAttribute("aria-expanded")}))')
    check('Escape closes only history suggestions without closing finder', suggestEscape.finder && suggestEscape.hidden && suggestEscape.expanded === 'false', suggestEscape)
    await pause(300)
    check('dismissed suggestions stay closed while the omnibox retains focus', await ui('document.querySelector("#suggest-panel").hidden && document.activeElement.id === "omnibox"'))
    await key('Escape')
    check('Escape without suggestions reaches the underlying finder', await ui('window.aa.getState().then(s=>!s.find.open)'))
    await ui('window.aa.findClose()')
    chrome.focus()
    await ui('document.querySelector("#btn-find").focus()')
    await key('Enter')
    await until(() => ui('document.activeElement.id === "find-query"'), 'keyboard finder opening')
    await key('Escape')
    await until(() => ui('document.querySelector("#find-bar").hidden'), 'keyboard finder closing')
    const findReturn = await ui('({id:document.activeElement.id,focused:document.hasFocus()})')
    check('closing finder restores a visible shell target without main-process page focus theft', findReturn.id === 'btn-find' && findReturn.focused && webContents.getFocusedWebContents() === chrome, findReturn)

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
    const progressing = {...fixture, downloads:fixture.downloads.map(d=>({...d,state:'progressing'}))}
    await send(progressing)
    chrome.focus()
    await ui(`document.querySelector('[data-focus-key="download-cancel:ui-download"]')?.focus()`)
    await send(fixture)
    const completionFocus = await ui('({key:document.activeElement.dataset.focusKey,id:document.activeElement.id})')
    check('completed download moves focus from removed cancel action to a surviving download action', completionFocus.key === 'download-open:ui-download', completionFocus)
    // Retry only exists for cancelled/interrupted downloads; completed ones must offer Open/Show instead.
    const retryableFixture = {...fixture, downloads: fixture.downloads.map(d => ({...d, state: 'cancelled'}))}
    await send(retryableFixture)
    await ui(`document.querySelector('[data-focus-key="download-retry:ui-download"]')?.click()`)
    await pause(200)
    const retryNotice = await ui(`(() => {const e=document.querySelector('#download-status');return {text:e?.textContent,live:e?.getAttribute('aria-live'),visible:!!e&&e.offsetParent!==null};})()`)
    check('download retry failure is visible and announced', !!retryNotice.text?.trim() && retryNotice.visible && !!retryNotice.live, retryNotice)
    await capture('download-retry-feedback')
    for (const selector of ['.tab.active .close', '.approval-allow', '.dl-act', '.agent-call-stop']) {
      chrome.focus()
      await ui(`document.querySelector(${literal(selector)}).focus()`)
      await send({ ...fixture, downloads: fixture.downloads.map(d=>({ ...d, receivedBytes: 2049 })) })
      const focused = await ui(`document.activeElement.matches(${literal(selector)})`)
      check(`state refresh preserves focus: ${selector}`, focused)
    }
    for (const [name,selector,next] of [
      ['approval resolution','.approval-allow',{...fixture,pendingApprovals:[]}],
      ['agent call completion','.agent-call-stop',{...fixture,agentActivity:{active:false,paused:false,calls:[]}}],
      ['tab removal','.tab.active .close',{...fixture,tabs:fixture.tabs.filter(tab=>tab.id !== fixture.activeId).map((tab,index)=>({...tab,active:index===0})),activeId:fixture.tabs.find(tab=>tab.id !== fixture.activeId)?.id}]
    ]) {
      await send(fixture)
      chrome.focus()
      await ui(`document.querySelector(${literal(selector)}).focus()`)
      await send(next)
      const fallback = await ui('({id:document.activeElement.id,key:document.activeElement.dataset.focusKey,visible:document.activeElement !== document.body && document.activeElement.offsetParent !== null})')
      check(`${name} retains a visible shell focus target`, fallback.visible, fallback)
    }
    await send(fixture)
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
      const longProgress = {...fixture.agentActivity, calls:fixture.agentActivity.calls.map(call=>({...call,message:'UnbrokenViewportName'.repeat(10)}))}
      await send({ ...live, agentActivity: longProgress })
      const hudView = win.contentView.children.find(view=>view.webContents === chrome)
      const hudBounds = hudView.getBounds()
      const content = win.getContentBounds()
      hudView.setBounds({x:0,y:0,width:content.width,height:content.height})
      await pause(100)
      const progressFits = await ui(`(() => {const row=document.querySelector('.agent-call-row');const stop=document.querySelector('.agent-call-stop');const r=row.getBoundingClientRect();const s=stop.getBoundingClientRect();const x=Math.round(s.x+s.width/2),y=Math.round(s.y+s.height/2);stop.dataset.testClicks='0';stop.addEventListener('click',()=>stop.dataset.testClicks=String(Number(stop.dataset.testClicks)+1),{once:true});return {scroll:row.scrollWidth,client:row.clientWidth,stopFits:s.right<=r.right&&s.left>=r.left&&s.top>=0&&s.bottom<=innerHeight,hit:document.elementFromPoint(x,y)===stop,x,y};})()`)
      chrome.focus()
      chrome.sendInputEvent({type:'mouseDown',x:progressFits.x,y:progressFits.y,button:'left',clickCount:1})
      chrome.sendInputEvent({type:'mouseUp',x:progressFits.x,y:progressFits.y,button:'left',clickCount:1})
      await pause(100)
      const stopClicked = await ui('document.querySelector(".agent-call-stop").dataset.testClicks === "1"')
      check(`${theme} long agent progress keeps its stop action visible and clickable`, progressFits.scroll <= progressFits.client+1 && progressFits.stopFits && progressFits.hit && stopClicked, {...progressFits,stopClicked})
      await capture(`${theme}-agent-progress`)
      hudView.setBounds(hudBounds)
      await send(live)
      await click('#btn-feed')
      await capture(`${theme}-activity-feed`)
      await click('#btn-feed')
      // Electron can report the background view as hidden right after the shell
      // reasserts its bounds; retry the evidence capture once instead of failing.
      try {
        await capture(`${theme}-newtab`, page)
      } catch (error) {
        await page.focus()
        await pause(300)
        await capture(`${theme}-newtab`, page)
      }
      const noteContrast = await page.executeJavaScript(`(() => {
        const rgb=s=>s.match(/[\\d.]+/g).map(Number);
        const lum=c=>c.slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4}).reduce((v,c,i)=>v+c*[.2126,.7152,.0722][i],0);
        const n=document.querySelector('.prompt-note'); const f=lum(rgb(getComputedStyle(n).color)); const b=lum(rgb(getComputedStyle(n.closest('.prompt-panel')).backgroundColor)); return (Math.max(f,b)+.05)/(Math.min(f,b)+.05);
      })()`)
      check(`${theme} newtab note meets 4.5:1`, noteContrast >= 4.5, { ratio: noteContrast })
    }
    await send(live)
    if (await ui('!document.querySelector("#download-panel").hidden')) await click('#btn-downloads')
    for (const [button,panel,close] of [['#btn-downloads','#download-panel','#btn-close-dl'],['#btn-feed','#action-feed-drawer','#btn-close-feed']]) {
      chrome.focus()
      await ui(`document.querySelector(${literal(button)}).focus()`)
      await key('Enter')
      check(`${panel} receives keyboard focus on opening`, await ui(`document.querySelector(${literal(panel)}).contains(document.activeElement)`))
      await ui(`document.querySelector(${literal(close)}).focus()`)
      await key('Enter')
      check(`${panel} close returns focus to its trigger`, await ui(`document.activeElement === document.querySelector(${literal(button)})`))
    }
    await ui('window.aa.findOpen()')
    await until(() => ui('!document.querySelector("#find-bar").hidden'), 'finder before drawer Escape')
    await click('#btn-downloads')
    chrome.focus()
    await ui('document.querySelector("#btn-close-dl").focus()')
    await key('Escape')
    const drawerEscape = await ui('window.aa.getState().then(s=>({findOpen:s.find.open,drawerHidden:document.querySelector("#download-panel").hidden,focus:document.activeElement.id}))')
    check('Escape closes only the top drawer and returns focus without closing finder', drawerEscape.findOpen && drawerEscape.drawerHidden && drawerEscape.focus === 'btn-downloads', drawerEscape)
    await ui('window.aa.findClose()')
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
      // Windows rounds content size to even pixels at forced DPI (1366 -> 1368) and
      // an immediate re-request can race the shell; wait for bounds to settle then
      // confirm the renderer viewport before measuring.
      // Windows 在强制 DPI 下会把内容尺寸取整到偶数像素（1366 -> 1368），
      // 且立即重请求可能与外壳竞争；等边界收敛后再确认渲染器视口。
      await until(() => {
        const bounds = win.getContentBounds()
        return Math.abs(bounds.width - width) <= 2
      }, `resize settled ${width}x${height}`)
      await pause(150)
      // 设置未打开时外壳视图只有工具栏高度，innerHeight 不等于窗口高度；宽度到位即可测量。
      await until(async () => {
        const size = await ui('({w:innerWidth})')
        return Math.abs(size.w - width) <= 2
      }, `renderer viewport width ${width}`)
      await openSettings()
      await ui('document.querySelector("#set-locale").value="en-US"; document.querySelector("#set-locale").dispatchEvent(new Event("change"))')
      const geometry = await ui(`(() => { const c=document.querySelector('.settings-card').getBoundingClientRect(); const b=document.querySelector('#settings-body'); const f=document.querySelector('#btn-save-settings').getBoundingClientRect(); return {width:innerWidth,height:innerHeight,devicePixelRatio,overflow:b.scrollWidth-b.clientWidth,cardFits:c.left>=0&&c.top>=0&&c.right<=innerWidth+1&&c.bottom<=innerHeight+1,saveFits:f.bottom<=innerHeight&&f.right<=innerWidth}; })()`)
      check(`English desktop layout ${width}x${height}`, geometry.overflow <= 1 && geometry.cardFits && geometry.saveFits, geometry)
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

    // Delayed IPC fixtures run last and never contact a server or write client configuration.
    let finishRetry
    let retryCalls = 0
    ipcMain.removeHandler('aa:download-retry')
    ipcMain.handle('aa:download-retry', () => {
      retryCalls++
      return new Promise(resolve => { finishRetry = resolve })
    })
    const delayedDownloads = {...live, downloads:[{...fixture.downloads[0], state:'cancelled'}, {...fixture.downloads[0],id:'ui-download-2',filename:'Second isolated file.txt',state:'cancelled'}]}
    await send(delayedDownloads)
    await click('#btn-downloads')
    chrome.focus()
    await ui(`document.querySelector('[data-focus-key="download-retry:ui-download"]').focus()`)
    await key('Enter')
    await until(() => retryCalls === 1, 'delayed retry started')
    const pendingFocus = await ui('({id:document.activeElement.id,key:document.activeElement.dataset.focusKey,body:document.activeElement===document.body})')
    check('keyboard retry keeps focus inside the drawer while the request is pending', pendingFocus.id === 'btn-close-dl' && !pendingFocus.body, pendingFocus)
    await send({...delayedDownloads,downloads:delayedDownloads.downloads.map(d=>({...d,receivedBytes:2050}))})
    await ui(`document.querySelector('[data-focus-key="download-retry:ui-download-2"]').dispatchEvent(new MouseEvent('click',{bubbles:true}))`)
    const pendingRetry = await ui(`Array.from(document.querySelectorAll('[data-focus-key^="download-retry:"]')).map(e=>e.disabled)`)
    check('download retry remains serialized after state rebuilds its buttons', retryCalls === 1 && pendingRetry.length === 2 && pendingRetry.every(Boolean), {retryCalls,disabled:pendingRetry})
    finishRetry({ok:false,reason:'Isolated delayed retry failure'})
    await until(() => ui(`Array.from(document.querySelectorAll('[data-focus-key^="download-retry:"]')).every(e=>!e.disabled)`), 'rebuilt retry buttons unlocked')
    const delayedError = await ui('({text:document.querySelector("#download-status").textContent,state:document.querySelector("#download-status").dataset.state,focus:document.activeElement.dataset.focusKey})')
    check('delayed retry unlocks current buttons, identifies the failed file and returns focus', delayedError.state === 'error' && delayedError.text.includes(fixture.downloads[0].filename) && delayedError.text.includes('Isolated delayed retry failure') && delayedError.focus === 'download-retry:ui-download', delayedError)
    await ui(`document.querySelector('[data-focus-key="download-retry:ui-download-2"]').click()`)
    await until(() => retryCalls === 2, 'second retry after completion')
    finishRetry({ok:true})
    await until(() => ui('document.querySelector("#download-status").dataset.state === "success"'), 'second retry acknowledged')
    check('another download can retry after the pending request finishes', await ui('document.querySelector("#download-status").textContent.includes("Second isolated file.txt")'))
    await click('#btn-close-dl')
    await send({...live,agentActivity:fixture.agentActivity})
    chrome.focus()
    await ui('document.querySelector(".agent-call-stop").focus()')
    await send({...live,agentActivity:{active:false,paused:false,calls:[]}})
    check('last agent call completion has a neutral focus fallback without an open drawer', await ui('document.activeElement.id === "btn-feed"') && webContents.getFocusedWebContents() === chrome)

    let finishSetup
    let setupCalls = 0
    let scanFails = false
    ipcMain.removeHandler('aa:clients-detect')
    ipcMain.removeHandler('aa:clients-setup')
    ipcMain.handle('aa:clients-detect', () => {
      if (scanFails) throw new Error('Isolated scan failure')
      return [{id:'ui-client',name:'Isolated UI client',installed:true,configured:false,outdated:false}]
    })
    ipcMain.handle('aa:clients-setup', () => {
      setupCalls++
      return new Promise(resolve => { finishSetup = resolve })
    })
    await openSettings()
    await click('#btn-client-setup')
    await until(() => setupCalls === 1, 'isolated client setup started')
    await ui('document.querySelector("#set-locale").value="en-US"; document.querySelector("#set-locale").dispatchEvent(new Event("change"))')
    await ui('document.querySelector("#btn-client-setup").dispatchEvent(new MouseEvent("click",{bubbles:true}))')
    const busySetup = await ui('({disabled:document.querySelector("#btn-client-setup").disabled,busy:document.querySelector("#btn-client-setup").getAttribute("aria-busy")})')
    check('client setup stays busy across locale rebuilds and rejects duplicate submissions', setupCalls === 1 && busySetup.disabled && busySetup.busy === 'true', {...busySetup,setupCalls})
    finishSetup([{status:'error',name:'Isolated UI client',message:'Isolated write failure'}])
    await until(() => ui('!document.querySelector("#btn-client-setup").disabled && !document.querySelector("#btn-client-setup").hasAttribute("aria-busy")'), 'remaining client setup available')
    check('client setup re-enables when writable clients remain after its result', await ui('document.querySelector("#set-client-result").textContent.includes("Isolated write failure")'))
    scanFails = true
    await click('#btn-client-scan')
    await until(() => ui('document.querySelector("#set-client-list").textContent.includes("Isolated scan failure") && !document.querySelector("#set-client-list").hasAttribute("aria-busy")'), 'isolated scan error visible')
    await ui('document.querySelector("#set-locale").value="zh-CN"; document.querySelector("#set-locale").dispatchEvent(new Event("change"))')
    check('locale preview does not replace a scan failure with stale cached clients', await ui('document.querySelector("#set-client-list").textContent.includes("Isolated scan failure") && !document.querySelector("#set-client-list input") && document.querySelector("#btn-client-setup").disabled'))
    await click('#btn-close-settings')
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
