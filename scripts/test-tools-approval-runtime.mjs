#!/usr/bin/env node
/** Runtime approval/redaction regressions against transpiled production tools.ts. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { compileFunction } from 'node:vm'
import test from 'node:test'
import { SECURITY_MODULES, securityFixture } from './security-fixture.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-tools-approval-'))
const out = path.join(tmp, 'compiled')
const tick = () => new Promise((resolve) => setImmediate(resolve))
let security

function deferred() {
  let resolve
  const promise = new Promise((yes) => { resolve = yes })
  return { promise, resolve }
}

const { TOOL_DEFS, TOOL_ANNOTATIONS } = await import(pathToFileURL(path.join(root, 'src/shared/tool-defs.mjs')).href)

function loadMain(name, deps) {
  const filename = path.join(out, `${name}.js`)
  const module = { exports: {} }
  compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(
    (specifier) => {
      if (specifier.startsWith('node:')) return require(specifier)
      assert.ok(Object.hasOwn(deps, specifier) || Object.hasOwn(security ?? {}, specifier), `Unexpected production dependency: ${specifier}`)
      return deps[specifier] ?? security[specifier]
    }, module, module.exports
  )
  return module.exports
}

function createFixture({ requireOperationApproval = false, approvalService = true } = {}) {
  const refContext = { error: null }
  // Keep the actual queue/abort contract as it evolves; only page I/O is stubbed.
  const { ActionError, refFailure, assertRefContext, withTabLock, raceAbort, throwIfAborted } = loadMain('actions', {
    electron: {}, '@snapshot/scripts': {}, '@snapshot/engine': { __aaSnapshot() {} },
    './progress': {}, './evidence': {},
    './ref-context': { checkRefContext: () => refContext.error, noteSnapshot() {}, noteNavigation() {}, noteRendererRestart() {} }
  })
  const calls = { type: [], clicks: [], frameType: [], frameEvaluate: [], pageEvaluate: [], sensitive: [], operation: [], actions: [], cookies: [] }
  const operationState = { ok: true, risky: false, label: 'Fixture control', fingerprint: 'fixture', document: '1', url: 'https://merchant.example/page' }
  const pending = []
  const tab = {
    id: 'tab-1', title: 'Fixture page', keepRendering: () => () => {},
    view: { webContents: {
      getURL: () => 'https://merchant.example/page',
      isDestroyed: () => false,
      executeJavaScript: async (script) => {
        calls.pageEvaluate.push(String(script))
        if (String(script).includes('__aaOperationNodes')) return { ...operationState }
        if (String(script).includes('fingerprint')) return { fingerprint: 'INPUT|password|secret|pw|current-password||Password' }
        return null
      }
    } }
  }
  const tabs = {
    activeId: tab.id,
    active: () => tab,
    get: (id) => id === tab.id ? tab : null,
    currentAgentClientId: () => undefined
  }
  const approvals = {
    assertRunning() {},
    request(meta) {
      calls.sensitive.push(meta)
      const wait = deferred()
      pending.push(wait)
      return wait.promise
    },
    opRequest(meta) {
      calls.operation.push(meta)
      const wait = deferred()
      pending.push(wait)
      return wait.promise
    }
  }
  const forbidden = () => { throw new Error('unexpected production dependency in approval fixture') }
  const deps = {
    '@shared/tool-defs.mjs': { TOOL_DEFS, TOOL_ANNOTATIONS },
    '@snapshot/scripts': {
      checkedStateScript: (ref) => `checked:${ref}`,
      fingerprintScript: (ref) => `fingerprint:${ref}`,
      jsLiteral: (value) => JSON.stringify(value),
      refLiteral: (ref) => JSON.stringify(ref),
      tagNameScript: (ref) => `tag:${ref}`
    },
    './tabs': { TabManager: class {}, normalizeUrl: (url) => url },
    './network': { clipBody: (x) => x, safeNetworkHeaders: (x) => x, safeNetworkUrl: (x) => x },
    './actions': {
      ActionError, refFailure, withTabLock, throwIfAborted, assertTabUsable: () => {}, assertRefContext,
      captureSnapshot: async () => ({ tree: 'snapshot', elements: [], url: 'https://merchant.example/page', title: 'Fixture page' }),
      snapshotText: (snap) => snap.tree,
      doNavigate: forbidden, doReload: forbidden, doClick: async (_tab, ref) => { calls.clicks.push(ref); return { clicked: ref } }, doDrag: forbidden,
      doType: async (_tab, ref, value, opts) => { calls.type.push({ ref, value, opts }); return { typed: 'INPUT' } },
      doSelectOption: async () => ({ selected: 'choice' }), doScroll: forbidden, doExtract: forbidden,
      doWaitForText: forbidden, doWaitForCondition: forbidden, doWaitForDom: forbidden,
      doPressKey: forbidden, doScreenshot: forbidden, doConsoleLogs: forbidden, raceAbort,
      doCookies: async (_tab, { action }) => { calls.cookies.push(action); return { content: action } },
      resolveWebContents: (manager, id) => {
        const result = id ? manager.get(id) : manager.active()
        if (!result) throw new Error('missing fixture tab')
        return result
      },
      inspectTypeTarget: async (_tab, ref) => ({
        ok: true,
        sensitive: ref === 'password',
        label: ref === 'password' ? 'Password' : 'Text field',
        fingerprint: 'INPUT|password|secret|pw|current-password||Password'
      })
    },
    './dialogs': { readDialogs: forbidden, clearDialogs: forbidden, setDialogPolicy: forbidden, clearDialogPolicy: forbidden, dialogGuardReady: forbidden },
    './assertions': { runAssertions: forbidden, formatAssertions: forbidden },
    './frames': {
      listFrames: () => [], frameText: forbidden, frameElements: forbidden,
      frameEvaluate: async (_wc, frameId, expression) => {
        calls.frameEvaluate.push({ frameId, expression })
        if (expression.includes('__aaOperationNodes')) return { ok: true, risky: false, label: 'Fixture frame', fingerprint: 'frame-fixture', document: '1', url: 'https://payments.example/frame' }
        if (expression.includes('const el = document.querySelector(')) {
          return { ok: true, sensitive: true, label: 'Card number', fingerprint: 'INPUT|text|card|cc||Card number', url: 'https://payments.example/frame' }
        }
        return 'EVAL_RESULT'
      },
      frameClick: forbidden,
      frameType: async (_wc, frameId, selector, value) => { calls.frameType.push({ frameId, selector, value }); return { typed: 'INPUT' } },
      frameSelect: forbidden
    },
    './visual': { visualSave: forbidden, visualCompare: forbidden, visualList: forbidden, visualDelete: forbidden, formatDiff: forbidden },
    './evidence': { getEvidenceManager: forbidden },
    './contrast': { auditContrast: forbidden, formatContrast: forbidden },
    './viewport': { captureViewportMatrix: forbidden, VIEWPORT_PRESETS: [], formatViewportMatrix: forbidden },
    './cloudflare': { clickCloudflareControl: forbidden, formatCloudflareStatus: forbidden, inspectCloudflare: forbidden, waitForCloudflare: forbidden },
    './extensions': { getExtensionManager: forbidden },
    './downloads': {}
  }

  const { buildTools } = loadMain('tools', deps)
  const tools = buildTools(
    tabs, 'about:blank', 'https://search.example/?q=', {
      resize: forbidden, releaseToAi: () => ({}), cancelTask: () => true,
      taskDetail: () => ({ id: 1, client: 7, taskId: 'owned-task', tool: 'browser_wait', status: 'interrupted', startedAt: 1 })
    }, {}, approvalService ? approvals : undefined,
    (item) => calls.actions.push(item), () => ({ requireOperationApproval })
  )
  return { tools: new Map(tools.map((tool) => [tool.name, tool])), calls, pending, operationState, refContext }
}

function texts(result) {
  return result.content.map((item) => item.text ?? '').join('\n')
}

try {
  const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc')
  const compiled = spawnSync(process.execPath, [
    tsc, '--ignoreConfig', '--noCheck', '--noResolve', '--outDir', out,
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--esModuleInterop',
    ...['tools', 'actions', ...SECURITY_MODULES].map((name) => path.join(root, `src/main/${name}.ts`))
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(compiled.status, 0, `Compilation failed: ${compiled.error ?? ''}\n${compiled.stdout}\n${compiled.stderr}`)
  security = securityFixture(out)

  await test('Cookie actions accept explicit operations only, and writes and clears keep the approval gate', async () => {
    const f = createFixture({ requireOperationApproval: true })
    const handle = f.tools.get('browser_cookies').handler
    for (const args of [{}, { action: 'unsupported' }, { action: 123 }]) {
      await assert.rejects(handle(args), /Cookie 操作必须|INVALID_ARGUMENT/)
    }
    assert.deepEqual(f.calls.cookies, [])
    assert.deepEqual(f.calls.operation, [])
    assert.equal(texts(await handle({ action: 'get' })), 'get')
    const denied = handle({ action: 'set', name: 'fixture', value: 'sample' })
    await tick()
    assert.equal(f.calls.operation.length, 1)
    assert.deepEqual(f.calls.cookies, ['get'])
    f.pending[0].resolve(false)
    await assert.rejects(denied, /高危操作已取消/)
    const allowed = handle({ action: 'clear', name: 'fixture' })
    await tick()
    assert.equal(f.calls.operation.length, 2)
    assert.deepEqual(f.calls.cookies, ['get'])
    f.pending[1].resolve(true)
    assert.equal(texts(await allowed), 'clear')
    assert.deepEqual(f.calls.cookies, ['get', 'clear'])
  })

  await test('browser_fill_form sensitive input requests approval, never calls doType, and does not echo the secret', async () => {
    const f = createFixture()
    const secret = 'fixture-secret-never-log'
    const work = f.tools.get('browser_fill_form').handler({ fields: [{ ref: 'password', value: secret }], snapshot: false })
    await tick()
    assert.equal(f.calls.sensitive.length, 1)
    assert.equal(f.calls.sensitive[0].site, 'merchant.example')
    assert.deepEqual(f.calls.type, [], 'sensitive data must not reach the page typing implementation')
    f.pending[0].resolve(true)
    const result = await work
    assert.match(texts(result), /敏感字段请由你输入/)
    assert.equal(texts(result).includes(secret), false)
    assert.equal(JSON.stringify(f.calls.actions).includes(secret), false)
    assert.deepEqual(f.calls.type, [])
  })

  await test('browser_fill_form denied sensitive approval leaves the field untouched', async () => {
    const f = createFixture()
    const work = f.tools.get('browser_fill_form').handler({ fields: [{ ref: 'password', value: 'fixture-secret' }], snapshot: false })
    await tick()
    f.pending[0].resolve(false)
    await assert.rejects(work, /敏感输入已取消/)
    assert.deepEqual(f.calls.type, [])
  })

  await test('ordinary form input output and action logs do not contain entered-value prefixes', async () => {
    const f = createFixture()
    const value = 'ordinary-value-must-not-appear-in-output'
    const result = await f.tools.get('browser_fill_form').handler({ fields: [{ ref: 'text', value }], snapshot: false })
    assert.equal(f.calls.type.length, 1)
    assert.equal(f.calls.type[0].value, value, 'ordinary input still reaches the existing typing path')
    assert.equal(texts(result).includes(value), false)
    assert.equal(JSON.stringify(f.calls.actions).includes(value), false)
  })

  await test('browser_fill_form submit follows the existing operation approval gate', async () => {
    const denied = createFixture({ requireOperationApproval: true })
    const deniedWork = denied.tools.get('browser_fill_form').handler({ fields: [{ ref: 'text', value: 'ordinary-submit-value', submit: true }], snapshot: false })
    await tick()
    assert.equal(denied.calls.operation.length, 1)
    assert.deepEqual(denied.calls.type, [])
    denied.pending[0].resolve(false)
    await assert.rejects(deniedWork, /高危操作已取消/)

    const allowed = createFixture({ requireOperationApproval: true })
    const allowedWork = allowed.tools.get('browser_fill_form').handler({ fields: [{ ref: 'text', value: 'ordinary-submit-value', submit: true }], snapshot: false })
    await tick()
    allowed.pending[0].resolve(true)
    await allowedWork
    assert.equal(allowed.calls.type.length, 1)
  })

  await test('browser_frame sensitive typing gates approval and never invokes frameType with supplied text', async () => {
    const f = createFixture()
    const secret = 'frame-secret-never-log'
    const work = f.tools.get('browser_frame').handler({ action: 'type', frameId: 'f2', selector: '#card', text: secret })
    await tick()
    assert.equal(f.calls.sensitive.length, 1)
    assert.equal(f.calls.sensitive[0].site, 'payments.example')
    assert.deepEqual(f.calls.frameType, [])
    f.pending[0].resolve(true)
    const result = await work
    assert.match(texts(result), /内容由你在网页中输入/)
    assert.equal(texts(result).includes(secret), false)
    assert.equal(JSON.stringify(f.calls.actions).includes(secret), false)
    assert.deepEqual(f.calls.frameType, [])
  })

  await test('browser_frame evaluate denial does not execute the expression; approval preserves explicit evaluation', async () => {
    const expression = 'window.__fixtureAuthorizedExpression'
    const denied = createFixture({ requireOperationApproval: true })
    const deniedWork = denied.tools.get('browser_frame').handler({ action: 'evaluate', frameId: 'f2', expression })
    await tick()
    assert.equal(denied.calls.operation.length, 1)
    assert.equal(denied.calls.operation[0].fieldLabel, '在网页中执行 JavaScript')
    assert.equal(denied.calls.operation[0].detail, 'Fixture frame')
    assert.equal(denied.calls.frameEvaluate.some((call) => call.expression === expression), false, 'denied evaluation must not reach page execution')
    denied.pending[0].resolve(false)
    await assert.rejects(deniedWork, /高危操作已取消/)

    const allowed = createFixture({ requireOperationApproval: true })
    const allowedWork = allowed.tools.get('browser_frame').handler({ action: 'evaluate', frameId: 'f2', expression })
    await tick()
    assert.equal(allowed.calls.operation.length, 1)
    allowed.pending[0].resolve(true)
    const result = await allowedWork
    assert.equal(texts(result), '"EVAL_RESULT"')
    assert.equal(allowed.calls.frameEvaluate.filter((call) => call.expression === expression).length, 1, 'explicit evaluation semantics are unchanged after approval')
  })

  await test('legacy approval preference cannot disable mandatory execution approval, and absent approval service fails closed', async () => {
    const f = createFixture({ requireOperationApproval: false })
    const work = f.tools.get('browser_evaluate').handler({ expression: 'window.fixture = 1' })
    await tick()
    assert.equal(f.calls.operation.length, 1)
    f.pending[0].resolve(false)
    await assert.rejects(work, /高危操作已取消/)
    const unavailable = createFixture({ approvalService: false })
    await assert.rejects(unavailable.tools.get('browser_evaluate').handler({ expression: 'window.fixture = 1' }), /审批服务不可用/)
  })

  await test('sensitive Cookie reads require approval while default reads remain available', async () => {
    const f = createFixture()
    const work = f.tools.get('browser_cookies').handler({ action: 'get', includeSensitive: true })
    await tick()
    assert.equal(f.calls.operation.length, 1)
    assert.deepEqual(f.calls.cookies, [])
    f.pending[0].resolve(false)
    await assert.rejects(work, /高危操作已取消/)
    assert.equal(texts(await f.tools.get('browser_cookies').handler({ action: 'get' })), 'get')
  })

  await test('risk metadata gates clicks and approval cannot survive document or target changes', async () => {
    const safe = createFixture()
    await safe.tools.get('browser_click').handler({ ref: 'e1', snapshot: false })
    assert.deepEqual(safe.calls.clicks, ['e1'])
    assert.deepEqual(safe.calls.operation, [])
    for (const changed of ['fingerprint', 'document', 'url']) {
      const f = createFixture()
      f.operationState.risky = true
      const work = f.tools.get('browser_click').handler({ ref: 'e1', snapshot: false })
      await tick()
      assert.equal(f.calls.operation.length, 1)
      f.operationState[changed] = 'changed'
      f.pending[0].resolve(true)
      await assert.rejects(work, /STALE_REF/)
      assert.deepEqual(f.calls.clicks, [])
    }
  })

  await test('keyboard chords and risky select/drag controls cannot bypass operation approval', async () => {
    for (const [tool, args] of [
      ['browser_press_key', { key: 'Ctrl+Enter' }],
      ['browser_press_key', { key: 'Shift+Return' }],
      ['browser_select_option', { ref: 'e1', value: 'delete' }],
      ['browser_drag', { ref: 'e1', toRef: 'e2' }]
    ]) {
      const f = createFixture()
      f.operationState.risky = true
      const work = f.tools.get(tool).handler(args)
      await tick()
      assert.equal(f.calls.operation.length, 1, tool)
      f.pending[0].resolve(false)
      await assert.rejects(work, /高危操作已取消/, tool)
    }
  })

  await test('operation preflight preserves existing navigation, missing-ref and detached-element errors', async () => {
    const f = createFixture()
    const handle = f.tools.get('browser_click').handler
    f.refContext.error = { code: 'NAVIGATION_ERROR', message: 'reason=navigation_changed 页面在快照后已导航' }
    await assert.rejects(handle({ ref: 'e1', snapshot: false }), /\[NAVIGATION_ERROR\] reason=navigation_changed/)
    assert.deepEqual(f.calls.pageEvaluate, [], 'stale document context is rejected before page target inspection')
    f.refContext.error = null
    f.operationState.ok = false
    f.operationState.reason = 'detached'
    await assert.rejects(handle({ ref: 'e1', snapshot: false }), /\[ELEMENT_NOT_FOUND\] reason=element_detached/)
    f.operationState.reason = 'no-ref'
    await assert.rejects(handle({ ref: 'e1', snapshot: false }), /\[STALE_REF\] reason=stale_ref/)
    assert.deepEqual(f.calls.operation, [], 'invalid targets never open an approval')
    assert.deepEqual(f.calls.clicks, [], 'invalid targets never dispatch a click')
  })

  await test('named scope grants never bypass the final native decision or stale target validation', async () => {
    const manager = security['./permissions'].getPermissionManager()
    const f = createFixture()
    f.operationState.risky = true
    manager.grant({ profileId: 'default' }, 'high-risk', { action: '执行可能产生副作用的页面操作' })
    const work = f.tools.get('browser_click').handler({ ref: 'e1', snapshot: false })
    await tick()
    assert.equal(f.calls.operation.length, 1)
    assert.deepEqual(f.calls.clicks, [], 'granting a generic operation does not approve this target')
    assert.equal(manager.list({ profileId: 'default' }).length, 0, 'one-use scope grant is consumed')
    f.operationState.fingerprint = 'different-target'
    f.pending[0].resolve(true)
    await assert.rejects(work, /STALE_REF/)
    assert.deepEqual(f.calls.clicks, [])

    const cookie = createFixture()
    manager.grant({ profileId: 'default' }, 'sensitive', { action: '读取 Cookie 凭据' })
    const sensitive = cookie.tools.get('browser_cookies').handler({ action: 'get', includeSensitive: true })
    await tick()
    assert.equal(cookie.calls.operation.length, 1, 'a sensitive grant still requires a concrete native decision')
    cookie.pending[0].resolve(false)
    await assert.rejects(sensitive, /高危操作已取消/)
    assert.deepEqual(cookie.calls.cookies, [])
  })

  await test('session task controls and release remain available while a workflow owns the Profile', async () => {
    const profiles = security['./profiles'].getProfileManager()
    const original = { assertLeaseAccess: profiles.assertLeaseAccess, withUse: profiles.withUse }
    try {
      profiles.assertLeaseAccess = () => { throw new Error('PROFILE_BUSY') }
      profiles.withUse = () => { throw new Error('PROFILE_BUSY') }
      const f = createFixture()
      for (const [tool, args] of [
        ['browser_tasks', { action: 'list' }],
        ['browser_tasks', { action: 'get', taskId: 'owned-task' }],
        ['browser_tasks', { action: 'cancel', id: 1 }],
        ['browser_tasks', { action: 'pause' }],
        ['browser_tasks', { action: 'resume' }],
        ['browser_window', { action: 'release' }]
      ]) {
        const result = await f.tools.get(tool).handler(args)
        assert.equal(result.isError, undefined, `${tool} ${args.action}`)
      }
      assert.deepEqual(f.calls.pageEvaluate, [], 'these controls do not inspect page or Profile data')
      await assert.rejects(f.tools.get('browser_extract').handler({}), /PROFILE_BUSY/, 'page reads still enforce the workflow lease')
    } finally { Object.assign(profiles, original) }
  })
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
