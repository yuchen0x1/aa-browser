import type { WebContents } from 'electron'
import { jsLiteral } from '@snapshot/scripts'

/**
 * 跨域 iframe 支持。
 *
 * 快照引擎受浏览器同源策略限制：跨域 iframe 只能看到外壳，内部元素既不可见也不可操作。
 * 但主进程可以通过 `webContents.mainFrame.framesInSubtree` 拿到每个子帧的
 * `WebFrameMain`，再用 `frame.executeJavaScript()` 在该帧自己的上下文里执行脚本。
 * 这样支付组件、OAuth 登录、第三方编辑器等真实站点就能被真正测到。
 *
 * 工具面按“帧 + CSS 选择器”工作，而不是复用顶层 ref：
 * 顶层 ref 属于顶层文档，跨帧无效；按选择器操作语义明确、不依赖快照。
 */

export interface FrameInfo {
  /** 稳定 id：`f<frameTreeNodeId>`，每次调用都可用 */
  id: string
  url: string
  name: string
  /** 顶层帧深度：0 = 主文档 */
  depth: number
  /** 是否跨域（与父帧 origin 不同或无法判定） */
  crossOrigin: boolean
}

function originOf(url: string): string | null {
  try {
    const parsed = new URL(url)
    if (!/^https?:$/.test(parsed.protocol)) return null
    return parsed.origin
  } catch {
    return null
  }
}

/** 枚举主文档与其全部子帧（含跨域），按深度优先排序 */
export function listFrames(wc: WebContents): FrameInfo[] {
  const out: FrameInfo[] = []
  if (wc.isDestroyed()) return out
  const root = wc.mainFrame
  if (!root) return out
  const walk = (frame: Electron.WebFrameMain, depth: number, parentOrigin: string | null): void => {
    let url = ''
    try {
      url = frame.url
    } catch {
      /* 帧可能已销毁 */
    }
    const origin = originOf(url)
    const frameId = `f${frame.frameTreeNodeId}`
    let name = ''
    try {
      name = frame.name || ''
    } catch {
      /* 忽略 */
    }
    out.push({
      id: frameId,
      url,
      name,
      depth,
      crossOrigin: depth > 0 && (!origin || !parentOrigin || origin !== parentOrigin)
    })
    let children: Electron.WebFrameMain[] = []
    try {
      children = frame.frames
    } catch {
      children = []
    }
    for (const child of children) walk(child, depth + 1, origin ?? parentOrigin)
  }
  walk(root, 0, originOf(root.url))
  return out
}

/** 按工具面 id 找到帧；主文档也允许显式指定 */
export function resolveFrame(wc: WebContents, id: string): Electron.WebFrameMain | null {
  const target = String(id || '').trim()
  if (!target) return null
  const frames = listFrames(wc)
  if (!frames.some((frame) => frame.id === target)) return null
  const walk = (frame: Electron.WebFrameMain): Electron.WebFrameMain | null => {
    if (`f${frame.frameTreeNodeId}` === target) return frame
    let children: Electron.WebFrameMain[] = []
    try {
      children = frame.frames
    } catch {
      children = []
    }
    for (const child of children) {
      const hit = walk(child)
      if (hit) return hit
    }
    return null
  }
  return walk(wc.mainFrame)
}

/** 在指定帧内执行脚本（跨域也可用，因为走的是该帧自己的上下文） */
export async function frameEvaluate(wc: WebContents, frameId: string, expression: string): Promise<unknown> {
  // evaluate 是显式执行表达式的工具操作；固定动作不经由这个入口。
  return runFrameScript(wc, frameId, `(() => { return (${expression}) })()`)
}

async function runFrameScript(wc: WebContents, frameId: string, script: string): Promise<unknown> {
  const frame = resolveFrame(wc, frameId)
  if (!frame) throw new Error(`找不到 iframe: ${frameId}（先用 browser_frame action=list 查看）`)
  return await frame.executeJavaScript(script, true)
}

/** 生成元素选择器的页面内片段：优先 id / data-testid / name，退回结构路径 */
const SELECTOR_HELPER = `
  const cssPath = (el) => {
    if (!el || el.nodeType !== 1) return '';
    if (el.id) return '#' + (window.CSS && CSS.escape ? CSS.escape(el.id) : el.id);
    const testId = el.getAttribute && el.getAttribute('data-testid');
    if (testId) return '[data-testid="' + String(testId).replace(/"/g, '\\\\"') + '"]';
    const name = el.getAttribute && el.getAttribute('name');
    if (name) return el.tagName.toLowerCase() + '[name="' + String(name).replace(/"/g, '\\\\"') + '"]';
    const parts = [];
    let node = el;
    let guard = 0;
    while (node && node.nodeType === 1 && guard < 6) {
      let part = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (parent) {
        const same = Array.prototype.filter.call(parent.children, (c) => c.tagName === node.tagName);
        if (same.length > 1) part += ':nth-of-type(' + (same.indexOf(node) + 1) + ')';
      }
      parts.unshift(part);
      node = parent;
      guard++;
    }
    return parts.join(' > ');
  };
  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const type = el.getAttribute && (el.getAttribute('type') || '');
    const text = (el.innerText || el.value || el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('title') || '').replace(/\\s+/g, ' ').trim().slice(0, 80);
    return tag + (type ? '[' + type + ']' : '') + (text ? ' "' + text + '"' : '');
  };
  const isInteractive = (el) => {
    const tag = el.tagName;
    if (['A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'OPTION'].includes(tag)) return true;
    if (el.isContentEditable) return true;
    const role = el.getAttribute && el.getAttribute('role');
    if (role && ['button', 'link', 'checkbox', 'radio', 'tab', 'menuitem', 'switch', 'combobox', 'textbox', 'slider'].includes(role)) return true;
    return el.hasAttribute && el.hasAttribute('tabindex');
  };
`

export interface FrameElement {
  selector: string
  description: string
  tag: string
}

/** 列出帧内可交互元素（带可用选择器），让 AI 知道能点什么 */
export async function frameElements(wc: WebContents, frameId: string, limit = 80): Promise<FrameElement[]> {
  const list = await runFrameScript(
    wc,
    frameId,
    `(() => {
      ${SELECTOR_HELPER}
      const nodes = Array.prototype.slice.call(document.querySelectorAll('a[href],button,input,select,textarea,summary,option,[role],[contenteditable="true"],[tabindex]'));
      const out = [];
      for (const el of nodes) {
        if (out.length >= ${Math.max(1, Math.min(200, limit))}) break;
        if (!isInteractive(el)) continue;
        const rect = el.getBoundingClientRect();
        if (rect.width < 1 || rect.height < 1) continue;
        const selector = cssPath(el);
        if (!selector) continue;
        out.push({ selector: selector, description: describe(el), tag: el.tagName.toLowerCase() });
      }
      return out;
    })()`
  )
  return Array.isArray(list) ? (list as FrameElement[]) : []
}

/** 帧内文本（innerText），用于读取跨域 iframe 内容 */
export async function frameText(wc: WebContents, frameId: string, maxChars = 4000): Promise<{ url: string; text: string; truncated: boolean }> {
  return (await runFrameScript(
    wc,
    frameId,
    `(() => {
      const text = String(document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n').trim();
      const limit = ${Math.max(200, Math.min(20000, maxChars))};
      return { url: String(location.href), text: text.slice(0, limit), truncated: text.length > limit };
    })()`
  )) as { url: string; text: string; truncated: boolean }
}

/** 帧内点击（合成 click，跨域可用；不受顶层命中测试影响） */
export async function frameClick(wc: WebContents, frameId: string, selector: string, index = 0): Promise<{ clicked: string }> {
  const result = (await runFrameScript(
    wc,
    frameId,
    `(() => {
      ${SELECTOR_HELPER}
      let nodes = [];
      try { nodes = Array.prototype.slice.call(document.querySelectorAll(${jsLiteral(selector)})) } catch (e) { return { ok: false, reason: 'invalid-selector' } }
      if (!nodes.length) return { ok: false, reason: 'not-found' };
      const el = nodes[${Math.max(0, Math.floor(index))}] || nodes[0];
      if (!el) return { ok: false, reason: 'index-out-of-range' };
      try { el.scrollIntoView({ block: 'center', inline: 'center' }) } catch (e) {}
      el.click();
      return { ok: true, clicked: describe(el) };
    })()`
  )) as { ok: boolean; reason?: string; clicked?: string }
  if (!result?.ok) {
    throw new Error(
      result?.reason === 'invalid-selector'
        ? `选择器无效: ${selector}`
        : result?.reason === 'index-out-of-range'
          ? `索引超出范围: ${index}`
          : `在 ${frameId} 内找不到元素: ${selector}（先用 action=elements 查看可用选择器）`
    )
  }
  return { clicked: result.clicked ?? selector }
}

/** 帧内输入：原生 setter + input/change 事件，兼容 React/Vue 受控组件 */
export async function frameType(wc: WebContents, frameId: string, selector: string, text: string): Promise<{ typed: string }> {
  const result = (await runFrameScript(
    wc,
    frameId,
    `(() => {
      ${SELECTOR_HELPER}
      let el = null;
      try { el = document.querySelector(${jsLiteral(selector)}) } catch (e) { return { ok: false, reason: 'invalid-selector' } }
      if (!el) return { ok: false, reason: 'not-found' };
      const value = ${jsLiteral(text)};
      el.focus();
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, value); else el.value = value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, typed: describe(el) };
    })()`
  )) as { ok: boolean; reason?: string; typed?: string }
  if (!result?.ok) throw new Error(result?.reason === 'invalid-selector' ? `选择器无效: ${selector}` : `在 ${frameId} 内找不到输入元素: ${selector}`)
  return { typed: result.typed ?? selector }
}

/** 帧内下拉选择：按 value 或可见文案匹配 */
export async function frameSelect(
  wc: WebContents,
  frameId: string,
  selector: string,
  opts: { value?: string; label?: string }
): Promise<{ selected: string }> {
  const result = (await runFrameScript(
    wc,
    frameId,
    `(() => {
      ${SELECTOR_HELPER}
      let el = null;
      try { el = document.querySelector(${jsLiteral(selector)}) } catch (e) { return { ok: false, reason: 'invalid-selector' } }
      if (!el) return { ok: false, reason: 'not-found' };
      const wantLabel = ${jsLiteral(opts.label ?? null)};
      const wantValue = ${jsLiteral(opts.value ?? null)};
      const options = Array.prototype.slice.call(el.options || []);
      const target = options.find((o) => wantLabel !== null && ((o.label || '') === wantLabel || (o.text || '').trim() === wantLabel))
        || options.find((o) => wantValue !== null && String(o.value) === String(wantValue));
      if (!target) return { ok: false, reason: 'option-not-found' };
      const proto = HTMLSelectElement.prototype;
      const desc = Object.getOwnPropertyDescriptor(proto, 'value');
      if (desc && desc.set) desc.set.call(el, target.value); else el.value = target.value;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, selected: (target.label || target.text || target.value) };
    })()`
  )) as { ok: boolean; reason?: string; selected?: string }
  if (!result?.ok) throw new Error(result?.reason === 'option-not-found' ? `在 ${frameId} 内找不到该选项` : `在 ${frameId} 内找不到下拉框: ${selector}`)
  return { selected: result.selected ?? '' }
}
