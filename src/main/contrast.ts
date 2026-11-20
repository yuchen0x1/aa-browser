import type { Tab } from './tabs'
import { ActionError, raceAbort } from './actions'

/** 单个文字对比度违规项 */
export interface ContrastViolation {
  selector: string
  tag: string
  text: string
  foreground: string
  background: string
  ratio: number
  required: number
  level: 'AA' | 'AAA'
  fontSize: string
  bold: boolean
  largeText: boolean
}

/** 整页文字对比度审计报告 */
export interface ContrastReport {
  url: string
  scanned: number
  violations: ContrastViolation[]
  skipped: number
  level: 'AA' | 'AAA'
  truncated: boolean
}

/**
 * 页面内对比度审计脚本（自包含 IIFE，返回可 JSON 序列化的普通对象）。
 * level / maxResults 由主进程以 JSON 字面量注入，避免额外的 executeJavaScript 往返。
 */
function contrastProbeScript(level: 'AA' | 'AAA', maxResults: number): string {
  return `(() => {
  const __opts = ${JSON.stringify({ level, maxResults })};
  const round2 = (n) => Math.round(n * 100) / 100;
  const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
  const clip = (s, n) => { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n) : s; };

  // 解析 computed color：rgb()/rgba()（逗号或空格分隔、斜杠 alpha）、#hex、transparent。
  const parseColor = (raw) => {
    if (!raw) return null;
    const s = String(raw).trim().toLowerCase();
    if (s === '' || s === 'transparent' || s === 'none') return { r: 0, g: 0, b: 0, a: 0 };
    const m = /^rgba?\\(\\s*([0-9.]+)[\\s,]+([0-9.]+)[\\s,]+([0-9.]+)(?:\\s*[,/]\\s*([0-9.]+))?\\s*\\)$/.exec(s);
    if (m) {
      const r = parseFloat(m[1]), g = parseFloat(m[2]), b = parseFloat(m[3]);
      const a = m[4] === undefined ? 1 : parseFloat(m[4]);
      if (!isFinite(r) || !isFinite(g) || !isFinite(b) || !isFinite(a)) return null;
      return { r: clamp(r, 0, 255), g: clamp(g, 0, 255), b: clamp(b, 0, 255), a: clamp(a, 0, 1) };
    }
    const h = /^#([0-9a-f]{3,8})$/.exec(s);
    if (h) {
      const hex = h[1];
      const ex = (x) => x.length === 1 ? x + x : x;
      if (hex.length === 3 || hex.length === 4) {
        return {
          r: parseInt(ex(hex[0]), 16), g: parseInt(ex(hex[1]), 16), b: parseInt(ex(hex[2]), 16),
          a: hex.length === 4 ? parseInt(ex(hex[3]), 16) / 255 : 1
        };
      }
      if (hex.length === 6 || hex.length === 8) {
        return {
          r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16),
          a: hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1
        };
      }
    }
    return null;
  };

  // 把带 alpha 的 src 叠加到 dst 上（source-over）；dst 起点为不透明白，结果始终不透明。
  const composite = (src, dst) => {
    const a = src.a;
    const outA = a + dst.a * (1 - a);
    if (outA <= 0) return { r: 0, g: 0, b: 0, a: 0 };
    return {
      r: (src.r * a + dst.r * dst.a * (1 - a)) / outA,
      g: (src.g * a + dst.g * dst.a * (1 - a)) / outA,
      b: (src.b * a + dst.b * dst.a * (1 - a)) / outA,
      a: outA
    };
  };

  // WCAG 2.x 相对亮度与对比度
  const lin = (c) => { c = c / 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const lum = (c) => 0.2126 * lin(c.r) + 0.7152 * lin(c.g) + 0.0722 * lin(c.b);
  const contrast = (a, b) => {
    const la = lum(a), lb = lum(b);
    const hi = Math.max(la, lb), lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  };
  const toHex = (c) => {
    const h = (n) => { const v = Math.round(clamp(n, 0, 255)).toString(16); return v.length === 1 ? '0' + v : v; };
    return '#' + h(c.r) + h(c.g) + h(c.b);
  };

  // 从根到元素逐层叠加背景色；遇到 background-image 则无法可靠推断，标记跳过。
  const effectiveBg = (el) => {
    const chain = [];
    let cur = el;
    while (cur && cur.nodeType === 1) { chain.push(cur); cur = cur.parentElement; }
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = chain.length - 1; i >= 0; i--) {
      let cs;
      try { cs = getComputedStyle(chain[i]); } catch (e) { return { skip: true }; }
      const img = cs.backgroundImage || 'none';
      if (img !== 'none' && img !== '') return { skip: true };
      const c = parseColor(cs.backgroundColor);
      if (!c) return { skip: true };
      bg = composite(c, bg);
    }
    return { bg };
  };

  // 简短、确定性的 CSS 选择器：优先 #id，其次 tag.class，最后 tag:nth-of-type。
  const selectorFor = (el) => {
    const id = el.id;
    if (id && /^[A-Za-z][A-Za-z0-9_-]*$/.test(id)) return clip('#' + id, 120);
    const tag = (el.tagName || 'div').toLowerCase();
    const cls = [];
    try {
      const list = el.classList || [];
      for (let i = 0; i < list.length && cls.length < 4; i++) {
        if (/^[A-Za-z_][A-Za-z0-9_-]*$/.test(list[i])) cls.push('.' + list[i]);
      }
    } catch (e) {}
    if (cls.length) return clip(tag + cls.join(''), 120);
    try {
      const parent = el.parentElement;
      if (parent) {
        const kids = parent.children;
        let idx = 0, total = 0;
        for (let i = 0; i < kids.length; i++) {
          if (kids[i].tagName === el.tagName) { total++; if (kids[i] === el) idx = total; }
        }
        if (total > 1 && idx > 0) return clip(tag + ':nth-of-type(' + idx + ')', 120);
      }
    } catch (e) {}
    return clip(tag, 120);
  };

  // 只审计带直接非空文本节点的“文本元素”，跳过脚本/样式/图形等非文本节点。
  const SKIP_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg', 'path', 'g', 'defs',
    'symbol', 'use', 'circle', 'rect', 'line', 'polygon', 'polyline', 'ellipse', 'iframe',
    'object', 'embed', 'canvas', 'br', 'hr', 'input', 'textarea', 'select', 'option',
    'head', 'title', 'meta', 'link']);
  const directText = (el) => {
    let out = '';
    const nodes = el.childNodes;
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      if (n.nodeType === 3 && /\\S/.test(n.nodeValue || '')) out += n.nodeValue;
    }
    return out;
  };

  const candidates = [];
  try {
    if (document.body) candidates.push(document.body);
    const all = document.querySelectorAll('body *');
    for (let i = 0; i < all.length; i++) candidates.push(all[i]);
  } catch (e) {}

  const level = __opts.level === 'AAA' ? 'AAA' : 'AA';
  const max = clamp(__opts.maxResults, 1, 200);
  let scanned = 0;
  let skipped = 0;
  const violations = [];

  for (let i = 0; i < candidates.length; i++) {
    const el = candidates[i];
    try {
      const tag = (el.tagName || '').toLowerCase();
      if (SKIP_TAGS.has(tag)) continue;
      const cs = getComputedStyle(el);
      if (!cs) continue;
      if (cs.display === 'none' || cs.visibility === 'hidden' || cs.visibility === 'collapse') continue;
      if (parseFloat(cs.opacity) === 0) continue;
      const rects = el.getClientRects();
      if (!rects || rects.length === 0) continue;
      const rawText = directText(el);
      if (!/\\S/.test(rawText)) continue;

      const color = parseColor(cs.color);
      if (!color) { skipped++; continue; }
      const eb = effectiveBg(el);
      if (eb.skip) { skipped++; continue; }
      const bg = eb.bg;
      const fg = composite(color, bg);
      const ratio = contrast(fg, bg);

      const fontSize = parseFloat(cs.fontSize) || 16;
      let weight = parseInt(cs.fontWeight, 10);
      if (!isFinite(weight)) weight = (cs.fontWeight === 'bold' || cs.fontWeight === 'bolder') ? 700 : 400;
      const largeText = fontSize >= 24 || (fontSize >= 18.66 && weight >= 700);
      const required = largeText ? (level === 'AAA' ? 4.5 : 3) : (level === 'AAA' ? 7 : 4.5);
      scanned++;

      // 用未取整的 ratio 比较，避免边界值因四舍五入误判。
      if (ratio + 0.001 < required) {
        violations.push({
          selector: selectorFor(el),
          tag,
          text: clip(rawText.replace(/\\s+/g, ' ').trim(), 60),
          foreground: toHex(fg),
          background: toHex(bg),
          ratio: ratio,
          required: required,
          level: level,
          fontSize: cs.fontSize || (fontSize + 'px'),
          bold: weight >= 700,
          largeText: largeText
        });
      }
    } catch (e) {
      // 奇怪的 DOM / 计算样式异常：跳过，绝不让整个脚本抛出。
    }
  }

  violations.sort((a, b) => a.ratio - b.ratio);
  const truncated = violations.length > max;
  const kept = truncated ? violations.slice(0, max) : violations;
  for (let i = 0; i < kept.length; i++) {
    kept[i].ratio = round2(kept[i].ratio);
    kept[i].required = round2(kept[i].required);
  }

  return {
    url: location.href,
    scanned: scanned,
    violations: kept,
    skipped: skipped,
    level: level,
    truncated: truncated
  };
})()`
}

/**
 * 在页面内执行 WCAG 文字对比度审计。
 */
export async function auditContrast(
  tab: Tab,
  opts?: { level?: 'AA' | 'AAA'; maxResults?: number; signal?: AbortSignal }
): Promise<ContrastReport> {
  const level = opts?.level ?? 'AA'
  if (level !== 'AA' && level !== 'AAA') throw new ActionError('level 必须是 AA 或 AAA')
  const maxResults = opts?.maxResults ?? 50
  if (typeof maxResults !== 'number' || !Number.isFinite(maxResults)) {
    throw new ActionError('maxResults 必须是有限数字')
  }
  if (opts?.signal !== undefined && opts.signal !== null) {
    const s = opts.signal as unknown as { aborted?: unknown; addEventListener?: unknown }
    if (typeof s.aborted !== 'boolean' || typeof s.addEventListener !== 'function') {
      throw new ActionError('signal 必须是有效的 AbortSignal')
    }
  }

  const wc = tab.view.webContents
  if (wc.isDestroyed()) throw new ActionError('页面已关闭')

  const script = contrastProbeScript(level, Math.min(200, Math.max(1, maxResults)))
  const raw = await raceAbort(wc.executeJavaScript(script, false), opts?.signal)
  if (!raw || typeof raw !== 'object') {
    throw new ActionError('对比度审计执行失败：页面未返回有效数据')
  }
  const r = raw as ContrastReport
  const num = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) ? n : 0)
  return {
    url: String(r.url ?? ''),
    scanned: num(r.scanned),
    violations: Array.isArray(r.violations) ? r.violations : [],
    skipped: num(r.skipped),
    level: r.level === 'AAA' ? 'AAA' : 'AA',
    truncated: !!r.truncated
  }
}

/** 把审计报告渲染成 Agent 可读的简洁中文多行文本 */
export function formatContrast(report: ContrastReport, ok: boolean): string {
  const lines: string[] = []
  lines.push(
    `文字对比度审计  ${report.url}  等级 ${report.level}  扫描 ${report.scanned}  违规 ${report.violations.length}`
  )
  lines.push(ok ? '结论：通过（未发现对比度不足）' : '结论：未通过（存在对比度不足的文字）')

  for (const v of report.violations) {
    const large = v.largeText ? ' [大字]' : ''
    lines.push(
      `${v.ratio} (需 ${v.required}) ${v.selector} — ${v.text}  [前景 ${v.foreground} / 背景 ${v.background}${large}]`
    )
  }

  const notes: string[] = []
  if (report.truncated) notes.push(`结果已截断，仅列出对比度最差的 ${report.violations.length} 条`)
  if (report.skipped > 0) notes.push(`${report.skipped} 个元素因背景图片或颜色无法解析被跳过`)
  if (notes.length) lines.push('注：' + notes.join('；'))

  return lines.join('\n')
}
