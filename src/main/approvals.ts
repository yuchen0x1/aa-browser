import crypto from 'node:crypto'

/**
 * 审批等待上限。必须小于 MCP 桥的 CALL_TIMEOUT_MS（cli/mcp.mjs: 180s），
 * 否则用户还没点“允许”桥就已超时并发出 cancel，审批结果永远送不回去。
 */
export const APPROVAL_TIMEOUT_MS = 120_000
/** 用户点击「中断」后暂停 Agent 的窗口；到期自动恢复接管能力。 */
export const INTERRUPT_RESUME_MS = 30_000

export interface PendingApproval {
  id: string
  site: string
  tabTitle: string
  fieldLabel: string
  createdAt: number
  /** 审批类型：sensitive=敏感输入；operation=高危操作确认；permission=站点权限请求 */
  kind?: 'sensitive' | 'operation' | 'permission'
  /** operation / permission 类型的说明文案 */
  detail?: string
  /** permission 类型的权限名（media/geolocation/notifications） */
  permission?: string
}

type Pending = PendingApproval & { resolve: (allowed: boolean) => void; timer: NodeJS.Timeout }

export class ApprovalManager {
  private pending = new Map<string, Pending>()
  private interrupted = false
  private resumeTimer: NodeJS.Timeout | null = null
  private resumeAtValue: number | undefined
  onChange: () => void = () => {}

  list(): PendingApproval[] {
    return [...this.pending.values()].map(({ resolve: _resolve, timer: _timer, ...item }) => item)
  }

  isInterrupted(): boolean {
    return this.interrupted
  }

  /** 自动恢复倒计时的目标时间；未暂停时为 undefined。 */
  getResumeAt(): number | undefined {
    return this.resumeAtValue
  }

  assertRunning(): void {
    if (this.interrupted) throw new Error('Agent 已被用户中断；在浏览器工具栏重新允许操作后才能继续。')
  }

  request(meta: Omit<PendingApproval, 'id' | 'createdAt'>, signal?: AbortSignal): Promise<boolean> {
    this.assertRunning()
    const id = crypto.randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(id, false), APPROVAL_TIMEOUT_MS)
      const abort = (): void => { this.finish(id, false) }
      if (signal?.aborted) {
        clearTimeout(timer)
        resolve(false)
        return
      }
      signal?.addEventListener('abort', abort, { once: true })
      this.pending.set(id, {
        ...meta,
        id,
        createdAt: Date.now(),
        resolve: (allowed) => {
          signal?.removeEventListener('abort', abort)
          resolve(allowed)
        },
        timer
      })
      this.onChange()
    })
  }

  /** 高危操作人工确认（提交表单/下载等）。与 request 同构，kind=operation + detail 说明。 */
  opRequest(meta: { site: string; tabTitle: string; fieldLabel: string; detail?: string }, signal?: AbortSignal): Promise<boolean> {
    return this.request({ ...meta, kind: 'operation' }, signal)
  }

  decide(id: string, allowed: boolean): boolean {
    return this.finish(id, allowed)
  }

  interrupt(): void {
    // 重复中断只保持原有倒计时，不叠加 timer；UI 可安全重复触发该路径。
    if (!this.interrupted) {
      this.interrupted = true
      this.resumeAtValue = Date.now() + INTERRUPT_RESUME_MS
    }
    if (!this.resumeTimer) {
      const delay = Math.max(0, (this.resumeAtValue ?? Date.now()) - Date.now())
      this.resumeTimer = setTimeout(() => {
        this.resumeTimer = null
        this.resume()
      }, delay)
    }
    for (const id of [...this.pending.keys()]) this.finish(id, false)
    this.onChange()
  }

  resume(): void {
    const changed = this.interrupted || this.resumeAtValue !== undefined || this.resumeTimer !== null
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer)
      this.resumeTimer = null
    }
    this.interrupted = false
    this.resumeAtValue = undefined
    if (changed) this.onChange()
  }

  cancelAll(): void {
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer)
      this.resumeTimer = null
    }
    this.resumeAtValue = undefined
    for (const id of [...this.pending.keys()]) this.finish(id, false)
  }

  private finish(id: string, allowed: boolean): boolean {
    const item = this.pending.get(id)
    if (!item) return false
    clearTimeout(item.timer)
    this.pending.delete(id)
    item.resolve(allowed && !this.interrupted)
    this.onChange()
    return true
  }
}
