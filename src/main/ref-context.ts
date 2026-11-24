import type { WebContents } from 'electron'

export type RefContextError = 'STALE_REF' | 'NAVIGATION_ERROR' | 'RENDERER_CRASH'

export type RefInvalidationReason =
  | 'stale_ref'
  | 'navigation_changed'
  | 'element_detached'
  | 'frame_unavailable'
  | 'target_closed'
  | 'renderer_restarted'
  | 'snapshot_expired'

interface EpochState {
  renderer: number
  navigation: number
}

interface SnapshotContext {
  renderer: number
  navigation: number
  url: string
  capturedAt: number
  refFloor: number
}

const epochs = new WeakMap<WebContents, EpochState>()
const snapshots = new WeakMap<WebContents, SnapshotContext>()
// 每个 WebContents 的 ref 编号底线。它与 Renderer 生命周期无关：导航、刷新、
// Renderer 重启后仍然保留，防止新文档把旧的 eN 名称分配给新的 DOM 节点。
const refFloors = new WeakMap<WebContents, number>()

function epochState(wc: WebContents): EpochState {
  let state = epochs.get(wc)
  if (!state) {
    state = { renderer: 0, navigation: 0 }
    epochs.set(wc, state)
  }
  return state
}

export function noteRendererRestart(wc: WebContents): void {
  const state = epochState(wc)
  state.renderer += 1
}

export function noteNavigation(wc: WebContents): void {
  const state = epochState(wc)
  state.navigation += 1
}

export function getRefFloor(wc: WebContents): number {
  return refFloors.get(wc) ?? 0
}

export function noteSnapshot(wc: WebContents, url: string, nextRefFloor = 0): void {
  const state = epochState(wc)
  const floor = Math.max(getRefFloor(wc), Number.isFinite(nextRefFloor) ? Math.floor(nextRefFloor) : 0)
  refFloors.set(wc, floor)
  snapshots.set(wc, {
    renderer: state.renderer,
    navigation: state.navigation,
    url,
    capturedAt: Date.now(),
    refFloor: floor
  })
}

export function checkRefContext(
  wc: WebContents,
  maxAgeMs = 30 * 60_000
): { code: RefContextError; reason: RefInvalidationReason; message: string } | null {
  const snapshot = snapshots.get(wc)
  if (!snapshot) return null
  const state = epochState(wc)
  if (state.renderer !== snapshot.renderer) {
    return {
      code: 'RENDERER_CRASH',
      reason: 'renderer_restarted',
      message: '渲染进程已重启，旧 ref 已失效（reason=renderer_restarted）；请重新调用 browser_snapshot 获取新 ref。'
    }
  }
  if (state.navigation !== snapshot.navigation || (wc.getURL() && snapshot.url && wc.getURL() !== snapshot.url)) {
    return {
      code: 'NAVIGATION_ERROR',
      reason: 'navigation_changed',
      message: '页面在快照后已导航或路由变化，旧 ref 已失效（reason=navigation_changed）；请重新调用 browser_snapshot 获取新 ref。'
    }
  }
  if (Date.now() - snapshot.capturedAt > maxAgeMs) {
    return {
      code: 'STALE_REF',
      reason: 'snapshot_expired',
      message: '快照已过期，旧 ref 已失效（reason=snapshot_expired）；请重新调用 browser_snapshot 获取新 ref。'
    }
  }
  return null
}
