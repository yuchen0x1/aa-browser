import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { Tab } from './tabs'
import { ActionError, raceAbort, throwIfAborted } from './actions'
import { reportProgress } from './progress'
import { getEvidenceManager } from './evidence'

/** 单个视口的定义。name 省略时会按尺寸自动派生。 */
export interface ViewportSpec {
  name?: string
  width: number
  height: number
  deviceScaleFactor?: number
  mobile?: boolean
}

/** 单个视口的截图结果（含请求尺寸、实际像素与页面内测得的布局信息）。 */
export interface ViewportResult {
  name: string
  width: number
  height: number
  deviceScaleFactor: number
  imageWidth: number
  imageHeight: number
  innerWidth: number
  innerHeight: number
  scrollWidth: number
  overflowX: boolean
  file: string
}

const MOBILE: ViewportSpec[] = [
  { name: 'mobile-320', width: 320, height: 568, deviceScaleFactor: 2, mobile: true },
  { name: 'mobile-375', width: 375, height: 667, deviceScaleFactor: 2, mobile: true },
  { name: 'mobile-480', width: 480, height: 800, deviceScaleFactor: 2, mobile: true }
]
const TABLET: ViewportSpec[] = [
  { name: 'tablet-768', width: 768, height: 1024, deviceScaleFactor: 2, mobile: false },
  { name: 'tablet-834', width: 834, height: 1112, deviceScaleFactor: 2, mobile: false }
]
const DESKTOP: ViewportSpec[] = [
  { name: 'desktop-1280', width: 1280, height: 800, deviceScaleFactor: 1, mobile: false },
  { name: 'desktop-1440', width: 1440, height: 900, deviceScaleFactor: 1, mobile: false }
]
const HI_DPI: ViewportSpec[] = [
  { name: 'hidpi-1280', width: 1280, height: 800, deviceScaleFactor: 2, mobile: false },
  { name: 'hidpi-1440', width: 1440, height: 900, deviceScaleFactor: 2, mobile: false }
]

/** 常用视口组合。`all` 为上面四组的拼接（名称互不重复）。 */
export const VIEWPORT_PRESETS: Record<string, ViewportSpec[]> = {
  mobile: MOBILE,
  tablet: TABLET,
  desktop: DESKTOP,
  'hi-dpi': HI_DPI,
  all: [...MOBILE, ...TABLET, ...DESKTOP, ...HI_DPI]
}

type ValidSpec = Required<ViewportSpec>

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

/** 校验并规范化一条视口定义；非法输入直接抛 ActionError。 */
function validateSpec(spec: ViewportSpec): ValidSpec {
  if (!spec || typeof spec !== 'object') {
    throw new ActionError('视口规格无效：每项必须是对象')
  }
  const { width, height } = spec
  if (!Number.isInteger(width) || width < 200 || width > 5000) {
    throw new ActionError(`视口宽度必须是 200..5000 的整数，收到: ${String(width)}`)
  }
  if (!Number.isInteger(height) || height < 200 || height > 5000) {
    throw new ActionError(`视口高度必须是 200..5000 的整数，收到: ${String(height)}`)
  }
  const deviceScaleFactor = spec.deviceScaleFactor ?? 1
  if (typeof deviceScaleFactor !== 'number' || !Number.isFinite(deviceScaleFactor) || deviceScaleFactor < 1 || deviceScaleFactor > 4) {
    throw new ActionError(`视口 deviceScaleFactor 必须在 1..4，收到: ${String(deviceScaleFactor)}`)
  }

  let name: string
  if (typeof spec.name === 'string' && spec.name.length > 0) {
    if (!/^[A-Za-z0-9_-]+$/.test(spec.name)) {
      throw new ActionError(`视口名称只能包含字母、数字、下划线和连字符，收到: ${spec.name}`)
    }
    name = spec.name
  } else {
    name = `viewport-${width}x${height}@${deviceScaleFactor}x`
  }

  return { name, width, height, deviceScaleFactor, mobile: !!spec.mobile }
}

/** 从 PNG base64 的 IHDR 块读取真实像素尺寸（宽在偏移 16，高在偏移 20，大端）。 */
function readPngSize(base64: string): { width: number; height: number } {
  const buf = Buffer.from(base64, 'base64')
  if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') {
    throw new ActionError('视口截图失败：浏览器返回的图像不是有效的 PNG')
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/**
 * 多视口截图矩阵：通过 CDP Emulation.setDeviceMetricsOverride 直接设定 CSS 视口与 DPI，
 * 从而绕过 Electron BrowserWindow 的最小尺寸限制（960x640），并支持高 DPI 截图。
 *
 * 关键点：无论成功或失败，finally 里都会清除设备度量覆盖再按需分离调试器，
 * 否则残留的 override 会污染后续所有工具与截图。
 */
export async function captureViewportMatrix(
  tab: Tab,
  specs: ViewportSpec[],
  opts?: { signal?: AbortSignal; isMinimized?: () => boolean }
): Promise<ViewportResult[]> {
  const signal = opts?.signal
  throwIfAborted(signal)

  if (!Array.isArray(specs) || specs.length === 0) {
    throw new ActionError('视口矩阵为空：请至少提供一个视口规格')
  }
  if (specs.length > 12) {
    throw new ActionError(`视口矩阵最多支持 12 个视口，收到 ${specs.length} 个`)
  }
  const validated = specs.map(validateSpec)

  const wc = tab.view.webContents
  const dbg = wc.debugger
  const dir = process.env['AA_BROWSER_SCREENSHOT_DIR'] || path.join(os.homedir(), '.aabrowser', 'screenshots')
  fs.mkdirSync(dir, { recursive: true })

  const usedFiles = new Set<string>()
  const results: ViewportResult[] = []
  let attachedHere = false
  // 最小化时窗口后台会维持一个虚拟视口；矩阵工具结束后必须把它恢复，
  // 否则 backgroundViewportTabs 仍认为已覆盖，后续快照会读到 0×0。
  const wasMinimized = opts?.isMinimized?.() === true
  let restoreViewport: { width: number; height: number; deviceScaleFactor: number } | null = null
  if (wasMinimized) {
    try {
      const size = (await wc.executeJavaScript(
        '({ width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio || 1 })',
        false
      )) as { width?: number; height?: number; deviceScaleFactor?: number } | null
      if ((size?.width ?? 0) > 0 && (size?.height ?? 0) > 0) {
        restoreViewport = {
          width: Math.round(size!.width!),
          height: Math.round(size!.height!),
          deviceScaleFactor: size?.deviceScaleFactor ?? 1
        }
      }
    } catch {
      /* 页面可能尚未就绪 */
    }
  }

  try {
    if (!dbg.isAttached()) {
      dbg.attach('1.3')
      attachedHere = true
    }

    for (const [index, spec] of validated.entries()) {
      // 每个视口开始前检查中断，保证用户中断后不再产生新的截图副作用。
      throwIfAborted(signal)
      reportProgress(index + 1, specs.length, '视口 ' + spec.name)

      await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
        width: spec.width,
        height: spec.height,
        deviceScaleFactor: spec.deviceScaleFactor,
        mobile: spec.mobile,
        screenWidth: spec.width,
        screenHeight: spec.height
      })

      // 给渲染器一点时间按新尺寸重排，否则截图可能仍是旧布局。
      await delay(200)
      throwIfAborted(signal)

      const shot = (await raceAbort(
        dbg.sendCommand('Page.captureScreenshot', {
          format: 'png',
          fromSurface: true,
          captureBeyondViewport: false
        }),
        signal
      )) as { data?: string } | undefined
      throwIfAborted(signal)
      if (!shot?.data) {
        throw new ActionError(`视口 ${spec.name} 截图失败：浏览器未返回图像数据`)
      }

      // 无 clip：PNG 物理尺寸应为 width*dsf × height*dsf，从 IHDR 实测确认。
      const pngSize = readPngSize(shot.data)

      const metrics = (await wc.executeJavaScript(
        '(() => ({' +
        'innerWidth: window.innerWidth,' +
        'innerHeight: window.innerHeight,' +
        'scrollWidth: document.documentElement.scrollWidth,' +
        'overflowX: document.documentElement.scrollWidth > window.innerWidth + 1' +
        '}))()'
      )) as { innerWidth?: number; innerHeight?: number; scrollWidth?: number; overflowX?: boolean } | undefined
      throwIfAborted(signal)

      // 文件名按视口唯一：同一毫秒内连续截图也不会互相覆盖。
      let file = path.join(dir, `aa-matrix-${spec.name}-${Date.now()}.png`)
      let dup = 1
      while (usedFiles.has(file)) {
        file = path.join(dir, `aa-matrix-${spec.name}-${Date.now()}-${dup++}.png`)
      }
      usedFiles.add(file)
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
      getEvidenceManager().record(file, 'viewport')

      results.push({
        name: spec.name,
        width: spec.width,
        height: spec.height,
        deviceScaleFactor: spec.deviceScaleFactor,
        imageWidth: pngSize.width,
        imageHeight: pngSize.height,
        innerWidth: metrics?.innerWidth ?? 0,
        innerHeight: metrics?.innerHeight ?? 0,
        scrollWidth: metrics?.scrollWidth ?? 0,
        overflowX: !!metrics?.overflowX,
        file
      })
    }

    return results
  } catch (error) {
    if (error instanceof ActionError) throw error
    throw new ActionError(`视口矩阵截图失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    // 关键：一定要先清除覆盖（并吞掉清理过程中的异常），再分离本次附加的调试器。
    try {
      await dbg.sendCommand('Emulation.clearDeviceMetricsOverride')
      // Linux 上 renderer 应用“恢复原尺寸”比 CDP 响应略慢，留一帧避免后续 evaluate 读到旧尺寸。
      await delay(150)
      if (wasMinimized && restoreViewport) {
        await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
          width: restoreViewport.width,
          height: restoreViewport.height,
          deviceScaleFactor: restoreViewport.deviceScaleFactor,
          mobile: false,
          screenWidth: restoreViewport.width,
          screenHeight: restoreViewport.height
        })
      }
    } catch {
      /* 调试器可能已分离或页面已销毁 */
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

/** 把视口矩阵结果格式化为简洁的中文表格报告（含横向溢出汇总）。 */
export function formatViewportMatrix(results: ViewportResult[]): string {
  if (!results.length) {
    return '视口矩阵截图：无结果。'
  }

  const lines: string[] = [`视口矩阵截图结果（共 ${results.length} 个视口）：`]
  lines.push('名称 | 请求尺寸(CSS) @DPI → 实际像素 | innerWidth×innerHeight | 横向溢出 | 文件')
  for (const r of results) {
    lines.push(
      `${r.name} | ${r.width}×${r.height} @${r.deviceScaleFactor}x → ${r.imageWidth}×${r.imageHeight} | ` +
      `${r.innerWidth}×${r.innerHeight} | ` +
      `${r.overflowX ? '⚠️ 横向溢出' : '✓ 无溢出'} | ${r.file}`
    )
  }
  const overflowCount = results.filter((r) => r.overflowX).length
  lines.push(`摘要：共 ${results.length} 个视口，其中 ${overflowCount} 个存在横向溢出（⚠️）。`)
  return lines.join('\n')
}
