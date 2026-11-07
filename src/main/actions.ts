import { WebContents, webContents } from 'electron'
import type { PageSnapshot, SnapshotElement, ToolContent } from '@shared/types'
import { __aaSnapshot } from '@snapshot/engine'
import {
  locateScript,
  inspectInputScript,
  syntheticClickScript,
  focusScript,
  clearScript,
  setValueScript,
  selectOptionScript,
  scrollScript,
  extractScript,
  containsTextScript,
  readValueScript,
  rectScript,
  selectorScript,
  storageScript,
  uploadScript,
  laserCursorScript
} from '@snapshot/scripts'
import type { Tab } from './tabs'

export class ActionError extends Error {}

/** 从 webContents 上执行注入的快照引擎（mode=full 强制完整快照，默认增量） */
export async function captureSnapshot(wc: WebContents, opts?: { mode?: 'full' | 'auto' }): Promise<PageSnapshot> {
  const source = `(${__aaSnapshot.toString()})(${JSON.stringify(opts ?? {})})`
  const snap = (await wc.executeJavaScript(source, false)) as PageSnapshot
  if (!snap || typeof snap !== 'object') {
    throw new ActionError('快照执行失败：页面未返回有效数据')
  }
  if ((snap as unknown as { error?: string }).error) {
    throw new ActionError(`快照执行失败：${(snap as unknown as { error: string }).error}`)
  }
  return snap
}

/** Agent 可读文本（引擎已在页面内拼好头部与模式标注） */
export function snapshotText(snap: PageSnapshot): string {
  return snap.tree || `页面快照 url: ${snap.url}\ntitle: ${snap.title}\n（页面无可渲染内容）`
}

export function findElement(snap: PageSnapshot, ref: string): SnapshotElement | null {
  return snap.elements.find((e) => e.ref === ref) ?? null
}

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** 等待页面加载稳定（导航结束 + 小缓冲），供动作后调用 */
async function settle(wc: WebContents): Promise<void> {
  try {
    if (wc.isLoading()) {
      await new Promise<void>((resolve) => {
        // SPA 导航或长轮询下避免死等 8 秒：缩减至 3500ms
        const timer = setTimeout(() => {
          wc.removeListener('did-stop-loading', onDone)
          resolve()
        }, 3500)
        const onDone = (): void => {
          clearTimeout(timer)
          wc.removeListener('did-stop-loading', onDone)
          resolve()
        }
        wc.once('did-stop-loading', onDone)
      })
    }
  } catch {
    /* 忽略 */
  }
  await delay(250)
}

/** 找到 tab 对应的 webContents（可指定 tabId，默认活动标签） */
export function resolveWebContents(tabs: { active: () => Tab | null; get: (id: string) => Tab | null }, tabId?: string): Tab {
  const tab = tabId ? tabs.get(tabId) : tabs.active()
  if (!tab) throw new ActionError(tabId ? `标签不存在: ${tabId}` : '浏览器没有打开的标签页')
  if (tab.view.webContents.isDestroyed()) throw new ActionError('页面已关闭')
  return tab
}

export async function doNavigate(
  tabs: { active: () => Tab | null; get: (id: string) => Tab | null; createTab: (url?: string) => Tab; assertUrlAllowed?: (url: string) => void },
  url: string,
  opts: { newTab?: boolean; tabId?: string }
): Promise<{ tabId: string; url: string; title: string }> {
  tabs.assertUrlAllowed?.(url)
  let tab: Tab | null = null
  if (opts.tabId) {
    tab = tabs.get(opts.tabId)
    if (!tab) throw new ActionError(`标签不存在: ${opts.tabId}`)
  } else if (opts.newTab) {
    tab = tabs.createTab(url)
  } else {
    tab = tabs.active() ?? tabs.createTab(url)
  }
  const wc = tab.view.webContents
  // 导航前确保抓包已启用（保证本次导航的请求都被捕获）
  await tab.net.ensure().catch(() => {})
  // loadURL 在打断进行中的导航时会抛出上一次导航的 ERR_ABORTED，
  // 因此不信任其 Promise，以"加载停止后的最终 URL"为准
  try {
    await wc.loadURL(url)
  } catch {
    /* ERR_ABORTED 等由下方 URL 校验兜底 */
  }
  await settle(wc)
  const finalUrl = wc.getURL() || ''
  const ok =
    finalUrl === url ||
    finalUrl === url + '/' ||
    (url.startsWith('file://') && finalUrl.replace(/\\/g, '/') === url.replace(/\\/g, '/'))
  if (!ok && finalUrl && !finalUrl.startsWith(url)) {
    // 未到达目标（如被重定向到完全不同的地址且非正常跳转）时仍放行常见情形
    const norm = (u: string): string => u.replace(/\/$/, '')
    if (norm(finalUrl) !== norm(url)) {
      throw new ActionError(`导航未到达目标：当前 ${finalUrl}，目标 ${url}`)
    }
  }
  return { tabId: tab.id, url: finalUrl || url, title: tab.title }
}

export async function doClick(
  tab: Tab,
  ref: string,
  wantSnapshot: boolean,
  opts?: { button?: 'left' | 'right' | 'middle'; clickCount?: number }
): Promise<{ clicked: string; snapshot?: PageSnapshot }> {
  const wc = tab.view.webContents
  const loc = (await wc.executeJavaScript(locateScript(ref), false)) as {
    ok: boolean
    reason?: string
    x?: number
    y?: number
    hitOk?: boolean
    tag?: string
    type?: string
    editable?: boolean
    checked?: boolean
  }
  if (!loc || !loc.ok) {
    const reason = loc?.reason ?? 'unknown'
    throw new ActionError(
      reason === 'no-ref'
        ? `找不到元素 ${ref}：页面可能已变化，请先重新调用 browser_snapshot`
        : `无法定位元素 ${ref}（${reason}）`
    )
  }

  const x = Math.max(0, loc.x ?? 0)
  const y = Math.max(0, loc.y ?? 0)
  const button = opts?.button ?? 'left'
  const clickCount = Math.max(1, Math.min(3, opts?.clickCount ?? 1))
  const actName = clickCount === 2 ? '双击' : button === 'right' ? '右键' : '点击'
  let clicked = `${loc.tag}${loc.type ? `[type=${loc.type}]` : ''} (${actName})`

  // 视觉激光波纹投影（让用户直观看到 AI 点击位置）
  void wc.executeJavaScript(laserCursorScript(x, y, 'click'), false).catch(() => {})

  if (loc.hitOk) {
    // 优先走真实输入事件（isTrusted=true，兼容防爬站点）
    wc.sendInputEvent({ type: 'mouseMove', x, y })
    wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount })
    wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount })
  } else {
    // 元素被遮挡 → 页面内合成事件兜底
    await wc.executeJavaScript(syntheticClickScript(ref, button), false)
  }

  await settle(wc)
  const snapshot = wantSnapshot ? await captureSnapshot(wc) : undefined
  return { clicked, snapshot }
}

/** 拖拽操作（支持从元素拖拽至目标元素，或指定相对偏移像素 dx, dy，适用于滑块/看板） */
export async function doDrag(
  tab: Tab,
  ref: string,
  opts: { toRef?: string; dx?: number; dy?: number; wantSnapshot?: boolean }
): Promise<{ dragged: string; snapshot?: PageSnapshot }> {
  const wc = tab.view.webContents
  const loc1 = (await wc.executeJavaScript(locateScript(ref), false)) as {
    ok: boolean
    reason?: string
    x?: number
    y?: number
    tag?: string
  }
  if (!loc1 || !loc1.ok) {
    throw new ActionError(`找不到拖拽起始元素 ${ref}`)
  }

  const x1 = Math.max(0, loc1.x ?? 0)
  const y1 = Math.max(0, loc1.y ?? 0)
  let x2 = x1
  let y2 = y1

  if (opts.toRef) {
    const loc2 = (await wc.executeJavaScript(locateScript(opts.toRef), false)) as {
      ok: boolean
      reason?: string
      x?: number
      y?: number
    }
    if (!loc2 || !loc2.ok) throw new ActionError(`找不到拖拽目标元素 ${opts.toRef}`)
    x2 = Math.max(0, loc2.x ?? 0)
    y2 = Math.max(0, loc2.y ?? 0)
  } else if (opts.dx != null || opts.dy != null) {
    x2 = Math.max(0, x1 + (opts.dx ?? 0))
    y2 = Math.max(0, y1 + (opts.dy ?? 0))
  } else {
    throw new ActionError('拖拽操作必须指定 toRef 目标元素或 dx/dy 偏移像素')
  }

  // 播放起始与终点光标
  void wc.executeJavaScript(laserCursorScript(x1, y1, 'drag'), false).catch(() => {})
  void wc.executeJavaScript(laserCursorScript(x2, y2, 'drag'), false).catch(() => {})

  // 模拟真实轨迹平滑拖动（5 步插值）
  wc.sendInputEvent({ type: 'mouseMove', x: x1, y: y1 })
  wc.sendInputEvent({ type: 'mouseDown', x: x1, y: y1, button: 'left', clickCount: 1 })
  await delay(50)

  const steps = 7
  for (let i = 1; i <= steps; i++) {
    const curX = Math.round(x1 + ((x2 - x1) * i) / steps)
    const curY = Math.round(y1 + ((y2 - y1) * i) / steps)
    wc.sendInputEvent({ type: 'mouseMove', x: curX, y: curY })
    await delay(20)
  }

  wc.sendInputEvent({ type: 'mouseUp', x: x2, y: y2, button: 'left', clickCount: 1 })
  await settle(wc)

  const snapshot = opts.wantSnapshot ? await captureSnapshot(wc) : undefined
  return { dragged: `从 (${x1},${y1}) 拖动至 (${x2},${y2})`, snapshot }
}

export async function inspectTypeTarget(tab: Tab, ref: string): Promise<{ ok: boolean; sensitive?: boolean; label?: string; type?: string; fingerprint?: string }> {
  return await tab.view.webContents.executeJavaScript(inspectInputScript(ref), false) as { ok: boolean; sensitive?: boolean; label?: string; type?: string; fingerprint?: string }
}

export async function doType(
  tab: Tab,
  ref: string,
  text: string,
  opts: { submit?: boolean; clear?: boolean; wantSnapshot?: boolean }
): Promise<{ typed: string; snapshot?: PageSnapshot }> {
  const wc = tab.view.webContents
  const focus = (await wc.executeJavaScript(focusScript(ref), false)) as {
    ok: boolean
    reason?: string
    tag?: string
    type?: string
    editable?: boolean
  }
  if (!focus || !focus.ok) {
    const reason = focus?.reason ?? 'unknown'
    throw new ActionError(
      reason === 'no-ref'
        ? `找不到元素 ${ref}：页面可能已变化，请先重新调用 browser_snapshot`
        : `无法聚焦元素 ${ref}（${reason}）`
    )
  }
  const tag = focus.tag ?? 'unknown'
  if (['checkbox', 'radio', 'button', 'submit', 'file'].includes(focus.type ?? '')) {
    throw new ActionError(
      `元素 ${ref} 是 ${focus.type} 类型，不支持输入文本；请改用 browser_click 或 browser_select_option`
    )
  }

  if (opts.clear) {
    await wc.executeJavaScript(clearScript(ref), false)
  }

  // 首选 insertText（走真实输入管线），失败则用原生 setter 兜底（React 受控输入兼容）
  let inserted = false
  try {
    await wc.insertText(text)
    const check = (await wc.executeJavaScript(readValueScript(ref), false)) as {
      ok: boolean
      value?: string
    }
    if (check?.ok && (check.value ?? '').endsWith(text)) inserted = true
  } catch {
    inserted = false
  }
  if (!inserted) {
    await wc.executeJavaScript(setValueScript(ref, text), false)
  }
  const typed = `${tag}${inserted ? '' : '（setter 兜底写入）'}`

  if (opts.submit) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  }

  await settle(wc)
  const snapshot = opts.wantSnapshot ? await captureSnapshot(wc) : undefined
  return { typed, snapshot }
}

export async function doSelectOption(
  tab: Tab,
  ref: string,
  opts: { value?: string; label?: string; wantSnapshot?: boolean }
): Promise<{ selected: string; snapshot?: PageSnapshot }> {
  const wc = tab.view.webContents
  const result = (await wc.executeJavaScript(selectOptionScript(ref, opts.value, opts.label), false)) as {
    ok: boolean
    reason?: string
    value?: string
    label?: string
    options?: { value: string; label: string }[]
    tag?: string
  }
  if (!result || !result.ok) {
    if (result?.reason === 'no-ref') {
      throw new ActionError(`找不到元素 ${ref}：页面可能已变化，请先重新调用 browser_snapshot`)
    }
    if (result?.reason === 'not-select') {
      throw new ActionError(`元素 ${ref} 不是下拉框（是 ${result.tag}）`)
    }
    const list = result?.options?.map((o) => `"${o.label}"`).join('、') ?? ''
    throw new ActionError(`下拉框中找不到匹配项（value=${opts.value ?? ''}, label=${opts.label ?? ''}）。可选：${list}`)
  }
  await settle(wc)
  const snapshot = opts.wantSnapshot ? await captureSnapshot(wc) : undefined
  return { selected: `${result.value}${result.label !== result.value ? ` (${result.label})` : ''}`, snapshot }
}

export async function doScroll(
  tab: Tab,
  direction: string,
  amount: number,
  wantSnapshot: boolean
): Promise<{ where: string; snapshot?: PageSnapshot }> {
  const wc = tab.view.webContents
  const result = (await wc.executeJavaScript(scrollScript(direction, amount), false)) as {
    ok: boolean
    where?: string
  }
  await delay(200)
  const snapshot = wantSnapshot ? await captureSnapshot(wc) : undefined
  return { where: result?.where ?? 'unknown', snapshot }
}

export async function doExtract(tab: Tab, ref?: string): Promise<{ text: string; url?: string; title?: string }> {
  const wc = tab.view.webContents
  const MAX_TEXT = 20000
  const result = (await wc.executeJavaScript(extractScript(ref), false)) as {
    ok: boolean
    reason?: string
    text?: string
    url?: string
    title?: string
  }
  if (!result || !result.ok) {
    if (result?.reason === 'no-ref') {
      throw new ActionError(`找不到元素 ${ref}：请先重新调用 browser_snapshot`)
    }
    throw new ActionError(`提取失败（${result?.reason ?? 'unknown'}）`)
  }
  const text = (result.text ?? '').trim()
  return {
    text: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + '\n…（内容过长已截断）' : text,
    url: result.url,
    title: result.title
  }
}

export async function doWaitForText(tab: Tab, text: string, timeoutMs: number): Promise<{ found: boolean; elapsedMs: number }> {
  const wc = tab.view.webContents
  const script = containsTextScript(text)
  const start = Date.now()
  const deadline = start + Math.min(30000, Math.max(1000, timeoutMs))
  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const found = (await wc.executeJavaScript(script, false)) as boolean
      if (found) return { found: true, elapsedMs: Date.now() - start }
    } catch {
      /* 页面导航中，继续等 */
    }
    if (Date.now() >= deadline) return { found: false, elapsedMs: Date.now() - start }
    await delay(250)
  }
}

const VALID_KEYS = new Set([
  'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End',
  'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'Space'
])

export async function doPressKey(tab: Tab, key: string): Promise<{ pressed: string }> {
  const wc = tab.view.webContents
  const k = key.trim()
  if (VALID_KEYS.has(k)) {
    if (k === 'Space') {
      wc.sendInputEvent({ type: 'keyDown', keyCode: ' ' })
      wc.sendInputEvent({ type: 'keyUp', keyCode: ' ' })
    } else {
      wc.sendInputEvent({ type: 'keyDown', keyCode: k })
      wc.sendInputEvent({ type: 'keyUp', keyCode: k })
    }
    await delay(120)
    return { pressed: k }
  }
  if (/^[a-zA-Z0-9]$/.test(k)) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: k })
    wc.sendInputEvent({ type: 'char', keyCode: k })
    wc.sendInputEvent({ type: 'keyUp', keyCode: k })
    await delay(120)
    return { pressed: k }
  }
  throw new ActionError(`不支持的按键: ${key}（支持 Enter/Escape/Tab/Arrow*/F1-F12/单字符等）`)
}

export async function doScreenshot(tab: Tab): Promise<ToolContent> {
  const wc = tab.view.webContents
  // capturePage 偶发 UnknownVizError（合成器首帧未就绪）：聚焦 + 重试
  let image: Electron.NativeImage | null = null
  try {
    wc.focus()
  } catch {
    /* 忽略 */
  }
  for (let i = 0; i < 3; i++) {
    try {
      image = await wc.capturePage()
      if (!image.isEmpty()) break
    } catch {
      image = null
    }
    await delay(300)
  }
  if (!image || image.isEmpty()) {
    throw new ActionError('截图失败：页面合成器未就绪，请稍后重试')
  }
  let img = image
  const size = image.getSize()
  if (size.width > 1440) {
    img = image.resize({ width: 1440 })
  }
  const base64 = img.toPNG().toString('base64')
  return { type: 'image', data: base64, mimeType: 'image/png' }
}

export function doConsoleLogs(
  tab: Tab,
  opts: { level?: string; limit?: number }
): { logs: { level: string; text: string; ts: number }[] } {
  let logs = tab.consoleBuf
  if (opts.level && opts.level !== 'all') {
    const lv = opts.level.toLowerCase()
    logs = logs.filter((l) => {
      // Electron console level: 0 verbose, 1 info, 2 warning, 3 error（数字形态）或字符串
      if (lv === 'error') return l.level === 'error' || l.level === '3'
      if (lv === 'warning' || lv === 'warn') return l.level === 'warning' || l.level === 'warn' || l.level === '2'
      if (lv === 'info') return l.level === 'info' || l.level === 'log' || l.level === '1'
      return l.level === lv
    })
  }
  const limit = Math.min(100, Math.max(1, opts.limit ?? 50))
  return { logs: logs.slice(-limit) }
}

/** 确保所有 webContents 的引用有效（未使用则无需导入警告） */
export function allWebContents(): WebContents[] {
  return webContents.getAllWebContents()
}

/* ────────── v0.4.0 新增动作 ────────── */

/** 悬停：真实 mouseMove 路径（触发菜单/提示展开） */
export async function doHover(tab: Tab, ref: string): Promise<{ hovered: string }> {
  const wc = tab.view.webContents
  const loc = (await wc.executeJavaScript(locateScript(ref), false)) as {
    ok: boolean
    reason?: string
    x?: number
    y?: number
    hitOk?: boolean
    tag?: string
  }
  if (!loc || !loc.ok) {
    const reason = loc?.reason ?? 'unknown'
    throw new ActionError(
      reason === 'no-ref'
        ? `找不到元素 ${ref}：页面可能已变化，请先重新调用 browser_snapshot`
        : `无法定位元素 ${ref}（${reason}）`
    )
  }
  const x = Math.max(0, loc.x ?? 0)
  const y = Math.max(0, loc.y ?? 0)
  void wc.executeJavaScript(laserCursorScript(x, y, 'hover'), false).catch(() => {})
  wc.sendInputEvent({ type: 'mouseMove', x, y })
  await delay(150)
  return { hovered: `${loc.tag} @(${x},${y})` }
}

/** 历史后退/前进（含快照）。bfcache 恢复可能没有 loading 事件：等待 URL 真正切换后再快照 */
export async function doNavigateHistory(
  tab: Tab,
  dir: 'back' | 'forward',
  wantSnapshot: boolean,
  go: (t: Tab) => void,
  canGo: (t: Tab) => boolean
): Promise<{ moved: boolean; snapshot?: PageSnapshot }> {
  if (!canGo(tab)) throw new ActionError(`没有可${dir === 'back' ? '后退' : '前进'}的历史记录`)
  const wc = tab.view.webContents
  const urlBefore = wc.getURL()
  go(tab)
  await settle(wc)
  // 等 URL 稳定（最多 3s）：back/forward 的页面恢复可能异步完成
  const deadline = Date.now() + 3000
  while (Date.now() < deadline) {
    const urlNow = wc.getURL()
    if (urlNow && urlNow !== urlBefore) break
    if (!wc.isLoading() && urlNow && urlNow !== urlBefore) break
    await delay(150)
  }
  await delay(400)
  const snapshot = wantSnapshot ? await captureSnapshot(wc) : undefined
  return { moved: true, snapshot }
}

/** 页面内文本查找：高亮并跳到第一处（返回匹配数） */
export async function doFind(
  tab: Tab,
  text: string,
  timeoutMs = 4000
): Promise<{ matches: number; activeOrdinal: number | null }> {
  const wc = tab.view.webContents
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      wc.removeListener('found-in-page', onFound)
      reject(new ActionError('查找超时（页面未响应 findInPage）'))
    }, timeoutMs)
    const onFound = (_e: unknown, result: { matches: number; activeMatchOrdinal: number }): void => {
      clearTimeout(timer)
      wc.removeListener('found-in-page', onFound)
      resolve({ matches: result.matches, activeOrdinal: result.activeMatchOrdinal })
    }
    wc.on('found-in-page', onFound)
    try {
      wc.findInPage(text, { findNext: false })
    } catch (err) {
      clearTimeout(timer)
      wc.removeListener('found-in-page', onFound)
      reject(new ActionError(`查找失败：${(err as Error).message}`))
    }
  })
}

/** 视口（窗口内容区）调整 */
export async function doResize(
  tab: Tab,
  resizeWindow: (w: number, h: number) => Promise<{ width: number; height: number }>,
  width: number,
  height: number
): Promise<{ width: number; height: number }> {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 200 || height < 200 || width > 5000 || height > 5000) {
    throw new ActionError('尺寸需在 200–5000 之间')
  }
  await delay(50)
  const r = await resizeWindow(Math.round(width), Math.round(height))
  await delay(250)
  void tab // 布局会同步调整活动页视图
  return r
}

/** 元素级截图：定位 → 整页截图 → 按 bbox 裁剪 */
export async function doElementScreenshot(tab: Tab, ref: string): Promise<ToolContent> {
  const wc = tab.view.webContents
  const rect = (await wc.executeJavaScript(rectScript(ref), false)) as {
    ok: boolean
    reason?: string
    x?: number
    y?: number
    width?: number
    height?: number
  }
  if (!rect || !rect.ok) {
    throw new ActionError(
      rect?.reason === 'no-ref'
        ? `找不到元素 ${ref}：页面可能已变化，请先重新调用 browser_snapshot`
        : `无法定位元素 ${ref}（${rect?.reason ?? 'unknown'}）`
    )
  }
  try {
    wc.focus()
  } catch {
    /* 忽略 */
  }
  let image: Electron.NativeImage | null = null
  for (let i = 0; i < 3; i++) {
    try {
      image = await wc.capturePage()
      if (!image.isEmpty()) break
    } catch {
      image = null
    }
    await delay(300)
  }
  if (!image || image.isEmpty()) throw new ActionError('截图失败：页面合成器未就绪，请稍后重试')
  const vp = (await wc.executeJavaScript('({ w: window.innerWidth, h: window.innerHeight })', false)) as {
    w: number
    h: number
  }
  const size = image.getSize()
  const sx = size.width / Math.max(1, vp.w)
  const sy = size.height / Math.max(1, vp.h)
  const cropX = Math.min(size.width - 1, Math.max(0, Math.round((rect.x ?? 0) * sx)))
  const cropY = Math.min(size.height - 1, Math.max(0, Math.round((rect.y ?? 0) * sy)))
  const cropW = Math.max(1, Math.min(Math.round((rect.width ?? 1) * sx), size.width - cropX))
  const cropH = Math.max(1, Math.min(Math.round((rect.height ?? 1) * sy), size.height - cropY))
  const cropped = image.crop({ x: cropX, y: cropY, width: cropW, height: cropH })
  return { type: 'image', data: cropped.toPNG().toString('base64'), mimeType: 'image/png' }
}

/** Cookie 读/写/清（会话级，覆盖所有标签的站点） */
export async function doCookies(
  tab: Tab,
  opts: {
    action: 'get' | 'set' | 'clear'
    url?: string
    name?: string
    value?: string
    domain?: string
    path?: string
    secure?: boolean
    httpOnly?: boolean
    expiresSeconds?: number
  }
): Promise<{ content: string }> {
  const session = tab.view.webContents.session
  try {
    if (opts.action === 'get') {
      const filter = opts.url ? { url: opts.url } : {}
      const cookies = await session.cookies.get(filter as never)
      const list = cookies
        .filter((c) => !opts.name || c.name === opts.name)
        .map(
          (c) =>
            `${c.name}=${c.value.length > 60 ? c.value.slice(0, 60) + '…' : c.value}` +
            `  (domain=${c.domain ?? ''}${c.httpOnly ? ' httpOnly' : ''}${c.secure ? ' secure' : ''})`
        )
      return { content: list.length ? `共 ${list.length} 条：\n${list.join('\n')}` : '（无匹配 Cookie）' }
    }
    if (opts.action === 'set') {
      if (!opts.url || !opts.name || opts.value === undefined) {
        throw new ActionError('set 需要 url、name、value')
      }
      const details: Record<string, unknown> = {
        url: opts.url,
        name: opts.name,
        value: opts.value,
        secure: opts.secure ?? opts.url.startsWith('https'),
        httpOnly: opts.httpOnly ?? false
      }
      if (opts.domain) details['domain'] = opts.domain
      if (opts.path) details['path'] = opts.path
      if (opts.expiresSeconds) details['expirationDate'] = Math.floor(Date.now() / 1000) + opts.expiresSeconds
      await session.cookies.set(details as never)
      return { content: `已写入 Cookie ${opts.name}（${opts.url}）` }
    }
    // clear
    const cookies = await session.cookies.get({})
    let n = 0
    for (const c of cookies) {
      if (opts.name && c.name !== opts.name) continue
      const domain = c.domain ?? ''
      if (opts.domain && !domain.includes(opts.domain)) continue
      const scheme = c.secure ? 'https' : 'http'
      await session.cookies.remove(`${scheme}://${domain.replace(/^\./, '')}${c.path ?? '/'}`, c.name)
      n++
    }
    return { content: `已清除 ${n} 条${opts.name ? ` ${opts.name}` : ''} Cookie` }
  } catch (err) {
    throw new ActionError(`Cookie 操作失败：${(err as Error).message}`)
  }
}

/** localStorage / sessionStorage 读写 */
export async function doStorage(
  tab: Tab,
  opts: { action: 'get' | 'set' | 'remove' | 'clear'; kind: 'local' | 'session'; key?: string; value?: string }
): Promise<{ content: string }> {
  const wc = tab.view.webContents
  const result = (await wc.executeJavaScript(storageScript(opts.action, opts.kind, opts.key, opts.value), false)) as {
    ok: boolean
    reason?: string
    key?: string
    value?: string | null
    count?: number
    values?: Record<string, string>
    truncated?: boolean
  }
  if (!result?.ok) throw new ActionError(`存储操作失败（${result?.reason ?? 'unknown'}）`)
  if (opts.action === 'get') {
    if (opts.key != null) return { content: `${opts.key} = ${result.value ?? '（空）'}` }
    const entries = Object.entries(result.values ?? {})
    return {
      content: entries.length
        ? `共 ${result.count} 项（显示 ${entries.length}${result.truncated ? '，已截断' : ''}）：\n` +
          entries.map(([k, v]) => `  ${k} = ${v}`).join('\n')
        : `（${opts.kind === 'session' ? 'sessionStorage' : 'localStorage'} 为空）`
    }
  }
  return { content: `已${opts.action === 'set' ? '写入' : opts.action === 'remove' ? '移除' : '清空'} ${opts.kind === 'session' ? 'sessionStorage' : 'localStorage'}` }
}

/** 文件上传（input[type=file]），paths 为本机绝对路径 */
export async function doUploadFile(tab: Tab, ref: string, paths: string[]): Promise<{ content: string }> {
  const fs = await import('node:fs')
  const pathMod = await import('node:path')
  const files: { name: string; type: string; data: string }[] = []
  let total = 0
  for (const p of paths) {
    const stat = fs.statSync(p)
    if (!stat.isFile()) throw new ActionError(`不是文件: ${p}`)
    total += stat.size
    if (total > 20 * 1024 * 1024) throw new ActionError('上传文件总大小超过 20MB 限制')
    const ext = pathMod.extname(p).toLowerCase()
    const mime =
      ext === '.png'
        ? 'image/png'
        : ext === '.jpg' || ext === '.jpeg'
          ? 'image/jpeg'
          : ext === '.gif'
            ? 'image/gif'
            : ext === '.pdf'
              ? 'application/pdf'
              : ext === '.json'
                ? 'application/json'
                : ext === '.txt'
                  ? 'text/plain'
                  : 'application/octet-stream'
    files.push({ name: pathMod.basename(p), type: mime, data: fs.readFileSync(p).toString('base64') })
  }
  const wc = tab.view.webContents
  const result = (await wc.executeJavaScript(uploadScript(ref, files), false)) as {
    ok: boolean
    reason?: string
    tag?: string
    type?: string
    count?: number
    names?: string[]
  }
  if (!result?.ok) {
    if (result?.reason === 'no-ref') throw new ActionError(`找不到元素 ${ref}：请先重新调用 browser_snapshot`)
    if (result?.reason === 'not-file-input') {
      throw new ActionError(`元素 ${ref} 不是文件上传控件（是 ${result.tag}[type=${result.type}]）`)
    }
    throw new ActionError(`上传失败（${result?.reason ?? 'unknown'}）`)
  }
  await settle(wc)
  return { content: `已上传 ${result.count} 个文件: ${(result.names ?? []).join('、')}` }
}

/** 页面存 PDF */
export async function doPdf(tab: Tab, filePath?: string, landscape = false): Promise<{ savedPath: string }> {
  const wc = tab.view.webContents
  const pdf = await wc.printToPDF({ printBackground: true, landscape, pageSize: 'A4' } as never)
  const osMod = await import('node:os')
  const pathMod = await import('node:path')
  const fsMod = await import('node:fs')
  const file = filePath || pathMod.join(process.env['AA_BROWSER_DOWNLOAD_DIR'] || pathMod.join(osMod.homedir(), '.aabrowser', 'downloads'), `aa-page-${Date.now()}.pdf`)
  fsMod.mkdirSync(pathMod.dirname(file), { recursive: true })
  fsMod.writeFileSync(file, pdf)
  return { savedPath: file }
}

/** 元素 CSS 选择器导出（BrowserTools 风格，含回验） */
export async function doGetSelector(tab: Tab, ref: string): Promise<{ selector: string; verified: boolean; text: string }> {
  const wc = tab.view.webContents
  const result = (await wc.executeJavaScript(selectorScript(ref), false)) as {
    ok: boolean
    reason?: string
    selector?: string
    verified?: boolean
    text?: string
  }
  if (!result?.ok) {
    throw new ActionError(
      result?.reason === 'no-ref'
        ? `找不到元素 ${ref}：请先重新调用 browser_snapshot`
        : `选择器生成失败（${result?.reason ?? 'unknown'}）`
    )
  }
  return { selector: result.selector ?? '', verified: !!result.verified, text: result.text ?? '' }
}
