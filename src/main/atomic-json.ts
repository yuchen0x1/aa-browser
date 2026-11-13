import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

/** 同目录临时文件写完并刷新后再替换，失败时保留原文件。 */
export function writeJsonAtomic(file: string, value: unknown, backupInvalid = false): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${randomUUID()}.tmp`
  let fd: number | undefined
  try {
    fd = fs.openSync(temp, 'wx', 0o600)
    fs.writeFileSync(fd, JSON.stringify(value, null, 2), 'utf8')
    fs.fsyncSync(fd)
    fs.closeSync(fd)
    fd = undefined
    if (backupInvalid && fs.existsSync(file)) {
      fs.copyFileSync(file, `${file}.invalid-${Date.now()}-${randomUUID()}.bak`, fs.constants.COPYFILE_EXCL)
    }
    fs.renameSync(temp, file)
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(temp) } catch { /* 已提交，或临时文件尚未创建 */ }
  }
}
