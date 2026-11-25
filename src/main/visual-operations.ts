import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { nativeImage } from 'electron'
import type { WebContents } from 'electron'
import type { Tab } from './tabs'
import { captureVisual, type VisualCapture } from './visual'
import { withTabLock, throwIfAborted, assertTabUsable } from './actions'
import { getEvidenceManager } from './evidence'

interface PageGeometry {
  url: string
  document: number
  width: number
  height: number
  scrollX: number
  scrollY: number
  deviceScaleFactor: number
  zoom: number
}

export interface VisualEvidence {
  captureId: string
  tabId: string
  profileId: string
  capturedAt: number
  expiresAt: number
  width: number
  height: number
  /** Coordinates are CSS pixels in the captured viewport, not bitmap pixels. */
  viewport: { width: number; height: number; deviceScaleFactor: number; zoom: number }
  sha256: string
  file: string
  image: { type: 'image'; mimeType: 'image/png'; data: string }
}

export interface VisualOperationInput {
  captureId: string
  action: 'click' | 'drag' | 'scroll' | 'crop'
  x: number
  y: number
  toX?: number
  toY?: number
  width?: number
  height?: number
  deltaX?: number
  deltaY?: number
}

export interface VisualOperationResult {
  before: VisualEvidence
  after?: VisualEvidence
  operation: { action: VisualOperationInput['action']; x: number; y: number; toX?: number; toY?: number; deltaX?: number; deltaY?: number; at: number }
  verification: { visualChanged: boolean; documentChanged: boolean; verificationRequired: true }
}

interface CaptureRecord {
  evidence: VisualEvidence
  geometry: PageGeometry
  generation: number
  webContents: WebContents
}

export interface VisualOperationDependencies {
  directoryFor?: (profileId: string) => string
  /** A fresh native approval must be requested for every coordinate mutation. */
  approve: (request: { profileId: string; tabId: string; action: string; url: string; captureId: string; x: number; y: number; toX?: number; toY?: number }, signal?: AbortSignal) => Promise<boolean>
  capture?: (tab: Tab) => Promise<VisualCapture>
  crop?: (image: Buffer, rectangle: { x: number; y: number; width: number; height: number }) => Buffer
  record?: (operation: Omit<VisualOperationResult, 'before' | 'after'> & { tabId: string; profileId: string; before: string; after?: string }) => void
  now?: () => number
}

const MAX_CAPTURES = 12
const MAX_CAPTURE_BYTES = 16 * 1024 * 1024
const CAPTURE_TTL_MS = 120_000
const GEOMETRY_SCRIPT = `(() => ({
  url: String(location.href), document: performance.timeOrigin,
  width: window.innerWidth, height: window.innerHeight,
  scrollX: window.scrollX, scrollY: window.scrollY,
  deviceScaleFactor: window.devicePixelRatio
}))()`

function hash(image: Buffer): string {
  return createHash('sha256').update(image).digest('hex')
}

function profileFor(tab: Tab): string {
  const id = (tab as Tab & { profileId?: string }).profileId ?? 'default'
  if (!/^(default|p[a-f0-9]{24})$/.test(id)) throw new Error('[INVALID_PROFILE] Invalid Profile identifier.')
  return id
}

function point(x: unknown, y: unknown, geometry: PageGeometry): { x: number; y: number } {
  if (typeof x !== 'number' || typeof y !== 'number' || !Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x >= geometry.width || y >= geometry.height) {
    throw new Error('[INVALID_COORDINATES] Coordinates must be finite CSS pixels inside the captured viewport.')
  }
  return { x: Math.floor(x), y: Math.floor(y) }
}

function sameGeometry(a: PageGeometry, b: PageGeometry): boolean {
  return a.url === b.url && a.document === b.document && a.width === b.width && a.height === b.height &&
    a.scrollX === b.scrollX && a.scrollY === b.scrollY && a.deviceScaleFactor === b.deviceScaleFactor && a.zoom === b.zoom
}

function publicEvidence(evidence: VisualEvidence): VisualEvidence {
  return { ...evidence, viewport: { ...evidence.viewport }, image: { ...evidence.image } }
}

export class VisualOperationManager {
  private captures = new Map<string, CaptureRecord>()
  private epochs = new WeakMap<WebContents, { generation: number }>()

  constructor(private readonly deps: VisualOperationDependencies) {}

  private watch(wc: WebContents): { generation: number } {
    let epoch = this.epochs.get(wc)
    if (epoch) return epoch
    epoch = { generation: 0 }
    this.epochs.set(wc, epoch)
    const current = epoch
    const invalidate = (): void => { current.generation++ }
    wc.on('did-start-navigation', invalidate)
    wc.on('render-process-gone', invalidate)
    wc.on('destroyed', () => {
      invalidate()
      for (const [id, record] of this.captures) if (record.webContents === wc) this.captures.delete(id)
      this.epochs.delete(wc)
    })
    return epoch
  }

  private async geometry(tab: Tab): Promise<PageGeometry> {
    assertTabUsable(tab)
    const wc = tab.view.webContents
    const value = await wc.executeJavaScript(GEOMETRY_SCRIPT, false) as Omit<PageGeometry, 'zoom'>
    const geometry = { ...value, zoom: wc.getZoomFactor() }
    if (!geometry || !Number.isFinite(geometry.document) || !Number.isFinite(geometry.width) || !Number.isFinite(geometry.height) || geometry.width <= 0 || geometry.height <= 0 || geometry.width > 10000 || geometry.height > 10000 || !Number.isFinite(geometry.zoom) || geometry.zoom <= 0) {
      throw new Error('[VISUAL_VIEWPORT_INVALID] The page has no usable viewport.')
    }
    return geometry
  }

  private async take(tab: Tab): Promise<VisualCapture> {
    const work = this.deps.capture ? this.deps.capture(tab) : captureVisual(tab.view.webContents, {
      background: !tab.canUseWindowInput(), isWindowMinimized: () => tab.isWindowMinimized?.() ?? false
    })
    const image = await settleWithin(work, 15_000)
    if (!image.base64 || Buffer.byteLength(image.base64, 'base64') > MAX_CAPTURE_BYTES || image.width <= 0 || image.height <= 0) throw new Error('[VISUAL_CAPTURE_INVALID] Screenshot is empty or exceeds 16 MiB.')
    return image
  }

  private write(profileId: string, captureId: string, image: Buffer): string {
    const directory = this.deps.directoryFor?.(profileId) ?? path.join(os.homedir(), '.aabrowser', 'profiles', profileId, 'screenshots')
    // No linked output directory is accepted, including links in its ancestors.
    const assertNoLinks = (): void => {
      for (let current = path.resolve(directory); ; current = path.dirname(current)) {
        try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('[FILE_LINK_DENIED] Visual evidence directory cannot contain symbolic links.') } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (path.dirname(current) === current) break
      }
    }
    assertNoLinks()
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
    assertNoLinks()
    const file = path.join(directory, `visual-${captureId}.png`)
    fs.writeFileSync(file, image, { flag: 'wx', mode: 0o600 })
    getEvidenceManager(profileId).record(file, 'screenshot', { managed: true })
    return file
  }

  private save(tab: Tab, image: VisualCapture, geometry: PageGeometry, generation: number): VisualEvidence {
    const now = this.deps.now?.() ?? Date.now()
    for (const [id, record] of this.captures) if (record.evidence.expiresAt < now) this.captures.delete(id)
    while (this.captures.size >= MAX_CAPTURES) {
      const oldest = this.captures.keys().next().value
      if (oldest === undefined) break
      this.captures.delete(oldest)
    }
    const captureId = randomUUID()
    const profileId = profileFor(tab)
    const buffer = Buffer.from(image.base64, 'base64')
    const evidence: VisualEvidence = {
      captureId, profileId, tabId: tab.id, capturedAt: now, expiresAt: now + CAPTURE_TTL_MS,
      width: image.width, height: image.height,
      viewport: { width: geometry.width, height: geometry.height, deviceScaleFactor: geometry.deviceScaleFactor, zoom: geometry.zoom },
      sha256: hash(buffer), file: this.write(profileId, captureId, buffer), image: { type: 'image', mimeType: 'image/png', data: image.base64 }
    }
    this.captures.set(captureId, { evidence, geometry, generation, webContents: tab.view.webContents })
    return publicEvidence(evidence)
  }

  /** DOM/ref remains preferred. This method only supplies actual pixels and CSS geometry. */
  capture(tab: Tab, signal?: AbortSignal): Promise<VisualEvidence> {
    return withTabLock(tab, signal, async () => {
      throwIfAborted(signal)
      const epoch = this.watch(tab.view.webContents)
      const generation = epoch.generation
      const geometry = await this.geometry(tab)
      const image = await this.take(tab)
      throwIfAborted(signal)
      if (generation !== epoch.generation || !sameGeometry(geometry, await this.geometry(tab))) throw new Error('[VISUAL_STATE_CHANGED] Page changed during capture; capture again.')
      return this.save(tab, image, geometry, generation)
    })
  }

  private async verify(tab: Tab, record: CaptureRecord, signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    const epoch = this.watch(tab.view.webContents)
    if (this.captures.get(record.evidence.captureId) !== record || record.webContents !== tab.view.webContents || record.evidence.tabId !== tab.id || record.evidence.profileId !== profileFor(tab) || record.evidence.expiresAt < (this.deps.now?.() ?? Date.now()) || record.generation !== epoch.generation || !sameGeometry(record.geometry, await this.geometry(tab))) {
      throw new Error('[STALE_VISUAL_CAPTURE] Profile, document, viewport, scroll or zoom changed; capture again.')
    }
    const fresh = await this.take(tab)
    throwIfAborted(signal)
    if (this.captures.get(record.evidence.captureId) !== record || hash(Buffer.from(fresh.base64, 'base64')) !== record.evidence.sha256 || record.generation !== epoch.generation || !sameGeometry(record.geometry, await this.geometry(tab))) {
      throw new Error('[STALE_VISUAL_CAPTURE] Screenshot pixels changed; capture again before using coordinates.')
    }
  }

  act(tab: Tab, input: VisualOperationInput, signal?: AbortSignal): Promise<VisualOperationResult> {
    return withTabLock(tab, signal, async () => {
      if (!input || !['click', 'drag', 'scroll', 'crop'].includes(input.action)) throw new Error('[INVALID_VISUAL_ACTION] Unknown visual action.')
      const record = this.captures.get(input.captureId)
      if (!record) throw new Error('[STALE_VISUAL_CAPTURE] Capture was not found; capture again.')
      const start = point(input.x, input.y, record.geometry)
      const end = input.action === 'drag' ? point(input.toX, input.toY, record.geometry) : undefined
      const deltaX = input.deltaX ?? 0
      const deltaY = input.deltaY ?? 0
      if (input.action === 'scroll' && (!Number.isFinite(deltaX) || !Number.isFinite(deltaY) || Math.abs(deltaX) > 3000 || Math.abs(deltaY) > 3000 || (deltaX === 0 && deltaY === 0))) throw new Error('[INVALID_SCROLL] Scroll deltas must be finite, nonzero and within 3000 CSS pixels.')
      await this.verify(tab, record, signal)
      const before = publicEvidence(record.evidence)
      if (input.action === 'crop') {
        if (!Number.isFinite(input.width) || !Number.isFinite(input.height) || Number(input.width) <= 0 || Number(input.height) <= 0 || start.x + Number(input.width) > record.geometry.width || start.y + Number(input.height) > record.geometry.height) throw new Error('[INVALID_CROP] Crop must stay inside the captured viewport.')
        const scaleX = before.width / record.geometry.width
        const scaleY = before.height / record.geometry.height
        const rectangle = { x: Math.floor(start.x * scaleX), y: Math.floor(start.y * scaleY), width: Math.max(1, Math.floor(Number(input.width) * scaleX)), height: Math.max(1, Math.floor(Number(input.height) * scaleY)) }
        const source = Buffer.from(before.image.data, 'base64')
        const buffer = this.deps.crop ? this.deps.crop(source, rectangle) : nativeImage.createFromBuffer(source).crop(rectangle).toPNG()
        const after = this.save(tab, { base64: buffer.toString('base64'), width: rectangle.width, height: rectangle.height }, record.geometry, record.generation)
        // Cropped evidence is a read result, never a valid coordinate source.
        this.captures.delete(after.captureId)
        return { before, after, operation: { action: 'crop', ...start, at: this.deps.now?.() ?? Date.now() }, verification: { visualChanged: false, documentChanged: false, verificationRequired: true } }
      }
      const approved = await this.deps.approve({ profileId: profileFor(tab), tabId: tab.id, action: input.action, url: approvalUrl(record.geometry.url), captureId: input.captureId, ...start, ...(end ? { toX: end.x, toY: end.y } : {}) }, signal)
      if (approved !== true) throw new Error('[APPROVAL_DENIED] Coordinate operation was not approved.')
      // User approval can take minutes. Validate the actual pixels again after it settles.
      await this.verify(tab, record, signal)
      this.captures.delete(input.captureId)
      const wc = tab.view.webContents
      const releaseRendering = tab.keepRendering()
      let attachedHere = false
      try {
        throwIfAborted(signal)
        if (!wc.debugger.isAttached()) { wc.debugger.attach('1.3'); attachedHere = true }
        const mouse = (type: string, x: number, y: number, extra: Record<string, unknown> = {}): Promise<unknown> => wc.debugger.sendCommand('Input.dispatchMouseEvent', { type, x, y, ...extra })
        if (input.action === 'scroll') {
          await mouse('mouseWheel', start.x, start.y, { deltaX, deltaY })
        } else {
          await mouse('mouseMoved', start.x, start.y)
          throwIfAborted(signal)
          await mouse('mousePressed', start.x, start.y, { button: 'left', buttons: 1, clickCount: 1 })
          try {
            if (end) {
              for (let index = 1; index <= 10; index++) {
                throwIfAborted(signal)
                await mouse('mouseMoved', start.x + (end.x - start.x) * index / 10, start.y + (end.y - start.y) * index / 10, { button: 'left', buttons: 1 })
              }
            }
          } finally {
            // Release pressed input even on cancellation, preventing a stuck drag.
            if (!wc.isDestroyed()) await mouse('mouseReleased', end?.x ?? start.x, end?.y ?? start.y, { button: 'left', buttons: 0, clickCount: 1 })
          }
        }
        tab.recordPointer?.({ kind: 'click', x: end?.x ?? start.x, y: end?.y ?? start.y })
        throwIfAborted(signal)
        await settleWithin(wc.debugger.sendCommand('Runtime.evaluate', { expression: 'new Promise(resolve => setTimeout(resolve, 80))', awaitPromise: true }), 1500)
        const afterGeometry = await this.geometry(tab)
        const afterImage = await this.take(tab)
        throwIfAborted(signal)
        const after = this.save(tab, afterImage, afterGeometry, this.watch(wc).generation)
        const result: VisualOperationResult = {
          before, after,
          operation: { action: input.action, ...start, ...(end ? { toX: end.x, toY: end.y } : {}), ...(input.action === 'scroll' ? { deltaX, deltaY } : {}), at: this.deps.now?.() ?? Date.now() },
          verification: { visualChanged: before.sha256 !== after.sha256, documentChanged: record.geometry.document !== afterGeometry.document || record.geometry.url !== afterGeometry.url, verificationRequired: true }
        }
        this.deps.record?.({ tabId: tab.id, profileId: profileFor(tab), before: before.file, after: after.file, operation: result.operation, verification: result.verification })
        return result
      } finally {
        if (attachedHere && !wc.isDestroyed()) { try { wc.debugger.detach() } catch { /* Renderer may already have exited. */ } }
        releaseRendering()
      }
    })
  }

  clear(tabId?: string): void {
    for (const [id, record] of this.captures) if (!tabId || record.evidence.tabId === tabId) this.captures.delete(id)
  }

  clearProfile(profileId: string): void {
    for (const [id, record] of this.captures) if (record.evidence.profileId === profileId) this.captures.delete(id)
  }
}

function approvalUrl(raw: string): string {
  try { const url = new URL(raw); url.username = ''; url.password = ''; url.search = ''; url.hash = ''; return url.toString() } catch { return '[unavailable]' }
}

async function settleWithin<T>(promise: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try { return await Promise.race([promise, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('[VISUAL_TIMEOUT] Page did not respond within the visual operation deadline.')), milliseconds) })]) }
  finally { if (timer) clearTimeout(timer) }
}
