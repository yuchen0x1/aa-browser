/** Full application workflows: real Sessions, MCP clients, desktop approvals and process restart. */
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import http from 'node:http'
import { createRequire } from 'node:module'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath, pathToFileURL } from 'node:url'
import WebSocket from 'ws'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const require = createRequire(import.meta.url)
const script = fileURLToPath(import.meta.url)
const checks = []
const literal = (value) => JSON.stringify(value).replace(/[<>/\u2028\u2029]/g, (ch) => ({ '<': '\\u003C', '>': '\\u003E', '/': '\\u002F', '\u2028': '\\u2028', '\u2029': '\\u2029' })[ch])

function pass(message) { checks.push(message); console.log(`PASS: ${message}`) }
async function until(probe, description, timeout = 12_000) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    const result = await probe()
    if (result) return result
    await delay(50)
  }
  throw new Error(`Timed out: ${description}`)
}

if (!process.versions.electron) {
  await runParent()
} else {
  // Electron cannot emit ready while its ESM entry is awaiting app.whenReady().
  void runApplication().catch((error) => {
    fs.writeSync(2, `FAIL: ${error?.stack ?? error}\n`)
    process.exit(1)
  })
}

async function runParent() {
  const root = path.join(ROOT, '.local-verification')
  fs.mkdirSync(root, { recursive: true })
  const runDir = fs.mkdtempSync(path.join(root, 'workflow-e2e-'))
  const effects = []
  const sockets = new Set()
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1')
    if (url.pathname === '/stats') {
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(effects))
      return
    }
    if (url.pathname === '/effect') {
      const kind = url.searchParams.get('kind')
      effects.push({ kind, cookie: req.headers.cookie ?? '', method: req.method })
      // A server-visible write whose result never reaches the first app process.
      if (kind === 'crash' && effects.filter((effect) => effect.kind === kind).length === 1) return
      res.end('committed')
      return
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8')
    res.end(`<!doctype html><meta charset="utf-8"><title>Workflow fixture</title>
      <h1>Workflow fixture</h1><p id="identity"></p><div id="gate"></div>
      <script>
        const seed = new URL(location.href).searchParams.get('seed');
        if (seed) {
          document.cookie = 'identity=' + seed + '; Path=/; SameSite=Lax; Max-Age=86400';
          localStorage.setItem('identity', seed);
          sessionStorage.setItem('identity', seed);
        }
        document.querySelector('#identity').textContent = localStorage.getItem('identity') || 'unseeded';
      </script>`)
  })
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const env = {
    ...process.env,
    AA_WORKFLOW_E2E_DIR: runDir,
    AA_WORKFLOW_E2E_BASE: `http://127.0.0.1:${server.address().port}`,
    AA_BROWSER_START_IN_BACKGROUND: '1',
    AA_BROWSER_AUTO_LAUNCH: '0',
    AA_BROWSER_USER_DATA_DIR: path.join(runDir, 'user-data'),
    AA_BROWSER_DATA_DIR: path.join(runDir, 'data'),
    AA_BROWSER_CONNECTION_FILE: path.join(runDir, 'connection.json'),
    AA_BROWSER_SETTINGS_FILE: path.join(runDir, 'settings.json'),
    AA_BROWSER_SESSION_FILE: path.join(runDir, 'session.json'),
    AA_BROWSER_HISTORY_DIR: path.join(runDir, 'history'),
    AA_BROWSER_DOWNLOAD_DIR: path.join(runDir, 'downloads'),
    AA_BROWSER_EVIDENCE_FILE: path.join(runDir, 'evidence.json')
  }
  delete env.ELECTRON_RUN_AS_NODE
  fs.writeFileSync(env.AA_BROWSER_SETTINGS_FILE, JSON.stringify({ autoUpdate: false, restoreSession: false, backgroundMode: 'hidden' }))
  const runPhase = (phase) => new Promise((resolve, reject) => {
    const child = spawn(require('electron'), [script], { cwd: ROOT, env: { ...env, AA_WORKFLOW_E2E_PHASE: phase }, stdio: 'inherit' })
    let forcedCrash = false
    const crashProbe = phase === 'before-crash' ? setInterval(() => {
      try {
        const report = JSON.parse(fs.readFileSync(path.join(runDir, `${phase}.json`), 'utf8'))
        if (report.readyForCrash === true) {
          forcedCrash = child.kill('SIGKILL')
          clearInterval(crashProbe)
        }
      } catch { /* The child publishes this marker only after the real request reaches the fixture. */ }
    }, 20) : undefined
    const timer = setTimeout(() => { child.kill(); reject(new Error(`Workflow phase ${phase} timed out`)) }, 150_000)
    child.once('error', (error) => { clearTimeout(timer); clearInterval(crashProbe); reject(error) })
    child.once('exit', (code) => { clearTimeout(timer); clearInterval(crashProbe); resolve({ code, forcedCrash }) })
  })
  try {
    assert.equal((await runPhase('before-crash')).forcedCrash, true, 'parent must terminate the real app while a mutation is in flight')
    assert.equal(effects.filter((effect) => effect.kind === 'crash').length, 1)
    assert.equal((await runPhase('after-crash')).code, 0, 'restarted application must complete all recovery checks')
    const reports = ['before-crash', 'after-crash'].map((phase) => JSON.parse(fs.readFileSync(path.join(runDir, `${phase}.json`), 'utf8')))
    const result = { status: 'PASS', checks: reports.flatMap((report) => report.checks), effects, phases: reports }
    fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify(result, null, 2))
    console.log(`PASS: workflow application E2E; report ${path.join(runDir, 'result.json')}`)
  } catch (error) {
    fs.writeFileSync(path.join(runDir, 'result.json'), JSON.stringify({ status: 'FAIL', error: error.stack, effects }, null, 2))
    console.error(error)
    process.exitCode = 1
  } finally {
    for (const socket of sockets) socket.destroy()
    await new Promise((resolve) => server.close(resolve))
  }
}

async function runApplication() {
  const { app, webContents } = await import('electron')
  const runDir = process.env.AA_WORKFLOW_E2E_DIR
  const base = process.env.AA_WORKFLOW_E2E_BASE
  const phase = process.env.AA_WORKFLOW_E2E_PHASE
  const peers = []
  const unhandled = []
  process.on('unhandledRejection', (error) => { unhandled.push(String(error?.stack ?? error)); fs.writeSync(2, `Unhandled rejection: ${error?.stack ?? error}\n`) })
  app.setAppPath(ROOT)
  await import(pathToFileURL(path.join(ROOT, 'out/main/index.js')).href)
  await app.whenReady()
  const chrome = await until(() => webContents.getAllWebContents().find((wc) => wc.getURL().endsWith('/renderer/index.html')), 'browser shell')
  const ui = (source) => chrome.executeJavaScript(source, true)
  await until(() => ui('!!window.aa?.platformState'), 'platform preload bridge')
  chrome.setBackgroundThrottling(false)
  const state = () => ui('window.aa.getState()')
  const platformState = () => ui('window.aa.platformState()')
  const platform = (action, input = {}) => ui(`window.aa.platformAction(${literal(action)},${literal(input)})`)
  const record = async (id) => (await platformState()).workflows.find((item) => item.id === id)
  const effects = async () => (await fetch(`${base}/stats`)).json()
  const count = async (kind) => (await effects()).filter((effect) => effect.kind === kind).length
  const pending = async (pattern) => (await state()).pendingApprovals.find((item) => pattern.test(item.fieldLabel ?? ''))
  const approval = (pattern) => until(() => pending(pattern), `native approval ${pattern}`)
  const decide = (item, allowed) => ui(`window.aa.decideApproval(${literal(item.id)},${allowed})`)
  async function approved(promise, pattern = /./) {
    let done = false
    let value
    let failure
    void promise.then((result) => { value = result; done = true }, (error) => { failure = error; done = true })
    await until(async () => {
      if (done) return true
      const item = await pending(pattern)
      if (item) await decide(item, true)
      return done
    }, 'approved desktop operation')
    if (failure) throw failure
    return value
  }
  async function desktop(action, input = {}) {
    const result = await platform(action, input)
    assert.equal(result.ok, true, `${action}: ${result.error}`)
    return result.data
  }
  async function approvedDesktop(action, input = {}, pattern = /./) {
    const result = await approved(platform(action, input), pattern)
    assert.equal(result.ok, true, `${action}: ${result.error}`)
    return result.data
  }
  async function connect(session) {
    await until(() => fs.existsSync(process.env.AA_BROWSER_CONNECTION_FILE), 'connection discovery')
    const connection = JSON.parse(fs.readFileSync(process.env.AA_BROWSER_CONNECTION_FILE, 'utf8'))
    const ws = new WebSocket(`ws://127.0.0.1:${connection.port}/?token=${connection.token}&client=${session}`)
    await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject) })
    const connectionId = randomUUID()
    let id = 0
    const requests = new Map()
    ws.on('message', (raw) => {
      const response = JSON.parse(String(raw))
      if (response.event) return
      const waiter = requests.get(response.id)
      if (!waiter) return
      requests.delete(response.id)
      clearTimeout(waiter.timer)
      if (response.ok) waiter.resolve(response.result)
      else waiter.reject(new Error(String(response.error)))
    })
    ws.on('close', () => {
      for (const waiter of requests.values()) { clearTimeout(waiter.timer); waiter.reject(new Error('MCP client disconnected')) }
      requests.clear()
    })
    const call = (tool, args = {}) => new Promise((resolve, reject) => {
      const requestId = ++id
      const timer = setTimeout(() => { requests.delete(requestId); reject(new Error(`MCP timeout: ${tool}`)) }, 20_000)
      requests.set(requestId, { resolve, reject, timer })
      ws.send(JSON.stringify({ id: requestId, tool, args, idempotencyKey: `${session}:${phase}:${connectionId}:${requestId}` }))
    })
    const json = async (tool, args) => {
      const result = await call(tool, args)
      assert.notEqual(result.isError, true)
      return JSON.parse(result.content.filter((block) => block.type === 'text').map((block) => block.text).join('\n'))
    }
    const peer = { ws, call, json }
    peers.push(peer)
    return peer
  }
  const pageFor = (url) => until(() => webContents.getAllWebContents().find((wc) => wc !== chrome && wc.getURL() === url), `page ${url}`)
  const ready = (page) => page.executeJavaScript(`document.querySelector('#gate').innerHTML='<span id="ready">Ready</span>'`)
  const identity = (page) => page.executeJavaScript('({cookie:document.cookie,local:localStorage.getItem("identity"),session:sessionStorage.getItem("identity")})')
  const create = (peer, name, steps, options = {}) => peer.json('browser_workflows', { action: 'create', name, steps, ...options })
  const command = (peer, action, workflow, extra = {}) => peer.json('browser_workflows', { action, workflowId: workflow.id, ...extra })
  const waitStatus = (workflow, status) => until(async () => {
    const current = await record(workflow.id)
    return current?.status === status ? current : false
  }, `${workflow.name} ${status}`)
  const step = (id, tool, args = {}, extra = {}) => ({ id, name: id, tool, args, ...extra })
  const mutationArgs = { expression: `fetch(${JSON.stringify(`${base}/effect?kind=crash`)},{method:'POST'}).then(response=>response.text())` }
  try {
    if (phase === 'before-crash') {
      const a = await approvedDesktop('profile.create', { name: 'Workflow identity A' }, /^Profile: create$/)
      const b = await approvedDesktop('profile.create', { name: 'Workflow identity B' }, /^Profile: create$/)
      const sessionA = randomUUID()
      const sessionB = randomUUID()
      const peerA = await connect(sessionA)
      let peerB = await connect(sessionB)
      await approved(peerA.json('browser_profiles', { action: 'bind', profileId: a.id }), /^Bind browser identity$/)
      await approved(peerB.json('browser_profiles', { action: 'bind', profileId: b.id }), /^Bind browser identity$/)
      const urlA = `${base}/identity?seed=A`
      const urlB = `${base}/identity?seed=B`
      await Promise.all([peerA.call('browser_navigate', { url: urlA, snapshot: false }), peerB.call('browser_navigate', { url: urlB, snapshot: false })])
      const pageA = await pageFor(urlA)
      const pageB = await pageFor(urlB)
      assert.notEqual(pageA.session, pageB.session)
      assert.deepEqual(await identity(pageA), { cookie: 'identity=A', local: 'A', session: 'A' })
      assert.deepEqual(await identity(pageB), { cookie: 'identity=B', local: 'B', session: 'B' })
      pass('two MCP clients use genuinely isolated persistent Chromium Sessions, Cookies and Storage')

      const steps = [step('gate', 'browser_wait', { selector: '#ready', timeoutMs: 15_000 }), step('read', 'browser_page_state', {}, { dependsOn: ['gate'], checkpoint: { before: { selector: '#ready' } } })]
      const [wa, wb] = await Promise.all([create(peerA, 'Concurrent A', steps), create(peerB, 'Concurrent B', steps)])
      assert.equal(wa.profileId, a.id)
      assert.equal(wb.profileId, b.id)
      await assert.rejects(command(peerA, 'get', wb), /WORKFLOW_NOT_FOUND/)
      await Promise.all([command(peerA, 'run', wa), command(peerB, 'run', wb)])
      await until(async () => {
        const current = await Promise.all([record(wa.id), record(wb.id)])
        return current.every((workflow) => workflow.steps[0].status === 'running')
      }, 'both Profile workflows running concurrently')
      await assert.rejects(peerA.call('browser_page_state'), /PROFILE_BUSY/)
      await Promise.all([ready(pageA), ready(pageB)])
      const [doneA, doneB] = await Promise.all([waitStatus(wa, 'completed'), waitStatus(wb, 'completed')])
      assert.equal(doneA.steps[1].verifiedUrl, urlA)
      assert.equal(doneB.steps[1].verifiedUrl, urlB)
      assert.ok(doneA.steps.every((item) => item.checkpointAt && item.attempts === 1))
      pass('concurrent workflows retain Profile/client ownership and leases block unrelated calls')

      const blocked = await create(peerA, 'Checkpoint blocks writes', [step('blocked', 'browser_evaluate', { expression: `fetch(${JSON.stringify(`${base}/effect?kind=checkpoint`)})` }, { checkpoint: { before: { selector: '#missing-checkpoint' } } })])
      await command(peerA, 'run', blocked)
      const blockedState = await waitStatus(blocked, 'waiting')
      assert.equal(blockedState.steps[0].attempts, 0)
      assert.equal(await count('checkpoint'), 0)
      assert.equal(await pending(/^Workflow: blocked$/), undefined)
      pass('a failed live DOM checkpoint prevents dispatch before any side effect')
      await command(peerA, 'cancel', blocked)

      const denied = await create(peerA, 'Native approval denial', [step('denied', 'browser_evaluate', { expression: `fetch(${JSON.stringify(`${base}/effect?kind=denied`)})` }, { requiresApproval: false })])
      await command(peerA, 'run', denied)
      const deniedApproval = await approval(/^Workflow: denied$/)
      assert.equal(await count('denied'), 0)
      assert.equal((await record(denied.id)).steps[0].attempts, 0)
      await decide(deniedApproval, false)
      await waitStatus(denied, 'waiting')
      assert.equal(await count('denied'), 0)
      pass('requiresApproval:false cannot bypass actual desktop approval, and denial executes nothing')
      await command(peerA, 'cancel', denied)

      const paused = await create(peerA, 'Pause and inspect', [step('pause-point', 'browser_wait', { selector: '#continue', timeoutMs: 30_000 })])
      await command(peerA, 'run', paused)
      await until(async () => (await record(paused.id)).steps[0].status === 'running', 'pause fixture running')
      await command(peerA, 'pause', paused)
      await until(async () => !(await platformState()).profiles.find((item) => item.id === a.id).leased, 'pause releases Profile lease')
      assert.equal((await record(paused.id)).status, 'paused')
      await pageA.executeJavaScript('document.querySelector("#gate").insertAdjacentHTML("beforeend", \'<span id="continue">Continue</span>\')')
      await command(peerA, 'resume', paused)
      const continued = await waitStatus(paused, 'completed')
      assert.equal(continued.steps[0].attempts, 2)
      pass('manual pause releases resources and resume verifies fresh page state before retrying a read-only step')

      const clientPaused = await create(peerA, 'Client pause detached workflow', [step('client-gate', 'browser_wait', { selector: '#client-resumed', timeoutMs: 30_000 })])
      const sibling = await create(peerB, 'Sibling survives client pause', [step('sibling-gate', 'browser_wait', { selector: '#sibling-ready', timeoutMs: 30_000 })])
      await Promise.all([command(peerA, 'run', clientPaused), command(peerB, 'run', sibling)])
      await until(async () => (await Promise.all([record(clientPaused.id), record(sibling.id)])).every((workflow) => workflow.steps[0].status === 'running'), 'both detached workflows running before client pause')
      await peerA.call('browser_tasks', { action: 'pause' })
      await until(async () => {
        const snapshot = await platformState()
        const workflow = snapshot.workflows.find((item) => item.id === clientPaused.id)
        return workflow.status === 'paused' && workflow.steps[0].status === 'interrupted' && !snapshot.profiles.find((item) => item.id === a.id).leased
      }, 'client pause aborts its detached wait and releases its Profile lease')
      assert.equal((await record(sibling.id)).steps[0].status, 'running')
      assert.equal((await platformState()).profiles.find((item) => item.id === b.id).leased, true)
      await assert.rejects(peerA.call('browser_page_state'), /客户端已暂停/)
      const pausedDesktopResume = await platform('workflow.resume', { workflowId: clientPaused.id })
      assert.equal(pausedDesktopResume.ok, false)
      assert.match(pausedDesktopResume.error, /CLIENT_PAUSED/)
      await pageB.executeJavaScript('document.querySelector("#gate").insertAdjacentHTML("beforeend", \'<span id="sibling-ready">Sibling ready</span>\')')
      assert.equal((await waitStatus(sibling, 'completed')).steps[0].attempts, 1)
      await pageA.executeJavaScript('document.querySelector("#gate").insertAdjacentHTML("beforeend", \'<span id="client-resumed">Client ready</span>\')')
      await peerA.call('browser_tasks', { action: 'resume' })
      await delay(1100)
      const stillClientPaused = await record(clientPaused.id)
      assert.equal(stillClientPaused.status, 'paused', 'resuming a client must not automatically resume its detached workflow')
      assert.equal(stillClientPaused.steps[0].attempts, 1)
      assert.equal((await platformState()).profiles.find((item) => item.id === a.id).leased, false)
      await command(peerA, 'resume', clientPaused)
      assert.equal((await waitStatus(clientPaused, 'completed')).steps[0].attempts, 2)
      pass('client task pause aborts an accepted workflow and releases its lease without affecting another client; client resume never replays it')

      for (const scenario of [
        { name: 'Global interrupt', selector: 'global-resume', interrupt: () => ui('window.aa.interruptAgent()'), release: () => ui('window.aa.resumeAgent()') },
        { name: 'Monitor takeover', selector: 'takeover-resume', interrupt: () => peerB.call('browser_window', { action: 'takeover' }), release: () => peerB.call('browser_window', { action: 'release' }) }
      ]) {
        const running = await create(peerA, `${scenario.name} running workflow`, [step('global-gate', 'browser_wait', { selector: `#${scenario.selector}`, timeoutMs: 30_000 })])
        await command(peerA, 'run', running)
        await until(async () => (await record(running.id)).steps[0].status === 'running', `${scenario.name} detached wait is running`)
        const scheduleAt = Date.now() + 2000
        const scheduled = await create(peerB, `${scenario.name} scheduled draft`, [step('scheduled-read', 'browser_page_state')], { scheduleAt })
        assert.equal(scheduled.status, 'draft')
        await scenario.interrupt()
        await until(async () => {
          const snapshot = await platformState()
          const active = snapshot.workflows.find((item) => item.id === running.id)
          const draft = snapshot.workflows.find((item) => item.id === scheduled.id)
          return active.status === 'paused' && active.steps[0].status === 'interrupted' && draft.status === 'paused' && !snapshot.profiles.find((item) => item.id === a.id).leased
        }, `${scenario.name} pauses in-flight and scheduled workflows`)
        if (scenario.selector === 'takeover-resume') assert.equal((await state()).monitor.control, 'human')
        await pageA.executeJavaScript(`document.querySelector("#gate").insertAdjacentHTML("beforeend", '<span id="${scenario.selector}">Ready</span>')`)
        await until(() => Date.now() >= scheduleAt + 1100, `${scenario.name} schedule passes while paused`)
        assert.equal((await record(scheduled.id)).steps[0].attempts, 0, 'a paused scheduled draft must not execute at its deadline')
        await assert.rejects(peerA.call('browser_page_state'), /中断|人工接管/)
        await scenario.release()
        await delay(1100)
        const [stillRunning, stillScheduled] = await Promise.all([record(running.id), record(scheduled.id)])
        assert.equal(stillRunning.status, 'paused')
        assert.equal(stillRunning.steps[0].attempts, 1)
        assert.equal(stillScheduled.status, 'paused', 'releasing global control must not re-enable a paused schedule')
        assert.equal(stillScheduled.steps[0].attempts, 0)
        await Promise.all([command(peerA, 'resume', running), command(peerB, 'resume', scheduled)])
        const [finishedRunning, finishedScheduled] = await Promise.all([waitStatus(running, 'completed'), waitStatus(scheduled, 'completed')])
        assert.equal(finishedRunning.steps[0].attempts, 2)
        assert.equal(finishedScheduled.steps[0].attempts, 1)
        pass(`${scenario.name} aborts detached execution and pauses future drafts; neither deadline nor control release can restart them without explicit workflow resume`)
      }

      const disconnected = await create(peerB, 'Disconnected owner', [step('disconnect-point', 'browser_wait', { selector: '#reconnected', timeoutMs: 30_000 })])
      await command(peerB, 'run', disconnected)
      await until(async () => (await record(disconnected.id)).steps[0].status === 'running', 'disconnect fixture running')
      peerB.ws.close()
      await until(async () => (await record(disconnected.id)).status === 'paused' && !(await platformState()).profiles.find((item) => item.id === b.id).leased, 'disconnected workflow pauses and releases resources')
      peerB = await connect(sessionB)
      const rebound = peerB.json('browser_profiles', { action: 'bind', profileId: b.id })
      const rebindApproval = await Promise.race([
        approval(/^Bind browser identity$/),
        rebound.then(() => { throw new Error('Reconnecting a Profile must require a fresh desktop decision') })
      ])
      assert.equal((await record(disconnected.id)).status, 'paused')
      await decide(rebindApproval, true)
      await rebound
      await pageB.executeJavaScript('document.querySelector("#gate").insertAdjacentHTML("beforeend", \'<span id="reconnected">Reconnected</span>\')')
      await command(peerB, 'resume', disconnected)
      await waitStatus(disconnected, 'completed')
      pass('MCP disconnect pauses execution; the same stable client must renew native Profile access before recovery')

      const cancelled = await create(peerB, 'Cancel in-flight task', [step('wait', 'browser_wait', { selector: '#never-present', timeoutMs: 30_000 }), step('later', 'browser_evaluate', { expression: `fetch(${JSON.stringify(`${base}/effect?kind=cancelled`)})` }, { dependsOn: ['wait'] })])
      await command(peerB, 'run', cancelled)
      await until(async () => (await record(cancelled.id)).steps[0].status === 'running', 'cancel fixture running')
      await command(peerB, 'cancel', cancelled)
      await until(async () => !(await platformState()).profiles.find((item) => item.id === b.id).leased, 'cancel releases Profile lease')
      const cancelledState = await record(cancelled.id)
      assert.equal(cancelledState.status, 'cancelled')
      assert.equal(cancelledState.steps[1].status, 'cancelled')
      assert.equal(await count('cancelled'), 0)
      pass('cancellation aborts an in-flight real browser wait and prevents later mutation')

      pageA.session.flushStorageData()
      pageB.session.flushStorageData()
      await Promise.all([pageA.session.cookies.flushStore(), pageB.session.cookies.flushStore()])
      const crash = await create(peerA, 'Uncertain mutation across restart', [step('precheck', 'browser_page_state'), step('commit', 'browser_evaluate', mutationArgs, { dependsOn: ['precheck'], checkpoint: { before: { urlContains: '/identity', selector: '#ready' } } }), step('finish', 'browser_page_state', {}, { dependsOn: ['commit'] })])
      fs.writeFileSync(path.join(runDir, 'fixture.json'), JSON.stringify({ a: a.id, b: b.id, sessionA, sessionB, crash: crash.id }, null, 2))
      await command(peerA, 'run', crash)
      await decide(await approval(/^Workflow: commit$/), true)
      await decide(await approval(/执行 JavaScript/), true)
      await until(async () => (await count('crash')) === 1, 'server observes irreversible test mutation')
      const inflight = await record(crash.id)
      assert.equal(inflight.steps[0].status, 'completed')
      assert.equal(inflight.steps[1].status, 'running')
      assert.deepEqual(unhandled, [])
      pass('dispatch intent is persisted before a real server-side mutation whose response is still pending')
      fs.writeFileSync(path.join(runDir, `${phase}.json`), JSON.stringify({ checks, inflight, readyForCrash: true }, null, 2))
      // The Node parent terminates this process; app.quit/process.exit would dispose
      // renderers first and allow the pending tool to persist a normal failure.
      return new Promise(() => {})
    }

    const fixture = JSON.parse(fs.readFileSync(path.join(runDir, 'fixture.json'), 'utf8'))
    const crash = { id: fixture.crash, name: 'Uncertain mutation across restart' }
    const recovered = await record(crash.id)
    assert.equal(recovered.status, 'interrupted')
    assert.equal(recovered.steps[0].status, 'completed')
    assert.equal(recovered.steps[0].attempts, 1)
    assert.equal(recovered.steps[1].status, 'interrupted')
    assert.equal(recovered.steps[1].sideEffect, 'uncertain')
    assert.equal(await count('crash'), 1)
    pass('real restart preserves completed checkpoints and marks the in-flight mutation uncertain without replay')

    const deniedTakeover = platform('workflow.resume', { workflowId: crash.id })
    const takeoverApproval = await approval(/^Take over workflow$/)
    assert.equal(await count('crash'), 1)
    await decide(takeoverApproval, false)
    assert.equal((await deniedTakeover).ok, false)
    assert.equal((await record(crash.id)).status, 'interrupted')
    pass('a disconnected MCP owner cannot silently fall back to desktop execution')

    await approvedDesktop('workflow.resume', { workflowId: crash.id }, /^Take over workflow$/)
    await waitStatus(crash, 'waiting')
    assert.equal(await count('crash'), 1)
    pass('explicit approved desktop takeover and resume still do not replay an uncertain write')

    await desktop('profile.select', { profileId: fixture.a })
    const resumeUrl = `${base}/identity?resume=A`
    await ui(`window.aa.submit(${literal(resumeUrl)})`)
    const resumePage = await pageFor(resumeUrl)
    await until(async () => (await identity(resumePage)).local === 'A', 'Profile storage survives actual restart')
    assert.equal((await identity(resumePage)).cookie, 'identity=A')
    await ready(resumePage)
    const restored = await record(crash.id)
    for (const item of restored.steps) {
      if (item.needsInput && item.status !== 'completed') {
        await desktop('workflow.input', { workflowId: crash.id, stepId: item.id, input: item.id === 'commit' ? mutationArgs : {} })
      }
    }

    await approvedDesktop('workflow.retry', { workflowId: crash.id, stepId: 'commit' }, /^Take over workflow$/)
    const changedApproval = await approval(/^Workflow: commit$/)
    await resumePage.executeJavaScript('document.querySelector("#ready").remove()')
    await decide(changedApproval, true)
    const changed = await waitStatus(crash, 'waiting')
    assert.match(changed.steps[1].error, /checkpoint/i)
    assert.equal(changed.steps[1].attempts, 1)
    assert.equal(await count('crash'), 1)
    pass('page changes during human approval are rechecked before an uncertain retry is dispatched')

    await ready(resumePage)
    await approvedDesktop('workflow.retry', { workflowId: crash.id, stepId: 'commit' }, /^Take over workflow$/)
    await decide(await approval(/^Workflow: commit$/), false)
    await waitStatus(crash, 'waiting')
    assert.equal(await count('crash'), 1)
    pass('targeted retry requires a fresh native decision and denial does not repeat the server-side write')

    await approvedDesktop('workflow.retry', { workflowId: crash.id, stepId: 'commit' }, /^Take over workflow$/)
    await decide(await approval(/^Workflow: commit$/), true)
    await decide(await approval(/执行 JavaScript/), true)
    const completed = await waitStatus(crash, 'completed')
    assert.equal(completed.steps[0].attempts, 1, 'completed checkpoint must never be replayed')
    assert.equal(completed.steps[1].attempts, 2)
    assert.equal(completed.steps[1].sideEffect, 'committed')
    assert.equal(await count('crash'), 2)
    assert.equal((await effects()).filter((effect) => effect.kind === 'crash').at(-1).cookie, 'identity=A')
    pass('approved targeted recovery runs only the selected uncertain step and its remaining dependency chain')
    assert.deepEqual(unhandled, [])
    fs.writeFileSync(path.join(runDir, `${phase}.json`), JSON.stringify({ checks, completed }, null, 2))
    for (const peer of peers) peer.ws.close()
    await new Promise((resolve) => { app.once('will-quit', resolve); app.quit() })
  } catch (error) {
    fs.writeFileSync(path.join(runDir, `${phase}.json`), JSON.stringify({ status: 'FAIL', checks, error: error.stack, unhandled }, null, 2))
    for (const peer of peers) peer.ws.close()
    fs.writeSync(2, `FAIL: ${error?.stack ?? error}\n`)
    app.exit(1)
  }
}
