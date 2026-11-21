#!/usr/bin/env node
/**
 * Deterministic bridge lifecycle regressions against production cli/mcp.mjs.
 * Only imports/import.meta are adapted for a VM; production handlers stay intact.
 * Sockets, discovery, process I/O, and timers are in-memory fixtures. This tests
 * event ordering and cleanup, not real ws handshakes, TCP, or Electron startup.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Script, createContext } from 'node:vm'
import test from 'node:test'
import { TOOL_DEFS, TOOL_ANNOTATIONS } from '../src/shared/tool-defs.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BRIDGE = path.join(ROOT, 'cli/mcp.mjs')
const CONNECTION = path.join(ROOT, '__in_memory_lifecycle_connection__.json')
const source = fs.readFileSync(BRIDGE, 'utf8').replace(/\r\n/g, '\n')
const expectedImports = [
  "import fs from 'node:fs'",
  "import os from 'node:os'",
  "import path from 'node:path'",
  "import process from 'node:process'",
  "import { spawn } from 'node:child_process'",
  "import { fileURLToPath } from 'node:url'",
  "import WebSocket from 'ws'",
  "import { TOOL_DEFS, TOOL_ANNOTATIONS } from '../src/shared/tool-defs.mjs'"
]
assert.deepEqual(source.match(/^import .+$/gm), expectedImports,
  'Bridge imports changed: review and explicitly update the fixture dependency allowlist')
assert.equal(source.match(/import\.meta\.url/g)?.length, 2,
  'Bridge import.meta usage changed: review the VM rewrite')
let adapted = source
for (const declaration of expectedImports) adapted = adapted.replace(`${declaration}\n`, '\n')
adapted = adapted.replaceAll('import.meta.url', JSON.stringify(pathToFileURL(BRIDGE).href))
assert.doesNotMatch(adapted, /^\s*(?:import|export)\s|\bimport\s*\(|\bimport\.meta/m,
  'Unexpected module syntax: do not execute unreviewed bridge dependencies')
const program = new Script(`${adapted}\n;globalThis.fixtureBridge = {
  handleStdioLine, connectWs,
  state: () => ({ ws, connecting, pending, mcpToBridge, cancelledMcpRequests, bridgeToProgressToken })
};`, { filename: BRIDGE })

// Drain a bounded number of promise continuations, never a real request timeout.
const flush = async () => { for (let i = 0; i < 24; i++) await Promise.resolve() }

function createFixture() {
  const sockets = []
  const messages = []
  const timeouts = new Set()
  const intervals = new Set()
  const forbidden = () => { throw new Error('Unexpected real process/filesystem operation in lifecycle fixture') }
  const makeTimer = (set, callback, ms) => {
    assert.equal(typeof callback, 'function')
    const timer = { callback, ms, unref() { this.unreferenced = true; return this } }
    set.add(timer)
    return timer
  }

  class FakeSocket extends EventEmitter {
    static CONNECTING = 0
    static OPEN = 1
    static CLOSING = 2
    static CLOSED = 3

    constructor(url) {
      super()
      assert.equal(url, 'ws://127.0.0.1:12345/?token=fixture-token')
      this.readyState = FakeSocket.CONNECTING
      this.sent = []
      this.attempts = []
      this.sendCallbacks = []
      this.throwOnSend = null
      sockets.push(this)
    }

    open() {
      assert.equal(this.readyState, FakeSocket.CONNECTING)
      this.readyState = FakeSocket.OPEN
      this.emit('open')
    }

    beginClose() { this.readyState = FakeSocket.CLOSING }
    close() {
      if (this.readyState === FakeSocket.CLOSED) return
      this.readyState = FakeSocket.CLOSED
      this.emit('close')
    }

    terminate() { this.close() }
    message(value) { this.emit('message', Buffer.from(JSON.stringify(value))) }
    reply(id, text = 'fixture success') {
      this.message({ id, ok: true, result: { content: [{ type: 'text', text }] } })
    }

    send(raw, callback) {
      const message = JSON.parse(raw)
      this.attempts.push(message)
      if (this.readyState === FakeSocket.CONNECTING) throw new Error('WebSocket is still connecting')
      // Match ws.sendAfterClose: no synchronous throw in CLOSING/CLOSED;
      // an error is observable only through a supplied asynchronous callback.
      if (this.readyState !== FakeSocket.OPEN) {
        if (callback) this.sendCallbacks.push(() => callback(new Error('WebSocket is not open')))
        return
      }
      if (this.throwOnSend) {
        const error = this.throwOnSend
        this.throwOnSend = null
        throw error
      }
      this.sent.push(message)
      if (callback) this.sendCallbacks.push((error) => callback(error))
    }

    completeSend(error) {
      assert.ok(this.sendCallbacks.length, 'Expected an installed send callback')
      this.sendCallbacks.shift()(error)
    }
  }

  const stdin = new EventEmitter()
  stdin.setEncoding = (encoding) => assert.equal(encoding, 'utf8')
  const processFixture = Object.assign(new EventEmitter(), {
    env: { AA_BROWSER_CONNECTION_FILE: CONNECTION, AA_BROWSER_AUTO_LAUNCH: '0' },
    platform: process.platform,
    stdin,
    stdout: {
      write(raw) {
        assert.ok(raw.endsWith('\n'), 'stdio output must remain LF-framed')
        messages.push(JSON.parse(raw))
      }
    },
    kill: (pid, signal) => { assert.equal(pid, 123); assert.equal(signal, 0) },
    exit: forbidden
  })
  const context = createContext({
    fs: {
      readFileSync(file, encoding) {
        assert.equal(file, CONNECTION, 'Only fixture discovery may be read')
        assert.equal(encoding, 'utf-8')
        return JSON.stringify({ pid: 123, port: 12345, token: 'fixture-token' })
      },
      statSync: forbidden,
      existsSync: forbidden
    },
    os: { homedir: () => '/in-memory-fixture' },
    path,
    process: processFixture,
    spawn: forbidden,
    fileURLToPath,
    WebSocket: FakeSocket,
    TOOL_DEFS,
    TOOL_ANNOTATIONS,
    Buffer,
    console: { error() {} },
    __AA_BRIDGE_VERSION__: 'lifecycle-fixture',
    setTimeout: (callback, ms) => makeTimer(timeouts, callback, ms),
    clearTimeout: (timer) => timeouts.delete(timer),
    setInterval: (callback, ms) => makeTimer(intervals, callback, ms),
    clearInterval: (timer) => intervals.delete(timer)
  })
  program.runInContext(context, { timeout: 1000 })
  const bridge = context.fixtureBridge
  const results = (id) => messages.filter((message) => Object.hasOwn(message, 'id') && message.id === id)
  const notifications = () => messages.filter((message) => !Object.hasOwn(message, 'id'))
  const call = (id, token = `progress-${id}`) => bridge.handleStdioLine(JSON.stringify({
    jsonrpc: '2.0', id, method: 'tools/call',
    params: { name: 'browser_tabs', arguments: { action: 'list' }, _meta: { progressToken: token } }
  }))
  const cancel = (requestId) => bridge.handleStdioLine(JSON.stringify({
    jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId }
  }))
  const result = (id, isError, pattern) => {
    const replies = results(id)
    assert.equal(replies.length, 1, `Expected exactly one prompt stdio result for ${id}`)
    assert.equal(replies[0].error, undefined)
    assert.equal(replies[0].result?.isError, isError)
    if (pattern) assert.match(replies[0].result?.content?.[0]?.text ?? '', pattern)
    return replies[0]
  }
  const clean = (ids) => {
    const state = bridge.state()
    for (const name of ['pending', 'mcpToBridge', 'cancelledMcpRequests', 'bridgeToProgressToken']) {
      assert.equal(state[name].size, 0, `${name} must be empty after completion`)
    }
    assert.equal(state.connecting, null, 'Settled handshake must release the single-flight slot')
    assert.equal(timeouts.size, 0, 'No handshake or request timeout may remain')
    assert.equal(intervals.size, 1, 'Only the inert eager-connect interval is expected')
    assert.ok([...intervals][0].unreferenced)
    assert.deepEqual(messages.filter((message) => Object.hasOwn(message, 'id')).map((message) => message.id).sort(), [...ids].sort())
  }
  const fireTimeout = (ms) => {
    const matches = [...timeouts].filter((timer) => timer.ms === ms)
    assert.equal(matches.length, 1, `Expected one controlled ${ms}ms timeout`)
    timeouts.delete(matches[0])
    matches[0].callback()
  }
  return { ...bridge, sockets, messages, timeouts, results, notifications, call, cancel, result, clean, fireTimeout }
}

async function connectedFixture() {
  const fixture = createFixture()
  const connection = fixture.connectWs()
  fixture.sockets[0].open()
  assert.equal(await connection, fixture.sockets[0])
  await flush()
  return fixture
}

await test('old close and wrong-socket frames preserve replacement pending calls and progress', async () => {
  const f = createFixture()
  f.call(10)
  const old = f.sockets[0]
  old.open()
  await flush()
  const oldId = old.sent[0].id
  old.beginClose()
  f.call(11, 'replacement-token')
  const replacement = f.sockets[1]
  replacement.open()
  await flush()
  const newId = replacement.sent[0].id
  const timer = f.state().pending.get(newId).timer

  // Deliberately misrouted ids test isolation, not an ordinary old-id replay.
  old.reply(newId, 'must not resolve replacement')
  old.message({ id: newId, event: 'progress', progress: 99 })
  assert.equal(f.notifications().length, 0)
  assert.equal(f.state().pending.get(newId).timer, timer)
  assert.equal(f.results(11).length, 0)
  replacement.message({ id: newId, event: 'progress', progress: 1, total: 2, message: 'owned' })
  assert.deepEqual(f.notifications()[0].params, {
    progressToken: 'replacement-token', progress: 1, total: 2, message: 'owned'
  })
  assert.equal(f.state().pending.size, 2, 'Progress must not settle either tool call')

  old.close()
  assert.equal(f.state().ws, replacement)
  assert.equal(f.state().pending.size, 1)
  assert.equal(f.state().pending.get(newId).socket, replacement)
  assert.equal(f.state().mcpToBridge.get(11), newId)
  assert.equal(f.state().bridgeToProgressToken.get(newId), 'replacement-token')
  assert.equal(f.state().pending.has(oldId), false)
  await flush()
  f.result(10, true, /连接已断开/)
  replacement.reply(newId, 'replacement success')
  await flush()
  f.result(11, false, /replacement success/)
  f.clean([10, 11])
})

await test('cancellation does not send an old call on its replacement socket', async () => {
  const f = createFixture()
  f.call(20)
  const old = f.sockets[0]
  old.open()
  await flush()
  old.beginClose()
  f.call(21)
  const replacement = f.sockets[1]
  replacement.open()
  await flush()
  const newId = replacement.sent[0].id

  f.cancel(20)
  assert.equal(old.sent.filter((message) => message.cancel).length, 0, 'Closing owner is not writable')
  assert.equal(replacement.sent.filter((message) => message.cancel).length, 0, 'Never redirect cancellation')
  await flush()
  f.result(20, true, /已取消/)
  assert.equal(f.state().pending.get(newId).socket, replacement)
  f.cancel(21)
  assert.deepEqual(replacement.sent.at(-1), { id: newId, cancel: true }, 'Writable owner receives cancellation')
  await flush()
  f.result(21, true, /已取消/)
  old.close()
  replacement.reply(newId, 'late cancelled result')
  replacement.completeSend(new Error('late cancelled send failure'))
  replacement.close()
  await flush()
  f.clean([20, 21])
})

await test('successful mapping survives synchronous close until the stdio .then consumes it', async () => {
  const f = createFixture()
  f.call(30)
  const socket = f.sockets[0]
  socket.open()
  await flush()
  const id = socket.sent[0].id
  socket.reply(id, 'retained success')
  socket.completeSend(new Error('late callback must not replace success'))
  socket.close()
  assert.equal(f.state().pending.size, 0)
  assert.equal(f.state().bridgeToProgressToken.size, 0)
  assert.equal(f.state().mcpToBridge.get(30), id, 'Keep mapping until the stdio continuation')
  assert.equal(f.results(30).length, 0, 'Promise continuation has not run yet')
  await flush()
  f.result(30, false, /retained success/)
  socket.reply(id, 'duplicate success')
  await flush()
  f.clean([30])
})

await test('close between getWs resolution and send fails promptly without registering an orphan', async () => {
  const f = await connectedFixture()
  const socket = f.sockets[0]
  f.call(40)
  socket.close() // Before the await getWs() continuation registers pending state.
  await flush()
  assert.equal(socket.attempts.length, 0, 'Do not attempt a send on a closed socket')
  f.result(40, true, /连接已断开/)
  f.clean([40])
})

await test('synchronous send throw clears request state and returns exactly one error', async () => {
  const f = await connectedFixture()
  const socket = f.sockets[0]
  socket.throwOnSend = new Error('fixture synchronous send failure')
  f.call(50)
  await flush()
  assert.equal(socket.attempts.length, 1)
  assert.equal(socket.sent.length, 0)
  f.result(50, true, /fixture synchronous send failure/)
  socket.close()
  await flush()
  f.clean([50])
})

await test('asynchronous send callback error clears request state and ignores late events', async () => {
  const f = await connectedFixture()
  const socket = f.sockets[0]
  f.call(60)
  await flush()
  assert.equal(f.state().pending.size, 1)
  assert.equal(f.results(60).length, 0)
  const id = socket.sent[0].id
  socket.completeSend(new Error('fixture asynchronous send failure'))
  await flush()
  f.result(60, true, /fixture asynchronous send failure/)
  socket.reply(id, 'late result')
  socket.close()
  await flush()
  f.clean([60])
})

for (const failure of ['error', 'close', 'timeout']) {
  await test(`concurrent failed ${failure} handshake releases the slot for a successful reconnect`, async () => {
    const f = createFixture()
    f.call(70)
    f.call(71)
    assert.equal(f.sockets.length, 1, 'Concurrent calls must share the handshake')
    const failed = f.sockets[0]
    if (failure === 'error') {
      failed.emit('error', new Error('fixture handshake failure'))
      failed.close()
    } else if (failure === 'close') failed.close()
    else f.fireTimeout(3000)
    await flush()
    f.result(70, true)
    f.result(71, true)
    f.clean([70, 71])
    f.call(72)
    assert.equal(f.sockets.length, 2, 'A settled failure must not poison the next connection')
    const replacement = f.sockets[1]
    replacement.open()
    await flush()
    replacement.completeSend()
    replacement.reply(replacement.sent[0].id, 'reconnected success')
    await flush()
    f.result(72, false, /reconnected success/)
    f.clean([70, 71, 72])
  })
}

await test('controlled request timeout cancels its owner and ignores late completion', async () => {
  const f = await connectedFixture()
  const socket = f.sockets[0]
  f.call(80)
  await flush()
  const id = socket.sent[0].id
  f.fireTimeout(180_000) // Explicit fake timer firing, not a wall-clock wait.
  assert.deepEqual(socket.sent.at(-1), { id, cancel: true })
  await flush()
  f.result(80, true, /执行超时/)
  socket.reply(id, 'late timed-out result')
  socket.completeSend(new Error('late timed-out send failure'))
  socket.close()
  await flush()
  f.clean([80])
})
