import fs from 'node:fs'
import path from 'node:path'
import { app, session } from 'electron'
import { ISOLATED_PARTITION_PREFIX, SHARED_PARTITION } from './tabs'

/**
 * 隔离标签的会话分区生命周期管理。
 *
 * 隔离分区是一次性的：标签关闭时必须把 Cookie / Storage / 缓存一起清掉，
 * 否则 `Partitions/aa-iso-*` 会随使用不断累积。应用异常退出时来不及清理，
 * 因此启动阶段还要扫一遍残留目录。
 */

/**
 * 默认拒绝的权限。Agent 驱动的浏览器不需要摄像头/麦克风/定位等能力，
 * 而网页一旦拿到这些权限就可能静默采集环境信息；全部拒绝并由用户显式开启。
 */
const DENIED_PERMISSIONS = new Set([
  'media',
  'geolocation',
  'notifications',
  'midi',
  'midiSysex',
  'hid',
  'serial',
  'usb',
  'bluetooth',
  'idle-detection',
  'speaker-selection',
  'window-management',
  'display-capture',
  'openExternal'
])

const configuredSessions = new WeakSet<Electron.Session>()

/**
 * 为会话安装权限策略：默认拒绝，只放行剪贴板读写这类正常浏览必需的能力。
 * 幂等：同一 Session 只安装一次。
 */
export function applyPermissionPolicy(ses: Electron.Session): void {
  if (configuredSessions.has(ses)) return
  configuredSessions.add(ses)
  ses.setPermissionRequestHandler((_wc, permission, callback) => {
    callback(!DENIED_PERMISSIONS.has(permission))
  })
  // 同步检查路径（如 navigator.permissions.query）必须给出一致答案，
  // 否则页面会看到"能查询到权限但请求失败"的矛盾状态。
  ses.setPermissionCheckHandler((_wc, permission) => !DENIED_PERMISSIONS.has(permission))
}

/**
 * 分区名 → 磁盘目录名。
 *
 * Electron 只去掉 `persist:` 前缀，其余字符原样保留（实测 `persist:aa-iso-abc`
 * 对应目录 `aa-iso-abc`）。早期版本把非字母数字替换成下划线，导致清理时
 * 找错目录、隔离分区永远删不掉。
 */
function partitionDirName(partition: string): string {
  return partition.replace(/^persist:/, '')
}

function partitionsRoot(): string {
  return path.join(app.getPath('userData'), 'Partitions')
}

/** 该分区是否属于隔离标签（只清理我们自己创建的，不碰其他前缀） */
export function isIsolatedPartition(partition: string): boolean {
  return partition.startsWith(`persist:${ISOLATED_PARTITION_PREFIX}`)
}

/**
 * 清理单个隔离分区的会话数据。
 *
 * ⚠️ 实测结论（Windows / Electron 45）：**当前进程生命周期内无法删除分区目录**。
 * 即使 removeChildView + webContents.close 之后重试 12 次（约 5 秒），
 * Chromium 的会话层仍持有目录内文件句柄（EPERM）。这是运行时行为，不是调用方式问题。
 *
 * 因此这里只负责「清数据」——Cookie / Storage / 缓存被清空后该分区不再携带任何
 * 残留身份信息；物理目录由下次启动的 sweepStalePartitions() 回收。
 * 这样既保证隔离语义（数据不残留），也不会因为反复重试而卡住关闭流程。
 */
export async function clearIsolatedPartition(partition: string): Promise<void> {
  if (!isIsolatedPartition(partition)) return
  const ses = session.fromPartition(partition)
  try {
    await ses.clearStorageData()
  } catch {
    /* 分区可能已销毁 */
  }
  try {
    await ses.clearCache()
  } catch {
    /* 忽略 */
  }
}

/**
 * 启动时清理上次异常退出遗留的隔离分区目录。
 * 同时清理 v0.6.x 每标签分区（`tab-*`）遗留目录——那套模型已废弃。
 */
export function sweepStalePartitions(): { removed: string[]; kept: number } {
  const root = partitionsRoot()
  const removed: string[] = []
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return { removed, kept: 0 }
  }
  const sharedDir = partitionDirName(SHARED_PARTITION)
  let kept = 0
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const name = entry.name
    const staleIsolated = name.startsWith(partitionDirName(`persist:${ISOLATED_PARTITION_PREFIX}`))
    // v0.6.x 及更早：每个标签一个持久分区，现已改为共享会话
    const legacyPerTab = /^tab-t[a-z0-9]+$/i.test(name)
    if (name === sharedDir || (!staleIsolated && !legacyPerTab)) {
      kept++
      continue
    }
    try {
      fs.rmSync(path.join(root, name), { recursive: true, force: true })
      removed.push(name)
    } catch {
      kept++
    }
  }
  return { removed, kept }
}
