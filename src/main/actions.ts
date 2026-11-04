import { WebContents, webContents } from 'electron'
import type { PageSnapshot, SnapshotElement, ToolContent } from '@shared/types'
import { __aaSnapshot } from '@snapshot/engine'
import {
  locateScript,
  syntheticClickScript,
  focusScript,
  clearScript,
  setValueScript,
  selectOptionScript,
  scrollScript,
  extractScript,
  containsTextScript,
  readValueScript
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
        const timer = setTimeout(() => {
          wc.removeListener('did-stop-loading', onDone)
          resolve()
        }, 8000)
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
  await delay(350)
}

/** 找到 tab 对应的 webContents（可指定 tabId，默认活动标签） */
export function resolveWebContents(tabs: { active: () => Tab | null; get: (id: string) => Tab | null }, tabId?: string): Tab {
  const tab = tabId ? tabs.get(tabId) : tabs.active()
  if (!tab) throw new ActionError(tabId ? `标签不存在: ${tabId}` : '浏览器没有打开的标签页')
  if (tab.view.webContents.isDestroyed()) throw new ActionError('页面已关闭')
  return tab
}

export async function doNavigate(
  tabs: { active: () => Tab | null; get: (id: string) => Tab | null; createTab: (url?: string) => Tab },
  url: string,
  opts: { newTab?: boolean; tabId?: string }
): Promise<{ tabId: string; url: string; title: string }> {
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
  wantSnapshot: boolean
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
  let clicked = `${loc.tag}${loc.type ? `[type=${loc.type}]` : ''}`

  if (loc.hitOk) {
    // 优先走真实输入事件（isTrusted=true，兼容防爬站点）
    wc.sendInputEvent({ type: 'mouseMove', x, y })
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
  } else {
    // 元素被遮挡 → 页面内合成事件兜底
    await wc.executeJavaScript(syntheticClickScript(ref), false)
  }

  await settle(wc)
  const snapshot = wantSnapshot ? await captureSnapshot(wc) : undefined
  return { clicked, snapshot }
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
