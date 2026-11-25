import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeJsonAtomic } from './atomic-json'

export const TASK_CENTER_VERSION = 2

export const TASK_STATES = [
  'pending',
  'running',
  'waiting',
  'paused',
  'interrupted',
  'recovering',
  'completed',
  'failed',
  'cancelled'
] as const

export type TaskState = (typeof TASK_STATES)[number]

export interface TaskEvent {
  state: TaskState
  at: number
  reason?: string
  details?: Record<string, unknown>
}

export interface TaskStep {
  at: number
  label: string
  status?: string
  detail?: string
  durationMs?: number
}

export interface TaskSourceRecord {
  type: 'mcp' | 'internal' | 'unknown'
  clientId?: number
  sessionId?: string
  clientName?: string
  label?: string
  instanceId?: string
}

export interface TaskBrowserRecord {
  pid?: number
  instanceId?: string
  startedAt?: number
}

export interface TaskTabRecord {
  id?: string
  url?: string
  title?: string
  rendererPid?: number
  recovery?: {
    reason: 'crash' | 'unresponsive'
    attempts: number
    at: number
  }
}

export interface TaskRecoveryRecord {
  automaticReplay: false
  resumable: boolean
  requiresConfirmation: boolean
  reason: string
  lastAttemptAt?: number
}

export interface TaskSideEffectRecord {
  /** none=只读；possible=写操作可能已发生；committed=已确认完成；uncertain=失败/中断后无法确认。 */
  risk: 'none' | 'possible' | 'committed' | 'uncertain'
  destructive: boolean
  updatedAt?: number
}

export interface TaskRecord {
  id: string
  state: TaskState
  createdAt: number
  updatedAt: number
  highRisk: boolean
  retryCount: number
  maxRetries: number
  context?: Record<string, unknown>
  source?: TaskSourceRecord
  browser?: TaskBrowserRecord
  tab?: TaskTabRecord
  currentStep?: string
  recovery?: TaskRecoveryRecord
  sideEffect?: TaskSideEffectRecord
  idempotencyKey?: string
  history: TaskEvent[]
  steps?: TaskStep[]
  error?: string
}

export interface CreateTaskOptions {
  id?: string
  highRisk?: boolean
  retryCount?: number
  maxRetries?: number
  context?: Record<string, unknown>
  source?: TaskSourceRecord
  browser?: TaskBrowserRecord
  tab?: TaskTabRecord
  sideEffect?: TaskSideEffectRecord
  idempotencyKey?: string
}

const transitions: Record<TaskState, readonly TaskState[]> = {
  pending: ['running', 'waiting', 'recovering', 'cancelled'],
  running: ['waiting', 'paused', 'interrupted', 'recovering', 'completed', 'failed', 'cancelled'],
  waiting: ['running', 'paused', 'interrupted', 'recovering', 'failed', 'cancelled'],
  paused: ['running', 'interrupted', 'cancelled'],
  interrupted: ['running', 'waiting', 'recovering', 'cancelled', 'failed'],
  recovering: ['running', 'waiting', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: ['waiting', 'recovering', 'cancelled'],
  cancelled: []
}

const MAX_TASKS = 200
const MAX_HISTORY = 200
const MAX_STEPS = 200

function taskStoreFile(): string {
  return process.env['AA_BROWSER_TASK_CENTER_FILE'] || path.join(os.homedir(), '.aabrowser', 'task-center.json')
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function safeText(value: unknown, max: number): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined
}

function copyContext(context: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return context ? { ...context } : undefined
}

function copyEvent(event: TaskEvent): TaskEvent {
  return { ...event, details: event.details ? { ...event.details } : undefined }
}

function copyTask(task: TaskRecord): TaskRecord {
  return {
    ...task,
    context: copyContext(task.context),
    source: task.source ? { ...task.source } : undefined,
    browser: task.browser ? { ...task.browser } : undefined,
    tab: task.tab ? { ...task.tab, recovery: task.tab.recovery ? { ...task.tab.recovery } : undefined } : undefined,
    recovery: task.recovery ? { ...task.recovery } : undefined,
    sideEffect: task.sideEffect ? { ...task.sideEffect } : undefined,
    history: task.history.map(copyEvent),
    steps: task.steps?.map((step) => ({ ...step }))
  }
}

function normalizeSource(value: unknown, context: Record<string, unknown>): TaskSourceRecord | undefined {
  const raw = value && typeof value === 'object' ? value as Partial<TaskSourceRecord> : null
  const clientId = Number(raw?.clientId ?? context['client'])
  const sessionId = safeText(raw?.sessionId ?? context['clientSession'], 120)
  const clientName = safeText(raw?.clientName ?? context['clientName'], 80)
  const label = safeText(raw?.label ?? context['source'], 160)
  const instanceId = safeText(raw?.instanceId ?? context['instanceId'], 120)
  if (!raw && !sessionId && !clientName && !label && !Number.isSafeInteger(clientId)) return undefined
  const type = raw?.type === 'mcp' || raw?.type === 'internal' || raw?.type === 'unknown'
    ? raw.type
    : label?.startsWith('mcp:') ? 'mcp' : 'unknown'
  return {
    type,
    ...(Number.isSafeInteger(clientId) && clientId > 0 ? { clientId } : {}),
    ...(sessionId ? { sessionId } : {}),
    ...(clientName ? { clientName } : {}),
    ...(label ? { label } : {}),
    ...(instanceId ? { instanceId } : {})
  }
}

function normalizeBrowser(value: unknown, context: Record<string, unknown>): TaskBrowserRecord | undefined {
  const raw = value && typeof value === 'object' ? value as Partial<TaskBrowserRecord> : null
  const pid = Number(raw?.pid ?? context['browserPid'])
  const instanceId = safeText(raw?.instanceId ?? context['instanceId'], 120)
  const startedAt = Number(raw?.startedAt ?? context['browserStartedAt'])
  if (!raw && !Number.isSafeInteger(pid) && !instanceId) return undefined
  return {
    ...(Number.isSafeInteger(pid) && pid > 0 ? { pid } : {}),
    ...(instanceId ? { instanceId } : {}),
    ...(Number.isFinite(startedAt) ? { startedAt } : {})
  }
}

function normalizeTab(value: unknown, context: Record<string, unknown>): TaskTabRecord | undefined {
  const raw = value && typeof value === 'object' ? value as Partial<TaskTabRecord> : null
  const id = safeText(raw?.id ?? context['tabId'], 160)
  const url = safeText(raw?.url ?? context['tabUrl'], 2_000)
  const title = safeText(raw?.title ?? context['tabTitle'], 300)
  const rendererPid = Number(raw?.rendererPid ?? context['rendererPid'])
  const rawRecovery = raw?.recovery ?? context['rendererRecovery']
  let recovery: TaskTabRecord['recovery']
  if (rawRecovery && typeof rawRecovery === 'object') {
    const item = rawRecovery as { reason?: unknown; attempts?: unknown; at?: unknown }
    if ((item.reason === 'crash' || item.reason === 'unresponsive') && Number.isFinite(Number(item.attempts))) {
      recovery = {
        reason: item.reason,
        attempts: Math.max(0, Math.trunc(Number(item.attempts))),
        at: finiteNumber(item.at, Date.now())
      }
    }
  }
  if (!raw && !id && !url && !title && !Number.isSafeInteger(rendererPid) && !recovery) return undefined
  return {
    ...(id ? { id } : {}),
    ...(url ? { url } : {}),
    ...(title ? { title } : {}),
    ...(Number.isSafeInteger(rendererPid) && rendererPid > 0 ? { rendererPid } : {}),
    ...(recovery ? { recovery } : {})
  }
}

function normalizeSideEffect(value: unknown, highRisk: boolean): TaskSideEffectRecord | undefined {
  if (value && typeof value === 'object') {
    const raw = value as Partial<TaskSideEffectRecord>
    const risk = raw.risk === 'none' || raw.risk === 'possible' || raw.risk === 'committed' || raw.risk === 'uncertain'
      ? raw.risk
      : highRisk ? 'possible' : 'none'
    return {
      risk,
      destructive: raw.destructive === true || highRisk,
      ...(Number.isFinite(raw.updatedAt) ? { updatedAt: Number(raw.updatedAt) } : {})
    }
  }
  return highRisk ? { risk: 'possible', destructive: true } : undefined
}

function normalizeRecovery(
  value: unknown,
  highRisk: boolean,
  sideEffect: TaskSideEffectRecord | undefined
): TaskRecoveryRecord | undefined {
  if (!value || typeof value !== 'object') return undefined
  const raw = value as Partial<TaskRecoveryRecord>
  return {
    automaticReplay: false,
    resumable: raw.resumable === true,
    requiresConfirmation: raw.requiresConfirmation === true || highRisk || sideEffect?.risk !== 'none',
    reason: safeText(raw.reason, 160) ?? 'unknown',
    ...(Number.isFinite(raw.lastAttemptAt) ? { lastAttemptAt: Number(raw.lastAttemptAt) } : {})
  }
}

function normalizeTask(raw: unknown): TaskRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<TaskRecord>
  if (typeof value.id !== 'string' || !value.id.trim()) return null
  const now = Date.now()
  const highRisk = value.highRisk === true
  const context = value.context && typeof value.context === 'object' && !Array.isArray(value.context)
    ? { ...value.context }
    : {}
  const sideEffect = normalizeSideEffect(value.sideEffect, highRisk)
  const state = TASK_STATES.includes(value.state as TaskState) ? value.state as TaskState : 'interrupted'
  const steps = Array.isArray(value.steps)
    ? value.steps.slice(-MAX_STEPS)
      .filter((step): step is TaskStep => Boolean(step && typeof step === 'object' && typeof (step as TaskStep).label === 'string'))
      .map((step) => ({
        at: finiteNumber(step.at, now),
        label: String(step.label).slice(0, 200),
        ...(safeText(step.status, 80) ? { status: safeText(step.status, 80) } : {}),
        ...(safeText(step.detail, 1_000) ? { detail: safeText(step.detail, 1_000) } : {}),
        ...(Number.isFinite(step.durationMs) ? { durationMs: Math.max(0, Number(step.durationMs)) } : {})
      }))
    : undefined
  const task: TaskRecord = {
    id: value.id.trim().slice(0, 200),
    state,
    createdAt: finiteNumber(value.createdAt, now),
    updatedAt: finiteNumber(value.updatedAt, now),
    highRisk,
    retryCount: Math.max(0, Math.min(10, Math.trunc(finiteNumber(value.retryCount, 0)))),
    maxRetries: Math.max(0, Math.min(10, Math.trunc(finiteNumber(value.maxRetries, 2)))),
    context,
    source: normalizeSource(value.source, context),
    browser: normalizeBrowser(value.browser, context),
    tab: normalizeTab(value.tab, context),
    currentStep: safeText(value.currentStep, 200),
    recovery: normalizeRecovery(value.recovery, highRisk, sideEffect),
    sideEffect,
    idempotencyKey: safeText(value.idempotencyKey, 200),
    history: Array.isArray(value.history)
      ? value.history.slice(-MAX_HISTORY)
        .filter((event): event is TaskEvent => Boolean(event && typeof event === 'object' && TASK_STATES.includes((event as TaskEvent).state)))
        .map((event) => ({
          state: event.state,
          at: finiteNumber(event.at, now),
          ...(safeText(event.reason, 300) ? { reason: safeText(event.reason, 300) } : {}),
          ...(event.details && typeof event.details === 'object' && !Array.isArray(event.details) ? { details: { ...event.details } } : {})
        }))
      : [],
    steps,
    error: safeText(value.error, 240)
  }
  if (!task.history.length) task.history = [{ state: task.state, at: task.updatedAt }]
  const active = task.state === 'pending' || task.state === 'running' || task.state === 'waiting' || task.state === 'paused' || task.state === 'recovering'
  if (active) {
    task.state = 'interrupted'
    task.updatedAt = now
    task.error = '上次进程未完成；任务未自动重放。'
    task.recovery = {
      automaticReplay: false,
      resumable: !task.highRisk && task.sideEffect?.risk === 'none',
      requiresConfirmation: task.highRisk || task.sideEffect?.risk !== 'none',
      reason: 'process_restart'
    }
    task.history.push({ state: 'interrupted', at: now, reason: 'process_restart', details: { automaticReplay: false } })
  } else if (task.state === 'interrupted' || task.state === 'failed') {
    task.recovery ??= {
      automaticReplay: false,
      resumable: !task.highRisk && task.sideEffect?.risk === 'none',
      requiresConfirmation: task.highRisk || task.sideEffect?.risk !== 'none',
      reason: task.state
    }
  }
  return task
}

export class TaskStateError extends Error {
  readonly code = 'INVALID_TASK_TRANSITION'
}

export class TaskCenter {
  private readonly tasks = new Map<string, TaskRecord>()
  private sequence = 0
  private readonly storeFile: string
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  private lastWriteOk = true
  onChange: (task: TaskRecord) => void = () => {}

  /**
   * 默认路径可用 AA_BROWSER_TASK_CENTER_FILE 覆盖；AgentServer 会传入与
   * connection.json 同目录的路径，确保测试和自定义数据目录不会写到用户主目录。
   */
  constructor(storeFile?: string) {
    this.storeFile = storeFile?.trim() || taskStoreFile()
  }

  /** 加载持久化任务；v1 自动迁移，非终态统一标记为 interrupted，绝不自动重放。 */
  load(): TaskRecord[] {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = null
    this.lastWriteOk = true
    this.tasks.clear()
    try {
      const value = JSON.parse(fs.readFileSync(this.storeFile, 'utf8')) as { version?: unknown; tasks?: unknown }
      if ((value?.version !== 1 && value?.version !== TASK_CENTER_VERSION) || !Array.isArray(value.tasks)) {
        this.preserveStore('unsupported', '任务中心数据版本不受支持，原文件已保留')
        return []
      }
      let rejected = 0
      for (const raw of value.tasks.slice(-MAX_TASKS)) {
        const task = normalizeTask(raw)
        if (task) this.tasks.set(task.id, task)
        else rejected += 1
      }
      if (rejected) {
        this.preserveStore('partial', `任务中心有 ${rejected} 条无效记录，原文件已保留`)
      }
      this.write()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.preserveStore('corrupt', `任务中心数据无法读取，原文件已保留: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    return this.list()
  }

  persist(immediate = false): void {
    if (immediate) {
      if (this.persistTimer) clearTimeout(this.persistTimer)
      this.persistTimer = null
      this.write()
      return
    }
    if (this.persistTimer) return
    this.persistTimer = setTimeout(() => {
      this.persistTimer = null
      this.write()
    }, 1000)
    this.persistTimer.unref?.()
  }

  addStep(id: string, step: Omit<TaskStep, 'at'> & { at?: number }): TaskRecord {
    const task = this.require(id)
    task.steps ??= []
    const item: TaskStep = {
      at: finiteNumber(step.at, Date.now()),
      label: step.label.slice(0, 200),
      ...(step.status ? { status: step.status.slice(0, 80) } : {}),
      ...(step.detail ? { detail: step.detail.slice(0, 1_000) } : {}),
      ...(Number.isFinite(step.durationMs) ? { durationMs: Math.max(0, Number(step.durationMs)) } : {})
    }
    task.steps.push(item)
    if (task.steps.length > MAX_STEPS) task.steps.splice(0, task.steps.length - MAX_STEPS)
    task.currentStep = item.label
    task.updatedAt = Date.now()
    this.emit(task)
    return copyTask(task)
  }

  recordError(id: string, error: unknown): TaskRecord {
    const task = this.require(id)
    task.error = String(error ?? '').slice(0, 240)
    task.updatedAt = Date.now()
    this.emit(task, true)
    return copyTask(task)
  }

  markSideEffect(id: string, risk: TaskSideEffectRecord['risk'], destructive?: boolean): TaskRecord {
    const task = this.require(id)
    task.sideEffect = {
      risk,
      destructive: destructive ?? task.sideEffect?.destructive ?? task.highRisk,
      updatedAt: Date.now()
    }
    task.updatedAt = Date.now()
    this.emit(task, risk === 'committed' || risk === 'uncertain')
    return copyTask(task)
  }

  create(options: CreateTaskOptions = {}): TaskRecord {
    const id = options.id?.trim() || `task-${Date.now().toString(36)}-${(++this.sequence).toString(36)}`
    if (this.tasks.has(id)) throw new TaskStateError(`Task already exists: ${id}`)
    const now = Date.now()
    const highRisk = options.highRisk === true
    const task: TaskRecord = {
      id,
      state: 'pending',
      createdAt: now,
      updatedAt: now,
      highRisk,
      retryCount: Math.max(0, Math.min(10, Math.trunc(options.retryCount ?? 0))),
      maxRetries: Math.max(0, Math.min(10, Math.trunc(options.maxRetries ?? 2))),
      context: copyContext(options.context),
      source: options.source ? { ...options.source } : undefined,
      browser: options.browser ? { ...options.browser } : undefined,
      tab: options.tab ? { ...options.tab, recovery: options.tab.recovery ? { ...options.tab.recovery } : undefined } : undefined,
      sideEffect: options.sideEffect ? { ...options.sideEffect } : highRisk ? { risk: 'possible', destructive: true } : undefined,
      idempotencyKey: safeText(options.idempotencyKey, 200),
      history: [{ state: 'pending', at: now }],
      steps: []
    }
    this.tasks.set(id, task)
    this.prune(MAX_TASKS)
    this.emit(task, true)
    return copyTask(task)
  }

  get(id: string): TaskRecord | undefined {
    const task = this.tasks.get(id)
    return task ? copyTask(task) : undefined
  }

  findByIdempotencyKey(key: string): TaskRecord | undefined {
    const normalized = key.trim()
    if (!normalized) return undefined
    for (const task of [...this.tasks.values()].reverse()) {
      if (task.idempotencyKey === normalized) return copyTask(task)
    }
    return undefined
  }

  get lastPersistOk(): boolean {
    return this.lastWriteOk
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()].map(copyTask)
  }

  transition(id: string, state: TaskState, reason?: string, details?: Record<string, unknown>): TaskRecord {
    const task = this.tasks.get(id)
    if (!task) throw new TaskStateError(`Unknown task: ${id}`)
    if (task.state !== state && !transitions[task.state].includes(state)) {
      throw new TaskStateError(`Cannot transition ${task.state} -> ${state}`)
    }
    const now = Date.now()
    task.state = state
    task.updatedAt = now
    if (state === 'completed' || state === 'cancelled') task.currentStep = undefined
    if (state === 'failed' || state === 'interrupted' || state === 'cancelled') task.error ??= reason
    if (state === 'interrupted' || state === 'failed') {
      task.recovery = {
        automaticReplay: false,
        resumable: !task.highRisk && task.sideEffect?.risk === 'none',
        requiresConfirmation: task.highRisk || task.sideEffect?.risk !== 'none',
        reason: reason ?? state
      }
    } else if (state === 'recovering') {
      task.recovery = {
        automaticReplay: false,
        resumable: true,
        requiresConfirmation: task.highRisk || task.sideEffect?.risk !== 'none',
        reason: reason ?? 'recovery_requested',
        lastAttemptAt: now
      }
    } else if (state === 'completed' || state === 'cancelled') {
      task.recovery = {
        automaticReplay: false,
        resumable: false,
        requiresConfirmation: false,
        reason: state
      }
    }
    task.history.push({ state, at: now, ...(reason ? { reason } : {}), ...(details ? { details: { ...details } } : {}) })
    if (task.history.length > MAX_HISTORY) task.history.splice(0, task.history.length - MAX_HISTORY)
    this.emit(task, true)
    return copyTask(task)
  }

  /** 暂停是审计事件；恢复安全闸门后旧任务仍会收敛为 interrupted，绝不自动重放。 */
  notePause(id: string, reason: string): TaskRecord {
    const task = this.require(id)
    if (task.state === 'running' || task.state === 'waiting') {
      return this.transition(id, 'paused', reason, { automaticReplay: false })
    }
    if (task.state === 'pending') {
      task.updatedAt = Date.now()
      task.history.push({ state: 'paused', at: task.updatedAt, reason })
      if (task.history.length > MAX_HISTORY) task.history.splice(0, task.history.length - MAX_HISTORY)
      this.emit(task, true)
    }
    return copyTask(task)
  }

  requestRecovery(id: string, reason: string, confirmed = false): TaskRecord {
    const task = this.require(id)
    const risky = task.highRisk || (task.sideEffect?.risk !== undefined && task.sideEffect.risk !== 'none')
    if (risky && !confirmed) {
      return this.transition(id, 'waiting', reason, { requiresConfirmation: true, retryCount: task.retryCount })
    }
    if (!this.canRetry(id, confirmed)) return this.transition(id, 'failed', reason, { retryable: false })
    task.retryCount += 1
    return this.transition(id, 'recovering', reason, { retryCount: task.retryCount })
  }

  canRetry(id: string, confirmed = false): boolean {
    const task = this.require(id)
    const risky = task.highRisk || (task.sideEffect?.risk !== undefined && task.sideEffect.risk !== 'none')
    return !risky || confirmed ? task.retryCount < task.maxRetries : false
  }

  updateContext(id: string, context: Record<string, unknown>): TaskRecord {
    const task = this.require(id)
    task.context = { ...(task.context ?? {}), ...context }
    if (typeof context['tabId'] === 'string' && context['tabId']) task.tab = { ...task.tab, id: context['tabId'].slice(0, 160) }
    if (typeof context['tabUrl'] === 'string' && context['tabUrl']) task.tab = { ...task.tab, url: context['tabUrl'].slice(0, 2_000) }
    if (typeof context['tabTitle'] === 'string' && context['tabTitle']) task.tab = { ...task.tab, title: context['tabTitle'].slice(0, 300) }
    if (typeof context['rendererPid'] === 'number' && Number.isFinite(context['rendererPid'])) task.tab = { ...task.tab, rendererPid: Math.trunc(context['rendererPid']) }
    if (typeof context['browserPid'] === 'number' && Number.isFinite(context['browserPid'])) task.browser = { ...task.browser, pid: Math.trunc(context['browserPid']) }
    if (typeof context['source'] === 'string' && context['source']) task.source = { ...task.source, type: task.source?.type ?? 'unknown', label: context['source'].slice(0, 160) }
    const recovered = context['rendererRecovery']
    if (recovered && typeof recovered === 'object') {
      const value = recovered as { reason?: unknown; attempts?: unknown; at?: unknown }
      if ((value.reason === 'crash' || value.reason === 'unresponsive') && Number.isFinite(Number(value.attempts))) {
        task.tab = {
          ...task.tab,
          recovery: { reason: value.reason, attempts: Math.max(0, Math.trunc(Number(value.attempts))), at: finiteNumber(value.at, Date.now()) }
        }
      }
    }
    task.updatedAt = Date.now()
    this.emit(task, true)
    return copyTask(task)
  }

  remove(id: string): boolean {
    const removed = this.tasks.delete(id)
    if (removed) this.persist(true)
    return removed
  }

  prune(maxTasks = 1000): void {
    const capped = Math.max(0, Math.min(MAX_TASKS, Math.trunc(maxTasks)))
    if (this.tasks.size <= capped) return
    const terminal = [...this.tasks.values()]
      .filter((task) => task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled' || task.state === 'interrupted')
      .sort((left, right) => left.updatedAt - right.updatedAt)
    for (const task of terminal) {
      if (this.tasks.size <= capped) break
      this.tasks.delete(task.id)
    }
    this.persist(true)
  }

  private require(id: string): TaskRecord {
    const task = this.tasks.get(id)
    if (!task) throw new TaskStateError(`Unknown task: ${id}`)
    return task
  }

  private preserveStore(label: 'corrupt' | 'unsupported' | 'partial', message: string): void {
    try {
      fs.copyFileSync(this.storeFile, `${this.storeFile}.${label}-${Date.now()}.bak`, fs.constants.COPYFILE_EXCL)
    } catch { /* preserve failure as a startup diagnostic */ }
    console.warn(`[aa-browser] ${message}`)
  }

  private emit(task: TaskRecord, immediate = false): void {
    this.onChange(copyTask(task))
    this.persist(immediate)
  }

  private write(): void {
    try {
      writeJsonAtomic(this.storeFile, { version: TASK_CENTER_VERSION, tasks: [...this.tasks.values()] })
      this.lastWriteOk = true
    } catch (error) {
      this.lastWriteOk = false
      console.warn(`[aa-browser] 任务中心保存失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
