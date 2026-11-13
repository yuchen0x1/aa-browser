import type { WebContents } from 'electron'
import type { FindState } from '@shared/types'
import type { TabManager } from './tabs'

/** 原生页面查找；请求与标签绑定，忽略已过期的异步查找结果。 */
export class PageFinder {
  private state: FindState = { open: false, query: '', matches: 0, activeMatch: 0 }
  private target: WebContents | null = null
  private requestId = -1
  private listening = new WeakSet<WebContents>()

  constructor(private tabs: TabManager, private changed: () => void) {}

  getState(): FindState { return { ...this.state } }

  open(): void {
    const wc = this.tabs.active()?.view.webContents
    if (!wc || wc.isDestroyed()) return
    if (this.target !== wc) this.close(false)
    this.target = wc
    if (!this.listening.has(wc)) {
      this.listening.add(wc)
      wc.on('found-in-page', (_event, result) => {
        if (!this.state.open || this.target !== wc || result.requestId !== this.requestId) return
        this.state.matches = result.matches
        this.state.activeMatch = result.activeMatchOrdinal
        this.changed()
      })
      wc.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
        if (isMainFrame && !inPlace && this.target === wc) this.close(false)
      })
      wc.once('destroyed', () => { if (this.target === wc) this.close(false) })
    }
    this.state.open = true
    this.changed()
  }

  search(query: string, forward = true, next = false): void {
    if (!this.state.open || !this.target || this.target.isDestroyed()) return
    const text = query.slice(0, 500)
    const sameQuery = this.state.query === text
    this.state.query = text
    this.requestId = -1
    if (!text || !sameQuery) {
      this.target.stopFindInPage('clearSelection')
      this.state.matches = 0
      this.state.activeMatch = 0
    }
    if (text) this.requestId = this.target.findInPage(text, { forward, findNext: !next || !sameQuery })
    this.changed()
  }

  syncActive(): void {
    if (this.target && this.target !== this.tabs.active()?.view.webContents) this.close(false)
  }

  close(focusPage = true): void {
    const wc = this.target
    this.target = null
    this.requestId = -1
    this.state = { open: false, query: '', matches: 0, activeMatch: 0 }
    if (wc && !wc.isDestroyed()) {
      wc.stopFindInPage('clearSelection')
      if (focusPage) wc.focus()
    }
    this.changed()
  }
}
