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
}

/** 与 settings.ts 同目录约定：默认 ~/.aabrowser/extensions.json，测试可用环境变量重定向。 */
function defaultExtensionsFile(): string {
  const home = process.env.HOME || process.env.USERPROFILE || os.homedir()
  if (process.env.AA_BROWSER_SETTINGS_FILE) return path.join(path.dirname(process.env.AA_BROWSER_SETTINGS_FILE), 'extensions.json')
  return path.join(home, '.aabrowser', 'extensions.json')
}

/** 校验目录是一个合法的已解压扩展，返回 manifest 摘要；失败时抛出可读错误。 */
function readManifest(dir: string): { name: string; version: string; manifestVersion: number } {
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
  return { name, version, manifestVersion: mv }
}

/** 读取持久化列表；损坏文件按空列表处理（下次保存覆盖）。 */
function loadPersisted(file: string): string[] {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    if (!Array.isArray(parsed)) return []
    return parsed.filter((p): p is string => typeof p === 'string' && !!p.trim()).slice(0, MAX_EXTENSIONS)
  } catch {
    return []
  }
}

export class ExtensionManager {
  /** 已加载的扩展（含本次会话 load 的与启动时恢复的） */
  private loaded: LoadedExtension[] = []
  private loadedPaths = new Set<string>()
  private file: string

  constructor() {
    this.file = process.env['AA_BROWSER_EXTENSIONS_FILE'] || defaultExtensionsFile()
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
        await this.loadInto(ses, p)
      } catch {
        skipped.push(p)
      }
    }
    if (skipped.length) this.persist()
    return { restored: this.loaded.length, skipped }
  }

  /** 装载一个已解压扩展目录到 Session（幂等：同一路径重复加载返回已有条目）。 */
  private async loadInto(ses: ExtensionsSession, dir: string): Promise<LoadedExtension> {
    const abs = path.resolve(dir)
    if (this.loadedPaths.has(abs)) {
      return this.loaded.find((e) => e.path === abs)!
    }
    let stat: fs.Stats
    try {
      stat = fs.statSync(abs)
    } catch {
      throw new Error(`目录不存在或不可访问：${abs}`)
    }
    if (!stat.isDirectory()) throw new Error(`不是目录：${abs}`)
    const manifest = readManifest(abs)
    const api = ses.extensions
    if (!api?.loadExtension) throw new Error('当前 Electron 版本不支持 session.extensions API。')
    let extId = ''
    try {
      const result = await api.loadExtension(abs, { allowFileAccess: true })
      extId = typeof result === 'string' ? result : String((result as { id?: string })?.id ?? '')
    } catch (error) {
      throw new Error(`扩展加载失败：${error instanceof Error ? error.message : String(error)}`)
    }
    const entry: LoadedExtension = {
      id: extId,
      name: manifest.name,
      version: manifest.version,
      manifestVersion: manifest.manifestVersion,
      path: abs
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
    try {
      ses.extensions?.removeExtension?.(entry.id)
    } catch {
      /* 卸载失败不阻止移除记录：下次启动不再自动装载 */
    }
    this.loaded = this.loaded.filter((e) => e !== entry)
    this.loadedPaths.delete(entry.path)
    this.persist()
    return entry
  }

  list(): ExtensionInfo[] {
    return this.loaded.map((e) => ({ ...e }))
  }

  /** 新目录选择对话框的结果校验：只做 manifest 预检，不装载。 */
  static validateDirectory(dir: string): { name: string; version: string } {
    const manifest = readManifest(dir)
    return { name: manifest.name, version: manifest.version }
  }

  private persist(): void {
    try {
      writeJsonAtomic(this.file, this.loaded.map((e) => e.path), false)
    } catch {
      /* 持久化失败只影响下次启动自动恢复，不阻塞本次使用 */
    }
  }
}

let manager: ExtensionManager | null = null
export function getExtensionManager(): ExtensionManager {
  if (!manager) manager = new ExtensionManager()
  return manager
}
