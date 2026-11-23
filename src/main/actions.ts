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
  pageStateScript,
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

/**
 * 页面合成/截图的等待上限。窗口隐藏、合成器丢掉帧或渲染器卡死时，
 * capturePage / CDP 命令可能永远不结算；不能让它拖住整条标签队列。
 */
const PAGE_CAPTURE_TIMEOUT_MS = 15_000
/** 队列收尾等待上限：容忍迟到的派生操作，但不能让标签永久排队。 */
const DRAIN_TIMEOUT_MS = 10_000

/**
 * 未挂到窗口的页面用 CDP 取视口截图。
 *
 * 这类页面不会被桌面合成器绘制，capturePage 只会一直等到超时；CDP 直接向渲染器
 * 索取当前视口的合成结果，是唯一可靠的路径。附带一份有界超时，
 * 保证渲染器无响应时调用能在限定时间内失败而不是挂住整条标签队列。
 */
async function captureBackgroundViewport(wc: WebContents, signal?: AbortSignal, fullPage = false): Promise<string> {
  const dbg = wc.debugger
  let attachedHere = false
  try {
    if (!dbg.isAttached()) {
      dbg.attach('1.3')
      attachedHere = true
    }
    const params: Record<string, unknown> = { format: 'png', fromSurface: true }
    if (fullPage) {
      const metrics = (await withDeadline(dbg.sendCommand('Page.getLayoutMetrics'), PAGE_CAPTURE_TIMEOUT_MS, '页面布局测量')) as {
        cssContentSize?: { width?: number; height?: number }
        contentSize?: { width?: number; height?: number }
      }
      const size = metrics.cssContentSize ?? metrics.contentSize ?? {}
      params['captureBeyondViewport'] = true
      params['clip'] = {
        x: 0,
        y: 0,
        width: Math.max(1, Math.ceil(size.width ?? 0) || 1280),
        height: Math.min(8000, Math.max(1, Math.ceil(size.height ?? 0) || 720)),
        scale: 1
      }
    }
    // fromSurface=true 依赖窗口合成表面；从未挂到窗口的页面可能没有表面，会一直挂起。
    // 因此先用较短超时尝试，再退回 fromSurface=false（直接读渲染器主帧）。
    let shot: { data?: string } | undefined
    try {
      shot = (await raceAbort(
        withDeadline(dbg.sendCommand('Page.captureScreenshot', { ...params, fromSurface: true }), 4_000, '后台截图'),
        signal
      )) as { data?: string } | undefined
    } catch (error) {
      if (error instanceof ActionError && error.message.includes('已被用户中断')) throw error
      shot = (await raceAbort(
        withDeadline(dbg.sendCommand('Page.captureScreenshot', { ...params, fromSurface: false }), PAGE_CAPTURE_TIMEOUT_MS, '后台截图'),
        signal
      )) as { data?: string } | undefined
    }
    if (!shot?.data) throw new ActionError('截图失败：浏览器未返回图像数据')
    return shot.data
  } catch (error) {
    if (error instanceof ActionError) throw error
    throw new ActionError(`截图失败：${error instanceof Error ? error.message : String(error)}`)
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

/** 给可能永不结算的页面操作加上限；超时后原始 Promise 仍由页面侧收尾。导出供队列回归测试使用。 */
export async function withDeadline<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new ActionError(`${label}超时（${ms}ms）；页面可能已失去响应`)), ms)
  })
  // 超时路径下 promise 仍由页面侧收尾；若它在竞速结束后才拒绝，
  // 需要有人消费，否则会变成进程级未处理拒绝。仅吞掉迟到错误。
  void work.catch(() => {})
  try {
    return await Promise.race([work, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

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

/** 等待派生操作收敛，但受 timeoutMs 约束；导出供队列回归测试使用。 */
export async function drainTabOperations(
  context: { inFlight: Set<Promise<unknown>> },
  timeoutMs = DRAIN_TIMEOUT_MS
): Promise<void> {
  if (!context.inFlight.size) return
  let timer: ReturnType<typeof setTimeout> | undefined
  // 整个收尾阶段共用一个截止时间；等待期间新增的操作也受同一个上限约束。
  const deadline = new Promise<'timeout'>((resolve) => {
    timer = setTimeout(() => resolve('timeout'), timeoutMs)
  })
  try {
    while (context.inFlight.size) {
      const settled = await Promise.race([
        Promise.allSettled([...context.inFlight]).then(() => 'settled' as const),
        deadline
      ])
      if (settled === 'timeout') {
        console.warn(
          `[aa-browser] 标签操作超过 ${timeoutMs}ms 仍未结束，强制释放标签队列（剩余 ${context.inFlight.size} 项）`
        )
        return
      }
    }
  } finally {
    if (timer) clearTimeout(timer)
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
  }, () => {
    // 队尾按设计永不拒绝；万一上游引入拒绝，这里也要收尾，否则队列会卡死。
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
      }, () => {
        // 前驱失败不代表本调用应失败：继续进入锁槽，但必须消费该拒绝。
        signal?.removeEventListener('abort', onAbort)
        resolve()
      })
    })
    throwIfAborted(signal)
    // 排队期间页面可能已被关闭，不能只在入队时检查。
    if (tab.view.webContents.isDestroyed()) throw new ActionError('页面已关闭')

    const context = { inFlight: new Set<Promise<unknown>>() }
    const runPromise = tabQueueContext.run(context, () => Promise.resolve().then(async () => {
      throwIfAborted(signal)
      // 渲染租约由 TabManager 计数管理；即使本调用被取消，
      // 清理也通过 releaseRendering 无条件归还，不会把节能策略留在关闭状态。
      const releaseRendering = tab.keepRendering()
      try {
        return await run()
      } finally {
        await drainTabOperations(context)
        releaseRendering()
      }
    }))
    started = true
    const finished = runPromise.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error })
    ).finally(release)
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

type MouseEvent = { type: 'mouseMove' | 'mouseDown' | 'mouseUp'; x: number; y: number; button?: 'left' | 'middle' | 'right'; clickCount?: number }

/** CDP 与现有抓包/对话框守卫共用通道；attach 幂等，成功后保持挂载。 */
async function withPageDebugger<T>(wc: WebContents, run: (dbg: Electron.Debugger) => Promise<T>): Promise<T> {
  const dbg = wc.debugger
  if (!dbg.isAttached()) {
    try {
      dbg.attach('1.3')
    } catch {
      throw new ActionError('无法在后台操作页面：调试通道不可用，请关闭该页的开发者工具后重试。')
    }
  }
  return await run(dbg)
}

/** 整个手势期间持有一条 CDP 连接；send 不做取消判断，调用点显式检查（拖拽清理必须无条件释放）。 */
async function gestureSender(tab: Tab): Promise<(event: MouseEvent, held?: boolean) => Promise<unknown>> {
  const wc = tab.view.webContents
  if (tab.canUseWindowInput()) {
    return async (event) => { wc.sendInputEvent(event) }
  }
  const shared = gestureSenders.get(wc)
  if (shared) return shared
  return await withPageDebugger(wc, (dbg) => {
    const send = (event: MouseEvent, held = false): Promise<unknown> => {
      const { type, x, y, button, clickCount } = event
      return dbg.sendCommand('Input.dispatchMouseEvent', {
        type: type === 'mouseMove' ? 'mouseMoved' : type === 'mouseDown' ? 'mousePressed' : 'mouseReleased',
        x, y, button: button ?? 'none', clickCount: clickCount ?? 0,
        buttons: type === 'mouseDown' ? (button === 'right' ? 2 : button === 'middle' ? 4 : 1) : held ? 1 : 0
      })
    }
    gestureSenders.set(wc, send)
    return Promise.resolve(send)
  })
}

const gestureSenders = new WeakMap<Electron.WebContents, (event: MouseEvent, held?: boolean) => Promise<unknown>>()

type DragData = {
  items: { mimeType: string; data: string; title?: string; baseURL?: string }[]
  dragOperationsMask: number
  files?: string[]
}

/**
 * 判断起始元素是否可能触发 HTML5 拖拽。只有这类元素才值得开启
 * Input.setInterceptDrags：滑块、canvas、文本选择等永远不会派发 dragstart，
 * 对它们开启拦截只会白等一次超时，并让渲染器停在悬而未决的拖拽状态。
 */
const dragCandidateScript = (ref: string): string => `(() => {
  const el = (window.__aaRefs || {})['${ref}']
  if (!el || !el.isConnected) return false
  if (el.draggable === true) return true
  const tag = el.tagName
  if (tag === 'IMG' || tag === 'VIDEO' || tag === 'CANVAS') return true
  if (tag === 'A' && el.href) return true
  return false
})()`

/**
 * Chromium 拦截到的 DataTransfer 数据。非 HTML 拖拽元素（滑块、canvas、文本选择）
 * 永远不会触发 dragstart，因此超时是预期路径而不是错误：返回 null 让调用方
 * 回退到合成鼠标拖拽。
 */
function waitForDragIntercept(dbg: Electron.Debugger, signal?: AbortSignal, timeoutMs = 1200): Promise<DragData | null> {
  return new Promise((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>
    const cleanup = (): void => {
      clearTimeout(timer)
      dbg.removeListener('message', onMessage)
      dbg.removeListener('detach', onDetach)
      signal?.removeEventListener('abort', onAbort)
    }
    const fail = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const onMessage = (_event: Electron.Event, method: string, params: Record<string, unknown>): void => {
      if (method !== 'Input.dragIntercepted') return
      const data = params['data'] as DragData | undefined
      if (!data || !Array.isArray(data.items) || typeof data.dragOperationsMask !== 'number') {
        fail(new ActionError('Chromium 返回了无效的拖拽数据'))
        return
      }
      cleanup()
      resolve(data)
    }
    const onDetach = (): void => fail(new ActionError('页面调试通道在拖拽期间已关闭'))
    const onAbort = (): void => fail(new ActionError('工具调用已被用户中断。'))
    dbg.on('message', onMessage)
    dbg.once('detach', onDetach)
    signal?.addEventListener('abort', onAbort, { once: true })
    // 元素没有启动 HTML 拖拽属于正常情况：回退到合成鼠标拖拽。
    timer = setTimeout(() => {
      cleanup()
      resolve(null)
    }, timeoutMs)
    if (signal?.aborted) onAbort()
  })
}

async function dispatchDragEvent(
  dbg: Electron.Debugger,
  type: 'dragEnter' | 'dragOver' | 'drop' | 'dragCancel',
  x: number,
  y: number,
  data: DragData
): Promise<void> {
  await dbg.sendCommand('Input.dispatchDragEvent', { type, x, y, data })
}

/**
 * 在页面里记录 HTML5 拖放事件是否真的发生。
 * 原生拖放是否生效只能由页面侧证明：CDP 命令返回成功 ≠ 页面收到 dragstart。
 * 窗口最小化时这条差别是决定性的（见 doDrag 的回退分支）。
 */
async function armDragProbe(wc: WebContents): Promise<void> {
  try {
    await wc.executeJavaScript(
      `(() => {
        const probe = { start: false, drop: false }
        window.__aaDragProbe = probe
        const mark = (key) => () => { probe[key] = true }
        document.addEventListener('dragstart', mark('start'), { capture: true, once: true })
        document.addEventListener('drop', mark('drop'), { capture: true, once: true })
        return true
      })()`,
      false
    )
  } catch {
    /* 页面可能已关闭；探针缺失按「未验证」处理 */
  }
}

async function readDragProbe(wc: WebContents): Promise<{ start: boolean; drop: boolean } | null> {
  try {
    return (await wc.executeJavaScript(
      `(() => { const p = window.__aaDragProbe; return p ? { start: !!p.start, drop: !!p.drop } : null })()`,
      false
    )) as { start: boolean; drop: boolean } | null
  } catch {
    return null
  }
}

/**
 * DOM 级拖放回退。
 *
 * 原生拖放在后台有平台限制：X11 下窗口最小化或不可见时，Chromium 根本不会
 * 建立系统级 DnD 会话，`Input.dragIntercepted` 永不触发，页面连 dragstart 都收不到，
 * 于是拖放静默失效（调用仍返回成功）。这里用页面内的 DataTransfer 走完整的
 * dragstart → dragenter/dragover → drop → dragend 序列，让页面自己的处理函数执行。
 *
 * 这是兼容回退，不是默认路径：只有可信输入没有产生真实 drop 时才会走到这里，
 * 且返回值会明确标注「DOM 回退」，让上层知道事件不是 isTrusted。
 */
async function syntheticHtml5Drag(wc: WebContents, fromRef: string, toRef: string): Promise<boolean> {
  try {
    return (await wc.executeJavaScript(
      `(() => {
        const src = (window.__aaRefs || {})[${refLiteral(fromRef)}]
        const tgt = (window.__aaRefs || {})[${refLiteral(toRef)}]
        if (!src || !tgt || !src.isConnected || !tgt.isConnected) return false
        const center = (el) => {
          const r = el.getBoundingClientRect()
          return { clientX: Math.round(r.x + r.width / 2), clientY: Math.round(r.y + r.height / 2) }
        }
        let dt
        try {
          dt = new DataTransfer()
        } catch {
          return false
        }
        const make = (type, el) => new DragEvent(type, {
          bubbles: true, cancelable: true, composed: true, dataTransfer: dt, ...center(el)
        })
        try {
          src.dispatchEvent(make('dragstart', src))
          tgt.dispatchEvent(make('dragenter', tgt))
          // dragover 必须被页面 preventDefault，否则 drop 不会发生。
          const over = make('dragover', tgt)
          tgt.dispatchEvent(over)
          const drop = make('drop', tgt)
          tgt.dispatchEvent(drop)
          src.dispatchEvent(make('dragend', src))
        } catch {
          return false
        }
        return true
      })()`,
      false
    )) === true
  } catch {
    return false
  }
}

/** 未预先建立连接时的单事件兜底路径（悬停等无取消语义的调用）。 */
function pageMouse(tab: Tab): (event: MouseEvent, held?: boolean) => unknown {
  const wc = tab.view.webContents
  if (tab.canUseWindowInput()) return (event) => wc.sendInputEvent(event)
  const shared = gestureSenders.get(wc)
  if (shared) return shared
  return (event, held = false) => {
    const { type, x, y, button, clickCount } = event
    return withPageDebugger(wc, (dbg) => dbg.sendCommand('Input.dispatchMouseEvent', {
      type: type === 'mouseMove' ? 'mouseMoved' : type === 'mouseDown' ? 'mousePressed' : 'mouseReleased',
      x, y, button: button ?? 'none', clickCount: clickCount ?? 0,
      buttons: type === 'mouseDown' ? (button === 'right' ? 2 : button === 'middle' ? 4 : 1) : held ? 1 : 0
    }))
  }
}

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
  tab.recordPointer?.({ kind: 'click', x, y })
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
    // 优先走真实输入事件（isTrusted=true，兼容防爬站点）。
    // 后台 CDP 路径整个手势共用一条连接；取消发生在按下与抬起之间时，
    // 不再补发 mouseUp——宁可让页面停在按下态，也不能在取消后提交点击。
    const send = await gestureSender(tab)
    try {
      await send({ type: 'mouseMove', x, y })
      await send({ type: 'mouseDown', x, y, button, clickCount })
      throwIfAborted(signal)
      await send({ type: 'mouseUp', x, y, button, clickCount })
    } finally {
      gestureSenders.delete(wc)
    }
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
): Promise<{ dragged: string; snapshot?: SnapshotSummary; dropped: boolean }> {
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
  tab.recordPointer?.({ kind: 'move', x: x1, y: y1 })
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
  tab.recordPointer?.({ kind: 'click', x: x2, y: y2 })

  throwIfAborted(opts.signal)
  // 播放起始与终点光标
  void wc.executeJavaScript(laserCursorScript(x1, y1, 'drag'), false).catch(() => {})
  void wc.executeJavaScript(laserCursorScript(x2, y2, 'drag'), false).catch(() => {})

  // 优先走真实 HTML5 拖放：Chromium 拦截 dragstart 后返回页面生成的 DataTransfer，
  // 再派发可信 CDP 拖放事件。元素不产生 dragstart（滑块/canvas/文本选择）时
  // 回退到合成鼠标拖拽，保持 v0.13 的行为。
  let mouseDown = false
  let interceptEnabled = false
  let dragData: DragData | null = null
  let dbg: Electron.Debugger | null = null
  // 捕获 Promise 放进对象里：闭包内赋值不会让 TS 把外层变量错误收窄成 null。
  const dragState: { intercepted: Promise<DragData | null> | null } = { intercepted: null }
  // 先问页面这个元素是否可能产生 HTML5 拖拽；否则直接走合成鼠标轨迹。
  let dragCandidate = true
  try {
    dragCandidate = (await wc.executeJavaScript(dragCandidateScript(ref), false)) === true
  } catch { /* 页面可能已关闭；交给后续步骤报错 */ }
  throwIfAborted(opts.signal)
  const send = await gestureSender(tab)
  // 先装页面侧探针：CDP 命令全部返回成功也可能一个 drop 都没发生。
  await armDragProbe(wc)
  let nativeDropped = false
  try {
    throwIfAborted(opts.signal)
    if (dragCandidate) {
      dbg = await withPageDebugger(wc, async (pageDebugger) => {
        await pageDebugger.sendCommand('Input.setInterceptDrags', { enabled: true })
        interceptEnabled = true
        dragState.intercepted = waitForDragIntercept(pageDebugger, opts.signal)
        return pageDebugger
      })
    }
    await send({ type: 'mouseMove', x: x1, y: y1 })
    throwIfAborted(opts.signal)
    mouseDown = true
    await send({ type: 'mouseDown', x: x1, y: y1, button: 'left', clickCount: 1 })
    const deltaX = x2 - x1
    const deltaY = y2 - y1
    const distance = Math.hypot(deltaX, deltaY)
    const thresholdX = Math.round(x1 + (distance ? (deltaX / distance) * 12 : 12))
    const thresholdY = Math.round(y1 + (distance ? (deltaY / distance) * 12 : 0))
    await send({ type: 'mouseMove', x: thresholdX, y: thresholdY, button: 'left' }, true)
    dragData = dragState.intercepted ? await dragState.intercepted : null
    throwIfAborted(opts.signal)
    const dragChannel = dbg
    if (dragData && dragChannel) {
      await dispatchDragEvent(dragChannel, 'dragEnter', thresholdX, thresholdY, dragData)
      await dispatchDragEvent(dragChannel, 'dragOver', thresholdX, thresholdY, dragData)
    }

    const steps = 7
    for (let i = 1; i <= steps; i++) {
      throwIfAborted(opts.signal)
      const curX = Math.round(thresholdX + ((x2 - thresholdX) * i) / steps)
      const curY = Math.round(thresholdY + ((y2 - thresholdY) * i) / steps)
      if (dragData && dragChannel) await dispatchDragEvent(dragChannel, 'dragOver', curX, curY, dragData)
      else await send({ type: 'mouseMove', x: curX, y: curY, button: 'left' }, true)
      await delay(20)
    }

    throwIfAborted(opts.signal)
    if (dragData && dragChannel) await dispatchDragEvent(dragChannel, 'drop', x2, y2, dragData)
    await send({ type: 'mouseUp', x: x2, y: y2, button: 'left', clickCount: 1 })
    mouseDown = false
  } finally {
    gestureSenders.delete(wc)
    // 提前失败时拦截 Promise 可能仍在等待：吞掉它的迟到拒绝，避免未处理异常。
    void dragState.intercepted?.catch(() => {})
    if (dbg && dragData && mouseDown) {
      try {
        await dispatchDragEvent(dbg, 'dragCancel', x2, y2, dragData)
      } catch {
        /* 页面已关闭 */
      }
    }
    if (mouseDown) {
      try {
        await send({ type: 'mouseUp', x: x2, y: y2, button: 'left', clickCount: 1 })
      } catch {
        /* 页面已关闭 */
      }
    }
    if (dbg && interceptEnabled) {
      try {
        await dbg.sendCommand('Input.setInterceptDrags', { enabled: false })
      } catch {
        /* 页面已关闭 */
      }
    }
  }
  const probeAfterNative = await readDragProbe(wc)
  nativeDropped = probeAfterNative?.drop === true
  // 后台原生拖放在 X11 最小化/不可见窗口下不会建立系统 DnD 会话，
  // 页面连 dragstart 都收不到。此时用 DOM 级 DataTransfer 序列补一次，
  // 保证「拖到目标元素」这类操作在后台仍然有实际效果。
  let usedDomFallback = false
  if (!nativeDropped && opts.toRef) {
    usedDomFallback = await syntheticHtml5Drag(wc, ref, opts.toRef)
  }
  await settle(wc)

  const snapshot = opts.wantSnapshot ? await captureSnapshot(wc) : undefined
  // 是否真的产生 drop 只能由页面侧探针证明；命令返回成功不算证据。
  const probeFinal = await readDragProbe(wc)
  const dropped = probeFinal?.drop === true
  const note = dropped
    ? usedDomFallback
      ? '（DOM 事件回退：后台原生拖放不可用）'
      : ''
    : '（未验证到页面 drop；可能该元素不支持拖放，或页面已重绘）'
  return { dragged: `从 (${x1},${y1}) 拖动至 (${x2},${y2})${note}`, snapshot, dropped }
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
  tab.recordPointer?.({ kind: 'input' })
  if (['checkbox', 'radio', 'button', 'submit', 'file'].includes(focus.type ?? '')) {
    throw new ActionError(
      `元素 ${ref} 是 ${focus.type} 类型，不支持输入文本；请改用 browser_click 或 browser_select_option`
    )
  }

  if (opts.clear) {
    const cleared = (await wc.executeJavaScript(clearScript(ref), false)) as { ok?: boolean; reason?: string } | null
    if (!cleared?.ok) {
      throw new ActionError(
        cleared?.reason === 'no-ref'
          ? `找不到元素 ${ref}：页面可能已变化，请先重新调用 browser_snapshot`
          : `无法清空元素 ${ref}（${cleared?.reason ?? 'clear-failed'}）`
      )
    }
  }
  throwIfAborted(signal)

  // 首选 insertText（走真实输入管线），失败则用原生 setter 兜底（React 受控输入兼容）
  let inserted = false
  try {
    if (tab.canUseWindowInput()) await wc.insertText(text)
    else await withPageDebugger(wc, (dbg) => dbg.sendCommand('Input.insertText', { text }))
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
    const setResult = (await wc.executeJavaScript(setValueScript(ref, text), false)) as
      | { ok?: boolean; reason?: string }
      | null
    if (!setResult?.ok) {
      throw new ActionError(
        setResult?.reason === 'no-ref'
          ? `找不到元素 ${ref}：页面可能已变化，请先重新调用 browser_snapshot`
          : `无法写入 ${ref}（${setResult?.reason ?? 'set-failed'}）：目标可能不是可编辑输入框`
      )
    }
  }
  const typed = `${tag}${inserted ? '' : '（setter 兜底写入）'}`

  // 提交是新的高危副作用：输入期间被取消/中断时不得再回车。
  throwIfAborted(signal)
  if (opts.submit) {
    await sendPageKey(tab, 'Enter', [])
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

export interface ScrollResult {
  didScroll: boolean
  where: string
  before?: { x: number; y: number }
  after?: { x: number; y: number }
  requested?: { x: number; y: number }
  moved?: { x: number; y: number }
  atLimit?: boolean
  scrollHeight?: number
  scrollWidth?: number
  viewportHeight?: number
  viewportWidth?: number
  visibilityState?: string
  hidden?: boolean
  reason?: string
}

/**
 * 滚动并回报实际结果。
 *
 * 不再把 `executeJavaScript` 完成当成滚动成功：页面在末尾、内容不足一屏、
 * 或滚动容器未初始化时，浏览器会静默不移动，调用方必须拿到 didScroll:false。
 */
export async function doScroll(
  tab: Tab,
  direction: string,
  amount: number,
  wantSnapshot: boolean
): Promise<{ result: ScrollResult; snapshot?: SnapshotSummary }> {
  const wc = tab.view.webContents
  const raw = (await wc.executeJavaScript(scrollScript(direction, amount), false)) as ScrollResult | null
  const result: ScrollResult = {
    didScroll: raw?.didScroll === true,
    where: raw?.where ?? 'unknown',
    ...(raw?.before ? { before: raw.before } : {}),
    ...(raw?.after ? { after: raw.after } : {}),
    ...(raw?.requested ? { requested: raw.requested } : {}),
    ...(raw?.moved ? { moved: raw.moved } : {}),
    ...(typeof raw?.atLimit === 'boolean' ? { atLimit: raw.atLimit } : {}),
    ...(typeof raw?.scrollHeight === 'number' ? { scrollHeight: raw.scrollHeight } : {}),
    ...(typeof raw?.scrollWidth === 'number' ? { scrollWidth: raw.scrollWidth } : {}),
    ...(typeof raw?.viewportHeight === 'number' ? { viewportHeight: raw.viewportHeight } : {}),
    ...(typeof raw?.viewportWidth === 'number' ? { viewportWidth: raw.viewportWidth } : {}),
    ...(typeof raw?.visibilityState === 'string' ? { visibilityState: raw.visibilityState } : {}),
    ...(typeof raw?.hidden === 'boolean' ? { hidden: raw.hidden } : {}),
    ...(typeof raw?.reason === 'string' ? { reason: raw.reason } : {})
  }
  await delay(200)
  const snapshot = wantSnapshot ? await captureSnapshot(wc) : undefined
  return { result, snapshot }
}

/** 页面状态摘要（主进程侧补充标签信息，见 browser_page_state） */
export async function doPageState(tab: Tab): Promise<Record<string, unknown>> {
  const wc = tab.view.webContents
  const page = (await wc.executeJavaScript(pageStateScript(), false)) as Record<string, unknown> | null
  return page && typeof page === 'object' ? page : {}
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

/**
 * 等待“任一条件”满足：文本出现/消失、选择器出现/消失、URL 包含。
 * 旧实现先等完文本再等 DOM，最坏耗时是 timeout 的两倍，且与工具声明的
 * “whichever happens first” 不符。这里共用一个 deadline，每轮依次检查，
 * 任一条件命中立即返回。
 */
export async function doWaitForAny(
  tab: Tab,
  opts: {
    text?: string
    textGone?: string
    selector?: string
    selectorGone?: string
    urlContains?: string
    timeoutMs: number
    signal?: AbortSignal
  }
): Promise<{
  found: boolean
  elapsedMs: number
  which?: 'appeared' | 'gone' | 'selector' | 'selectorGone' | 'url'
}> {
  const wc = tab.view.webContents
  const start = Date.now()
  const timeoutMs = Math.min(30000, Math.max(1000, opts.timeoutMs))
  const deadline = start + timeoutMs
  const checks: { which: 'appeared' | 'gone' | 'selector' | 'selectorGone'; script: string; expect: boolean }[] = []
  if (opts.text !== undefined) checks.push({ which: 'appeared', script: containsTextScript(opts.text), expect: true })
  if (opts.textGone !== undefined) checks.push({ which: 'gone', script: containsTextScript(opts.textGone), expect: false })
  if (opts.selector !== undefined) {
    checks.push({
      which: 'selector',
      expect: true,
      script: `(() => { const el = document.querySelector(${jsLiteral(opts.selector)}); if (!el) return false; try { const cs = getComputedStyle(el); if (cs.display === 'none' || cs.visibility === 'hidden') return false; const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0 } catch (e) { return true } })()`
    })
  }
  if (opts.selectorGone !== undefined) {
    checks.push({
      which: 'selectorGone',
      expect: true,
      script: `(() => !document.querySelector(${jsLiteral(opts.selectorGone)}))()`
    })
  }
  const urlNeedle = opts.urlContains ?? null
  let lastReport = 0
  // eslint-disable-next-line no-constant-condition
  while (true) {
    throwIfAborted(opts.signal)
    const elapsed = Date.now() - start
    if (elapsed - lastReport >= 100) {
      lastReport = elapsed
      reportProgress(elapsed, timeoutMs, '等待条件')
    }
    if (urlNeedle !== null && wc.getURL().includes(urlNeedle)) {
      reportProgress(1, 1, '完成')
      return { found: true, elapsedMs: Date.now() - start, which: 'url' }
    }
    for (const check of checks) {
      try {
        const value = (await wc.executeJavaScript(check.script, false)) as boolean
        if (value === check.expect) {
          reportProgress(1, 1, '完成')
          return { found: true, elapsedMs: Date.now() - start, which: check.which }
        }
      } catch {
        /* 页面导航中，继续等 */
      }
    }
    if (Date.now() >= deadline) {
      reportProgress(1, 1, '完成')
      return { found: false, elapsedMs: Date.now() - start }
    }
    await delay(250)
  }
}

const VALID_KEYS = new Set([  'Enter', 'Escape', 'Tab', 'Backspace', 'Delete', 'Insert', 'Home', 'End',
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

const KEY_CODES: Record<string, number> = {
  Enter: 13, Escape: 27, Tab: 9, Backspace: 8, Delete: 46, Insert: 45, Home: 36, End: 35,
  PageUp: 33, PageDown: 34, ArrowUp: 38, ArrowDown: 40, ArrowLeft: 37, ArrowRight: 39, Space: 32
}
const CDP_MODIFIERS: Record<InputModifier, number> = { alt: 1, control: 2, meta: 4, shift: 8 }

async function sendPageKey(tab: Tab, key: string, modifiers: InputModifier[]): Promise<void> {
  const wc = tab.view.webContents
  const printable = /^[a-zA-Z0-9]$/.test(key)
  if (tab.canUseWindowInput()) {
    const keyCode = key === 'Space' ? ' ' : key
    wc.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    if (printable && !modifiers.length) wc.sendInputEvent({ type: 'char', keyCode, modifiers })
    wc.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    return
  }
  const letter = /^[a-zA-Z]$/.test(key)
  const upper = key.toUpperCase()
  const domKey = key === 'Space' ? ' ' : letter && modifiers.includes('shift') ? upper : key
  const code = letter ? `Key${upper}` : printable ? `Digit${key}` : key
  const windowsVirtualKeyCode = printable ? upper.charCodeAt(0) : KEY_CODES[key] ?? 111 + Number(key.slice(1))
  // Shift+符号产生上档字符（美式布局）；字母由 text 传大写形式。
  const shifted: Record<string, string> = { '`': '~', '1': '!', '2': '@', '3': '#', '4': '$', '5': '%', '6': '^', '7': '&', '8': '*', '9': '(', '0': ')', '-': '_', '=': '+', '[': '{', ']': '}', '\\': '|', ';': ':', "'": '"', ',': '<', '.': '>', '/': '?' }
  const domChar = modifiers.includes('shift') && !letter ? shifted[key] ?? key : key
  const event = { key: domKey, code, windowsVirtualKeyCode, modifiers: modifiers.reduce((mask, mod) => mask | CDP_MODIFIERS[mod], 0) }
  const text = modifiers.every((mod) => mod === 'shift')
    ? key === 'Enter' ? '\r' : printable || key === 'Space' ? domChar : ''
    : ''
  await withPageDebugger(wc, async (dbg) => {
    await dbg.sendCommand('Input.dispatchKeyEvent', { ...event, type: text ? 'keyDown' : 'rawKeyDown', ...(text ? { text } : {}) })
    await dbg.sendCommand('Input.dispatchKeyEvent', { ...event, type: 'keyUp' })
  })
}

export async function doPressKey(tab: Tab, key: string, modifiers: string[] = []): Promise<{ pressed: string; modifiers: InputModifier[] }> {
  const parsed = normalizePressKey(key.trim(), modifiers)
  const k = parsed.key
  if (!VALID_KEYS.has(k) && !/^[a-zA-Z0-9]$/.test(k)) {
    throw new ActionError(`不支持的按键: ${key}（支持 Enter/Escape/Tab/Arrow*/F1-F12/单字符及 Ctrl/Alt/Shift/Meta 组合）`)
  }
  await sendPageKey(tab, k, parsed.modifiers)
  tab.recordPointer?.({ kind: 'input' })
  await delay(120)
  return { pressed: k, modifiers: parsed.modifiers }
}

/**
 * 整页截图：用 CDP 的 captureBeyondViewport 抓完整文档，而不是只抓视口。
 *
 * UI 评审必须能一次看到长页面的页脚、折叠区、首屏之外的内容；
 * 高度上限 8000px，避免超长页面生成几十 MB 的图片。
 */
async function captureFullPage(wc: WebContents, background: boolean, minimized: () => boolean): Promise<{ base64: string; width: number; height: number; capped: boolean }> {
  const dbg = wc.debugger
  let attachedHere = false
  let restoreViewport: { width: number; height: number } | null = null
  let viewportOverridden = false
  try {
    if (!dbg.isAttached()) {
      dbg.attach('1.3')
      attachedHere = true
    }

    if (background) {
      // Electron 45 在最小化状态下 CDP Page.captureScreenshot 可能一直不返回。
      // 临时把 CSS 视口扩大到文档高度，再用普通 capturePage 合成整页，结束后恢复。
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
      const measuredWidth = Math.ceil(dimensions.viewportWidth ?? 0)
      const measuredHeight = Math.ceil(dimensions.viewportHeight ?? 0)
      const originalWidth = Math.max(1, measuredWidth || 1280)
      const originalHeight = Math.max(1, measuredHeight || 720)
      const width = Math.max(originalWidth, Math.ceil(dimensions.contentWidth ?? 0) || 1280)
      const fullHeight = Math.max(originalHeight, Math.ceil(dimensions.contentHeight ?? 0) || 720)
      const MAX_HEIGHT = 8000
      const height = Math.min(fullHeight, MAX_HEIGHT)
      // 只有实测到正尺寸才恢复；0×0 说明本来就没有有效视口，
      // 恢复 1280×720 会在窗口还原后留下无人清理的覆盖。
      if (measuredWidth > 0 && measuredHeight > 0) {
        restoreViewport = { width: originalWidth, height: originalHeight }
      }
      await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false, screenWidth: width, screenHeight: height
      })
      viewportOverridden = true
      await delay(100)
      const image = await wc.capturePage(undefined, { stayHidden: true })
      if (image.isEmpty()) throw new ActionError('整页截图失败：页面合成器未返回图像数据')
      const size = image.getSize()
      return { base64: image.toPNG().toString('base64'), width: size.width, height: size.height, capped: fullHeight > MAX_HEIGHT }
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
      fromSurface: true,
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width, height, scale: 1 }
    })) as { data?: string }
    if (!shot?.data) throw new ActionError('整页截图失败：浏览器未返回图像数据')
    return { base64: shot.data, width, height, capped: fullHeight > MAX_HEIGHT }
  } catch (error) {
    if (error instanceof ActionError) throw error
    throw new ActionError(`整页截图失败：${error instanceof Error ? error.message : String(error)}`)
  } finally {
    if (viewportOverridden && dbg.isAttached()) {
      try {
        if (restoreViewport && minimized()) {
          // 仍最小化：回到索引层维持的后台视口，快照与后续输入继续可用。
          await dbg.sendCommand('Emulation.setDeviceMetricsOverride', {
            width: restoreViewport.width,
            height: restoreViewport.height,
            deviceScaleFactor: 1,
            mobile: false,
            screenWidth: restoreViewport.width,
            screenHeight: restoreViewport.height
          })
        } else {
          // 截图中用户已恢复窗口：清除覆盖，不能把模拟视口留在前台页面上。
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

export async function doScreenshot(tab: Tab, signal?: AbortSignal, opts?: { fullPage?: boolean }): Promise<ToolContent> {
  throwIfAborted(signal)
  const wc = tab.view.webContents
  // 视图没有挂在窗口上时（其他 MCP 客户端的标签、后台标签）桌面合成器不会为该页产生帧，
  // capturePage 只会一直等到超时。此时改走 CDP 截图，它直接向渲染器要画面。
  const composited = tab.isComposited?.() === true
  if (opts?.fullPage) {
    const background = !composited || !tab.canUseWindowInput()
    // 最小化时 capturePage 可能等待永远不会产生的合成帧；后台直接走 CDP，
    // 这样整页截图不依赖窗口是否能被桌面合成器显示。
    if (!background) await raceAbort(withDeadline(wc.capturePage(undefined, { stayHidden: true }), PAGE_CAPTURE_TIMEOUT_MS, '页面截图'), signal)
    reportProgress(0.5, 1, '正在捕获整页')
    const full = await raceAbort(
      withDeadline(captureFullPage(wc, background, () => tab.isWindowMinimized?.() ?? false), PAGE_CAPTURE_TIMEOUT_MS, '整页截图'),
      signal
    )
    throwIfAborted(signal)
    let img = nativeImage.createFromBuffer(Buffer.from(full.base64, 'base64'))
    if (img.isEmpty()) throw new ActionError('整页截图失败：图像为空')
    if (full.width > 1440) img = img.resize({ width: 1440 })
    reportProgress(1, 1, '截图完成')
    return { type: 'image', data: img.toPNG().toString('base64'), mimeType: 'image/png' }
  }
  if (!composited) {
    const shot = await captureBackgroundViewport(wc, signal)
    let img = nativeImage.createFromBuffer(Buffer.from(shot, 'base64'))
    if (img.isEmpty()) throw new ActionError('截图失败：浏览器未返回有效图像')
    if (img.getSize().width > 1440) img = img.resize({ width: 1440 })
    return { type: 'image', data: img.toPNG().toString('base64'), mimeType: 'image/png' }
  }
  // 合成器首帧可能未就绪；等待而不聚焦桌面窗口。
  let image: Electron.NativeImage | null = null
  for (let i = 0; i < 3; i++) {
    throwIfAborted(signal)
    try {
      image = await withDeadline(wc.capturePage(undefined, { stayHidden: true }), PAGE_CAPTURE_TIMEOUT_MS, '页面截图')
      if (!image.isEmpty()) break
    } catch (error) {
      // 超时说明合成器已失去响应，重试只会把工具调用拖得更久。
      if (error instanceof ActionError) throw error
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
  tab.recordPointer?.({ kind: 'move', x, y })
  await pageMouse(tab)({ type: 'mouseMove', x, y })
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
    let requestId: number | null = null
    const timer = setTimeout(() => {
      wc.removeListener('found-in-page', onFound)
      reject(new ActionError('查找超时（页面未响应 findInPage）'))
    }, timeoutMs)
    const onFound = (
      _e: unknown,
      result: { matches: number; activeMatchOrdinal: number; finalUpdate?: boolean; requestId?: number }
    ): void => {
      // Electron 会先上报中间结果，只有 finalUpdate 才是完整计数；
      // 同时过滤旧请求（连续查找时）的迟到事件。
      if (requestId !== null && typeof result.requestId === 'number' && result.requestId !== requestId) return
      if (result.finalUpdate === false) return
      clearTimeout(timer)
      wc.removeListener('found-in-page', onFound)
      resolve({ matches: result.matches, activeOrdinal: result.activeMatchOrdinal })
    }
    wc.on('found-in-page', onFound)
    try {
      requestId = wc.findInPage(text, { findNext: false })
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
  if (tab.isComposited?.() !== true) {
    // 未挂到窗口的页面不合成：走 CDP 取视口截图再按 bbox 裁剪。
    // 必须与前台路径使用同一坐标空间：rectScript 返回的是视口内坐标，
    // 用整页图裁剪会因滚动偏移裁到错误位置（通常是空白区域）。
    const shot = await captureBackgroundViewport(wc)
    const fullImage = nativeImage.createFromBuffer(Buffer.from(shot, 'base64'))
    if (fullImage.isEmpty()) throw new ActionError('截图失败：浏览器未返回有效图像')
    const vpBg = (await wc.executeJavaScript('({ w: window.innerWidth, h: window.innerHeight })', false)) as { w: number; h: number }
    const sizeBg = fullImage.getSize()
    const sxBg = sizeBg.width / Math.max(1, vpBg.w)
    const syBg = sizeBg.height / Math.max(1, vpBg.h)
    const cropXBg = Math.min(sizeBg.width - 1, Math.max(0, Math.round((rect.x ?? 0) * sxBg)))
    const cropYBg = Math.min(sizeBg.height - 1, Math.max(0, Math.round((rect.y ?? 0) * syBg)))
    const cropWBg = Math.max(1, Math.min(Math.round((rect.width ?? 1) * sxBg), sizeBg.width - cropXBg))
    const cropHBg = Math.max(1, Math.min(Math.round((rect.height ?? 1) * syBg), sizeBg.height - cropYBg))
    const croppedBg = fullImage.crop({ x: cropXBg, y: cropYBg, width: cropWBg, height: cropHBg })
    return { type: 'image', data: croppedBg.toPNG().toString('base64'), mimeType: 'image/png' }
  }
  let image: Electron.NativeImage | null = null
  for (let i = 0; i < 3; i++) {
    try {
      image = await withDeadline(wc.capturePage(undefined, { stayHidden: true }), PAGE_CAPTURE_TIMEOUT_MS, '元素截图')
      if (!image.isEmpty()) break
    } catch (error) {
      if (error instanceof ActionError) throw error
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
    // clear 的作用域必须与审批面板显示的一致：url 指定来源站点，domain 指定域名。
    // 旧实现只按 name 过滤，传了 url 仍会清空所有站点的同名 Cookie。
    let host: string | null = null
    if (opts.url) {
      try {
        host = new URL(opts.url).hostname.toLowerCase()
      } catch {
        throw new ActionError(`url 无法解析：${opts.url}`)
      }
    }
    const domainFilter = opts.domain?.replace(/^\./, '').toLowerCase() || null
    let n = 0
    for (const c of cookies) {
      if (opts.name && c.name !== opts.name) continue
      const domain = c.domain ?? ''
      const bare = domain.replace(/^\./, '').toLowerCase()
      if (domainFilter && bare !== domainFilter && !bare.endsWith(`.${domainFilter}`)) continue
      if (host && bare !== host && !host.endsWith(`.${bare}`)) continue
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

/**
 * 导出文件落盘位置约束。
 *
 * HAR/PDF 的 path 来自 MCP 调用方，可能被提示注入操纵。旧实现会在任意位置
 * 递归建目录并覆盖任意文件（例如 ~/.ssh/authorized_keys）。这里把显式路径
 * 限制在浏览器自己的导出目录内，同时拒绝符号链接，避免写到用户配置或
 * 证据登记文件。不传 path 的自动导出不受影响。
 */
const insideDir = (pathMod: typeof import('node:path'), root: string, target: string): boolean => {
  const rel = pathMod.relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !pathMod.isAbsolute(rel))
}

export async function resolveExportFile(
  requested: string | undefined,
  ext: '.pdf' | '.har',
  defaultFile: string
): Promise<{ file: string; explicit: boolean }> {
  if (!requested) return { file: defaultFile, explicit: false }
  const [fsMod, pathMod, osMod] = await Promise.all([
    import('node:fs'),
    import('node:path'),
    import('node:os')
  ])
  if (!requested.trim() || requested.includes('\0')) {
    throw new ActionError('导出路径不能为空或包含非法字符')
  }
  let file = requested
  if (pathMod.extname(file).toLowerCase() !== ext) file += ext
  file = pathMod.resolve(file)
  const home = osMod.homedir()
  const roots = [
    process.env['AA_BROWSER_EXPORT_DIR'],
    process.env['AA_BROWSER_DOWNLOAD_DIR'] || pathMod.join(home, '.aabrowser', 'downloads'),
    pathMod.join(home, '.aabrowser', 'har'),
    pathMod.join(home, '.aabrowser', 'screenshots')
  ]
    .filter((root): root is string => Boolean(root))
    .map((root) => pathMod.resolve(root))
  if (!roots.some((root) => insideDir(pathMod, root, file))) {
    throw new ActionError(
      `导出路径必须位于浏览器导出目录内（${roots.join('、')}）；可用 AA_BROWSER_EXPORT_DIR 自定义目录。当前: ${file}`
    )
  }
  if (fsMod.existsSync(file)) {
    const st = fsMod.lstatSync(file)
    if (st.isSymbolicLink()) throw new ActionError(`拒绝写入符号链接: ${file}`)
    if (!st.isFile()) throw new ActionError(`导出路径不是普通文件: ${file}`)
  }
  // 父目录可能是指向外部的符号链接；按真实路径再确认一次（只检查已存在、且词法上位于根内的祖先）。
  const root = roots.find((candidate) => insideDir(pathMod, candidate, file))
  if (root && fsMod.existsSync(root)) {
    let parent = pathMod.dirname(file)
    while (!fsMod.existsSync(parent) && pathMod.dirname(parent) !== parent && insideDir(pathMod, root, parent)) {
      parent = pathMod.dirname(parent)
    }
    if (fsMod.existsSync(parent)) {
      const realParent = fsMod.realpathSync(parent)
      const realRoot = fsMod.realpathSync(root)
      if (!insideDir(pathMod, realRoot, realParent)) {
        throw new ActionError(`导出路径的真实父目录不在允许范围内: ${realParent}`)
      }
    }
  }
  return { file, explicit: true }
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
  const defaultFile = pathMod.join(
    process.env['AA_BROWSER_DOWNLOAD_DIR'] || pathMod.join(osMod.homedir(), '.aabrowser', 'downloads'),
    `aa-page-${Date.now()}.pdf`
  )
  const { file, explicit } = await resolveExportFile(filePath, '.pdf', defaultFile)
  throwIfAborted(signal)
  fsMod.mkdirSync(pathMod.dirname(file), { recursive: true })
  fsMod.writeFileSync(file, pdf)
  // Printing may be non-cancellable; do not register a PDF after its caller has cancelled.
  throwIfAborted(signal)
  getEvidenceManager().record(file, 'pdf', { managed: !explicit })
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
