import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scales = [1.25, 1.5, 2]
let failed = false

for (const scale of scales) {
  console.log(`\n[display-matrix] forcing device scale factor ${scale}`)
  const child = spawn(process.execPath, [path.join(root, 'scripts/test-desktop.mjs'), '--display-only', `--display-scale=${scale}`], {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, AA_DISPLAY_MATRIX_SCALE: String(scale) }
  })
  const code = await new Promise((resolve) => {
    child.once('error', () => resolve(1))
    child.once('exit', (exitCode) => resolve(exitCode ?? 1))
  })
  if (code !== 0) failed = true
}

if (failed) process.exitCode = 1
else console.log('\n[display-matrix] all DPI and display placement checks passed')
