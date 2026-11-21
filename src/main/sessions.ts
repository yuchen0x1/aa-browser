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

/** 默认拒绝的设备能力与剪贴板读取权限；媒体、定位和通知另走人工审批。 */
const DENIED_PERMISSIONS = new Set([
  'clipboard-read',
  'deprecated-sync-clipboard-read',
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

/** 需要用户明确点头的权限；集合外仍沿用非拒绝即允许的兼容策略。 */
const PROMPT_PERMISSIONS = new Set(['media', 'geolocation', 'geolocation-approximate', 'notifications'])

const PERMISSION_LABELS: Record<string, string> = {
  media: '摄像头 / 麦克风',
  geolocation: '精确位置',
  'geolocation-approximate': '大致位置',
  notifications: '桌面通知'
}

export interface PermissionApprovalMeta {
  site: string
  tabTitle: string
  fieldLabel: string
  detail?: string
  kind: 'permission'
  permission: string
}

export interface PermissionPolicyDeps {
  /** 注入人工审批；未注入时一律拒绝（无人值守的 Agent 不会挂起等待） */
  requestApproval?: (meta: PermissionApprovalMeta) => Promise<boolean>
}

const configuredSessions = new WeakSet<Electron.Session>()
/** 每个 Session 的已授权记录：origin -> permissions。隔离分区只在内存里，进程结束即失效。 */
const grants = new WeakMap<Electron.Session, Map<string, Set<string>>>()

function originOf(url: string): string {
  try {
    return new URL(url).origin
  } catch {
    return url || '(未知站点)'
  }
}

/**
 * 默认拒绝敏感设备能力和网页脚本读取剪贴板；摄像头/定位/通知走人工审批。
 * 幂等：同一 Session 只安装一次。
 */
export function applyPermissionPolicy(ses: Electron.Session, deps?: PermissionPolicyDeps): void {
  if (configuredSessions.has(ses)) return
  configuredSessions.add(ses)
  const sessionGrants = new Map<string, Set<string>>()
  grants.set(ses, sessionGrants)

  // 审批只能在同一 Session、WebContents 和文档生命周期内合并。
  // 已完成的授权仍按 Session + origin 保存，保持同站点的原有授权行为。
  const requestContexts = new WeakMap<Electron.WebContents, {
    generation: number
    pendingPrompts: Map<string, Promise<boolean>>
  }>()

  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    if (!PROMPT_PERMISSIONS.has(permission)) {
      callback(!DENIED_PERMISSIONS.has(permission))
      return
    }
    if (wc.isDestroyed()) {
      callback(false)
      return
    }
    // Electron 的请求是 mediaTypes[]，检查才是单数 mediaType。
    const media = details as Electron.MediaAccessPermissionRequest
    const mediaTypes = permission === 'media' ? [...new Set(media?.mediaTypes ?? [])].sort() : []
    if (permission === 'media' && (!mediaTypes.length || mediaTypes.some((type) => type !== 'audio' && type !== 'video'))) {
      callback(false)
      return
    }
    const requested = permission === 'media' ? mediaTypes.map((type) => `media:${type}`) : [permission]
    const site = originOf(String((permission === 'media' && media?.securityOrigin) || details?.requestingUrl || wc.getURL() || ''))
    if (requested.every((scope) => sessionGrants.get(site)?.has(scope))) {
      callback(true)
      return
    }
    const requestApproval = deps?.requestApproval
    if (!requestApproval) {
      callback(false)
      return
    }
    let context = requestContexts.get(wc)
    if (!context) {
      const created = { generation: 0, pendingPrompts: new Map<string, Promise<boolean>>() }
      context = created
      requestContexts.set(wc, created)
      const invalidate = (): void => {
        created.generation++
        created.pendingPrompts.clear()
      }
      const onNavigate = (details: Electron.WebContentsDidStartNavigationEventParams): void => {
        // PermissionRequest 没有 frame ID；任何换文档导航都使未完成审批失效。
        // 不能只比较 URL，否则同 URL 的刷新或离开后返回仍会复用旧审批。
        if (!details.isSameDocument) invalidate()
      }
      wc.on('did-start-navigation', onNavigate)
      wc.on('render-process-gone', invalidate)
      wc.once('destroyed', () => {
        invalidate()
        wc.removeListener('did-start-navigation', onNavigate)
        wc.removeListener('render-process-gone', invalidate)
        requestContexts.delete(wc)
      })
    }
    const { generation, pendingPrompts } = context
    const isCurrent = (): boolean => !wc.isDestroyed() && context.generation === generation
    const respond = (allowed: boolean): void => {
      const approved = allowed === true && isCurrent()
      if (approved) {
        const set = sessionGrants.get(site) ?? new Set<string>()
        for (const scope of requested) set.add(scope)
        sessionGrants.set(site, set)
      }
      // 逐个回调前重新验证；即使共享审批，也不能批准已销毁/已导航的请求。
      try {
        callback(approved)
      } catch {
        /* Electron 可能已在销毁过程中移除了原生请求。 */
      }
    }
    const key = JSON.stringify([site, ...requested])
    const existing = pendingPrompts.get(key)
    if (existing) {
      void existing.then(respond)
      return
    }
    const label = permission === 'media'
      ? mediaTypes.map((type) => type === 'audio' ? '麦克风' : '摄像头').join(' / ')
      : PERMISSION_LABELS[permission] ?? permission
    const meta: PermissionApprovalMeta = {
      site,
      tabTitle: wc.getTitle() || site,
      fieldLabel: `允许使用${label}`,
      detail: mediaTypes.length ? `权限类型: ${permission} · ${mediaTypes.join(', ')}` : `权限类型: ${permission}`,
      kind: 'permission',
      permission
    }
    // 同步抛错、拒绝和超时都不授权；只接受明确的 true。
    const prompt = Promise.resolve()
      .then(() => isCurrent() ? requestApproval(meta) : false)
      .then((allowed) => allowed === true, () => false)
      .then((allowed) => {
        // 旧文档的完成不能删掉新文档刚发起的同 key 审批。
        if (pendingPrompts.get(key) === prompt) pendingPrompts.delete(key)
        return allowed
      })
    pendingPrompts.set(key, prompt)
    void prompt.then(respond)
  })

  // 同步检查路径（如 navigator.permissions.query）必须给出一致答案，
  // 否则页面会看到"能查询到权限但请求失败"的矛盾状态。
  ses.setPermissionCheckHandler((wc, permission, requestingOrigin, details) => {
    if (!PROMPT_PERMISSIONS.has(permission)) return !DENIED_PERMISSIONS.has(permission)
    const site = originOf(String((permission === 'media' && details?.securityOrigin) || requestingOrigin || wc?.getURL() || ''))
    if (permission === 'media') {
      const mediaType = details?.mediaType
      if (mediaType !== 'audio' && mediaType !== 'video') return false
      return sessionGrants.get(site)?.has(`media:${mediaType}`) ?? false
    }
    return sessionGrants.get(site)?.has(permission) ?? false
  })
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
