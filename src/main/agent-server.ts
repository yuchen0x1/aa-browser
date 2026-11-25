import http from 'node:http'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { WebSocketServer, WebSocket } from 'ws'
import type { ConnectionInfo, WsRequest, WsProgressEvent, AgentActivityState, AgentCallInfo, AgentTaskRecord } from '@shared/types'
import type { McpToolDef } from './tools'
import type { ApprovalManager } from './approvals'
import { runWithProgress } from './progress'
import { writeJsonAtomic } from './atomic-json'
import { redactText } from './redaction'
import { validateToolArguments } from './tool-validation'
import { revokeClientProfileAccess } from './permissions'
import { TaskCenter, type TaskRecord, type TaskSideEffectRecord } from './task-center'
import {
  IdempotencyConflictError,
  IdempotencyLedger,
  IdempotencyStorageError,
  type IdempotencyEntry
} from './idempotency-ledger'

const CONNECT_DIR = path.join(os.homedir(), '.aabrowser')
const DEFAULT_CONNECT_FILE = path.join(CONNECT_DIR, 'connection.json')
/** 单连接待发送队列上限；超过说明桥已跟不上，继续排队只会占内存。 */
const MAX_BUFFERED_BYTES = 64 * 1024 * 1024
const MAX_TASK_HISTORY = 100
const MAX_ACTIVITY_TASKS = 24
const CLIENT_SESSION_TTL_MS = 24 * 60 * 60 * 1000
export const MAX_REQUEST_BYTES = 2 * 1024 * 1024
export const MAX_CLIENT_CALLS = 16
export const MAX_ACTIVE_CALLS = 64
export const MAX_CLIENTS = 32

type ActiveTool = AgentTaskRecord

function redactTaskText(value: unknown): string {
  return redactText(value, 240)
}

function terminalLedgerState(state: TaskRecord['state']): IdempotencyEntry['state'] {
  if (state === 'completed' || state === 'failed' || state === 'cancelled') return state
  return 'interrupted'
}

function markResultUncertain(result: unknown, detail?: string): unknown {
  const base = result && typeof result === 'object' ? result as Record<string, unknown> : {}
  const content = Array.isArray(base['content']) ? base['content'] : []
  return {
    ...base,
    isError: true,
    content: [
      ...content,
      {
        type: 'text',
        text: `[TASK_STATE_CONFLICT] 工具可能已执行，但任务审计未能持久化（${detail ?? '未知错误'}）。请先核对页面实际状态，不要自动重试破坏性操作。`
      }
    ]
  }
}

function finiteRetryCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0
}

function terminalTaskStatus(state: string): AgentTaskRecord['status'] | null {
  return state === 'completed' || state === 'failed' || state === 'cancelled' || state === 'interrupted'
    ? state
    : null
}

function cloneActivity(state: AgentActivityState): AgentActivityState {
  return {
    ...state,
    calls: state.calls?.map((call) => ({ ...call })),
    tasks: state.tasks?.map((task) => ({
      ...task,
      steps: task.steps?.map((step) => ({ ...step })),
      recovery: task.recovery ? { ...task.recovery } : undefined,
      sideEffect: task.sideEffect ? { ...task.sideEffect } : undefined
    }))
  }
}

function connectionFile(): string {
  return process.env['AA_BROWSER_CONNECTION_FILE'] || DEFAULT_CONNECT_FILE
}

/** 本地 Agent 接入服务：WS + token 鉴权 + connection.json 发现文件 */
export class AgentServer {
  onPause?: (clientId?: number) => void
  private server = http.createServer()
  private wss: WebSocketServer
  private clients = new Set<WebSocket>()
  private verifiedClients = new Set<WebSocket>()
  private port = 0
  private token = ''
  private instanceId = crypto.randomUUID()
  private startedAt = 0
  private ownConnectionFile = ''
  private activityState: AgentActivityState = { active: false, paused: false }
  private taskHistory: AgentTaskRecord[] = []
  private taskHistoryFile = ''
  private taskPersistTimer: ReturnType<typeof setTimeout> | null = null
  private taskCenter = new TaskCenter()
  private idempotency: IdempotencyLedger | null = null
  private readonly taskLedgerKeys = new Map<string, string>()
  private activeTools = new Map<WebSocket, Map<number, ActiveTool>>()
  private active = new Map<WebSocket, Map<number, AbortController>>()
  private clientIds = new Map<WebSocket, number>()
  private pausedClients = new Set<number>()
  private clientSessions = new Map<string, { id: number; lastSeen: number }>()
  private clientLabels = new Map<number, { name?: string; session?: string }>()
  private clientSeq = 0
  private lastActivityPushAt = 0

  constructor(
    private tools: McpToolDef[],
    private onStatusChange: (count: number, verifiedCount: number) => void,
    private version: string,
    private approvals?: ApprovalManager,
    private onActivityChange: (state: AgentActivityState) => void = () => {},
    private runWithClientScope: <T>(clientId: number, operation: () => Promise<T>) => Promise<T> = (_clientId, operation) => operation(),
    private onClientDisconnected: (clientId: number) => void = () => {},
    private taskTabInfo: (tabId?: string) => { id: string; url?: string; title?: string; rendererPid?: number } | null = () => null
  ) {
    this.wss = new WebSocketServer({ server: this.server, maxPayload: MAX_REQUEST_BYTES })
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req))
  }

  noteTabRecovery(tabId: string, reason: 'crash' | 'unresponsive', attempts: number): void {
    for (const task of this.taskHistory) {
      if (task.status !== 'running' && task.status !== 'cancelling') continue
      if (task.tabId !== tabId) continue
      const detail = `标签 ${tabId} 渲染进程${reason === 'crash' ? '崩溃' : '无响应'}，第 ${attempts} 次恢复`
      task.steps ??= []
      task.steps.push({ at: Date.now(), label: 'renderer_recovery', status: reason, detail: detail.slice(0, 200) })
      if (task.steps.length > 20) task.steps.splice(0, task.steps.length - 20)
      task.updatedAt = Date.now()
      this.recordTaskStep(task.taskId, { at: Date.now(), label: 'renderer_recovery', status: reason, detail: `attempts=${attempts}` })
      if (task.taskId) {
        try {
          this.taskCenter.updateContext(task.taskId, {
            rendererRecovery: { reason, attempts, at: Date.now() }
          })
        } catch { /* historical task without a center record */ }
      }
      this.persistTaskHistory()
    }
  }

  /** 供 MCP 工具展示的运行时身份；不包含令牌和端口。 */
  get runtimeInfo(): { instanceId: string; pid: number; version: string; startedAt: number } {
    return { instanceId: this.instanceId, pid: process.pid, version: this.version, startedAt: this.startedAt }
  }

  async start(): Promise<void> {
    this.taskHistoryFile = path.join(path.dirname(connectionFile()), 'task-history.json')
    // 任务中心默认与发现文件放在同一数据目录；显式环境变量仍可覆盖。
    this.taskCenter = new TaskCenter(process.env['AA_BROWSER_TASK_CENTER_FILE'] || path.join(path.dirname(this.taskHistoryFile), 'task-center.json'))
    // 先载入 TaskCenter，避免 loadTaskHistory 的首次持久化用空内存覆盖已有记录。
    this.taskCenter.load()
    this.loadTaskHistory()
    this.reconcileTaskCenter()
    const ledgerFile = process.env['AA_BROWSER_IDEMPOTENCY_FILE'] ||
      path.join(path.dirname(this.taskCenterStoreFile()), 'task-idempotency.json')
    this.idempotency = new IdempotencyLedger(ledgerFile)
    const ledgerLoaded = this.idempotency.load()
    if (ledgerLoaded) {
      const knownKeys = this.taskCenter.list()
        .filter((task) => task.idempotencyKey)
        .map((task) => ({
          key: task.idempotencyKey!,
          taskId: task.id,
          tool: typeof task.context?.['tool'] === 'string' ? task.context['tool'] : 'unknown',
          state: terminalLedgerState(task.state),
          destructive: task.highRisk,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt
        }))
      this.idempotency.merge(knownKeys)
    }
    if (!this.idempotency.ready) {
      console.warn('[aa-browser] 幂等账本损坏或版本不受支持；破坏性写操作将被拒绝。请先核验备份和页面状态，再人工移走账本后重启')
    }
    this.token = crypto.randomBytes(24).toString('hex')
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(0, '127.0.0.1', () => {
        const addr = this.server.address()
        if (addr && typeof addr === 'object') this.port = addr.port
        resolve()
      })
    })
    this.ownConnectionFile = connectionFile()
    this.startedAt = Date.now()
    const info: ConnectionInfo = {
      port: this.port,
      token: this.token,
      pid: process.pid,
      version: this.version,
      startedAt: this.startedAt,
      instanceId: this.instanceId
    }
    const discoveryDir = path.resolve(path.dirname(this.ownConnectionFile))
    fs.mkdirSync(discoveryDir, { recursive: true, mode: 0o700 })
    // Only the application's private directory is ours to tighten. An existing custom
    // parent may be shared with other applications; the token file still uses 0600.
    if (process.platform !== 'win32' && path.resolve(discoveryDir) === path.resolve(CONNECT_DIR)) {
      try {
        if (!fs.lstatSync(discoveryDir).isSymbolicLink()) fs.chmodSync(discoveryDir, 0o700)
      } catch { /* 收紧失败不阻止令牌文件的 0600 保护。 */ }
    }
    writeJsonAtomic(this.ownConnectionFile, info)
  }

  private taskCenterStoreFile(): string {
    return process.env['AA_BROWSER_TASK_CENTER_FILE'] || path.join(path.dirname(this.taskHistoryFile), 'task-center.json')
  }

  /** 供设置面板展示：本地 Agent 服务的连接信息 */
  info(): { port: number; token: string; version: string; discoveryFile: string; clientCount: number; verifiedClientCount: number } {
    return {
      port: this.port,
      token: this.token,
      version: this.version,
      discoveryFile: this.ownConnectionFile || connectionFile(),
      clientCount: this.clients.size,
      verifiedClientCount: this.verifiedClients.size
    }
  }

  /** 当前活动快照，返回副本避免调用方修改内部状态。 */
  activity(): AgentActivityState {
    return cloneActivity({ ...this.activityState, tasks: this.taskHistory.slice(-MAX_ACTIVITY_TASKS).reverse() })
  }

  /** numeric client id 在进程重启后会复用，带会话的任务必须精确匹配会话。 */
  private ownsTask(task: AgentTaskRecord, clientId?: number, sessionId?: string): boolean {
    if (task.clientSession) return !!sessionId && task.clientSession === sessionId
    if (clientId === undefined || task.client !== clientId) return false
    return !!task.browserInstanceId && task.browserInstanceId === this.instanceId
  }

  /** MCP 任务列表所有权过滤；HUD 仍可通过 activity() 查看本机全部记录。 */
  tasksFor(clientId?: number, sessionId?: string): AgentTaskRecord[] {
    return this.taskHistory
      .filter((task) => this.ownsTask(task, clientId, sessionId))
      .slice(-MAX_ACTIVITY_TASKS)
      .reverse()
      .map((task) => ({
        ...task,
        steps: task.steps?.map((step) => ({ ...step })),
        recovery: task.recovery ? { ...task.recovery } : undefined,
        sideEffect: task.sideEffect ? { ...task.sideEffect } : undefined
      }))
  }

  /** 查询持久任务；同会话在浏览器重启后仍可读取，其它客户端不能猜测 taskId。 */
  taskDetail(taskId: string, clientId?: number, sessionId?: string): AgentTaskRecord | null {
    const id = taskId.trim()
    if (!id) return null
    let task = [...this.taskHistory].reverse().find((entry) => entry.taskId === id)
    if (!task) {
      const record = this.taskCenter.get(id)
      if (record) task = this.taskFromRecord(record) ?? undefined
    }
    if (!task) return null
    if (!this.ownsTask(task, clientId, sessionId)) return null
    return {
      ...task,
      steps: task.steps?.map((step) => ({ ...step })),
      recovery: task.recovery ? { ...task.recovery } : undefined,
      sideEffect: task.sideEffect ? { ...task.sideEffect } : undefined
    }
  }

  private loadTaskHistory(): void {
    try {
      const value = JSON.parse(fs.readFileSync(this.taskHistoryFile, 'utf8')) as { version?: unknown; tasks?: unknown }
      if (value?.version !== 1 || !Array.isArray(value.tasks)) {
        try { fs.copyFileSync(this.taskHistoryFile, `${this.taskHistoryFile}.unsupported-${Date.now()}.bak`, fs.constants.COPYFILE_EXCL) } catch { /* preserve failure as startup diagnostic */ }
        console.warn('[aa-browser] 任务历史版本不受支持，原文件已保留；将从任务中心重建')
        return
      }
      let rejected = 0
      const accepted = value.tasks.filter((raw): raw is AgentTaskRecord => {
        if (!raw || typeof raw !== 'object') return false
        const task = raw as Partial<AgentTaskRecord>
        const valid = Number.isSafeInteger(task.id) && Number.isSafeInteger(task.client) &&
          (task.client! > 0 || typeof task.taskId === 'string') &&
          typeof task.tool === 'string' && typeof task.startedAt === 'number' &&
          ['running', 'cancelling', 'completed', 'failed', 'cancelled', 'interrupted'].includes(String(task.status))
        if (!valid) rejected += 1
        return valid
      }).slice(-MAX_TASK_HISTORY).map((raw) => ({
        ...raw,
        steps: Array.isArray(raw.steps) ? raw.steps.slice(-20) : undefined
      }))
      if (rejected) {
        try { fs.copyFileSync(this.taskHistoryFile, `${this.taskHistoryFile}.partial-${Date.now()}.bak`, fs.constants.COPYFILE_EXCL) } catch { /* preserve failure as startup diagnostic */ }
        console.warn(`[aa-browser] 任务历史有 ${rejected} 条无效记录，原文件已保留`)
      }
      this.taskHistory = accepted
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      try { fs.copyFileSync(this.taskHistoryFile, `${this.taskHistoryFile}.corrupt-${Date.now()}.bak`, fs.constants.COPYFILE_EXCL) } catch { /* preserve failure as a startup diagnostic */ }
      console.warn(`[aa-browser] 任务历史无法读取，原文件已保留: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  private reconcileTaskCenter(): void {
    const records = new Map(this.taskCenter.list().map((task) => [task.id, task]))
    let changed = false
    for (const task of this.taskHistory) {
      // 新记录自带跨进程唯一的 taskId；旧版历史没有该字段时退回 legacy 键。
      const taskId = typeof task.taskId === 'string' && task.taskId ? task.taskId : `${task.client}:${task.id}`
      const record = records.get(taskId)
      task.taskId = taskId
      if (!record) {
        if (task.status === 'running' || task.status === 'cancelling') {
          task.status = 'interrupted'
          task.finishedAt = Date.now()
          task.updatedAt = task.finishedAt
          task.error = '上次进程未完成；任务未自动重放。'
          changed = true
        }
        continue
      }
      task.updatedAt = record.updatedAt
      task.retryCount = record.retryCount
      task.steps = record.steps?.slice(-20)
      task.browserInstanceId = record.browser?.instanceId ?? task.browserInstanceId
      task.clientSession = record.source?.sessionId ?? task.clientSession
      task.recovery = record.recovery ? { ...record.recovery } : task.recovery
      task.sideEffect = record.sideEffect ? { ...record.sideEffect } : task.sideEffect
      if (record.error) task.error = record.error
      const terminal = terminalTaskStatus(record.state)
      if (terminal) {
        task.status = terminal
        task.finishedAt = record.updatedAt
        task.updatedAt = record.updatedAt
      }
      changed = true
      records.delete(taskId)
    }
    // task-history.json 丢失或损坏时，仍从有效的 TaskCenter 恢复任务记录。
    for (const record of records.values()) {
      const task = this.taskFromRecord(record)
      if (!task) continue
      this.taskHistory.push(task)
      changed = true
    }
    if (this.taskHistory.length > MAX_TASK_HISTORY) {
      this.taskHistory = this.taskHistory
        .sort((left, right) => left.startedAt - right.startedAt)
        .slice(-MAX_TASK_HISTORY)
    }
    if (changed) this.persistTaskHistory(true)
  }

  private taskFromRecord(record: TaskRecord): AgentTaskRecord | null {
    const context = record.context ?? {}
    const clientValue = Number(context['client'])
    const callValue = Number(context['callId'])
    const startedValue = Number(context['startedAt'])
    const tool = typeof context['tool'] === 'string' ? context['tool'] : ''
    if (!tool) return null
    const status = terminalTaskStatus(record.state) ?? 'interrupted'
    const client = Number.isSafeInteger(clientValue) && clientValue > 0 ? clientValue : 0
    const id = Number.isSafeInteger(callValue) && callValue >= 0 ? callValue : record.createdAt
    const startedAt = Number.isFinite(startedValue) ? startedValue : record.createdAt
    const text = (value: unknown): string | undefined =>
      typeof value === 'string' && value ? value : undefined
    return {
      id,
      tool,
      startedAt,
      client,
      status,
      taskId: record.id,
      ...(record.browser?.instanceId ? { browserInstanceId: record.browser.instanceId } : {}),
      updatedAt: record.updatedAt,
      retryCount: record.retryCount,
      ...(status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'interrupted'
        ? { finishedAt: record.updatedAt }
        : {}),
      ...(record.error ? { error: record.error } : {}),
      ...(record.steps?.length ? { steps: record.steps.slice(-20) } : {}),
      ...(text(context['source']) ? { source: text(context['source']) } : {}),
      ...(text(context['tabId']) ? { tabId: text(context['tabId']) } : {}),
      ...(record.source?.sessionId ? { clientSession: record.source.sessionId } : {}),
      ...(record.recovery ? { recovery: { ...record.recovery } } : {}),
      ...(record.sideEffect ? { sideEffect: { ...record.sideEffect } } : {})
    }
  }

  private persistTaskHistory(immediate = false): void {
    if (!this.taskHistoryFile) return
    if (!immediate) {
      if (this.taskPersistTimer) return
      this.taskPersistTimer = setTimeout(() => {
        this.taskPersistTimer = null
        this.persistTaskHistory(true)
      }, 1000)
      this.taskPersistTimer.unref?.()
      return
    }
    if (this.taskPersistTimer) clearTimeout(this.taskPersistTimer)
    this.taskPersistTimer = null
    try {
      writeJsonAtomic(this.taskHistoryFile, { version: 1, tasks: this.taskHistory.slice(-MAX_TASK_HISTORY) })
    } catch (error) {
      console.warn(`[aa-browser] 任务历史保存失败: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      this.taskCenter.persist(immediate)
    }
  }

  private finishTask(
    task: AgentTaskRecord,
    status: AgentTaskRecord['status'],
    error?: unknown
  ): { durable: boolean; error?: string } {
    // 连接断开/暂停会先把任务标记为 terminal；随后被中止的工具在 catch/finally
    // 里还会再走一次 finishTask。终态必须一次性确定，不能被迟到的 abort 覆盖成
    // cancelled，否则持久化历史与 TaskCenter 会分叉。
    if (task.status === 'completed' || task.status === 'failed' || task.status === 'cancelled' || task.status === 'interrupted') {
      return { durable: this.taskCenter.lastPersistOk }
    }
    let effectiveStatus = status
    let centerOk = true
    if (task.taskId) {
      const current = this.taskCenter.get(task.taskId)
      if (current) {
        const terminal = terminalTaskStatus(current.state)
        if (terminal) {
          // 只可能发生在旧版 client:callId 记录与当前调用撞键时。核验为终态后
          // 必须同步内存记录，绝不能把当前任务永久留在 running/cancelling。
          console.warn(`[aa-browser] 任务 ID 已存在且处于终态，按已落库结果收敛: ${task.taskId}`)
          effectiveStatus = terminal
          task.finishedAt = current.updatedAt
          task.updatedAt = current.updatedAt
          if (current.error) task.error = current.error
        } else try {
          if (task.sideEffect && task.sideEffect.risk !== 'none') {
            const risk: TaskSideEffectRecord['risk'] = status === 'completed' ? 'committed' : 'uncertain'
            const sideEffect = this.taskCenter.markSideEffect(task.taskId, risk, task.sideEffect.destructive)
            task.sideEffect = sideEffect.sideEffect ? { ...sideEffect.sideEffect } : task.sideEffect
          }
          if (error !== undefined) this.taskCenter.recordError(task.taskId, redactTaskText(error))
          const state = status === 'interrupted' ? 'interrupted' : status === 'cancelled' ? 'cancelled' : status === 'failed' ? 'failed' : 'completed'
          this.taskCenter.transition(task.taskId, state, status, { callId: task.id, tool: task.tool })
        } catch (persistError) {
          // 状态机拒绝（例如 waiting -> completed）不能让工具响应丢失或内存记录悬空。
          centerOk = false
          console.warn(`[aa-browser] 任务中心状态更新失败: ${persistError instanceof Error ? persistError.message : String(persistError)}`)
        }
        if (!this.taskCenter.lastPersistOk) centerOk = false
      } else {
        centerOk = false
        console.warn(`[aa-browser] 任务中心记录缺失，仅更新内存任务: ${task.taskId}`)
      }
    }
    task.status = effectiveStatus
    task.finishedAt = Date.now()
    task.updatedAt = task.finishedAt
    if (error !== undefined) task.error = redactTaskText(error)
    this.persistTaskHistory(true)
    let ledgerOk = true
    const ledgerKey = task.taskId ? this.taskLedgerKeys.get(task.taskId) : undefined
    if (ledgerKey && this.idempotency) {
      const ledgerState = terminalLedgerState(effectiveStatus as TaskRecord['state'])
      try {
        this.idempotency.update(ledgerKey, ledgerState)
        this.taskLedgerKeys.delete(task.taskId!)
      } catch (ledgerError) {
        ledgerOk = false
        console.warn(`[aa-browser] 幂等账本终态写入失败: ${ledgerError instanceof Error ? ledgerError.message : String(ledgerError)}`)
      }
    }
    const durable = centerOk && ledgerOk
    return {
      durable,
      ...(durable ? {} : { error: !centerOk ? '任务中心持久化失败' : '幂等账本持久化失败' })
    }
  }

  private notifyPause(clientId?: number): void {
    try { this.onPause?.(clientId) }
    catch (error) {
      console.warn(`[aa-browser] 工作流暂停通知失败: ${redactText(error instanceof Error ? error.message : String(error), 240)}`)
    }
  }

  /** 中断当前调用并进入暂停状态；重复调用不会重复广播或产生额外副作用。 */
  pause(resumeAt?: number): void {
    for (const calls of this.active.values()) {
      for (const controller of calls.values()) controller.abort()
    }
    // 调用 finally 仍会清理原 Map 引用；从当前活动集合移除，防止恢复后残留旧调用。
    this.activeTools.clear()
    const next: AgentActivityState = {
      active: false,
      paused: true,
      calls: [],
      tasks: this.taskHistory.slice(-MAX_ACTIVITY_TASKS).reverse(),
      ...(resumeAt !== undefined ? { resumeAt } : {})
    }
    for (const task of this.taskHistory) {
      if (task.status !== 'running' && task.status !== 'cancelling') continue
      if (task.taskId) {
        try { this.taskCenter.notePause(task.taskId, '用户暂停 Agent') } catch { /* 历史任务可能没有中心记录 */ }
      }
      this.finishTask(task, 'interrupted', '任务已暂停；不会自动重放。')
    }
    this.persistTaskHistory(true)
    const changed = this.activityState.active !== next.active ||
      this.activityState.paused !== next.paused ||
      this.activityState.resumeAt !== next.resumeAt ||
      this.activityState.tool !== next.tool ||
      this.activityState.startedAt !== next.startedAt
    this.activityState = next
    this.notifyPause()
    if (changed) this.onActivityChange(this.activity())
  }

  /** 清除暂停标记；新的调用会在 handleMessage 中重新成为 active。 */
  resume(): void {
    if (!this.activityState.paused && this.activityState.resumeAt === undefined) return
    this.activityState = { active: false, paused: false, tasks: this.taskHistory.slice(-MAX_ACTIVITY_TASKS).reverse() }
    this.onActivityChange(this.activity())
  }

  isClientPaused(clientId: number): boolean {
    return this.pausedClients.has(clientId)
  }

  pauseClient(clientId: number, exceptCallId?: number): void {
    if (!Number.isSafeInteger(clientId) || clientId < 1) return
    this.pausedClients.add(clientId)
    for (const [ws, calls] of this.active) {
      if (this.clientIds.get(ws) !== clientId) continue
      for (const [id, controller] of calls) {
        if (id === exceptCallId) continue
        const task = this.activeTools.get(ws)?.get(id)
        if (task && (task.status === 'running' || task.status === 'cancelling')) {
          if (task.taskId) {
            try { this.taskCenter.notePause(task.taskId, 'MCP 客户端暂停') } catch { /* 历史任务可能没有中心记录 */ }
          }
          this.finishTask(task, 'interrupted', '此 MCP 客户端已暂停；任务未自动重放。')
        }
        controller.abort()
      }
    }
    this.notifyPause(clientId)
    this.persistTaskHistory(true)
    this.refreshActivity()
  }

  resumeClient(clientId: number): void {
    if (this.pausedClients.delete(clientId)) this.refreshActivity()
  }

  private refreshActivity(force = true): void {
    if (this.activityState.paused) return
    const entries: ActiveTool[] = []
    for (const calls of this.activeTools.values()) entries.push(...calls.values())
    entries.sort((a, b) => b.startedAt - a.startedAt)
    const current = entries[0]
    const calls: AgentCallInfo[] = entries.map((entry) => ({ ...entry }))
    const next: AgentActivityState = current
      ? { active: true, paused: false, tool: current.tool, startedAt: current.startedAt, calls }
      : { active: false, paused: false, calls: [] }
    const prev = this.activityState
    const structuralChanged = prev.active !== next.active ||
      prev.tool !== next.tool ||
      prev.startedAt !== next.startedAt ||
      prev.paused !== next.paused ||
      (prev.calls?.length ?? 0) !== calls.length ||
      (prev.calls ?? []).some((call, i) => call.id !== calls[i]?.id || call.client !== calls[i]?.client || call.tool !== calls[i]?.tool)
    const throttled = !force && !structuralChanged && Date.now() - this.lastActivityPushAt < 150
    this.activityState = next
    if (throttled) return
    this.lastActivityPushAt = Date.now()
    this.onActivityChange(this.activity())
  }

  /** 把工具上报的进度写回活动状态（限流推送）并发给对应客户端的桥。 */
  private sendProgress(ws: WebSocket, id: number, progress: number, total?: number, message?: string): void {
    const call = this.activeTools.get(ws)?.get(id)
    if (!call || call.status !== 'running' || this.activityState.paused || this.pausedClients.has(call.client)) return
    if (Number.isFinite(progress)) call.progress = progress
    if (total !== undefined && Number.isFinite(total)) call.total = total
    if (message !== undefined) call.message = redactTaskText(message).slice(0, 200)
    const event: WsProgressEvent = {
      id,
      event: 'progress',
      progress: Number.isFinite(progress) ? progress : 0,
      ...(total !== undefined ? { total } : {}),
      ...(message !== undefined ? { message: redactTaskText(message).slice(0, 200) } : {})
    }
    this.reply(ws, event)
    const step = {
      at: Date.now(),
      label: redactTaskText(message ?? 'progress').slice(0, 200),
      status: 'progress',
      detail: `${progress}/${total ?? '?'}`
    }
    call.steps ??= []
    call.steps.push(step)
    if (call.steps.length > 20) call.steps.splice(0, call.steps.length - 20)
    this.recordTaskStep(call.taskId, step)
    call.updatedAt = Date.now()
    this.persistTaskHistory()
    // 进度可能非常密集（等待轮询每 100ms 一次），限流到 ~6fps，完成/取消时再强制推送。
    this.refreshActivity(Date.now() - this.lastActivityPushAt >= 150)
  }

  private recordTaskStep(taskId: string | undefined, step: { at: number; label: string; status?: string; detail?: string }): void {
    if (!taskId) return
    try {
      this.taskCenter.addStep(taskId, step)
    } catch {
      // 创建失败已在 handleMessage 记录诊断；进度更新是尽力而为，不能反向中断工具。
    }
  }

  /** 按 (client, id) 中断一个调用；旧版仅传 id 时必须唯一，否则拒绝猜测。 */
  cancelCall(id: number, client?: number): boolean {
    if (typeof id !== 'number' || !Number.isFinite(id)) return false
    if (client !== undefined && (!Number.isSafeInteger(client) || client < 1)) return false
    let target: { ws: WebSocket; controller: AbortController } | undefined
    for (const [ws, calls] of this.active) {
      if (client !== undefined && this.clientIds.get(ws) !== client) continue
      const controller = calls.get(id)
      if (!controller) continue
      // 请求 id 是客户端本地序号；不同连接可能都从 1 开始，不得中断首个匹配项。
      if (target) return false
      target = { ws, controller }
    }
    if (!target) return false
    const task = this.activeTools.get(target.ws)?.get(id)
    if (task?.status === 'running') {
      task.status = 'cancelling'
      task.message = '正在取消…'
      this.persistTaskHistory(true)
      this.refreshActivity()
    }
    target.controller.abort()
    return true
  }

  private onConnection(ws: WebSocket, req: http.IncomingMessage): void {
    // 仅允许本机 + token 校验
    const remote = req.socket.remoteAddress ?? ''
    if (!/^127\.0\.0\.1$|^::1$|^::ffff:127\.0\.0\.1$/.test(remote)) {
      ws.close(4403, 'forbidden')
      return
    }
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.searchParams.get('token') !== this.token) {
      ws.close(4401, 'unauthorized')
      return
    }
    if (this.clients.size >= MAX_CLIENTS) { ws.close(4429, 'too many clients'); return }
    this.clients.add(ws)
    const now = Date.now()
    for (const [key, session] of this.clientSessions) {
      if (now - session.lastSeen <= CLIENT_SESSION_TTL_MS) continue
      this.clientSessions.delete(key)
      this.pausedClients.delete(session.id)
    }
    const sessionKey = url.searchParams.get('client') ?? ''
    let clientId: number
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionKey)) {
      const session = this.clientSessions.get(sessionKey)
      if (session) {
        clientId = session.id
        session.lastSeen = now
      } else {
        clientId = ++this.clientSeq
        this.clientSessions.set(sessionKey, { id: clientId, lastSeen: now })
      }
    } else {
      clientId = ++this.clientSeq
    }
    const label = this.clientLabels.get(clientId) ?? {}
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(sessionKey)) label.session = sessionKey
    const requestedName = (url.searchParams.get('name') ?? '').trim().slice(0, 80)
    if (requestedName) label.name = requestedName
    this.clientLabels.set(clientId, label)
    this.clientIds.set(ws, clientId)
    this.onStatusChange(this.clients.size, this.verifiedClients.size)

    ws.on('message', (raw) => {
      void this.handleMessage(ws, raw.toString()).catch((error: unknown) => {
        console.warn(`[aa-browser] 处理桥请求失败: ${redactText(error instanceof Error ? error.message : String(error))}`)
      })
    })
    const dropClient = (): void => {
      const calls = this.active.get(ws)
      for (const controller of calls?.values() ?? []) controller.abort()
      for (const task of this.activeTools.get(ws)?.values() ?? []) {
        this.finishTask(task, 'interrupted', 'MCP 客户端连接已断开；任务未自动重放。')
      }
      this.active.delete(ws)
      this.activeTools.delete(ws)
      this.clients.delete(ws)
      this.clientIds.delete(ws)
      this.verifiedClients.delete(ws)
      if (![...this.clientIds.values()].includes(clientId)) {
        revokeClientProfileAccess(clientId)
        this.onClientDisconnected(clientId)
      }
      this.refreshActivity()
      this.onStatusChange(this.clients.size, this.verifiedClients.size)
    }
    ws.on('close', dropClient)
    ws.on('error', dropClient)
  }

  private async handleMessage(ws: WebSocket, raw: string): Promise<void> {
    if (Buffer.byteLength(raw) > MAX_REQUEST_BYTES) { ws.close(1009, 'request too large'); return }
    let req: WsRequest
    try {
      req = JSON.parse(raw) as WsRequest
    } catch {
      console.warn('[aa-browser] 忽略无法解析的桥消息（原始内容未记录）')
      return
    }
    if (!Number.isSafeInteger(req?.id) || req.id < 0) return
    if (req.cancel === true) {
      this.active.get(ws)?.get(req.id)?.abort()
      return
    }
    // 活动 id 的响应权归原调用；忽略同连接的重复请求，既不覆盖 controller，
    // 也不回同 id 的错误（会让桥把原调用误判为失败）。取消帧仍在上面正常处理。
    if (this.active.get(ws)?.has(req.id)) return
    const totalCalls = [...this.active.values()].reduce((sum, calls) => sum + calls.size, 0)
    if ((this.active.get(ws)?.size ?? 0) >= MAX_CLIENT_CALLS || totalCalls >= MAX_ACTIVE_CALLS) {
      this.reply(ws, { id: req.id, ok: false, error: '[RESOURCE_LIMIT] Too many concurrent tool calls; wait for a running call to finish' })
      return
    }
    const clientId = this.clientIds.get(ws) ?? 0
    const canControlPausedTasks = (req.tool === 'browser_window' && req.args?.['action'] === 'release') ||
      (req.tool === 'browser_tasks' && ['list', 'get', 'cancel', 'pause', 'resume'].includes(String(req.args?.['action'] ?? 'list')))
    if ((this.approvals?.isInterrupted() || this.pausedClients.has(clientId)) && !canControlPausedTasks) {
      this.reply(ws, { id: req.id, ok: false, error: this.pausedClients.has(clientId) ? '此 MCP 客户端已暂停；请调用 browser_tasks action=resume 后重试。' : 'Agent 已被用户中断（人工接管或任务暂停）；请调用 browser_window action=release，或在浏览器工具栏点击“恢复”后重试。' })
      return
    }
    if (typeof req.tool !== 'string' || !req.tool.trim()) {
      // 有 id 却不带工具名：立即回错误，否则桥只能等到超时。
      this.reply(ws, { id: req.id, ok: false, error: 'invalid request: 缺少工具名' })
      return
    }
    if (req.args !== undefined && (req.args === null || typeof req.args !== 'object' || Array.isArray(req.args))) {
      this.reply(ws, { id: req.id, ok: false, error: 'invalid request: args 必须是对象' })
      return
    }

    const tool = this.tools.find((t) => t.name === req.tool)
    if (!tool) {
      this.reply(ws, { id: req.id, ok: false, error: `未知工具: ${req.tool}` })
      return
    }
    try {
      if (tool.inputSchema) validateToolArguments(tool.inputSchema, req.args ?? {})
    } catch (error) {
      this.reply(ws, { id: req.id, ok: false, error: redactText((error as Error).message) })
      return
    }
    const actionName = String(req.args?.['action'] ?? '')
    const actionReadOnly =
      (req.tool === 'browser_tasks' && ['list', 'get'].includes(actionName || 'list')) ||
      (req.tool === 'browser_tabs' && (actionName || 'list') === 'list') ||
      (req.tool === 'browser_evidence' && ['list', 'hash'].includes(actionName)) ||
      (req.tool === 'browser_window' && (actionName || 'mode') === 'mode' && req.args?.['mode'] === undefined)
    const readOnly = tool.annotations?.readOnlyHint === true || actionReadOnly
    const destructive = !actionReadOnly && tool.annotations?.destructiveHint === true &&
      !(req.tool === 'browser_tasks' && ['cancel', 'pause', 'resume'].includes(actionName))
    const suppliedIdempotencyKey = typeof req.idempotencyKey === 'string' ? req.idempotencyKey.trim().slice(0, 200) : ''
    const clientSession = this.clientLabels.get(clientId)?.session ?? `client-${clientId}`
    const idempotencyKey = suppliedIdempotencyKey
      ? crypto.createHash('sha256').update(clientSession).update('\0').update(suppliedIdempotencyKey).digest('hex')
      : ''
    const startedAt = Date.now()
    // MCP 请求 ID 会在桥或应用重启后从 1 重新计数，不能单独作为持久化主键。
    const taskId = `${clientId}:${req.id}:${startedAt.toString(36)}`
    if (!readOnly) {
      if (destructive && !idempotencyKey) {
        this.reply(ws, {
          id: req.id,
          ok: false,
          error: '[TASK_STATE_CONFLICT] 破坏性操作缺少 idempotencyKey，已拒绝执行。请通过官方 MCP 桥调用，或提供稳定的幂等键。'
        })
        return
      }
      if (idempotencyKey) {
        if (!this.idempotency?.ready) {
          this.reply(ws, {
            id: req.id,
            ok: false,
            error: '[TASK_STATE_CONFLICT] 幂等账本损坏或不可写，写操作已拒绝。请先修复任务数据目录后重启浏览器。'
          })
          return
        }
        try {
          this.idempotency.claim({
            key: idempotencyKey,
            taskId,
            tool: req.tool,
            destructive
          })
          this.taskLedgerKeys.set(taskId, idempotencyKey)
        } catch (claimError) {
          if (claimError instanceof IdempotencyConflictError) {
            const entry = claimError.entry
            this.reply(ws, {
              id: req.id,
              ok: false,
              error: `[TASK_STATE_CONFLICT] 当前客户端会话已受理同一操作（状态 ${entry.state}${entry.destructive ? '；副作用无法安全重放' : ''}）。请先核验页面状态；如确需重试，请生成新的操作步骤而不是复用旧请求。`
            })
          } else if (claimError instanceof IdempotencyStorageError) {
            const message = claimError instanceof Error ? claimError.message : String(claimError)
            this.reply(ws, {
              id: req.id,
              ok: false,
              error: `[TASK_STATE_CONFLICT] 幂等记录无法落盘，写操作未执行: ${message}。请修复磁盘/权限后重启浏览器，不要绕过幂等保护。`
            })
          } else {
            this.reply(ws, { id: req.id, ok: false, error: `[TASK_STATE_CONFLICT] 幂等保护失败，写操作未执行: ${String(claimError)}` })
          }
          return
        }
      }
    }
    const controller = new AbortController()
    let calls = this.active.get(ws)
    if (!calls) { calls = new Map(); this.active.set(ws, calls) }
    calls.set(req.id, controller)
    let activityCalls = this.activeTools.get(ws)
    if (!activityCalls) { activityCalls = new Map(); this.activeTools.set(ws, activityCalls) }
    const label = this.clientLabels.get(clientId)
    const source = label?.name
      ? `mcp:${label.name}`
      : label?.session
        ? `mcp:${label.session.slice(0, 8)}`
        : `client-${clientId}`
    const requestedTabId = typeof req.args?.['tabId'] === 'string' ? req.args['tabId'] : undefined
    const tabInfo = this.taskTabInfo(requestedTabId)
    const tabId = requestedTabId || tabInfo?.id
    const sideEffect: AgentTaskRecord['sideEffect'] = readOnly
      ? { risk: 'none', destructive: false }
      : { risk: 'possible', destructive, updatedAt: startedAt }
    const task: AgentTaskRecord = {
      id: req.id,
      tool: req.tool,
      startedAt,
      client: clientId,
      status: 'running',
      taskId,
      updatedAt: startedAt,
      retryCount: Math.max(0, Math.trunc(finiteRetryCount(req.args?.['__aaRetryCount']))),
      steps: [],
      ...(tabId ? { tabId } : {}),
      source,
      browserInstanceId: this.instanceId,
      ...(label?.session ? { clientSession: label.session } : {}),
      sideEffect
    }
    activityCalls.set(req.id, task)
    this.taskHistory.push(task)
    if (this.taskHistory.length > MAX_TASK_HISTORY) this.taskHistory.splice(0, this.taskHistory.length - MAX_TASK_HISTORY)
    try {
      const record = this.taskCenter.create({
        id: task.taskId,
        retryCount: task.retryCount,
        highRisk: destructive,
        idempotencyKey: idempotencyKey || undefined,
        sideEffect: {
          risk: sideEffect.risk,
          destructive: sideEffect.destructive,
          updatedAt: startedAt
        },
        source: {
          type: 'mcp',
          clientId,
          ...(label?.session ? { sessionId: label.session } : {}),
          ...(label?.name ? { clientName: label.name } : {}),
          label: source,
          instanceId: this.instanceId
        },
        browser: {
          pid: process.pid,
          instanceId: this.instanceId,
          startedAt: this.startedAt
        },
        ...(tabId ? {
          tab: {
            id: tabId,
            ...(tabInfo?.url ? { url: tabInfo.url } : {}),
            ...(tabInfo?.title ? { title: tabInfo.title } : {}),
            ...(tabInfo?.rendererPid ? { rendererPid: tabInfo.rendererPid } : {})
          }
        } : {}),
        context: {
          client: clientId,
          callId: req.id,
          tool: req.tool,
          instanceId: this.instanceId,
          browserPid: process.pid,
          source: task.source,
          clientSession: label?.session,
          clientName: label?.name,
          startedAt: task.startedAt,
          ...(tabId ? {
            tabId,
            ...(tabInfo?.url ? { tabUrl: tabInfo.url } : {}),
            ...(tabInfo?.title ? { tabTitle: tabInfo.title } : {}),
            ...(tabInfo?.rendererPid ? { rendererPid: tabInfo.rendererPid } : {})
          } : {})
        }
      })
      this.taskCenter.transition(record.id, 'running', 'tool_started')
    } catch (error) {
      console.warn(`[aa-browser] 任务中心未能登记 ${taskId}: ${error instanceof Error ? error.message : String(error)}`)
    }
    this.persistTaskHistory(true)
    this.refreshActivity()
    console.log(`[aa-browser] tool request: ${req.tool} (${req.id})`)
    try {
      const result = await runWithProgress(
        {
          report: (progress, total, message) => this.sendProgress(ws, req.id, progress, total, message)
        },
        () => this.runWithClientScope(task.client, () => tool.handler({
          ...Object.fromEntries(Object.entries(req.args ?? {}).filter(([key]) => !key.startsWith('__aa'))),
          __aaSignal: controller.signal,
          __aaClientId: task.client,
          __aaCallId: req.id,
          __aaTaskId: taskId,
          __aaClientSession: label?.session
        }))
      )
      if ((controller.signal.aborted || this.approvals?.isInterrupted()) && !canControlPausedTasks) {
        throw new Error('工具调用已被用户中断或取消。')
      }
      const toolSucceeded = typeof result === 'object' && result !== null && (result as { isError?: boolean }).isError !== true
      const finished = this.finishTask(task, toolSucceeded ? 'completed' : 'failed', toolSucceeded ? undefined : (result as { content?: Array<{ text?: unknown }> })?.content?.[0]?.text ?? '工具返回失败。')
      // 任意一次成功调用都证明客户端确实能驱动浏览器。更新重启后桥会先重放
      // 只读调用；只认 browser_tabs(list) 会让界面在任务已恢复时仍显示“等待首次调用”。
      if (toolSucceeded && !this.verifiedClients.has(ws)) {
        this.verifiedClients.add(ws)
        this.onStatusChange(this.clients.size, this.verifiedClients.size)
      }
      console.log(`[aa-browser] tool complete: ${req.tool} (${req.id})`)
      this.reply(ws, { id: req.id, ok: true, result: finished.durable ? result : markResultUncertain(result, finished.error) })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const finished = this.finishTask(task, controller.signal.aborted ? (this.activityState.paused || this.pausedClients.has(task.client) ? 'interrupted' : 'cancelled') : 'failed', msg)
      this.reply(ws, {
        id: req.id,
        ok: false,
        error: finished.durable
          ? msg
          : `${msg}\n[TASK_STATE_CONFLICT] 任务审计未能持久化（${finished.error ?? '未知错误'}）。请先核对页面实际状态，不要自动重试破坏性操作。`
      })
    } finally {
      calls.delete(req.id)
      // pause/disconnect may detach these maps while an abort-ignoring handler is
      // still running. Only remove the socket entry if it still owns this map.
      if (!calls.size && this.active.get(ws) === calls) this.active.delete(ws)
      activityCalls.delete(req.id)
      if (!activityCalls.size && this.activeTools.get(ws) === activityCalls) this.activeTools.delete(ws)
      this.refreshActivity()
    }
  }

  private reply(ws: WebSocket, resp: unknown): void {
    if (ws.readyState !== WebSocket.OPEN) return
    // 结果可能带大截图；慢客户端积压过多时断开重连，避免主进程内存被无界排队拖垮。
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) {
      console.warn(`[aa-browser] 桥客户端发送积压 ${ws.bufferedAmount} 字节，主动断开`)
      ws.close(1011, 'client too slow')
      return
    }
    try {
      ws.send(JSON.stringify(resp))
    } catch (error) {
      // 序列化失败或连接在检查后关闭：记录并放弃这一帧，不能让异常逃出消息处理。
      console.warn(`[aa-browser] 回复桥消息失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  isClientConnected(clientId: number): boolean {
    return [...this.clientIds.values()].includes(clientId)
  }

  /** 清理发现文件（应用退出时调用） */
  stop(): void {
    for (const clientId of new Set(this.clientIds.values())) revokeClientProfileAccess(clientId)
    for (const calls of this.active.values()) {
      for (const controller of calls.values()) controller.abort()
    }
    for (const calls of this.activeTools.values()) {
      for (const task of calls.values()) this.finishTask(task, 'interrupted', '浏览器已退出；任务未自动重放。')
    }
    this.persistTaskHistory(true)
    if (this.taskPersistTimer) clearTimeout(this.taskPersistTimer)
    this.taskPersistTimer = null
    for (const ws of this.clients) ws.close(1001, 'browser shutting down')
    try {
      const file = this.ownConnectionFile || connectionFile()
      const current = JSON.parse(fs.readFileSync(file, 'utf-8')) as Partial<ConnectionInfo>
      if (current.instanceId === this.instanceId && current.pid === process.pid) fs.rmSync(file, { force: true })
    } catch {
      /* missing, stale, or owned by another instance */
    }
    try {
      this.wss.close()
      this.server.close()
    } catch {
      /* 忽略 */
    }
  }
}
