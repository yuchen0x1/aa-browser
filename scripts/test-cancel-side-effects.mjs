#!/usr/bin/env node
/** Exercise production tool wrappers and actions with controllable Electron/approval boundaries. */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { compileFunction, constants } from 'node:vm'
import { TOOL_ANNOTATIONS, TOOL_DEFS } from '../src/shared/tool-defs.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-cancel-side-effects-'))
// HAR/PDF exports are confined to an allowed root; point that root at this fixture.
process.env.AA_BROWSER_EXPORT_DIR = tmp
const out = path.join(tmp, 'compiled')
const url = 'https://fixture.test/page'
const text = 'fixture text'
const cancelled = { message: /已被用户中断/ }

function load(file, deps) {
  const filename = path.join(out, file)
  const module = { exports: {} }
  compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], {
    filename,
    importModuleDynamically: constants.USE_MAIN_CONTEXT_DEFAULT_LOADER
  })((name) => {
    if (name.startsWith('node:')) return require(name)
    assert.ok(Object.hasOwn(deps, name), `Unexpected production dependency: ${name}`)
    return deps[name]
  }, module, module.exports)
  return module.exports
}

function deferred() {
  let resolve
  const promise = new Promise((yes) => { resolve = yes })
  return { promise, resolve }
}

try {
  const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc')
  const compiled = spawnSync(process.execPath, [
    tsc, '--ignoreConfig', '--noCheck', '--noResolve', '--rootDir', 'src', '--outDir', out,
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--esModuleInterop',
    'src/main/actions.ts', 'src/main/frames.ts', 'src/main/tools.ts', 'src/snapshot/scripts.ts'
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(compiled.status, 0, `Compilation failed: ${compiled.error ?? ''}\n${compiled.stdout}\n${compiled.stderr}`)

  // HAR uses a dynamic Electron import. Resolve it in the temp tree; fs/path/os stay real.
  const electronFixture = path.join(out, 'node_modules', 'electron')
  fs.mkdirSync(electronFixture, { recursive: true })
  fs.writeFileSync(path.join(electronFixture, 'package.json'), JSON.stringify({ exports: './index.mjs' }))
  fs.writeFileSync(path.join(electronFixture, 'index.mjs'), "export const app = { getVersion: () => 'fixture-version' }\n")
  const scripts = load('snapshot/scripts.js', {})
  const frames = load('main/frames.js', { '@snapshot/scripts': scripts })

  function fixture({ at, rejectStep = false, verify = text, approval = false, hitOk = true } = {}) {
    const calls = []
    const logs = []
    const entered = deferred()
    const release = deferred()
    async function step(name, value) {
      calls.push(name)
      if (name === at) {
        entered.resolve()
        await release.promise
        if (rejectStep) throw new Error('fixture: in-flight operation failed')
      }
      return value
    }
    const evidence = { getEvidenceManager: () => ({ record: (file, kind) => calls.push(`record:${kind}:${file}`) }) }
    const actions = load('main/actions.js', {
      '@snapshot/scripts': scripts,
      '@snapshot/engine': { __aaSnapshot() {} },
      './progress': {},
      './evidence': evidence,
      './ref-context': { checkRefContext: () => null, noteSnapshot() {}, noteNavigation() {}, noteRendererRestart() {} },
      electron: {}
    })
    const loc = { ok: true, x: 10, y: 10, hitOk, tag: 'INPUT', type: 'checkbox' }
    const pageSteps = new Map([
      [scripts.checkedStateScript('e1'), ['checked:e1', { ok: true, checked: false, type: 'checkbox' }]],
      [scripts.checkedStateScript('e2'), ['checked:e2', { ok: true, checked: false, type: 'checkbox' }]],
      [scripts.locateScript('e1'), ['locate:e1', loc]],
      [scripts.clickScript('e1'), ['domClick:e1', null]],
      [scripts.syntheticClickScript('e1', 'left'), ['syntheticClick:e1', null]],
      [scripts.laserCursorScript(10, 10, 'click'), ['laser', null]],
      [scripts.tagNameScript('e1'), ['tag:e1', 'select']],
      [scripts.selectOptionScript('e1', undefined, 'Choice'), ['select:e1', { ok: true, label: 'Choice', value: 'one' }]],
      [scripts.inspectInputScript('e1'), ['inspect:e1', { ok: true, sensitive: false }]],
      [scripts.focusScript('e1'), ['focus:e1', { ok: true, tag: 'INPUT', type: 'text' }]],
      [scripts.clearScript('e1'), ['clear:e1', { ok: true }]],
      [scripts.readValueScript('e1'), ['verify:e1', { ok: true, value: verify }]],
      [scripts.setValueScript('e1', text), ['setter:e1', { ok: true }]]
    ])
    const wc = {
      getURL: () => url,
      isDestroyed: () => false,
      isLoading: () => false,
      async executeJavaScript(script) {
        if (pageSteps.has(script)) return step(...pageSteps.get(script))
        if (script.includes('window.__aaClickProbe =')) return step('armProbe', true)
        if (script.includes('const p = window.__aaClickProbe')) return step('readProbe', false)
        if (script.includes('window.__fixtureEvaluate')) return step('evaluateDispatch', 1)
        if (script.includes('function __aaSnapshot') || script.includes('__aaSnapshot()')) return step('snapshot', { tree: 'fixture snapshot' })
        assert.fail(`Unexpected page script: ${script}`)
      },
      insertText: (value) => step(`insertText:${value}`),
      sendInputEvent: (event) => calls.push(event.keyCode ? `${event.type}:${event.keyCode}` : event.type),
      mainFrame: {
        url, frameTreeNodeId: 1, frames: [],
        executeJavaScript: (script) => script.includes('if (sensitive) el.focus()')
          ? step('frameInspect', { ok: true, sensitive: false })
          : step('frameWrite', { ok: true })
      }
    }
    const tab = {
      id: 'tab-1', title: 'Fixture', url, view: { webContents: wc },
      canUseWindowInput: () => true, keepRendering: () => () => {},
      net: {
        ensure: () => step('ensure'),
        toHar: (version, includeSensitive) => {
          calls.push('serializeHar')
          return { version, includeSensitive }
        }
      }
    }
    const tabs = { activeId: tab.id, active: () => tab }
    let onApprovalReturn
    const approvals = {
      // Single-call cancellation does not pause the approval manager.
      assertRunning() {},
      opRequest: () => {
        const approved = step('operationApproval', true)
        // Register before opGate's await reaction: approval has resolved true,
        // but the caller has not yet been allowed to dispatch the next action.
        if (onApprovalReturn) void approved.then(onApprovalReturn, () => {})
        return approved
      }
    }
    const { buildTools } = load('main/tools.js', {
      '@shared/tool-defs.mjs': { TOOL_DEFS, TOOL_ANNOTATIONS },
      '@snapshot/scripts': scripts,
      './actions': {
        ...actions,
        doStorage: (...args) => { calls.push('storageDispatch'); return actions.doStorage(...args) },
        doUploadFile: (...args) => { calls.push('uploadDispatch'); return actions.doUploadFile(...args) }
      }, './frames': frames, './evidence': evidence,
      './tabs': {}, './network': {}, './dialogs': {}, './assertions': {}, './visual': {}, './contrast': {}, './viewport': {}, './cloudflare': {},
      './extensions': { getExtensionManager: () => ({}) }
    })
    const tools = buildTools(tabs, 'about:blank', '', {}, {}, approvals, (entry) => logs.push(entry),
      () => ({ requireOperationApproval: approval }))
    const call = (name, args) => tools.find((tool) => tool.name === name).handler(args)
    async function abortDuring(name, args, { afterApproval = false } = {}) {
      const ctrl = new AbortController()
      if (afterApproval) onApprovalReturn = () => ctrl.abort()
      const work = call(name, { ...args, __aaSignal: ctrl.signal })
      try {
        await Promise.race([entered.promise, work.then(() => assert.fail(`Tool completed before ${at}`))])
        assert.equal(ctrl.signal.aborted, false, 'The tool must reach the pending step while still live')
        if (!afterApproval) ctrl.abort()
      } finally {
        release.resolve()
      }
      await assert.rejects(work, cancelled)
      assert.equal(ctrl.signal.aborted, true)
      assert.equal(logs.at(-1)?.isError, true)
    }
    return { calls, call, abortDuring }
  }

  const checkbox = { fields: [{ ref: 'e1', checked: true }] }
  const formSubmit = { fields: [{ ref: 'e1', value: text, submit: true }, { ref: 'e2', checked: true }] }
  const input = { ref: 'e1', text, clear: true, submit: true }
  const trustedClick = ['checked:e1', 'locate:e1', 'laser', 'armProbe', 'mouseMove', 'mouseDown', 'mouseUp']

  for (const { name, tool = 'browser_fill_form', args = checkbox, options, calls } of [
    { name: 'checkbox state return does not proceed to locate', options: { at: 'checked:e1' }, calls: ['checked:e1'] },
    { name: 'checkbox locate return does not start the first click', options: { at: 'locate:e1' }, calls: ['checked:e1', 'locate:e1'] },
    { name: 'failed probe arming does not start the first click', options: { at: 'armProbe', rejectStep: true }, calls: trustedClick.slice(0, 4) },
    { name: 'probe arming on an occluded checkbox does not start a DOM click', options: { at: 'armProbe', hitOk: false }, calls: trustedClick.slice(0, 4) },
    { name: 'click verification does not re-click', options: { at: 'readProbe' }, calls: [...trustedClick, 'readProbe'] },
    { name: 'select tag probe does not change selection', args: { fields: [{ ref: 'e1', label: 'Choice' }] }, options: { at: 'tag:e1' }, calls: ['tag:e1'] },
    { name: 'focus return does not clear the field', tool: 'browser_type', args: input, options: { at: 'focus:e1' }, calls: ['inspect:e1', 'focus:e1'] },
    { name: 'clear return does not insert or submit', tool: 'browser_type', args: input, options: { at: 'clear:e1' }, calls: ['inspect:e1', 'focus:e1', 'clear:e1'] },
    { name: 'insertText return does not verify, submit Enter, or touch the next field', args: formSubmit, options: { at: `insertText:${text}` }, calls: ['inspect:e1', 'focus:e1', `insertText:${text}`] },
    { name: 'verification mismatch does not run setter fallback', args: formSubmit, options: { at: 'verify:e1', verify: '' }, calls: ['inspect:e1', 'focus:e1', `insertText:${text}`, 'verify:e1'] },
    { name: 'rejected verification does not swallow cancellation and run setter fallback', args: formSubmit, options: { at: 'verify:e1', rejectStep: true }, calls: ['inspect:e1', 'focus:e1', `insertText:${text}`, 'verify:e1'] },
    { name: 'setter return does not submit Enter', args: formSubmit, options: { at: 'setter:e1', verify: '' }, calls: ['inspect:e1', 'focus:e1', `insertText:${text}`, 'verify:e1', 'setter:e1'] },
    { name: 'form submit approval does not allow focus after cancellation', args: formSubmit, options: { at: 'operationApproval', approval: true }, calls: ['inspect:e1', 'operationApproval'] },
    { name: 'frame type inspection does not dispatch the input script', tool: 'browser_frame', args: { action: 'type', frameId: 'f1', selector: '#field', text }, options: { at: 'frameInspect' }, calls: ['frameInspect'] },
    { name: 'frame evaluate approval does not dispatch the expression', tool: 'browser_frame', args: { action: 'evaluate', frameId: 'f1', expression: '1' }, options: { at: 'operationApproval', approval: true }, calls: ['operationApproval'] }
  ]) {
    await test(`in-flight cancellation: ${name}`, { timeout: 3000 }, async () => {
      const f = fixture(options)
      await f.abortDuring(tool, args)
      assert.deepEqual(f.calls, calls)
    })
  }

  for (const { tool, args } of [
    ...['set', 'remove', 'clear'].map((action) => ({ tool: 'browser_storage', args: { action, key: 'fixture', value: text } })),
    { tool: 'browser_upload_file', args: { ref: 'e1', paths: [path.join(tmp, 'never-upload.txt')] } },
    { tool: 'browser_evaluate', args: { expression: 'window.__fixtureEvaluate = 1' } }
  ]) {
    await test(`approval-return cancellation: ${tool} ${args.action ?? ''} never dispatches the approved operation`, { timeout: 3000 }, async () => {
      const f = fixture({ at: 'operationApproval', approval: true })
      await f.abortDuring(tool, args, { afterApproval: true })
      assert.deepEqual(f.calls, ['operationApproval'], 'Approval resolves true before cancellation; storage/upload/evaluation must not dispatch')
    })
  }

  await test('already-aborted click and frame tools do not dispatch any page script', async () => {
    const f = fixture()
    const ctrl = new AbortController()
    ctrl.abort()
    await assert.rejects(f.call('browser_click', { ref: 'e1', __aaSignal: ctrl.signal }), cancelled)
    // The low-level frame API must also reject independently of the wrapper.
    const wc = { isDestroyed: () => false, mainFrame: { url, frames: [], frameTreeNodeId: 1,
      executeJavaScript: () => assert.fail('Cancelled frame script must not be dispatched') } }
    await assert.rejects(frames.frameClick(wc, 'f1', '#field', 0, ctrl.signal), { name: 'AbortError' })
    await assert.rejects(frames.frameType(wc, 'f1', '#field', text, ctrl.signal), { name: 'AbortError' })
    await assert.rejects(frames.frameSelect(wc, 'f1', '#field', { value: 'one' }, ctrl.signal), { name: 'AbortError' })
    assert.deepEqual(f.calls, [])
  })

  for (const includeSensitive of [false, true]) {
    await test(`in-flight cancellation: HAR ensure does not create files (includeSensitive=${includeSensitive})`, { timeout: 3000 }, async () => {
      const f = fixture({ at: 'ensure', approval: true })
      const dir = path.join(tmp, `cancelled-har-${includeSensitive}`)
      const file = path.join(dir, 'result.har')
      await f.abortDuring('browser_har', { path: file, includeSensitive })
      assert.deepEqual(f.calls, includeSensitive ? ['operationApproval', 'ensure'] : ['ensure'])
      assert.equal(fs.existsSync(file), false)
      assert.equal(fs.existsSync(dir), false)
    })
  }

  await test('without cancellation, insert verification failure still falls back and submits', async () => {
    const f = fixture({ verify: '' })
    const result = await f.call('browser_fill_form', { fields: [formSubmit.fields[0]], snapshot: false, __aaSignal: new AbortController().signal })
    assert.match(result.content[0].text, /已填写 1 个字段/)
    assert.deepEqual(f.calls, ['inspect:e1', 'focus:e1', `insertText:${text}`, 'verify:e1', 'setter:e1', 'keyDown:Enter', 'keyUp:Enter'])
  })

  await test('without cancellation, HAR still saves and registers the approved output', async () => {
    const f = fixture({ approval: true })
    const file = path.join(tmp, 'successful-har', 'result.har')
    const result = await f.call('browser_har', { path: file, includeSensitive: true, __aaSignal: new AbortController().signal })
    assert.match(result.content[0].text, /HAR 已导出/)
    assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { version: 'fixture-version', includeSensitive: true })
    assert.deepEqual(f.calls, ['operationApproval', 'ensure', 'serializeHar', `record:har:${file}`])
  })
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
