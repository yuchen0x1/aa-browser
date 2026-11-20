/** Permission regressions against transpiled production sessions.ts; no Electron process or user data. */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { compileFunction } from 'node:vm'
import test from 'node:test'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-session-permissions-'))
const out = path.join(tmp, 'compiled')
const site = 'https://permission.example'
const tick = () => new Promise((resolve) => setImmediate(resolve))

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function webContents(url = `${site}/page`) {
  const wc = new EventEmitter()
  let destroyed = false
  wc.getURL = () => {
    assert.equal(destroyed, false, 'must not access a destroyed WebContents')
    return url
  }
  wc.getTitle = () => {
    assert.equal(destroyed, false, 'must not read a destroyed WebContents title')
    return 'Permission fixture'
  }
  wc.isDestroyed = () => destroyed
  wc.destroy = () => { destroyed = true; wc.emit('destroyed') }
  wc.navigate = (next = url, { isSameDocument = false, isMainFrame = true } = {}) => {
    // Electron 45 supplies these properties on the event itself, plus deprecated positional args.
    wc.emit('did-start-navigation', {
      url: next, isSameDocument, isMainFrame, frame: null
    }, next, isSameDocument, isMainFrame, 1, 2)
    if (isMainFrame) url = next
  }
  return wc
}

function fixture(requestApproval) {
  // A fresh production module isolates each test, while all Sessions within a test share its globals.
  const filename = path.join(out, 'sessions.js')
  const forbidden = () => { throw new Error('Production user-data/filesystem access is forbidden') }
  const dependencies = {
    electron: { app: { getPath: forbidden }, session: { fromPartition: forbidden } },
    './tabs': { ISOLATED_PARTITION_PREFIX: 'aa-iso-', SHARED_PARTITION: 'persist:aa-shared' },
    'node:fs': { readdirSync: forbidden, rmSync: forbidden },
    'node:path': path
  }
  const module = { exports: {} }
  compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(
    (name) => {
      assert.ok(Object.hasOwn(dependencies, name), `Unexpected production dependency: ${name}`)
      return dependencies[name]
    }, module, module.exports
  )
  const approvals = []
  const approve = requestApproval ?? ((meta) => {
    const pending = { meta, ...deferred() }
    approvals.push(pending)
    return pending.promise
  })
  const { applyPermissionPolicy } = module.exports
  function session(deps = { requestApproval: approve }) {
    const ses = {
      requestInstalls: 0,
      checkInstalls: 0,
      setPermissionRequestHandler(handler) { this.requestHandler = handler; this.requestInstalls++ },
      setPermissionCheckHandler(handler) { this.checkHandler = handler; this.checkInstalls++ }
    }
    applyPermissionPolicy(ses, deps)
    return ses
  }
  return { approvals, session, applyPermissionPolicy }
}

function request(ses, wc, permission = 'notifications', details = {}) {
  const values = []
  const completed = deferred()
  ses.requestHandler(wc, permission, (value) => {
    values.push(value)
    completed.resolve(value)
  }, { requestingUrl: wc.isDestroyed() ? '' : wc.getURL(), isMainFrame: true, ...details })
  return { result: completed.promise, values }
}

function check(ses, permission = 'notifications', details = {}, origin = site, wc = null) {
  return ses.checkHandler(wc, permission, origin, { isMainFrame: true, ...details })
}

try {
  // Match the existing isolated TS compilation pattern; TypeScript 7 removed transpileModule.
  const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc')
  const compiled = spawnSync(process.execPath, [
    tsc, '--ignoreConfig', '--noCheck', '--noResolve', '--outDir', out,
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--esModuleInterop',
    path.join(root, 'src/main/sessions.ts')
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(compiled.status, 0, `Compilation failed: ${compiled.error ?? ''}\n${compiled.stdout}\n${compiled.stderr}`)

  await test('concurrent same-origin requests cannot share approval across isolated Sessions', async () => {
    const f = fixture()
    const first = f.session()
    const isolated = f.session()
    const a = request(first, webContents())
    const b = request(isolated, webContents())
    await tick()
    assert.equal(f.approvals.length, 2)
    f.approvals[0].resolve(true)
    assert.equal(await a.result, true)
    assert.deepEqual(b.values, [], 'other Session must still wait for its own approval')
    assert.equal(check(first), true)
    assert.equal(check(isolated), false)
    f.approvals[1].resolve(false)
    assert.equal(await b.result, false)
    assert.equal(check(isolated), false)
    const retry = request(isolated, webContents())
    await tick()
    assert.equal(f.approvals.length, 3)
    f.approvals[2].resolve(true)
    assert.equal(await retry.result, true)
    assert.equal(check(isolated), true, 'the second Session records only its own approval')
    assert.deepEqual(a.values, [true])
    assert.deepEqual(b.values, [false])
  })

  await test('same-document requests dedupe, notification grants persist, and policy installation stays idempotent', async () => {
    const f = fixture()
    const ses = f.session()
    f.applyPermissionPolicy(ses, { requestApproval: () => { throw new Error('must not replace policy') } })
    assert.equal(ses.requestInstalls, 1)
    assert.equal(ses.checkInstalls, 1)
    const wc = webContents()
    const a = request(ses, wc)
    const b = request(ses, wc)
    await tick()
    assert.equal(f.approvals.length, 1)
    assert.deepEqual(f.approvals[0].meta, {
      site, tabTitle: 'Permission fixture', fieldLabel: '允许使用桌面通知',
      detail: '权限类型: notifications', kind: 'permission', permission: 'notifications'
    }, 'existing approval metadata API is unchanged')
    f.approvals[0].resolve(true)
    assert.deepEqual(await Promise.all([a.result, b.result]), [true, true])
    assert.deepEqual(a.values, [true])
    assert.deepEqual(b.values, [true])
    assert.equal(check(ses), true, 'null WebContents notification/worker checks remain supported')
    assert.equal(check(ses, 'notifications', {}, site, wc), true)
    assert.equal(await request(ses, webContents(`${site}/another-page`)).result, true)
    assert.equal(f.approvals.length, 1, 'completed grants retain same-Session, same-origin reuse')
    assert.equal(check(ses, 'notifications', {}, 'https://other.example'), false)
  })

  await test('different WebContents in one Session do not inherit an in-flight document approval', async () => {
    const f = fixture()
    const ses = f.session()
    const a = request(ses, webContents())
    const b = request(ses, webContents())
    await tick()
    assert.equal(f.approvals.length, 2)
    f.approvals[0].resolve(false)
    f.approvals[1].resolve(true)
    assert.deepEqual(await Promise.all([a.result, b.result]), [false, true])
  })

  await test('audio and video have separate pending prompts, labels, grants, and checks', async () => {
    const f = fixture()
    const ses = f.session()
    const wc = webContents('https://embedder.example/page')
    const frame = { requestingUrl: `${site}/frame`, securityOrigin: site, isMainFrame: false }
    const audio = request(ses, wc, 'media', { ...frame, mediaTypes: ['audio'] })
    const video = request(ses, wc, 'media', { ...frame, mediaTypes: ['video'] })
    await tick()
    assert.equal(f.approvals.length, 2)
    assert.equal(f.approvals[0].meta.fieldLabel, '允许使用麦克风')
    assert.equal(f.approvals[1].meta.fieldLabel, '允许使用摄像头')
    assert.equal(f.approvals[0].meta.detail, '权限类型: media · audio')
    assert.equal(f.approvals[0].meta.permission, 'media', 'approval API retains Electron permission name')
    f.approvals[0].resolve(true)
    assert.equal(await audio.result, true)
    const mediaCheck = (mediaType) => check(ses, 'media', { mediaType, securityOrigin: site }, 'https://embedder.example', wc)
    assert.equal(mediaCheck('audio'), true, 'media checks use the requesting securityOrigin')
    assert.equal(mediaCheck('video'), false, 'microphone approval is not camera approval')
    f.approvals[1].resolve(false)
    assert.equal(await video.result, false)
    assert.equal(mediaCheck('video'), false)
    assert.equal(await request(ses, wc, 'media', { ...frame, mediaTypes: ['audio'] }).result, true)
    assert.equal(check(ses, 'media', { mediaType: 'audio' }, 'https://embedder.example'), false)
    const combined = request(ses, wc, 'media', { ...frame, mediaTypes: ['audio', 'video'] })
    await tick()
    assert.equal(f.approvals.length, 3, 'partial grant cannot silently satisfy a combined request')
    f.approvals[2].resolve(true)
    assert.equal(await combined.result, true)
    assert.equal(mediaCheck('video'), true)
    assert.equal(check(f.session(), 'media', { mediaType: 'audio' }), false)
  })

  await test('combined media requests normalize scope without mutating details and never authorize unknown media checks', async () => {
    const f = fixture()
    const ses = f.session()
    const wc = webContents()
    const types = ['video', 'audio', 'video']
    const a = request(ses, wc, 'media', { mediaTypes: types })
    const b = request(ses, wc, 'media', { mediaTypes: ['audio', 'video'] })
    await tick()
    assert.deepEqual(types, ['video', 'audio', 'video'])
    assert.equal(f.approvals.length, 1)
    assert.equal(f.approvals[0].meta.detail, '权限类型: media · audio, video')
    f.approvals[0].resolve(true)
    assert.deepEqual(await Promise.all([a.result, b.result]), [true, true])
    for (const mediaType of ['audio', 'video']) assert.equal(check(ses, 'media', { mediaType }), true)
    for (const mediaType of [undefined, 'unknown', 'screen']) assert.equal(check(ses, 'media', { mediaType }), false)
    assert.equal(check(ses, 'media', { mediaType: 'video' }, 'https://other.example'), false)
    for (const mediaTypes of [undefined, [], ['screen'], ['audio', 'screen']]) {
      assert.equal(await request(ses, wc, 'media', { mediaTypes }).result, false)
    }
    assert.equal(f.approvals.length, 1, 'unspecified/invalid device scope cannot reuse a blanket media grant')
  })

  await test('denial, rejection, synchronous approval failure, and non-boolean responses grant nothing and allow retry', async () => {
    for (const outcome of [false, 'reject', 'throw', 'yes', 1, undefined]) {
      let calls = 0
      const f = fixture(() => {
        if (++calls > 1) return Promise.resolve(true)
        if (outcome === 'throw') throw new Error('approval failed synchronously')
        if (outcome === 'reject') return Promise.reject(new Error('approval rejected/timed out'))
        return Promise.resolve(outcome)
      })
      const ses = f.session()
      const wc = webContents()
      assert.equal(await request(ses, wc).result, false, `outcome ${String(outcome)}`)
      assert.equal(check(ses), false)
      assert.equal(await request(ses, wc).result, true, 'failed prompt must be removed so retry can be approved')
      assert.equal(calls, 2)
      assert.equal(check(ses), true)
    }
  })

  await test('destruction before approval completion neither grants nor authorizes and removes lifecycle listeners', async () => {
    const f = fixture()
    const ses = f.session()
    const wc = webContents()
    const pending = request(ses, wc)
    await tick()
    wc.destroy()
    f.approvals[0].resolve(true)
    assert.equal(await pending.result, false)
    assert.deepEqual(pending.values, [false])
    assert.equal(check(ses), false)
    assert.equal(wc.listenerCount('did-start-navigation'), 0)
    assert.equal(wc.listenerCount('render-process-gone'), 0)
    assert.equal(await request(ses, wc).result, false, 'already destroyed request fails closed')
    const retry = request(ses, webContents())
    await tick()
    assert.equal(f.approvals.length, 2, 'destroyed request did not seed a cached grant')
    f.approvals[1].resolve(false)
    assert.equal(await retry.result, false)
  })

  await test('cross-document navigation invalidates approval, including reload, away-and-back, and subframes', async () => {
    for (const navigate of [
      (wc) => wc.navigate(`${site}/next`),
      (wc) => wc.navigate(),
      (wc) => { wc.navigate('https://other.example/'); wc.navigate(`${site}/page`) },
      (wc) => wc.navigate(`${site}/frame-next`, { isMainFrame: false })
    ]) {
      const f = fixture()
      const ses = f.session()
      const wc = webContents()
      const pending = request(ses, wc)
      await tick()
      navigate(wc)
      f.approvals[0].resolve(true)
      assert.equal(await pending.result, false)
      assert.equal(check(ses), false, 'stale document must not populate the Session grant cache')
      assert.equal(check(ses, 'notifications', {}, 'https://other.example'), false)
    }
  })

  await test('stale completion cannot delete a newer same-key prompt after navigation', async () => {
    const f = fixture()
    const ses = f.session()
    const wc = webContents()
    const stale = request(ses, wc)
    await tick()
    wc.navigate()
    const current = request(ses, wc)
    await tick()
    assert.equal(f.approvals.length, 2)
    f.approvals[0].resolve(true)
    assert.equal(await stale.result, false)
    assert.equal(check(ses), false)
    const duplicate = request(ses, wc)
    await tick()
    assert.equal(f.approvals.length, 2, 'new document prompt must still dedupe')
    f.approvals[1].resolve(true)
    assert.deepEqual(await Promise.all([current.result, duplicate.result]), [true, true])
    assert.equal(check(ses), true)
  })

  await test('same-document navigation preserves an approval, but renderer termination invalidates it', async () => {
    const f = fixture()
    const ses = f.session()
    const wc = webContents()
    const pending = request(ses, wc, 'geolocation')
    await tick()
    wc.navigate(`${site}/page#fragment`, { isSameDocument: true })
    f.approvals[0].resolve(true)
    assert.equal(await pending.result, true)
    assert.equal(check(ses, 'geolocation'), true)
    assert.equal(check(ses, 'geolocation-approximate'), false, 'different permissions are not interchangeable')
    const crashed = request(ses, wc)
    await tick()
    wc.emit('render-process-gone', {}, { reason: 'crashed', exitCode: 1 })
    f.approvals[1].resolve(true)
    assert.equal(await crashed.result, false)
    assert.equal(check(ses), false)
    assert.equal(check(ses, 'geolocation'), true, 'already completed Session grants are not blanket revoked')
  })

  await test('each deduped callback rechecks liveness and callback exceptions do not reject shared approval', async () => {
    const f = fixture()
    const ses = f.session()
    const wc = webContents()
    const values = []
    ses.requestHandler(wc, 'notifications', (allowed) => {
      values.push(allowed)
      wc.destroy()
      throw new Error('native request was removed')
    }, { requestingUrl: wc.getURL(), isMainFrame: true })
    const sibling = request(ses, wc)
    await tick()
    assert.equal(f.approvals.length, 1)
    f.approvals[0].resolve(true)
    assert.equal(await sibling.result, false, 'second callback cannot authorize after first destroys its WebContents')
    assert.deepEqual(values, [true])
    assert.deepEqual(sibling.values, [false])
    await tick() // An unhandled rejection here fails node:test.
  })

  await test('existing non-prompt policy is preserved, including allowed unknown/features and unattended prompt denial', async () => {
    const f = fixture()
    const ses = f.session({})
    const wc = webContents()
    for (const permission of [
      'clipboard-read', 'deprecated-sync-clipboard-read', 'midi', 'midiSysex', 'hid', 'serial', 'usb',
      'bluetooth', 'idle-detection', 'speaker-selection', 'window-management', 'display-capture', 'openExternal'
    ]) {
      assert.equal(await request(ses, wc, permission).result, false, permission)
      assert.equal(check(ses, permission), false, permission)
    }
    for (const permission of [
      'unknown', 'fullscreen', 'pointerLock', 'keyboardLock', 'clipboard-sanitized-write',
      'fileSystem', 'mediaKeySystem', 'persistent-storage', 'background-sync', 'local-fonts', 'local-network'
    ]) {
      assert.equal(await request(ses, wc, permission).result, true, permission)
      assert.equal(check(ses, permission), true, permission)
    }
    for (const permission of ['notifications', 'geolocation', 'geolocation-approximate', 'media']) {
      assert.equal(await request(ses, wc, permission, { mediaTypes: ['audio'] }).result, false)
      assert.equal(check(ses, permission, { mediaType: 'audio' }), false)
    }
    assert.equal(f.approvals.length, 0)
  })
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
