/**
 * 生成应用图标（透明背景 PNG）。
 * 运行：npx electron scripts/make-icon.js
 *
 * 产物：
 *   build/icon.png                   512×512  应用图标源，electron-builder 据此生成 Windows .ico / Linux 图标
 *   packages/dsh/assets/icon-180.png 180×180  DeepSeek Harness 插件市场图标
 *
 * 实现说明：图标用 Canvas 2D 直接绘制并导出 PNG，不经过窗口截图，
 * 因此不会出现白底、四周白边、内容偏移或 DPI 缩放问题；圆角「方窗」
 * 以外的像素 alpha 为 0，在桌面和任务栏上都不会露出白框。
 * 两个尺寸各自按目标像素渲染，小尺寸不做降采样，边缘更干净。
 */
const electron = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const { spawnSync } = require('node:child_process')

// 某些终端/CI 包装器会默认导出 ELECTRON_RUN_AS_NODE=1，此时 Electron 二进制退化成纯 Node：
// require('electron') 只返回可执行文件路径，process.versions.electron 仍然存在。
// 这里自动以 Electron 身份重启一次，保证 `npm run icon` 在任何 shell 里都能用。
if (typeof electron === 'string') {
  const electronPath = electron
  if (process.env.AA_ICON_RELAUNCHED === '1') {
    console.error('需要用 Electron 运行：npx electron scripts/make-icon.js（不要设置 ELECTRON_RUN_AS_NODE）')
    process.exit(1)
  }
  const env = { ...process.env, AA_ICON_RELAUNCHED: '1' }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawnSync(electronPath, [__filename], { env, stdio: 'inherit' })
  process.exit(child.status ?? 1)
}

const { app, BrowserWindow } = electron

const ROOT = path.join(__dirname, '..')
const TARGETS = [
  { file: 'build/icon.png', size: 512 },
  { file: 'packages/dsh/assets/icon-180.png', size: 180 }
]

const DRAW_ICON = `
  function drawIcon(size) {
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d')
    const u = size / 512                      // 设计稿按 512 绘制，按比例缩放

    // 超椭圆路径：现代「方窗」轮廓，四角完全透明
    const squircle = (inset) => {
      const radius = size / 2 - inset
      const exponent = 3.6
      const steps = 320
      ctx.beginPath()
      for (let i = 0; i <= steps; i++) {
        const t = (i / steps) * Math.PI * 2
        const cos = Math.cos(t)
        const sin = Math.sin(t)
        const x = size / 2 + radius * Math.sign(cos) * Math.pow(Math.abs(cos), 2 / exponent)
        const y = size / 2 + radius * Math.sign(sin) * Math.pow(Math.abs(sin), 2 / exponent)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.closePath()
    }

    // 1. 底色：满幅深石墨渐变（顶部略亮，底部沉下去）
    ctx.save()
    squircle(0)
    ctx.clip()
    const base = ctx.createLinearGradient(0, 0, 0, size)
    base.addColorStop(0, '#2b2e37')
    base.addColorStop(0.55, '#1e2027')
    base.addColorStop(1, '#141519')
    ctx.fillStyle = base
    ctx.fillRect(0, 0, size, size)
    // 顶部柔光，避免大尺寸下显得死板
    const sheen = ctx.createLinearGradient(0, 0, 0, size * 0.6)
    sheen.addColorStop(0, 'rgba(255, 255, 255, 0.09)')
    sheen.addColorStop(1, 'rgba(255, 255, 255, 0)')
    ctx.fillStyle = sheen
    ctx.fillRect(0, 0, size, size)
    ctx.restore()

    // 2. 内描边：浅色/深色桌面上都能看到轮廓，且不会出现硬白边
    ctx.save()
    squircle(1 * u)
    ctx.lineWidth = 1.5 * u
    ctx.strokeStyle = 'rgba(255, 255, 255, 0.10)'
    ctx.stroke()
    ctx.restore()

    // 3. 品牌圆环（带一点品牌蓝，缩到小尺寸也不会糊成灰边）
    ctx.beginPath()
    ctx.arc(size / 2, size / 2, 196 * u, 0, Math.PI * 2)
    ctx.lineWidth = 7 * u
    ctx.strokeStyle = 'rgba(122, 168, 255, 0.18)'
    ctx.stroke()

    // 4. 「Aa」字标：A 蓝色、a 白色，按字形墨迹外框光学居中
    const fontSize = 248 * u
    ctx.font = "700 " + fontSize + "px 'Segoe UI', 'Inter', 'Helvetica Neue', Arial, sans-serif"
    ctx.textAlign = 'left'
    ctx.textBaseline = 'alphabetic'
    const glyphA = ctx.measureText('A')
    const glyphLower = ctx.measureText('a')
    const glyphBoth = ctx.measureText('Aa')
    const kerning = Math.max(0, glyphBoth.width - glyphA.width - glyphLower.width)
    // 用整串的墨迹外框（actualBoundingBox*）居中，避免字腔左右边距不对称造成的偏移
    const totalInk = glyphBoth.actualBoundingBoxLeft + glyphBoth.actualBoundingBoxRight
    const penA = size / 2 - totalInk / 2 + glyphBoth.actualBoundingBoxLeft
    const baseline = size / 2 + (glyphBoth.actualBoundingBoxAscent - glyphBoth.actualBoundingBoxDescent) / 2
    ctx.fillStyle = '#4f8cff'
    ctx.fillText('A', penA, baseline)
    ctx.fillStyle = '#eceef2'
    ctx.fillText('a', penA + glyphA.width + kerning, baseline)

    return canvas.toDataURL('image/png')
  }
  ;({ 512: drawIcon(512), 180: drawIcon(180) })
`

app.whenReady().then(async () => {
  const win = new BrowserWindow({ show: false, width: 64, height: 64, webPreferences: { sandbox: true } })
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent('<!doctype html><html><body></body></html>'))
    const icons = await win.webContents.executeJavaScript(DRAW_ICON, true)
    for (const target of TARGETS) {
      const dataUrl = icons?.[String(target.size)]
      if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
        throw new Error(`图标渲染失败：${target.file}`)
      }
      const out = path.join(ROOT, target.file)
      fs.mkdirSync(path.dirname(out), { recursive: true })
      fs.writeFileSync(out, Buffer.from(dataUrl.slice('data:image/png;base64,'.length), 'base64'))
      console.log(`icon written: ${target.file} (${target.size}x${target.size})`)
    }
    app.exit(0)
  } catch (error) {
    console.error(error)
    app.exit(1)
  }
})