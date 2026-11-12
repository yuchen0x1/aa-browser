/**
 * 构建 MCP 桥的单文件零依赖产物：cli/mcp.mjs → out/bridge/mcp.cjs
 * （内联 ws 依赖，安装版/发布环境下无需 node_modules 即可被系统 node 执行）
 */
import { rolldown } from 'rolldown'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const OUT = path.join(ROOT, 'out', 'bridge', 'mcp.cjs')
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf-8'))

const bundle = await rolldown({
  input: path.join(ROOT, 'cli', 'mcp.mjs'),
  platform: 'node',
  external: [/^node:/]
})

await bundle.write({ file: OUT, format: 'cjs', exports: 'auto', sourcemap: false })
await bundle.close()

// 打包版把 package.json 留在 asar 内，产物运行时读不到它：
// 在产物里注入版本号，源码直接跑时 globalThis 上没有该属性，会回退读 package.json。
// ⚠️ 必须插在 shebang 之后：node 只接受第一行是 #!。
const versionInject = `globalThis.__AA_BRIDGE_VERSION__ = ${JSON.stringify(pkg.version)};\n`
const outText = fs.readFileSync(OUT, 'utf-8')
if (!outText.includes('__AA_BRIDGE_VERSION__')) {
  console.error('❌ 桥产物缺少版本号读取点（cli/mcp.mjs 的 readVersion 被改动？）')
  process.exit(1)
}
const shebangEnd = outText.startsWith('#!') ? outText.indexOf('\n') + 1 : 0
fs.writeFileSync(OUT, outText.slice(0, shebangEnd) + versionInject + outText.slice(shebangEnd), 'utf-8')

// 产物自检：除 node 内置模块与 ws 的可选依赖外，不允许出现未内联的 require
import { builtinModules } from 'node:module'
const text = fs.readFileSync(OUT, 'utf-8')
const BUILTIN = new Set([
  ...builtinModules,
  ...builtinModules.map((m) => `node:${m}`)
])
const OPTIONAL_OK = new Set(['bufferutil', 'utf-8-validate']) // ws 可选依赖，运行时已守护
const badRequires = [
  ...text.matchAll(/require\(['"]([^'"]+)['"]\)/g)].map((m) => m[1])
  .filter((r) => !BUILTIN.has(r) && !OPTIONAL_OK.has(r))
if (badRequires.length) {
  console.error('❌ 桥产物存在未内联的依赖:', badRequires.join(', '))
  process.exit(1)
}
// 版本号自检：产物里必须固化本包版本，避免发版后 serverInfo 仍是旧版本
if (!text.includes(JSON.stringify(pkg.version))) {
  console.error(`❌ 桥产物未包含当前版本号 ${pkg.version}`)
  process.exit(1)
}
console.log(`✅ MCP 桥已打包: ${OUT} (${Math.round(fs.statSync(OUT).size / 1024)} KB, v${pkg.version})`)
