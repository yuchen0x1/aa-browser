#!/usr/bin/env node
/**
 * 工具定义漂移检查（CI 与本地都用）。
 *
 * v0.6.0 曾出现：主进程有 30 个工具，但 MCP 桥只声明 27 个，
 * 导致 browser_mock_requests / list_mocks / clear_mocks 对真实客户端不可见。
 * v0.7.0 起 name/title/description/inputSchema/annotations 的唯一来源是
 *   src/shared/tool-defs.mjs
 * 主进程只写 name + handler，桥直接 import 同一份定义。这里把四方对比固定成
 * 一次构建期断言：
 *   1. src/shared/tool-defs.mjs —— 唯一来源（工具名 + annotations）
 *   2. src/main/tools.ts       —— 主进程真实注册的 handler 名
 *   3. cli/mcp.mjs             —— 桥必须引用同一份定义，不得再手写一份
 *   4. README.md 工具表        —— 文档
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

const SOURCE = 'src/shared/tool-defs.mjs'
const sourceText = fs.readFileSync(path.join(ROOT, SOURCE), 'utf-8')
const sourceNames = namesIn(SOURCE, /name:\s*'(browser_[a-z0-9_]+)'/g)
const annotationNames = [...sourceText.matchAll(/^\s{2}(browser_[a-z0-9_]+):\s*\{/gm)].map((m) => m[1])
const mainNames = namesIn('src/main/tools.ts', /name:\s*'(browser_[a-z0-9_]+)'/g)
const bridgeText = fs.readFileSync(path.join(ROOT, 'cli/mcp.mjs'), 'utf-8')
const bridgeNames = namesIn('cli/mcp.mjs', /name:\s*'(browser_[a-z0-9_]+)'/g)
// README 允许把成对工具写在同一行（如 browser_navigate_back / browser_navigate_forward），
// 因此逐行收集该行内所有 `browser_*`。
const readmeNames = fs
  .readFileSync(path.join(ROOT, 'README.md'), 'utf-8')
  .split(/\r?\n/)
  .filter((line) => line.trimStart().startsWith('|'))
  .flatMap((line) => [...line.matchAll(/`(browser_[a-z0-9_]+)`/g)].map((m) => m[1]))

const uniq = (arr) => [...new Set(arr)]
const sourceSet = uniq(sourceNames)
const annotationSet = uniq(annotationNames)
const mainSet = uniq(mainNames)
const bridgeSet = uniq(bridgeNames)
const readmeSet = uniq(readmeNames)

const problems = []
const compare = (label, expected, actual) => {
  const missing = expected.filter((n) => !actual.includes(n))
  const extra = actual.filter((n) => !expected.includes(n))
  if (missing.length) problems.push(`${label} 缺少：${missing.join(', ')}`)
  if (extra.length) problems.push(`${label} 多出：${extra.join(', ')}`)
}
compare(`主进程(${mainSet.length}) vs 唯一来源`, sourceSet, mainSet)
compare(`README(${readmeSet.length}) vs 唯一来源`, sourceSet, readmeSet)
compare(`annotations(${annotationSet.length}) vs 唯一来源`, sourceSet, annotationSet)

// 单一来源守卫：桥不得再内嵌工具定义；主进程不得再手写 title/description/inputSchema。
if (bridgeNames.length) problems.push(`桥出现 ${bridgeNames.length} 个手写工具定义，应改为从 ${SOURCE} 导入`)
if (!bridgeText.includes("from '../src/shared/tool-defs.mjs'")) problems.push('桥未从唯一来源导入 TOOL_DEFS')
const mainText = fs.readFileSync(path.join(ROOT, 'src/main/tools.ts'), 'utf-8')
if (!mainText.includes("from '@shared/tool-defs.mjs'")) problems.push('主进程未从唯一来源导入 schema')
// 接口类型声明本身有一处 `inputSchema: {`；除此之外不得出现第二处（即重新手写 schema）
const inlineSchemaCount = (mainText.match(/\binputSchema:\s*\{/g) ?? []).length
if (inlineSchemaCount > 1) problems.push(`主进程再次手写 inputSchema（共 ${inlineSchemaCount} 处，应只保留 name + handler）`)
if (/title:\s*'[^']*',\s*\r?\n\s*description:/.test(mainText)) problems.push('主进程再次手写 title/description')

// 工具重名会让 MCP 客户端只看到最后一个，必须单独拦
for (const [label, names] of [['唯一来源', sourceNames], ['主进程', mainNames], ['annotations', annotationNames]]) {
  const dup = names.filter((n, i) => names.indexOf(n) !== i)
  if (dup.length) problems.push(`${label} 内重复定义：${[...new Set(dup)].join(', ')}`)
}

console.log(`唯一来源 ${sourceSet.length} 个 · 主进程 ${mainSet.length} · 桥 ${bridgeSet.length} · README ${readmeSet.length} · annotations ${annotationSet.length}`)

if (problems.length) {
  console.error('\n❌ 工具定义漂移：')
  for (const p of problems) console.error(`  - ${p}`)
  process.exit(1)
}
console.log('✅ 工具定义单一来源 + 四方一致')
