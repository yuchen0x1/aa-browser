import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { writeJsonAtomic } from './atomic-json'

/**
 * 证据文件（截图 / HAR / PDF / 视觉基线 / 差异图 / 上下文菜单截图）的生命周期管理。
 *
 * - 每次写入后登记：路径、大小、sha256、文件身份、时间、TTL
 * - 启动时与定时 sweep：按 TTL / 总配额清理最旧且仍匹配的临时证据
 * - 显式导出、基线、下载属于用户数据，不按 TTL / 配额删除
 * - 无所有权标记的历史登记仅供查询，不推断为可清理的临时文件
 */
export type EvidenceKind = 'screenshot' | 'viewport' | 'har' | 'pdf' | 'baseline' | 'diff' | 'download' | 'context-shot'

const IDENTITY_FIELDS = ['dev', 'ino', 'birthtimeNs', 'mtimeNs', 'ctimeNs'] as const
type EvidenceIdentity = Record<(typeof IDENTITY_FIELDS)[number], string>

export interface EvidenceEntry {
  file: string
  kind: EvidenceKind
  bytes: number
  hash: string
  ts: number
  ttlMs: number
  /** 只有明确受管的临时文件才可自动清理；缺省的历史登记保留文件。 */
  managed?: boolean
  /** 写入时的文件身份；字符串避免 inode / 纳秒时间在 JSON 中丢精度。旧登记仍可读取。 */
  identity?: EvidenceIdentity
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
  // 右键「截图保存」写入用户图片目录，不是自动生成的临时文件。
  'context-shot': 0
}
/** 临时证据总配额（超过后删除最旧的）；用户文件不计入配额 */
const EPHEMERAL_QUOTA_BYTES = 500 * 1024 * 1024
/** 刚生成的文件不清理，避免删掉仍在 MCP 结果里引用的图片 */
const GRACE_MS = 60_000
/** 仅限制非受管文件的查询历史，不能因登记数上限而丢失临时文件的清理责任。 */
const MAX_UNMANAGED_ENTRIES = 5000

function isManagedTemporary(entry: EvidenceEntry): boolean {
  return entry.managed === true && DEFAULT_TTL[entry.kind] > 0
}

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

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function isEntry(value: unknown): value is EvidenceEntry {
  if (!isObject(value) || typeof value.file !== 'string' || value.file.includes('\0') ||
      !path.isAbsolute(value.file) || path.resolve(value.file) !== value.file ||
      typeof value.kind !== 'string' || !Object.hasOwn(DEFAULT_TTL, value.kind) ||
      typeof value.bytes !== 'number' || !Number.isSafeInteger(value.bytes) || value.bytes < 0 ||
      typeof value.hash !== 'string' || !/^[a-f0-9]{64}$/i.test(value.hash) ||
      typeof value.ts !== 'number' || !Number.isFinite(value.ts) || value.ts < 0 ||
      typeof value.ttlMs !== 'number' || !Number.isFinite(value.ttlMs) || value.ttlMs < 0 ||
      (value.managed !== undefined && typeof value.managed !== 'boolean')) return false
  const identity = value.identity
  return identity === undefined || (isObject(identity) && IDENTITY_FIELDS.every((key) =>
    typeof identity[key] === 'string' &&
    (key === 'dev' || key === 'ino' ? /^\d+$/ : /^-?\d+$/).test(identity[key])
  ))
}

function matchesFile(entry: EvidenceEntry, stat: fs.BigIntStats): boolean {
  const identity = entry.identity
  return stat.isFile() && stat.size === BigInt(entry.bytes) &&
    (identity === undefined || IDENTITY_FIELDS.every((key) => identity[key] === stat[key].toString()))
}

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

export class EvidenceManager {
  private entries: EvidenceEntry[] = []
  private loaded = false
  private dirty = false
  /** 注册表损坏且无法备份时置位：宁可不写，也不能用空表覆盖原始数据。 */
  private writeBlocked = false

  private load(): void {
    if (this.loaded) return
    this.loaded = true
    const file = registryFile()
    let text: string
    try {
      text = fs.readFileSync(file, 'utf-8')
    } catch (error) {
      if (!isMissing(error)) console.warn(`[evidence] 无法读取登记表 ${file}: ${String(error)}`)
      return
    }
    try {
      const raw: unknown = JSON.parse(text)
      if (!isObject(raw) || !Array.isArray(raw.entries)) throw new Error('unexpected registry shape')
      const unique = new Map<string, EvidenceEntry>()
      for (const entry of raw.entries) {
        if (!isEntry(entry)) continue
        unique.delete(entry.file)
        unique.set(entry.file, entry)
      }
      this.entries = [...unique.values()]
      this.dirty = this.entries.length !== raw.entries.length
    } catch (error) {
      // 首次运行是 ENOENT（上面已返回）；这里只剩真正的损坏。
      // 先保留一份可人工恢复的副本，再以空表继续，否则下一次 record 会覆盖原文件。
      const backup = `${file}.corrupt-${Date.now()}.bak`
      try {
        fs.copyFileSync(file, backup)
        console.warn(`[evidence] 登记表损坏（${String(error)}），已备份到 ${backup}，本次从空表开始`)
      } catch (copyError) {
        this.writeBlocked = true
        console.warn(
          `[evidence] 登记表损坏（${String(error)}），且无法创建备份 ${backup}（${String(copyError)}）；` +
            '为保护原始数据，本次会话不会写入登记表'
        )
      }
    }
  }

  private save(): void {
    this.dirty = true
    if (this.writeBlocked) {
      console.warn('[evidence] 登记表处于只读保护状态，跳过写入')
      return
    }
    try {
      writeJsonAtomic(registryFile(), { version: 1, entries: this.entries })
      this.dirty = false
    } catch {
      /* 登记失败不影响主流程，下次 sweep 再试 */
    }
  }

  /** 文件写完后调用；PDF/HAR 默认视为用户文件，仅自动路径显式传 managed: true。 */
  record(file: string, kind: EvidenceKind, opts?: { hash?: string; ttlMs?: number; managed?: boolean }): EvidenceEntry | null {
    this.load()
    const abs = path.resolve(file)
    const managed = DEFAULT_TTL[kind] > 0 && (opts?.managed ?? (kind !== 'pdf' && kind !== 'har'))
    let entry: EvidenceEntry
    try {
      const stat = fs.lstatSync(abs, { bigint: true })
      if (!stat.isFile()) return null
      entry = {
        file: abs,
        kind,
        bytes: Number(stat.size),
        hash: opts?.hash ?? hashFile(abs),
        ts: Date.now(),
        ttlMs: managed ? opts?.ttlMs ?? DEFAULT_TTL[kind] : 0,
        managed,
        identity: {
          dev: stat.dev.toString(),
          ino: stat.ino.toString(),
          birthtimeNs: stat.birthtimeNs.toString(),
          mtimeNs: stat.mtimeNs.toString(),
          ctimeNs: stat.ctimeNs.toString()
        }
      }
      // 不认领链接、非普通文件，或登记过程中已经被修改 / 替换的文件。
      if (!isEntry(entry) || !matchesFile(entry, fs.lstatSync(abs, { bigint: true }))) return null
    } catch {
      return null
    }
    this.entries = this.entries.filter((e) => e.file !== abs)
    this.entries.push(entry)
    let excess = this.entries.filter((e) => !isManagedTemporary(e)).length - MAX_UNMANAGED_ENTRIES
    if (excess > 0) {
      this.entries = this.entries.filter((e) => {
        if (excess <= 0 || isManagedTemporary(e)) return true
        excess--
        return false
      })
    }
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
    return this.entries.slice(-Math.min(500, Math.max(1, limit))).reverse().map((entry) =>
      isManagedTemporary(entry) ? entry : { ...entry, ttlMs: 0 }
    )
  }

  /** 删除过期 / 超配额的临时证据；返回清理结果。 */
  sweep(now = Date.now()): SweepResult {
    this.load()
    const removed: string[] = []
    let bytesFreed = 0
    const isEphemeral = isManagedTemporary
    const retired = new Set<EvidenceEntry>()
    const attempted = new Set<EvidenceEntry>()

    // 只检查登记路径，不扫描目录。旧临时登记不能凭当前内容相同就补身份后删除。
    for (const entry of this.entries) {
      if (isEphemeral(entry) && !entry.identity) {
        retired.add(entry)
        continue
      }
      try {
        if (!matchesFile(entry, fs.lstatSync(entry.file, { bigint: true }))) retired.add(entry)
      } catch (error) {
        if (isMissing(error)) retired.add(entry)
        else attempted.add(entry) // 无法确认身份（如 EACCES），保留登记供下次重试。
      }
    }

    const remove = (e: EvidenceEntry): void => {
      if (!isEphemeral(e) || retired.has(e) || attempted.has(e)) return
      attempted.add(e)
      try {
        if (!e.identity || !matchesFile(e, fs.lstatSync(e.file, { bigint: true })) ||
            hashFile(e.file) !== e.hash.toLowerCase()) {
          retired.add(e)
          return
        }
        // hash 读取后再次核对，避免把读取期间可观察到的替换 / 修改当作原证据。
        const current = fs.lstatSync(e.file, { bigint: true })
        if (!matchesFile(e, current)) {
          retired.add(e)
          return
        }
        fs.unlinkSync(e.file)
        retired.add(e)
        removed.push(e.file)
        bytesFreed += Number(current.size)
      } catch (error) {
        if (isMissing(error)) retired.add(e)
        // 其他错误不扣配额、不移除登记，也不在同一轮的配额阶段重复尝试。
      }
    }

    for (const entry of this.entries) {
      if (!isEphemeral(entry) || entry.ttlMs <= 0) continue
      if (now - entry.ts > entry.ttlMs && now - entry.ts > GRACE_MS) remove(entry)
    }
    this.entries = this.entries.filter((e) => !retired.has(e))

    let total = this.entries.filter(isEphemeral).reduce((sum, e) => sum + e.bytes, 0)
    const quota = quotaBytes()
    if (total > quota) {
      const oldest = this.entries.filter(isEphemeral).sort((a, b) => a.ts - b.ts)
      for (const entry of oldest) {
        if (total <= quota) break
        if (now - entry.ts < GRACE_MS) continue
        remove(entry)
        // 成功删除或确认不再拥有才从受管配额扣除；只有 unlink 成功计入 bytesFreed。
        if (retired.has(entry)) total -= entry.bytes
      }
      this.entries = this.entries.filter((e) => !retired.has(e))
    }

    const result: SweepResult = { removed, kept: this.entries.length, bytesFreed }
    if (retired.size || this.dirty) this.save()
    return result
  }
}

let manager: EvidenceManager | null = null
export function getEvidenceManager(): EvidenceManager {
  if (!manager) manager = new EvidenceManager()
  return manager
}
