import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { writeJsonAtomic } from './atomic-json'

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
}

const transitions: Record<TaskState, readonly TaskState[]> = {
  pending: ['running', 'waiting', 'recovering', 'cancelled'],
  running: ['waiting', 'paused', 'interrupted', 'recovering', 'completed', 'failed', 'cancelled'],
  waiting: ['running', 'paused', 'interrupted', 'recovering', 'failed', 'cancelled'],
  paused: ['running', 'interrupted', 'cancelled'],
  interrupted: ['running', 'recovering', 'cancelled', 'failed'],
  recovering: ['running', 'waiting', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: ['recovering', 'cancelled'],
  cancelled: []
}

function copyContext(context: Record<string, unknown> | undefined): Record<string, unknown> | undefined {
  return context ? { ...context } : undefined
}

function cloneTask(task: TaskRecord): TaskRecord {
  return {
    ...task,
    context: copyContext(task.context),
    history: task.history.map((event) => ({ ...event, details: event.details ? { ...event.details } : undefined })),
    steps: task.steps?.map((step) => ({ ...step }))
  }
}

export class TaskStateError extends Error {
  readonly code = 'INVALID_TASK_TRANSITION'
}

const TASK_CENTER_VERSION = 1
const MAX_TASKS = 200

function taskStoreFile(): string {
  return process.env['AA_BROWSER_TASK_CENTER_FILE'] || path.join(os.homedir(), '.aabrowser', 'task-center.json')
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeTask(raw: unknown): TaskRecord | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<TaskRecord>
  if (typeof value.id !== 'string' || !value.id.trim()) return null
  const state = TASK_STATES.includes(value.state as TaskState) ? value.state as TaskState : 'interrupted'
  const now = Date.now()
  const task: TaskRecord = {
    id: value.id,
    state,
    createdAt: finiteNumber(value.createdAt, now),
    updatedAt: finiteNumber(value.updatedAt, now),
    highRisk: value.highRisk === true,
    retryCount: Math.max(0, Math.min(10, Math.trunc(finiteNumber(value.retryCount, 0)))),
    maxRetries: Math.max(0, Math.min(10, Math.trunc(finiteNumber(value.maxRetries, 2)))),
    context: value.context && typeof value.context === 'object' && !Array.isArray(value.context) ? { ...value.context } : undefined,
    history: Array.isArray(value.history) ? value.history.slice(-200).filter((event): event is TaskEvent => Boolean(event && typeof event === 'object' && TASK_STATES.includes((event as TaskEvent).state))) : [],
    steps: Array.isArray(value.steps) ? value.steps.slice(-200).filter((step): step is TaskStep => Boolean(step && typeof step === 'object' && typeof (step as TaskStep).label === 'string')) : undefined,
    error: typeof value.error === 'string' ? value.error.slice(0, 240) : undefined
  }
  if (!task.history.length) task.history = [{ state: task.state, at: task.updatedAt }]
  if (task.state === 'pending' || task.state === 'running' || task.state === 'waiting' || task.state === 'paused' || task.state === 'recovering') {
    task.state = 'interrupted'
    task.updatedAt = now
    task.error = '上次进程未完成；任务未自动重放。'
    task.history.push({ state: 'interrupted', at: now, reason: 'process_restart', details: { automaticReplay: false } })
  }
  return task
}

export class TaskCenter {
  private readonly tasks = new Map<string, TaskRecord>()
  private sequence = 0
  private readonly storeFile: string
  private persistTimer: ReturnType<typeof setTimeout> | null = null
  onChange: (task: TaskRecord) => void = () => {}

  /**
   * 默认路径可用 AA_BROWSER_TASK_CENTER_FILE 覆盖；AgentServer 会传入与
   * connection.json 同目录的路径，确保测试和自定义数据目录不会写到用户主目录。
   */
  constructor(storeFile?: string) {
    this.storeFile = storeFile?.trim() || taskStoreFile()
  }

  /** 加载持久化任务；非终态统一标记为 interrupted，绝不自动重放。 */
  load(): TaskRecord[] {
    if (this.persistTimer) clearTimeout(this.persistTimer)
    this.persistTimer = null
    this.tasks.clear()
    try {
      const value = JSON.parse(fs.readFileSync(this.storeFile, 'utf8')) as { version?: unknown; tasks?: unknown }
      if (value?.version !== TASK_CENTER_VERSION || !Array.isArray(value.tasks)) {
        this.preserveStore('unsupported', '任务中心数据版本不受支持，原文件已保留')
        return []
      }
      for (const raw of value.tasks.slice(-MAX_TASKS)) {
        const task = normalizeTask(raw)
        if (task) this.tasks.set(task.id, task)
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
    task.steps.push({
      at: finiteNumber(step.at, Date.now()),
      label: step.label.slice(0, 200),
      ...(step.status ? { status: step.status.slice(0, 80) } : {}),
      ...(step.detail ? { detail: step.detail.slice(0, 1000) } : {})
    })
    if (task.steps.length > 200) task.steps.splice(0, task.steps.length - 200)
    task.updatedAt = Date.now()
    this.emit(task)
    return cloneTask(task)
  }

  recordError(id: string, error: unknown): TaskRecord {
    const task = this.require(id)
    task.error = String(error ?? '').slice(0, 240)
    task.updatedAt = Date.now()
    this.emit(task)
    return cloneTask(task)
  }

  create(options: CreateTaskOptions = {}): TaskRecord {
    const id = options.id?.trim() || `task-${Date.now().toString(36)}-${(++this.sequence).toString(36)}`
    if (this.tasks.has(id)) throw new TaskStateError(`Task already exists: ${id}`)
    const now = Date.now()
    const task: TaskRecord = {
      id,
      state: 'pending',
      createdAt: now,
      updatedAt: now,
      highRisk: options.highRisk === true,
      retryCount: Math.max(0, Math.min(10, Math.trunc(options.retryCount ?? 0))),
      maxRetries: Math.max(0, Math.min(10, Math.trunc(options.maxRetries ?? 2))),
      context: copyContext(options.context),
      history: [{ state: 'pending', at: now }],
      steps: []
    }
    this.tasks.set(id, task)
    this.prune(MAX_TASKS)
    this.emit(task)
    return cloneTask(task)
  }

  get(id: string): TaskRecord | undefined {
    const task = this.tasks.get(id)
    return task ? cloneTask(task) : undefined
  }

  list(): TaskRecord[] {
    return [...this.tasks.values()].map(cloneTask)
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
    if (state === 'failed' || state === 'interrupted' || state === 'cancelled') task.error ??= reason
    task.history.push({ state, at: now, ...(reason ? { reason } : {}), ...(details ? { details: { ...details } } : {}) })
    if (task.history.length > 200) task.history.splice(0, task.history.length - 200)
    this.emit(task)
    return cloneTask(task)
  }

  requestRecovery(id: string, reason: string, confirmed = false): TaskRecord {
    const task = this.require(id)
    if (task.highRisk && !confirmed) {
      return this.transition(id, 'waiting', reason, { requiresConfirmation: true, retryCount: task.retryCount })
    }
    if (!this.canRetry(id, confirmed)) return this.transition(id, 'failed', reason, { retryable: false })
    task.retryCount += 1
    return this.transition(id, 'recovering', reason, { retryCount: task.retryCount })
  }

  canRetry(id: string, confirmed = false): boolean {
    const task = this.require(id)
    return !task.highRisk || confirmed ? task.retryCount < task.maxRetries : false
  }

  updateContext(id: string, context: Record<string, unknown>): TaskRecord {
    const task = this.require(id)
    task.context = { ...(task.context ?? {}), ...context }
    task.updatedAt = Date.now()
    this.emit(task)
    return cloneTask(task)
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

  private preserveStore(label: 'corrupt' | 'unsupported', message: string): void {
    try {
      fs.copyFileSync(this.storeFile, `${this.storeFile}.${label}-${Date.now()}.bak`, fs.constants.COPYFILE_EXCL)
    } catch { /* preserve failure as a startup diagnostic */ }
    console.warn(`[aa-browser] ${message}`)
  }

  private emit(task: TaskRecord): void {
    this.onChange(cloneTask(task))
    this.persist()
  }

  private write(): void {
    try {
      writeJsonAtomic(this.storeFile, { version: TASK_CENTER_VERSION, tasks: [...this.tasks.values()] })
    } catch (error) {
      console.warn(`[aa-browser] 任务中心保存失败: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}

