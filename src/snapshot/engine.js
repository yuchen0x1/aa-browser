// @ts-nocheck
/**
 * 页面快照引擎 —— 注入到页面主世界运行的核心。
 *
 * ⚠️ 本函数必须完全自包含：不引用任何外部变量、不使用 import。
 * 主进程通过 `Function.prototype.toString()` 取出源码，以 `(<fn>)()` 形式
 * 通过 webContents.executeJavaScript() 注入页面执行，返回可序列化的快照。
 *
 * 设计对齐 Playwright MCP 的 aria snapshot + ref 规范：
 *   - button "登录" [ref=e5]
 * Agent 通过 ref 调用 browser_click / browser_type 等工具。
 *
 * 同时在本帧（含同源 iframe 递归时挂在顶层 window）上维护
 * window.__aaRefs: { [ref]: Element } 供动作引擎定位。
 */
export function __aaSnapshot() {
  'use strict'
  var MAX_NODES = 500
  var MAX_TEXT = 300
  var MAX_OPTIONS = 8
  var MAX_DEPTH = 40

  var truncated = false
  var seq = 0
  var refs = {} // ref -> Element（仅存在于页面世界）
  var elements = [] // 可序列化的元素信息
  var lines = []
  var topDoc = document

  function clip(s, n) {
    n = n || MAX_TEXT
    s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim()
    if (s.length > n) {
      truncated = true
      return s.slice(0, n - 1) + '…'
    }
    return s
  }

  function styleOf(el) {
    try {
      return el.ownerDocument.defaultView.getComputedStyle(el)
    } catch (e) {
      return null
    }
  }

  function isVisible(el) {
    try {
      if (el.closest && el.closest('[aria-hidden="true"],[hidden]')) return false
      var cs = styleOf(el)
      if (!cs) return false
      if (cs.display === 'none' || cs.visibility === 'hidden') return false
      if (parseFloat(cs.opacity || '1') === 0) return false
      var r = el.getBoundingClientRect()
      if (r.width < 1 || r.height < 1) return false
      return true
    } catch (e) {
      return false
    }
  }

  function cssEsc(s) {
    try {
      if (window.CSS && CSS.escape) return CSS.escape(s)
    } catch (e) {}
    return s.replace(/["\\]/g, '\\$&')
  }

  /** 计算无障碍名称：aria-label > aria-labelledby > alt > placeholder > title > label[for] > value > innerText */
  function labelFor(el) {
    var al = el.getAttribute && el.getAttribute('aria-label')
    if (al && al.trim()) return al.trim()
    var lb = el.getAttribute && el.getAttribute('aria-labelledby')
    if (lb) {
      var parts = []
      var ids = lb.split(/\s+/)
      for (var i = 0; i < ids.length; i++) {
        var t = null
        try {
          t = el.ownerDocument.getElementById(ids[i]) || topDoc.getElementById(ids[i])
        } catch (e) {}
        if (t) parts.push(t.textContent || '')
      }
      var j = parts.join(' ').trim()
      if (j) return j
    }
    if (el.tagName === 'IMG') {
      var a = el.getAttribute('alt')
      if (a) return a
    }
    var ph = el.getAttribute && el.getAttribute('placeholder')
    if (ph && ph.trim()) return ph
    var ti = el.getAttribute && el.getAttribute('title')
    if (ti && ti.trim()) return ti
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') {
      var id = el.id
      if (id) {
        try {
          var lab = el.ownerDocument.querySelector('label[for="' + cssEsc(id) + '"]')
          if (lab && lab.textContent && lab.textContent.trim()) return lab.textContent.trim()
        } catch (e) {}
      }
      var wrap = el.closest ? el.closest('label') : null
      if (wrap && wrap.textContent && wrap.textContent.trim()) return wrap.textContent.trim()
      var name = el.getAttribute && el.getAttribute('name')
      if (name) return name
    }
    if (el.tagName === 'INPUT') {
      var v = el.getAttribute('value')
      if (v) return v
    }
    var tx = el.innerText || el.textContent || ''
    return tx.trim()
  }

  var INTERACTIVE_ROLES = {
    link: 1,
    button: 1,
    textbox: 1,
    searchbox: 1,
    combobox: 1,
    listbox: 1,
    checkbox: 1,
    radio: 1,
    switch: 1,
    option: 1,
    tab: 1,
    menuitem: 1,
    menuitemcheckbox: 1,
    menuitemradio: 1,
    slider: 1,
    spinbutton: 1,
    treeitem: 1
  }

  function roleOf(el) {
    var explicit = el.getAttribute && el.getAttribute('role')
    if (explicit && explicit !== 'presentation' && explicit !== 'none') return explicit
    var t = el.tagName
    if (t === 'A') return el.hasAttribute('href') ? 'link' : null
    if (t === 'BUTTON' || t === 'SUMMARY') return 'button'
    if (t === 'SELECT') return 'combobox'
    if (t === 'TEXTAREA') return 'textbox'
    if (t === 'IMG') return el.getAttribute('alt') ? 'img' : null
    if (t === 'INPUT') {
      var ty = (el.type || 'text').toLowerCase()
      if (ty === 'checkbox') return 'checkbox'
      if (ty === 'radio') return 'radio'
      if (ty === 'button' || ty === 'submit' || ty === 'reset' || ty === 'image' || ty === 'file')
        return 'button'
      if (ty === 'range') return 'slider'
      if (ty === 'hidden') return null
      return 'textbox'
    }
    if (t === 'IFRAME') return 'iframe'
    var m = /^H([1-6])$/.exec(t)
    if (m) return 'heading'
    if (t === 'NAV') return 'navigation'
    if (t === 'MAIN') return 'main'
    if (t === 'HEADER') return 'banner'
    if (t === 'FOOTER') return 'contentinfo'
    if (t === 'ASIDE') return 'complementary'
    if (t === 'ARTICLE') return 'article'
    if (t === 'DIALOG') return 'dialog'
    if (t === 'FORM') return el.getAttribute('aria-label') ? 'form' : null
    return null
  }

  function valueText(el) {
    try {
      if (el.tagName === 'INPUT' && (el.type || '').toLowerCase() === 'password') {
        return el.value ? '••••••' : ''
      }
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.value || ''
      if (el.isContentEditable) return el.textContent || ''
    } catch (e) {}
    return ''
  }

  function indent(d) {
    var s = ''
    for (var i = 0; i < d; i++) s += '  '
    return s
  }

  function bboxTopFrame(el, ox, oy) {
    try {
      var r = el.getBoundingClientRect()
      return [Math.round(ox + r.x), Math.round(oy + r.y), Math.round(r.width), Math.round(r.height)]
    } catch (e) {
      return undefined
    }
  }

  /** 记录一个交互元素并输出树行 */
  function record(el, role, name, depth, ox, oy) {
    seq++
    var ref = 'e' + seq
    refs[ref] = el
    var info = {
      ref: ref,
      role: role,
      name: clip(name),
      tag: el.tagName.toLowerCase()
    }
    var bb = bboxTopFrame(el, ox, oy)
    if (bb) info.bbox = bb

    if (role === 'link' && el.getAttribute('href')) {
      var href = el.getAttribute('href') || ''
      try {
        href = el.href || href
      } catch (e) {}
      if (href) info.href = clip(href, 200)
    }
    if (role === 'textbox' || role === 'searchbox' || role === 'combobox') {
      var v = valueText(el)
      if (v) info.value = clip(v, 150)
      if (el.tagName === 'TEXTAREA' || el.isContentEditable) info.multiline = true
    }
    if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox') {
      info.checked = !!el.checked
    }
    if (el.disabled) info.disabled = true
    if (role === 'heading') info.level = parseInt(el.tagName.charAt(1), 10) || undefined
    if (role === 'combobox' && el.tagName === 'SELECT') {
      var opts = []
      try {
        var os = el.options
        for (var i = 0; i < os.length && i < MAX_OPTIONS; i++) opts.push(os[i].label || os[i].value)
        if (os.length > MAX_OPTIONS) truncated = true
      } catch (e) {}
      if (opts.length) info.options = opts
    }
    elements.push(info)

    // 树行
    var line = '- ' + role
    if (info.name) line += ' "' + info.name + '"'
    if (role === 'heading' && info.level) line += ' [level=' + info.level + ']'
    line += ' [ref=' + ref + ']'
    if (info.checked) line += ' [checked]'
    if (info.disabled) line += ' [disabled]'
    if (info.expanded !== undefined) line += ' [expanded]'
    if ((role === 'textbox' || role === 'searchbox' || role === 'combobox') && info.value) {
      line += ': ' + info.value
    }
    lines.push(indent(depth) + line)

    // select 的 option 子项展示（不加 ref）
    if (role === 'combobox' && el.tagName === 'SELECT') {
      try {
        var os2 = el.options
        var n = Math.min(os2.length, MAX_OPTIONS)
        for (var k = 0; k < n; k++) {
          var ol = (os2[k].label || os2[k].value || '').trim()
          if (!ol) continue
          var mark = os2[k].selected ? ' [selected]' : ''
          lines.push(indent(depth + 1) + '- option "' + clip(ol, 80) + '"' + mark)
        }
      } catch (e) {}
    }
  }

  var SKIP_TAGS = {
    SCRIPT: 1,
    STYLE: 1,
    NOSCRIPT: 1,
    TEMPLATE: 1,
    SVG: 1,
    HEAD: 1,
    META: 1,
    LINK: 1,
    TITLE: 1,
    BASE: 1
  }

  /** 递归遍历 DOM（含同源 iframe 与 open shadow root） */
  function walk(node, depth, ox, oy) {
    if (lines.length >= MAX_NODES) {
      truncated = true
      return
    }
    if (depth > MAX_DEPTH) return

    // 文本节点
    if (node.nodeType === 3) {
      var pl = node.parentElement
      // label 自带控件时其文本已作为控件名称，跳过避免重复
      if (pl && pl.closest && pl.closest('label')) {
        try {
          if (pl.querySelector('input,select,textarea,button')) return
        } catch (e) {}
      }
      var t = clip(node.nodeValue)
      if (t && lines.length < MAX_NODES) lines.push(indent(depth) + '- text "' + t + '"')
      return
    }
    if (node.nodeType !== 1) return

    var el = node
    var tag = el.tagName
    if (SKIP_TAGS[tag]) return
    if (!isVisible(el)) return

    var role = roleOf(el)

    // iframe：同源则递归，跨源则记一行
    if (tag === 'IFRAME') {
      var doc = null
      try {
        doc = el.contentDocument
      } catch (e) {
        doc = null
      }
      if (doc && doc.documentElement) {
        try {
          var fr = el.getBoundingClientRect()
          walk(doc.documentElement, depth, ox + fr.x, oy + fr.y)
        } catch (e) {}
        return
      }
      lines.push(indent(depth) + '- iframe "' + clip(el.title || el.name || el.src, 80) + '" [cross-origin]')
      return
    }

    // 段落类：无交互子元素时整体输出文本
    if ((tag === 'P' || tag === 'BLOCKQUOTE' || tag === 'PRE' || tag === 'CODE') && !role) {
      var hasInteractive = false
      try {
        hasInteractive = !!el.querySelector('a,button,input,select,textarea,[contenteditable]')
      } catch (e) {}
      if (!hasInteractive) {
        var pt = clip(el.innerText || el.textContent || '')
        if (pt && lines.length < MAX_NODES) lines.push(indent(depth) + '- text "' + pt + '"')
        return
      }
    }

    // 图片：无 alt 视为装饰性，跳过
    if (tag === 'IMG' && !role) return

    var interactive = false
    if (role && INTERACTIVE_ROLES[role]) interactive = true
    try {
      if (!interactive && el.isContentEditable) {
        role = role || 'textbox'
        interactive = true
      }
      if (!interactive && !role && el.getAttribute) {
        var oc = el.getAttribute('onclick')
        var ce = el.getAttribute('contenteditable')
        if (oc || (ce !== null && ce !== 'false')) {
          role = oc ? 'button' : 'textbox'
          interactive = true
        }
      }
    } catch (e) {}

    if (interactive) {
      record(el, role, labelFor(el), depth, ox, oy)
      // 输入类/按钮类一般是叶子，不再深入其子元素（label 例外，继续找关联控件文本）
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT') return
      var kids = el.childNodes
      for (var i2 = 0; i2 < kids.length; i2++) walk(kids[i2], depth + 1, ox, oy)
    } else {
      // 地标/标题容器：输出自身行
      if (role) {
        var nm = labelFor(el)
        var ln = indent(depth) + '- ' + role
        if (nm && nm !== clip(el.innerText || '', 40)) ln += ' "' + clip(nm, 80) + '"'
        if (role === 'heading') ln = indent(depth) + '- heading "' + clip(el.innerText || '', 120) + '" [level=' + (parseInt(el.tagName.charAt(1), 10) || 1) + ']'
        if (role === 'dialog') ln += ' [modal]'
        lines.push(ln)
        depth = depth + 1
      }
      var kids2 = el.childNodes
      for (var j = 0; j < kids2.length; j++) walk(kids2[j], depth, ox, oy)
    }

    // open shadow root
    try {
      if (el.shadowRoot) {
        var sr = el.shadowRoot.childNodes
        for (var k2 = 0; k2 < sr.length; k2++) walk(sr[k2], depth + 1, ox, oy)
      }
    } catch (e) {}
  }

  try {
    var root = document.body || document.documentElement
    if (root) walk(root, 0, 0, 0)
  } catch (e) {
    return { v: 1, error: 'snapshot-failed: ' + (e && e.message) }
  }

  try {
    window.__aaRefs = refs
  } catch (e) {}

  return {
    v: 1,
    url: String(location.href),
    title: clip(document.title || '', 150),
    tree: lines.join('\n'),
    elements: elements,
    truncated: truncated,
    capturedAt: Date.now()
  }
}
