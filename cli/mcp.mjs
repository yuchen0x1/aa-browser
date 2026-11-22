#!/usr/bin/env node
/**
 * aa-browser-mcp —— MCP stdio 桥。
 *
 * 把 MCP（stdio 上的 JSON-RPC）连接转发到 Aa Browser 桌面应用
 * （通过 ~/.aabrowser/connection.json 发现，未运行时首次工具调用会按受信路径自动启动，走本地 WebSocket）。
 *
 * 协议：MCP stdio 为换行分隔的 JSON-RPC 2.0。实现最小子集：
 *   initialize / notifications/* / tools/list / tools/call / ping
 * 零依赖，直接 `node cli/mcp.mjs` 运行。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import process from 'node:process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import WebSocket from 'ws'
import { TOOL_DEFS, TOOL_ANNOTATIONS } from '../src/shared/tool-defs.mjs'

/**
 * 版本号单一来源：优先使用构建期注入的 package.json 版本；
 * 源码直接运行时回退到逐级查找 package.json。
 * 构建产物 out/bridge/mcp.cjs 位于 <root>/out/bridge/，源码位于 <root>/cli/。
 *
 * ⚠️ 注入走 globalThis 动态属性，而不是"常量与字面量比较"：
 * 打包器会把 `X !== '0.0.0-dev'` 这种常量比较直接折叠掉，
 * 连注入点一起删除，构建期就再也找不到可替换的位置。
 */
function readVersion() {
  try {
    const injected = globalThis.__AA_BRIDGE_VERSION__
    if (typeof injected === 'string' && injected) return injected
  } catch {
    /* 宿主禁用 globalThis：继续回退 */
  }
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 5; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf-8'))
      if (pkg?.name === 'aa-browser' && typeof pkg.version === 'string') return pkg.version
    } catch {
      /* 继续向上 */
    }
    const up = path.dirname(dir)
    if (up === dir) break
    dir = up
  }
  return '0.0.0'
}

const VERSION = readVersion()
const CONNECT_FILE = process.env['AA_BROWSER_CONNECTION_FILE'] || path.join(os.homedir(), '.aabrowser', 'connection.json')
/**
 * 必须大于主进程的审批等待窗口（ApprovalManager 默认 120s），
 * 否则用户还在审批时桥已超时并发出 cancel，审批结果永远无法送达。
 */
const CALL_TIMEOUT_MS = 180_000

const log = (...a) => console.error('[aa-browser-mcp]', ...a)

/* ──────────────────── 工具定义（单一来源 src/shared/tool-defs.mjs） ──────────────────── */

// Keep every MCP hint explicit. Values are conservative for tools whose
// action can either read or mutate browser/page state.


for (const tool of TOOL_DEFS) {
  const annotations = TOOL_ANNOTATIONS[tool.name]
  if (!annotations || Object.keys(annotations).length !== 4 || Object.values(annotations).some((value) => typeof value !== 'boolean')) {
    throw new Error(`工具缺少完整 MCP annotations：${tool.name}`)
  }
}

/* ──────────────────── WS 连接管理 ──────────────────── */

let ws = null
let connecting = null
let suspendedReconnect = null
let nextCallId = 1
const pending = new Map() // 线上 id -> { id, resolve, reject, timer, mcpId, socket, name, args, progressToken }
/** 断线后等待重连再重发的只读调用；写操作绝不进入这里。 */
const suspended = new Set()
const mcpToBridge = new Map()
const cancelledMcpRequests = new Set()
const bridgeToProgressToken = new Map() // 桥调用 id -> MCP progressToken（仅在调用期间存在）

/**
 * 只有「只读 + 幂等」的调用才允许跨重启自动重发：
 * 应用更新会重启进程，重发读取不会改变页面；点击、输入、表单提交等
 * 可能已部分执行，重放会造成二次副作用，因此只回报明确的中断错误。
 */
const RETRYABLE_TOOLS = new Set(
  TOOL_DEFS
    .filter((tool) => TOOL_ANNOTATIONS[tool.name]?.readOnlyHint === true && TOOL_ANNOTATIONS[tool.name]?.idempotentHint === true)
    .map((tool) => tool.name)
)
const RETRY_ON_RECONNECT = process.env['AA_BROWSER_RETRY_ON_RECONNECT'] !== '0'
function isRetryable(name, args) {
  if (!RETRY_ON_RECONNECT) return false
  // browser_tabs 整体带写标记，但 list 只是读取新实例的标签列表，重发安全。
  if (name === 'browser_tabs') return args?.action === 'list'
  return RETRYABLE_TOOLS.has(name)
}

function readConnection() {
  try {
    const info = JSON.parse(fs.readFileSync(CONNECT_FILE, 'utf-8'))
    if (!info.port || !info.token) throw new Error('invalid')
    return info
  } catch {
    return null
  }
}

/**
 * 更新重启标记：应用在 quitAndInstall 前写入，重启后的新实例清除。
 * 看到标记说明「旧实例已退出、安装器/新实例还没就绪」，此时不能自动启动，
 * 否则会和安装器抢文件或拉起一个旧版本。
 */
const RESTART_MARKER = path.join(path.dirname(CONNECT_FILE), 'update-restart.json')
const RESTART_MARKER_TTL_MS = 10 * 60_000
const UPDATE_RESTART_TIMEOUT_MS = Math.min(
  CALL_TIMEOUT_MS,
  Math.max(5_000, Number(process.env['AA_BROWSER_RESTART_TIMEOUT_MS']) || 120_000)
)

function updateRestartPending() {
  try {
    const marker = JSON.parse(fs.readFileSync(RESTART_MARKER, 'utf-8'))
    if (marker?.reason !== 'update' || typeof marker.at !== 'number') return false
    const age = Date.now() - marker.at
    return age >= -60_000 && age <= RESTART_MARKER_TTL_MS
  } catch {
    return false
  }
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

const AUTO_LAUNCH_TIMEOUT_MS = Math.min(120_000, Math.max(5_000, Number(process.env['AA_BROWSER_LAUNCH_TIMEOUT_MS']) || 30_000))
const CONNECT_RETRY_MS = Math.min(2_000, Math.max(100, Number(process.env['AA_BROWSER_CONNECT_RETRY_MS']) || 500))
let launchPromise = null

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function isRegularFile(file) {
  try { return fs.statSync(file).isFile() } catch { return false }
}

function addPathCandidate(list, value) {
  if (!value || !path.isAbsolute(value)) return
  const resolved = path.resolve(value)
  if (!list.includes(resolved)) list.push(resolved)
}

function browserLaunchSpec() {
  const candidates = []
  const explicit = process.env['AA_BROWSER_APP_PATH']?.trim()
  if (explicit) {
    if (!path.isAbsolute(explicit)) throw new Error('AA_BROWSER_APP_PATH 必须是绝对路径。')
    const file = path.resolve(explicit)
    const allowed = process.platform === 'win32'
      ? /^(Aa Browser|aa-browser)\.exe$/i
      : process.platform === 'linux'
        ? /^(?:AppRun|AaBrowser\.AppImage|(?:Aa Browser|aa-browser)(?:\.AppImage|-[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9._-]+)?\.AppImage)?)$/i
        : /^(Aa Browser|aa-browser)$/i
    if (!allowed.test(path.basename(file)) || !isRegularFile(file)) {
      throw new Error('AA_BROWSER_APP_PATH 不是受支持的 Aa Browser 可执行文件。')
    }
    return { command: file, args: [], cwd: path.dirname(file) }
  }

  const bridgeDir = path.dirname(path.resolve(fileURLToPath(import.meta.url)))
  const installRoot = path.resolve(bridgeDir, '../../../..')
  if (fs.existsSync(path.join(installRoot, 'resources', 'app.asar.unpacked'))) {
    addPathCandidate(candidates, path.join(installRoot, process.platform === 'win32' ? 'Aa Browser.exe' : 'aa-browser'))
    if (process.platform === 'linux') {
      addPathCandidate(candidates, path.join(installRoot, 'Aa Browser'))
      addPathCandidate(candidates, path.join(installRoot, 'usr', 'bin', 'aa-browser'))
      addPathCandidate(candidates, path.join(installRoot, 'AppRun'))
    }
  }

  if (process.platform === 'win32') {
    const localAppData = process.env['LOCALAPPDATA']
    const programFiles = process.env['PROGRAMFILES']
    const programFilesX86 = process.env['PROGRAMFILES(X86)']
    for (const dir of [
      localAppData && path.join(localAppData, 'Programs', 'Aa Browser'),
      programFiles && path.join(programFiles, 'Aa Browser'),
      programFilesX86 && path.join(programFilesX86, 'Aa Browser')
    ]) addPathCandidate(candidates, dir && path.join(dir, 'Aa Browser.exe'))
  } else if (process.platform === 'darwin') {
    addPathCandidate(candidates, '/Applications/Aa Browser.app/Contents/MacOS/Aa Browser')
    addPathCandidate(candidates, path.join(os.homedir(), 'Applications', 'Aa Browser.app', 'Contents', 'MacOS', 'Aa Browser'))
  } else {
    addPathCandidate(candidates, '/usr/bin/aa-browser')
    addPathCandidate(candidates, '/usr/local/bin/aa-browser')
    addPathCandidate(candidates, '/opt/Aa Browser/aa-browser')
    addPathCandidate(candidates, path.join(os.homedir(), '.local', 'bin', 'aa-browser'))
    if (process.platform === 'linux') addPathCandidate(candidates, path.join(os.homedir(), 'Applications', 'AaBrowser.AppImage'))
  }

  // 源码目录：只在当前仓库和本地 Electron 可验证时启动构建产物，不执行 shell 或任意命令。
  let sourceSpec = null
  let sourceRoot = bridgeDir
  for (let i = 0; i < 6; i++) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'))
      if (pkg?.name === 'aa-browser') {
        const electronBinary = process.platform === 'win32'
          ? path.join(sourceRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
          : process.platform === 'darwin'
            ? path.join(sourceRoot, 'node_modules', 'electron', 'dist', 'Electron.app', 'Contents', 'MacOS', 'Electron')
            : path.join(sourceRoot, 'node_modules', 'electron', 'dist', 'electron')
        if (isRegularFile(electronBinary)) sourceSpec = { command: electronBinary, args: [sourceRoot], cwd: sourceRoot }
        break
      }
    } catch { /* 非源码路径继续查找 */ }
    const parent = path.dirname(sourceRoot)
    if (parent === sourceRoot) break
    sourceRoot = parent
  }

  const file = candidates.find((candidate) => isRegularFile(candidate))
  if (file) return { command: file, args: [], cwd: path.dirname(file) }
  return sourceSpec
}

function connectionReady() {
  const info = readConnection()
  return !!info && isPidAlive(info.pid)
}

async function waitForConnection() {
  const deadline = Date.now() + AUTO_LAUNCH_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (connectionReady()) return
    await delay(CONNECT_RETRY_MS)
  }
  throw new Error(`Aa Browser 已启动但在 ${Math.round(AUTO_LAUNCH_TIMEOUT_MS / 1000)} 秒内没有写入连接信息。`)
}

async function ensureBrowserStarted() {
  if (process.env['AA_BROWSER_AUTO_LAUNCH'] === '0' || process.env['AA_BROWSER_AUTO_LAUNCH']?.toLowerCase() === 'false') {
    throw new Error('Aa Browser 未运行，且已通过 AA_BROWSER_AUTO_LAUNCH 禁用自动启动。')
  }
  if (connectionReady()) return
  if (launchPromise) return launchPromise
  launchPromise = (async () => {
    const spec = browserLaunchSpec()
    if (!spec) throw new Error('未找到可启动的 Aa Browser。请安装桌面应用，或设置 AA_BROWSER_APP_PATH 指向 Aa Browser.exe/aa-browser。')
    log('Aa Browser 未运行，正在自动启动…')
    await new Promise((resolve, reject) => {
      let settled = false
      const launchEnv = { ...process.env, AA_BROWSER_CONNECTION_FILE: CONNECT_FILE, AA_BROWSER_START_IN_BACKGROUND: '1' }
      delete launchEnv.ELECTRON_RUN_AS_NODE
      const child = spawn(spec.command, spec.args, {
        cwd: spec.cwd,
        env: launchEnv,
        detached: false,
        stdio: 'ignore',
        windowsHide: true
      })
      child.once('error', (error) => {
        if (!settled) { settled = true; reject(new Error(`自动启动 Aa Browser 失败：${error.message}`)) }
      })
      child.once('spawn', () => {
        if (!settled) { settled = true; resolve() }
      })
      child.unref()
    })
    await waitForConnection()
    log('Aa Browser 已启动，等待 MCP 连接就绪')
  })().finally(() => { launchPromise = null })
  return launchPromise
}

/** 清除一条调用的所有索引；调用方随后决定 resolve / reject。 */
function detachPending(p) {
  clearTimeout(p.timer)
  if (p.id !== null) {
    pending.delete(p.id)
    bridgeToProgressToken.delete(p.id)
  }
  suspended.delete(p)
  if (p.mcpId !== undefined && (mcpToBridge.get(p.mcpId) === p.id || mcpToBridge.get(p.mcpId) === -2)) {
    mcpToBridge.delete(p.mcpId)
  }
}

function rejectPending(p, error) {
  detachPending(p)
  p.reject(error)
}

/** 发送（首次或重连后重发）；成功回包由 socket message 处理。 */
function sendPending(p, socket) {
  suspended.delete(p)
  const id = nextCallId++
  p.id = id
  p.socket = socket
  pending.set(id, p)
  if (p.mcpId !== undefined) mcpToBridge.set(p.mcpId, id)
  if (p.progressToken !== undefined) bridgeToProgressToken.set(id, p.progressToken)
  const request = { id, tool: p.name, args: p.args }
  if (p.progressToken !== undefined) request.progressToken = p.progressToken
  const failSend = (error) => {
    if (!error || pending.get(id) !== p) return
    rejectPending(p, error)
  }
  try {
    if (socket.readyState !== WebSocket.OPEN) throw new Error('与 Aa Browser 的连接已断开。')
    socket.send(JSON.stringify(request), failSend)
  } catch (error) {
    failSend(error)
  }
}

/** 新实例连上后，把等待中的只读调用按新 id 重发。 */
function flushSuspended(socket) {
  if (!suspended.size || socket.readyState !== WebSocket.OPEN) return
  const queue = [...suspended]
  suspended.clear()
  for (const p of queue) {
    if (pending.get(p.id) === p) continue
    log('replaying read-only call after browser restart:', p.name)
    sendPending(p, socket)
  }
}

/**
 * 断线后主动恢复，避免只读调用干等到 5 秒的 eager 轮询。
 * 走 getWs()：更新重启时它会识别标记、只等待新实例；普通退出/崩溃时
 * 沿用原有的自动启动行为，把浏览器带回来完成这次读取。
 */
function scheduleSuspendedReconnect() {
  if (suspendedReconnect || !suspended.size) return
  suspendedReconnect = (async () => {
    const deadline = Date.now() + UPDATE_RESTART_TIMEOUT_MS
    while (suspended.size && Date.now() < deadline) {
      if (ws && ws.readyState === WebSocket.OPEN) {
        flushSuspended(ws)
        break
      }
      try {
        await getWs()
        if (ws && ws.readyState === WebSocket.OPEN) {
          flushSuspended(ws)
          break
        }
      } catch {
        /* 旧实例已退出但新实例还没就绪：继续等。 */
      }
      await delay(CONNECT_RETRY_MS)
    }
  })().finally(() => { suspendedReconnect = null })
}

function connectWs() {
  if (ws && ws.readyState === WebSocket.OPEN) return Promise.resolve(ws)
  if (connecting) return connecting
  const attempt = new Promise((resolve, reject) => {
    const info = readConnection()
    if (!info) {
      reject(new Error('未找到 Aa Browser：请先启动 Aa Browser 桌面应用（npm run dev 或 npm start）。'))
      return
    }
    if (!isPidAlive(info.pid)) {
      reject(new Error('Aa Browser 进程已退出但发现文件残留：请重新启动 Aa Browser。'))
      return
    }
    const socket = new WebSocket(`ws://127.0.0.1:${info.port}/?token=${info.token}`)
    let settled = false
    const timer = setTimeout(() => {
      try { socket.terminate() } catch {}
      finish(new Error('连接 Aa Browser 超时（3s）。'))
    }, 3000)
    const finish = (error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (error) reject(error)
      else resolve(socket)
    }

    socket.on('open', () => {
      ws = socket
      log('connected to browser bridge', info.pid, info.port)
      socket.on('message', (raw) => {
        let msg
        try { msg = JSON.parse(raw.toString()) } catch { return }
        // 进度事件不属于工具响应：转发为 stdio 通知，绝不能碰 pending，
        // 否则工具调用会被提前 resolve/reject。
        if (msg?.event === 'progress') {
          if (pending.get(msg.id)?.socket !== socket) return
          const token = bridgeToProgressToken.get(msg.id)
          if (token !== undefined) {
            const params = { progressToken: token, progress: msg.progress }
            if (typeof msg.total === 'number') params.total = msg.total
            if (typeof msg.message === 'string') params.message = msg.message
            notify('notifications/progress', params)
          }
          return
        }
        if (typeof msg?.id === 'number' && pending.has(msg.id)) {
          const p = pending.get(msg.id)
          if (p.socket !== socket) return
          clearTimeout(p.timer)
          pending.delete(msg.id)
          bridgeToProgressToken.delete(msg.id)
          log('received browser tool response', msg.id, !!msg.ok)
          if (msg.ok) p.resolve(msg.result)
          else p.reject(new Error(msg.error || '工具执行失败'))
        }
      })
      socket.on('close', () => {
        if (ws === socket) ws = null
        for (const [id, p] of pending) {
          if (p.socket !== socket) continue
          if (isRetryable(p.name, p.args)) {
            // 应用重启（常见于安装更新）会断开 WS。只读且幂等的调用保留到重连后重发，
            // 让 AI 当前这一步拿到真实结果，而不是凭空失败。
            pending.delete(id)
            bridgeToProgressToken.delete(id)
            if (p.mcpId !== undefined) mcpToBridge.set(p.mcpId, -2)
            p.id = null
            p.socket = null
            suspended.add(p)
            log('browser disconnected; queued read-only call for replay:', p.name)
            continue
          }
          rejectPending(p, new Error('与 Aa Browser 的连接已断开。此操作不会自动重试；请重新读取页面状态后再继续。'))
        }
        scheduleSuspendedReconnect()
      })
      socket.on('error', (err) => log('ws error:', err.message))
      // 先重发挂起调用，再把连接交给新的工具调用；两者使用同一 socket。
      flushSuspended(socket)
      finish()
    })
    socket.on('error', (err) => finish(new Error(`无法连接 Aa Browser: ${err.message}`)))
    socket.once('close', () => finish(new Error('与 Aa Browser 的连接已断开。')))
  })
  connecting = attempt
  void attempt.finally(() => {
    if (connecting === attempt) connecting = null
  }).catch(() => {})
  return attempt
}

/** 更新安装期间只等新实例回来，绝不自动启动，避免与安装器抢文件。 */
async function waitForUpdateRestart() {
  const deadline = Date.now() + UPDATE_RESTART_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      return await connectWs()
    } catch {
      /* 旧连接信息已失效，等新实例写回 connection.json。 */
    }
    if (!updateRestartPending()) return null
    await delay(CONNECT_RETRY_MS)
  }
  return null
}

async function getWs() {
  if (ws && ws.readyState === WebSocket.OPEN) return ws
  let lastError
  if (updateRestartPending()) {
    const restarted = await waitForUpdateRestart()
    if (restarted) return restarted
  }
  try {
    return await connectWs()
  } catch (error) {
    lastError = error
  }
  await ensureBrowserStarted()
  const deadline = Date.now() + AUTO_LAUNCH_TIMEOUT_MS
  while (Date.now() < deadline) {
    try {
      return await connectWs()
    } catch (error) {
      lastError = error
      await delay(CONNECT_RETRY_MS)
    }
  }
  throw lastError instanceof Error ? lastError : new Error('无法连接 Aa Browser。')
}

/**
 * 启动即连接（带重试）：桥被 AI 客户端拉起时立刻连上浏览器，
 * 让桌面端"Agent 已连接"指示灯在会话开始时就点亮；
 * 浏览器未启动/正在重启时静默重试，浏览器重启（换端口）后也会自动重连。
 */
const EAGER_CONNECT_RETRY_MS = 5000
function startEagerConnect() {
  const timer = setInterval(() => {
    if (ws && ws.readyState === WebSocket.OPEN) return
    connectWs().catch(() => {
      /* 浏览器未运行等原因：静默等待下一轮重试 */
    })
  }, EAGER_CONNECT_RETRY_MS)
  timer.unref?.()
}

startEagerConnect()

async function callTool(name, args, progressToken) {
  const mcpId = args?.__mcpId
  let socket
  try {
    socket = await getWs()
  } catch (error) {
    if (mcpId !== undefined) cancelledMcpRequests.delete(mcpId)
    throw error
  }
  if (mcpId !== undefined && cancelledMcpRequests.delete(mcpId)) {
    throw new Error('MCP 请求已取消。')
  }
  const cleanArgs = { ...(args ?? {}) }
  delete cleanArgs.__mcpId
  return new Promise((resolve, reject) => {
    const p = {
      id: null,
      name,
      args: cleanArgs,
      progressToken,
      mcpId,
      socket: null,
      resolve,
      reject,
      timer: null
    }
    p.timer = setTimeout(() => {
      const owner = p.socket
      const wireId = p.id
      detachPending(p)
      try {
        if (owner && owner.readyState === WebSocket.OPEN && wireId !== null) {
          owner.send(JSON.stringify({ id: wireId, cancel: true }))
        }
      } catch {}
      reject(new Error(`工具 ${name} 执行超时（${CALL_TIMEOUT_MS / 1000}s）`))
    }, CALL_TIMEOUT_MS)
    // sendPending 在发送前登记 pending / progressToken，避免进度事件先到。
    sendPending(p, socket)
  })
}

/* ──────────────────── MCP stdio 协议 ──────────────────── */

function writeStdioMessage(message) {
  // JSON 允许这两个字符，但有些客户端的逐行读取器会把它们当成换行。
  const json = JSON.stringify(message).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')
  process.stdout.write(`${json}\n`)
}

function send(msg) {
  log('stdio response', msg.id, msg.error ? 'error' : 'result')
  writeStdioMessage(msg)
}

// JSON-RPC 通知（无 id，不需要响应）：进度事件走这里发往 MCP 客户端。
function notify(method, params) {
  writeStdioMessage({ jsonrpc: '2.0', method, params })
}

function rpcResult(id, result) {
  send({ jsonrpc: '2.0', id, result })
}

function rpcError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } })
}

function toolResultForMcp(result) {
  // result: { content: [{type:'text'|'image', ...}], isError? }
  const content = (result?.content ?? []).map((c) => {
    if (c.type === 'image') {
      return { type: 'image', data: c.data, mimeType: c.mimeType || 'image/png' }
    }
    return { type: 'text', text: String(c.text ?? '') }
  })
  return { content, isError: !!result?.isError }
}

function handleStdioLine(line) {
  const s = line.trim()
  if (!s) return
  let msg
  try {
    msg = JSON.parse(s)
  } catch {
    return
  }
  if (msg.jsonrpc !== '2.0') return
  const { id, method, params } = msg
  if (method === 'notifications/cancelled') {
    const requestId = params?.requestId
    const bridgeId = mcpToBridge.get(requestId)
    if (bridgeId !== undefined) {
      // -1 是"仍在等待建立连接"的占位 id；-2 是"已断线、等待重连后重发"的只读调用。
      if (bridgeId === -1) {
        cancelledMcpRequests.add(requestId)
      } else if (bridgeId === -2) {
        for (const p of [...suspended]) {
          if (p.mcpId === requestId) rejectPending(p, new Error('MCP 请求已取消。'))
        }
      } else {
        const p = pending.get(bridgeId)
        if (p) {
          detachPending(p)
          p.reject(new Error('MCP 请求已取消。'))
          try {
            if (p.socket?.readyState === WebSocket.OPEN) p.socket.send(JSON.stringify({ id: bridgeId, cancel: true }))
          } catch {}
        }
      }
      mcpToBridge.delete(requestId)
    }
    return
  }

  // 通知（无 id）
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') return
    if (method === 'notifications/roots/list') return
    return
  }

  switch (method) {
    case 'initialize':
      rpcResult(id, {
        protocolVersion: params?.protocolVersion || '2025-06-18',
        capabilities: { tools: {} },
        serverInfo: { name: 'aa-browser', title: 'Aa Browser', version: VERSION }
      })
      break
    case 'ping':
      rpcResult(id, {})
      break
    case 'tools/list':
      rpcResult(id, {
        tools: TOOL_DEFS.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { title: t.title, ...TOOL_ANNOTATIONS[t.name] }
        }))
      })
      break
    case 'tools/call': {
      const name = params?.name
      const args = params?.arguments ?? {}
      // 只有 string / number 是合法的 progressToken；其它类型一律忽略（当作未提供）。
      const rawProgressToken = params?._meta?.progressToken
      const progressToken = (typeof rawProgressToken === 'string' || typeof rawProgressToken === 'number')
        ? rawProgressToken
        : undefined
      const def = TOOL_DEFS.find((t) => t.name === name)
      if (!def) {
        rpcError(id, -32602, `未知工具: ${name}`)
        break
      }
      // 先在 mcpToBridge 里占位：callTool 可能因为浏览器未运行而在
      // await getWs() 阶段就失败；没有占位时下面的 catch 会把错误静默丢弃，
      // 客户端就永远收不到 tools/call 的响应（DSH 中表现为挂到工具超时）。
      mcpToBridge.set(id, -1)
      callTool(name, { ...args, __mcpId: id }, progressToken)
        .then((result) => {
          if (mcpToBridge.has(id)) {
            mcpToBridge.delete(id)
            rpcResult(id, toolResultForMcp(result))
          }
        })
        .catch((err) => {
          // 无论失败发生在「建立连接」还是「工具执行」，都必须给出响应。
          mcpToBridge.delete(id)
          // 工具级错误按 MCP 规范放在结果里（isError: true）
          rpcResult(id, {
            content: [{ type: 'text', text: String(err?.message ?? err) }],
            isError: true
          })
        })
      break
    }
    case 'resources/list':
      rpcResult(id, { resources: [] })
      break
    case 'prompts/list':
      rpcResult(id, { prompts: [] })
      break
    case 'completion/complete':
      rpcResult(id, { completion: { values: [] } })
      break
    default:
      rpcError(id, -32601, `方法不支持: ${method}`)
  }
}

// MCP stdio 只以 LF 分帧；readline 还会把合法 JSON 字符串里的 U+2028/U+2029 分开。
let stdioBuffer = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (chunk) => {
  stdioBuffer += chunk
  let start = 0
  for (let end = stdioBuffer.indexOf('\n'); end !== -1; end = stdioBuffer.indexOf('\n', start)) {
    handleStdioLine(stdioBuffer.slice(start, end))
    start = end + 1
  }
  stdioBuffer = stdioBuffer.slice(start)
})
process.stdin.on('end', () => {
  if (stdioBuffer) handleStdioLine(stdioBuffer)
  try { ws?.close() } catch {}
  process.exit(0)
})

process.on('SIGINT', () => {
  try { ws?.close() } catch {}
  process.exit(0)
})

log(`stdio MCP bridge started (waiting for client initialize)`)
