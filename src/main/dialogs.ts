import type { WebContents } from 'electron'

/**
 * 页面对话框守卫。
 *
 * ⚠️ 这是一个会让 Agent 永久卡死的真实缺陷：
 * Electron 45 已移除 `javascript-dialog` 事件，页面调用 `alert()` 时
 * 该 WebContents 会一直阻塞——实测后续任何 executeJavaScript / 工具调用
 * 都 3 秒超时且永不恢复。对 Agent 来说等于"浏览器突然不响应"。
 *
 * 处理方式：通过 CDP `Page.addScriptToEvaluateOnNewDocument` 在**页面脚本执行前**
 * 覆盖 alert / confirm / prompt / beforeunload 的默认行为，并把调用记录进
 * `window.__aaDialogs`，让 Agent 能用 browser_dialogs 读取。
 * 不用 preload 覆盖：contextIsolation 下 preload 与页面世界隔离，改不到 window.alert。
 */

const GUARD_SOURCE = `(() => {
  if (window.__aaDialogGuardInstalled) return
  window.__aaDialogGuardInstalled = true
  const push = (rec) => {
    try {
      window.__aaDialogs = window.__aaDialogs || []
      window.__aaDialogs.push(rec)
      if (window.__aaDialogs.length > 50) window.__aaDialogs.shift()
    } catch (e) {}
  }
  try {
    window.alert = function (message) { push({ type: 'alert', message: String(message ?? ''), ts: Date.now() }); return undefined }
    window.confirm = function (message) { push({ type: 'confirm', message: String(message ?? ''), ts: Date.now() }); return false }
    window.prompt = function (message, def) {
      push({ type: 'prompt', message: String(message ?? ''), defaultValue: def == null ? null : String(def), ts: Date.now() })
      return null
    }
    // beforeunload 返回值会触发"离开此页面？"系统弹窗，同样会卡住 Agent
    window.onbeforeunload = null
    if (typeof EventTarget === 'function') {
      window.addEventListener('beforeunload', (e) => { e.stopImmediatePropagation() }, true)
    }
  } catch (e) {}
})()`

/**
 * 为单个 WebContents 安装对话框守卫（幂等）。
 * 需要调试通道；与抓包共用同一 debugger，因此这里只 attach 一次就保留。
 */
export async function installDialogGuard(wc: WebContents): Promise<void> {
  const dbg = wc.debugger
  let attachedHere = false
  try {
    if (!dbg.isAttached()) {
      dbg.attach('1.3')
      attachedHere = true
    }
    await dbg.sendCommand('Page.enable')
    await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: GUARD_SOURCE })
    // 当前已加载的页面也要生效（导航前的空白页）
    try {
      await dbg.sendCommand('Runtime.evaluate', { expression: GUARD_SOURCE })
    } catch {
      /* 页面尚未创建执行上下文：新文档注入已足够 */
    }
  } catch {
    // 调试通道被 DevTools 占用等：不阻塞标签创建，但运行时会缺这层保护
    if (attachedHere) {
      try {
        dbg.detach()
      } catch {
        /* 忽略 */
      }
    }
  }
}

/** 读取页面记录的对话框（Agent 视角：页面弹了什么，而不真的弹出来） */
export async function readDialogs(wc: WebContents): Promise<{ type: string; message: string; defaultValue?: string | null; ts: number }[]> {
  try {
    const list = (await wc.executeJavaScript('(window.__aaDialogs || []).slice(-50)', false)) as
      | { type: string; message: string; defaultValue?: string | null; ts: number }[]
      | null
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

/** 清空记录，避免重复上报 */
export async function clearDialogs(wc: WebContents): Promise<number> {
  try {
    const n = (await wc.executeJavaScript('(() => { const n = (window.__aaDialogs || []).length; window.__aaDialogs = []; return n })()', false)) as number
    return typeof n === 'number' ? n : 0
  } catch {
    return 0
  }
}
