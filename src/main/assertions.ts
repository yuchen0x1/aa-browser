import type { Tab } from './tabs'

/**
 * 结构化断言：把“点了一下”与“功能真的通过了”区分开。
 *
 * 设计要点：
 *  - 一次调用可携带多条检查，统一返回逐条通过/失败，调用方（AI）可据此决定继续或修复；
 *  - DOM 类检查在页面内一次性求值，避免每条断言一次 executeJavaScript 的开销；
 *  - 非 DOM 类（URL/标题/控制台/网络）在主进程读，语义更稳定；
 *  - 任何一条失败时 tool 层返回 isError，让 MCP 客户端也能感知“测试没通过”。
 */

export type AssertMatch = 'equals' | 'contains' | 'notContains' | 'regex' | 'gte' | 'lte' | 'exists' | 'absent'

export interface AssertCheck {
  /** 检查类型 */
  kind: 'url' | 'title' | 'text' | 'selector' | 'count' | 'value' | 'checked' | 'attribute' | 'console' | 'network'
  /** selector / value / checked / attribute / count 的目标：CSS 选择器或快照 ref（e2） */
  target?: string
  /** 比较方式，默认按类型推断（url/title/text/value/attribute → contains） */
  match?: AssertMatch
  /** 期望值；count 用数字，checked 用布尔 */
  expected?: string | number | boolean
  /** 人类可读说明，失败时原样回显，便于报告 */
  message?: string
  /** attribute 检查的属性名 */
  attribute?: string
  /** console 检查：级别过滤，默认 error */
  level?: 'error' | 'warning' | 'all'
  /** console 检查：只看该时间戳之后的日志 */
  since?: number
  /** network 检查：URL 子串、方法、期望状态码范围 */
  urlContains?: string
  method?: string
  status?: number
  statusMin?: number
  statusMax?: number
}

export interface AssertResult {
  index: number
  passed: boolean
  label: string
  expected: string
  actual: string
  kind: AssertCheck['kind']
}

export interface AssertOutcome {
  results: AssertResult[]
  passed: number
  failed: number
}

const DOM_CHECK_KINDS = new Set<AssertCheck['kind']>(['selector', 'count', 'value', 'checked', 'attribute'])

function describeCheck(check: AssertCheck): string {
  const where = check.target ? ` ${check.target}` : ''
  switch (check.kind) {
    case 'url':
      return `URL ${check.match ?? 'contains'} ${JSON.stringify(String(check.expected ?? ''))}`
    case 'title':
      return `标题 ${check.match ?? 'contains'} ${JSON.stringify(String(check.expected ?? ''))}`
    case 'text':
      return `页面文本 ${check.match ?? 'contains'} ${JSON.stringify(String(check.expected ?? ''))}`
    case 'selector':
      return `选择器${where} ${check.match === 'absent' ? '不存在' : '存在'}`
    case 'count':
      return `选择器${where} 元素数量 ${check.match ?? 'equals'} ${String(check.expected ?? '')}`
    case 'value':
      return `元素${where} 的值 ${check.match ?? 'contains'} ${JSON.stringify(String(check.expected ?? ''))}`
    case 'checked':
      return `元素${where} 勾选状态为 ${String(check.expected ?? '')}`
    case 'attribute':
      return `元素${where} 属性 ${check.attribute ?? '?'} ${check.match ?? 'equals'} ${JSON.stringify(String(check.expected ?? ''))}`
    case 'console':
      return `控制台 ${check.level ?? 'error'} 日志数量 ${check.match ?? 'equals'} ${String(check.expected ?? 0)}`
    case 'network':
      return `网络请求 ${JSON.stringify(check.urlContains ?? '')} 状态 ${check.status !== undefined ? `= ${check.status}` : `∈ [${check.statusMin ?? 200}, ${check.statusMax ?? 399}]`}`
    default:
      return check.kind
  }
}

function compare(actual: string, expected: string, match: AssertMatch): boolean {
  switch (match) {
    case 'equals':
      return actual === expected
    case 'contains':
      return actual.includes(expected)
    case 'notContains':
      return !actual.includes(expected)
    case 'regex':
      try {
        return new RegExp(expected).test(actual)
      } catch {
        return false
      }
    default:
      return false
  }
}

function compareNumber(actual: number, expected: number, match: AssertMatch): boolean {
  if (match === 'gte') return actual >= expected
  if (match === 'lte') return actual <= expected
  return actual === expected
}

/** 页面内一次性求值 DOM 类检查；返回与输入同序的原始观测值 */
function domProbeScript(checks: AssertCheck[]): string {
  const specs = checks.map((check) => ({
    kind: check.kind,
    target: check.target ?? '',
    attribute: check.attribute ?? ''
  }))
  return `(() => {
    const specs = ${JSON.stringify(specs)};
    const refs = window.__aaRefs || {};
    const resolve = (target) => {
      if (!target) return null;
      if (/^e[0-9]+$/.test(target)) return refs[target] || null;
      try { return document.querySelector(target); } catch (e) { return null; }
    };
    const clip = (s, n) => {
      s = String(s == null ? '' : s).replace(/\\s+/g, ' ').trim();
      return s.length > n ? s.slice(0, n) + '…' : s;
    };
    return specs.map((spec) => {
      try {
        if (spec.kind === 'selector' || spec.kind === 'count') {
          let count = 0;
          if (spec.target && /^e[0-9]+$/.test(spec.target)) count = resolve(spec.target) ? 1 : 0;
          else if (spec.target) {
            try { count = document.querySelectorAll(spec.target).length } catch (e) { count = -1 }
          }
          return { ok: true, count };
        }
        const el = resolve(spec.target);
        if (!el) return { ok: false, reason: 'target-not-found' };
        if (spec.kind === 'value') {
          const value = el.value !== undefined ? el.value : (el.textContent || '');
          return { ok: true, value: String(value == null ? '' : value) };
        }
        if (spec.kind === 'checked') return { ok: true, checked: !!el.checked };
        if (spec.kind === 'attribute') {
          const value = el.getAttribute(spec.attribute);
          return { ok: true, attribute: value === null ? null : String(value) };
        }
        return { ok: false, reason: 'unsupported' };
      } catch (e) {
        return { ok: false, reason: 'probe-error' };
      }
    });
  })()`
}

export async function runAssertions(tab: Tab, checks: AssertCheck[]): Promise<AssertOutcome> {
  const wc = tab.view.webContents
  const domChecks = checks.filter((check) => DOM_CHECK_KINDS.has(check.kind))
  let domObservations: { ok: boolean; count?: number; value?: string; checked?: boolean; attribute?: string | null; reason?: string }[] = []
  if (domChecks.length) {
    domObservations = (await wc.executeJavaScript(domProbeScript(domChecks), false)) as typeof domObservations
  }
  let pageText: string | null = null
  const results: AssertResult[] = []

  for (const [index, check] of checks.entries()) {
    const label = check.message?.trim() || describeCheck(check)
    let actual = ''
    let passed = false
    if (DOM_CHECK_KINDS.has(check.kind)) {
      const domIndex = checks.slice(0, index).filter((c) => DOM_CHECK_KINDS.has(c.kind)).length
      const observed = domObservations[domIndex]
      if (check.kind === 'selector') {
        const exists = !!observed?.ok && (observed?.count ?? 0) > 0
        actual = exists ? '存在' : '不存在'
        passed = check.match === 'absent' ? !exists : exists
      } else if (check.kind === 'count') {
        const count = observed?.count ?? -1
        actual = `数量 ${count}`
        const expected = typeof check.expected === 'number' ? check.expected : Number(check.expected ?? 0)
        passed = count >= 0 && compareNumber(count, Number.isFinite(expected) ? expected : 0, check.match ?? 'equals')
      } else if (check.kind === 'value') {
        actual = observed?.ok ? `值 ${JSON.stringify(observed.value ?? '')}` : '找不到目标元素'
        if (observed?.ok) passed = compare(observed.value ?? '', String(check.expected ?? ''), check.match ?? 'contains')
      } else if (check.kind === 'checked') {
        actual = observed?.ok ? `勾选=${observed.checked}` : '找不到目标元素'
        if (observed?.ok) passed = !!observed.checked === (check.expected === true)
      } else if (check.kind === 'attribute') {
        actual = observed?.ok ? `属性=${observed.attribute === null ? '不存在' : JSON.stringify(observed.attribute)}` : '找不到目标元素'
        if (observed?.ok) {
          const expected = check.expected === undefined ? null : String(check.expected)
          if (check.match === 'absent') passed = observed.attribute === null
          else if (expected === null) passed = observed.attribute === null
          else if (observed.attribute === null) passed = false
          else passed = compare(String(observed.attribute), expected, check.match ?? 'equals')
        }
      }
      results.push({ index, passed, label, expected: describeCheck(check), actual, kind: check.kind })
      continue
    }

    if (check.kind === 'url') {
      actual = wc.getURL()
      passed = compare(actual, String(check.expected ?? ''), check.match ?? 'contains')
    } else if (check.kind === 'title') {
      actual = wc.getTitle()
      passed = compare(actual, String(check.expected ?? ''), check.match ?? 'contains')
    } else if (check.kind === 'text') {
      if (pageText === null) {
        pageText = (await wc
          .executeJavaScript('(() => String(document.body ? document.body.innerText : ""))()', false)
          .catch(() => '')) as string
      }
      actual = pageText.replace(/\s+/g, ' ').slice(0, 160)
      passed = compare(pageText, String(check.expected ?? ''), check.match ?? 'contains')
    } else if (check.kind === 'console') {
      const level = check.level ?? 'error'
      const since = typeof check.since === 'number' ? check.since : 0
      const logs = tab.consoleBuf.filter((entry) => {
        if (entry.ts < since) return false
        if (level === 'all') return true
        const raw = String(entry.level)
        if (level === 'error') return raw === 'error' || raw === '3'
        return raw === 'warning' || raw === 'warn' || raw === '2'
      })
      const expected = typeof check.expected === 'number' ? check.expected : Number(check.expected ?? 0)
      actual = `数量 ${logs.length}${logs.length ? `，最新：${logs[logs.length - 1].text.replace(/\s+/g, ' ').slice(0, 80)}` : ''}`
      passed = compareNumber(logs.length, Number.isFinite(expected) ? expected : 0, check.match ?? 'equals')
    } else if (check.kind === 'network') {
      const matched = tab.net.requests({
        urlContains: check.urlContains,
        method: check.method,
        statusMin: check.statusMin,
        statusMax: check.statusMax
      })
      let hit = matched
      if (typeof check.status === 'number') hit = matched.filter((r) => r.status === check.status)
      const statusList = hit.map((r) => r.status).filter((s) => s > 0)
      const hasStatusExpectation =
        typeof check.status === 'number' ||
        typeof check.statusMin === 'number' ||
        typeof check.statusMax === 'number'
      actual = hit.length ? `${hit.length} 条匹配，状态 ${[...new Set(statusList)].join('/') || '未知'}` : '无匹配请求'
      // 调用方明确指定状态或区间时，requests() 已按此过滤，不能再要求 2xx/3xx；
      // 否则 status:404 这类“预期失败”的断言永远无法通过。
      passed =
        hit.length > 0 &&
        statusList.length > 0 &&
        (hasStatusExpectation || statusList.every((s) => s >= 200 && s < 400))
    }

    results.push({ index, passed, label, expected: describeCheck(check), actual, kind: check.kind })
  }

  const passed = results.filter((r) => r.passed).length
  return { results, passed, failed: results.length - passed }
}

/** 把断言结果渲染成 Agent 可读文本；失败项带“期望 / 实际”，方便直接定位问题 */
export function formatAssertions(outcome: AssertOutcome): string {
  const lines = outcome.results.map((r) => `${r.passed ? '✅' : '❌'} ${r.label}${r.passed ? '' : `\n   期望：${r.expected}\n   实际：${r.actual}`}`)
  const head = `${outcome.passed}/${outcome.results.length} 项断言通过${outcome.failed ? `，${outcome.failed} 项失败` : ''}`
  return `${head}\n${lines.join('\n')}`
}
