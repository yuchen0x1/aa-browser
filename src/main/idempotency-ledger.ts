import fs from 'node:fs'
import { writeJsonAtomic } from './atomic-json'

const LEDGER_VERSION = 1
const MAX_ENTRIES = 5_000

export type IdempotencyState = 'claimed' | 'completed' | 'failed' | 'cancelled' | 'interrupted'

export interface IdempotencyEntry {
  key: string
  taskId: string
  tool: string
  state: IdempotencyState
  destructive: boolean
  createdAt: number
  updatedAt: number
}

export interface IdempotencyClaim {
  key: string
  taskId: string
  tool: string
  destructive: boolean
}

export class IdempotencyConflictError extends Error {
  readonly code = 'TASK_STATE_CONFLICT'

  constructor(readonly entry: IdempotencyEntry) {
    super(`Idempotency key already claimed: ${entry.key}`)
  }
}

export class IdempotencyStorageError extends Error {
  readonly code = 'TASK_STATE_CONFLICT'
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function normalizeEntry(raw: unknown): IdempotencyEntry | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Partial<IdempotencyEntry>
  if (typeof value.key !== 'string' || !value.key.trim()) return null
  if (typeof value.taskId !== 'string' || !value.taskId.trim()) return null
  if (typeof value.tool !== 'string' || !value.tool.trim()) return null
  const state = value.state === 'claimed' || value.state === 'completed' || value.state === 'failed' ||
    value.state === 'cancelled' || value.state === 'interrupted'
    ? value.state
    : 'claimed'
  const createdAt = finiteNumber(value.createdAt, Date.now())
  return {
    key: value.key.trim().slice(0, 200),
    taskId: value.taskId.trim().slice(0, 200),
    tool: value.tool.trim().slice(0, 120),
    state,
    destructive: value.destructive === true,
    createdAt,
    updatedAt: finiteNumber(value.updatedAt, createdAt)
  }
}

function copyEntry(entry: IdempotencyEntry): IdempotencyEntry {
  return { ...entry }
}

/**
 * 独立于 TaskCenter 的副作用幂等账本。任务历史可以裁剪或损坏，但已受理的
 * 破坏性 key 必须继续阻止重放；写入失败时调用方必须 fail closed。
 */
export class IdempotencyLedger {
  private readonly entries = new Map<string, IdempotencyEntry>()
  private healthy = true

  constructor(private readonly file: string) {}

  load(): boolean {
    this.entries.clear()
    this.healthy = true
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { version?: unknown; entries?: unknown }
      if (raw?.version !== LEDGER_VERSION || !Array.isArray(raw.entries)) {
        this.preserve('unsupported')
        this.healthy = false
        return false
      }
      if (raw.entries.length > MAX_ENTRIES) {
        this.preserve('partial')
        this.healthy = false
        console.warn(`[aa-browser] 幂等账本超过 ${MAX_ENTRIES} 条安全上限；为避免丢失防重记录，写操作将被拒绝`)
        return false
      }
      let rejected = 0
      for (const item of raw.entries.slice(-MAX_ENTRIES)) {
        const entry = normalizeEntry(item)
        if (!entry) {
          rejected += 1
          continue
        }
        this.entries.set(entry.key, entry)
      }
      if (rejected) {
        this.preserve('partial')
        this.healthy = false
      }
      return this.healthy
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return true
      this.preserve('corrupt')
      this.healthy = false
      return false
    }
  }

  get ready(): boolean {
    return this.healthy
  }

  get(key: string): IdempotencyEntry | undefined {
    const entry = this.entries.get(key.trim())
    return entry ? copyEntry(entry) : undefined
  }

  claim(claim: IdempotencyClaim): IdempotencyEntry {
    if (!this.healthy) throw new IdempotencyStorageError('幂等账本不可用；写操作已拒绝')
    const key = claim.key.trim().slice(0, 200)
    if (!key) throw new IdempotencyStorageError('幂等键为空；写操作已拒绝')
    if (this.entries.size >= MAX_ENTRIES) {
      throw new IdempotencyStorageError(`幂等账本达到 ${MAX_ENTRIES} 条安全上限；写操作已拒绝，请先完成审计与人工归档`)
    }
    const existing = this.entries.get(key)
    if (existing) throw new IdempotencyConflictError(copyEntry(existing))
    const now = Date.now()
    const entry: IdempotencyEntry = {
      key,
      taskId: claim.taskId.trim().slice(0, 200),
      tool: claim.tool.trim().slice(0, 120),
      state: 'claimed',
      destructive: claim.destructive,
      createdAt: now,
      updatedAt: now
    }
    this.entries.set(key, entry)
    try {
      this.flush()
    } catch (error) {
      this.entries.delete(key)
      throw new IdempotencyStorageError(`幂等账本写入失败；写操作未执行: ${error instanceof Error ? error.message : String(error)}`)
    }
    return copyEntry(entry)
  }

  update(key: string, state: IdempotencyState): IdempotencyEntry {
    const normalized = key.trim()
    const entry = this.entries.get(normalized)
    if (!entry) throw new IdempotencyStorageError(`幂等记录不存在: ${normalized}`)
    entry.state = state
    entry.updatedAt = Date.now()
    this.flush()
    return copyEntry(entry)
  }

  /** 合并旧版本任务中心里已有的 idempotencyKey，避免升级后丢失保护。 */
  merge(entries: IdempotencyEntry[]): boolean {
    if (!this.healthy) return false
    const additions = new Map<string, IdempotencyEntry>()
    for (const raw of entries) {
      const entry = normalizeEntry(raw)
      if (!entry || this.entries.has(entry.key)) continue
      additions.set(entry.key, entry)
    }
    if (this.entries.size + additions.size > MAX_ENTRIES) {
      this.healthy = false
      console.warn(`[aa-browser] 合并后的幂等账本超过 ${MAX_ENTRIES} 条安全上限，写操作将被拒绝`)
      return false
    }
    if (!additions.size) return true
    for (const [key, entry] of additions) this.entries.set(key, entry)
    try {
      this.flush()
    } catch (error) {
      this.healthy = false
      console.warn(`[aa-browser] 幂等账本迁移失败: ${error instanceof Error ? error.message : String(error)}`)
    }
    return this.healthy
  }

  private flush(): void {
    const entries = [...this.entries.values()].sort((left, right) => left.updatedAt - right.updatedAt)
    writeJsonAtomic(this.file, { version: LEDGER_VERSION, entries })
  }

  private preserve(label: 'corrupt' | 'unsupported' | 'partial'): void {
    try {
      fs.copyFileSync(this.file, `${this.file}.${label}-${Date.now()}.bak`, fs.constants.COPYFILE_EXCL)
    } catch { /* 保留失败时仍拒绝新的写操作。 */ }
    console.warn(`[aa-browser] 幂等账本${label === 'unsupported' ? '版本不受支持' : label === 'partial' ? '包含无效记录' : '无法读取'}，原文件已保留`)
  }
}
