// 真实网站实战测试：MCP 驱动 Aa Browser 在必应搜索
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import readline from 'node:readline'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mcp = spawn(process.execPath, [path.join(ROOT, 'cli', 'mcp.mjs')], { stdio: ['pipe', 'pipe', 'inherit'] })
let nextId = 1
const pending = new Map()
const rl = readline.createInterface({ input: mcp.stdout })
rl.on('line', (line) => {
  let msg
  try { msg = JSON.parse(line) } catch { return }
  if (typeof msg.id === 'number' && pending.has(msg.id)) {
    const { resolve } = pending.get(msg.id)
    pending.delete(msg.id)
    resolve(msg)
  }
})
function request(method, params) {
  const id = nextId++
  return new Promise((resolve) => {
    pending.set(id, { resolve })
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
  })
}
async function call(name, args) {
  const res = await request('tools/call', { name, arguments: args ?? {} })
  return res.result
}
const textOf = (r) => (r?.content ?? []).filter((c) => c.type === 'text').map((c) => c.text).join('\n')

await request('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'live-test', version: '0' } })

console.log('── 导航到 bing.com（内嵌完整快照） ──')
const nav = await call('browser_navigate', { url: 'https://www.bing.com' })
const navText = textOf(nav)
console.log(navText.slice(0, 300))

console.log('\n── 立即再快照一次（增量生效演示） ──')
console.log(textOf(await call('browser_snapshot', {})))

// refs 来自导航内嵌快照（真实 Agent 流程：导航即可行动）
const navSnap = navText.slice(navText.indexOf('页面快照（'))
const inputLine = navSnap.split('\n').find((l) => /- (textbox|searchbox|combobox)/.test(l))
const m = inputLine ? /\[ref=(e\d+)\]/.exec(inputLine) : null
const searchRef = m ? m[1] : null
console.log('\n搜索框 ref:', searchRef, '←', inputLine?.trim().slice(0, 80))

if (searchRef) {
  console.log('\n── 输入并提交搜索（动作后返回增量快照） ──')
  const typed = await call('browser_type', { ref: searchRef, text: 'Aa Browser AI agent browser', submit: true })
  console.log(textOf(typed).split('\n').slice(0, 4).join('\n'))
  console.log('\n── 等待结果 ──')
  const wait = await call('browser_wait', { text: 'Aa', timeoutMs: 15000 })
  console.log(textOf(wait))
  console.log('\n── 提取结果页文本（截取前 1200 字） ──')
  const ext = await call('browser_extract', {})
  console.log(textOf(ext).slice(0, 1200))
}

mcp.stdin.end()
process.exit(0)
