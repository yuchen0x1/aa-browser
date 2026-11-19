#!/usr/bin/env node
/**
 * End-to-end test for `install.mjs --connect-only --verify --json`.
 *
 * Uses the packaged build produced by `npm run dist` / `dist:linux` with an isolated
 * HOME/XDG profile, so it never touches real user data or MCP configs:
 *   - Windows: release/win-unpacked/Aa Browser.exe
 *   - Linux:   release/*.AppImage (copied to an isolated stable path)
 *
 * On Linux the CI runner must provide a display (wrap with `xvfb-run -a`).
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const isWin = process.platform === 'win32'
const isLinux = process.platform === 'linux'
if (!isWin && !isLinux) {
  console.log(`SKIP: connect-flow test requires Windows or Linux (got ${process.platform})`)
  process.exit(0)
}

const releaseDir = path.join(ROOT, 'release')
function packagedApp() {
  if (isWin) {
    const exe = path.join(releaseDir, 'win-unpacked', 'Aa Browser.exe')
    return fs.existsSync(exe) ? exe : null
  }
  const appImage = fs.readdirSync(releaseDir, { withFileTypes: true }).find((entry) => entry.isFile() && entry.name.endsWith('.AppImage'))
  return appImage ? path.join(releaseDir, appImage.name) : null
}
const sourceApp = packagedApp()
if (!sourceApp) {
  console.log('SKIP: packaged build not found (run npm run dist / npm run dist:linux first)')
  process.exit(0)
}

const runDir = path.join(ROOT, '.local-verification', `connect-flow-${Date.now()}-${process.pid}`)
const home = path.join(runDir, 'home')
const appData = path.join(runDir, 'AppData', 'Roaming')
const xdgConfig = path.join(runDir, 'config')
fs.mkdirSync(home, { recursive: true })
fs.mkdirSync(appData, { recursive: true })
fs.mkdirSync(xdgConfig, { recursive: true })

let appPath = sourceApp
let appDir = path.dirname(sourceApp)
if (isLinux) {
  appDir = path.join(runDir, 'Applications')
  fs.mkdirSync(appDir, { recursive: true })
  appPath = path.join(appDir, 'AaBrowser.AppImage')
  fs.copyFileSync(sourceApp, appPath)
  fs.chmodSync(appPath, 0o755)
}

const environment = {
  ...process.env,
  USERPROFILE: home,
  HOME: home,
  APPDATA: appData,
  XDG_CONFIG_HOME: xdgConfig,
  AA_BROWSER_CONNECTION_FILE: path.join(runDir, 'connection.json'),
  AA_BROWSER_SETTINGS_FILE: path.join(runDir, 'settings.json'),
  AA_BROWSER_HISTORY_DIR: path.join(runDir, 'history'),
  AA_BROWSER_DOWNLOAD_DIR: path.join(runDir, 'downloads'),
  AA_BROWSER_SCREENSHOT_DIR: path.join(runDir, 'screenshots')
}
if (isWin) environment.AA_BROWSER_USER_DATA_DIR = path.join(runDir, 'profile')
delete environment.ELECTRON_RUN_AS_NODE

const connectionFile = environment.AA_BROWSER_CONNECTION_FILE
let child = null
let failures = 0
const check = (label, value, detail = '') => {
  console.log(`${value ? '  ✅' : '  ❌'} ${label}${value || !detail ? '' : ` —— ${detail}`}`)
  if (!value) failures++
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const alive = (pid) => {
  try { process.kill(pid, 0); return true } catch { return false }
}

try {
  const launchEnv = isLinux ? { ...environment, APPIMAGE_EXTRACT_AND_RUN: '1' } : environment
  child = spawn(appPath, [], { env: launchEnv, stdio: 'ignore', detached: true })
  child.unref()
  let connection = null
  const deadline = Date.now() + 45000
  while (Date.now() < deadline && !connection) {
    await sleep(300)
    try {
      const info = JSON.parse(fs.readFileSync(connectionFile, 'utf-8'))
      if (info?.port && info?.token && alive(info.pid)) connection = info
    } catch {
      /* still starting */
    }
  }
  assert.ok(connection, `Aa Browser did not become ready (${connectionFile})`)
  check(`isolated packaged app started (${process.platform})`, true)

  const result = spawnSync(process.execPath, ['install.mjs', '--connect-only', '--dir', appDir, '--clients', '__none__', '--verify', '--json'], {
    cwd: ROOT,
    env: environment,
    encoding: 'utf8',
    timeout: 180000
  })
  const stdout = result.stdout.trim().split(/\r?\n/).filter(Boolean)
  let report = null
  try { report = JSON.parse(stdout.at(-1) ?? '') } catch { /* reported below */ }
  check('install.mjs exits 0', result.status === 0, result.stderr.slice(-800))
  check('install.mjs returns JSON report', !!report, result.stdout.slice(-500))
  check('report.ok is true', report?.ok === true, JSON.stringify(report))
  check('browser_tabs verification passed', report?.verified === true, JSON.stringify(report?.error))
  check('bridge path was resolved', typeof report?.bridge === 'string' && fs.existsSync(report.bridge), report?.bridge)

  const printConfig = spawnSync(process.execPath, ['install.mjs', '--print-config', '--dir', appDir], {
    cwd: ROOT,
    env: environment,
    encoding: 'utf8',
    timeout: 30000
  })
  let config = null
  try { config = JSON.parse(printConfig.stdout) } catch { /* reported below */ }
  check('--print-config returns an MCP entry', !!config?.mcpServers?.['aa-browser']?.args?.[0], printConfig.stdout.slice(0, 300))
  check('--print-config bridge exists', !!config && fs.existsSync(config.mcpServers['aa-browser'].args[0]))

  if (failures) {
    console.error(`\n🚨 connect-flow failed: ${failures} check(s)`)
    process.exitCode = 1
  } else {
    console.log('\n🎉 install.mjs --connect-only --verify works against a packaged app')
  }
} catch (error) {
  console.error(`\n🚨 connect-flow error: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
} finally {
  try {
    const info = JSON.parse(fs.readFileSync(connectionFile, 'utf-8'))
    if (info?.pid) process.kill(info.pid)
  } catch { /* ignore */ }
  try { child?.kill() } catch { /* ignore */ }
  await sleep(500)
  fs.rmSync(runDir, { recursive: true, force: true })
}
