import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ExtensionInfo } from '@shared/types'
import { writeJsonAtomic } from './atomic-json'

/**
 * 已解压扩展（Load unpacked）的加载与跨会话恢复。
 *
 * Chrome 的「加载已解压的扩展程序」对应 Electron 的 `session.extensions.load`。
 * 扩展加载到共享分区（persist:aa-main），与普通标签共用 Cookie / Storage；
 * 隔离标签的一次性分区不装载扩展，避免把扩展注入到脏会话里。
 *
 * 本模块不 import electron（与 downloads.ts 的 DownloadTracker 一样作为可独立
 * 编译验证的生产模块）；Session 由调用方传入（index.ts / tools.ts）。
 *
 * 已加载的扩展路径持久化到 ~/.aabrowser/extensions.json，下次启动自动重装，
 * 行为对齐 Chrome：重启后「开发者模式」加载的扩展仍然可用。
 */

/** Electron Session.extensions 的最小形状（类型来自运行时，避免 import electron）。 */
interface ExtensionsApi {
  loadExtension: (path: string, options?: { allowFileAccess: boolean }) => Promise<unknown>
  removeExtension: (id: string) => void
}
/** 调用方传入的 Electron.Session 最小形状。 */
export interface ExtensionsSession {
  extensions?: ExtensionsApi
}

const MAX_EXTENSIONS = 20
/** manifest 必须至少有一个入口；MV2 page/background_page 与 MV3 service_worker 都接受。 */
const MIN_MANIFEST_VERSION = 2

export interface LoadedExtension {
  id: string
  name: string
  version: string
  manifestVersion: number
  path: string
  enabled: boolean
  permissions: string[]
  hostPermissions: string[]
  source: 'local-unpacked'
  status: 'running' | 'disabled' | 'stopped' | 'error'
  error?: string
}

/** 与 settings.ts 同目录约定：默认 ~/.aabrowser/extensions.json，测试可用环境变量重定向。 */
function defaultExtensionsFile(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir()
  if (process.env.AA_BROWSER_SETTINGS_FILE) return path.join(path.dirname(process.env.AA_BROWSER_SETTINGS_FILE), 'extensions.json')
  return path.join(home, '.aabrowser', 'extensions.json')
}

/** 校验目录是一个合法的已解压扩展，返回 manifest 摘要；失败时抛出可读错误。 */
function readManifest(dir: string): { name: string; version: string; manifestVersion: number; permissions: string[]; hostPermissions: string[] } {
  let manifestRaw: unknown
  try {
    manifestRaw = JSON.parse(fs.readFileSync(path.join(dir, 'manifest.json'), 'utf8'))
  } catch (error) {
    throw new Error(`目录里没有可读的 manifest.json：${error instanceof Error ? error.message : String(error)}`)
  }
  if (!manifestRaw || typeof manifestRaw !== 'object' || Array.isArray(manifestRaw)) {
    throw new Error('manifest.json 内容不是有效的 JSON 对象。')
  }
  const manifest = manifestRaw as Record<string, unknown>
  const name = typeof manifest.name === 'string' ? manifest.name.trim() : ''
  if (!name) throw new Error('manifest.json 缺少 name 字段。')
  const version = typeof manifest.version === 'string' ? manifest.version.trim() : ''
  if (!version) throw new Error('manifest.json 缺少 version 字段。')
  const mv = typeof manifest['manifest_version'] === 'number' ? manifest['manifest_version'] : 0
  if (mv < MIN_MANIFEST_VERSION || mv > 3) {
    throw new Error(`不支持的 manifest_version: ${mv}（仅支持 2 / 3）。`)
  }
  const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, 200) : []
  return { name, version, manifestVersion: mv, permissions: strings(manifest.permissions), hostPermissions: strings(manifest.host_permissions) }
}

/** 读取持久化列表；损坏文件按空列表处理（下次保存覆盖）。 */
function loadPersisted(file: string): { path: string; enabled: boolean }[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    const record = parsed && typeof parsed === 'object' ? parsed as { version?: unknown; entries?: unknown } : null
    const entries = Array.isArray(parsed) ? parsed : record?.version === 2 && Array.isArray(record.entries) ? record.entries : []
    return entries.map((entry: unknown) => typeof entry === 'string' ? { path: entry, enabled: true } : entry)
      .filter((entry: unknown): entry is { path: string; enabled: boolean } => !!entry && typeof entry === 'object' && typeof (entry as { path?: unknown }).path === 'string' && !!(entry as { path: string }).path.trim())
      .slice(0, MAX_EXTENSIONS).map((entry: { path: string; enabled?: boolean }) => ({ path: entry.path, enabled: entry.enabled !== false }))
  } catch {
    return []
  }
}

export class ExtensionManager {
  /** 已加载的扩展（含本次会话 load 的与启动时恢复的） */
  private loaded: LoadedExtension[] = []
  private loadedPaths = new Set<string>()
  private file: string

  constructor(file?: string) {
    this.file = file || process.env['AA_BROWSER_EXTENSIONS_FILE'] || defaultExtensionsFile()
  }

  get count(): number {
    return this.loaded.length
  }

  /** 启动时调用：把上次会话的扩展路径重新装载到指定 Session。 */
  async restore(ses: ExtensionsSession): Promise<{ restored: number; skipped: string[] }> {
    const paths = loadPersisted(this.file)
    const skipped: string[] = []
    for (const p of paths) {
      try {
        if (p.enabled) {
          const previous = this.loaded.find((entry) => entry.path === path.resolve(p.path) && entry.status === 'stopped')
          if (previous) { this.loaded = this.loaded.filter((entry) => entry !== previous); this.loadedPaths.delete(previous.path) }
          await this.loadInto(ses, p.path)
        }
        else {
          const abs = path.resolve(p.path)
          if (this.loadedPaths.has(abs)) continue
          const manifest = readManifest(abs)
          this.loaded.push({ ...manifest, id: `disabled:${abs}`, path: abs, enabled: false, source: 'local-unpacked', status: 'disabled' })
          this.loadedPaths.add(abs)
        }
      } catch {
        skipped.push(p.path)
        const abs = path.resolve(p.path)
        const previous = this.loaded.find((entry) => entry.path === abs)
        if (previous) { previous.status = 'error'; previous.error = 'Extension initialization failed; verify the local files and permissions.' }
        else {
          this.loaded.push({ id: `error:${abs}`, name: path.basename(abs), version: '?', manifestVersion: 0, path: abs, enabled: p.enabled, permissions: [], hostPermissions: [], source: 'local-unpacked', status: 'error', error: 'Extension initialization failed; verify the local files and permissions.' })
          this.loadedPaths.add(abs)
        }
      }
    }
    return { restored: this.loaded.filter((entry) => entry.status === 'running').length, skipped }
  }

  /** 装载一个已解压扩展目录到 Session（幂等：同一路径重复加载返回已有条目）。 */
  private async loadInto(ses: ExtensionsSession, dir: string): Promise<LoadedExtension> {
    const abs = path.resolve(dir)
    if (this.loadedPaths.has(abs)) {
      const existing = this.loaded.find((e) => e.path === abs)!
      if (existing.status !== 'error') return existing
      this.loaded = this.loaded.filter((entry) => entry !== existing); this.loadedPaths.delete(abs)
    }
    if (this.loaded.length >= MAX_EXTENSIONS) throw new Error('最多安装 20 个扩展。')
    let stat: fs.Stats
    try {
      stat = fs.lstatSync(abs)
    } catch {
      throw new Error(`目录不存在或不可访问：${abs}`)
    }
    if (!stat.isDirectory()) throw new Error(`不是目录：${abs}`)
    if (stat.isSymbolicLink()) throw new Error('不允许从符号链接安装扩展。')
    const manifest = readManifest(abs)
    const api = ses.extensions
    if (!api?.loadExtension) throw new Error('当前 Electron 版本不支持 session.extensions API。')
    let extId = ''
    try {
      const result = await api.loadExtension(abs, { allowFileAccess: false })
      extId = typeof result === 'string' ? result : String((result as { id?: string })?.id ?? '')
    } catch (error) {
      throw new Error(`扩展加载失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const entry: LoadedExtension = {
      id: extId,
      name: manifest.name,
      version: manifest.version,
      manifestVersion: manifest.manifestVersion,
      path: abs,
      enabled: true,
      permissions: manifest.permissions,
      hostPermissions: manifest.hostPermissions,
      source: 'local-unpacked',
      status: 'running'
    }
    this.loaded.push(entry)
    this.loadedPaths.add(abs)
    return entry
  }

  /** 供 UI / MCP 调用：装载到共享分区并持久化。 */
  async load(ses: ExtensionsSession, dir: string): Promise<LoadedExtension> {
    const entry = await this.loadInto(ses, dir)
    this.persist()
    return entry
  }

  /** 卸载并从持久化列表移除；按路径或扩展 id 匹配。 */
  remove(ses: ExtensionsSession, key: string): LoadedExtension {
    const entry = this.loaded.find((e) => e.path === path.resolve(key) || e.id === key)
    if (!entry) throw new Error(`未找到该扩展：${key}`)
    if (entry.enabled && entry.status === 'running') ses.extensions?.removeExtension?.(entry.id)
    this.loaded = this.loaded.filter((e) => e !== entry)
    this.loadedPaths.delete(entry.path)
    this.persist()
    return entry
  }

  list(): ExtensionInfo[] {
    return this.loaded.map((e) => ({ ...e, permissions: [...e.permissions], hostPermissions: [...e.hostPermissions] }))
  }

  async setEnabled(ses: ExtensionsSession, key: string, enabled: boolean): Promise<LoadedExtension> {
    const entry = this.loaded.find((item) => item.id === key || item.path === path.resolve(key))
    if (!entry) throw new Error('未找到该扩展。')
    if (entry.enabled === enabled) return { ...entry }
    if (!enabled) {
      if (!ses.extensions?.removeExtension) throw new Error('会话不支持卸载扩展。')
      if (entry.status === 'running') ses.extensions.removeExtension(entry.id)
      entry.enabled = false; entry.status = 'disabled'
    } else {
      const index = this.loaded.indexOf(entry)
      this.loaded = this.loaded.filter((item) => item !== entry); this.loadedPaths.delete(entry.path)
      try {
        const loaded = await this.loadInto(ses, entry.path)
        this.loaded.splice(this.loaded.indexOf(loaded), 1); this.loaded.splice(index, 0, loaded)
        this.persist(); return { ...loaded }
      } catch (error) { this.loaded.splice(index, 0, entry); this.loadedPaths.add(entry.path); throw error }
    }
    this.persist()
    return { ...entry }
  }

  suspend(ses: ExtensionsSession): void {
    for (const entry of this.loaded) {
      if (!entry.enabled || entry.status !== 'running') continue
      if (!ses.extensions?.removeExtension) throw new Error('会话不支持卸载扩展。')
      ses.extensions.removeExtension(entry.id)
      entry.status = 'stopped'
    }
  }

  checkUpdates(): { id: string; installedVersion: string; localVersion?: string; changed: boolean; error?: string }[] {
    return this.loaded.map((entry) => {
      try { const localVersion = readManifest(entry.path).version; return { id: entry.id, installedVersion: entry.version, localVersion, changed: localVersion !== entry.version } }
      catch { return { id: entry.id, installedVersion: entry.version, changed: false, error: 'Local extension manifest unavailable' } }
    })
  }

  /** 新目录选择对话框的结果校验：只做 manifest 预检，不装载。 */
  static validateDirectory(dir: string): { name: string; version: string } {
    const manifest = readManifest(dir)
    return { name: manifest.name, version: manifest.version }
  }

  private persist(): void {
    try {
      const entries = this.loaded.map((e) => ({ path: e.path, enabled: e.enabled }))
      writeJsonAtomic(this.file, entries.every((entry) => entry.enabled) ? entries.map((entry) => entry.path) : { version: 2, entries }, false)
    } catch {
      /* 持久化失败只影响下次启动自动恢复，不阻塞本次使用 */
    }
  }
}

const managers = new Map<string, ExtensionManager>()
let profileProvider = (): string => 'default'
let profileFileProvider: ((id: string) => string) | undefined
export function configureExtensionProfiles(current: () => string, fileFor: (id: string) => string): void { profileProvider = current; profileFileProvider = fileFor }
export function getExtensionManager(profileId = profileProvider()): ExtensionManager {
  if (!/^(?:default|p[a-f0-9]{24})$/.test(profileId)) throw new Error('Invalid extension profile')
  const file = profileFileProvider?.(profileId) ?? (profileId === 'default' ? process.env['AA_BROWSER_EXTENSIONS_FILE'] || defaultExtensionsFile() : path.join(path.dirname(defaultExtensionsFile()), 'profiles', profileId, 'extensions', 'registry.json'))
  let manager = managers.get(file)
  if (!manager) { manager = new ExtensionManager(file); managers.set(file, manager) }
  return manager
}
