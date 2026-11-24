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

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-tools-approval-'))
const out = path.join(tmp, 'compiled')
const tick = () => new Promise((resolve) => setImmediate(resolve))

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
      assert.ok(Object.hasOwn(deps, specifier), `Unexpected production dependency: ${specifier}`)
      return deps[specifier]
    }, module, module.exports
  )
  return module.exports
}

function createFixture({ requireOperationApproval = false } = {}) {
  // Keep the actual queue/abort contract as it evolves; only page I/O is stubbed.
  const { ActionError, withTabLock, raceAbort, throwIfAborted } = loadMain('actions', {
    electron: {}, '@snapshot/scripts': {}, '@snapshot/engine': { __aaSnapshot() {} },
    './progress': {}, './evidence': {},
    './ref-context': { checkRefContext: () => null, noteSnapshot() {}, noteNavigation() {}, noteRendererRestart() {} }
  })
  const calls = { type: [], frameType: [], frameEvaluate: [], pageEvaluate: [], sensitive: [], operation: [], actions: [], cookies: [] }
  const pending = []
  const tab = {
    id: 'tab-1', title: 'Fixture page', keepRendering: () => () => {},
    view: { webContents: {
      getURL: () => 'https://merchant.example/page',
      isDestroyed: () => false,
      executeJavaScript: async (script) => {
        calls.pageEvaluate.push(String(script))
        if (String(script).includes('fingerprint')) return { fingerprint: 'INPUT|password|secret|pw|current-password||Password' }
        return null
      }
    } }
  }
  const tabs = {
    activeId: tab.id,
    active: () => tab,
    get: (id) => id === tab.id ? tab : null
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
      ActionError, withTabLock, throwIfAborted, assertTabUsable: () => {}, assertRefContext: () => {},
      captureSnapshot: async () => ({ tree: 'snapshot', elements: [], url: 'https://merchant.example/page', title: 'Fixture page' }),
      snapshotText: (snap) => snap.tree,
      doNavigate: forbidden, doReload: forbidden, doClick: forbidden, doDrag: forbidden,
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
    tabs, 'about:blank', 'https://search.example/?q=', { resize: forbidden }, {}, approvals,
    (item) => calls.actions.push(item), () => ({ requireOperationApproval })
  )
  return { tools: new Map(tools.map((tool) => [tool.name, tool])), calls, pending }
}

function texts(result) {
  return result.content.map((item) => item.text ?? '').join('\n')
}

try {
  const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc')
  const compiled = spawnSync(process.execPath, [
    tsc, '--ignoreConfig', '--noCheck', '--noResolve', '--outDir', out,
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--esModuleInterop',
    ...['tools', 'actions'].map((name) => path.join(root, `src/main/${name}.ts`))
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(compiled.status, 0, `Compilation failed: ${compiled.error ?? ''}\n${compiled.stdout}\n${compiled.stderr}`)

  await test('Cookie actions accept explicit operations only, and writes and clears keep the approval gate', async () => {
    const f = createFixture({ requireOperationApproval: true })
    const handle = f.tools.get('browser_cookies').handler
    for (const args of [{}, { action: 'unsupported' }, { action: 123 }]) {
      await assert.rejects(handle(args), /Cookie 操作必须/)
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
    assert.equal(denied.calls.operation[0].detail, `frame f2 · ${expression}`)
    assert.deepEqual(denied.calls.frameEvaluate, [], 'denied evaluation must not reach page execution')
    denied.pending[0].resolve(false)
    await assert.rejects(deniedWork, /高危操作已取消/)

    const allowed = createFixture({ requireOperationApproval: true })
    const allowedWork = allowed.tools.get('browser_frame').handler({ action: 'evaluate', frameId: 'f2', expression })
    await tick()
    assert.equal(allowed.calls.operation.length, 1)
    allowed.pending[0].resolve(true)
    const result = await allowedWork
    assert.equal(texts(result), '"EVAL_RESULT"')
    assert.equal(allowed.calls.frameEvaluate.length, 1)
    assert.equal(allowed.calls.frameEvaluate[0].expression, expression, 'explicit evaluation semantics are unchanged after approval')
  })
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
