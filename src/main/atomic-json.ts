import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** 同目录临时文件写完并刷新后再替换，失败时保留原文件。 */
export function writeJsonAtomic(file: string, value: unknown, backupInvalid = false): void {
  writeFileAtomic(file, JSON.stringify(value, null, 2), backupInvalid)
}

const RENAME_RETRY_DELAYS_MS = [10, 25, 50, 100]
const sleepBuffer = new Int32Array(new SharedArrayBuffer(4))

/**
 * Windows 上杀毒软件或索引器短暂占用目标文件时，rename 可能返回
 * EPERM/EACCES/EBUSY。延迟重试有界次数；最终失败仍保留原文件并向上抛出。
 */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt += 1) {
    try {
      fs.renameSync(from, to)
      return
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      const retryable = code === 'EPERM' || code === 'EACCES' || code === 'EBUSY'
      if (!retryable || attempt >= RENAME_RETRY_DELAYS_MS.length) throw error
      Atomics.wait(sleepBuffer, 0, 0, RENAME_RETRY_DELAYS_MS[attempt])
    }
  }
}

export function writeFileAtomic(file: string, value: string | Buffer, backupInvalid = false): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = fs.openSync(temp, 'wx', 0o600)
    fs.writeFileSync(fd, value)
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    if (backupInvalid && fs.existsSync(file)) {
      fs.copyFileSync(file, `${file}.invalid-${Date.now()}-${randomUUID()}.bak`, fs.constants.COPYFILE_EXCL)
    }
    renameWithRetry(temp, file)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(temp) } catch { /* 已提交，或临时文件尚未创建 */ }
  }
}
