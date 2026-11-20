#!/usr/bin/env node
/**
 * printPage 单元测试（无 Electron、无 GUI、无打印机、无真实用户目录）。
 * 编译产物只写入系统临时目录；被测模块的 Electron / locale / fs 均被 mock，
 * 不加载真实设置或访问真实用户目录。
 */
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import Module, { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-printing-'))
const out = path.join(tmp, 'compiled')
const originalLoad = Module._load
const unhandled = []
const onUnhandled = (reason) => unhandled.push(reason)
process.on('unhandledRejection', onUnhandled)
let fsCalls = 0
const mockFs = new Proxy({}, {
  get: (_target, method) => {
    fsCalls++
    throw new Error(`Production filesystem access is forbidden: ${String(method)}`)
  }
})

let locale = 'zh-CN'
let localeCalls = 0
let dialogs = []
let printCalls = []
let printImpl = () => {}
let dialogError
const mockLocale = {
  getMainLocale: () => {
    localeCalls++
    return locale
  }
}
const mockElectron = {
  dialog: {
    showMessageBox: (...args) => {
      dialogs.push(args)
      if (dialogError) throw dialogError
      return mockElectron.dialog.result
    }
  }
}
mockElectron.dialog.result = Promise.resolve({ response: 0 })

let failures = 0
let checks = 0
const tick = () => new Promise((resolve) => setImmediate(resolve))

function wcFixture() {
  const wc = new EventEmitter()
  wc.destroyed = false
  wc.isDestroyed = () => wc.destroyed
  wc.print = (options, callback) => {
    assert.deepEqual(options, { silent: false }, 'Every request must be non-silent')
    printCalls.push({ wc, options, callback })
    printImpl(options, callback, wc)
  }
  wc.destroy = () => {
    wc.destroyed = true
    wc.emit('destroyed')
  }
  return wc
}

function winFixture() {
  const win = new EventEmitter()
  win.destroyed = false
  win.isDestroyed = () => win.destroyed
  win.close = () => {
    win.destroyed = true
    win.emit('closed')
  }
  return win
}

function reset() {
  locale = 'zh-CN'
  localeCalls = 0
  dialogs = []
  printCalls = []
  unhandled.length = 0
  fsCalls = 0
  dialogError = undefined
  printImpl = () => {}
  mockElectron.dialog.result = Promise.resolve({ response: 0 })
}

/** dialog.showMessageBox 有两种重载：有父窗口时 (parent, options)，否则 (options)。 */
const optionsOf = (call) => (call.length === 2 ? call[1] : call[0])

async function test(label, fn) {
  checks++
  reset()
  try {
    await fn()
    await tick()
    assert.equal(fsCalls, 0, 'Production code must not access the filesystem')
    assert.deepEqual(unhandled, [], 'dialog rejection must not become an unhandled rejection')
    console.log(`  PASS: ${label}`)
  } catch (error) {
    failures++
    console.error(`  FAIL: ${label}\n${error.stack || error}`)
  }
}

try {
  const config = path.join(tmp, 'tsconfig.json')
  fs.writeFileSync(config, JSON.stringify({
    compilerOptions: {
      target: 'ES2022', module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
      esModuleInterop: true, skipLibCheck: true, types: ['node'],
      typeRoots: [path.join(root, 'node_modules', '@types')],
      rootDir: path.join(root, 'src'), outDir: out
    },
    files: [path.join(root, 'src', 'main', 'printing.ts')]
  }))
  const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc')
  const compiled = spawnSync(process.execPath, [tsc, '--project', config], { cwd: root, stdio: 'inherit' })
  assert.equal(compiled.status, 0, compiled.error?.message || 'printing.ts 编译失败')

  let printPage
  try {
    Module._load = function (name, parent, ...rest) {
      if (parent?.filename === path.join(out, 'main', 'printing.js')) {
        if (name === 'electron') return mockElectron
        if (name === './locale') return mockLocale
        if (name === 'node:fs' || name === 'fs') return mockFs
        throw new Error(`Unexpected production dependency: ${name}`)
      }
      return originalLoad.call(this, name, parent, ...rest)
    }
    ;({ printPage } = require(path.join(out, 'main', 'printing.js')))
  } finally {
    Module._load = originalLoad
  }

  await test('success: silent=false, 无弹框, 返回 true', async () => {
    const wc = wcFixture()
    printImpl = (_options, callback) => callback(true, '')
    assert.equal(printPage(wc, null), true)
    assert.equal(printCalls.length, 1)
    assert.deepEqual(printCalls[0].options, { silent: false })
    await tick()
    assert.equal(dialogs.length, 0, '成功不得弹框')
    assert.equal(localeCalls, 1)
  })

  await test('failure: 异步 failureReason 走原样 detail 的错误框', async () => {
    const wc = wcFixture()
    const win = winFixture()
    const reason = 'Invalid printer settings Ω e\u0301 $& {x}\n第二行'
    printImpl = (_options, callback) => callback(false, reason)
    assert.equal(printPage(wc, win), true)
    await tick()
    assert.equal(dialogs.length, 1)
    const [parent] = dialogs[0]
    const options = optionsOf(dialogs[0])
    assert.equal(parent, win)
    assert.equal(options.type, 'error')
    assert.equal(options.title, 'Aa Browser — 打印')
    assert.equal(options.message, '无法完成打印，请检查打印机配置。')
    assert.equal(options.detail, reason, 'raw reason 必须原样')
    assert.equal(options.buttons[0], '确定')
    assert.equal(options.noLink, true)
  })

  await test('取消: 中立 info，不谎报成功或失败', async () => {
    const wc = wcFixture()
    printImpl = (_options, callback) => callback(false, 'Print job canceled')
    assert.equal(printPage(wc, null), true)
    await tick()
    const options = optionsOf(dialogs[0])
    assert.equal(options.type, 'info')
    assert.equal(options.message, '打印未完成。')
    assert.equal(options.detail, 'Print job canceled')
    assert.ok(!/成功|success/i.test(options.message))
  })

  await test('同步 throw: 返回 false 并安全反馈错误', async () => {
    const wc = wcFixture()
    printImpl = () => { throw new Error('invalid print settings Ω') }
    assert.equal(printPage(wc, null), false)
    assert.equal(printCalls.length, 1)
    await tick()
    assert.equal(dialogs.length, 1)
    assert.equal(optionsOf(dialogs[0]).type, 'error')
    assert.equal(optionsOf(dialogs[0]).detail, 'invalid print settings Ω')
  })

  await test('已销毁 WebContents: 不调用 print，不弹框', async () => {
    const wc = wcFixture()
    wc.destroyed = true
    assert.equal(printPage(wc, null), false)
    await tick()
    assert.equal(printCalls.length, 0)
    assert.equal(dialogs.length, 0)
    assert.equal(localeCalls, 0)
  })

  await test('等待期间销毁: 回调不再弹框，回调多次也只处理一次', async () => {
    const wc = wcFixture()
    let callback
    printImpl = (_options, cb) => { callback = cb }
    assert.equal(printPage(wc, null), true)
    wc.destroy()
    callback(false, 'Print job failed')
    callback(false, 'Print job failed')
    await tick()
    assert.equal(dialogs.length, 0)
  })

  await test('同类窗口 closed 期间销毁: 不弹框', async () => {
    const wc = wcFixture()
    const win = winFixture()
    let callback
    printImpl = (_options, cb) => { callback = cb }
    assert.equal(printPage(wc, win), true)
    win.close()
    callback(false, 'Print job failed')
    await tick()
    assert.equal(dialogs.length, 0)
  })

  await test('同 wc 单飞: 重复调用不新增 print，完成后可再次打印', async () => {
    const wc = wcFixture()
    let callback
    printImpl = (_options, cb) => { callback = cb }
    assert.equal(printPage(wc, null), true)
    assert.equal(printPage(wc, null), false)
    assert.equal(printCalls.length, 1)
    callback(true, '')
    await tick()
    printImpl = (_options, cb) => cb(true, '')
    assert.equal(printPage(wc, null), true)
    assert.equal(printCalls.length, 2)
  })

  await test('busy 清理: 弹框期间保持单飞，dialog 结束后释放；dialog 失败也释放', async () => {
    const wc = wcFixture()
    let callback
    printImpl = (_options, cb) => { callback = cb }
    mockElectron.dialog.result = new Promise((resolve) => { wc.resolveDialog = resolve })
    assert.equal(printPage(wc, null), true)
    callback(false, 'Print job failed')
    await tick()
    assert.equal(printPage(wc, null), false, '弹框未关闭前仍应单飞')
    wc.resolveDialog({ response: 0 })
    await tick()
    printImpl = (_options, cb) => cb(true, '')
    assert.equal(printPage(wc, null), true, '弹框关闭后应释放')

    // dialog 自身 reject 也必须释放，且不得产生 unhandled rejection
    mockElectron.dialog.result = Promise.reject(new Error('dialog unavailable'))
    printImpl = (_options, cb) => cb(false, 'Print job failed')
    assert.equal(printPage(wc, null), true)
    await tick()
    printImpl = (_options, cb) => cb(true, '')
    assert.equal(printPage(wc, null), true, 'dialog 失败后仍应释放')
  })

  await test('callback 多次调用: 仅一次错误反馈', async () => {
    const wc = wcFixture()
    let callback
    printImpl = (_options, cb) => { callback = cb }
    printPage(wc, null)
    callback(false, 'Print job failed')
    callback(false, 'Print job failed')
    callback(true, '')
    await tick()
    assert.equal(dialogs.length, 1)
  })

  await test('原生对话框同步 throw: 安全清理 busy 且无未处理异常', async () => {
    const wc = wcFixture()
    let calls = 0
    dialogError = new Error('dialog unavailable')
    printImpl = (_options, callback) => callback(false, 'Print job failed')
    assert.equal(printPage(wc, null), true)
    dialogError = undefined
    printImpl = (_options, callback) => { calls++; callback(true, '') }
    assert.equal(printPage(wc, null), true, '原生对话框异常后应释放单飞状态')
    assert.equal(calls, 1)
  })

  await test('en-US: 标题/提示/按钮英文，detail 仍原样', async () => {
    locale = 'en-US'
    const wc = wcFixture()
    printImpl = (_options, callback) => callback(false, 'Invalid printer settings')
    assert.equal(printPage(wc, null), true)
    await tick()
    const options = optionsOf(dialogs[0])
    assert.equal(options.title, 'Aa Browser — Print')
    assert.equal(options.message, 'Printing could not be completed. Check the printer configuration.')
    assert.equal(options.buttons[0], 'OK')
    assert.equal(options.detail, 'Invalid printer settings')
  })

  await test('locale 在开始时捕获: 中途切换语言不改变本次反馈', async () => {
    const wc = wcFixture()
    let callback
    printImpl = (_options, cb) => { callback = cb }
    assert.equal(printPage(wc, null), true)
    locale = 'en-US'
    callback(false, 'Print job failed')
    await tick()
    assert.equal(optionsOf(dialogs[0]).title, 'Aa Browser — 打印')
    assert.equal(localeCalls, 1)
  })

  await test('父窗口已销毁: 不调用 print；无父窗口仍可反馈', async () => {
    const wc1 = wcFixture()
    const dead = winFixture()
    dead.destroyed = true
    assert.equal(printPage(wc1, dead), false)
    assert.equal(printCalls.length, 0)

    const wc2 = wcFixture()
    printImpl = (_options, callback) => callback(false, 'Print job canceled')
    assert.equal(printPage(wc2, null), true)
    await tick()
    assert.equal(dialogs.length, 1)
    assert.equal(dialogs[0].length, 1, '无父窗口时应使用不绑定窗口的重载')
  })
} finally {
  Module._load = originalLoad
  process.removeListener('unhandledRejection', onUnhandled)
  fs.rmSync(tmp, { recursive: true, force: true })
}

if (failures) {
  console.error(`\n${failures}/${checks} 项失败`)
  process.exit(1)
}
console.log(`\n🎉 printPage 单元测试通过（${checks} 项）`)