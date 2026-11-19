#!/usr/bin/env node
/**
 * 页面注入脚本的字面量转义回归测试。
 *
 * 背景：所有动作脚本都由 src/snapshot/scripts.ts 拼成字符串再交给
 * webContents.executeJavaScript 执行，数据一旦被转义破坏，轻则脚本语法错误、
 * 重则选择器/文本被截断（CodeQL js/bad-code-sanitization 报的就是这类写法）。
 *
 * 本测试把 scripts.ts 编译成 JS，在 vm 沙箱里用假的 window/document 跑真实生成的
 * 脚本，断言：
 *   1) jsLiteral()/refLiteral() 的输出不含裸 `</script>`、U+2028、U+2029，且能被 JS 还原成原值
 *   2) 四个工具探针（click / checkedState / tagName / fingerprint）行为与内联版本一致
 *   3) 带数据的脚本（setValue / selectOption / containsText / storage / upload）
 *      在页面侧拿到的就是原始值，特殊字符不丢不坏
 *
 * 用法：npm run test:page-scripts（已并入 npm run check，无需先 build）
 */
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import vm from 'node:vm'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const NASTY = [
  "a'b\\c</script>\u2028\u2029\n<>&/",
  'plain text',
  '100% <b>bold</b>',
  '汉字与 emoji 😀 </SCRIPT >'
]

let passed = 0
function pass(label) {
  passed++
  console.log(`  ✅ ${label}`)
}

/** 编译 scripts.ts（该模块没有运行期依赖，单文件编译即可） */
function compileScriptsModule() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-page-scripts-'))
  const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc')
  const result = spawnSync(
    process.execPath,
    [
      tsc,
      path.join(root, 'src', 'snapshot', 'scripts.ts'),
      '--ignoreConfig',
      '--outDir',
      outDir,
      '--target',
      'ES2022',
      '--module',
      'ESNext',
      '--skipLibCheck'
    ],
    { encoding: 'utf8' }
  )
  if (result.status !== 0) {
    fs.rmSync(outDir, { recursive: true, force: true })
    throw new Error(`编译 src/snapshot/scripts.ts 失败：\n${result.stdout ?? ''}${result.stderr ?? ''}`)
  }
  // package.json 没有 "type": "module"，.js 会被当成 CJS，改名后再动态 import
  const emitted = path.join(outDir, 'scripts.js')
  const modulePath = path.join(outDir, 'scripts.mjs')
  fs.renameSync(emitted, modulePath)
  return { outDir, modulePath }
}

function makeEl(over = {}) {
  return {
    tagName: 'INPUT',
    type: 'checkbox',
    checked: false,
    name: 'agree',
    id: 'chk',
    autocomplete: '',
    labels: null,
    isConnected: true,
    isContentEditable: false,
    value: '',
    textContent: '',
    innerText: '',
    clicks: 0,
    focusCount: 0,
    click() {
      this.clicks++
      if (this.type === 'checkbox') this.checked = !this.checked
    },
    focus() {
      this.focusCount++
    },
    getBoundingClientRect() {
      return { x: 10, y: 20, width: 30, height: 40 }
    },
    getAttribute(name) {
      return name === 'aria-label' ? '标签' : null
    },
    dispatchEvent() {
      return true
    },
    addEventListener() {},
    scrollIntoView() {},
    ...over
  }
}

function makeSandbox(refs, extra = {}) {
  const makeStore = () => {
    const storage = new Map()
    const store = {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
      clear: () => storage.clear(),
      get length() {
        return storage.size
      },
      key: (i) => [...storage.keys()][i]
    }
    return store
  }

  class FakeInput {
    get value() {
      return this._v ?? ''
    }
    set value(v) {
      this._v = v
    }
  }

  const sandbox = {
    window: { __aaRefs: refs, scrollX: 0, scrollY: 0, scrollBy() {}, innerWidth: 800, innerHeight: 600 },
    document: {
      body: { innerText: extra.bodyText ?? '', cloneNode: () => ({ querySelectorAll: () => [] }) },
      documentElement: { innerText: '' },
      querySelectorAll: () => []
    },
    HTMLInputElement: FakeInput,
    HTMLTextAreaElement: class {},
    Event: class {
      constructor(type) {
        this.type = type
      }
    },
    localStorage: makeStore(),
    sessionStorage: makeStore(),
    getComputedStyle: () => ({ overflowY: 'visible', overflowX: 'visible' }),
    requestAnimationFrame: (fn) => fn(),
    setTimeout: (fn) => fn(),
    clearTimeout: () => {},
    atob: (s) => Buffer.from(s, 'base64').toString('binary'),
    DataTransfer: class {
      constructor() {
        this._files = []
        this.items = { add: (f) => this._files.push(f) }
        this.files = this._files
      }
    },
    File: class {
      constructor(parts, name, opts) {
        this.name = name
        this.type = opts?.type ?? ''
      }
    },
    Uint8Array,
    Array,
    Math,
    JSON,
    Object,
    String,
    Number,
    Date,
    RegExp,
    Error,
    TypeError,
    Map,
    Set,
    Promise,
    ...extra
  }
  sandbox.globalThis = sandbox
  return vm.createContext(sandbox)
}

const run = (context, source) => vm.runInContext(source, context)

/** 跨 vm realm 的对象无法 deepStrictEqual，先转成本 realm 的普通值 */
const plain = (value) => (value === undefined ? value : JSON.parse(JSON.stringify(value)))

const { outDir, modulePath } = compileScriptsModule()
const S = await import(pathToFileURL(modulePath).href)

try {
  console.log('[1] 字面量转义：不含裸 </script> / U+2028 / U+2029，且能还原原值')
  for (const value of [...NASTY, null, 42, { a: "x'y</script>" }, ["a'b", '\u2028']]) {
    const literal = S.jsLiteral(value)
    assert.ok(!literal.includes('</script>'), `jsLiteral 未转义 </script>：${literal}`)
    assert.ok(!/[\u2028\u2029]/.test(literal), `jsLiteral 未转义行分隔符：${literal}`)
    const round = run(makeSandbox({}), `(() => (${literal}))()`)
    assert.deepEqual(plain(round), plain(value), `jsLiteral 还原失败：${literal}`)
  }
  assert.equal(S.refLiteral('e12'), "'e12'")
  for (const bad of ["e1'; app.leak(1); //", '#main', 'e1 ', '', 'E1']) {
    assert.throws(() => S.refLiteral(bad), /非法 ref/, `refLiteral 未拦住非法 ref：${bad}`)
  }
  pass('jsLiteral 转义保真；refLiteral 只放行 /^e\\d+$/, 其余抛错')

  console.log('[2] 工具探针脚本：行为与内联版本一致')
  {
    const el = makeEl({ checked: true, labels: [{ innerText: '同意' }] })
    const context = makeSandbox({ e7: el })
    assert.deepEqual(plain(run(context, S.checkedStateScript('e7'))), { ok: true, checked: true, type: 'checkbox' })
    assert.equal(run(context, S.tagNameScript('e7')), 'input')
    const fingerprint = run(context, S.fingerprintScript('e7'))
    assert.equal(fingerprint.fingerprint, ['INPUT', 'checkbox', 'agree', 'chk', '', '标签', '同意'].join('|'))
    assert.deepEqual(plain(fingerprint.rect), [10, 20, 30, 40])
    assert.equal(el.focusCount, 1, 'fingerprintScript 必须聚焦目标')
  }
  {
    const el = makeEl({ tagName: 'BUTTON', type: '' })
    const context = makeSandbox({ e8: el })
    assert.equal(run(context, S.clickScript('e8')), true)
    assert.equal(el.clicks, 1)
    assert.equal(run(context, S.clickScript('e9')), false, '元素不存在时应返回 false')
    assert.deepEqual(plain(run(context, S.checkedStateScript('e9'))), { ok: false })
    assert.equal(run(context, S.tagNameScript('e9')), '')
  }
  pass('clickScript / checkedStateScript / tagNameScript / fingerprintScript')

  console.log('[3] 带数据的脚本：页面侧拿到的就是原值')
  {
    const el = makeEl()
    const context = makeSandbox({ e1: el })
    const text = NASTY[0]
    assert.equal(run(context, S.setValueScript('e1', text)).ok, true)
    // 原生 setter 分支写入 el._v，兜底分支写入 el.value
    assert.equal(el._v ?? el.value, text, 'setValueScript 写入的值被转义破坏')
  }
  {
    const option = { value: 'a<b', label: 'x</script>y' }
    const el = makeEl({ tagName: 'SELECT', type: 'select-one', options: [option] })
    const result = run(makeSandbox({ e2: el }), S.selectOptionScript('e2', undefined, option.label))
    assert.equal(result.ok, true, 'selectOptionScript 未匹配到 option')
    assert.equal(result.value, option.value)
    assert.equal(result.label, option.label, 'selectOptionScript 的 label 被转义破坏')
  }
  {
    const text = NASTY[0]
    const context = makeSandbox({}, { bodyText: `前缀 ${text} 后缀` })
    assert.equal(run(context, S.containsTextScript(text)), true, 'containsTextScript 未匹配到含特殊字符的文本')
  }
  {
    const context = makeSandbox({})
    const key = NASTY[0]
    const value = NASTY[3]
    assert.equal(run(context, S.storageScript('set', 'local', key, value)).ok, true)
    assert.equal(run(context, S.storageScript('get', 'local', key)).value, value, 'storageScript 的 key/value 被转义破坏')
    assert.equal(run(context, S.storageScript('get', 'session', key)).value, null, 'session/local 未区分')
  }
  {
    const el = makeEl({ tagName: 'INPUT', type: 'file', files: [] })
    const name = "f</script>'\u2028.txt"
    const result = run(
      makeSandbox({ e3: el }),
      S.uploadScript('e3', [{ name, type: 'text/plain', data: Buffer.from('hi').toString('base64') }])
    )
    assert.equal(result.ok, true)
    assert.equal(result.names[0], name, 'uploadScript 的文件名被转义破坏')
  }
  pass('setValue / selectOption / containsText / storage / upload')

  console.log(`\n🎉 页面脚本字面量回归：${passed} 组断言全部通过`)
} finally {
  fs.rmSync(outDir, { recursive: true, force: true })
}