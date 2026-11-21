#!/usr/bin/env node
/** Regression: concurrent MCP calls share one WebSocket handshake and socket cleanup is scoped. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn } from 'node:child_process'
import { WebSocketServer } from 'ws'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BRIDGE = path.join(ROOT, 'cli', 'mcp.mjs')
const CONNECTION_FILE = path.join(os.tmpdir(), `aa-bridge-race-${process.pid}-${Date.now()}.json`)
const server = new WebSocketServer({
  port: 0,
  verifyClient: (_info, done) => setTimeout(() => done(true), 200)
})
let connections = 0
server.on('connection', (socket) => {
  connections++
  socket.on('message', (raw) => {
    const request = JSON.parse(raw.toString())
    socket.send(JSON.stringify({
      id: request.id,
      ok: true,
      result: { content: [{ type: 'text', text: `reply-${request.args?.marker}` }] }
    }))
  })
})
await new Promise((resolve) => server.once('listening', resolve))
fs.writeFileSync(CONNECTION_FILE, JSON.stringify({
  pid: process.pid,
  port: server.address().port,
  token: 'test-token'
}))
const child = spawn(process.execPath, [BRIDGE], {
  cwd: ROOT,
  env: {
    ...process.env,
    AA_BROWSER_CONNECTION_FILE: CONNECTION_FILE,
    AA_BROWSER_AUTO_LAUNCH: '0'
  },
  stdio: ['pipe', 'pipe', 'pipe']
})
child.stderr.on('data', (chunk) => process.stderr.write(chunk))
const pending = new Map()
const rl = readline.createInterface({ input: child.stdout })
let nextId = 1
rl.on('line', (line) => {
  try {
    const message = JSON.parse(line)
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    waiter.resolve(message)
  } catch { /* Ignore incomplete or diagnostic output. */ }
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
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'connection-race-test', version: '0' }
  })
  assert.equal(init.result?.serverInfo?.name, 'aa-browser')
  const calls = Array.from({ length: 8 }, (_, index) => request('tools/call', {
    name: 'browser_tabs',
    arguments: { action: 'list', marker: index }
  }))
  const responses = await Promise.all(calls)
  assert.equal(connections, 1, 'concurrent calls must share a single in-flight WebSocket handshake')
  for (let index = 0; index < responses.length; index++) {
    assert.equal(responses[index].error, undefined, JSON.stringify(responses[index]))
    assert.equal(responses[index].result?.content?.[0]?.text, `reply-${index}`)
  }
  console.log('PASS: concurrent MCP calls share one delayed WebSocket handshake and all responses are routed')
} finally {
  try { child.stdin.end() } catch { /* ignore */ }
  try { child.kill() } catch { /* ignore */ }
  try { rl.close() } catch { /* ignore */ }
  try { fs.rmSync(CONNECTION_FILE, { force: true }) } catch { /* ignore */ }
  for (const client of server.clients) {
    try { client.terminate() } catch { /* ignore */ }
  }
  await new Promise((resolve) => server.close(resolve))
}
