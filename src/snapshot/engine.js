// @ts-nocheck
/**
 * 页面快照引擎 —— 注入到页面主世界运行的核心。
 *
 * ⚠️ 本函数必须完全自包含：不引用任何外部变量、不使用 import。
 * 主进程通过 `Function.prototype.toString()` 取出源码，以 `(<fn>)(opts)` 形式
 * 通过 webContents.executeJavaScript() 注入页面执行，返回可序列化的快照。
 *
 * 设计对齐 Playwright MCP 的 aria snapshot + ref 规范：
 *   - button "登录" [ref=e5]
 * Agent 通过 ref 调用 browser_click / browser_type 等工具。
 *
 * v2 增量特性（降 token）：
 *   1. ref 跨快照复用：仍连接的元素直接沿用旧 ref；React 重渲染重建的节点
 *      通过"内容签名"（tag|role|name|href）匹配旧 ref，只有新元素才分配新 ref。
 *      → 旧快照里的 ref 持续有效，动作更稳。
 *   2. 增量 diff：新旧树做前缀/后缀裁剪 + LCS：
 *      - 完全一致 → 「无变化」一行（≈50 token）
 *      - 小变化   → 只返回变更区块 ± 上下文
 *      - 大变化/URL 跳转/强制 full → 完整快照
 *
 * 同时在本帧（含同源 iframe 递归时挂在顶层 window）上维护：
 *   window.__aaRefs      { [ref]: Element }   动作引擎定位用
 *   window.__aaSnapState { v,url,title,lines,refs,elements,nextSeq }  增量状态
 */
export function __aaSnapshot() {
  'use strict'
  var MAX_NODES = 500
  var MAX_TEXT = 300
  var MAX_OPTIONS = 8
  var MAX_DEPTH = 40
  var DIFF_WINDOW = 260 // 中段差异行数上限，超过直接回退完整快照
  var PATCH_MAX_CHARS = 8000

  var opts = typeof arguments[0] === 'object' && arguments[0] !== null ? arguments[0] : {}

  var truncated = false
  var seq = 0
  var refs = {} // ref -> Element（动作定位）
  var refOf = null // Map Element -> ref（活元素复用）
  var sigPool = {} // sig -> [ref]（失连元素的签名池）
  var elements = [] // 可序列化的元素信息
  var lines = []
  var topDoc = document

  /* ── 恢复上次快照状态（同 URL 且未强制 full 时） ── */
  var prevState = null
  try {
    prevState = window.__aaSnapState || null
  } catch (e) {}
  if (
    prevState &&
    (prevState.v !== 2 ||
      prevState.url !== String(location.href) ||
      opts.mode === 'full' ||
      !prevState.lines ||
      !prevState.refs)
  ) {
    prevState = null
  }
  if (prevState) {
    try {
      refOf = new Map()
    } catch (e) {
      refOf = null
    }
    seq = prevState.nextSeq || 0
    var oldRefs = prevState.refs
    var infoByRef = {}
    var prevEls = prevState.elements || []
    for (var pe = 0; pe < prevEls.length; pe++) infoByRef[prevEls[pe].ref] = prevEls[pe]
    for (var r0 in oldRefs) {
      var el0 = oldRefs[r0]
      var conn = false
      try {
        conn = !!(el0 && el0.isConnected)
      } catch (e) {}
      if (conn) {
        refs[r0] = el0
        if (refOf) {
          try {
            refOf.set(el0, r0)
          } catch (e) {}
        }
      } else {
        var inf = infoByRef[r0]
        if (inf) {
          var sg = [inf.tag, inf.role, inf.name, inf.href || ''].join('|')
          if (!sigPool[sg]) sigPool[sg] = []
          sigPool[sg].push(r0)
        }
      }
    }
  }

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
      var ty = (el.type || 'text').toLowerCase()
      if (ty !== 'password') {
        var v = el.getAttribute('value')
        if (v) return v
      }
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
      if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable) {
        var type = String(el.type || '').toLowerCase()
        var autocomplete = String(el.autocomplete || '').toLowerCase()
        var labels = el.labels ? Array.from(el.labels).map(function (x) { return x.innerText || x.textContent || '' }).join(' ') : ''
        var meta = [labels, el.name, el.id, autocomplete, el.placeholder, el.getAttribute && el.getAttribute('aria-label'), el.getAttribute && el.getAttribute('data-testid')].join(' ').toLowerCase()
        var sensitive = type === 'password' || /^(current-password|new-password|one-time-code|cc-csc|cc-number|cc-exp|cc-exp-month|cc-exp-year)$/.test(autocomplete) || /(token|secret|api.?key|access.?key|private.?key|password|passwd|credential|验证码|密钥|令牌|密码|otp|one.?time.?code|security.?code|auth.?code|card.?number|cc.?number|cvv|cvc|expiry|expiration)/i.test(meta)
        if (sensitive) return el.value || el.textContent ? '••••••' : ''
        if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') return el.value || ''
        return el.textContent || ''
      }
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

  /** ref 分配：活元素复用 > 签名匹配失连元素 > 新 ref */
  function assignRef(el, sig) {
    var ref = null
    if (refOf) {
      try {
        ref = refOf.get(el) || null
      } catch (e) {}
    }
    if (!ref) {
      var pool = sigPool[sig]
      if (pool && pool.length) ref = pool.pop()
      else {
        seq++
        ref = 'e' + seq
      }
    }
    refs[ref] = el
    if (refOf) {
      try {
        refOf.set(el, ref)
      } catch (e) {}
    }
    return ref
  }

  /** 记录一个交互元素并输出树行 */
  function record(el, role, name, depth, ox, oy) {
    var info = {
      ref: '',
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
      var optsList = []
      try {
        var os = el.options
        for (var i = 0; i < os.length && i < MAX_OPTIONS; i++) optsList.push(os[i].label || os[i].value)
        if (os.length > MAX_OPTIONS) truncated = true
      } catch (e) {}
      if (optsList.length) info.options = optsList
    }

    var sig = [info.tag, info.role, info.name, info.href || ''].join('|')
    info.ref = assignRef(el, sig)
    elements.push(info)

    // 树行
    var line = '- ' + role
    if (info.name) line += ' "' + info.name + '"'
    if (role === 'heading' && info.level) line += ' [level=' + info.level + ']'
    line += ' [ref=' + info.ref + ']'
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
      // 输入类/按钮类一般是叶子，不再深入其子元素
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
    return { v: 2, mode: 'full', error: 'snapshot-failed: ' + (e && e.message) }
  }

  var url = String(location.href)
  var title = clip(document.title || '', 150)

  /* ── diff 与三模式输出 ── */

  function fullText() {
    var head =
      '页面快照（完整） url: ' + url + '\n' +
      'title: ' + title + '\n' +
      '元素数: ' + elements.length + (truncated ? '（内容已截断，可滚动后重新快照）' : '')
    return head + '\n\n' + (lines.join('\n') || '（页面无可渲染内容）')
  }

  function unchangedText(n) {
    return (
      '页面快照（无变化） url: ' + url + '\n' +
      'title: ' + title + '\n' +
      '与上次快照完全一致（共 ' + n + ' 行）；之前的 ref 全部仍然有效，可直接继续操作。'
    )
  }

  function normKey(l) {
    return l.replace(/^[ ]+/, '')
  }

  /** 对中段 [p..eO] × [p..eN] 做 LCS diff，返回绝对下标的 ops */
  function diffMiddle(p, eO, eN, oldK, newK) {
    var n1 = eO - p + 1
    var n2 = eN - p + 1
    var w = n2 + 1
    var len = new Int32Array((n1 + 1) * w)
    var dir = new Uint8Array((n1 + 1) * w)
    for (var i = n1 - 1; i >= 0; i--) {
      for (var j = n2 - 1; j >= 0; j--) {
        var k = i * w + j
        if (oldK[p + i] === newK[p + j]) {
          len[k] = len[(i + 1) * w + j + 1] + 1
          dir[k] = 0
        } else if (len[(i + 1) * w + j] >= len[i * w + j + 1]) {
          len[k] = len[(i + 1) * w + j]
          dir[k] = 1
        } else {
          len[k] = len[i * w + j + 1]
          dir[k] = 2
        }
      }
    }
    var ops = []
    var i2 = 0
    var j2 = 0
    while (i2 < n1 && j2 < n2) {
      var d = dir[i2 * w + j2]
      if (d === 0) {
        ops.push({ t: '=', o: p + i2, n: p + j2 })
        i2++
        j2++
      } else if (d === 1) {
        ops.push({ t: '-', o: p + i2 })
        i2++
      } else {
        ops.push({ t: '+', n: p + j2 })
        j2++
      }
    }
    while (i2 < n1) {
      ops.push({ t: '-', o: p + i2 })
      i2++
    }
    while (j2 < n2) {
      ops.push({ t: '+', n: p + j2 })
      j2++
    }
    return ops
  }

  function patchBody(ops, oldL, newL) {
    // 标记需要输出的 op（变更块 ± 2 行上下文）
    var show = []
    var gi = 0
    while (gi < ops.length) {
      if (ops[gi].t === '=') {
        gi++
        continue
      }
      var g0 = gi
      while (gi < ops.length && ops[gi].t !== '=') gi++
      var s = g0 - 1
      var cnt = 0
      while (s >= 0 && cnt < 2) {
        if (ops[s].t === '=') cnt++
        s--
      }
      var e = gi
      cnt = 0
      while (e < ops.length && cnt < 2) {
        if (ops[e].t === '=') cnt++
        e++
      }
      for (var x = s + 1; x < e; x++) show[x] = true
    }
    var out = []
    for (var q = 0; q < ops.length; q++) {
      if (!show[q]) continue
      var op = ops[q]
      if (op.t === '+') out.push('+ ' + newL[op.n])
      else if (op.t === '-') out.push('- ' + oldL[op.o])
      else out.push('  ' + newL[op.n])
    }
    return out.join('\n')
  }

  var mode = 'full'
  var text = fullText()
  var newRefs = []
  var removedRefs = []

  if (prevState) {
    // 统计新增/失效 ref
    for (var rk in refs) {
      if (!(rk in prevState.refs)) newRefs.push(rk)
    }
    for (var rk2 in prevState.refs) {
      if (!(rk2 in refs)) removedRefs.push(rk2)
    }

    var oldL = prevState.lines
    var oldK = []
    var newK = []
    for (var a = 0; a < oldL.length; a++) oldK.push(normKey(oldL[a]))
    for (var b = 0; b < lines.length; b++) newK.push(normKey(lines[b]))

    var p = 0
    while (p < oldL.length && p < lines.length && oldK[p] === newK[p]) p++
    var eO = oldL.length - 1
    var eN = lines.length - 1
    while (eO >= p && eN >= p && oldK[eO] === newK[eN]) {
      eO--
      eN--
    }
    var midO = eO - p + 1
    var midN = eN - p + 1

    if (midO <= 0 && midN <= 0) {
      mode = 'unchanged'
      text = unchangedText(lines.length)
    } else if (midO + midN > DIFF_WINDOW || midO * midN > 20000) {
      mode = 'full'
      text = fullText()
    } else {
      var ops = diffMiddle(p, eO, eN, oldK, newK)
      var added = 0
      var removed = 0
      for (var q0 = 0; q0 < ops.length; q0++) {
        if (ops[q0].t === '+') added++
        else if (ops[q0].t === '-') removed++
      }
      if (added + removed > 120 || added + removed > Math.max(40, lines.length * 0.4)) {
        mode = 'full'
        text = fullText()
      } else {
        var body = patchBody(ops, oldL, lines)
        if (body.length > PATCH_MAX_CHARS) {
          mode = 'full'
          text = fullText()
        } else {
          mode = 'patch'
          text =
            '页面快照（增量） url: ' + url + '\n' +
            'title: ' + title + '\n' +
            '变化: +' + added + ' / -' + removed + '（共 ' + lines.length + ' 行，其余未变，仍以上次快照为准）\n\n' +
            body + '\n\n' +
            '新增 ref: ' + (newRefs.slice(0, 15).join(' ') || '无') + '\n' +
            '失效 ref: ' + (removedRefs.slice(0, 15).join(' ') || '无')
        }
      }
    }
  }

  /* ── 持久化状态并返回 ── */
  try {
    window.__aaRefs = refs
    window.__aaSnapState = {
      v: 2,
      url: url,
      title: title,
      lines: lines,
      refs: refs,
      elements: elements,
      nextSeq: seq
    }
  } catch (e) {}

  return {
    v: 2,
    mode: mode,
    url: url,
    title: title,
    tree: text,
    elements: elements,
    newRefs: newRefs,
    removedRefs: removedRefs,
    truncated: truncated,
    capturedAt: Date.now()
  }
}
