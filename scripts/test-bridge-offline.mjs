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
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BRIDGE = path.join(ROOT, 'cli', 'mcp.mjs')
const CONNECTION_FILE = path.join(os.tmpdir(), `aa-bridge-offline-${process.pid}-${Date.now()}.json`)

function startBridge() {
  return spawn(process.execPath, [BRIDGE], {
    cwd: ROOT,
    env: {
      ...process.env,
      AA_BROWSER_CONNECTION_FILE: CONNECTION_FILE,
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
  const request = (method, params, timeoutMs = 8000) => new Promise((resolve, reject) => {
    const id = nextId++
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
    assert.ok(fs.existsSync(CONNECTION_FILE) === false, 'offline test must not have a discovery file')

    const call = await request('tools/call', { name: 'browser_tabs', arguments: { action: 'list' } })
    assert.equal(call.error, undefined, 'offline tool call must be a tool result, not a protocol error')
    assert.equal(call.result?.isError, true, 'offline tool call must report isError')
    const text = (call.result?.content ?? []).map((item) => item.text ?? '').join('\n')
    assert.match(text, /未找到 Aa Browser|无法连接|请先启动/, `unexpected offline error text: ${text}`)
  } finally {
    try { child.stdin.end() } catch { /* ignore */ }
    try { child.kill() } catch { /* ignore */ }
    try { fs.rmSync(CONNECTION_FILE, { force: true }) } catch { /* ignore */ }
  }
})
