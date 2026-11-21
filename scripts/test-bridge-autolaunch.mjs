#!/usr/bin/env node
/**
 * Regression: with no running browser, the MCP bridge starts the source desktop
 * app, waits for connection.json, and completes the first browser tool call.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import readline from 'node:readline'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const BRIDGE = path.join(ROOT, 'cli', 'mcp.mjs')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `aa-bridge-autolaunch-${process.pid}-`))
const connection = path.join(tmp, 'connection.json')
const child = spawn(process.execPath, [BRIDGE], {
  cwd: ROOT,
  env: {
    ...process.env,
    AA_BROWSER_CONNECTION_FILE: connection,
    AA_BROWSER_USER_DATA_DIR: path.join(tmp, 'profile'),
    AA_BROWSER_HISTORY_DIR: path.join(tmp, 'history'),
    AA_BROWSER_SETTINGS_FILE: path.join(tmp, 'settings.json'),
    AA_BROWSER_SESSION_FILE: path.join(tmp, 'session.json'),
    AA_BROWSER_DOWNLOAD_DIR: path.join(tmp, 'downloads'),
    AA_BROWSER_AUTO_LAUNCH: '1',
    AA_BROWSER_LAUNCH_TIMEOUT_MS: '60000',
    AA_BROWSER_CONNECT_RETRY_MS: '250'
  },
  stdio: ['pipe', 'pipe', 'pipe']
})

const pending = new Map()
let nextId = 1
const rl = readline.createInterface({ input: child.stdout })
rl.on('line', (line) => {
  try {
    const message = JSON.parse(line)
    const waiter = pending.get(message.id)
    if (!waiter) return
    pending.delete(message.id)
    waiter.resolve(message)
  } catch {
    /* Ignore non-protocol output. */
  }
})
child.stderr.on('data', (chunk) => process.stderr.write(chunk))

function request(method, params, timeoutMs = 70_000) {
  return new Promise((resolve, reject) => {
    const id = nextId++
    const timer = setTimeout(() => {
      pending.delete(id)
      reject(new Error(`no response to ${method} within ${timeoutMs}ms`))
    }, timeoutMs)
    pending.set(id, {
      resolve: (value) => { clearTimeout(timer); resolve(value) },
      reject
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
  })
}

try {
  const init = await request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'autolaunch-test', version: '0' }
  })
  assert.equal(init.result?.serverInfo?.name, 'aa-browser')
  const call = await request('tools/call', { name: 'browser_tabs', arguments: { action: 'list' } })
  assert.equal(call.error, undefined, JSON.stringify(call))
  assert.notEqual(call.result?.isError, true, JSON.stringify(call))
  assert.ok(fs.existsSync(connection), 'auto-launched browser should publish connection.json')
  console.log('✅ MCP bridge auto-launched Aa Browser and completed browser_tabs')
} finally {
  let browserPid
  try { browserPid = JSON.parse(fs.readFileSync(connection, 'utf8')).pid } catch { /* best effort cleanup */ }
  try { child.stdin.end() } catch { /* ignore */ }
  try { child.kill() } catch { /* ignore */ }
  if (browserPid) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(browserPid), '/T', '/F'], { stdio: 'ignore' })
    else {
      try { process.kill(browserPid, 'SIGTERM') } catch { /* process already exited */ }
    }
  }
  // Electron releases Chromium profile locks asynchronously after SIGTERM. Retry the
  // fixture cleanup instead of turning a successful browser regression into ENOTEMPTY.
  await delay(200)
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 })
}
