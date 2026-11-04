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

const bundle = await rolldown({
  input: path.join(ROOT, 'cli', 'mcp.mjs'),
  platform: 'node',
  external: [/^node:/]
})

await bundle.write({ file: OUT, format: 'cjs', exports: 'auto', sourcemap: false })
await bundle.close()

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
console.log(`✅ MCP 桥已打包: ${OUT} (${Math.round(fs.statSync(OUT).size / 1024)} KB)`)
