import path from 'node:path'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import { fitWindowToDisplay } from './display-fit.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const scales = [1, 1.25, 1.5, 2]
let failed = false

// Placement rules are pure, so both the large-display and the CI small-display
// (1024×720 at 150%/200%) branches are verified without their hardware.
const large = { x: 0, y: 0, width: 1920, height: 1080 }
const small = { x: 0, y: 0, width: 683, height: 480 }
const windowBounds = { x: 100, y: 100, width: 1200, height: 900 }
assert.deepEqual(fitWindowToDisplay(windowBounds, large), { x: 24, y: 24, width: 1200, height: 900, fits: true })
assert.equal(fitWindowToDisplay(windowBounds, { ...large, width: 900 }).width, 960, 'never shrink below the minimum window width')
assert.deepEqual(fitWindowToDisplay(windowBounds, small), { x: 0, y: 0, width: 960, height: 640, fits: false }, 'small displays keep the minimum window and report the constraint')
// A secondary display with a negative origin must keep the window on that display.
assert.deepEqual(fitWindowToDisplay(windowBounds, { x: -1920, y: -240, width: 1920, height: 1040 }), { x: -1896, y: -216, width: 1200, height: 900, fits: true })
console.log('[display-matrix] placement rules verified for large, small and offset displays')

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
