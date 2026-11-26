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
  /** 是否可由用户在本次会话内记住同一操作（仅 operation，且主进程算出了稳定键）。 */
  rememberable?: boolean
}

type ApprovalRequest = Omit<PendingApproval, 'id' | 'createdAt' | 'rememberable'> & {
  /** 调用方提供的稳定去重键（例如目标元素指纹）；缺省时用 site + action + detail。 */
  rememberKey?: string
  /** 传 false 时不参与本会话记忆（Profile/工作流等范围授权保持逐次确认）。 */
  remember?: boolean
}
type Pending = PendingApproval & { resolve: (allowed: boolean) => void; timer: NodeJS.Timeout; rememberKey?: string; remember?: boolean }

/** 操作类审批的自动放行键；只保存在内存里，应用退出即失效。 */
function composeRememberKey(meta: ApprovalRequest): string | undefined {
  if (meta.kind !== 'operation' || meta.remember === false) return undefined
  return crypto
    .createHash('sha256')
    .update(meta.site)
    .update('\u0000')
    .update(meta.fieldLabel)
    .update('\u0000')
    .update(meta.rememberKey ?? meta.detail ?? '')
    .digest('hex')
}

export class ApprovalManager {
  private pending = new Map<string, Pending>()
  /** 本会话内用户明确允许过的“相同页面 + 相同操作”；不落盘、不跨重启。 */
  private remembered = new Set<string>()
  private interrupted = false
  private resumeTimer: NodeJS.Timeout | null = null
  private resumeAtValue: number | undefined
  onChange: () => void = () => {}
  /** 只有新增请求时才通知桌面层；解决、超时或暂停不会再次唤起窗口。 */
  onRequest: () => void = () => {}

  list(): PendingApproval[] {
    return [...this.pending.values()].map(({ resolve: _resolve, timer: _timer, rememberKey: key, remember: _remember, ...item }) => (
      { ...item, rememberable: !!key }
    ))
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

  request(meta: ApprovalRequest, signal?: AbortSignal): Promise<boolean> {
    this.assertRunning()
    if (signal?.aborted) return Promise.resolve(false)
    const key = composeRememberKey(meta)
    // 已在本会话人工允许过的同一页面同一操作：直接放行，不再次打扰用户。
    if (key && this.remembered.has(key)) return Promise.resolve(true)
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
        rememberKey: key,
        resolve: (allowed) => {
          signal?.removeEventListener('abort', abort)
          resolve(allowed)
        },
        timer
      })
      this.onChange()
      this.onRequest()
    })
  }

  /** 高危操作人工确认（提交表单/下载等）。与 request 同构，kind=operation + detail 说明。
   *  rememberKey 用于区分同一站点上的不同目标（例如元素指纹），避免“删除”类操作互相放行。 */
  opRequest(meta: { site: string; tabTitle: string; fieldLabel: string; detail?: string; rememberKey?: string; remember?: boolean }, signal?: AbortSignal): Promise<boolean> {
    return this.request({ ...meta, kind: 'operation' }, signal)
  }

  /** remember=true 时把本次允许记到当前会话；只对 operation 且真正放行的允许生效。 */
  decide(id: string, allowed: boolean, remember = false): boolean {
    const item = this.pending.get(id)
    if (allowed && remember && item?.rememberKey && !this.interrupted) this.remembered.add(item.rememberKey)
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

  /** 任务中心的手动暂停：与“中断 30 秒”不同，必须等待用户显式恢复。 */
  pauseIndefinitely(): void {
    if (this.resumeTimer) {
      clearTimeout(this.resumeTimer)
      this.resumeTimer = null
    }
    this.interrupted = true
    this.resumeAtValue = undefined
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
