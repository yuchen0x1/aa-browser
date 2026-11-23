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
}

export interface CreateTaskOptions {
  id?: string
  highRisk?: boolean
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
    history: task.history.map((event) => ({ ...event, details: event.details ? { ...event.details } : undefined }))
  }
}

export class TaskStateError extends Error {
  readonly code = 'INVALID_TASK_TRANSITION'
}

export class TaskCenter {
  private readonly tasks = new Map<string, TaskRecord>()
  private sequence = 0
  onChange: (task: TaskRecord) => void = () => {}

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
      retryCount: 0,
      maxRetries: Math.max(0, Math.min(10, Math.trunc(options.maxRetries ?? 2))),
      context: copyContext(options.context),
      history: [{ state: 'pending', at: now }]
    }
    this.tasks.set(id, task)
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
    return this.tasks.delete(id)
  }

  prune(maxTasks = 1000): void {
    if (this.tasks.size <= maxTasks) return
    const terminal = [...this.tasks.values()]
      .filter((task) => task.state === 'completed' || task.state === 'failed' || task.state === 'cancelled')
      .sort((left, right) => left.updatedAt - right.updatedAt)
    for (const task of terminal) {
      if (this.tasks.size <= maxTasks) break
      this.tasks.delete(task.id)
    }
  }

  private require(id: string): TaskRecord {
    const task = this.tasks.get(id)
    if (!task) throw new TaskStateError(`Unknown task: ${id}`)
    return task
  }

  private emit(task: TaskRecord): void {
    this.onChange(cloneTask(task))
  }
}

