#!/usr/bin/env node
/** Regression: frame element descriptions never expose populated sensitive values. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { compileFunction, runInNewContext } from 'node:vm'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-frame-elements-'))
const out = path.join(tmp, 'compiled')
try {
  const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin', 'tsc')
  const compiled = spawnSync(process.execPath, [
    tsc, '--ignoreConfig', '--noCheck', '--noResolve', '--outDir', out,
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--esModuleInterop',
    path.join(root, 'src/main/frames.ts')
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(compiled.status, 0, `Compilation failed: ${compiled.error ?? ''}\n${compiled.stdout}\n${compiled.stderr}`)

  const module = { exports: {} }
  const localRequire = (specifier) => {
    if (specifier === '@snapshot/scripts') return { jsLiteral: (value) => JSON.stringify(value) }
    return require(specifier)
  }
  compileFunction(fs.readFileSync(path.join(out, 'frames.js'), 'utf8'), ['require', 'module', 'exports'], {
    filename: path.join(out, 'frames.js')
  })(localRequire, module, module.exports)
  const { frameElements, frameClick } = module.exports

  const sensitiveFixtures = [
    { attrs: { type: 'password', 'aria-label': 'Password' }, label: 'Password' },
    { attrs: { name: 'api_key', placeholder: 'API key' }, label: 'API key' },
    { attrs: { name: 'access_token', 'aria-label': 'Access token' }, label: 'Access token' },
    { attrs: { autocomplete: 'one-time-code', 'aria-label': 'Verification code' }, label: 'Verification code' },
    { attrs: { name: 'cc-number', 'aria-label': 'Card number' }, label: 'Card number' },
    ...['current-password', 'new-password', 'cc-csc', 'cc-exp', 'cc-exp-month', 'cc-exp-year', 'section-checkout billing cc-csc'].map((autocomplete) => ({
      attrs: { autocomplete, 'aria-label': 'Private field' }, label: 'Private field'
    })),
    ...['验证码', '密钥', '令牌', '密码'].map((label) => ({ attrs: { 'aria-label': label }, label })),
    { attrs: { 'data-testid': 'api-key', title: 'Private field' }, label: 'Private field' },
    { attrs: {}, externalLabel: 'Password', label: 'Password' },
    { attrs: { type: 'text' }, externalLabel: 'Security code', label: 'Security code' }
  ]
  const makeNode = ({ attrs = {}, externalLabel, secret }) => ({
    nodeType: 1,
    tagName: 'INPUT',
    labels: externalLabel ? [{ textContent: externalLabel }] : [],
    get value() {
      if (secret) throw new Error('Sensitive input value must not be read')
      return 'Aa Browser'
    },
    get innerText() {
      if (secret) throw new Error('Sensitive control innerText must not be read')
      return ''
    },
    parentElement: null,
    children: [],
    isContentEditable: false,
    getAttribute(name) { return Object.hasOwn(attrs, name) ? attrs[name] : null },
    hasAttribute(name) { return Object.hasOwn(attrs, name) },
    getBoundingClientRect() { return { width: 120, height: 28 } },
    click() {}
  })
  const nodes = sensitiveFixtures.map((fixture) => makeNode({ ...fixture, secret: true }))
  nodes.push(makeNode({ attrs: { type: 'text', name: 'query' } }))
  const document = { querySelectorAll: () => nodes }
  const frame = {
    frameTreeNodeId: 1,
    url: 'https://fixture.example/',
    name: '',
    frames: [],
    async executeJavaScript(script) {
      return runInNewContext(script, { document, window: {} })
    }
  }
  const webContents = { isDestroyed: () => false, mainFrame: frame }
  const result = await frameElements(webContents, 'f1')
  assert.equal(result.length, nodes.length)
  for (const [index, fixture] of sensitiveFixtures.entries()) {
    assert.ok(result[index].description.includes(`"${fixture.label}"`), result[index].description)
    const clicked = await frameClick(webContents, 'f1', 'input', index)
    assert.equal(clicked.clicked, result[index].description)
  }
  assert.match(result.at(-1).description, /input\[text\] "Aa Browser"/)
  console.log(`PASS: ${sensitiveFixtures.length} sensitive descriptors never read value/innerText; safe labels, clicks and ordinary values preserved`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })
}
