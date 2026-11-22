import fs from 'node:fs'
import path from 'node:path'

/**
 * 更新重启标记。
 *
 * 安装更新会退出整个应用，随后由安装器拉起新实例。MCP 桥在新实例写入
 * connection.json 之前无法连接；如果此时按普通流程自动启动，会和安装器
 * 抢同一个安装目录，甚至拉起旧版本。标记文件让桥明确区分「更新重启」
 * 与「用户正常关闭应用」，前者只等待、不自动启动。
 *
 * 标记与连接发现文件放在同一目录（跟随 AA_BROWSER_CONNECTION_FILE 覆盖），
 * 由旧实例在 before-quit 写入、新实例启动后清除。
 */
export const UPDATE_RESTART_FILE = 'update-restart.json'
/** 超过该时间的标记视为上次安装失败/中断的残留，桥会回退到普通启动流程。 */
export const UPDATE_RESTART_TTL_MS = 10 * 60_000

export interface UpdateRestartMarker {
  reason: 'update'
  at: number
  from?: string
}

export function updateRestartMarkerPath(connectionFile: string): string {
  return path.join(path.dirname(connectionFile), UPDATE_RESTART_FILE)
}

/**
 * 写入标记。同步、尽力而为：它发生在退出路径上，不能因为磁盘错误阻塞更新。
 */
export function writeUpdateRestartMarker(connectionFile: string, from: string): void {
  try {
    fs.writeFileSync(updateRestartMarkerPath(connectionFile), JSON.stringify({ reason: 'update', at: Date.now(), from }))
  } catch {
    /* 退出路径：标记失败只会退化为旧的自动启动行为 */
  }
}

export function clearUpdateRestartMarker(connectionFile: string): void {
  try {
    fs.rmSync(updateRestartMarkerPath(connectionFile), { force: true })
  } catch {
    /* 不存在或不可写 */
  }
}

export function readUpdateRestartMarker(connectionFile: string): UpdateRestartMarker | null {
  try {
    const raw = JSON.parse(fs.readFileSync(updateRestartMarkerPath(connectionFile), 'utf-8')) as Partial<UpdateRestartMarker>
    if (raw?.reason !== 'update' || typeof raw.at !== 'number') return null
    const age = Date.now() - raw.at
    if (age < -60_000 || age > UPDATE_RESTART_TTL_MS) return null
    return { reason: 'update', at: raw.at, ...(typeof raw.from === 'string' ? { from: raw.from } : {}) }
  } catch {
    return null
  }
}
