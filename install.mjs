#!/usr/bin/env node
/**
 * Aa Browser 通用安装器（零依赖，单文件可直接分发）。
 *
 * 复制一条命令即可完成：下载 → 静默安装 → 启动 → 自动写入本机 AI 客户端的 MCP 配置。
 *
 *   node install.mjs --url  <安装包直链或本地路径>   [选项]
 *   node install.mjs --repo <owner>/<repo>           # 自动取 GitHub Releases 最新安装包
 *   node install.mjs --from <本地安装包或目录>
 *
 * 选项：
 *   --clients zcode,cursor   只接入指定客户端（默认接入所有检测到的）
 *   --dir <路径>             自定义安装目录检测位置（默认 %LOCALAPPDATA%/Programs/Aa Browser）
 *   --no-launch              安装后不自动启动浏览器
 *
 * 设计为可被 AI Agent 逐字执行：失败即退出非零码并给出原因。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import process from 'node:process'

const HOME = os.homedir()
const CONNECT_FILE = path.join(HOME, '.aabrowser', 'connection.json')
const CLIENT_IDS = ['zcode', 'claude', 'cursor', 'windsurf', 'cline', 'vscode', 'gemini', 'qwen', 'workbuddy']

const args = process.argv.slice(2)
const argOf = (name) => {
  const i = args.indexOf(name)
  return i !== -1 ? args[i + 1] : undefined
}
const has = (name) => args.includes(name)
const URL_ARG = argOf('--url')
const REPO = argOf('--repo')
const FROM = argOf('--from')
const CLIENTS = argOf('--clients')
const CUSTOM_DIR = argOf('--dir')
const NO_LAUNCH = has('--no-launch')
const SHA256_ARG = argOf('--sha256')
const HELP = has('--help') || has('-h')

const log = (...a) => console.log(...a)
const die = (msg) => {
  console.error('❌ ' + msg)
  process.exit(1)
}

if (HELP || (!URL_ARG && !REPO && !FROM)) {
  log('Aa Browser 安装器 —— 下载 → 静默安装 → 启动 → 自动接入 AI 客户端')
  log('')
  log('用法:')
  log('  node install.mjs --url  <安装包直链或本地路径>')
  log('  node install.mjs --repo <owner>/<repo>      # 从 GitHub Releases 取最新版')
  log('  node install.mjs --from <本地安装包/目录>')
  log('选项: --clients zcode,cursor,workbuddy  |  --dir <安装目录>  |  --no-launch')
  log('      --sha256 <hex>  下载后校验安装包 SHA-256（--repo 会自动使用 Release digest）')
  process.exit(HELP ? 0 : 1)
}

const isWin = process.platform === 'win32'

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
    if (info.pid && pidAlive(info.pid)) return info
    return null
  } catch {
    return null
  }
}

async function downloadTo(url, dest) {
  log(`⬇️  下载 ${url}`)
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) die(`下载失败: HTTP ${res.status}（检查地址是否有效/可公开访问）`)
  const total = Number(res.headers.get('content-length') || 0)
  let got = 0
  let lastPct = -1
  await pipeline(
    Readable.fromWeb(res.body),
    async function* (src) {
      const fsStream = (await import('node:fs')).createWriteStream(dest)
      for await (const chunk of src) {
        got += chunk.length
        if (total) {
          const pct = Math.floor((got / total) * 100)
          if (pct >= lastPct + 10) {
            lastPct = pct
            log(`   ${pct}% (${Math.round(got / 1048576)}MB)`)
          }
        }
        if (!fsStream.write(chunk)) await new Promise((r) => fsStream.once('drain', r))
      }
      await new Promise((r) => fsStream.end(r))
    }
  )
  log(`✅ 下载完成: ${dest} (${Math.round(got / 1048576)}MB)`)
}

async function resolveFromRepo(repo) {
  const api = `https://api.github.com/repos/${repo}/releases/latest`
  const res = await fetch(api, {
    headers: { 'User-Agent': 'aa-browser-installer', Accept: 'application/vnd.github+json' }
  })
  if (!res.ok) die(`查询 GitHub Releases 失败: HTTP ${res.status}（确认仓库存在且已发布 Release）`)
  const data = await res.json()
  const asset = (data.assets || []).find((a) => /setup.*\.exe$/i.test(a.name)) ||
    (data.assets || []).find((a) => a.name.endsWith('.exe'))
  if (!asset) die(`Release ${data.tag_name ?? ''} 中没有 .exe 安装包`)
  log(`找到最新版: ${data.tag_name} → ${asset.name}`)
  return { url: asset['browser_download_url'], digest: asset.digest, name: asset.name }
}

/**
 * 校验下载的安装包。
 *
 * 安装器会被 AI Agent 逐字执行，而包体来自网络：没有校验就无法区分
 * "官方资产"和"被替换/被中间人篡改的 exe"。GitHub Release API 会给出
 * 形如 `sha256:<hex>` 的 digest，有则必须匹配；没有 digest 时至少
 * 校验文件非空且是 PE 可执行文件头，并明确告警。
 */
async function verifyArtifact(file, expectedDigest, label) {
  const size = fs.statSync(file).size
  if (!size) die(`安装包为空：${file}`)
  const head = Buffer.alloc(2)
  const fd = fs.openSync(file, 'r')
  try {
    fs.readSync(fd, head, 0, 2, 0)
  } finally {
    fs.closeSync(fd)
  }
  if (head.toString('latin1') !== 'MZ') die(`安装包不是有效的 Windows 可执行文件（缺少 MZ 头）：${file}`)

  if (!expectedDigest) {
    log('⚠️  Release 未提供 digest，仅完成格式与大小校验；如需严格校验请用 --sha256 指定预期值。')
    return
  }
  const m = /^(sha256):([0-9a-f]{64})$/i.exec(String(expectedDigest).trim())
  if (!m) {
    log(`⚠️  无法识别的 digest 格式（${expectedDigest}），跳过哈希校验。`)
    return
  }
  const { createHash } = await import('node:crypto')
  const hash = createHash('sha256')
  await new Promise((resolve, reject) => {
    fs.createReadStream(file)
      .on('data', (c) => hash.update(c))
      .on('end', resolve)
      .on('error', reject)
  })
  const actual = hash.digest('hex')
  if (actual !== m[2].toLowerCase()) {
    die(`安装包哈希校验失败：${label}\n  预期 sha256:${m[2]}\n  实际 sha256:${actual}\n可能被篡改或下载不完整，已中止安装。`)
  }
  log(`🔒 已校验 SHA-256: ${actual.slice(0, 16)}…`)
}

function defaultInstallDir() {
  if (!isWin) die('当前版本安装包仅支持 Windows；macOS/Linux 请用源码安装：git clone → npm install → npm run build → node cli/setup.mjs')
  return CUSTOM_DIR || path.join(process.env['LOCALAPPDATA'] || path.join(HOME, 'AppData', 'Local'), 'Programs', 'Aa Browser')
}

function findSetupScript(installDir) {
  const candidates = [
    path.join(installDir, 'resources', 'app.asar.unpacked', 'cli', 'setup.mjs'),
    path.join(installDir, 'cli', 'setup.mjs'),
    path.join(installDir, 'resources', 'cli', 'setup.mjs')
  ]
  for (const c of candidates) if (fs.existsSync(c)) return c
  die(`安装目录里找不到 cli/setup.mjs（查找过 ${candidates.join(' , ')}）——安装包可能不完整`)
}

function findAppExe(installDir) {
  const exe = path.join(installDir, 'Aa Browser.exe')
  if (!fs.existsSync(exe)) die(`未找到 ${exe} —— 安装似乎未完成`)
  return exe
}

const appExeExists = (dir) => fs.existsSync(path.join(dir, 'Aa Browser.exe'))

function runSetup(setupPath, appExe) {
  const cliArgs = ['--yes']
  if (CLIENTS) cliArgs.push('--client', CLIENTS)
  // 优先系统 node；没有就用 Aa Browser 本体（ELECTRON_RUN_AS_NODE）
  let node = 'node'
  const probe = spawnSync('node', ['--version'], { encoding: 'utf-8', timeout: 8000 })
  if (!(probe.status === 0 && /^v\d/.test((probe.stdout || '').trim()))) {
    node = appExe
    log('（未检测到系统 Node，使用 Aa Browser 内置运行时执行配置）')
  }
  const env = node === appExe ? { ...process.env, ELECTRON_RUN_AS_NODE: '1' } : { ...process.env }
  log(`\n🔌 写入 AI 客户端 MCP 配置（${CLIENTS ? '指定: ' + CLIENTS : '所有检测到的'}）…`)
  // 不经过 shell：安装路径含空格（...\Programs\Aa Browser\...）也能正确传参
  const r = spawnSync(node, [setupPath, ...cliArgs], { stdio: 'inherit', env, timeout: 120000 })
  if (r.status !== 0) die('MCP 配置写入失败（见上方输出）')
}

async function main() {
  const t0 = Date.now()

  // 1. 取得安装包
  let artifact
  let expectedDigest = null
  if (FROM) {
    artifact = path.resolve(FROM)
    if (!fs.existsSync(artifact)) die(`--from 路径不存在: ${artifact}`)
  } else if (URL_ARG && /^[a-z]+:\/\//i.test(URL_ARG)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-browser-'))
    artifact = path.join(tmp, path.basename(new URL(URL_ARG).pathname) || 'aa-browser-setup.exe')
    await downloadTo(URL_ARG, artifact)
  } else if (URL_ARG && fs.existsSync(URL_ARG)) {
    artifact = path.resolve(URL_ARG) // 本地路径等同 --from
  } else if (REPO) {
    const resolved = await resolveFromRepo(REPO)
    expectedDigest = resolved.digest ?? null
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-browser-'))
    artifact = path.join(tmp, 'aa-browser-setup.exe')
    await downloadTo(resolved.url, artifact)
  } else {
    die('请提供 --url / --repo / --from 之一')
  }
  if (artifact.toLowerCase().endsWith('.zip')) {
    die('暂不支持 zip 便携包，请使用 NSIS 安装包（.exe）')
  }
  // 显式 --sha256 优先于 Release 元数据；本地文件（--from / 本地 --url）没有远端 digest，
  // 仍会校验 PE 头与非空，给了 --sha256 时再做哈希比对。
  const digestToUse = SHA256_ARG ? `sha256:${String(SHA256_ARG).trim()}` : expectedDigest
  if (!fs.statSync(artifact).isDirectory()) {
    await verifyArtifact(artifact, digestToUse, artifact)
  }

  // 2. 安装：exe → NSIS 静默安装；目录 → 便携模式就地使用
  const isDir = fs.statSync(artifact).isDirectory()
  let installDir
  if (isDir) {
    installDir = artifact
    log(`\n📁 便携模式：直接使用目录 ${installDir}`)
    if (!appExeExists(installDir)) {
      die('目录中没有 Aa Browser.exe（便携模式需要 win-unpacked 解压目录，源码目录请用 npm start 方式运行）')
    }
  } else {
    installDir = defaultInstallDir()
    log('\n📦 静默安装中（约 10-30 秒）…')
    const r = spawnSync(artifact, ['/S'], { timeout: 180000 })
    if (r.status !== 0 && !fs.existsSync(installDir)) {
      die(`安装器退出码 ${r.status}，且未检测到安装目录 ${installDir}`)
    }
  }

  // 3. 启动（若安装器未自动拉起）
  const appExe = findAppExe(installDir)
  let conn = null
  log('⏳ 等待 Aa Browser 就绪…')
  const deadline = Date.now() + 60000
  let launched = false
  while (Date.now() < deadline) {
    conn = readConnection()
    if (conn) break
    if (!NO_LAUNCH && !launched && Date.now() - t0 > 3000) {
      // 安装器通常已自动启动；若 3 秒后仍无连接信息则手动拉起一次
      try {
        spawn(appExe, [], { detached: true, stdio: 'ignore' }).unref()
        launched = true
      } catch {
        /* 拉起失败则继续轮询 */
      }
    }
    await new Promise((r) => setTimeout(r, 1000))
  }
  if (!conn) die('60 秒内未检测到 Aa Browser 就绪（~/.aabrowser/connection.json）')
  log(`✅ Aa Browser 已就绪 (v${conn.version}, ws://127.0.0.1:${conn.port})`)

  // 4. 写入 AI 客户端 MCP 配置
  const setupPath = findSetupScript(installDir)
  runSetup(setupPath, appExe)

  // 5. 收尾汇报
  log('')
  log('🎉 安装与接入完成！')
  log(`   安装位置: ${installDir}`)
  log(`   浏览器  : 已运行（v${conn.version}）`)
  log(`   配置备份: 各客户端目录下的 *.aa-backup-* 文件`)
  log('   下一步  : 重启你的 AI 客户端，即可使用 browser_* 系列工具（截图/点击/输入/抓包等）')
  log('   卸载    : 系统"设置 → 应用"中卸载 Aa Browser')
}

main().catch((err) => die(err && err.stack ? err.stack : String(err)))
