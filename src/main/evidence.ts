import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { writeJsonAtomic } from './atomic-json'

/**
 * 证据文件（截图 / HAR / PDF / 视觉基线 / 差异图 / 上下文菜单截图）的生命周期管理。
 *
 * - 每次写入后登记：路径、大小、sha256、时间、TTL
 * - 启动时与定时 sweep：按 TTL / 总配额清理最旧的临时证据
 * - 基线、下载属于用户数据，默认不按 TTL 删除，只登记 hash/size
 */
export type EvidenceKind = 'screenshot' | 'viewport' | 'har' | 'pdf' | 'baseline' | 'diff' | 'download' | 'context-shot'

export interface EvidenceEntry {
  file: string
  kind: EvidenceKind
  bytes: number
  hash: string
  ts: number
  ttlMs: number
}

export interface SweepResult {
  removed: string[]
  kept: number
  bytesFreed: number
}

const DAY = 24 * 60 * 60 * 1000
const DEFAULT_TTL: Record<EvidenceKind, number> = {
  screenshot: 7 * DAY,
  viewport: 7 * DAY,
  har: 7 * DAY,
  pdf: 30 * DAY,
  baseline: 0,
  diff: 7 * DAY,
  download: 0,
  'context-shot': 7 * DAY
}
/** 临时证据总配额（超过后删除最旧的）；基线/下载不计入配额 */
const EPHEMERAL_QUOTA_BYTES = 500 * 1024 * 1024
/** 刚生成的文件不清理，避免删掉仍在 MCP 结果里引用的图片 */
const GRACE_MS = 60_000
const MAX_ENTRIES = 5000

function registryFile(): string {
  return process.env['AA_BROWSER_EVIDENCE_FILE'] || path.join(os.homedir(), '.aabrowser', 'evidence-registry.json')
}

/** 测试可用环境变量压低配额，验证淘汰顺序；默认 500MB */
function quotaBytes(): number {
  const override = Number(process.env['AA_BROWSER_EVIDENCE_QUOTA_BYTES'])
  return Number.isFinite(override) && override > 0 ? override : EPHEMERAL_QUOTA_BYTES
}

export function hashFile(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

export class EvidenceManager {
  private entries: EvidenceEntry[] = []
  private loaded = false

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    try {
      const raw = JSON.parse(fs.readFileSync(registryFile(), 'utf-8')) as { entries?: EvidenceEntry[] }
      if (Array.isArray(raw.entries)) this.entries = raw.entries.filter((e) => e && typeof e.file === 'string')
    } catch {
      /* 首次运行或注册表损坏：从空表开始 */
    }
  }

  private save(): void {
    try {
      writeJsonAtomic(registryFile(), { version: 1, entries: this.entries })
    } catch {
      /* 登记失败不影响主流程，下次启动自愈 */
    }
  }

  /** 文件写完后调用；返回登记条目。opts.hash 可复用已算好的 hash。 */
  record(file: string, kind: EvidenceKind, opts?: { hash?: string; ttlMs?: number }): EvidenceEntry | null {
    this.load()
    const abs = path.resolve(file)
    let stat: fs.Stats
    try {
      stat = fs.statSync(abs)
      if (!stat.isFile()) return null
    } catch {
      return null
    }
    const entry: EvidenceEntry = {
      file: abs,
      kind,
      bytes: stat.size,
      hash: opts?.hash ?? hashFile(abs),
      ts: Date.now(),
      ttlMs: opts?.ttlMs ?? DEFAULT_TTL[kind]
    }
    this.entries = this.entries.filter((e) => e.file !== abs)
    this.entries.push(entry)
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES)
    this.save()
    return entry
  }

  forget(file: string): boolean {
    this.load()
    const abs = path.resolve(file)
    const before = this.entries.length
    this.entries = this.entries.filter((e) => e.file !== abs)
    if (this.entries.length === before) return false
    this.save()
    return true
  }

  hash(file: string): string {
    return hashFile(file)
  }

  list(limit = 100): EvidenceEntry[] {
    this.load()
    return this.entries.slice(-Math.min(500, Math.max(1, limit))).reverse()
  }

  /** 删除过期 / 超配额的临时证据；返回清理结果。 */
  sweep(now = Date.now()): SweepResult {
    this.load()
    const removed: string[] = []
    let bytesFreed = 0
    const isEphemeral = (e: EvidenceEntry): boolean => DEFAULT_TTL[e.kind] > 0

    const remove = (e: EvidenceEntry): void => {
      try {
        fs.unlinkSync(e.file)
        removed.push(e.file)
        bytesFreed += e.bytes
      } catch {
        /* 文件已不存在或被占用：下一轮再试 */
      }
    }

    for (const entry of [...this.entries]) {
      if (!isEphemeral(entry) || entry.ttlMs <= 0) continue
      if (now - entry.ts > entry.ttlMs && now - entry.ts > GRACE_MS) remove(entry)
    }
    this.entries = this.entries.filter((e) => fs.existsSync(e.file))

    let total = this.entries.filter(isEphemeral).reduce((sum, e) => sum + e.bytes, 0)
    const quota = quotaBytes()
    if (total > quota) {
      const oldest = this.entries.filter(isEphemeral).sort((a, b) => a.ts - b.ts)
      for (const entry of oldest) {
        if (total <= quota) break
        if (now - entry.ts < GRACE_MS) continue
        remove(entry)
        total -= entry.bytes
      }
      this.entries = this.entries.filter((e) => fs.existsSync(e.file))
    }

    const result: SweepResult = { removed, kept: this.entries.length, bytesFreed }
    if (removed.length) this.save()
    return result
  }
}

let manager: EvidenceManager | null = null
export function getEvidenceManager(): EvidenceManager {
  if (!manager) manager = new EvidenceManager()
  return manager
}
