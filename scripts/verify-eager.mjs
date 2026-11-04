// 验证桥"启动即连接"：spawn 桥后不调用任何工具，8 秒内应出现到浏览器的 ESTABLISHED 连接
import { spawn, execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const info = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.aabrowser', 'connection.json'), 'utf-8'))
const p = spawn(process.execPath, ['cli/mcp.mjs'], { stdio: ['pipe', 'pipe', 'inherit'], cwd: process.cwd() })
p.stdin.write(
  JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'eager-test', version: '0' } }
  }) + '\n'
)

function check() {
  try {
    const out = execSync(`netstat -ano | findstr ":${info.port}" | findstr "ESTABLISHED"`, { shell: true }).toString()
    if (out.includes('ESTABLISHED')) {
      console.log('✅ 启动即连接生效（ESTABLISHED 出现，未调用任何工具）')
      p.kill()
      process.exit(0)
    }
  } catch {
    /* 尚未连接 */
  }
  setTimeout(check, 1000)
}
setTimeout(check, 1500)
setTimeout(() => {
  console.log('❌ 8 秒内未出现连接')
  p.kill()
  process.exit(1)
}, 8000)
