import { WebContents, webContents, nativeImage } from 'electron'
import { AsyncLocalStorage } from 'node:async_hooks'
import type { SnapshotSummary, ToolContent } from '@shared/types'
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
  clickScript,
  refLiteral,
  jsLiteral,
  laserCursorScript
} from '@snapshot/scripts'
import type { Tab, TabManager } from './tabs'
import { reportProgress } from './progress'
import { getEvidenceManager } from './evidence'

export class ActionError extends Error {}

/**
 * 中断检查：长操作在每一步开始前调用，用户一旦中断就立刻停止，
 * 而不是等操作自然跑完再报“已取消”（那样副作用已经发生）。
 */
export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ActionError('工具调用已被用户中断。')
}

// 队列只以 Tab 对象为键；不修改 Tab，也不把不同标签页串成全局锁。
const tabQueues = new WeakMap<Tab, Promise<void>>()
const tabQueueContext = new AsyncLocalStorage<{ inFlight: Set<Promise<unknown>> }>()

function trackTabOperation<T>(work: Promise<T>): void {
  const context = tabQueueContext.getStore()
  if (!context) return
  context.inFlight.add(work)
  // 仅用于移除已完成任务；同时处理拒绝，避免派生未处理拒绝。
  void work.then(
    () => context.inFlight.delete(work),
    () => context.inFlight.delete(work)
  )
}

async function drainTabOperations(context: { inFlight: Set<Promise<unknown>> }): Promise<void> {
  while (context.inFlight.size) {
    await Promise.allSettled([...context.inFlight])
  }
}

async function awaitWithAbort<T>(work: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return await work
  if (signal.aborted) throw new ActionError('工具调用已被用户中断。')
  return await new Promise<T>((resolve, reject) => {
    const onAbort = (): void => {
      signal.removeEventListener('abort', onAbort)
      reject(new ActionError('工具调用已被用户中断。'))
    }
    signal.addEventListener('abort', onAbort, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      }
    )
  })
}

/**
 * 同一标签页的 MCP 页面操作按到达顺序执行；不同标签页并行。
 * 排队取消立即返回，但取消节点仍须等前驱完成才能向后交棒。
 * 运行中取消会立即返回给调用者；锁槽则等待 run 和在锁上下文中经 raceAbort
 * 登记的原始操作 Promise 全部结束后才释放，避免取消回调抢跑后重叠页面操作。
 * 未 await 且未登记、或脱离此异步上下文启动的工作不在此接口保证范围内。
 */
export async function withTabLock<T>(
  tab: Tab,
  signal: AbortSignal | undefined,
  run: () => Promise<T>
): Promise<T> {
  throwIfAborted(signal)
  if (tab.view.webContents.isDestroyed()) throw new ActionError('页面已关闭')
  const prev = tabQueues.get(tab) ?? Promise.resolve()
  let release!: () => void
  const slot = new Promise<void>((resolve) => { release = resolve })
  // 即使本调用在等待时取消并 release，后继仍必须等 prev；队尾永不拒绝。
  const tail = prev.then(() => slot)
  tabQueues.set(tab, tail)
  void tail.then(() => {
    if (tabQueues.get(tab) === tail) tabQueues.delete(tab)
  })
  let started = false
  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        signal?.removeEventListener('abort', onAbort)
        reject(new ActionError('工具调用已被用户中断。'))
      }
      if (signal?.aborted) {
        onAbort()
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      void prev.then(() => {
        signal?.removeEventListener('abort', onAbort)
        resolve()
      })
    })
    throwIfAborted(signal)
    // 排队期间页面可能已被关闭，不能只在入队时检查。
    if (tab.view.webContents.isDestroyed()) throw new ActionError('页面已关闭')

    const context = { inFlight: new Set<Promise<unknown>>() }
    const runPromise = tabQueueContext.run(context, () => Promise.resolve().then(() => {
      throwIfAborted(signal)
      return run()
    }))
    started = true
    const finished = runPromise.then(
      async (value) => {
        try {
          await drainTabOperations(context)
        } finally {
          release()
        }
        return { ok: true as const, value }
      },
      async (error: unknown) => {
        try {
          await drainTabOperations(context)
        } finally {
          release()
        }
        return { ok: false as const, error }
      }
    )
    const result = await awaitWithAbort(finished, signal)
    if (!result.ok) throw result.error
    return result.value
  } finally {
    // 尚未启动 run 的取消/关闭路径不持有正在执行的工作。
    if (!started) release()
  }
}

/** 把可能很长的 Promise 与中断信号竞速；中断时执行 onAbort（如停止页面加载）后立即失败 */
export async function raceAbort<T>(
  work: Promise<T>,
  signal?: AbortSignal,
  onAbort?: () => void
): Promise<T> {
  trackTabOperation(work)
  if (!signal) return work
  if (signal.aborted) {
    throw new ActionError('工具调用已被用户中断。')
  }
  return await new Promise<T>((resolve, reject) => {
    const handle = (): void => {
      try {
        onAbort?.()
      } catch {
        /* 页面可能已关闭 */
      }
      reject(new ActionError('工具调用已被用户中断。'))
    }
    signal.addEventListener('abort', handle, { once: true })
    work.then(
      (value) => {
        signal.removeEventListener('abort', handle)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', handle)
        reject(error)
      }
    )
  })
}

/** 从 webContents 上执行注入的快照引擎（mode=full 强制完整快照，默认增量） */
const snapshotEngineSource = __aaSnapshot.toString()

export async function captureSnapshot(
  wc: WebContents,
  opts?: { mode?: 'full' | 'auto'; maxNodes?: number; cursor?: number }
): Promise<SnapshotSummary> {
  const source = `(${snapshotEngineSource})(${jsLiteral({ ...opts, includeElements: false })})`
  const snap = (await wc.executeJavaScript(source, false)) as (SnapshotSummary & { error?: string }) | null
  if (!snap || typeof snap !== 'object') {
    throw new ActionError('快照执行失败：页面未返回有效数据')
  }
  if (snap.error) {
    throw new ActionError(`快照执行失败：${snap.error}`)
  }
  return snap
}

/** Agent 可读文本（引擎已在页面内拼好头部与模式标注） */
export function snapshotText(snap: SnapshotSummary): string {
  return snap.tree || `页面快照 url: ${snap.url}\ntitle: ${snap.title}\n（页面无可渲染内容）`
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

/**
 * 点击送达探针。
 *
 * `webContents.sendInputEvent` 注入的鼠标事件偶发不会进入渲染进程——实测同一坐标
 * 上一次生效、下一次静默丢失，而调用本身仍然"成功"返回。对 Agent 来说这就是
 * "点了但页面没反应"，且无法从返回值察觉。因此点击后必须回验页面是否真的收到 click。
 */
async function armClickProbe(wc: WebContents, ref: string): Promise<boolean> {
  try {
    return (await wc.executeJavaScript(
      `(() => {
        const el = (window.__aaRefs || {})[${refLiteral(ref)}]
        if (!el) return false
        window.__aaClickProbe = { fired: false }
        el.addEventListener('click', () => { window.__aaClickProbe.fired = true }, { once: true, capture: true })
        return true
      })()`,
      false
    )) as boolean
  } catch {
    return false
  }
}

/** 读取探针；null 表示无法判定（上下文已销毁且 URL 未变） */
async function readClickProbe(wc: WebContents, urlBefore: string): Promise<boolean | null> {
  try {
    const fired = (await wc.executeJavaScript(
      `(() => { const p = window.__aaClickProbe; return p ? !!p.fired : null })()`,
      false
    )) as boolean | null
    return fired
  } catch {
    // 上下文被销毁：通常是点击触发了导航，等同于点击已送达
    return wc.getURL() !== urlBefore ? true : null
  }
}

/** 轮询探针，等待 click 事件被页面处理 */
async function waitClickProbe(wc: WebContents, urlBefore: string, signal?: AbortSignal): Promise<boolean | null> {
  const deadline = Date.now() + 700
  let last: boolean | null = null
  while (Date.now() < deadline) {
    await delay(60)
    throwIfAborted(signal)
    last = await readClickProbe(wc, urlBefore)
    throwIfAborted(signal)
    if (last === true) return true
    if (wc.getURL() !== urlBefore) return true
  }
  return last
}

/** 找到 tab 对应的 webContents（可指定 tabId，默认活动标签） */export function resolveWebContents(tabs: { active: () => Tab | null; get: (id: string) => Tab | null }, tabId?: string): Tab {
  const tab = tabId ? tabs.get(tabId) : tabs.active()
  if (!tab) throw new ActionError(tabId ? `标签不存在: ${tabId}` : '浏览器没有打开的标签页')
  if (tab.view.webContents.isDestroyed()) throw new ActionError('页面已关闭')
  return tab
}

export async function doNavigate(
  tabs: TabManager,
  url: string,
  opts: {
    newTab?: boolean
    tabId?: string
    signal?: AbortSignal
    onComplete?: (tab: Tab, signal?: AbortSignal) => Promise<void>
  }
): Promise<{ tabId: string; url: string; title: string }> {
  reportProgress(0, 1, '正在导航')
  throwIfAborted(opts.signal)
  tabs.assertUrlAllowed(url)
  const existing = opts.tabId ? tabs.get(opts.tabId) : opts.newTab ? null : tabs.active()
  if (opts.tabId && !existing) throw new ActionError(`标签不存在: ${opts.tabId}`)
  const tab = existing ?? tabs.createTab(url, true, undefined, true)
  return await withTabLock(tab, opts.signal, async () => {
    const load = tabs.navigate(tab, url, true, opts.signal)
    const result = await navigateInTab(tab, load, opts.signal)
    throwIfAborted(opts.signal)
    if (opts.onComplete) await opts.onComplete(tab, opts.signal)
    throwIfAborted(opts.signal)
    return result
  })
}

async function navigateInTab(
  tab: Tab,
  load: Promise<void>,
  signal: AbortSignal | undefined
): Promise<{ tabId: string; url: string; title: string }> {
  const wc = tab.view.webContents
  try {
    // 中断时停止加载，避免“用户已中断但页面继续跳转”的副作用
    await raceAbort(load, signal, () => {
      try {
        wc.stop()
      } catch {
        /* 已销毁 */
      }
    })
  } catch (error) {
    throw new ActionError(`导航失败：${error instanceof Error ? error.message : String(error)}`)
  }
  if (wc.isDestroyed()) throw new ActionError('页面已关闭')
  reportProgress(1, 1, '导航完成')
  return { tabId: tab.id, url: wc.getURL(), title: wc.getTitle() }
}

export async function doClick(
  tab: Tab,
  ref: string,
  wantSnapshot: boolean,
  opts?: { button?: 'left' | 'right' | 'middle'; clickCount?: number; signal?: AbortSignal }
): Promise<{ clicked: string; snapshot?: SnapshotSummary }> {
  const signal = opts?.signal
  throwIfAborted(signal)
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
  throwIfAborted(signal)
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

  const urlBefore = wc.getURL()
  const probeArmed = button === 'left' && (await armClickProbe(wc, ref))
  throwIfAborted(signal)
  if (loc.hitOk) {
    // 优先走真实输入事件（isTrusted=true，兼容防爬站点）
    wc.sendInputEvent({ type: 'mouseMove', x, y })
    wc.sendInputEvent({ type: 'mouseDown', x, y, button, clickCount })
    wc.sendInputEvent({ type: 'mouseUp', x, y, button, clickCount })
  } else {
    // 元素被遮挡 → 页面内合成事件兜底
    if (button === 'left' && (loc.type === 'checkbox' || loc.type === 'radio')) {
      // 合成 MouseEvent 不会执行 checkbox/radio 的默认切换行为。
      await wc.executeJavaScript(clickScript(ref), false)
    } else {
      await wc.executeJavaScript(syntheticClickScript(ref, button), false)
    }
  }

  throwIfAborted(signal)
  if (probeArmed) {
    const delivered = await waitClickProbe(wc, urlBefore, signal)
    throwIfAborted(signal)
    if (delivered !== true) {
      // sendInputEvent 偶发静默丢失；补发页面点击，避免“调用成功但页面没动”。
      if (loc.type === 'checkbox' || loc.type === 'radio') {
        await wc.executeJavaScript(clickScript(ref), false)
      } else {
        await wc.executeJavaScript(syntheticClickScript(ref, button), false)
      }
    }
  }

  throwIfAborted(signal)
  await settle(wc)
  throwIfAborted(signal)
  const snapshot = wantSnapshot ? await captureSnapshot(wc) : undefined
  throwIfAborted(signal)
  return { clicked, snapshot }
}

/** 拖拽操作（支持从元素拖拽至目标元素，或指定相对偏移像素 dx, dy，适用于滑块/看板） */
export async function doDrag(
  tab: Tab,
  ref: string,
  opts: { toRef?: string; dx?: number; dy?: number; wantSnapshot?: boolean; signal?: AbortSignal }
): Promise<{ dragged: string; snapshot?: SnapshotSummary }> {
  throwIfAborted(opts.signal)
  const wc = tab.view.webContents
  const loc1 = (await wc.executeJavaScript(locateScript(ref), false)) as {
    ok: boolean
    reason?: string
    x?: number
    y?: number
    tag?: string
  }
  throwIfAborted(opts.signal)
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
    throwIfAborted(opts.signal)
    if (!loc2 || !loc2.ok) throw new ActionError(`找不到拖拽目标元素 ${opts.toRef}`)
    x2 = Math.max(0, loc2.x ?? 0)
    y2 = Math.max(0, loc2.y ?? 0)
  } else if (opts.dx != null || opts.dy != null) {
    x2 = Math.max(0, x1 + (opts.dx ?? 0))
    y2 = Math.max(0, y1 + (opts.dy ?? 0))
  } else {
    throw new ActionError('拖拽操作必须指定 toRef 目标元素或 dx/dy 偏移像素')
  }

  throwIfAborted(opts.signal)
  // 播放起始与终点光标
  void wc.executeJavaScript(laserCursorScript(x1, y1, 'drag'), false).catch(() => {})
  void wc.executeJavaScript(laserCursorScript(x2, y2, 'drag'), false).catch(() => {})

  // 模拟真实轨迹平滑拖动（5 步插值）
  let mouseDown = false
  try {
    throwIfAborted(opts.signal)
    wc.sendInputEvent({ type: 'mouseMove', x: x1, y: y1 })
    throwIfAborted(opts.signal)
    wc.sendInputEvent({ type: 'mouseDown', x: x1, y: y1, button: 'left', clickCount: 1 })
    mouseDown = true
    await delay(50)
    throwIfAborted(opts.signal)

    const steps = 7
    for (let i = 1; i <= steps; i++) {
      throwIfAborted(opts.signal)
      const curX = Math.round(x1 + ((x2 - x1) * i) / steps)
      const curY = Math.round(y1 + ((y2 - y1) * i) / steps)
      wc.sendInputEvent({ type: 'mouseMove', x: curX, y: curY })
      await delay(20)
    }

    throwIfAborted(opts.signal)
    wc.sendInputEvent({ type: 'mouseUp', x: x2, y: y2, button: 'left', clickCount: 1 })
    mouseDown = false
  } finally {
    // 中断/异常路径也必须释放鼠标，否则页面可能停在“按住不放”状态
    if (mouseDown) {
      try {
        wc.sendInputEvent({ type: 'mouseUp', x: x2, y: y2, button: 'left', clickCount: 1 })
      } catch {
        /* 页面已关闭 */
      }
    }
  }
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
  opts: { submit?: boolean; clear?: boolean; wantSnapshot?: boolean; signal?: AbortSignal }
): Promise<{ typed: string; snapshot?: SnapshotSummary }> {
  const { signal } = opts
  throwIfAborted(signal)
  const wc = tab.view.webContents
  const focus = (await wc.executeJavaScript(focusScript(ref), false)) as {
    ok: boolean
    reason?: string
    tag?: string
    type?: string
    editable?: boolean
  }
  throwIfAborted(signal)
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
  throwIfAborted(signal)

  // 首选 insertText（走真实输入管线），失败则用原生 setter 兜底（React 受控输入兼容）
  let inserted = false
  try {
    await wc.insertText(text)
    throwIfAborted(signal)
    const check = (await wc.executeJavaScript(readValueScript(ref), false)) as {
      ok: boolean
      value?: string
    }
    if (check?.ok && (check.value ?? '').endsWith(text)) inserted = true
  } catch {
    // 只有输入/回验失败才允许兜底，中断不是写入失败。
    throwIfAborted(signal)
  }
  throwIfAborted(signal)
  if (!inserted) {
    await wc.executeJavaScript(setValueScript(ref, text), false)
  }
  const typed = `${tag}${inserted ? '' : '（setter 兜底写入）'}`

  // 提交是新的高危副作用：输入期间被取消/中断时不得再回车。
  throwIfAborted(signal)
  if (opts.submit) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
    wc.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  }

  await settle(wc)
  throwIfAborted(signal)
  const snapshot = opts.wantSnapshot ? await captureSnapshot(wc) : undefined
  throwIfAborted(signal)
  return { typed, snapshot }
}

export async function doSelectOption(
  tab: Tab,
  ref: string,
  opts: { value?: string; label?: string; wantSnapshot?: boolean; signal?: AbortSignal }
): Promise<{ selected: string; snapshot?: SnapshotSummary }> {
  const { signal } = opts
  throwIfAborted(signal)
  const wc = tab.view.webContents
  const result = (await wc.executeJavaScript(selectOptionScript(ref, opts.value, opts.label), false)) as {
    ok: boolean
    reason?: string
    value?: string
    label?: string
    options?: { value: string; label: string }[]
    tag?: string
  }
  throwIfAborted(signal)
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
  throwIfAborted(signal)
  const snapshot = opts.wantSnapshot ? await captureSnapshot(wc) : undefined
  throwIfAborted(signal)
  return { selected: `${result.value}${result.label !== result.value ? ` (${result.label})` : ''}`, snapshot }
}

export async function doScroll(
  tab: Tab,
  direction: string,
  amount: number,
  wantSnapshot: boolean
): Promise<{ where: string; snapshot?: SnapshotSummary }> {
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
  const r = await doWaitForCondition(tab, { text, timeoutMs })
  return { found: r.found, elapsedMs: r.elapsedMs }
}

/**
 * 等待文本出现 / 消失 / 任一发生。
 *
 * 相比只支持"出现"，增加"消失"能覆盖加载态（spinner 文字消失＝加载完成）
 * 这类常见 Agent 场景，且不必让 Agent 自己 sleep 固定时长。
 */
export async function doWaitForCondition(
  tab: Tab,
  opts: { text?: string; textGone?: string; timeoutMs: number; signal?: AbortSignal }
): Promise<{ found: boolean; elapsedMs: number; which?: 'appeared' | 'gone' }> {
  const wc = tab.view.webContents
  const start = Date.now()
  const timeoutMs = Math.min(30000, Math.max(1000, opts.timeoutMs))
  const deadline = start + timeoutMs
  const textScript = opts.text !== undefined ? containsTextScript(opts.text) : null
  const goneScript = opts.textGone !== undefined ? containsTextScript(opts.textGone) : null
  let lastReport = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    throwIfAborted(opts.signal)
    const elapsed = Date.now() - start
    if (elapsed - lastReport >= 100) {
      lastReport = elapsed
      reportProgress(elapsed, timeoutMs, '等待条件')
    }
    try {
      if (textScript) {
        const seen = (await wc.executeJavaScript(textScript, false)) as boolean
        if (seen) {
          reportProgress(1, 1, '完成')
          return { found: true, elapsedMs: Date.now() - start, which: 'appeared' }
        }
      }
      if (goneScript) {
        const stillThere = (await wc.executeJavaScript(goneScript, false)) as boolean
        if (!stillThere) {
          reportProgress(1, 1, '完成')
          return { found: true, elapsedMs: Date.now() - start, which: 'gone' }
        }
      }
    } catch {
      /* 页面导航中，继续等 */
    }
    if (Date.now() >= deadline) {
      reportProgress(1, 1, '完成')
      return { found: false, elapsedMs: Date.now() - start }
    }
    await delay(250)
  }
}

/**
 * 等待 DOM/URL 条件：选择器出现或消失、地址包含某串。
 *
 * 文本等待覆盖不了 SPA 场景（文案相同、节点替换、路由变化），
 * 因此按选择器与 URL 等待才是稳定做法；同样 250ms 轮询、上限 30s。
 */
export async function doWaitForDom(
  tab: Tab,
  opts: { selector?: string; selectorGone?: string; urlContains?: string; timeoutMs: number; signal?: AbortSignal }
): Promise<{ found: boolean; elapsedMs: number; which?: 'selector' | 'selectorGone' | 'url' }> {
  const wc = tab.view.webContents
  const start = Date.now()
  const timeoutMs = Math.min(30000, Math.max(1000, opts.timeoutMs))
  const deadline = start + timeoutMs
  const selectorScriptBody = opts.selector
    ? `(() => { const el = document.querySelector(${jsLiteral(opts.selector)}); if (!el) return false; try { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 } catch (e) { return true } })()`
    : null
  const goneScriptBody = opts.selectorGone
    ? `(() => !document.querySelector(${jsLiteral(opts.selectorGone)}))()`
    : null
  const urlNeedle = opts.urlContains ? opts.urlContains : null
  let lastReport = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    throwIfAborted(opts.signal)
    const elapsed = Date.now() - start
    if (elapsed - lastReport >= 100) {
      lastReport = elapsed
      reportProgress(elapsed, timeoutMs, '等待条件')
    }
    try {
      if (selectorScriptBody) {
        const seen = (await wc.executeJavaScript(selectorScriptBody, false)) as boolean
        if (seen) {
          reportProgress(1, 1, '完成')
          return { found: true, elapsedMs: Date.now() - start, which: 'selector' }
        }
      }
      if (goneScriptBody) {
        const gone = (await wc.executeJavaScript(goneScriptBody, false)) as boolean
        if (gone) {
          reportProgress(1, 1, '完成')
          return { found: true, elapsedMs: Date.now() - start, which: 'selectorGone' }
        }
      }
      if (urlNeedle !== null && wc.getURL().includes(urlNeedle)) {
        reportProgress(1, 1, '完成')
        return { found: true, elapsedMs: Date.now() - start, which: 'url' }
      }
    } catch {
      /* 页面导航中，继续等 */
    }
    if (Date.now() >= deadline) {
      reportProgress(1, 1, '完成')
      return { found: false, elapsedMs: Date.now() - start }
    }
    await delay(250)
  }
}

const VALID_KEYS = new Set([
  'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End',
  'PageUp', 'PageDown', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight',
  'F1', 'F2', 'F3', 'F4', 'F5', 'F6', 'F7', 'F8', 'F9', 'F10', 'F11', 'F12',
  'Space'
])

type InputModifier = 'alt' | 'control' | 'shift' | 'meta'
const MODIFIER_ALIASES: Record<string, InputModifier> = {
  ctrl: 'control', control: 'control', alt: 'alt', shift: 'shift',
  meta: 'meta', cmd: 'meta', command: 'meta'
}

function normalizePressKey(key: string, modifiers: string[] = []): { key: string; modifiers: InputModifier[] } {
  const parts = key.split('+').map((part) => part.trim()).filter(Boolean)
  const base = parts.pop() ?? ''
  const allModifiers = [...modifiers, ...parts]
  const normalized = [...new Set(allModifiers.map((item) => MODIFIER_ALIASES[String(item).toLowerCase()]).filter(Boolean))] as InputModifier[]
  if (allModifiers.some((item) => !MODIFIER_ALIASES[String(item).toLowerCase()])) {
    throw new ActionError(`不支持的修饰键: ${allModifiers.find((item) => !MODIFIER_ALIASES[String(item).toLowerCase()])}`)
  }
  return { key: base, modifiers: normalized }
}

export async function doReload(tab: Tab, hard = false, signal?: AbortSignal): Promise<{ url: string; title: string }> {
  throwIfAborted(signal)
  const wc = tab.view.webContents
  let cancelReload = (): void => {}
  await raceAbort(new Promise<void>((resolve, reject) => {
    let settled = false
    let aborted = false
    const cleanup = (): void => {
      wc.removeListener('did-finish-load', finish)
      wc.removeListener('did-fail-load', fail)
      wc.removeListener('did-stop-loading', stopped)
      wc.removeListener('destroyed', destroyed)
    }
    const finish = (): void => {
      if (settled) return
      settled = true
      cleanup()
      resolve()
    }
    const failWith = (error: Error): void => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const fail = (_event: Electron.Event, errorCode: number, errorDescription: string, _validatedURL: string, isMainFrame: boolean): void => {
      if (!isMainFrame || settled) return
      if (errorCode === -3 && aborted) finish()
      else failWith(new ActionError(`刷新失败：${errorDescription || errorCode}`))
    }
    const stopped = (): void => {
      if (aborted) finish()
    }
    const destroyed = (): void => failWith(new ActionError('页面已关闭'))
    wc.once('did-finish-load', finish)
    wc.on('did-fail-load', fail)
    wc.on('did-stop-loading', stopped)
    wc.once('destroyed', destroyed)
    cancelReload = (): void => {
      aborted = true
      try {
        wc.stop()
      } catch {
        /* 已销毁 */
      }
      if (wc.isDestroyed()) destroyed()
      else if (!wc.isLoading()) finish()
    }
    if (hard) wc.reloadIgnoringCache()
    else wc.reload()
  }), signal, () => cancelReload())
  return { url: wc.getURL(), title: wc.getTitle() }
}

export async function doPressKey(tab: Tab, key: string, modifiers: string[] = []): Promise<{ pressed: string; modifiers: InputModifier[] }> {
  const wc = tab.view.webContents
  const parsed = normalizePressKey(key.trim(), modifiers)
  const k = parsed.key
  if (VALID_KEYS.has(k)) {
    const keyCode = k === 'Space' ? ' ' : k
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers: parsed.modifiers })
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers: parsed.modifiers })
    await delay(120)
    return { pressed: k, modifiers: parsed.modifiers }
  }
  if (/^[a-zA-Z0-9]$/.test(k)) {
    wc.sendInputEvent({ type: 'keyDown', keyCode: k, modifiers: parsed.modifiers })
    if (!parsed.modifiers.length) wc.sendInputEvent({ type: 'char', keyCode: k })
    wc.sendInputEvent({ type: 'keyUp', keyCode: k, modifiers: parsed.modifiers })
    await delay(120)
    return { pressed: k, modifiers: parsed.modifiers }
  }
  throw new ActionError(`不支持的按键: ${key}（支持 Enter/Escape/Tab/Arrow*/F1-F12/单字符及 Ctrl/Alt/Shift/Meta 组合）`)
}

/**
 * 整页截图：用 CDP 的 captureBeyondViewport 抓完整文档，而不是只抓视口。
 *
 * UI 评审必须能一次看到长页面的页脚、折叠区、首屏之外的内容；
 * 高度上限 8000px，避免超长页面生成几十 MB 的图片。
 */
async function captureFullPage(wc: WebContents): Promise<{ base64: string; width: number; height: number; capped: boolean }> {
  const dbg = wc.debugger
  let attachedHere = false
  try {
    if (!dbg.isAttached()) {
      dbg.attach('1.3')
      attachedHere = true
    }
    const metrics = (await dbg.sendCommand('Page.getLayoutMetrics')) as {
      cssContentSize?: { width?: number; height?: number }
      contentSize?: { width?: number; height?: number }
    }
    const size = metrics.cssContentSize ?? metrics.contentSize ?? {}
    const fullHeight = Math.ceil(size.height ?? 0) || 720
    const width = Math.ceil(size.width ?? 0) || 1280
    const MAX_HEIGHT = 8000
    const height = Math.min(fullHeight, MAX_HEIGHT)
    const shot = (await dbg.sendCommand('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 }
    })) as { data?: string }
    if (!shot?.data) throw new ActionError('整页截图失败：浏览器未返回图像数据')
    return { base64: shot.data, width, height, capped: fullHeight > MAX_HEIGHT }
  } catch (error) {
    if (error instanceof ActionError) throw error
    throw new ActionError(`整页截图失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (attachedHere) {
      try {
        dbg.detach()
      } catch {
        /* 已销毁或仍被占用 */
      }
    }
  }
}

export async function doScreenshot(tab: Tab, signal?: AbortSignal, opts?: { fullPage?: boolean }): Promise<ToolContent> {
  throwIfAborted(signal)
  const wc = tab.view.webContents
  if (opts?.fullPage) {
    try {
      wc.focus()
    } catch {
      /* 忽略 */
    }
    reportProgress(0.5, 1, '正在捕获整页')
    const full = await raceAbort(captureFullPage(wc), signal)
    throwIfAborted(signal)
    let img = nativeImage.createFromBuffer(Buffer.from(full.base64, 'base64'))
    if (img.isEmpty()) throw new ActionError('整页截图失败：图像为空')
    if (full.width > 1440) img = img.resize({ width: 1440 })
    reportProgress(1, 1, '截图完成')
    return { type: 'image', data: img.toPNG().toString('base64'), mimeType: 'image/png' }
  }
  // capturePage 偶发 UnknownVizError（合成器首帧未就绪）：聚焦 + 重试
  let image: Electron.NativeImage | null = null
  try {
    wc.focus()
  } catch {
    /* 忽略 */
  }
  for (let i = 0; i < 3; i++) {
    throwIfAborted(signal)
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
): Promise<{ moved: boolean; snapshot?: SnapshotSummary }> {
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
    if (opts.action !== 'clear') throw new ActionError('不支持的 Cookie 操作')
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
export async function doPdf(
  tab: Tab,
  filePath?: string,
  landscape = false,
  signal?: AbortSignal
): Promise<{ savedPath: string }> {
  throwIfAborted(signal)
  const wc = tab.view.webContents
  const pdf = await raceAbort(wc.printToPDF({ printBackground: true, landscape, pageSize: 'A4' } as never), signal)
  throwIfAborted(signal)
  const osMod = await import('node:os')
  const pathMod = await import('node:path')
  const fsMod = await import('node:fs')
  const file = filePath || pathMod.join(process.env['AA_BROWSER_DOWNLOAD_DIR'] || pathMod.join(osMod.homedir(), '.aabrowser', 'downloads'), `aa-page-${Date.now()}.pdf`)
  throwIfAborted(signal)
  fsMod.mkdirSync(pathMod.dirname(file), { recursive: true })
  fsMod.writeFileSync(file, pdf)
  // Printing may be non-cancellable; do not register a PDF after its caller has cancelled.
  throwIfAborted(signal)
  getEvidenceManager().record(file, 'pdf', { managed: !filePath })
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
