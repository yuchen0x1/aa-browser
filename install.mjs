#!/usr/bin/env node
/**
 * Aa Browser 通用安装/接入器（零依赖，单文件可直接分发）。
 *
 * 一条命令完成：下载 → 校验 → 安装 → 启动 → 写入本机 AI 客户端 MCP 配置 → 实际调用
 * browser_tabs 验证。适用于 Windows x64 与 Linux x86_64。
 *
 *   node install.mjs --repo <owner>/<repo> [--verify --json]   # 安装最新 Release 并接入
 *   node install.mjs --connect-only --verify --json             # 已安装/已运行，只写配置并验证
 *   node install.mjs --verify-only                              # 只验证当前连接
 *   node install.mjs --print-config                             # 输出通用 MCP 配置片段
 *   node install.mjs --url <直链> | --from <本地安装包/目录>
 *
 * 选项：
 *   --clients zcode,cursor  只接入指定客户端（默认接入所有检测到的）
 *   --dir <目录>            Windows 安装目录 / Linux AppImage 存放目录
 *   --sha256 <hex>          显式校验安装包 SHA-256（--repo 自动使用 Release digest）
 *   --no-launch             不自动启动浏览器
 *   --json                  机器可读结果（日志改走 stderr）
 *   --yes                   兼容 AI 提示词的无人值守开关（本安装器从不交互提问）
 *
 * 设计目标：可被任意 AI Agent 逐字执行。失败时退出非零并给出原因；绝不静默安装
 * 系统依赖，也绝不把「配置已写入」当成「连接已验证」。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { finished, pipeline } from 'node:stream/promises'
import process from 'node:process'
import { pathToFileURL } from 'node:url'

export const SUPPORTED_PLATFORMS = ['win32', 'linux']
export const CONNECT_FILE_RELATIVE = path.join('.aabrowser', 'connection.json')

/* ──────────────────── 纯函数（可单测） ──────────────────── */

/** 解析命令行；未知位置参数忽略。 */
export function parseArgs(argv) {
  const valueFlags = new Set(['--url', '--repo', '--from', '--clients', '--dir', '--sha256'])
  const options = { positional: [] }
  for (let i = 0; i < argv.length; i++) {
    const item = argv[i]
    if (valueFlags.has(item)) {
      options[item.slice(2)] = argv[++i] ?? ''
    } else if (item.startsWith('--') && item.includes('=')) {
      const [key, ...rest] = item.slice(2).split('=')
      options[key] = rest.join('=')
    } else if (item.startsWith('-')) {
      options[item.replace(/^-+/, '')] = true
    } else {
      options.positional.push(item)
    }
  }
  return options
}

/** 从 GitHub Release assets 中挑选当前平台资产。 */
export function pickReleaseAsset(assets, platform) {
  const list = Array.isArray(assets) ? assets.filter((asset) => asset && typeof asset.name === 'string') : []
  if (platform === 'win32') {
    return list.find((asset) => /setup.*\.exe$/i.test(asset.name)) || list.find((asset) => /\.exe$/i.test(asset.name)) || null
  }
  if (platform === 'linux') return list.find((asset) => /\.AppImage$/i.test(asset.name)) || null
  return null
}

/** Windows 默认安装目录。 */
export function defaultInstallDirFor(platform, env = process.env, home = os.homedir()) {
  if (platform !== 'win32') return null
  const localAppData = env['LOCALAPPDATA'] || path.join(home, 'AppData', 'Local')
  return path.join(localAppData, 'Programs', 'Aa Browser')
}

/** Linux Electron userData 目录（AppImage 运行时会把稳定桥写到这里）。 */
export function linuxUserDataDirFor(env = process.env, home = os.homedir()) {
  const configHome = env['XDG_CONFIG_HOME'] || path.join(home, '.config')
  return path.join(configHome, 'Aa Browser')
}

/** Linux AppImage 稳定路径。 */
export function appImagePathFor(dirArg, home = os.homedir()) {
  const directory = dirArg || path.join(home, 'Applications')
  return path.join(directory, 'AaBrowser.AppImage')
}

/** MCP 桥的稳定绝对路径（客户端配置指向它，随应用升级保持有效）。 */
export function bridgePathFor({ platform, installDir, env = process.env, home = os.homedir() }) {
  if (env['AA_BROWSER_MCP_BRIDGE']) return env['AA_BROWSER_MCP_BRIDGE']
  if (platform === 'win32') {
    return path.join(installDir || defaultInstallDirFor(platform, env, home), 'resources', 'app.asar.unpacked', 'out', 'bridge', 'mcp.cjs')
  }
  if (platform === 'linux') return path.join(linuxUserDataDirFor(env, home), 'mcp', 'bridge.cjs')
  return null
}

/** 校验下载产物：文件头 + 可选 SHA-256。导出以便安全回归直接测试。 */
export async function verifyArtifact(file, expectedDigest, label, { requireDigest = false, platform } = {}) {
  const size = fs.statSync(file).size
  if (!size) throw new Error(`安装包为空：${file}`)
  const head = Buffer.alloc(4)
  const fd = fs.openSync(file, 'r')
  try {
    fs.readSync(fd, head, 0, 4, 0)
  } finally {
    fs.closeSync(fd)
  }
  const linuxArtifact = platform === 'linux' || /\.appimage$/i.test(file)
  if (linuxArtifact) {
    if (!(head[0] === 0x7f && head.subarray(1, 4).toString('latin1') === 'ELF')) {
      throw new Error(`安装包不是有效的 Linux ELF/AppImage 文件：${file}`)
    }
  } else if (head.subarray(0, 2).toString('latin1') !== 'MZ') {
    throw new Error(`安装包不是有效的 Windows 可执行文件（缺少 MZ 头）：${file}`)
  }

  if (!expectedDigest) {
    if (requireDigest) {
      throw new Error(`GitHub Release 未提供可验证的 SHA-256 digest，已中止安装：${label}\n请使用显式 --sha256 指定预期值。`)
    }
    return { digestChecked: false }
  }
  const match = /^(sha256):([0-9a-f]{64})$/i.exec(String(expectedDigest).trim())
  if (!match) throw new Error(`无法识别的 SHA-256 digest 格式（${expectedDigest}），已中止安装：${label}`)
  const { createHash } = await import('node:crypto')
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    fs.createReadStream(file).on('data', (chunk) => hash.update(chunk)).on('end', resolve).on('error', reject)
  })
  const actual = hash.digest('hex')
  if (actual !== match[2].toLowerCase()) {
    throw new Error(`安装包哈希校验失败：${label}\n  预期 sha256:${match[2]}\n  实际 sha256:${actual}\n可能被篡改或下载不完整，已中止安装。`)
  }
  return { digestChecked: true, digest: actual }
}

/* ──────────────────── 运行期辅助 ──────────────────── */

const HOME = os.homedir()
const CONNECT_FILE = process.env['AA_BROWSER_CONNECTION_FILE'] || path.join(HOME, CONNECT_FILE_RELATIVE)

function pidAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function readConnection() {
  try {
    const info = JSON.parse(fs.readFileSync(CONNECT_FILE, 'utf-8'))
    if (info && info.pid && pidAlive(info.pid) && info.port && info.token) return info
    return null
  } catch {
    return null
  }
}

async function downloadTo(url, dest, log) {
  log(`⬇️  下载 ${url}`)
  const res = await fetch(url, { redirect: 'follow', headers: { 'User-Agent': 'aa-browser-installer' } })
  if (!res.ok || !res.body) throw new Error(`下载失败: HTTP ${res.status}（检查地址是否有效/可公开访问）`)
  const total = Number(res.headers.get('content-length') || 0)
  let got = 0
  let lastPct = -1
  const out = fs.createWriteStream(dest)
  await pipeline(
    Readable.fromWeb(res.body),
    async function* (source) {
      for await (const chunk of source) {
        got += chunk.length
        if (total) {
          const pct = Math.floor((got / total) * 100)
          if (pct >= lastPct + 20) {
            lastPct = pct
            log(`   ${pct}% (${Math.round(got / 1048576)}MB)`)
          }
        }
        if (!out.write(chunk)) await new Promise((resolve) => out.once('drain', resolve))
      }
      await new Promise((resolve) => out.end(resolve))
    }
  )
  log(`✅ 下载完成: ${dest} (${Math.round(got / 1048576)}MB)`)
}

function publicAaBrowserReleaseAsset(input) {
  try {
    const url = new URL(input)
    if (url.protocol !== 'https:' || url.hostname !== 'github.com' || (url.port && url.port !== '443') || url.username || url.password || url.search || url.hash) return null
    const pathname = decodeURIComponent(url.pathname)
    const match = /^\/yuchen0x1\/aa-browser\/releases\/download\/(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\/(aa-browser-setup-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.exe|aa-browser-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-linux-x86_64\.AppImage)$/.exec(pathname)
    return match ? { url, tag: match[1], name: match[2] } : null
  } catch {
    return null
  }
}

const SAFE_RELEASE_REDIRECT_HOSTS = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'gh-proxy.org',
  'gh-proxy.com',
  'ghproxy.net'
])

async function streamReleaseBody(body, destination, offset, size, controller, onProgress) {
  const output = fs.createWriteStream(destination, { flags: offset ? 'a' : 'w', mode: 0o600 })
  const completion = finished(output)
  completion.catch(() => {})
  const reader = body.getReader()
  let received = 0
  let transferError = null
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      const chunk = Buffer.from(value)
      received += chunk.length
      if (offset + received > size) throw new Error('下载文件超过 GitHub Release 声明大小，已中止。')
      onProgress(chunk.length, received)
      if (!output.write(chunk)) {
        await Promise.race([
          new Promise((resolve) => output.once('drain', resolve)),
          completion.then(() => { throw new Error('安装包临时文件提前关闭') })
        ])
      }
    }
  } catch (error) {
    transferError = error
    controller.abort(error)
    await reader.cancel().catch(() => {})
  }
  output.end()
  try {
    await completion
  } catch (error) {
    transferError ??= error
  }
  if (transferError) throw transferError
  return received
}

async function fetchReleaseRoute(input, headers, signal, allowedHosts = SAFE_RELEASE_REDIRECT_HOSTS) {
  let current = new URL(input)
  for (let redirects = 0; redirects <= 8; redirects++) {
    const response = await fetch(current, {
      headers,
      signal,
      redirect: 'manual',
      credentials: 'omit',
      cache: 'no-store'
    })
    if (response.status < 300 || response.status >= 400) return response
    const location = response.headers.get('location')
    await response.body?.cancel()
    if (!location || redirects === 8) throw new Error('Release server returned too many redirects')
    const next = new URL(location, current)
    if (
      next.protocol !== 'https:' ||
      (next.port && next.port !== '443') ||
      next.username ||
      next.password ||
      !allowedHosts.has(next.hostname.toLowerCase())
    ) throw new Error('Release server returned an unsafe redirect')
    current = next
  }
  throw new Error('Release server returned too many redirects')
}

async function fetchReleaseRouteWithTimeout(input, headers, controller, allowedHosts = SAFE_RELEASE_REDIRECT_HOSTS) {
  const connectTimer = setTimeout(
    () => controller.abort(new Error('Release connection timed out')),
    20_000
  )
  try {
    return await fetchReleaseRoute(input, headers, controller.signal, allowedHosts)
  } finally {
    clearTimeout(connectTimer)
  }
}

export async function downloadPublicReleaseAsset(resolved, dest, log, platform) {
  const asset = publicAaBrowserReleaseAsset(resolved.url)
  if (!asset || resolved.name !== asset.name || resolved.tag !== asset.tag) {
    await downloadTo(resolved.url, dest, log)
    return
  }
  if (!Number.isSafeInteger(resolved.size) || resolved.size <= 0 || resolved.size > 1024 * 1024 * 1024) {
    throw new Error('GitHub Release 未提供有效的安装包大小，已中止下载。')
  }
  if (!/^sha256:[a-f0-9]{64}$/i.test(resolved.digest || '')) {
    throw new Error('GitHub Release 未提供可信 SHA-256 digest，已中止下载。')
  }

  const routes = [
    { id: 'GitHub', url: asset.url.href },
    { id: 'GH-Proxy', url: `https://gh-proxy.org/${asset.url.href}` },
    { id: 'GH-Proxy backup', url: `https://gh-proxy.com/${asset.url.href}` },
    { id: 'ghproxy.net backup', url: `https://ghproxy.net/${asset.url.href}` }
  ]
  const failures = []
  for (const route of routes) {
    let controller = null
    let watchdog = null
    try {
      log(`⬇️  正在尝试 ${route.id} 下载 ${asset.name}`)
      let offset = fs.existsSync(dest) ? fs.statSync(dest).size : 0
      if (offset > resolved.size) {
        fs.rmSync(dest, { force: true })
        offset = 0
      }

      controller = new AbortController()
      let response = await fetchReleaseRouteWithTimeout(
        route.url,
        offset ? { Range: `bytes=${offset}-` } : {},
        controller
      )

      if (response.status === 416 && offset > 0) {
        await response.body?.cancel()
        fs.rmSync(dest, { force: true })
        offset = 0
        controller = new AbortController()
        response = await fetchReleaseRouteWithTimeout(route.url, {}, controller)
      }
      if (response.status !== 200 && response.status !== 206) {
        await response.body?.cancel()
        throw new Error(`HTTP ${response.status}`)
      }
      if (response.status === 200) offset = 0
      else {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '')
        if (!range || Number(range[1]) !== offset || Number(range[3]) !== resolved.size) {
          await response.body?.cancel()
          throw new Error('Content-Range does not match the trusted Release size')
        }
      }
      const contentLength = response.headers.get('content-length')
      if (contentLength != null && (!/^\d+$/.test(contentLength) || Number(contentLength) > resolved.size - offset)) {
        await response.body?.cancel()
        throw new Error('Content-Length does not match the trusted Release size')
      }
      if (response.status === 206 && contentLength != null) {
        const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(response.headers.get('content-range') || '')
        if (range && Number(contentLength) !== Number(range[2]) - offset + 1) {
          await response.body?.cancel()
          throw new Error('Content-Length does not match the returned byte range')
        }
      }
      if (!response.body) throw new Error('Release server returned an empty response')

      let received = 0
      let windowReceived = 0
      let startedAt = Date.now()
      let windowStartedAt = startedAt
      let slowWindows = 0
      let lastPct = -1
      watchdog = setInterval(() => {
        if (Date.now() - startedAt > 45 * 60_000 || Date.now() - windowStartedAt > 20_000 && windowReceived === 0) {
          controller.abort(new Error('Release transfer timed out'))
        }
      }, 1000)
      received = await streamReleaseBody(response.body, dest, offset, resolved.size, controller, (chunkSize, transferred) => {
        windowReceived += chunkSize
        const percent = Math.floor(((offset + transferred) / resolved.size) * 100)
        if (percent >= lastPct + 20) {
          lastPct = percent
          log(`   ${percent}% (${Math.round((offset + transferred) / 1048576)}MB)`)
        }
        const now = Date.now()
        if (now - startedAt >= 10_000 && now - windowStartedAt >= 4_000) {
          const speed = windowReceived / Math.max(0.001, (now - windowStartedAt) / 1000)
          slowWindows = speed < 48 * 1024 ? slowWindows + 1 : 0
          if (slowWindows >= 2) throw new Error('下载速度持续低于 48 KiB/s')
          windowReceived = 0
          windowStartedAt = now
        }
      })
      clearInterval(watchdog)
      watchdog = null
      const downloadedSize = fs.statSync(dest).size
      if (downloadedSize < resolved.size) throw new Error('Release transfer ended before the trusted asset size')
      if (downloadedSize > resolved.size) {
        fs.rmSync(dest, { force: true })
        throw new Error('Release asset is larger than the trusted size')
      }
      await verifyArtifact(dest, resolved.digest, asset.name, { requireDigest: true, platform })
      log(`✅ 下载完成: ${dest} (${Math.round(downloadedSize / 1048576)}MB)`)
      return
    } catch (error) {
      if (watchdog) clearInterval(watchdog)
      controller?.abort()
      if (fs.existsSync(dest) && fs.statSync(dest).size > resolved.size) fs.rmSync(dest, { force: true })
      const message = error instanceof Error ? error.message : String(error)
      failures.push(`${route.id}: ${message.slice(0, 180)}`)
      log(`   ${route.id} 失败，正在切换备用线路`)
    }
  }
  throw new Error(`所有 GitHub Release 下载线路均失败：${failures.join('；')}`)
}

async function resolveFromRepo(repo, platform) {
  const api = `https://api.github.com/repos/${repo}/releases/latest`
  const res = await fetch(api, {
    headers: { 'User-Agent': 'aa-browser-installer', Accept: 'application/vnd.github+json' }
  })
  if (!res.ok) throw new Error(`查询 GitHub Releases 失败: HTTP ${res.status}（确认仓库存在且已发布 Release）`)
  const data = await res.json()
  const asset = pickReleaseAsset(data.assets, platform)
  if (!asset) throw new Error(`Release ${data.tag_name ?? ''} 中没有适用于 ${platform} 的安装包`)
  return { url: asset['browser_download_url'], digest: asset.digest, name: asset.name, tag: data.tag_name, size: asset.size }
}

function appExeFor(installDir) {
  return path.join(installDir, 'Aa Browser.exe')
}

function findWindowsInstallDir(dirArg, env = process.env) {
  const candidates = []
  if (dirArg) candidates.push(dirArg)
  const defaults = defaultInstallDirFor('win32', env)
  if (defaults) candidates.push(defaults)
  if (env['ProgramFiles']) candidates.push(path.join(env['ProgramFiles'], 'Aa Browser'))
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(appExeFor(candidate))) return candidate
    } catch {
      /* 继续找 */
    }
  }
  return null
}

function findLinuxAppImage(dirArg, env = process.env, home = HOME) {
  const direct = dirArg && fs.existsSync(dirArg) && !fs.statSync(dirArg).isDirectory() ? dirArg : null
  const candidates = [direct, appImagePathFor(dirArg, home)].filter(Boolean)
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      /* 继续找 */
    }
  }
  return null
}

function findSetupScript(installDir) {
  const candidates = [
    path.join(installDir, 'resources', 'app.asar.unpacked', 'cli', 'setup.mjs'),
    path.join(installDir, 'cli', 'setup.mjs'),
    path.join(installDir, 'resources', 'cli', 'setup.mjs')
  ]
  return candidates.find((candidate) => fs.existsSync(candidate)) || null
}

function extractAppImage(appImagePath) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-browser-extract-'))
  try {
    // Execute a fixed-name copy rather than a user-supplied path. The AppImage
    // runtime only needs the file itself; extracting the fixed copy keeps the
    // command line independent from --from/--dir input.
    const staged = path.join(tmp, 'aa-browser.AppImage')
    fs.copyFileSync(appImagePath, staged)
    fs.chmodSync(staged, 0o755)
    const result = spawnSync(staged, ['--appimage-extract'], { cwd: tmp, encoding: 'utf8', timeout: 180000 })
    if (result.status !== 0) return null
    const root = path.join(tmp, 'squashfs-root')
    if (!fs.existsSync(root)) return null
    return {
      root,
      bridge: path.join(root, 'resources', 'app.asar.unpacked', 'out', 'bridge', 'mcp.cjs'),
      setup: path.join(root, 'resources', 'app.asar.unpacked', 'cli', 'setup.mjs'),
      cleanup: () => { try { fs.rmSync(tmp, { recursive: true, force: true }) } catch { /* 忽略 */ } }
    }
  } catch {
    return null
  }
}

/**
 * Start an installed application detached without using the user-supplied
 * executable path as the spawn command. A fixed Node one-liner receives the
 * path as an argument, so the command line stays static.
 */
function launchDetached(target) {
  // The launcher strips ELECTRON_RUN_AS_NODE: if the installer itself was
  // started through an Electron runtime, the GUI app must not inherit that
  // Node-only mode.
  const launcherCode = [
    "const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;",
    "require('node:child_process').spawn(process.argv[1],[],{detached:true,stdio:'ignore',env,windowsHide:true}).unref();"
  ].join('')
  spawn(process.execPath, ['-e', launcherCode, target], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
}

async function waitForConnection({ launch, noLaunch, log, timeoutMs = 60000 }) {
  const deadline = Date.now() + timeoutMs
  const started = Date.now()
  let launched = false
  while (Date.now() < deadline) {
    const connection = readConnection()
    if (connection) return connection
    if (!noLaunch && !launched && launch && Date.now() - started > 3000) {
      try {
        launch()
        launched = true
      } catch {
        /* 拉起失败则继续轮询 */
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
  return null
}

async function verifyBrowserTabs(connection) {
  if (typeof WebSocket !== 'function') {
    throw new Error('当前 Node.js 不支持 WebSocket（需要 Node.js 22.12+），无法执行 browser_tabs 验证')
  }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { socket.close() } catch { /* 忽略 */ }
      reject(new Error('验证超时：15 秒内没有收到 browser_tabs 响应'))
    }, 15000)
    let socket
    try {
      socket = new WebSocket(`ws://127.0.0.1:${connection.port}/?token=${encodeURIComponent(connection.token)}`)
    } catch (error) {
      clearTimeout(timer)
      reject(error)
      return
    }
    socket.onopen = () => {
      socket.send(JSON.stringify({ id: 1, tool: 'browser_tabs', args: { action: 'list' } }))
    }
    socket.onmessage = (event) => {
      let message
      try {
        message = JSON.parse(String(event.data))
      } catch {
        return
      }
      if (message.id !== 1) return
      clearTimeout(timer)
      try { socket.close() } catch { /* 忽略 */ }
      if (!message.ok) {
        reject(new Error(`browser_tabs 调用失败：${message.error || '未知错误'}`))
        return
      }
      const content = (message.result?.content ?? []).filter((item) => item?.type === 'text').map((item) => item.text).join('\n')
      resolve({ text: content, toolCount: undefined })
    }
    socket.onerror = () => {
      clearTimeout(timer)
      reject(new Error('无法连接 Aa Browser 本地 Agent 服务（WebSocket）。确认浏览器仍在运行。'))
    }
  })
}

function runSetup(setupPath, bridge, clients, log, json = false) {
  if (!setupPath) throw new Error('找不到 cli/setup.mjs，无法写入客户端配置（安装包可能不完整）')
  log(`\n🔌 写入 AI 客户端 MCP 配置（${clients ? `指定: ${clients}` : '所有检测到的'}）…`)
  const cliArgs = ['--yes']
  if (clients) cliArgs.push('--client', clients)
  const env = { ...process.env, AA_BROWSER_MCP_BRIDGE: bridge }
  const result = spawnSync(process.execPath, [setupPath, ...cliArgs], {
    stdio: json ? ['ignore', 2, 2] : 'inherit',
    env,
    timeout: 120000
  })
  if (result.status !== 0) throw new Error('MCP 配置写入失败（见上方输出）')
}

function configEntry(bridge, env = process.env) {
  const entry = { command: process.execPath, args: [bridge] }
  if (process.versions.electron) entry.env = { ELECTRON_RUN_AS_NODE: '1' }
  return { mcpServers: { 'aa-browser': entry } }
}

/* ──────────────────── 主流程 ──────────────────── */

function usage() {
  console.log('Aa Browser 安装器 —— 下载 → 校验 → 安装/接入 → 验证')
  console.log('')
  console.log('用法:')
  console.log('  node install.mjs --repo <owner>/<repo> [--verify] [--json]')
  console.log('  node install.mjs --connect-only [--verify] [--json]   # 已安装，只写配置')
  console.log('  node install.mjs --verify-only                        # 只验证当前连接')
  console.log('  node install.mjs --print-config                       # 输出通用 MCP 配置')
  console.log('  node install.mjs --url <安装包直链或本地路径> | --from <本地路径>')
  console.log('')
  console.log('选项: --clients zcode,cursor,workbuddy | --dir <目录> | --no-launch')
  console.log('      --sha256 <hex>  显式校验安装包 SHA-256')
  console.log('      --json          机器可读结果（日志改走 stderr）')
  console.log('')
  console.log('支持平台: Windows x64、Linux x86_64。其他平台会明确拒绝。')
}

// 版本号在不同来源里可能已经带 v（例如 GitHub tag v0.11.0），
// 展示时统一只加一次前缀。
const versionLabel = (value) => `v${String(value ?? '').replace(/^v/i, '')}`

async function main(argv) {
  const options = parseArgs(argv)
  const json = options.json === true
  // --print-config 的 stdout 必须是纯 JSON，人类日志一律走 stderr。
  const machineOutput = json || options['print-config'] === true
  const log = machineOutput ? (...args) => console.error(...args) : (...args) => console.log(...args)
  const report = {
    ok: false,
    platform: process.platform,
    arch: process.arch,
    version: null,
    installDir: null,
    bridge: null,
    clients: null,
    verified: false,
    error: null,
    actions: []
  }
  const emit = () => {
    if (json) process.stdout.write(`${JSON.stringify({ ...report, actions: [...report.actions] })}\n`)
  }
  const die = (error) => {
    const message = error instanceof Error ? error.message : String(error)
    report.error = message
    console.error(`❌ ${message}`)
    emit()
    process.exit(1)
  }

  let extracted = null

  try {
    if (options.help || options.h) {
      usage()
      return
    }
    const platform = process.platform
    if (!SUPPORTED_PLATFORMS.includes(platform)) {
      die(new Error(`当前平台 ${platform}/${process.arch} 暂无官方安装包。官方支持 Windows x64 与 Linux x86_64；macOS/ARM 请等待后续版本，不要强行安装。`))
    }
    log(`平台: ${platform} ${process.arch} · Node ${process.version}`)

    if (options['verify-only']) {
      const connection = readConnection()
      if (!connection) die(new Error('没有检测到运行中的 Aa Browser（~/.aabrowser/connection.json）。请先启动浏览器。'))
      report.version = connection.version
      const result = await verifyBrowserTabs(connection)
      report.verified = true
      report.ok = true
      log(`✅ browser_tabs 验证通过（Aa Browser ${versionLabel(connection.version)}）`)
      log(result.text || '（未返回文本内容）')
      emit()
      return
    }

    if (options['print-config']) {
      const installDir = platform === 'win32' ? findWindowsInstallDir(options.dir) : null
      const appImage = platform === 'linux' ? findLinuxAppImage(options.dir) : null
      if (platform === 'win32' && !installDir) die(new Error('未找到已安装的 Aa Browser，无法生成配置。请先运行安装（--repo）。'))
      if (platform === 'linux' && !appImage && !process.env['AA_BROWSER_MCP_BRIDGE']) {
        die(new Error('未找到 Aa Browser AppImage，且未设置 AA_BROWSER_MCP_BRIDGE，无法生成配置。'))
      }
      const bridge = bridgePathFor({ platform, installDir })
      report.installDir = installDir
      report.bridge = bridge
      report.ok = true
      console.log(JSON.stringify(configEntry(bridge), null, 2))
      return
    }

    let connection = readConnection()
    let installDir = null
    let appImage = null

    if (options['connect-only']) {
      if (platform === 'win32') {
        installDir = findWindowsInstallDir(options.dir)
        if (!installDir) die(new Error('未找到已安装的 Aa Browser（可用 --dir 指定安装目录）。请先运行安装，或去掉 --connect-only。'))
      } else {
        appImage = findLinuxAppImage(options.dir)
        if (!appImage && !fs.existsSync(path.join(linuxUserDataDirFor(), 'mcp', 'bridge.cjs'))) {
          die(new Error('未找到已安装的 Aa Browser AppImage（可用 --dir 指定位置）。请先运行安装。'))
        }
      }
      report.actions.push('connect-only: skipped download and installation')
      if (!connection) {
        log('⏳ Aa Browser 未运行，正在尝试启动…')
        const launchTarget = platform === 'win32' ? appExeFor(installDir) : appImage
        connection = await waitForConnection({
          noLaunch: options['no-launch'] === true,
          launch: () => launchDetached(launchTarget),
          log
        })
        if (!connection) die(new Error('60 秒内未检测到运行中的 Aa Browser。请手动打开浏览器后重试。'))
      }
    } else {
      let artifact
      let expectedDigest = null
      if (options.from) {
        artifact = path.resolve(options.from)
        if (!fs.existsSync(artifact)) die(new Error(`--from 路径不存在: ${artifact}`))
      } else if (options.url && /^[a-z]+:\/\//i.test(options.url)) {
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-browser-'))
        artifact = path.join(tmp, path.basename(new URL(options.url).pathname) || 'aa-browser-setup.exe')
        await downloadTo(options.url, artifact, log)
      } else if (options.url && fs.existsSync(options.url)) {
        artifact = path.resolve(options.url)
      } else if (options.repo) {
        const resolved = await resolveFromRepo(options.repo, platform)
        expectedDigest = resolved.digest ?? null
        const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-browser-'))
        artifact = path.join(tmp, resolved.name || (platform === 'linux' ? 'aa-browser.AppImage' : 'aa-browser-setup.exe'))
        await downloadPublicReleaseAsset(resolved, artifact, log, platform)
        report.version = resolved.tag ?? null
      } else {
        die(new Error('请提供 --repo / --connect-only / --url / --from 之一（--help 查看用法）'))
        return
      }

      if (fs.statSync(artifact).isDirectory()) {
        if (platform !== 'win32') die(new Error('便携目录模式仅支持 Windows（win-unpacked）。Linux 请使用 AppImage。'))
        installDir = artifact
        if (!fs.existsSync(appExeFor(installDir))) die(new Error('目录中没有 Aa Browser.exe（便携模式需要 win-unpacked 解压目录）'))
        log(`\n📁 便携模式：直接使用目录 ${installDir}`)
      } else {
        const digestToUse = options.sha256 ? `sha256:${String(options.sha256).trim()}` : expectedDigest
        const verification = await verifyArtifact(artifact, digestToUse, artifact, {
          requireDigest: Boolean(options.repo && !options.sha256),
          platform
        })
        if (verification.digestChecked) log(`🔒 已校验 SHA-256: ${verification.digest.slice(0, 16)}…`)

        if (platform === 'win32') {
          installDir = options.dir || defaultInstallDirFor('win32')
          log('\n📦 静默安装中（约 10-30 秒）…')
          // Execute a fixed-name copy: the command line no longer depends on the
          // user-supplied or downloaded artifact path.
          const stagingDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-browser-install-'))
          const stagedInstaller = path.join(stagingDir, 'aa-browser-setup.exe')
          try {
            fs.copyFileSync(artifact, stagedInstaller)
            const result = spawnSync(stagedInstaller, ['/S'], { timeout: 180000 })
            if (result.status !== 0 && !fs.existsSync(appExeFor(installDir))) {
              die(new Error(`安装器退出码 ${result.status}，且未检测到安装目录 ${installDir}`))
            }
          } finally {
            try { fs.rmSync(stagingDir, { recursive: true, force: true }) } catch { /* 忽略 */ }
          }
          report.actions.push('installed Windows NSIS package')
        } else {
          appImage = appImagePathFor(options.dir)
          fs.mkdirSync(path.dirname(appImage), { recursive: true })
          fs.copyFileSync(artifact, appImage)
          fs.chmodSync(appImage, 0o755)
          report.actions.push('installed Linux AppImage')
          log(`\n📦 已安装 AppImage: ${appImage}`)
        }
      }

      report.installDir = installDir || path.dirname(appImage)
      if (!connection) {
        log('⏳ 等待 Aa Browser 就绪…')
        const launchTarget = platform === 'win32' ? appExeFor(installDir) : appImage
        connection = await waitForConnection({
          noLaunch: options['no-launch'] === true,
          launch: () => launchDetached(launchTarget),
          log
        })
        if (!connection) die(new Error('60 秒内未检测到 Aa Browser 就绪（~/.aabrowser/connection.json）'))
      }
    }

    report.version = report.version || connection.version
    report.installDir = report.installDir || (platform === 'win32' ? installDir : appImage ? path.dirname(appImage) : null)
    log(`✅ Aa Browser 已就绪 (${versionLabel(connection.version)}, ws://127.0.0.1:${connection.port})`)

    let bridge = bridgePathFor({ platform, installDir })
    if (platform === 'linux') {
      // AppImage 运行时会把桥写到稳定的 userData 路径；也允许从 AppImage 解包兜底。
      if (!fs.existsSync(bridge) && appImage) {
        extracted = extractAppImage(appImage)
        if (extracted && fs.existsSync(extracted.bridge)) {
          fs.mkdirSync(path.dirname(bridge), { recursive: true })
          fs.copyFileSync(extracted.bridge, bridge)
        }
      }
    }
    if (!fs.existsSync(bridge)) die(new Error(`找不到 MCP 桥文件：${bridge}。安装可能不完整。`))
    report.bridge = bridge

    let setupPath = platform === 'win32' ? findSetupScript(installDir || (options.dir || '')) : null
    if (!setupPath && appImage) {
      extracted = extracted || extractAppImage(appImage)
      setupPath = extracted && fs.existsSync(extracted.setup) ? extracted.setup : null
    }
    if (!setupPath && options.repo) {
      const raw = `https://raw.githubusercontent.com/${options.repo}/main/cli/setup.mjs`
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-browser-setup-'))
      setupPath = path.join(tmp, 'setup.mjs')
      log(`⬇️  下载客户端配置脚本 ${raw}`)
      const res = await fetch(raw, { headers: { 'User-Agent': 'aa-browser-installer' } })
      if (!res.ok) die(new Error(`下载 setup.mjs 失败: HTTP ${res.status}`))
      fs.writeFileSync(setupPath, Buffer.from(await res.arrayBuffer()))
    }
    runSetup(setupPath, bridge, options.clients, log, json)
    report.clients = options.clients || 'auto-detected'
    report.actions.push('wrote MCP configuration for detected clients')

    if (options.verify) {
      log('\n🔎 实际调用 browser_tabs 验证…')
      const result = await verifyBrowserTabs(connection)
      report.verified = true
      log(`✅ 验证通过：${(result.text || '').split('\n')[0] || 'browser_tabs 返回成功'}`)
      log(result.text || '')
    }

    report.ok = true
    log('')
    log('🎉 安装与接入完成！')
    log(`   版本    : ${versionLabel(report.version)}`)
    log(`   安装位置: ${report.installDir}`)
    log(`   MCP 桥  : ${bridge}`)
    log(`   配置备份: 各客户端目录下的 *.aa-backup-* 文件`)
    log('   下一步  : 重启/重载 AI 客户端，实际调用 browser_tabs 确认工具已加载')
    log('   自动更新: Aa Browser 通过 GitHub Releases 自动更新；升级后配置一般无需重写')
    emit()
  } catch (error) {
    die(error)
  } finally {
    if (extracted?.cleanup) extracted.cleanup()
  }
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href
if (isMain) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(`❌ ${error instanceof Error ? error.stack ?? error.message : String(error)}`)
    process.exit(1)
  })
}

export { main }
