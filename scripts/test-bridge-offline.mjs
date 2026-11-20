#!/usr/bin/env node
/**
 * Regression: a tools/call made while Aa Browser is not running must receive a
 * JSON-RPC response (isError tool result), not hang until the client timeout.
 *
 * Found via the DSH bundle: callTool() awaited the browser connection before
 * registering its pending id, and the tools/call catch silently returned when
 * the mapping was absent, so the MCP client never got an answer.
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
const CONNECTION_FILE = path.join(os.tmpdir(), `aa-bridge-offline-${process.pid}-${Date.now()}.json`)
const CANCEL_CONNECTION_FILE = path.join(os.tmpdir(), `aa-bridge-cancel-${process.pid}-${Date.now()}.json`)

function startBridge(connectionFile = CONNECTION_FILE) {
  return spawn(process.execPath, [BRIDGE], {
    cwd: ROOT,
    env: {
      ...process.env,
      AA_BROWSER_CONNECTION_FILE: connectionFile,
      AA_BROWSER_AUTO_LAUNCH: '0',
      AA_BROWSER_CONNECT_RETRY_MS: '2000'
    },
    stdio: ['pipe', 'pipe', 'pipe']
  })
}

await test('tools/call while Aa Browser is offline receives an isError response', async () => {
  const child = startBridge()
  const pending = new Map()
  let nextId = 1
  const rl = readline.createInterface({ input: child.stdout })
  rl.on('line', (line) => {
    let message
    try {
      message = JSON.parse(line)
    } catch {
      return
    }
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    waiter.resolve(message)
  })
  const request = (method, params, timeoutMs = 8000, id = nextId++) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`no response to ${method} within ${timeoutMs}ms`))
    }, timeoutMs)
    pending.set(id, { resolve: (value) => { clearTimeout(timer); resolve(value) } })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })

  try {
    const init = await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'offline-test', version: '0' } })
    assert.equal(init.result?.serverInfo?.name, 'aa-browser')

    // Send literal Unicode separators, not JSON escapes. The response must also
    // survive a readline-based client, so both directions are exercised here.
    const unicodeId = '分隔\u2028段落\u2029末尾'
    assert.deepEqual(await request('ping', undefined, 4000, unicodeId), { jsonrpc: '2.0', id: unicodeId, result: {} })

    assert.ok(fs.existsSync(CONNECTION_FILE) === false, 'offline test must not have a discovery file')

    const call = await request('tools/call', { name: 'browser_tabs', arguments: { action: 'list' } })
    assert.equal(call.error, undefined, 'offline tool call must be a tool result, not a protocol error')
    assert.equal(call.result?.isError, true, 'offline tool call must report isError')
    const text = (call.result?.content ?? []).map((item) => item.text ?? '').join('\n')
    assert.match(text, /未找到 Aa Browser|无法连接|请先启动|禁用自动启动/, `unexpected offline error text: ${text}`)
  } finally {
    try { child.stdin.end() } catch { /* ignore */ }
    try { child.kill() } catch { /* ignore */ }
    try { fs.rmSync(CONNECTION_FILE, { force: true }) } catch { /* ignore */ }
  }
})

await test('cancelled tools/call is not sent after a delayed browser connection opens', async () => {
  const server = new WebSocketServer({
    port: 0,
    verifyClient: (_info, done) => setTimeout(() => done(true), 250)
  })
  let browserCalls = 0
  server.on('connection', (socket) => socket.on('message', () => { browserCalls++ }))
  await new Promise((resolve) => server.once('listening', resolve))
  fs.writeFileSync(CANCEL_CONNECTION_FILE, JSON.stringify({
    pid: process.pid,
    port: server.address().port,
    token: 'test-token'
  }))

  const child = startBridge(CANCEL_CONNECTION_FILE)
  const response = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cancelled tools/call did not receive a response')), 4000)
    const rl = readline.createInterface({ input: child.stdout })
    rl.on('line', (line) => {
      try {
        const message = JSON.parse(line)
        if (message.id === 42) {
          clearTimeout(timer)
          rl.close()
          resolve(message)
        }
      } catch {
        /* Ignore diagnostic or incomplete output. */
      }
    })
    child.once('error', reject)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 42, method: 'tools/call', params: { name: 'browser_tabs', arguments: { action: 'list' } } })}\n`)
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 42 } })}\n`)
  })

  try {
    assert.equal(response.result?.isError, true)
    assert.match(response.result?.content?.[0]?.text ?? '', /已取消/)
    assert.equal(browserCalls, 0, 'cancelled call must not reach the browser bridge')
  } finally {
    try { child.stdin.end() } catch { /* ignore */ }
    try { child.kill() } catch { /* ignore */ }
    try { fs.rmSync(CANCEL_CONNECTION_FILE, { force: true }) } catch { /* ignore */ }
    await new Promise((resolve) => server.close(resolve))
  }
})
