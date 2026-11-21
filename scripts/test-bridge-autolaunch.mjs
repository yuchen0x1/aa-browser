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
import { linuxUserDataDirFor } from '../install.mjs'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const image = process.argv[2] && path.resolve(process.argv[2])
assert.ok(!image || (process.platform === 'linux' && image.endsWith('.AppImage') && fs.statSync(image).isFile()), 'Pass a locally built Linux AppImage')
const version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `aa-bridge-autolaunch-${process.pid}-`))
const connection = path.join(tmp, 'connection.json')
const profile = path.join(tmp, 'profile')
const settingsFile = path.join(tmp, 'settings.json')
const env = {
  ...process.env,
  AA_BROWSER_CONNECTION_FILE: connection,
  AA_BROWSER_USER_DATA_DIR: profile,
  AA_BROWSER_HISTORY_DIR: path.join(tmp, 'history'),
  AA_BROWSER_SETTINGS_FILE: settingsFile,
  AA_BROWSER_SESSION_FILE: path.join(tmp, 'session.json'),
  AA_BROWSER_DOWNLOAD_DIR: path.join(tmp, 'downloads'),
  AA_BROWSER_EVIDENCE_FILE: path.join(tmp, 'evidence.json'),
  AA_BROWSER_AUTO_LAUNCH: '1',
  AA_BROWSER_LAUNCH_TIMEOUT_MS: '60000',
  AA_BROWSER_CONNECT_RETRY_MS: '250'
}
let child
let childExit = Promise.resolve()

function childHasExited(proc) {
  return !proc || proc.exitCode !== null || proc.signalCode !== null
}

function processGroupExists(pid) {
  try { process.kill(-pid, 0); return true }
  catch (error) { return error?.code === 'EPERM' }
}

async function waitForChildExit(timeoutMs) {
  if (childHasExited(child)) return true
  return Promise.race([childExit.then(() => true), delay(timeoutMs).then(() => false)])
}

async function waitForGroupExit(pid, timeoutMs) {
  const deadline = Date.now() + timeoutMs
  while (processGroupExists(pid) && Date.now() < deadline) await delay(100)
  return !processGroupExists(pid)
}

async function stopOwnedProcesses() {
  if (!child?.pid) return
  const pid = child.pid // Only ever signal the process/group created by this test.
  if (process.platform === 'win32') {
    let treeKill = null
    if (!childHasExited(child)) {
      treeKill = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], {
        stdio: 'ignore', windowsHide: true, timeout: 10000
      })
    }
    if (!await waitForChildExit(2000)) {
      try { child.kill() } catch { /* already stopped */ }
      await waitForChildExit(1000)
    }
    if (!childHasExited(child) || treeKill?.error || (treeKill && treeKill.status !== 0)) {
      throw new Error('Could not confirm cleanup of the test-owned Windows process tree')
    }
    return
  }

  // detached:true gives this bridge its own POSIX process group. Its AppImage /
  // Electron descendants inherit that group, even if startup never wrote connection.json.
  try { process.kill(-pid, 'SIGTERM') } catch { /* group already exited */ }
  let groupExited = await waitForGroupExit(pid, 5000)
  if (!groupExited) {
    try { process.kill(-pid, 'SIGKILL') } catch { /* group already exited */ }
    groupExited = await waitForGroupExit(pid, 2000)
  }
  if (!await waitForChildExit(1000)) {
    try { child.kill('SIGKILL') } catch { /* already stopped */ }
    await waitForChildExit(1000)
  }
  if (!groupExited || !childHasExited(child)) {
    throw new Error('Could not confirm cleanup of the test-owned POSIX process group')
  }
}

try {
  fs.writeFileSync(settingsFile, JSON.stringify({ autoUpdate: false, restoreSession: false }))
  let appUserDataDir = profile
  if (process.platform === 'win32') {
    // Source-mode discovery must not see a real per-user or system installation.
    env.HOME = path.join(tmp, 'home')
    env.USERPROFILE = env.HOME
    env.APPDATA = path.join(tmp, 'appdata')
    env.LOCALAPPDATA = path.join(tmp, 'local-appdata')
    env.PROGRAMFILES = path.join(tmp, 'program-files')
    env['PROGRAMFILES(X86)'] = path.join(tmp, 'program-files-x86')
  } else if (process.platform === 'linux') {
    // Match install.mjs linuxUserDataDirFor() while keeping every XDG location test-owned.
    env.HOME = path.join(tmp, 'home')
    env.XDG_CONFIG_HOME = path.join(tmp, 'config')
    env.XDG_CACHE_HOME = path.join(tmp, 'cache')
    env.XDG_DATA_HOME = path.join(tmp, 'data')
    env.XDG_STATE_HOME = path.join(tmp, 'state')
    env.XDG_RUNTIME_DIR = path.join(tmp, 'runtime')
    appUserDataDir = linuxUserDataDirFor(env, env.HOME)
    for (const dir of [env.HOME, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME]) {
      fs.mkdirSync(dir, { recursive: true })
    }
    fs.mkdirSync(env.XDG_RUNTIME_DIR, { recursive: true, mode: 0o700 })

    // These hard-coded bridge candidates precede HOME/Applications. Refuse to run
    // rather than accidentally starting a host installation during this fixture.
    const hostCandidates = ['/usr/bin/aa-browser', '/usr/local/bin/aa-browser', '/opt/Aa Browser/aa-browser']
      .filter((candidate) => fs.existsSync(candidate))
    assert.deepEqual(hostCandidates, [], `Refusing to launch host-installed Aa Browser candidates: ${hostCandidates.join(', ')}`)
  }
  env.AA_BROWSER_USER_DATA_DIR = appUserDataDir
  delete env.AA_BROWSER_APP_PATH

  let bridge = path.join(ROOT, 'cli', 'mcp.mjs')
  if (image) {
    // Stage the packaged bridge at the same XDG userData path used by the AppImage installer.
    const installed = path.join(env.HOME, 'Applications', 'AaBrowser.AppImage')
    fs.mkdirSync(path.dirname(installed), { recursive: true })
    fs.copyFileSync(image, installed)
    fs.chmodSync(installed, 0o755)
    bridge = path.join(appUserDataDir, 'mcp', 'bridge.cjs')
    fs.mkdirSync(path.dirname(bridge), { recursive: true })
    fs.copyFileSync(path.join(ROOT, 'out', 'bridge', 'mcp.cjs'), bridge)
  }
  child = spawn(process.execPath, [bridge], {
    cwd: ROOT,
    env,
    detached: process.platform !== 'win32',
    stdio: ['pipe', 'pipe', 'pipe']
  })
  childExit = new Promise((resolve) => {
    if (childHasExited(child)) return resolve()
    child.once('exit', resolve)
    child.once('error', resolve)
  })
} catch (error) {
  await stopOwnedProcesses()
  fs.rmSync(tmp, { recursive: true, force: true })
  throw error
}

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
  assert.equal(init.result?.serverInfo?.version, version, 'initialize must report the candidate bridge version')
  const call = await request('tools/call', { name: 'browser_tabs', arguments: { action: 'list' } })
  assert.equal(call.error, undefined, JSON.stringify(call))
  assert.notEqual(call.result?.isError, true, JSON.stringify(call))
  const tabText = call.result?.content?.find((item) => item?.type === 'text')?.text
  assert.equal(typeof tabText, 'string', `browser_tabs must return text content: ${JSON.stringify(call)}`)
  assert.match(tabText, /^共 [1-9]\d* 个标签页：/m, `browser_tabs must return the production tab-list heading: ${JSON.stringify(call)}`)
  assert.match(tabText, /^\d+\. \[[^\]\r\n]+\] ★活动/m, `browser_tabs must include a production-format active tab row: ${JSON.stringify(call)}`)
  const connectionInfo = JSON.parse(fs.readFileSync(connection, 'utf8'))
  assert.equal(connectionInfo.version, version, 'cold launch must connect to the candidate version')
  console.log(`✅ MCP bridge auto-launched Aa Browser ${version} (${image ? 'default-path AppImage' : 'source app'}) and listed the active tab`)
} finally {
  await stopOwnedProcesses()
  // Electron releases Chromium profile locks asynchronously. Wait for the owned process
  // tree/group to exit before retrying fixture removal; never use a PID read from discovery.
  await delay(200)
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 50, retryDelay: 200 })
}
