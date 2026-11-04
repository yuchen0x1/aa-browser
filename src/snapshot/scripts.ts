/**
 * 动作脚本 —— 在页面主世界执行的定位/操作片段。
 * 均依赖快照引擎写入的 window.__aaRefs（ref -> Element）。
 * ref 已在主进程侧校验为 /^e\d+$/，可安全拼入字符串。
 */

const REF_GUARD = (ref: string): string => {
  if (!/^e\d+$/.test(ref)) throw new Error(`非法 ref: ${ref}`)
  return ref
}

/** 定位元素：滚动到视野内，返回顶层视口坐标与命中测试结果 */
export const locateScript = (ref: string): string => {
  REF_GUARD(ref)
  return `(() => {
  const el = (window.__aaRefs || {})['${ref}']
  if (!el) return { ok: false, reason: 'no-ref' }
  if (!el.isConnected) return { ok: false, reason: 'detached' }
  try { el.scrollIntoView({ block: 'center', inline: 'nearest' }) } catch (e) {}
  let ox = 0, oy = 0
  let doc = el.ownerDocument
  while (doc && doc !== document) {
    const fel = doc.defaultView && doc.defaultView.frameElement
    if (!fel) return { ok: false, reason: 'cross-origin' }
    try {
      const fr = fel.getBoundingClientRect()
      ox += fr.x; oy += fr.y
      doc = fel.ownerDocument
    } catch (e) { return { ok: false, reason: 'cross-origin' } }
  }
  let r
  try { r = el.getBoundingClientRect() } catch (e) { return { ok: false, reason: 'detached' } }
  const x = Math.round(ox + r.x + r.width / 2)
  const y = Math.round(oy + r.y + r.height / 2)
  let hitOk = false
  try {
    const hit = document.elementFromPoint(x, y)
    hitOk = !!hit && (hit === el || hit.contains(el) || el.contains(hit) ||
      (hit.tagName === 'IFRAME' && hit.contentDocument && hit.contentDocument.contains(el)))
  } catch (e) {}
  let tag = 'unknown', type = '', editable = false, checked = false
  try {
    tag = el.tagName.toLowerCase()
    type = (el.type || '').toLowerCase()
    editable = !!el.isContentEditable
    checked = !!el.checked
  } catch (e) {}
  return { ok: true, x, y, hitOk, tag, type, editable, checked }
})()`
}

/** 命中测试失败时的兜底：在页面内合成完整鼠标事件序列 */
export const syntheticClickScript = (ref: string): string => {
  REF_GUARD(ref)
  return `(() => {
  const el = (window.__aaRefs || {})['${ref}']
  if (!el) return { ok: false, reason: 'no-ref' }
  if (!el.isConnected) return { ok: false, reason: 'detached' }
  let cx = 0, cy = 0
  try {
    const r = el.getBoundingClientRect()
    cx = r.x + r.width / 2; cy = r.y + r.height / 2
  } catch (e) {}
  const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: 0 }
  try {
    if (typeof PointerEvent === 'function') el.dispatchEvent(new PointerEvent('pointerdown', opts))
    el.dispatchEvent(new MouseEvent('mousedown', opts))
    if (typeof PointerEvent === 'function') el.dispatchEvent(new PointerEvent('pointerup', opts))
    el.dispatchEvent(new MouseEvent('mouseup', opts))
    el.dispatchEvent(new MouseEvent('click', opts))
  } catch (e) {
    try { el.click() } catch (e2) { return { ok: false, reason: 'dispatch-failed' } }
  }
  return { ok: true }
})()`
}

/** 聚焦元素（输入前调用） */
export const focusScript = (ref: string): string => {
  REF_GUARD(ref)
  return `(() => {
  const el = (window.__aaRefs || {})['${ref}']
  if (!el) return { ok: false, reason: 'no-ref' }
  if (!el.isConnected) return { ok: false, reason: 'detached' }
  try { el.focus() } catch (e) {}
  let tag = 'unknown', type = '', editable = false
  try {
    tag = el.tagName.toLowerCase()
    type = (el.type || '').toLowerCase()
    editable = !!el.isContentEditable
  } catch (e) {}
  return { ok: true, tag, type, editable }
})()`
}

/** 清空输入框（React/Vue 兼容：用原生 setter 触发 input 事件） */
export const clearScript = (ref: string): string => {
  REF_GUARD(ref)
  return `(() => {
  const el = (window.__aaRefs || {})['${ref}']
  if (!el) return { ok: false, reason: 'no-ref' }
  try {
    if (el.isContentEditable) { el.textContent = '' }
    else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const desc = Object.getOwnPropertyDescriptor(proto, 'value')
      if (desc && desc.set) desc.set.call(el, ''); else el.value = ''
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  } catch (e) { return { ok: false, reason: 'clear-failed' } }
  return { ok: true }
})()`
}

/**
 * 兜底写入：原生 setter + input/change 事件（React 受控输入兼容）。
 * text 以 JSON 字符串安全内嵌。
 */
export const setValueScript = (ref: string, text: string): string => {
  REF_GUARD(ref)
  const lit = JSON.stringify(text)
  return `(() => {
  const el = (window.__aaRefs || {})['${ref}']
  if (!el) return { ok: false, reason: 'no-ref' }
  try {
    if (el.isContentEditable) { el.textContent = ${lit} }
    else {
      const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      const desc = Object.getOwnPropertyDescriptor(proto, 'value')
      if (desc && desc.set) desc.set.call(el, ${lit}); else el.value = ${lit}
    }
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  } catch (e) { return { ok: false, reason: 'set-failed' } }
  return { ok: true }
})()`
}

/** 下拉选择：按 value 或 label 匹配 option，触发 change */
export const selectOptionScript = (ref: string, value?: string, label?: string): string => {
  REF_GUARD(ref)
  const vLit = JSON.stringify(value == null ? null : String(value))
  const lLit = JSON.stringify(label == null ? null : String(label))
  return `(() => {
  const el = (window.__aaRefs || {})['${ref}']
  if (!el) return { ok: false, reason: 'no-ref' }
  if (el.tagName !== 'SELECT') return { ok: false, reason: 'not-select', tag: el.tagName.toLowerCase() }
  const opts = Array.from(el.options || [])
  const wantV = ${vLit}, wantL = ${lLit}
  let m = null
  if (wantV != null) m = opts.find(o => o.value === wantV)
  if (!m && wantL != null) m = opts.find(o => (o.label || '').trim() === wantL.trim())
  if (!m && wantL != null) m = opts.find(o => (o.label || '').includes(wantL))
  if (!m) return { ok: false, reason: 'no-option', options: opts.slice(0, 30).map(o => ({ value: o.value, label: (o.label || o.value || '') })) }
  try {
    el.value = m.value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  } catch (e) { return { ok: false, reason: 'set-failed' } }
  return { ok: true, value: m.value, label: m.label || m.value }
})()`
}

/** 滚动：先滚主文档，失败则找最大可滚动区域 */
export const scrollScript = (direction: string, amount: number): string => {
  const d = JSON.stringify(direction)
  const a = Math.max(50, Math.min(3000, Math.round(amount)))
  return `(() => {
  const dir = ${d}, amt = ${a}
  const dx = dir === 'right' ? amt : dir === 'left' ? -amt : 0
  const dy = dir === 'down' ? amt : dir === 'up' ? -amt : 0
  const bx = window.scrollX, by = window.scrollY
  window.scrollBy(dx, dy)
  if (Math.abs(window.scrollY - by) > 0 || Math.abs(window.scrollX - bx) > 0) return { ok: true, where: 'window' }
  let best = null, bestArea = 0, count = 0
  const all = document.querySelectorAll('div,main,section,nav,aside,ul,ol,textarea')
  for (let i = 0; i < all.length && count < 3000; i++, count++) {
    const el = all[i]
    const cs = getComputedStyle(el)
    const scrollableY = /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 4
    const scrollableX = /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 4
    if (!scrollableY && !scrollableX) continue
    const area = el.clientWidth * el.clientHeight
    if (area > bestArea) { bestArea = area; best = el }
  }
  if (best) {
    if (dy) best.scrollTop += dy
    if (dx) best.scrollLeft += dx
    return { ok: true, where: 'element' }
  }
  return { ok: true, where: 'none' }
})()`
}

/** 文本提取：ref 元素或整页 */
export const extractScript = (ref?: string): string => {
  const refPart = ref ? `'${REF_GUARD(ref)}'` : 'null'
  return `(() => {
  const ref = ${refPart}
  if (ref) {
    const el = (window.__aaRefs || {})[ref]
    if (!el) return { ok: false, reason: 'no-ref' }
    if (!el.isConnected) return { ok: false, reason: 'detached' }
    let t = ''
    try {
      t = (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? (el.value || '') : (el.innerText || el.textContent || '')
    } catch (e) {}
    return { ok: true, text: t }
  }
  const t = document.body ? document.body.innerText : (document.documentElement.innerText || '')
  return { ok: true, text: t, url: String(location.href), title: document.title || '' }
})()`
}

/** 等待文本出现（主进程轮询调用） */
export const containsTextScript = (text: string): string => {
  const lit = JSON.stringify(text)
  return `(() => {
  try { return !!document.body && document.body.innerText.indexOf(${lit}) !== -1 } catch (e) { return false }
})()`
}

/** 读取输入框当前值（type 校验用） */
export const readValueScript = (ref: string): string => {
  REF_GUARD(ref)
  return `(() => {
  const el = (window.__aaRefs || {})['${ref}']
  if (!el) return { ok: false, reason: 'no-ref' }
  try {
    return { ok: true, value: el.isContentEditable ? (el.textContent || '') : (el.value != null ? el.value : '') }
  } catch (e) { return { ok: false, reason: 'read-failed' } }
})()`
}

/** 获取元素完整包围盒（顶层视口坐标，先滚动到视野内）——元素级截图用 */
export const rectScript = (ref: string): string => {
  REF_GUARD(ref)
  return `(() => {
  const el = (window.__aaRefs || {})['${ref}']
  if (!el) return { ok: false, reason: 'no-ref' }
  if (!el.isConnected) return { ok: false, reason: 'detached' }
  try { el.scrollIntoView({ block: 'center', inline: 'nearest' }) } catch (e) {}
  let ox = 0, oy = 0
  let doc = el.ownerDocument
  while (doc && doc !== document) {
    const fel = doc.defaultView && doc.defaultView.frameElement
    if (!fel) return { ok: false, reason: 'cross-origin' }
    try { const fr = fel.getBoundingClientRect(); ox += fr.x; oy += fr.y; doc = fel.ownerDocument } catch (e) { return { ok: false, reason: 'cross-origin' } }
  }
  const r = el.getBoundingClientRect()
  return { ok: true, x: Math.round(ox + r.x), y: Math.round(oy + r.y), width: Math.round(r.width), height: Math.round(r.height) }
})()`
}

/** 生成元素 CSS 选择器并回验（BrowserTools 风格） */
export const selectorScript = (ref: string): string => {
  REF_GUARD(ref)
  return `(() => {
  const el = (window.__aaRefs || {})['${ref}']
  if (!el) return { ok: false, reason: 'no-ref' }
  function esc(s) { try { return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/([^\w-])/g, '\\$1') } catch (e) { return s } }
  function build(el) {
    if (el.id) { const s = '#' + esc(el.id); try { if (document.querySelector(s) === el) return s } catch (e) {} }
    const parts = []
    let cur = el, depth = 0
    while (cur && cur.nodeType === 1 && depth < 6) {
      if (cur.id) { parts.unshift('#' + esc(cur.id)); break }
      let sel = cur.tagName.toLowerCase()
      try {
        const cls = Array.from(cur.classList || []).slice(0, 2).map(esc)
        if (cls.length) sel += '.' + cls.join('.')
        const parent = cur.parentElement
        if (parent) {
          const same = Array.from(parent.children).filter(c => c.tagName === cur.tagName)
          if (same.length > 1) sel += ':nth-of-type(' + (same.indexOf(cur) + 1) + ')'
        }
      } catch (e) {}
      parts.unshift(sel)
      cur = cur.parentElement
      depth++
    }
    return parts.join(' > ')
  }
  const selector = build(el)
  let verified = false
  try { verified = document.querySelector(selector) === el } catch (e) {}
  let text = ''
  try { text = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80) } catch (e) {}
  return { ok: true, selector, verified, tag: el.tagName.toLowerCase(), text }
})()`
}

/** localStorage / sessionStorage 读写 */
export const storageScript = (action: string, kind: string, key?: string, value?: string): string => {
  const kLit = JSON.stringify(key ?? null)
  const vLit = JSON.stringify(value ?? null)
  return `(() => {
  const store = ${JSON.stringify(kind)} === 'session' ? sessionStorage : localStorage
  const action = ${JSON.stringify(action)}
  try {
    if (action === 'get') {
      const key = ${kLit}
      if (key != null) return { ok: true, key, value: store.getItem(key) }
      const keys = Object.keys(store)
      const values = {}
      keys.slice(0, 50).forEach(k => { values[k] = (store.getItem(k) || '').slice(0, 500) })
      return { ok: true, count: keys.length, values, truncated: keys.length > 50 }
    }
    if (action === 'set') { store.setItem(${kLit}, ${vLit}); return { ok: true, key: ${kLit} } }
    if (action === 'remove') { store.removeItem(${kLit}); return { ok: true } }
    if (action === 'clear') { store.clear(); return { ok: true } }
    return { ok: false, reason: 'bad-action' }
  } catch (e) { return { ok: false, reason: String(e && e.message || e) } }
})()`
}

/** 文件上传：注入 File 对象到 <input type=file>（主进程先读文件转 base64） */
export const uploadScript = (ref: string, files: { name: string; type: string; data: string }[]): string => {
  REF_GUARD(ref)
  const lit = JSON.stringify(files)
  return `(() => {
  const el = (window.__aaRefs || {})['${ref}']
  if (!el) return { ok: false, reason: 'no-ref' }
  if (el.tagName !== 'INPUT' || (el.type || '').toLowerCase() !== 'file') {
    return { ok: false, reason: 'not-file-input', tag: el.tagName.toLowerCase(), type: (el.type || '').toLowerCase() }
  }
  try {
    const dt = new DataTransfer()
    for (const f of ${lit}) {
      const bytes = Uint8Array.from(atob(f.data), c => c.charCodeAt(0))
      dt.items.add(new File([bytes], f.name, { type: f.type || 'application/octet-stream' }))
    }
    el.files = dt.files
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
    return { ok: true, count: el.files.length, names: Array.from(el.files).map(f => f.name) }
  } catch (e) { return { ok: false, reason: String(e && e.message || e) } }
})()`
}
