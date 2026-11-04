/**
 * 生成应用图标：用 Electron offscreen 窗口渲染 SVG → 512px PNG。
 * 运行：npx electron scripts/make-icon.js   （产物：build/icon.png）
 * electron-builder 会用它自动生成 Windows .ico。
 */
const { app, BrowserWindow } = require('electron')
const fs = require('node:fs')
const path = require('node:path')

const SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">
  <rect width="512" height="512" rx="104" fill="#1d1e23"/>
  <circle cx="256" cy="256" r="212" fill="none" stroke="#34353c" stroke-width="6"/>
  <text x="256" y="336" font-family="'Segoe UI','Microsoft YaHei',sans-serif" font-size="236" font-weight="700" text-anchor="middle"><tspan fill="#4f8cff">A</tspan><tspan fill="#e9eaee">a</tspan></text>
</svg>`

app.whenReady().then(async () => {
  const win = new BrowserWindow({
    show: false,
    width: 512,
    height: 512,
    webPreferences: { offscreen: true }
  })
  const html = `<html><body style="margin:0;padding:0;overflow:hidden">${SVG}</body></html>`
  await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html))
  // 等待离屏合成器出帧
  await new Promise((r) => setTimeout(r, 800))
  let img = await win.webContents.capturePage()
  if (img.isEmpty()) {
    await new Promise((r) => setTimeout(r, 800))
    img = await win.webContents.capturePage()
  }
  if (img.getSize().width !== 512) {
    img = img.resize({ width: 512, height: 512 })
  }
  const out = path.join(__dirname, '..', 'build', 'icon.png')
  fs.mkdirSync(path.dirname(out), { recursive: true })
  fs.writeFileSync(out, img.toPNG())
  console.log('icon written:', out, img.getSize())
  app.exit(0)
})
