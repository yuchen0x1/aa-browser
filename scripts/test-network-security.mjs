#!/usr/bin/env node
/** Regression tests for response limits, redaction and debugger lifecycle. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { compileFunction } from 'node:vm'
import { fileURLToPath } from 'node:url'
import { EventEmitter } from 'node:events'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-network-security-'))
const compiled = path.join(temp, 'compiled')

function loadNetwork() {
  const filename = path.join(compiled, 'network.js')
  const module = { exports: {} }
  compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(
    (specifier) => {
      if (specifier === './actions') return { ActionError: class ActionError extends Error {} }
      if (specifier.startsWith('node:')) return require(specifier)
      throw new Error(`Unexpected production dependency: ${specifier}`)
    },
    module,
    module.exports
  )
  return module.exports
}

function debuggerFixture() {
  let attached = false, destroyed = false
  const commands = [], queued = new Map()
  const dbg = Object.assign(new EventEmitter(), {
    isAttached: () => attached,
    attach: () => { assert.equal(destroyed, false); attached = true },
    detach: () => { attached = false },
    sendCommand: (method) => {
      assert.equal(destroyed, false, 'commands must not be sent to destroyed contents')
      commands.push(method)
      const pending = queued.get(method)?.shift()
      pending?.start()
      return pending?.promise ?? Promise.resolve({})
    }
  })
  return {
    wc: { debugger: dbg, isDestroyed: () => destroyed }, commands,
    destroy: () => { destroyed = true },
    defer(method) {
      let resolve, reject, start
      const pending = { promise: new Promise((yes, no) => { resolve = yes; reject = no }), entered: new Promise((yes) => { start = yes }) }
      const queue = queued.get(method) ?? []
      queue.push({ ...pending, start }); queued.set(method, queue)
      return { ...pending, resolve, reject }
    }
  }
}

try {
  const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc')
  const result = spawnSync(process.execPath, [
    tsc, '--ignoreConfig', '--noCheck', '--noResolve', '--outDir', compiled,
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--esModuleInterop',
    path.join(root, 'src/main/network.ts')
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, `Compilation failed:\n${result.stdout}\n${result.stderr}`)

  const { NetworkCapture, MAX_RESPONSE_BODY_BYTES, redactNetworkBody, clipBody } = loadNetwork()
  const json = '{"user":"alice","access_token":"fixture-token","nested":{"password":"fixture-password"},"message":"Bearer fixture-bearer"}'
  const redactedJson = redactNetworkBody(json, 'application/json')
  assert.doesNotMatch(redactedJson, /fixture-token|fixture-password|fixture-bearer/)
  assert.match(redactedJson, /\[redacted\]/)
  assert.match(redactedJson, /"user": "alice"/)

  const form = redactNetworkBody('name=alice&token=fixture-token', 'application/x-www-form-urlencoded')
  assert.equal(form.includes('fixture-token'), false)
  assert.match(form, /token=\[redacted\]/)

  const ordinaryBody = { content: json, base64Encoded: false, truncated: false, sizeBytes: Buffer.byteLength(json) }
  const safe = clipBody(ordinaryBody, 'application/json')
  assert.equal(safe.includes('fixture-token'), false)
  assert.match(safe, /敏感字段已脱敏/)
  assert.match(clipBody(ordinaryBody, 'application/json', true), /fixture-token/)

  const oversized = 'x'.repeat(MAX_RESPONSE_BODY_BYTES + 2048)
  const capture = new NetworkCapture({
    debugger: {
      sendCommand: async () => ({ body: oversized, base64Encoded: false })
    }
  })
  capture.attached = true
  const limited = await capture.getResponseBody('fixture-request')
  assert.ok(limited)
  assert.equal(limited.truncated, true)
  assert.equal(limited.sizeBytes, Buffer.byteLength(oversized))
  assert.ok(Buffer.byteLength(limited.content) <= MAX_RESPONSE_BODY_BYTES)
  assert.match(clipBody(limited, 'text/plain'), /仅返回前/)

  const encoded = 'A'.repeat(Math.ceil(MAX_RESPONSE_BODY_BYTES / 3) * 4 + 16)
  const binaryCapture = new NetworkCapture({
    debugger: {
      sendCommand: async () => ({ body: encoded, base64Encoded: true })
    }
  })
  binaryCapture.attached = true
  const binary = await binaryCapture.getResponseBody('fixture-binary')
  assert.ok(binary)
  assert.equal(binary.base64Encoded, true)
  assert.equal(binary.truncated, true)
  assert.match(clipBody(binary, 'application/octet-stream'), /二进制响应体/)

  console.log('PASS: network response size limits and default body redaction')

  const enablingFixture = debuggerFixture()
  const enabling = new NetworkCapture(enablingFixture.wc)
  const networkGate = enablingFixture.defer('Network.enable')
  const firstEnable = enabling.ensure(), duplicateEnable = enabling.ensure()
  const firstCancelled = assert.rejects(firstEnable, /初始化已取消/)
  const duplicateCancelled = assert.rejects(duplicateEnable, /初始化已取消/)
  assert.equal(enablingFixture.commands.filter((method) => method === 'Network.enable').length, 1)
  enabling.dispose()
  networkGate.resolve({})
  await Promise.all([firstCancelled, duplicateCancelled])
  assert.equal(enabling.enabled, false)
  assert.equal(enablingFixture.wc.debugger.listenerCount('message'), 0)
  assert.ok(enablingFixture.commands.includes('Network.disable'))
  await Promise.all([enabling.ensure(), enabling.ensure()])
  assert.equal(enabling.enabled, true)
  assert.equal(enablingFixture.wc.debugger.listenerCount('message'), 1)
  enabling.dispose()
  assert.equal(enablingFixture.wc.debugger.isAttached(), true, 'dispose preserves the dialog guard shared debugger')
  assert.equal(enablingFixture.wc.debugger.listenerCount('message'), 0)
  console.log('PASS: concurrent Network.enable is deduplicated; dispose cancels late completion and remains reusable')

  const staleFixture = debuggerFixture(), stale = new NetworkCapture(staleFixture.wc)
  const staleGate = staleFixture.defer('Network.enable')
  const staleEnable = stale.ensure()
  const staleCancelled = assert.rejects(staleEnable, /初始化已取消/)
  stale.releaseDebugger()
  assert.equal(staleFixture.wc.debugger.isAttached(), false)
  await stale.ensure()
  staleGate.reject(new Error('old target closed'))
  await staleCancelled
  assert.equal(stale.enabled, true)
  assert.equal(staleFixture.wc.debugger.isAttached(), true, 'an old failure cannot detach a newer initialization')
  assert.equal(staleFixture.wc.debugger.listenerCount('message'), 1)
  stale.dispose()
  const destroyedFixture = debuggerFixture(), destroyed = new NetworkCapture(destroyedFixture.wc)
  const destroyedGate = destroyedFixture.defer('Network.enable')
  const destroyedEnable = destroyed.ensure()
  const destroyedCancelled = assert.rejects(destroyedEnable, /初始化已取消/)
  destroyedFixture.destroy()
  destroyedGate.resolve({})
  await destroyedCancelled
  assert.equal(destroyedFixture.wc.debugger.listenerCount('message'), 0)
  await assert.rejects(destroyed.ensure(), /页面已关闭/)
  destroyed.dispose()
  console.log('PASS: late debugger failures cannot detach a new session or attach listeners to destroyed contents')

  const mockFixture = debuggerFixture(), mockCapture = new NetworkCapture(mockFixture.wc)
  mockCapture.setMock({ urlContains: 'fixture.test', body: 'fixture response' })
  const mockGate = mockFixture.defer('Fetch.enable')
  const mockEnable = mockCapture.ensureMockInterception()
  const mockCancelled = assert.rejects(mockEnable, /初始化已取消/)
  await mockGate.entered
  mockCapture.dispose()
  mockGate.resolve({})
  await mockCancelled
  assert.equal(mockFixture.wc.debugger.listenerCount('message'), 0)
  assert.ok(mockFixture.commands.includes('Fetch.disable'))
  assert.equal(mockCapture.listMocks().length, 1, 'dispose preserves mock configuration for DevTools recovery')
  for (let attempt = 0; attempt < 2; attempt++) {
    await Promise.all([mockCapture.ensureMockInterception(), mockCapture.ensureMockInterception()])
    assert.equal(mockFixture.wc.debugger.listenerCount('message'), 2, 'one Network listener and one Fetch listener')
    mockFixture.wc.debugger.emit('message', {}, 'Fetch.requestPaused', { requestId: `fixture-${attempt}`, request: { url: 'https://fixture.test/resource', method: 'GET' } })
    assert.equal(mockCapture.listMocks()[0].hits, attempt + 1, 'each intercepted request is handled exactly once')
    mockCapture.dispose()
    assert.equal(mockFixture.wc.debugger.listenerCount('message'), 0)
  }
  console.log('PASS: dispose cancels pending Fetch.enable, removes both listeners and restores mock interception without duplicates')

  const clearedFixture = debuggerFixture(), cleared = new NetworkCapture(clearedFixture.wc)
  cleared.setMock({ urlContains: 'fixture.test' })
  const clearedGate = clearedFixture.defer('Fetch.enable')
  const clearedEnable = cleared.ensureMockInterception()
  const clearedCancelled = assert.rejects(clearedEnable, /初始化已取消/)
  await clearedGate.entered
  cleared.clearMocks()
  await cleared.ensureMockInterception()
  clearedGate.resolve({})
  await clearedCancelled
  assert.equal(clearedFixture.wc.debugger.listenerCount('message'), 1, 'clearing mocks cannot restore a late Fetch listener')
  cleared.dispose()
  console.log('PASS: clearing mocks while Fetch.enable is pending leaves no interception listener')
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
