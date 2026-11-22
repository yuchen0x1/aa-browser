/**
 * 截图基线存储 + 像素级视觉对比。
 *
 * 只处理 PNG（CDP 截图与基线文件都是 PNG），解码/编码全部走 node:zlib，
 * 不引入图片库依赖。基线目录默认 ~/.aabrowser/baselines，可用
 * AA_BROWSER_BASELINE_DIR 覆盖（便于测试隔离）。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { deflateSync, inflateSync } from 'node:zlib'
import type { WebContents } from 'electron'
import { ActionError } from './actions'
import { getEvidenceManager } from './evidence'
import type { Tab } from './tabs'
import { reportProgress } from './progress'

export interface VisualCapture { base64: string; width: number; height: number }

export interface BaselineMeta {
  name: string
  file: string          // absolute path to baseline .png
  url: string
  width: number
  height: number
  fullPage: boolean
  createdAt: number
  bytes: number
}

export interface DiffResult {
  ok: boolean                 // true when changedPercent <= maxDiffPercent and dimensions match
  changed: number
  total: number
  percent: number             // changed/total*100, 2 decimals
  meanAbsDiff: number         // 2 decimals
  maxDiff: number
  bbox: { x: number; y: number; width: number; height: number } | null
  dimensionsMatch: boolean
  baseline: BaselineMeta
  current: { width: number; height: number }
  diffFile?: string
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const NAME_RE = /^[A-Za-z0-9._-]{1,80}$/
const MAX_FULL_PAGE_HEIGHT = 8000

export function visualBaselinesDir(): string {
  return process.env.AA_BROWSER_BASELINE_DIR || path.join(os.homedir(), '.aabrowser', 'baselines')
}

function assertName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new ActionError('基线名称无效：只能使用 1-80 个字母、数字、点、下划线或连字符（/^[A-Za-z0-9._-]{1,80}$/）。')
  }
}

function pngDimensions(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new ActionError('截图数据不是有效的 PNG 图像。')
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/**
 * 与 doScreenshot 的 captureFullPage 相同的 CDP 附加/释放模式：只 detach 自己 attach 的调试器。
 * 窗口不可见时 CDP Page.captureScreenshot 可能永久等待合成表面，因此后台统一改走
 * capturePage：整页先临时把 CSS 视口扩到文档高度，截完立即恢复。
 */
export async function captureVisual(wc: WebContents, opts?: { fullPage?: boolean; background?: boolean; isWindowMinimized?: () => boolean }): Promise<VisualCapture> {
  const dbg = wc.debugger
  const background = opts?.background === true
  let attachedHere = false
  let restoreViewport: { width: number; height: number } | null = null
  const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
  try {
    if (!dbg.isAttached()) {
      dbg.attach('1.3')
      attachedHere = true
    }
    if (background) {
      if (opts?.fullPage) {
        const dimensions = (await wc.executeJavaScript(`(() => {
          const root = document.documentElement
          const body = document.body
          return {
            viewportWidth: window.innerWidth,
            viewportHeight: window.innerHeight,
            contentWidth: Math.max(root?.scrollWidth || 0, body?.scrollWidth || 0, window.innerWidth || 0),
            contentHeight: Math.max(root?.scrollHeight || 0, body?.scrollHeight || 0, window.innerHeight || 0)
          }
        })()`, false)) as {
          viewportWidth?: number
          viewportHeight?: number
          contentWidth?: number
          contentHeight?: number
        }
        const originalWidth = Math.max(1, Math.ceil(dimensions.viewportWidth ?? 0) || 1280)
        const originalHeight = Math.max(1, Math.ceil(dimensions.viewportHeight ?? 0) || 720)
        const width = Math.max(originalWidth, Math.ceil(dimensions.contentWidth ?? 0) || 1280)
        const height = Math.min(Math.max(originalHeight, Math.ceil(dimensions.contentHeight ?? 0) || 720), MAX_FULL_PAGE_HEIGHT)
        restoreViewport = { width: originalWidth, height: originalHeight }
        await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
          width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height
        })
        await delay(100)
      }
      const image = await wc.capturePage(undefined, { stayHidden: true })
      if (image.isEmpty()) throw new ActionError('截图失败：页面合成器未返回图像数据')
      const size = image.getSize()
      return { base64: image.toPNG().toString('base64'), width: size.width, height: size.height }
    }
    // 最小化/隐藏时合成器可能没有首帧；先请求一次不改变可见性的捕获激活渲染。
    if (opts?.fullPage) await wc.capturePage(undefined, { stayHidden: true })
    const metrics = (await dbg.sendCommand('Page.getLayoutMetrics')) as {
      cssContentSize?: { width?: number; height?: number }
      cssVisualViewport?: { width?: number; height?: number }
      contentSize?: { width?: number; height?: number }
    }

    let width: number
    let height: number
    let captureBeyondViewport: boolean
    if (opts?.fullPage) {
      const size = metrics.cssContentSize ?? metrics.contentSize ?? {}
      const fullHeight = Math.ceil(size.height ?? 0) || 720
      width = Math.ceil(size.width ?? 0) || 1280
      height = Math.min(fullHeight, MAX_FULL_PAGE_HEIGHT)
      captureBeyondViewport = true
    } else {
      // 视口尺寸取 cssVisualViewport（CSS 像素，与 deviceScaleFactor 无关）。
      const vp = metrics.cssVisualViewport ?? {}
      // Electron 的类型定义未在 WebContents 上声明 getSize；按运行时能力做兜底。
      const screen = (wc as WebContents & { getSize?: () => { width: number; height: number } }).getSize?.()
      width = Math.ceil(vp.width ?? 0) || Math.ceil(screen?.width ?? 0) || 1280
      height = Math.ceil(vp.height ?? 0) || Math.ceil(screen?.height ?? 0) || 720
      captureBeyondViewport = false
    }

    const shot = (await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      fromSurface: true,
      captureBeyondViewport,
      clip: { x: 0, y: 0, width, height, scale: 1 }
    })) as { data?: string }
    if (!shot?.data) throw new ActionError('截图失败：浏览器未返回图像数据')

    // 用 PNG IHDR 的实际像素尺寸作为返回值，避免 device scale 带来的偏差。
    const buf = Buffer.from(shot.data, 'base64')
    const size = pngDimensions(buf)
    return { base64: shot.data, width: size.width, height: size.height }
  } catch (error) {
    if (error instanceof ActionError) throw error
    throw new ActionError(`截图失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (restoreViewport && dbg.isAttached()) {
      try {
        if (opts?.isWindowMinimized?.() ?? false) {
          await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
            width: restoreViewport.width,
            height: restoreViewport.height,
            deviceScaleFactor: 1,
            mobile: false,
            screenWidth: restoreViewport.width,
            screenHeight: restoreViewport.height
          })
        } else {
          // 截图中用户已恢复窗口：清除覆盖，避免模拟视口留在前台页面。
          await dbg.sendCommand('Emulation.clearDeviceMetricsOverride')
        }
      } catch {
        /* 页面已销毁或调试通道已关闭 */
      }
    }
    if (attachedHere) {
      try {
        dbg.detach()
      } catch {
        /* 已销毁或仍被占用 */
      }
    }
  }
}

interface DecodedPng { width: number; height: number; data: Uint8Array /* RGBA */ }

const UNSUPPORTED_PNG = '仅支持 8-bit、非隔行的 RGB（color type 2）或 RGBA（color type 6）PNG'

function paethPredictor(a: number, b: number, c: number): number {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/** 纯 Node 解码器：拼接 IDAT → inflate → 逐行撤销 PNG 过滤器 → RGBA。 */
function decodePng(buf: Buffer): DecodedPng {
  if (buf.length < 24 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    throw new ActionError('PNG 解码失败：不是有效的 PNG 文件。')
  }

  let width = 0
  let height = 0
  let bitDepth = 0
  let colorType = 0
  let interlace = 0
  const idat: Buffer[] = []
  let pos = 8
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos)
    const type = buf.toString('ascii', pos + 4, pos + 8)
    if (pos + 12 + len > buf.length) throw new ActionError('PNG 解码失败：数据块长度超出文件范围。')
    const body = buf.subarray(pos + 8, pos + 8 + len)
    if (type === 'IHDR') {
      width = body.readUInt32BE(0)
      height = body.readUInt32BE(4)
      bitDepth = body[8] ?? 0
      colorType = body[9] ?? 0
      interlace = body[12] ?? 0
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(body))
    } else if (type === 'IEND') {
      break
    }
    pos += 12 + len
  }

  if (!width || !height) throw new ActionError('PNG 解码失败：缺少有效的 IHDR 尺寸信息。')
  if (bitDepth !== 8) throw new ActionError(`PNG 解码不支持位深 ${bitDepth}；${UNSUPPORTED_PNG}。`)
  if (colorType !== 2 && colorType !== 6) throw new ActionError(`PNG 解码不支持颜色类型 ${colorType}；${UNSUPPORTED_PNG}。`)
  if (interlace !== 0) throw new ActionError(`PNG 解码不支持隔行图像；${UNSUPPORTED_PNG}。`)
  if (!idat.length) throw new ActionError('PNG 解码失败：没有 IDAT 数据块。')

  const bpp = colorType === 6 ? 4 : 3
  const stride = width * bpp
  const raw = inflateSync(Buffer.concat(idat))
  if (raw.length < height * (stride + 1)) throw new ActionError('PNG 解码失败：解压后的像素数据不完整。')

  const out = new Uint8Array(width * height * 4)
  const prev = new Uint8Array(stride)
  const cur = new Uint8Array(stride)
  let p = 0
  for (let y = 0; y < height; y++) {
    const filter = raw[p++] ?? 0
    for (let i = 0; i < stride; i++) cur[i] = raw[p++] ?? 0

    // 逐字节撤销过滤器：a=左侧已还原字节，b=上一行同列，c=上一行左侧。
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? cur[i - bpp] ?? 0 : 0
      const b = prev[i] ?? 0
      const c = i >= bpp ? prev[i - bpp] ?? 0 : 0
      const v = cur[i] ?? 0
      let restored: number
      switch (filter) {
        case 0: restored = v; break
        case 1: restored = v + a; break
        case 2: restored = v + b; break
        case 3: restored = v + ((a + b) >> 1); break
        case 4: restored = v + paethPredictor(a, b, c); break
        default: throw new ActionError(`PNG 解码失败：未知的过滤器类型 ${filter}。`)
      }
      cur[i] = restored & 0xff
    }

    for (let x = 0; x < width; x++) {
      const si = x * bpp
      const di = (y * width + x) * 4
      out[di] = cur[si] ?? 0
      out[di + 1] = cur[si + 1] ?? 0
      out[di + 2] = cur[si + 2] ?? 0
      out[di + 3] = bpp === 4 ? cur[si + 3] ?? 0 : 255
    }
    prev.set(cur)
  }
  return { width, height, data: out }
}

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1)
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Buffer): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(body.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, body])), 0)
  return Buffer.concat([len, typeBuf, body, crc])
}

/** 编码 RGBA PNG：每行使用过滤器 0（None），IDAT 用 deflateSync 压缩。 */
function encodePng(width: number, height: number, rgba: Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8  // bit depth
  ihdr[9] = 6  // color type: RGBA
  ihdr[10] = 0 // compression
  ihdr[11] = 0 // filter method
  ihdr[12] = 0 // interlace

  const stride = width * 4
  const raw = Buffer.alloc(height * (stride + 1))
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1)
    raw[row] = 0
    for (let x = 0; x < stride; x++) raw[row + 1 + x] = rgba[y * stride + x] ?? 0
  }
  return Buffer.concat([PNG_SIGNATURE, pngChunk('IHDR', ihdr), pngChunk('IDAT', deflateSync(raw)), pngChunk('IEND', Buffer.alloc(0))])
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function metaPath(dir: string, name: string): string {
  return path.join(dir, `${name}.json`)
}

function readBaseline(name: string): BaselineMeta {
  const metaFile = metaPath(visualBaselinesDir(), name)
  let text: string
  try {
    text = fs.readFileSync(metaFile, 'utf8')
  } catch (error) {
    throw new ActionError(`读取基线「${name}」元数据失败：${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    const meta = JSON.parse(text) as Partial<BaselineMeta>
    if (
      !meta || typeof meta.name !== 'string' || typeof meta.file !== 'string' ||
      typeof meta.width !== 'number' || typeof meta.height !== 'number'
    ) throw new Error('元数据字段缺失')
    return meta as BaselineMeta
  } catch (error) {
    throw new ActionError(`基线「${name}」元数据已损坏：${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function visualSave(tab: Tab, name: string, opts?: { fullPage?: boolean }): Promise<BaselineMeta> {
  assertName(name)
  const fullPage = opts?.fullPage === true
  const capture = await captureVisual(tab.view.webContents, { fullPage, background: !tab.canUseWindowInput(), isWindowMinimized: () => tab.isWindowMinimized?.() ?? false })
  const png = Buffer.from(capture.base64, 'base64')
  // 确认字节流确实是 PNG 且尺寸与 IHDR 一致后再落盘，避免存进坏基线。
  const size = pngDimensions(png)
  if (size.width !== capture.width || size.height !== capture.height) {
    throw new ActionError('截图尺寸校验失败，未保存基线。')
  }

  const dir = visualBaselinesDir()
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${name}.png`)
  fs.writeFileSync(file, png)
  getEvidenceManager().record(file, 'baseline')

  const meta: BaselineMeta = {
    name,
    file,
    url: tab.url,
    width: capture.width,
    height: capture.height,
    fullPage,
    createdAt: Date.now(),
    bytes: png.length
  }
  fs.writeFileSync(metaPath(dir, name), JSON.stringify(meta, null, 2))
  getEvidenceManager().record(metaPath(dir, name), 'baseline')
  return meta
}

export async function visualCompare(
  tab: Tab,
  name: string,
  opts?: { fullPage?: boolean; pixelThreshold?: number; maxDiffPercent?: number; writeDiff?: boolean }
): Promise<DiffResult> {
  assertName(name)
  const baseline = readBaseline(name)
  // 默认沿用基线当时的截图范围，保证对比口径一致。
  const fullPage = opts?.fullPage ?? baseline.fullPage
  const current = await captureVisual(tab.view.webContents, { fullPage, background: !tab.canUseWindowInput(), isWindowMinimized: () => tab.isWindowMinimized?.() ?? false })

  let basePng: Buffer
  try {
    basePng = fs.readFileSync(baseline.file)
  } catch (error) {
    throw new ActionError(`读取基线图片「${name}」失败：${error instanceof Error ? error.message : String(error)}`)
  }
  reportProgress(0.3, 1, '解码基线')
  const base = decodePng(basePng)
  const cur = decodePng(Buffer.from(current.base64, 'base64'))

  const threshold = Math.min(255, Math.max(0, opts?.pixelThreshold ?? 16))
  const maxDiffPercent = opts?.maxDiffPercent ?? 0.5

  const compareW = Math.min(base.width, cur.width)
  const compareH = Math.min(base.height, cur.height)
  const total = compareW * compareH

  let changed = 0
  let diffSum = 0
  let maxDiff = 0
  let minX = -1
  let minY = -1
  let maxX = -1
  let maxY = -1

  // 差异图以基线为底图：整体压暗到 35%，变化像素涂成亮红。
  const diffImage = opts?.writeDiff !== false
    ? new Uint8Array(base.width * base.height * 4)
    : null
  if (diffImage) {
    for (let i = 0; i < diffImage.length; i += 4) {
      diffImage[i] = Math.round((base.data[i] ?? 0) * 0.35)
      diffImage[i + 1] = Math.round((base.data[i + 1] ?? 0) * 0.35)
      diffImage[i + 2] = Math.round((base.data[i + 2] ?? 0) * 0.35)
      diffImage[i + 3] = 255
    }
  }

  reportProgress(0.7, 1, '逐像素对比')
  for (let y = 0; y < compareH; y++) {
    for (let x = 0; x < compareW; x++) {
      const bi = (y * base.width + x) * 4
      const ci = (y * cur.width + x) * 4
      const dr = Math.abs((base.data[bi] ?? 0) - (cur.data[ci] ?? 0))
      const dg = Math.abs((base.data[bi + 1] ?? 0) - (cur.data[ci + 1] ?? 0))
      const db = Math.abs((base.data[bi + 2] ?? 0) - (cur.data[ci + 2] ?? 0))
      const d = Math.max(dr, dg, db)
      diffSum += d
      if (d > maxDiff) maxDiff = d
      if (d > threshold) {
        changed++
        if (minX === -1 || x < minX) minX = x
        if (minY === -1 || y < minY) minY = y
        if (x > maxX) maxX = x
        if (y > maxY) maxY = y
        if (diffImage) {
          diffImage[bi] = 255
          diffImage[bi + 1] = 0
          diffImage[bi + 2] = 0
          diffImage[bi + 3] = 255
        }
      }
    }
  }

  const dimensionsMatch = base.width === cur.width && base.height === cur.height
  const percent = round2(total ? (changed / total) * 100 : 0)
  const result: DiffResult = {
    ok: dimensionsMatch && percent <= maxDiffPercent,
    changed,
    total,
    percent,
    meanAbsDiff: total ? round2(diffSum / total) : 0,
    maxDiff,
    bbox: changed ? { x: minX, y: minY, width: maxX - minX + 1, height: maxY - minY + 1 } : null,
    dimensionsMatch,
    baseline,
    current: { width: cur.width, height: cur.height }
  }

  if (diffImage) {
    const dir = visualBaselinesDir()
    fs.mkdirSync(dir, { recursive: true })
    const diffFile = path.join(dir, `${name}.diff.png`)
    fs.writeFileSync(diffFile, encodePng(base.width, base.height, diffImage))
    getEvidenceManager().record(diffFile, 'diff')
    result.diffFile = diffFile
  }
  reportProgress(1, 1, '完成')
  return result
}

export function visualList(): BaselineMeta[] {
  const dir = visualBaselinesDir()
  let files: string[]
  try {
    files = fs.readdirSync(dir)
  } catch {
    return []
  }
  const out: BaselineMeta[] = []
  for (const file of files) {
    if (!file.endsWith('.json')) continue
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as Partial<BaselineMeta>
      if (!meta || typeof meta.name !== 'string' || typeof meta.file !== 'string') continue
      out.push(meta as BaselineMeta)
    } catch {
      /* 跳过无法解析的元数据文件 */
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

export function visualDelete(name: string): boolean {
  assertName(name)
  const dir = visualBaselinesDir()
  const files = [
    path.join(dir, `${name}.png`),
    path.join(dir, `${name}.json`),
    path.join(dir, `${name}.diff.png`)
  ]
  let existed = false
  for (const file of files) {
    if (!fs.existsSync(file)) continue
    existed = true
    try {
      fs.unlinkSync(file)
      getEvidenceManager().forget(file)
    } catch {
      /* 文件被占用等情况下保留，交由调用方重试 */
    }
  }
  return existed
}

export function formatDiff(r: DiffResult): string {
  const verdict = r.ok ? '通过' : '未通过'
  const lines = [
    `视觉对比「${r.baseline.name}」：${verdict}`,
    `基线尺寸：${r.baseline.width}×${r.baseline.height}；当前尺寸：${r.current.width}×${r.current.height}（尺寸${r.dimensionsMatch ? '一致' : '不一致'}）`,
    `变化像素 ${r.changed}/${r.total} (${r.percent.toFixed(2)}%)`,
    `像素差：平均 ${r.meanAbsDiff.toFixed(2)}，最大 ${r.maxDiff}`,
    `差异区域：${r.bbox ? `x=${r.bbox.x}, y=${r.bbox.y}, 宽 ${r.bbox.width}, 高 ${r.bbox.height}` : '无'}`,
    `判定：${verdict}${r.dimensionsMatch ? '' : '（尺寸不一致）'}`
  ]
  if (r.diffFile) lines.push(`差异图：${r.diffFile}`)
  return lines.join('\n')
}
