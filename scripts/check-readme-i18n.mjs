#!/usr/bin/env node
/**
 * README 多语言一致性检查（CI 与本地都用）。
 *
 * README 的语言版本靠人工翻译维护，最容易漂移的是三件事：
 *   1. 语言栏漏项/多出某个语言，导致某个入口点进去是死链；
 *   2. 新增语言只改了文件没改进清单，或反过来；
 *   3. 翻译版丢掉了安装命令、工具名、关键数字或文档链接。
 *
 * 这里把「清单 ↔ 语言栏 ↔ 文件 ↔ 相对链接」固定成一次构建期断言：
 *   1. docs/i18n/readme-languages.json —— 语言清单（唯一事实来源）
 *   2. 各语言 README 的语言栏 —— 必须与清单逐项对应，且当前语言是加粗非链接
 *   3. 各语言 README 的关键内容 —— 安装命令、工具名、端口、数字、文档链接
 *
 * 只用文本扫描，不加载 Electron，因此可在任意 CI 环境运行。
 * 用法：node scripts/check-readme-i18n.mjs   （发现漂移时退出码 1）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const MANIFEST = 'docs/i18n/readme-languages.json'

/** 每个翻译版都必须保留的技术事实；与 README.md 的权威内容对应。 */
const REQUIRED_TOKENS = [
  'install.mjs',
  '--print-config',
  'browser_tabs',
  '127.0.0.1',
  '43',
  'MIT',
  'PROMPT.md',
  'docs/CONNECT.md',
  'docs/PLATFORMS.md',
  'LICENSE',
  'SECURITY.md',
  'CONTRIBUTING.md',
  // 安装与构建命令
  'git clone',
  'npm ci',
  'npm run build',
  'npm start',
  'chmod u+x',
  'APPIMAGE_EXTRACT_AND_RUN=1',
  // 运行时事实
  '~/.aabrowser/connection.json',
  '22.12',
  '180',
  '120',
  'isTrusted',
  'Playwright MCP',
  'SHA256SUMS.txt',
  'sbom.cdx.json',
  'browser_snapshot',
  'browser_network_requests',
  'browser_performance',
  // 真实快照示例必须原样保留（不得翻译成臆造输出）
  '- combobox "搜索网页" [ref=e15]',
]

/** 明显未翻译或未完成的占位内容。 */
const PLACEHOLDER = /\b(?:TODO|TBD|FIXME|XXX)\b|\{\{[^}]*\}\}|lorem ipsum/i

const errors = []
const fail = (file, message) => errors.push(`${file}: ${message}`)

function readText(file) {
  const abs = path.join(ROOT, file)
  if (!fs.existsSync(abs)) {
    fail(file, '文件不存在')
    return null
  }
  return fs.readFileSync(abs, 'utf-8').replace(/\r\n/g, '\n')
}

// ---- 1. 清单自检 ----
let manifest
try {
  manifest = JSON.parse(readText(MANIFEST) ?? '{}')
} catch (error) {
  console.error(`❌ ${MANIFEST} 不是合法 JSON：${error.message}`)
  process.exit(1)
}

const languages = Array.isArray(manifest.languages) ? manifest.languages : []
if (languages.length < 2) fail(MANIFEST, 'languages 至少要有两项（默认语言 + 一种翻译）')
if (!languages.some((item) => item.code === manifest.default)) {
  fail(MANIFEST, `default="${manifest.default}" 不在 languages 中`)
}

for (const field of ['code', 'nativeName', 'file']) {
  const seen = new Map()
  for (const item of languages) {
    if (!item[field]) fail(MANIFEST, `有条目缺少 ${field}`)
    else if (seen.has(item[field])) fail(MANIFEST, `${field} 重复：${item[field]}`)
    else seen.set(item[field], true)
  }
}
for (const item of languages) {
  if (item.dir && item.dir !== 'ltr' && item.dir !== 'rtl') {
    fail(MANIFEST, `${item.code}: dir 只能是 ltr 或 rtl，实际 ${item.dir}`)
  }
  if (item.file) {
    const validRootReadme = /^README(\.[A-Za-z-]+)?\.md$/.test(item.file)
    const validTranslationReadme = /^docs\/i18n\/readmes\/README\.[A-Za-z-]+\.md$/.test(item.file)
    if (!validRootReadme && !validTranslationReadme) {
      fail(MANIFEST, `${item.code}: file 必须是 README.md 或 docs/i18n/readmes/README.<lang>.md，实际 ${item.file}`)
    }
  }
}

const files = new Set(languages.map((item) => item.file))

function relativeHref(fromFile, targetFile) {
  const relative = path.posix.relative(path.posix.dirname(fromFile), targetFile)
  return relative.startsWith('.') ? relative : `./${relative}`
}

// ---- 2. 逐个语言文件检查 ----
for (const lang of languages) {
  const text = readText(lang.file)
  if (text === null) continue

  const lines = text.split('\n')
  const firstContent = lines.find((line) => line.trim().length > 0) ?? ''
  if (!/^#\s+\S/.test(firstContent)) {
    fail(lang.file, `首个非空行应是 H1 标题，实际是「${firstContent.slice(0, 40)}」`)
  }

  // 语言栏：第一段 <p align="center"> 必须是语言索引
  const bar = text.match(/<p align="center">([\s\S]*?)<\/p>/)
  if (!bar) {
    fail(lang.file, '缺少 <p align="center"> 语言栏')
  } else {
    const body = bar[1]
    if (!body.includes(`<b>${lang.nativeName}</b>`)) {
      fail(lang.file, `语言栏应把 <b>${lang.nativeName}</b> 加粗（当前语言非链接）`)
    }
    for (const other of languages) {
      if (other.code === lang.code) continue
      const href = relativeHref(lang.file, other.file)
      const link = `<a href="${href}">${other.nativeName}</a>`
      if (!body.includes(link)) fail(lang.file, `语言栏缺少条目：${link}`)
    }
    // 反向：语言栏中的每个相对路径都必须解析到已登记语言文件
    for (const [, href] of body.matchAll(/<a href="([^"]+\.md)"/g)) {
      if (/^[a-z]+:\/\//i.test(href)) continue
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(lang.file), href))
      if (!files.has(target)) fail(lang.file, `语言栏链接不在清单中：${href} -> ${target}`)
    }
  }

  // 关键内容
  for (const token of REQUIRED_TOKENS) {
    if (!text.includes(token)) fail(lang.file, `缺少必需内容：${token}`)
  }
  if (PLACEHOLDER.test(text)) fail(lang.file, '存在未翻译的占位内容（TODO/TBD/{{…}} 等）')

  // 相对链接可达性
  const localLinks = new Set()
  for (const [, target] of text.matchAll(/\]\(((?:\.\/|\.\.\/)[^)\s]+)\)/g)) localLinks.add(target)
  for (const [, target] of text.matchAll(/<img[^>]+src="((?:\.\/|\.\.\/)[^"]+)"/g)) localLinks.add(target)
  for (const link of localLinks) {
    const clean = decodeURI(link.split('#')[0])
    const absolute = path.resolve(ROOT, path.dirname(lang.file), clean)
    if (!absolute.startsWith(`${ROOT}${path.sep}`) && absolute !== ROOT) {
      fail(lang.file, `相对链接越出仓库：${link}`)
    } else if (!fs.existsSync(absolute)) {
      fail(lang.file, `相对链接指向不存在的路径：${link}`)
    }
  }
}

// ---- 3. 清单与磁盘上的 README 语言文件互相对齐 ----
const translationDir = path.join(ROOT, 'docs', 'i18n', 'readmes')
const rootReadmes = fs
  .readdirSync(ROOT)
  .filter((name) => /^README(\.[A-Za-z-]+)?\.md$/.test(name))
const translatedReadmes = fs.existsSync(translationDir)
  ? fs.readdirSync(translationDir)
      .filter((name) => /^README\.[A-Za-z-]+\.md$/.test(name))
      .map((name) => path.posix.join('docs/i18n/readmes', name))
  : []
const onDisk = [...rootReadmes, ...translatedReadmes]
const untracked = onDisk.filter((name) => !files.has(name))
for (const name of untracked) fail(name, `磁盘上存在多语言 README，但未登记在 ${MANIFEST}`)

if (errors.length) {
  console.error(`❌ README 多语言检查失败（${errors.length} 项）：`)
  for (const message of errors) console.error(`   - ${message}`)
  process.exit(1)
}

console.log(
  `✅ README 多语言一致（${languages.length} 种语言：${languages.map((item) => item.code).join(', ')}）`,
)
