#!/usr/bin/env node
/** Deterministic production withTabLock regressions; no Electron, network, or timed sleeps. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { getEventListeners } from 'node:events'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { compileFunction } from 'node:vm'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-tab-queue-'))
const out = path.join(tmp, 'compiled')
const cancelled = { message: /已被用户中断/ }
const closed = { name: 'ActionError', code: 'TARGET_CLOSED', message: /页面已关闭/ }
const options = { timeout: 3000 } // Deadlock guard only; ordering uses explicit gates.

function deferred() {
  let resolve
  let reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}

function fixture(id = 'tab-1') {
  let destroyed = false
  const wc = {
    isDestroyed: () => destroyed,
    getURL: () => 'https://fixture.test/',
    getTitle: () => 'Fixture',
    stop() {}
  }
  return {
    tab: { id, view: { webContents: wc }, keepRendering: () => () => {} },
    close: () => { destroyed = true }
  }
}

// One event-loop checkpoint drains promise reactions, without measuring elapsed time.
const checkpoint = () => new Promise((resolve) => setImmediate(resolve))

try {
  const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc')
  const compiled = spawnSync(process.execPath, [
    tsc, '--ignoreConfig', '--noCheck', '--noResolve', '--rootDir', 'src', '--outDir', out,
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--esModuleInterop',
    'src/main/actions.ts', 'src/main/tabs.ts'
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(compiled.status, 0, `Compilation failed: ${compiled.error ?? ''}\n${compiled.stdout}\n${compiled.stderr}`)

  const filename = path.join(out, 'main/actions.js')
  const module = { exports: {} }
  const deps = {
    electron: {},
    '@snapshot/scripts': {},
    '@snapshot/engine': { __aaSnapshot() {} },
    'node:async_hooks': require('node:async_hooks'),
    './progress': { reportProgress() {} },
    './evidence': {},
    './ref-context': { checkRefContext: () => null, noteSnapshot() {}, noteNavigation() {}, noteRendererRestart() {} }
  }
  compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })((name) => {
    assert.ok(Object.hasOwn(deps, name), `Unexpected production dependency: ${name}`)
    return deps[name]
  }, module, module.exports)
  const { withTabLock, raceAbort, doNavigate, doReload, ActionError, withDeadline, drainTabOperations } = module.exports
  const neverRun = () => assert.fail('Cancelled or closed queue entry must not run')

  await test('same-tab calls run strictly FIFO and preserve their results', options, async () => {
    const { tab } = fixture()
    const first = deferred()
    const second = deferred()
    const entered = deferred()
    const events = []
    const a = withTabLock(tab, undefined, async () => {
      events.push('A:start')
      entered.resolve()
      await first.promise
      events.push('A:end')
      return 'a'
    })
    await entered.promise
    const b = withTabLock(tab, undefined, async () => {
      events.push('B:start')
      await second.promise
      events.push('B:end')
      return 'b'
    })
    const c = withTabLock(tab, undefined, async () => { events.push('C'); return 'c' })
    await checkpoint()
    assert.deepEqual(events, ['A:start'])
    first.resolve()
    assert.equal(await a, 'a')
    await checkpoint()
    assert.deepEqual(events, ['A:start', 'A:end', 'B:start'])
    second.resolve()
    assert.deepEqual(await Promise.all([b, c]), ['b', 'c'])
    assert.deepEqual(events, ['A:start', 'A:end', 'B:start', 'B:end', 'C'])
  })

  await test('middle cancellation rejects promptly but C and a later D cannot overtake A', options, async () => {
    const { tab } = fixture()
    const hold = deferred()
    const entered = deferred()
    const events = []
    const a = withTabLock(tab, undefined, async () => {
      events.push('A:start')
      entered.resolve()
      await hold.promise
      events.push('A:end')
    })
    await entered.promise
    const ctrl = new AbortController()
    const b = withTabLock(tab, ctrl.signal, neverRun)
    const rejected = assert.rejects(b, (error) => error instanceof ActionError && /已被用户中断/.test(error.message))
    const c = withTabLock(tab, undefined, async () => { events.push('C') })
    assert.equal(getEventListeners(ctrl.signal, 'abort').length, 1)
    ctrl.abort()
    await rejected // Must settle while A is still held.
    assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0)
    const d = withTabLock(tab, undefined, async () => { events.push('D') })
    await checkpoint()
    assert.deepEqual(events, ['A:start'])
    hold.resolve()
    await Promise.all([a, c, d])
    assert.deepEqual(events, ['A:start', 'A:end', 'C', 'D'])
    // A drained queue must also accept new work.
    assert.equal(await withTabLock(tab, undefined, async () => 'again'), 'again')
  })

  for (const synchronous of [true, false]) {
    await test(`queue recovers from ${synchronous ? 'synchronous throw' : 'asynchronous rejection'}`, options, async () => {
      const { tab } = fixture()
      const failure = new Error('operation failed')
      const entered = deferred()
      const hold = deferred()
      const events = []
      const a = withTabLock(tab, undefined, synchronous
        ? () => { events.push('A'); throw failure }
        : async () => { events.push('A'); entered.resolve(); await hold.promise })
      const rejected = assert.rejects(a, (error) => error === failure)
      const b = withTabLock(tab, undefined, async () => { events.push('B'); return 42 })
      if (!synchronous) {
        await entered.promise
        await checkpoint()
        assert.deepEqual(events, ['A'])
        hold.reject(failure)
      }
      await rejected
      assert.equal(await b, 42)
      assert.deepEqual(events, ['A', 'B'])
      assert.equal(await withTabLock(tab, undefined, async () => 43), 43)
    })
  }

  await test('independent Tab objects run concurrently, even with identical display ids', options, async () => {
    const { tab: one } = fixture('same-id')
    const { tab: two } = fixture('same-id')
    const entered = deferred()
    const hold = deferred()
    const events = []
    const a = withTabLock(one, undefined, async () => {
      events.push('A:start'); entered.resolve(); await hold.promise; events.push('A:end')
    })
    await entered.promise
    const b = withTabLock(one, undefined, async () => { events.push('B') })
    assert.equal(await withTabLock(two, undefined, async () => { events.push('other'); return 7 }), 7)
    assert.deepEqual(events, ['A:start', 'other'])
    hold.resolve()
    await Promise.all([a, b])
    assert.deepEqual(events, ['A:start', 'other', 'A:end', 'B'])
  })

  await test('already-aborted calls never execute or block a subsequent call', options, async () => {
    const { tab } = fixture()
    const ctrl = new AbortController()
    ctrl.abort()
    await assert.rejects(withTabLock(tab, ctrl.signal, neverRun), cancelled)
    assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0)
    assert.equal(await withTabLock(tab, undefined, async () => 'live'), 'live')
  })

  await test('abort at predecessor completion is rechecked before dispatch', options, async () => {
    const { tab } = fixture()
    const entered = deferred()
    const hold = deferred()
    const ctrl = new AbortController()
    const a = withTabLock(tab, undefined, async () => { entered.resolve(); await hold.promise })
    await entered.promise
    const b = withTabLock(tab, ctrl.signal, neverRun)
    const rejected = assert.rejects(b, cancelled)
    hold.resolve()
    ctrl.abort()
    await Promise.all([a, rejected])
    assert.equal(await withTabLock(tab, undefined, async () => 'next'), 'next')
  })

  await test('a tab closed while waiting is rechecked for every queued entry', options, async () => {
    const { tab, close } = fixture()
    const entered = deferred()
    const hold = deferred()
    const ctrl = new AbortController()
    const a = withTabLock(tab, undefined, async () => { entered.resolve(); await hold.promise })
    await entered.promise
    const b = withTabLock(tab, ctrl.signal, neverRun)
    const c = withTabLock(tab, undefined, neverRun)
    const bClosed = assert.rejects(b, closed)
    const cClosed = assert.rejects(c, closed)
    close()
    hold.resolve()
    await Promise.all([a, bClosed, cClosed])
    assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0)
    await assert.rejects(withTabLock(tab, undefined, neverRun), closed)
    assert.equal(await withTabLock(fixture().tab, undefined, async () => 'fresh'), 'fresh')
  })

  await test('running abort returns promptly but holds the lock until the callback settles', options, async () => {
    const { tab } = fixture()
    const entered = deferred()
    const hold = deferred()
    const ctrl = new AbortController()
    const events = []
    const a = withTabLock(tab, ctrl.signal, async () => {
      events.push('A:start'); entered.resolve(); await hold.promise; events.push('A:end')
    })
    await entered.promise
    assert.equal(getEventListeners(ctrl.signal, 'abort').length, 1, 'Running call has a prompt-cancellation listener')
    const rejected = assert.rejects(a, cancelled)
    const b = withTabLock(tab, undefined, async () => { events.push('B') })
    ctrl.abort()
    await rejected
    await checkpoint()
    assert.deepEqual(events, ['A:start'])
    hold.resolve()
    await b
    assert.deepEqual(events, ['A:start', 'A:end', 'B'])
    assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0)
  })

  await test('raceAbort cancellation drains the tracked original promise before unlocking', options, async () => {
    const { tab } = fixture()
    const entered = deferred()
    const underlying = deferred()
    const ctrl = new AbortController()
    let underlyingFinished = false
    const events = []
    const work = underlying.promise.then(() => { underlyingFinished = true })
    const a = withTabLock(tab, ctrl.signal, () => {
      const raced = raceAbort(work, ctrl.signal)
      entered.resolve()
      return raced
    })
    const rejected = assert.rejects(a, cancelled)
    await entered.promise
    const b = withTabLock(tab, undefined, async () => {
      events.push('B')
      assert.equal(underlyingFinished, true, 'The queued operation starts only after raw work settles')
    })
    ctrl.abort()
    await rejected // User-facing cancellation is prompt even though the raw promise is pending.
    await checkpoint()
    assert.deepEqual(events, [])
    underlying.resolve()
    await Promise.all([work, b])
    assert.deepEqual(events, ['B'])
    assert.equal(underlyingFinished, true)
    assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0)
  })

  await test('a page operation bounded by withDeadline releases the tab promptly', options, async () => {
    const { tab } = fixture()
    const events = []
    const ctrl = new AbortController()
    const hung = new Promise(() => {})
    const a = withTabLock(tab, ctrl.signal, () => raceAbort(withDeadline(hung, 40, '页面截图'), ctrl.signal))
    const rejected = assert.rejects(a, cancelled)
    const b = withTabLock(tab, undefined, async () => { events.push('B') })
    await checkpoint()
    ctrl.abort()
    await rejected
    // 原始 capturePage 永不返回；队列仍必须在 withDeadline 的 40ms 上限后交棒。
    await b
    assert.deepEqual(events, ['B'])
  })

  await test('drainTabOperations gives up on a non-settling tracked promise', async () => {
    const context = { inFlight: new Set([new Promise(() => {})]) }
    const started = Date.now()
    await drainTabOperations(context, 30)
    assert.ok(Date.now() - started < 1000, 'drain must honor its own deadline instead of hanging forever')
  })

  await test('withDeadline rejects a non-settling page operation as ActionError', async () => {
    await assert.rejects(
      withDeadline(new Promise(() => {}), 20, '页面截图'),
      (error) => error instanceof ActionError && /页面截图超时/.test(error.message)
    )
  })

  await test('doNavigate keeps completion callback and queued work under one tab lock', options, async () => {
    const { tab } = fixture()
    const load = deferred()
    const events = []
    const tabs = {
      assertUrlAllowed() {},
      active: () => tab,
      get: () => tab,
      createTab: () => assert.fail('Existing-tab navigation must not create a tab'),
      navigate: async () => { events.push('navigate'); await load.promise }
    }
    const nav = doNavigate(tabs, 'https://fixture.test/next', {
      onComplete: async (completedTab) => {
        assert.equal(completedTab, tab)
        events.push('snapshot')
      }
    })
    await checkpoint()
    const later = withTabLock(tab, undefined, async () => { events.push('later') })
    assert.deepEqual(events, ['navigate'])
    load.resolve()
    await nav
    await later
    assert.deepEqual(events, ['navigate', 'snapshot', 'later'])
  })

  await test('doNavigate defers fresh-tab first load into the same lock', options, async () => {
    const { tab } = fixture('fresh')
    const events = []
    let createArgs
    const tabs = {
      assertUrlAllowed() {},
      active: () => null,
      get: () => null,
      createTab: (...args) => { createArgs = args; return tab },
      navigate: async (_tab, _url, _capture, signal) => {
        assert.equal(signal, undefined)
        events.push('navigate')
      }
    }
    await doNavigate(tabs, 'https://fixture.test/fresh', {
      newTab: true,
      onComplete: async () => { events.push('snapshot') }
    })
    assert.deepEqual(createArgs, ['https://fixture.test/fresh', true, undefined, true])
    assert.deepEqual(events, ['navigate', 'snapshot'])
  })
  for (const event of ['did-stop-loading', 'did-fail-load', 'destroyed']) {
    await test(`cancelled reload drains on ${event} without blocking the next call`, options, async () => {
      const wc = new EventEmitter()
      const entered = deferred()
      let loading = false
      Object.assign(wc, {
        isDestroyed: () => false, isLoading: () => loading,
        getURL: () => 'https://fixture.test/', getTitle: () => 'Fixture',
        reload() { loading = true; entered.resolve() },
        stop() {} // Native stop is asynchronous; release it with a controlled event below.
      })
      const tab = { view: { webContents: wc }, keepRendering: () => () => {} }
      const ctrl = new AbortController()
      const work = withTabLock(tab, ctrl.signal, () => doReload(tab, false, ctrl.signal))
      const rejected = assert.rejects(work, cancelled)
      await entered.promise
      let nextRan = false
      const next = withTabLock(tab, undefined, async () => { nextRan = true })
      ctrl.abort()
      await rejected
      await checkpoint()
      assert.equal(nextRan, false)
      loading = false
      if (event === 'did-fail-load') wc.emit(event, {}, -3, 'ERR_ABORTED', 'https://fixture.test/', true)
      else wc.emit(event)
      await next
      assert.equal(nextRan, true)
      for (const name of ['did-finish-load', 'did-fail-load', 'did-stop-loading', 'destroyed']) {
        assert.equal(wc.listenerCount(name), 0, `reload listener leaked: ${name}`)
      }
    })
  }

  await test('navigation timeout stops and drains raw loadURL before releasing the tab', options, async () => {
    let timeoutCallback
    const tabsModule = { exports: {} }
    const tabDeps = {
      electron: { app: { on() {} } },
      'node:async_hooks': require('node:async_hooks'),
      './network': {},
      './dialogs': {},
      './closed-shadow': {},
      './ref-context': { noteNavigation() {}, noteRendererRestart() {} }
    }
    const tabsFile = path.join(out, 'main/tabs.js')
    compileFunction(fs.readFileSync(tabsFile, 'utf8'), ['require', 'module', 'exports', 'setTimeout', 'clearTimeout'], { filename: tabsFile })(
      (name) => { assert.ok(Object.hasOwn(tabDeps, name), `Unexpected tabs dependency: ${name}`); return tabDeps[name] },
      tabsModule, tabsModule.exports,
      (callback, ms) => { assert.equal(ms, 20000); timeoutCallback = callback; return 1 },
      () => {}
    )
    const manager = new tabsModule.exports.TabManager('about:blank', '')
    const raw = deferred()
    const entered = deferred()
    let stopCalls = 0
    const wc = {
      isDestroyed: () => false,
      loadURL() { entered.resolve(); return raw.promise },
      stop() { stopCalls++ }
    }
    const tab = { ready: Promise.resolve(), view: { webContents: wc }, keepRendering: () => () => {} }
    const work = withTabLock(tab, undefined, () => manager.navigate(tab, 'https://fixture.test/'))
    const rejected = assert.rejects(work, /目标页面导航 超时/)
    await entered.promise
    let nextRan = false
    const next = withTabLock(tab, undefined, async () => { nextRan = true })
    timeoutCallback()
    await checkpoint()
    assert.equal(stopCalls, 1)
    assert.equal(nextRan, false, 'timeout wrapper must not release a pending native load')
    raw.reject(new Error('ERR_ABORTED'))
    await rejected
    await next
    assert.equal(nextRan, true)
    const replaced = { ...wc, loadURL: () => Promise.reject(new Error('ERR_ABORTED by manual navigation')), stop: () => assert.fail('Do not stop a manual replacement navigation') }
    await assert.rejects(manager.navigate({ ready: Promise.resolve(), view: { webContents: replaced } }, 'https://fixture.test/'), /ERR_ABORTED by manual navigation/)
  })
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
