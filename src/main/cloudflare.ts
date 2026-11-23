import type { WebContents } from 'electron'
import type { Tab } from './tabs'
import { frameEvaluate, listFrames, type FrameInfo } from './frames'

/**
 * Cloudflare challenge support is intentionally human-in-the-loop.
 *
 * Cloudflare's checkbox is usually inside a cross-origin iframe, so the
 * normal accessibility snapshot cannot expose it.  This module mirrors the
 * useful part of Cloudflare-Faker (detect the challenge, wait for it to
 * settle, and use a real pointer event for the visible checkbox) without
 * importing its GPL Java service, remote WebSocket protocol, or token/cookie
 * handling.  It never extracts challenge tokens and never solves image or
 * interactive CAPTCHAs.
 */

const CHALLENGE_HOST = 'challenges.cloudflare.com'
const MAX_TEXT = 1600
const DEFAULT_WAIT_MS = 30_000
const MAX_WAIT_MS = 120_000
const STABLE_MS = 750

export interface CloudflareControl {
  index: number
  kind: 'checkbox' | 'button'
  label: string
  checked: boolean | null
  rect: { x: number; y: number; width: number; height: number }
}

export interface CloudflareFrameStatus {
  frameId: string
  url: string
  depth: number
  crossOrigin: boolean
  visible: boolean
  challenge: boolean
  bodyText: string
  controls: CloudflareControl[]
  owner?: { x: number; y: number; width: number; height: number }
}

export interface CloudflareStatus {
  detected: boolean
  requiresUserAction: boolean
  url: string
  title: string
  mainDocument: {
    challenge: boolean
    hasChallengeText: boolean
    hasChallengeToken: boolean
    hasChallengeElement: boolean
  }
  frames: CloudflareFrameStatus[]
  checkedAt: number
}

export interface CloudflareWaitResult {
  completed: boolean
  elapsedMs: number
  status: CloudflareStatus
}

export interface CloudflareClickResult {
  frameId: string
  control: CloudflareControl
  point: { x: number; y: number }
  status: CloudflareStatus
}

const MAIN_DOCUMENT_SCRIPT = `(() => {
  const title = String(document.title || '')
  const url = String(location.href || '')
  const text = String((document.body && (document.body.innerText || document.body.textContent)) || '').slice(0, ${MAX_TEXT})
  const hasChallengeText = /just a moment|attention required|checking your browser|verify you are human|please complete the following to verify|正在进行安全验证|请完成以下操作.{0,20}验证/i.test(title + '\\n' + text)
  const hasChallengeToken =
    url.includes('__' + 'cf_' + 'chl_' + 'tk=') ||
    url.includes('cf_' + 'chl_' + 'jschl_tk=') ||
    url.includes('__' + 'cf_' + 'chl_' + 'captcha_tk=')
  let hasChallengeElement = false
  try {
    hasChallengeElement = !!document.querySelector('#challenge-form,#cf-challenge-running,#cf-please-wait,[data-translate="challenge_headline"]')
  } catch (_) {}
  return {
    url,
    title,
    challenge: hasChallengeText || hasChallengeToken || hasChallengeElement,
    hasChallengeText,
    hasChallengeToken,
    hasChallengeElement
  }
})()`

const FRAME_SCRIPT = `(() => {
  const visible = (el) => {
    let rect
    try { rect = el.getBoundingClientRect() } catch (_) { return null }
    if (!rect || rect.width < 2 || rect.height < 2) return null
    let style
    try { style = getComputedStyle(el) } catch (_) { style = null }
    if (style && (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) < 0.05)) return null
    return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) }
  }
  const labelFor = (el) => String(
    el.getAttribute('aria-label') || el.getAttribute('title') || el.innerText || el.textContent || ''
  ).replace(/\\s+/g, ' ').trim().slice(0, 160)
  const bodyText = String((document.body && (document.body.innerText || document.body.textContent)) || '').replace(/\\s+/g, ' ').trim().slice(0, ${MAX_TEXT})
  const title = String(document.title || '')
  const challengeText = /verify you are human|checking your browser|human verification|请验证您是真人|验证您不是机器人|正在进行安全验证/i.test(title + ' ' + bodyText)
  const controls = []
  let nodes = []
  try { nodes = Array.from(document.querySelectorAll('input[type="checkbox"],[role="checkbox"],button')) } catch (_) {}
  for (const el of nodes) {
    const rect = visible(el)
    if (!rect || controls.length >= 12) continue
    const type = String(el.getAttribute('type') || '').toLowerCase()
    const role = String(el.getAttribute('role') || '').toLowerCase()
    const kind = type === 'checkbox' || role === 'checkbox' ? 'checkbox' : 'button'
    const ariaChecked = el.getAttribute('aria-checked')
    const checked = kind === 'checkbox'
      ? (typeof el.checked === 'boolean' ? el.checked : ariaChecked === null ? null : ariaChecked === 'true')
      : null
    controls.push({ index: controls.length, kind, label: labelFor(el), checked, rect })
  }
  return { challenge: challengeText || controls.length > 0, bodyText, controls }
})()`

const FRAME_OWNER_SCRIPT = `(() => {
  const out = []
  for (const iframe of Array.from(document.querySelectorAll('iframe'))) {
    let rect
    try { rect = iframe.getBoundingClientRect() } catch (_) { continue }
    if (!rect || rect.width < 2 || rect.height < 2) continue
    const style = getComputedStyle(iframe)
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity || 1) < 0.05) continue
    out.push({
      src: String(iframe.getAttribute('src') || iframe.src || ''),
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    })
  }
  return out
})()`

function isChallengeHost(url: string): boolean {
  try {
    return new URL(url).hostname.toLowerCase() === CHALLENGE_HOST
  } catch {
    return false
  }
}

function trimText(value: unknown, max = 240): string {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, max)
}

function finiteRect(value: unknown): { x: number; y: number; width: number; height: number } | null {
  if (!value || typeof value !== 'object') return null
  const raw = value as Record<string, unknown>
  const x = Number(raw['x'])
  const y = Number(raw['y'])
  const width = Number(raw['width'])
  const height = Number(raw['height'])
  if (![x, y, width, height].every(Number.isFinite) || width < 2 || height < 2) return null
  return { x, y, width, height }
}

function sameFrameUrl(frameUrl: string, ownerUrl: string, pageUrl: string): boolean {
  try {
    const frame = new URL(frameUrl)
    const owner = new URL(ownerUrl, pageUrl)
    if (frame.hostname.toLowerCase() !== owner.hostname.toLowerCase()) return false
    const framePath = frame.pathname.replace(/\/+$/, '')
    const ownerPath = owner.pathname.replace(/\/+$/, '')
    return framePath === ownerPath || framePath.startsWith(`${ownerPath}/`) || ownerPath.startsWith(`${framePath}/`)
  } catch {
    return ownerUrl.toLowerCase().includes(CHALLENGE_HOST)
  }
}

async function readMainDocument(wc: WebContents): Promise<{
  url: string
  title: string
  challenge: boolean
  hasChallengeText: boolean
  hasChallengeToken: boolean
  hasChallengeElement: boolean
}> {
  try {
    const value = await wc.executeJavaScript(MAIN_DOCUMENT_SCRIPT, false) as Record<string, unknown> | null
    return {
      url: trimText(value?.['url'], 200),
      title: trimText(value?.['title'], 200),
      challenge: value?.['challenge'] === true,
      hasChallengeText: value?.['hasChallengeText'] === true,
      hasChallengeToken: value?.['hasChallengeToken'] === true,
      hasChallengeElement: value?.['hasChallengeElement'] === true
    }
  } catch {
    return {
      url: wc.getURL(),
      title: '',
      challenge: false,
      hasChallengeText: false,
      hasChallengeToken: false,
      hasChallengeElement: false
    }
  }
}

async function readFrame(frame: FrameInfo, wc: WebContents): Promise<CloudflareFrameStatus | null> {
  if (!isChallengeHost(frame.url)) return null
  try {
    const value = await frameEvaluate(wc, frame.id, FRAME_SCRIPT) as Record<string, unknown> | null
    const controls: CloudflareControl[] = []
    if (Array.isArray(value?.['controls'])) {
      for (const item of value['controls'] as unknown[]) {
        if (!item || typeof item !== 'object') continue
        const raw = item as Record<string, unknown>
        const rect = finiteRect(raw['rect'])
        if (!rect) continue
        controls.push({
          index: Number.isFinite(Number(raw['index'])) ? Number(raw['index']) : controls.length,
          kind: raw['kind'] === 'button' ? 'button' : 'checkbox',
          label: trimText(raw['label'], 160),
          checked: typeof raw['checked'] === 'boolean' ? raw['checked'] : null,
          rect
        })
      }
    }
    return {
      frameId: frame.id,
      url: frame.url,
      depth: frame.depth,
      crossOrigin: frame.crossOrigin,
      visible: false,
      challenge: value?.['challenge'] === true,
      bodyText: trimText(value?.['bodyText'], 600),
      controls
    }
  } catch {
    // A challenge frame can disappear while Cloudflare navigates it. Treat the
    // frame as unavailable rather than making the whole page-state call fail.
    return null
  }
}

async function readFrameOwners(wc: WebContents): Promise<{ src: string; rect: { x: number; y: number; width: number; height: number } }[]> {
  try {
    const value = await wc.executeJavaScript(FRAME_OWNER_SCRIPT, false)
    if (!Array.isArray(value)) return []
    return value.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const raw = item as Record<string, unknown>
      const rect = finiteRect(raw)
      const src = trimText(raw['src'], 600)
      return rect && src ? [{ src, rect }] : []
    })
  } catch {
    return []
  }
}

export async function inspectCloudflare(tab: Tab): Promise<CloudflareStatus> {
  const wc = tab.view.webContents
  const main = await readMainDocument(wc)
  const owners = await readFrameOwners(wc)
  const frames: CloudflareFrameStatus[] = []
  for (const frame of listFrames(wc)) {
    if (frame.depth === 0) continue
    const status = await readFrame(frame, wc)
    if (!status) continue
    const owner = owners.find((candidate) => sameFrameUrl(frame.url, candidate.src, main.url))
    status.owner = owner?.rect
    status.visible = !!owner
    frames.push(status)
  }
  const actionableFrames = frames.filter((frame) => frame.visible && frame.challenge && frame.controls.some((control) => control.checked !== true))
  const detected = main.challenge || actionableFrames.length > 0
  return {
    detected,
    requiresUserAction: actionableFrames.some((frame) => frame.controls.some((control) => control.kind === 'checkbox' && control.checked !== true)),
    url: main.url || wc.getURL(),
    title: main.title,
    mainDocument: {
      challenge: main.challenge,
      hasChallengeText: main.hasChallengeText,
      hasChallengeToken: main.hasChallengeToken,
      hasChallengeElement: main.hasChallengeElement
    },
    frames,
    checkedAt: Date.now()
  }
}

export async function waitForCloudflare(
  tab: Tab,
  timeoutMs = DEFAULT_WAIT_MS,
  signal?: AbortSignal
): Promise<CloudflareWaitResult> {
  const start = Date.now()
  const deadline = start + Math.min(MAX_WAIT_MS, Math.max(1000, Math.round(timeoutMs)))
  let clearSince: number | null = null
  let status = await inspectCloudflare(tab)
  while (Date.now() < deadline) {
    signal?.throwIfAborted()
    if (!status.detected) {
      clearSince ??= Date.now()
      if (Date.now() - clearSince >= STABLE_MS) {
        return { completed: true, elapsedMs: Date.now() - start, status }
      }
    } else {
      clearSince = null
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250))
    status = await inspectCloudflare(tab)
  }
  return { completed: !status.detected, elapsedMs: Date.now() - start, status }
}

function chooseControl(status: CloudflareStatus, frameId?: string, candidateIndex?: number): {
  frame: CloudflareFrameStatus
  control: CloudflareControl
} | null {
  const frames = status.frames.filter((frame) => frame.visible && frame.owner)
  const frame = frameId ? frames.find((item) => item.frameId === frameId) : frames.find((item) => item.controls.some((control) => control.kind === 'checkbox' && control.checked !== true))
  if (!frame) return null
  const control = typeof candidateIndex === 'number'
    ? frame.controls.find((item) => item.index === Math.floor(candidateIndex))
    : frame.controls.find((item) => item.kind === 'checkbox' && item.checked !== true) ?? frame.controls[0]
  return control ? { frame, control } : null
}

async function dispatchClick(wc: WebContents, x: number, y: number): Promise<void> {
  if (wc.isDestroyed()) throw new Error('页面已关闭')
  const dbg = wc.debugger
  if (!dbg.isAttached()) {
    try {
      dbg.attach('1.3')
    } catch {
      throw new Error('无法发送 Cloudflare 复选框点击：页面调试通道不可用，请关闭该页 DevTools 后重试。')
    }
  }
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 })
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1, buttons: 1 })
  await dbg.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1, buttons: 0 })
}

export async function clickCloudflareControl(
  tab: Tab,
  opts: { frameId?: string; candidateIndex?: number; focus?: () => void } = {}
): Promise<CloudflareClickResult> {
  const before = await inspectCloudflare(tab)
  const chosen = chooseControl(before, opts.frameId, opts.candidateIndex)
  if (!chosen) {
    throw new Error('没有找到可点击的 Cloudflare 验证复选框。先调用 browser_cloudflare action=inspect；若页面要求滑块或图片验证，请由用户在页面中完成。')
  }
  if (chosen.control.checked === true) {
    throw new Error('Cloudflare 验证复选框已经选中；请调用 browser_cloudflare action=wait 等待页面完成。')
  }
  if (chosen.control.kind !== 'checkbox') {
    throw new Error('Cloudflare click 只允许点击检测到的复选框；按钮、滑块和图片挑战必须由用户手动完成。')
  }
  const owner = chosen.frame.owner
  if (!owner) throw new Error('无法定位 Cloudflare 验证 iframe 的屏幕位置，请将目标标签切到前台后重试。')
  const point = {
    x: Math.round(owner.x + chosen.control.rect.x + chosen.control.rect.width / 2),
    y: Math.round(owner.y + chosen.control.rect.y + chosen.control.rect.height / 2)
  }
  opts.focus?.()
  await dispatchClick(tab.view.webContents, point.x, point.y)
  await new Promise<void>((resolve) => setTimeout(resolve, 300))
  const status = await inspectCloudflare(tab)
  return { frameId: chosen.frame.frameId, control: chosen.control, point, status }
}

function redactChallengeUrl(raw: string): string {
  try {
    const url = new URL(raw)
    for (const [key] of url.searchParams) {
      if (/^(?:__)?cf_chl|^cf_challenge|challenge|token/i.test(key)) url.searchParams.set(key, '[redacted]')
    }
    return url.toString()
  } catch {
    return raw
      .replace(/((?:__)?cf_chl[^=]*=)[^&#]*/gi, '$1[redacted]')
      .replace(/((?:cf_)?challenge[^=]*=)[^&#]*/gi, '$1[redacted]')
  }
}

export function formatCloudflareStatus(status: CloudflareStatus): string {
  const controls = status.frames.flatMap((frame) => frame.controls.map((control) => ({ frameId: frame.frameId, control })))
  return JSON.stringify({
    detected: status.detected,
    requiresUserAction: status.requiresUserAction,
    url: redactChallengeUrl(status.url),
    title: status.title,
    mainDocument: status.mainDocument,
    frames: status.frames.map((frame) => ({
      frameId: frame.frameId,
      url: redactChallengeUrl(frame.url),
      depth: frame.depth,
      crossOrigin: frame.crossOrigin,
      visible: frame.visible,
      challenge: frame.challenge,
      bodyText: frame.bodyText,
      owner: frame.owner,
      controls: frame.controls
    })),
    next: status.detected
      ? status.requiresUserAction
        ? '需要用户确认后点击可见复选框；不支持自动完成滑块或图片挑战。'
        : '挑战仍在处理中，请调用 action=wait。'
      : '未检测到活动 Cloudflare 挑战。',
    controlCount: controls.length,
    checkedAt: status.checkedAt
  }, null, 2)
}
