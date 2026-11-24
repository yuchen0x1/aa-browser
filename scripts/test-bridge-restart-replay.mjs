#!/usr/bin/env node
/**
 * Real-process regression for update restarts (no Electron needed).
 *
 * A read-only, idempotent tools/call that loses its WebSocket because the app
 * restarted must be replayed against the new instance and return its result to
 * the MCP client. A mutating call must never be replayed; it fails once with a
 * clear "verify the page" error.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { WebSocketServer } from 'ws'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BRIDGE = path.join(ROOT, 'cli', 'mcp.mjs')

function listen() {
  return new Promise((resolve) => {
    const server = new WebSocketServer({ port: 0 })
    server.once('listening', () => resolve(server))
  })
}

function closeServer(server) {
  for (const client of server.clients) {
    try { client.terminate() } catch { /* ignore */ }
  }
  return new Promise((resolve) => server.close(resolve))
}

/**
 * Start bridge + first app instance. Returns request helpers and the first
 * server so a test can emulate the app quitting after a call was delivered.
 */
async function startPair() {
  const connectionFile = path.join(os.tmpdir(), `aa-restart-replay-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`)
  const first = await listen()
  const second = await listen()
  fs.writeFileSync(connectionFile, JSON.stringify({ pid: process.pid, port: first.address().port, token: 'token-one' }))

  const child = spawn(process.execPath, [BRIDGE], {
    cwd: ROOT,
    env: {
      ...process.env,
      AA_BROWSER_CONNECTION_FILE: connectionFile,
      AA_BROWSER_AUTO_LAUNCH: '0',
      AA_BROWSER_CONNECT_RETRY_MS: '100'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  const pending = new Map()
  const receivedByFirst = []
  const receivedBySecond = []
  let secondSocket = null
  first.on('connection', (socket) => socket.on('message', (raw) => receivedByFirst.push(JSON.parse(raw.toString()))))
  second.on('connection', (socket) => {
    secondSocket = socket
    socket.on('message', (raw) => receivedBySecond.push(JSON.parse(raw.toString())))
  })
  const rl = readline.createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    let message
    try { message = JSON.parse(line) } catch { return }
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    waiter(message)
  })

  let nextId = 1
  const request = (method, params, timeoutMs = 10_000) => new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`no ${method} response within ${timeoutMs}ms`)) }, timeoutMs)
    pending.set(id, (message) => { clearTimeout(timer); resolve(message) })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })

  const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'restart-replay', version: '0' } })
  assert.equal(init.result?.serverInfo?.name, 'aa-browser')

  const waitFor = async (list, predicate, label, timeoutMs = 8_000) => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const found = list.find(predicate)
      if (found) return found
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error(`timed out waiting for ${label}`)
  }

  /** Emulate the app exiting and the new version accepting connections. */
  const restart = async () => {
    fs.writeFileSync(connectionFile, JSON.stringify({ pid: process.pid, port: second.address().port, token: 'token-two' }))
    await closeServer(first)
  }

  const cleanup = async () => {
    try { child.stdin.end() } catch { /* ignore */ }
    try { child.kill() } catch { /* ignore */ }
    try { rl.close() } catch { /* ignore */ }
    try { fs.rmSync(connectionFile, { force: true }) } catch { /* ignore */ }
    await closeServer(first).catch(() => {})
    await closeServer(second).catch(() => {})
  }

  const replySecond = (id, text) => {
    assert.ok(secondSocket && secondSocket.readyState === 1, 'the replayed request must arrive on the second instance')
    secondSocket.send(JSON.stringify({ id, ok: true, result: { content: [{ type: 'text', text }] } }))
  }

  return { child, request, receivedByFirst, receivedBySecond, waitFor, restart, replySecond, cleanup }
}

await test('read-only call is replayed against the restarted app instance', async () => {
  const pair = await startPair()
  try {
    const response = pair.request('tools/call', { name: 'browser_snapshot', arguments: { tabId: 'tab01' } })
    const firstCall = await pair.waitFor(pair.receivedByFirst, (message) => message.tool === 'browser_snapshot', 'first-instance call')
    assert.equal(firstCall.args?.tabId, 'tab01')

    await pair.restart()
    const replayed = await pair.waitFor(pair.receivedBySecond, (message) => message.tool === 'browser_snapshot', 'replayed call')
    assert.notEqual(replayed.id, firstCall.id, 'replay must use an id valid on the new instance')
    assert.equal(replayed.args?.__aaRetryCount, 1, 'replayed read-only call carries a retry counter')
    assert.notEqual(replayed.args, firstCall.args, 'replay args are copied so retry metadata never mutates the original call')
    pair.replySecond(replayed.id, 'snapshot after restart')
    const message = await response
    assert.equal(message.result?.isError, false)
    assert.match(message.result?.content?.[0]?.text ?? '', /snapshot after restart/)
  } finally {
    await pair.cleanup()
  }
})

await test('mutating call fails once and is never replayed', async () => {
  const pair = await startPair()
  try {
    const response = pair.request('tools/call', { name: 'browser_click', arguments: { ref: 'e1' } })
    await pair.waitFor(pair.receivedByFirst, (message) => message.tool === 'browser_click', 'first-instance click')
    await pair.restart()
    const message = await response
    assert.equal(message.result?.isError, true)
    assert.match(message.result?.content?.[0]?.text ?? '', /不会自动重试/)
    await new Promise((resolve) => setTimeout(resolve, 400))
    assert.equal(pair.receivedBySecond.length, 0, 'mutating calls must never be replayed')
  } finally {
    await pair.cleanup()
  }
})
