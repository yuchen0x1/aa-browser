/**
 * 动作脚本 —— 在页面主世界执行的定位/操作片段。
 * 均依赖快照引擎写入的 window.__aaRefs（ref -> Element）。
 * ref 已在主进程侧校验为 /^e\d+$/，可安全拼入字符串。
 */

const REF_GUARD = (ref: string): string => {
  if (!/^e\d+$/.test(ref)) throw new Error(`非法 ref: ${ref}`)
  return ref
}

/** ref → 可直接拼入脚本的字面量（'e12'）：先白名单校验，再拼接。 */
export const refLiteral = (ref: string): string => `'${REF_GUARD(ref)}'`

const CHAR_MAP: Record<string, string> = {
  '<': '\\u003C',
  '>': '\\u003E',
  '/': '\\u002F',
  '\u2028': '\\u2028',
  '\u2029': '\\u2029'
}

/**
 * 数据 → 可安全嵌入注入脚本的字面量。
 * JSON.stringify 负责引号、换行与反斜杠，再补上 JSON 不转义的 `<` `>` `/` 与
 * U+2028/U+2029，避免脚本被 `</script>` 或行分隔符截断（CodeQL
 * js/bad-code-sanitization 建议的做法）；JS 侧单靠 JSON.stringify 不算清理干净。
 */
export const jsLiteral = (value: unknown): string => {
  const json: string | undefined = JSON.stringify(value)
  return (json ?? 'null').replace(/[<>/\u2028\u2029]/g, (ch) => CHAR_MAP[ch] ?? ch)
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
  // 快照之后元素可能被隐藏/折叠；继续按旧坐标点击会命中其他元素，
  // 或通过合成事件触发一个用户根本点不到的东西。
  let cs = null
  try { cs = el.ownerDocument.defaultView ? el.ownerDocument.defaultView.getComputedStyle(el) : null } catch (e) {}
  if (!cs || cs.display === 'none' || cs.visibility === 'hidden' || parseFloat(cs.opacity || '1') === 0) {
    return { ok: false, reason: 'hidden' }
  }
  if (r.width < 1 || r.height < 1) return { ok: false, reason: 'not-visible' }
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
export const syntheticClickScript = (ref: string, button: 'left' | 'right' | 'middle' = 'left'): string => {
  REF_GUARD(ref)
  const btnCode = button === 'right' ? 2 : button === 'middle' ? 1 : 0
  return `(() => {
  const el = (window.__aaRefs || {})['${ref}']
  if (!el) return { ok: false, reason: 'no-ref' }
  if (!el.isConnected) return { ok: false, reason: 'detached' }
  let cx = 0, cy = 0
  try {
    const r = el.getBoundingClientRect()
    cx = r.x + r.width / 2; cy = r.y + r.height / 2
  } catch (e) {}
  const opts = { bubbles: true, cancelable: true, view: window, clientX: cx, clientY: cy, button: ${btnCode} }
  try {
    if (typeof PointerEvent === 'function') el.dispatchEvent(new PointerEvent('pointerdown', opts))
    el.dispatchEvent(new MouseEvent('mousedown', opts))
    if (typeof PointerEvent === 'function') el.dispatchEvent(new PointerEvent('pointerup', opts))
    el.dispatchEvent(new MouseEvent('mouseup', opts))
    if (${btnCode} === 2) {
      el.dispatchEvent(new MouseEvent('contextmenu', opts))
    } else {
      el.dispatchEvent(new MouseEvent('click', opts))
    }
  } catch (e) {
    try { el.click() } catch (e2) { return { ok: false, reason: 'dispatch-failed' } }
  }
  return { ok: true }
})()`
}

/**
 * 合成点击兜底（元素被遮挡或 sendInputEvent 静默丢失时）：
 * checkbox/radio 必须走真实 click 才会切换默认行为。
 */
export const clickScript = (ref: string): string => {
  return `(() => { const el = (window.__aaRefs || {})[${refLiteral(ref)}]; if (el) el.click(); return !!el })()`
}

/** Inspect an input target without reading or returning its current value. */
export const inspectInputScript = (ref: string): string => {
  REF_GUARD(ref)
  return `(() => {
  const el = (window.__aaRefs || {})['${ref}']
  if (!el || !el.isConnected) return { ok: false, reason: 'no-ref' }
  const type = String(el.type || '').toLowerCase()
  const label = String(el.labels && Array.from(el.labels).map(x => x.innerText || x.textContent).join(' ') || '')
  const autocomplete = String(el.autocomplete || '').toLowerCase()
  const meta = [label, el.name, el.id, autocomplete, el.placeholder, el.getAttribute('aria-label'), el.getAttribute('data-testid')].join(' ').toLowerCase()
  const secretPattern = /(token|secret|api.?key|access.?key|private.?key|password|passwd|credential|验证码|密钥|令牌|密码|otp|one.?time.?code|security.?code|auth.?code|card.?number|cc.?number|cvv|cvc|expiry|expiration)/i
  const sensitive = type === 'password' || /^(current-password|new-password|one-time-code|cc-csc|cc-number|cc-exp|cc-exp-month|cc-exp-year)$/.test(autocomplete) || secretPattern.test(meta)
  const fingerprint = [el.tagName, type, el.name || '', el.id || '', autocomplete, el.getAttribute('aria-label') || '', label].join('|')
  return { ok: true, sensitive, fingerprint, label: (label || el.getAttribute('aria-label') || el.name || el.id || type || el.tagName).slice(0, 120), type }
})()`
}

/** 敏感输入指纹：聚焦目标并回报特征串与包围盒，供确认前后比对目标是否漂移 */
export const fingerprintScript = (ref: string): string => {
  return `(() => {
  const e = (window.__aaRefs || {})[${refLiteral(ref)}]
  if (!e || !e.isConnected) return null
  const r = e.getBoundingClientRect()
  e.focus()
  const labels = e.labels ? Array.from(e.labels).map(x => x.innerText || x.textContent || '').join(' ') : ''
  const type = String(e.type || '').toLowerCase()
  const autocomplete = String(e.autocomplete || '').toLowerCase()
  return {
    fingerprint: [e.tagName, type, e.name || '', e.id || '', autocomplete, e.getAttribute('aria-label') || '', labels].join('|'),
    rect: [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]
  }
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
  const lit = jsLiteral(text)
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
  const vLit = jsLiteral(value == null ? null : String(value))
  const lLit = jsLiteral(label == null ? null : String(label))
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

/**
 * 滚动：先滚主文档，失败则找最大可滚动区域。
 *
 * 返回实际前后位置，而不是只回 `{ ok: true }`：调用方必须能区分
 * 「滚动指令已发出」和「页面真的移动了」——到末尾、内容不足一屏、
 * 或滚动容器尚未初始化时，scrollBy 会静默无操作，旧实现仍报告成功。
 */
export const scrollScript = (direction: string, amount: number): string => {
  const d = jsLiteral(direction)
  const a = Math.max(50, Math.min(3000, Math.round(amount)))
  return `(() => {
  const dir = ${d}, amt = ${a}
  const dx = dir === 'right' ? amt : dir === 'left' ? -amt : 0
  const dy = dir === 'down' ? amt : dir === 'up' ? -amt : 0
  const root = document.scrollingElement || document.documentElement
  const body = document.body
  const extent = (el) => {
    if (!el) return { width: 0, height: 0, viewWidth: window.innerWidth, viewHeight: window.innerHeight }
    const isRoot = el === document.scrollingElement || el === document.documentElement || el === body
    return {
      width: Math.max(Number(el.scrollWidth) || 0, isRoot && body ? Number(body.scrollWidth) || 0 : 0),
      height: Math.max(Number(el.scrollHeight) || 0, isRoot && body ? Number(body.scrollHeight) || 0 : 0),
      viewWidth: isRoot ? window.innerWidth : el.clientWidth,
      viewHeight: isRoot ? window.innerHeight : el.clientHeight
    }
  }
  const readPos = (el) => el
    ? { x: Math.round(Number(el.scrollLeft) || 0), y: Math.round(Number(el.scrollTop) || 0) }
    : { x: Math.round(window.scrollX || 0), y: Math.round(window.scrollY || 0) }
  // 在请求方向上还能不能再滚，而不是笼统的「到页面底部」。
  const atLimit = (pos, size) => {
    if (dy !== 0) return dy > 0 ? pos.y + size.viewHeight >= size.height - 2 : pos.y <= 1
    return dx > 0 ? pos.x + size.viewWidth >= size.width - 2 : pos.x <= 1
  }
  const state = (where, before, after, el, reason) => {
    const size = extent(el)
    return {
      ok: true,
      didScroll: before.x !== after.x || before.y !== after.y,
      where,
      before,
      after,
      requested: { x: dx, y: dy },
      moved: { x: after.x - before.x, y: after.y - before.y },
      atLimit: atLimit(after, size),
      scrollHeight: size.height,
      scrollWidth: size.width,
      viewportHeight: size.viewHeight,
      viewportWidth: size.viewWidth,
      visibilityState: String(document.visibilityState || 'unknown'),
      hidden: document.hidden === true,
      ...(reason ? { reason } : {})
    }
  }
  const rootBefore = readPos(root)
  try { window.scrollBy({ left: dx, top: dy, behavior: 'instant' }) } catch (e) { window.scrollBy(dx, dy) }
  const rootAfter = readPos(root)
  if (rootAfter.x !== rootBefore.x || rootAfter.y !== rootBefore.y) return state('window', rootBefore, rootAfter, root)
  // 页面没有移动：在请求方向上找最大的可滚动容器再试一次。
  let best = null, bestArea = 0, count = 0
  const all = document.querySelectorAll('div,main,section,nav,aside,ul,ol,textarea')
  for (let i = 0; i < all.length && count < 3000; i++, count++) {
    const el = all[i]
    let cs = null
    try { cs = getComputedStyle(el) } catch (e) {}
    if (!cs) continue
    const scrollableY = /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 4
    const scrollableX = /(auto|scroll)/.test(cs.overflowX) && el.scrollWidth > el.clientWidth + 4
    if (dy !== 0 ? !scrollableY : !scrollableX) continue
    const area = el.clientWidth * el.clientHeight
    if (area > bestArea) { bestArea = area; best = el }
  }
  if (best) {
    const before = readPos(best)
    if (dy) best.scrollTop += dy
    if (dx) best.scrollLeft += dx
    const after = readPos(best)
    return state('element', before, after, best)
  }
  const size = extent(root)
  const cannotScroll = dy !== 0 ? size.height <= size.viewHeight + 2 : size.width <= size.viewWidth + 2
  const reason = cannotScroll ? 'not-scrollable' : atLimit(rootAfter, size) ? 'at-limit' : 'no-scrollable-area'
  return state('none', rootBefore, rootAfter, root, reason)
})()`
}

/**
 * 页面状态摘要：地址、加载态、可见/焦点、滚动、弹窗、Cloudflare 验证与限流。
 *
 * 只读单次表达式。原生 alert/confirm 由对话框守卫记录到 window.__aaDialogs，
 * 这里一并带回最近几条，避免 Agent 为「页面到底弹了什么」反复 evaluate。
 */
export const pageStateScript = (): string => `(() => {
  const root = document.scrollingElement || document.documentElement
  const body = document.body
  const title = String(document.title || '')
  const text = String((body && (body.innerText || body.textContent)) || (document.documentElement && document.documentElement.innerText) || '').slice(0, 6000)
  const visibleDialogs = []
  try {
    const nodes = document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]')
    for (let i = 0; i < nodes.length && visibleDialogs.length < 5; i++) {
      const el = nodes[i]
      let cs = null
      try { cs = getComputedStyle(el) } catch (e) {}
      if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) continue
      let rect = null
      try { rect = el.getBoundingClientRect() } catch (e) {}
      if (rect && (rect.width <= 0 || rect.height <= 0)) continue
      visibleDialogs.push(String((el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 300)))
    }
  } catch (e) {}
  let nativeDialogs = []
  try {
    const records = Array.isArray(window.__aaDialogs) ? window.__aaDialogs.slice(-5) : []
    nativeDialogs = records.map((rec) => ({
      type: String(rec && rec.type || 'unknown'),
      message: String(rec && rec.message || '').slice(0, 300),
      ts: Number(rec && rec.ts) || 0
    }))
  } catch (e) {}
  let challengeVisible = false
  try {
    challengeVisible = /just a moment|attention required|checking your browser|verify you are human|验证.{0,6}(机器人|人机)|正在进行安全验证/i.test(title) ||
      !!document.querySelector('#challenge-form,#cf-challenge-running,#cf-please-wait,iframe[src*="challenges.cloudflare.com"],[data-translate="challenge_headline"]')
  } catch (e) {}
  const rateLimitHit = /(操作.{0,6}次数过多|请稍等\\s*\\d+\\s*秒|too many requests|rate limit|try again in \\s*\\d+\\s*seconds?)/i.test(text) ||
    /rate.?limit|too many requests/i.test(title)
  let retryAfterSeconds = null
  try {
    const retry = /(?:稍等|等待|after|in)\\s*(\\d{1,4})\\s*(?:秒|seconds?|s\\b)/i.exec(text)
    if (retry) {
      const n = Number(retry[1])
      if (Number.isFinite(n) && n > 0 && n <= 3600) retryAfterSeconds = n
    }
  } catch (e) {}
  const scrollHeight = root ? Math.max(Number(root.scrollHeight) || 0, body ? Number(body.scrollHeight) || 0 : 0) : 0
  const scrollY = Math.round(window.scrollY || 0)
  return {
    url: String(location.href),
    title,
    readyState: String(document.readyState || 'unknown'),
    visibilityState: String(document.visibilityState || 'unknown'),
    hidden: document.hidden === true,
    hasFocus: typeof document.hasFocus === 'function' ? document.hasFocus() === true : false,
    scroll: {
      x: Math.round(window.scrollX || 0),
      y: scrollY,
      scrollHeight,
      scrollWidth: root ? Number(root.scrollWidth) || 0 : 0,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
      atEnd: scrollY + window.innerHeight >= scrollHeight - 2,
      scrollable: scrollHeight > window.innerHeight + 2
    },
    dialogs: { count: visibleDialogs.length, visible: visibleDialogs, native: nativeDialogs },
    challenge: { provider: 'cloudflare', visible: challengeVisible, requiresUserAction: challengeVisible },
    rateLimit: { blocked: rateLimitHit, retryAfterSeconds }
  }
})()`


/** 文本提取：ref 元素或整页 */
export const extractScript = (ref?: string): string => {
  const refPart = ref ? `'${REF_GUARD(ref)}'` : 'null'
  return `(() => {
  const ref = ${refPart}
  const isSensitive = el => {
    const type = String(el.type || '').toLowerCase()
    const autocomplete = String(el.autocomplete || '').toLowerCase()
    const labels = el.labels ? Array.from(el.labels).map(x => x.innerText || x.textContent || '').join(' ') : ''
    const meta = [labels, el.name, el.id, autocomplete, el.placeholder, el.getAttribute && el.getAttribute('aria-label'), el.getAttribute && el.getAttribute('data-testid')].join(' ').toLowerCase()
    return type === 'password' || /^(current-password|new-password|one-time-code|cc-csc|cc-number|cc-exp|cc-exp-month|cc-exp-year)$/.test(autocomplete) || /(token|secret|api.?key|access.?key|private.?key|password|passwd|credential|验证码|密钥|令牌|密码|otp|one.?time.?code|security.?code|auth.?code|card.?number|cc.?number|cvv|cvc|expiry|expiration)/i.test(meta)
  }
  const safeText = root => {
    const clone = root.cloneNode(true)
    const originals = [root, ...root.querySelectorAll('*')]
    const copies = [clone, ...clone.querySelectorAll('*')]
    for (let i = 0; i < originals.length; i++) {
      const el = originals[i]
      const copy = copies[i]
      if (isSensitive(el) && copy) {
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') copy.value = '••••••'
        else copy.textContent = '••••••'
      }
    }
    // 离屏 clone 的 innerText 会退化到 textContent，把脚本/样式源码也带出来。
    try {
      clone.querySelectorAll('script,style,noscript,template').forEach(n => n.remove())
    } catch (e) {}
    return clone.innerText || clone.textContent || ''
  }
  if (ref) {
    const el = (window.__aaRefs || {})[ref]
    if (!el) return { ok: false, reason: 'no-ref' }
    if (!el.isConnected) return { ok: false, reason: 'detached' }
    let t = ''
    try { t = isSensitive(el) ? (el.value || el.textContent ? '••••••' : '') : ((el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') ? (el.value || '') : (el.innerText || el.textContent || '')) } catch (e) {}
    return { ok: true, text: t }
  }
  const t = document.body ? safeText(document.body) : (document.documentElement.innerText || '')
  return { ok: true, text: t, url: String(location.href), title: document.title || '' }
})()`
}

/** 等待文本出现（主进程轮询调用） */
export const containsTextScript = (text: string): string => {
  const lit = jsLiteral(text)
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

/** 读取 checkbox/radio 的勾选状态与类型（fill_form 判断是否真的需要点击） */
export const checkedStateScript = (ref: string): string => {
  return `(() => {
  const el = (window.__aaRefs || {})[${refLiteral(ref)}]
  if (!el) return { ok: false }
  return { ok: true, checked: !!el.checked, type: (el.type || '').toLowerCase() }
})()`
}

/** 读取元素标签名（fill_form 判断 <select> 用） */
export const tagNameScript = (ref: string): string => {
  return `(() => {
  const el = (window.__aaRefs || {})[${refLiteral(ref)}]
  return el ? el.tagName.toLowerCase() : ''
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
  function esc(s) { try { return window.CSS && CSS.escape ? CSS.escape(s) : s.replace(/([^\\w-])/g, '\\\\$1') } catch (e) { return s } }
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
  try { text = (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 80) } catch (e) {}
  return { ok: true, selector, verified, tag: el.tagName.toLowerCase(), text }
})()`
}

/** localStorage / sessionStorage 读写 */
export const storageScript = (action: string, kind: string, key?: string, value?: string): string => {
  const kLit = jsLiteral(key ?? null)
  const vLit = jsLiteral(value ?? null)
  return `(() => {
  const store = ${jsLiteral(kind)} === 'session' ? sessionStorage : localStorage
  const action = ${jsLiteral(action)}
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
  const lit = jsLiteral(files)
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

/** 视觉光标与波纹投影：在页面注入 AI 操作动画 */
export const laserCursorScript = (x: number, y: number, actionType: 'click' | 'hover' | 'drag' | 'type'): string => {
  return `(() => {
  try {
    let container = document.getElementById('__aa_agent_laser_overlay__')
    if (!container) {
      container = document.createElement('div')
      container.id = '__aa_agent_laser_overlay__'
      container.style.cssText = 'position:fixed;top:0;left:0;width:100vw;height:100vh;pointer-events:none;z-index:2147483647;overflow:hidden;'
      document.documentElement.appendChild(container)
    }

    const dot = document.createElement('div')
    const color = '${actionType === 'click' ? '#ff3b30' : actionType === 'type' ? '#34c759' : actionType === 'drag' ? '#af52de' : '#007aff'}'
    dot.style.cssText = 'position:absolute;left:' + ${x} + 'px;top:' + ${y} + 'px;width:18px;height:18px;border-radius:50%;background:' + color + ';box-shadow:0 0 12px ' + color + ';transform:translate(-50%,-50%) scale(1);transition:transform 0.45s cubic-bezier(0.1, 1, 0.1, 1), opacity 0.45s ease-out;opacity:0.95;pointer-events:none;'

    const ripple = document.createElement('div')
    ripple.style.cssText = 'position:absolute;left:' + ${x} + 'px;top:' + ${y} + 'px;width:14px;height:14px;border-radius:50%;border:2px solid ' + color + ';transform:translate(-50%,-50%) scale(1);transition:transform 0.6s ease-out, opacity 0.6s ease-out;opacity:1;pointer-events:none;'

    container.appendChild(dot)
    container.appendChild(ripple)

    requestAnimationFrame(() => {
      dot.style.transform = 'translate(-50%,-50%) scale(0.6)'
      ripple.style.transform = 'translate(-50%,-50%) scale(3.5)'
      ripple.style.opacity = '0'
      setTimeout(() => {
        dot.style.opacity = '0'
        setTimeout(() => {
          dot.remove()
          ripple.remove()
        }, 500)
      }, 400)
    })
  } catch (e) {}
})()`
}
