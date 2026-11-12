#!/usr/bin/env node
/**
 * 工具定义漂移检查（CI 与本地都用）。
 *
 * v0.6.0 曾出现：主进程有 30 个工具，但 MCP 桥只声明 27 个，
 * 导致 browser_mock_requests / list_mocks / clear_mocks 对真实客户端不可见。
 * 这里把三方对比固定成一次构建期断言：
 *   1. src/main/tools.ts   —— 主进程真实注册的工具
 *   2. cli/mcp.mjs         —— MCP 桥对外声明的工具
 *   3. README.md 工具表    —— 文档
 *
 * 只用文本扫描，不加载 Electron，因此可在任意 CI 环境运行。
 * 用法：node scripts/check-tools.mjs   （发现漂移时退出码 1）
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 从源码里按出现顺序抽 name: 'browser_xxx' */
function namesIn(file, pattern) {
  const text = fs.readFileSync(path.join(ROOT, file), 'utf-8')
  return [...text.matchAll(pattern)].map((m) => m[1])
}

const mainNames = namesIn('src/main/tools.ts', /name:\s*'(browser_[a-z0-9_]+)'/g)
const bridgeNames = namesIn('cli/mcp.mjs', /name:\s*'(browser_[a-z0-9_]+)'/g)
// README 允许把成对工具写在同一行（如 browser_navigate_back / browser_navigate_forward），
// 因此逐行收集该行内所有 `browser_*`。
const readmeNames = fs
  .readFileSync(path.join(ROOT, 'README.md'), 'utf-8')
  .split(/\r?\n/)
  .filter((line) => line.trimStart().startsWith('|'))
  .flatMap((line) => [...line.matchAll(/`(browser_[a-z0-9_]+)`/g)].map((m) => m[1]))

const uniq = (arr) => [...new Set(arr)]
const mainSet = uniq(mainNames)
const bridgeSet = uniq(bridgeNames)
const readmeSet = uniq(readmeNames)

const missingInBridge = mainSet.filter((n) => !bridgeSet.includes(n))
const extraInBridge = bridgeSet.filter((n) => !mainSet.includes(n))
const missingInReadme = mainSet.filter((n) => !readmeSet.includes(n))
const extraInReadme = readmeSet.filter((n) => !mainSet.includes(n))

const problems = []
if (missingInBridge.length) problems.push(`主进程有、桥缺失：${missingInBridge.join(', ')}`)
if (extraInBridge.length) problems.push(`桥有、主进程没有：${extraInBridge.join(', ')}`)
if (missingInReadme.length) problems.push(`README 工具表缺少：${missingInReadme.join(', ')}`)
if (extraInReadme.length) problems.push(`README 工具表多出：${extraInReadme.join(', ')}`)
// 工具重名会让 MCP 客户端只看到最后一个，必须单独拦
const dupBridge = bridgeNames.filter((n, i) => bridgeNames.indexOf(n) !== i)
if (dupBridge.length) problems.push(`桥内重复定义：${[...new Set(dupBridge)].join(', ')}`)
const dupMain = mainNames.filter((n, i) => mainNames.indexOf(n) !== i)
if (dupMain.length) problems.push(`主进程内重复定义：${[...new Set(dupMain)].join(', ')}`)

console.log(`主进程 ${mainSet.length} 个 · 桥 ${bridgeSet.length} 个 · README ${readmeSet.length} 个`)

if (problems.length) {
  console.error('\n❌ 工具定义漂移：')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log('✅ 工具定义三方一致')
