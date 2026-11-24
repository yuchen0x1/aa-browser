import type { WebContents } from 'electron'

export type RefContextError = 'STALE_REF' | 'NAVIGATION_ERROR' | 'RENDERER_CRASH'

interface EpochState {
  renderer: number
  navigation: number
}

interface SnapshotContext {
  renderer: number
  navigation: number
  url: string
  capturedAt: number
}

const epochs = new WeakMap<WebContents, EpochState>()
const snapshots = new WeakMap<WebContents, SnapshotContext>()

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

export function noteSnapshot(wc: WebContents, url: string): void {
  const state = epochState(wc)
  snapshots.set(wc, {
    renderer: state.renderer,
    navigation: state.navigation,
    url,
    capturedAt: Date.now()
  })
}

export function checkRefContext(wc: WebContents, maxAgeMs = 30 * 60_000): { code: RefContextError; message: string } | null {
  const snapshot = snapshots.get(wc)
  if (!snapshot) return null
  const state = epochState(wc)
  if (state.renderer !== snapshot.renderer) {
    return {
      code: 'RENDERER_CRASH',
      message: '渲染进程已重启，旧 ref 已失效；请重新调用 browser_snapshot 获取新 ref。'
    }
  }
  if (state.navigation !== snapshot.navigation || (wc.getURL() && snapshot.url && wc.getURL() !== snapshot.url)) {
    return {
      code: 'NAVIGATION_ERROR',
      message: '页面在快照后已导航或路由变化，旧 ref 已失效；请重新调用 browser_snapshot 获取新 ref。'
    }
  }
  if (Date.now() - snapshot.capturedAt > maxAgeMs) {
    return {
      code: 'STALE_REF',
      message: '快照已过期，旧 ref 已失效；请重新调用 browser_snapshot 获取新 ref。'
    }
  }
  return null
}
