import crypto from 'node:crypto'

export interface PendingApproval {
  id: string
  site: string
  tabTitle: string
  fieldLabel: string
  createdAt: number
  /** 审批类型：sensitive=敏感输入；operation=高危操作确认 */
  kind?: 'sensitive' | 'operation'
  /** operation 类型的说明文案 */
  detail?: string
}

type Pending = PendingApproval & { resolve: (allowed: boolean) => void; timer: NodeJS.Timeout }

export class ApprovalManager {
  private pending = new Map<string, Pending>()
  private interrupted = false
  onChange: () => void = () => {}

  list(): PendingApproval[] {
    return [...this.pending.values()].map(({ resolve: _resolve, timer: _timer, ...item }) => item)
  }

  isInterrupted(): boolean {
    return this.interrupted
  }

  assertRunning(): void {
    if (this.interrupted) throw new Error('Agent 已被用户中断；在浏览器工具栏重新允许操作后才能继续。')
  }

  request(meta: Omit<PendingApproval, 'id' | 'createdAt'>, signal?: AbortSignal): Promise<boolean> {
    this.assertRunning()
    const id = crypto.randomUUID()
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finish(id, false), 120_000)
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
    this.interrupted = true
    for (const id of [...this.pending.keys()]) this.finish(id, false)
    this.onChange()
  }

  resume(): void {
    this.interrupted = false
    this.onChange()
  }

  cancelAll(): void {
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
