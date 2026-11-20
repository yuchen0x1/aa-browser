import type { WebContents } from 'electron'

/**
 * 页面主世界脚本：记录 attachShadow({mode:'closed'}) 返回的 ShadowRoot。
 *
 * 只暴露一个 Symbol 键的只读查询函数给快照引擎，不提供任何 Electron/Node 能力；
 * 用 WeakMap 持有 host -> root，host 被回收时条目自动消失。
 * 必须在文档开始处注入，否则页面自己创建 closed root 时为时已晚。
 */
export const CLOSED_SHADOW_SOURCE = `(() => {
  var KEY = Symbol.for('aa.closedRoots');
  if (window[KEY]) return;
  var roots = new WeakMap();
  var native = Element.prototype.attachShadow;
  try {
    Element.prototype.attachShadow = function (init) {
      var root = native.call(this, init);
      if (init && init.mode === 'closed') { try { roots.set(this, root); } catch (e) {} }
      return root;
    };
  } catch (e) {}
  try {
    Object.defineProperty(window, KEY, {
      value: function (host) { try { return roots.get(host) || null; } catch (e) { return null; } },
      configurable: false,
      writable: false
    });
  } catch (e) {}
})()`

/** 为单个 WebContents 安装 closed-shadow 捕获（幂等；失败不阻塞标签创建）。 */
export async function installClosedShadowCapture(wc: WebContents): Promise<void> {
  const dbg = wc.debugger
  let attachedHere = false
  try {
    if (!dbg.isAttached()) {
      dbg.attach('1.3')
      attachedHere = true
    }
    await dbg.sendCommand('Page.enable')
    await dbg.sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: CLOSED_SHADOW_SOURCE })
    // 当前已加载的页面也补一次（导航前的空白页）
    try {
      await dbg.sendCommand('Runtime.evaluate', { expression: CLOSED_SHADOW_SOURCE })
    } catch {
      /* 尚无执行上下文：新文档注入已足够 */
    }
  } catch {
    // 调试通道被 DevTools 占用等：不阻塞标签创建，快照会自动降级为看不到 closed root
    if (attachedHere) {
      try {
        dbg.detach()
      } catch {
        /* 忽略 */
      }
    }
  }
}
