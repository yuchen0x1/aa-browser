/**
 * MCP 进度上报基础设施。
 *
 * 通过 node:async_hooks 的 AsyncLocalStorage 在一次工具调用的异步链路中
 * 传递进度回调；长操作只需调用 reportProgress 即可上报，而无需把回调
 * 层层透传。没有活动上下文时（例如直接调用底层函数）reportProgress 是
 * 安全的空操作，且它本身永不抛错，调用点无需 try/catch。
 */

import { AsyncLocalStorage } from 'node:async_hooks'

export interface ProgressContext {
  report: (progress: number, total?: number, message?: string) => void
}

const progressStorage = new AsyncLocalStorage<ProgressContext>()

/** 在给定进度上下文中执行 fn，始终返回 Promise（fn 的同步异常也会转成 rejection）。 */
export function runWithProgress<T>(ctx: ProgressContext, fn: () => T | Promise<T>): Promise<T> {
  return progressStorage.run(ctx, () => {
    try {
      return Promise.resolve(fn())
    } catch (error) {
      return Promise.reject(error)
    }
  })
}

/** 上报一次进度；无活动上下文或上报回调抛错时静默忽略，永不向外抛错。 */
export function reportProgress(progress: number, total?: number, message?: string): void {
  const ctx = progressStorage.getStore()
  if (!ctx) return
  try {
    ctx.report(progress, total, message)
  } catch {
    /* 进度上报失败不影响工具本身 */
  }
}
