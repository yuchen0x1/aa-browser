import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomBytes, scryptSync, createCipheriv, createDecipheriv } from 'node:crypto'
import { app, session } from 'electron'
import type { Session } from 'electron'
import { writeJsonAtomic } from './atomic-json'

export const DEFAULT_PROFILE_ID = 'default'
const PROFILE_ID = /^(?:default|p[a-f0-9]{24})$/
const MAX_ARCHIVE_BYTES = 128 * 1024 * 1024
export type ProfileDirectory = 'downloads' | 'history' | 'screenshots' | 'har' | 'baselines' | 'extensions' | 'files'
export interface BrowserProfile {
  id: string
  name: string
  description: string
  icon: string
  color: string
  createdAt: number
  updatedAt: number
}
export interface ProfileInfo extends BrowserProfile { running: boolean; isDefault: boolean; leased: boolean }
interface Registry { version: 1; defaultId: string; profiles: BrowserProfile[]; deleted: string[] }
interface ProfileOptions {
  filePath?: string
  dataRoot?: string
  sessionDataRoot?: string
  sessionProvider?: (partition: string) => Session
}
interface ArchiveFile { area: 'session' | 'data'; name: string; data: string }
interface ProfileArchive { version: 1; profile: BrowserProfile; files: ArchiveFile[] }
const context = new AsyncLocalStorage<string>()
const leaseContext = new AsyncLocalStorage<{ profileId: string; taskId: string }>()

function safeId(id: string): string {
  if (typeof id !== 'string' || !PROFILE_ID.test(id)) throw new Error('PROFILE_INVALID_ID: Invalid profile identifier')
  return id
}
function hasControlCharacters(value: string): boolean {
  for (const character of value) if (character.charCodeAt(0) < 32) return true
  return false
}
function boundedText(value: unknown, limit: number, fallback = ''): string {
  if (value === undefined) return fallback
  if (typeof value !== 'string' || value.length > limit || hasControlCharacters(value)) throw new Error('PROFILE_INVALID_METADATA: Invalid profile text')
  return value.trim()
}
function metadata(value: Partial<BrowserProfile>, previous?: BrowserProfile): BrowserProfile {
  const name = boundedText(value.name, 80, previous?.name ?? '')
  if (!name) throw new Error('PROFILE_INVALID_METADATA: A profile name is required')
  const color = boundedText(value.color, 7, previous?.color ?? '#36b5a0')
  if (!/^#[a-f0-9]{6}$/i.test(color)) throw new Error('PROFILE_INVALID_METADATA: Invalid color')
  return {
    id: previous?.id ?? `p${randomBytes(12).toString('hex')}`, name,
    description: boundedText(value.description, 1000, previous?.description),
    icon: boundedText(value.icon, 32, previous?.icon ?? 'user'), color,
    createdAt: previous?.createdAt ?? Date.now(), updatedAt: Date.now()
  }
}
function contained(root: string, target: string): boolean {
  const relative = path.relative(root, target)
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)
}
function assertNoLinks(target: string): void {
  for (let current = path.resolve(target);;) {
    try { if (fs.lstatSync(current).isSymbolicLink()) throw new Error('PROFILE_UNSAFE_PATH: Symbolic links are not allowed') }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
}

export class ProfileManager {
  readonly dataRoot: string
  readonly filePath: string
  private registry: Registry
  private sessions = new Map<string, Session>()
  private running = new Set<string>()
  private starting = new Map<string, Promise<ProfileInfo>>()
  private stopping = new Map<string, Promise<void>>()
  private removing = new Set<string>()
  private clients = new Map<number, string>()
  private leases = new Map<string, { taskId: string; holders: number }>()
  private activeUses = new Map<string, number>()
  private deleting = new Set<string>()
  private archiving = new Set<string>()
  private provider: (partition: string) => Session
  private sessionRoot: () => string
  onChange: (() => void) | null = null
  onStop: ((id: string) => Promise<void> | void) | null = null
  onSession: ((ses: Session, id: string) => Promise<void> | void) | null = null

  constructor(options: ProfileOptions = {}) {
    this.dataRoot = path.resolve(options.dataRoot ?? process.env.AA_BROWSER_DATA_DIR ?? (process.env.AA_BROWSER_SETTINGS_FILE ? path.dirname(process.env.AA_BROWSER_SETTINGS_FILE) : path.join(os.homedir(), '.aabrowser')))
    this.filePath = options.filePath ?? process.env.AA_BROWSER_PROFILES_FILE ?? path.join(this.dataRoot, 'profiles.json')
    this.provider = options.sessionProvider ?? ((partition) => session.fromPartition(partition))
    const sessionDataRoot = options.sessionDataRoot
    this.sessionRoot = sessionDataRoot ? () => path.resolve(sessionDataRoot) : () => path.join(app.getPath('userData'), 'Partitions')
    const original: BrowserProfile = { id: DEFAULT_PROFILE_ID, name: 'Default', description: '', icon: 'user', color: '#36b5a0', createdAt: Date.now(), updatedAt: Date.now() }
    this.registry = { version: 1, defaultId: DEFAULT_PROFILE_ID, profiles: [original], deleted: [] }
    if (!fs.existsSync(this.filePath)) return
    let raw: unknown
    try { raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8')) } catch { throw new Error('PROFILE_REGISTRY_CORRUPT: Registry preserved; restore a valid backup before opening profiles') }
    const record = raw as Registry
    if (record?.version !== 1 || !Array.isArray(record.profiles) || record.profiles.length > 100 || !Array.isArray(record.deleted)) throw new Error('PROFILE_REGISTRY_CORRUPT: Unsupported registry; original file preserved')
    const ids = new Set<string>()
    for (const item of record.profiles) {
      safeId(item.id)
      if (ids.has(item.id)) throw new Error('PROFILE_REGISTRY_CORRUPT: Duplicate profile identifier')
      ids.add(item.id)
      metadata(item, item)
      if (!Number.isFinite(item.createdAt) || !Number.isFinite(item.updatedAt)) throw new Error('PROFILE_REGISTRY_CORRUPT: Invalid timestamp')
    }
    if (!ids.has(DEFAULT_PROFILE_ID) || !ids.has(record.defaultId)) throw new Error('PROFILE_REGISTRY_CORRUPT: Missing default profile')
    for (const id of record.deleted) if (safeId(id) === DEFAULT_PROFILE_ID || ids.has(id)) throw new Error('PROFILE_REGISTRY_CORRUPT: Invalid deletion record')
    this.registry = record
  }

  private notify(): void { try { this.onChange?.() } catch { /* UI notifications do not roll back committed data. */ } }
  private persist(next: Registry): void { assertNoLinks(this.filePath); writeJsonAtomic(this.filePath, next); this.registry = next; this.notify() }
  private info(id: string): ProfileInfo { return { ...this.get(id), running: this.running.has(id), isDefault: id === this.defaultId, leased: this.leases.has(id) } }
  private assertAvailable(id: string): void {
    this.get(id)
    if (this.archiving.has(id) || this.removing.has(id) || this.stopping.has(id)) throw new Error('PROFILE_BUSY: The profile is stopping, being removed or backed up')
  }
  get defaultId(): string { return this.registry.defaultId }
  currentProfileId(): string { return context.getStore() ?? this.defaultId }
  hasContext(): boolean { return context.getStore() !== undefined }
  runWithProfile<T>(id: string, operation: () => T): T { this.get(id); return context.run(id, operation) }
  runWithoutProfile<T>(operation: () => T): T { return context.exit(operation) }
  get(id = this.currentProfileId()): BrowserProfile {
    safeId(id)
    const found = this.registry.profiles.find((profile) => profile.id === id)
    if (!found || this.deleting.has(id)) throw new Error('PROFILE_NOT_FOUND: Profile does not exist')
    return { ...found }
  }
  list(): ProfileInfo[] { return this.registry.profiles.map((profile) => ({ ...profile, running: this.running.has(profile.id), isDefault: profile.id === this.defaultId, leased: this.leases.has(profile.id) })) }
  create(value: Partial<BrowserProfile>): BrowserProfile {
    if (this.registry.profiles.length >= 100) throw new Error('PROFILE_LIMIT: At most 100 profiles are supported')
    const profile = metadata(value)
    this.persist({ ...this.registry, profiles: [...this.registry.profiles, profile] })
    return { ...profile }
  }
  update(id: string, value: Partial<BrowserProfile>): BrowserProfile {
    const profile = metadata(value, this.get(id))
    this.persist({ ...this.registry, profiles: this.registry.profiles.map((item) => item.id === id ? profile : item) })
    return { ...profile }
  }
  setDefault(id: string): void { this.get(id); this.persist({ ...this.registry, defaultId: id }) }
  partitionFor(id = this.currentProfileId()): string { this.get(id); return id === DEFAULT_PROFILE_ID ? 'persist:aa-main' : `persist:aa-profile-${id}` }
  directory(id: string, kind: ProfileDirectory): string {
    this.get(id)
    if (!['downloads', 'history', 'screenshots', 'har', 'baselines', 'extensions', 'files'].includes(kind)) throw new Error('PROFILE_INVALID_DIRECTORY')
    if (id === DEFAULT_PROFILE_ID) {
      const overrides: Partial<Record<ProfileDirectory, string | undefined>> = { downloads: process.env.AA_BROWSER_DOWNLOAD_DIR, history: process.env.AA_BROWSER_HISTORY_DIR, screenshots: process.env.AA_BROWSER_SCREENSHOT_DIR, har: process.env.AA_BROWSER_HAR_DIR, baselines: process.env.AA_BROWSER_BASELINE_DIR }
      return path.resolve(overrides[kind] || path.join(this.dataRoot, kind))
    }
    return path.join(this.dataRoot, 'profiles', safeId(id), kind)
  }
  sessionFor(id = this.currentProfileId()): Session {
    this.get(id)
    if (this.archiving.has(id)) throw new Error('PROFILE_BUSY: An offline backup is in progress')
    let ses = this.sessions.get(id)
    if (!ses) {
      assertNoLinks(path.join(this.sessionRoot(), id === DEFAULT_PROFILE_ID ? 'aa-main' : `aa-profile-${id}`))
      ses = this.provider(this.partitionFor(id)); this.sessions.set(id, ses)
    }
    return ses
  }
  existingSession(id = this.currentProfileId()): Session | undefined { this.get(id); return this.sessions.get(id) }
  profileForSession(ses: Session): string | undefined { for (const [id, candidate] of this.sessions) if (candidate === ses) return id; return undefined }
  async start(id = this.currentProfileId()): Promise<ProfileInfo> {
    this.assertLeaseAccess(id)
    if (this.running.has(id)) return this.info(id)
    const pending = this.starting.get(id)
    if (pending) return pending
    const ses = this.sessionFor(id)
    const work = Promise.resolve().then(async () => {
      await this.onSession?.(ses, id)
      this.running.add(id); this.notify()
      return this.info(id)
    }).finally(() => { this.starting.delete(id) })
    this.starting.set(id, work)
    return work
  }
  async stop(id: string): Promise<void> {
    this.get(id)
    const pending = this.stopping.get(id)
    if (pending) return pending
    if (this.archiving.has(id)) throw new Error('PROFILE_BUSY: An offline backup is in progress')
    if (this.leases.has(id)) throw new Error('PROFILE_BUSY: A task holds this profile')
    if (this.activeUses.has(id)) throw new Error('PROFILE_BUSY: Browser operations are still using this profile')
    const work = Promise.resolve().then(async () => {
      await this.starting.get(id)
      await this.onStop?.(id)
      await this.sessions.get(id)?.flushStorageData()
      await this.sessions.get(id)?.closeAllConnections()
      this.running.delete(id); this.notify()
    }).finally(() => { this.stopping.delete(id) })
    this.stopping.set(id, work)
    return work
  }
  bindClient(clientId: number, id: string): void { this.get(id); this.clients.set(clientId, id) }
  clientProfile(clientId: number): string { return this.clients.get(clientId) ?? this.defaultId }
  releaseClient(clientId: number): void { this.clients.delete(clientId) }
  acquireLease(id: string, taskId: string): () => void {
    this.assertAvailable(id)
    if (this.activeUses.has(id)) throw new Error('PROFILE_BUSY: Browser operations are still using this profile')
    let lease = this.leases.get(id)
    if (!taskId || (lease && lease.taskId !== taskId)) throw new Error('PROFILE_BUSY: Another task owns this profile')
    if (lease) lease.holders++
    else { lease = { taskId, holders: 1 }; this.leases.set(id, lease) }
    this.notify()
    let released = false
    return () => {
      if (released) return
      released = true
      if (this.leases.get(id) === lease && --lease.holders === 0) { this.leases.delete(id); this.notify() }
    }
  }
  releaseLease(id: string, taskId: string): void { if (this.leases.get(id)?.taskId === taskId) { this.leases.delete(id); this.notify() } }
  assertLeaseAccess(id: string): void {
    this.assertAvailable(id)
    const owner = this.leases.get(id)
    const caller = leaseContext.getStore()
    if (owner && (caller?.profileId !== id || caller.taskId !== owner.taskId)) throw new Error('PROFILE_BUSY: Another workflow owns this profile')
  }
  async withUse<T>(id: string, operation: () => T | Promise<T>): Promise<T> {
    this.assertLeaseAccess(id)
    const external = !this.leases.has(id)
    if (external) this.activeUses.set(id, (this.activeUses.get(id) ?? 0) + 1)
    try { return await operation() }
    finally {
      if (external) {
        const count = (this.activeUses.get(id) ?? 1) - 1
        if (count > 0) this.activeUses.set(id, count)
        else this.activeUses.delete(id)
      }
    }
  }
  runWithLease<T>(id: string, taskId: string, operation: () => T): T {
    if (this.leases.get(id)?.taskId !== taskId) throw new Error('PROFILE_LEASE_REQUIRED: Acquire the workflow lease before execution')
    return leaseContext.run({ profileId: id, taskId }, () => this.runWithProfile(id, operation))
  }
  async remove(id: string): Promise<void> {
    this.get(id)
    if (id === DEFAULT_PROFILE_ID) throw new Error('PROFILE_PROTECTED: Legacy default profile cannot be deleted')
    if (this.removing.has(id)) throw new Error('PROFILE_BUSY: Profile removal is in progress')
    this.removing.add(id)
    try {
      await this.stop(id)
      this.deleting.add(id)
      const ses = this.sessionForDeleted(id)
      await ses.clearStorageData(); await ses.clearCache(); await ses.closeAllConnections()
      this.persist({ ...this.registry, defaultId: this.defaultId === id ? DEFAULT_PROFILE_ID : this.defaultId, profiles: this.registry.profiles.filter((profile) => profile.id !== id), deleted: [...this.registry.deleted, id] })
      for (const [client, bound] of this.clients) if (bound === id) this.clients.delete(client)
    } finally { this.deleting.delete(id); this.removing.delete(id) }
  }
  private sessionForDeleted(id: string): Session {
    let ses = this.sessions.get(id)
    if (!ses) {
      assertNoLinks(path.join(this.sessionRoot(), `aa-profile-${safeId(id)}`))
      ses = this.provider(`persist:aa-profile-${id}`); this.sessions.set(id, ses)
    }
    return ses
  }
  /** Run before any profile Session is initialized; Chromium keeps files locked after tabs close. */
  async sweepDeleted(): Promise<number> {
    let removed = 0
    const remaining: string[] = []
    for (const id of this.registry.deleted) {
      if (this.sessions.has(id)) { remaining.push(id); continue }
      try {
        for (const [root, target] of [[this.sessionRoot(), path.join(this.sessionRoot(), `aa-profile-${safeId(id)}`)], [path.join(this.dataRoot, 'profiles'), path.join(this.dataRoot, 'profiles', id)]]) {
          if (!contained(path.resolve(root), path.resolve(target))) throw new Error('PROFILE_INVALID_PATH')
          assertNoLinks(target)
          await fs.promises.rm(target, { recursive: true, force: true })
        }
        removed++
      } catch { remaining.push(id) }
    }
    if (removed) this.persist({ ...this.registry, deleted: remaining })
    return removed
  }
  private assertOffline(id: string): void {
    this.assertAvailable(id)
    if (this.sessions.has(id) || this.running.has(id) || this.leases.has(id) || this.activeUses.has(id)) throw new Error('PROFILE_OFFLINE_REQUIRED: Restart and export before starting this profile; copying an active Chromium database is unsafe')
    if (id === DEFAULT_PROFILE_ID) throw new Error('PROFILE_LEGACY_BACKUP: Legacy profile uses shared application paths; close the app and back up userData plus .aabrowser together')
  }
  async exportProfile(id: string, passphrase: string): Promise<string> {
    this.assertOffline(id)
    if (typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024) throw new Error('PROFILE_BACKUP_PASSWORD: Use a passphrase of 12 to 1024 characters')
    if (this.archiving.has(id)) throw new Error('PROFILE_BUSY: An offline backup is in progress')
    this.archiving.add(id)
    try {
    const files: ArchiveFile[] = []; let bytes = 0
    for (const [area, root] of [['session', path.join(this.sessionRoot(), `aa-profile-${id}`)], ['data', path.join(this.dataRoot, 'profiles', id)]] as const) {
      const walk = async (dir: string): Promise<void> => {
        if (!fs.existsSync(dir)) return
        assertNoLinks(dir)
        for (const entry of await fs.promises.readdir(dir, { withFileTypes: true })) {
          const file = path.join(dir, entry.name)
          if (entry.isSymbolicLink()) throw new Error('PROFILE_UNSAFE_PATH: Backup cannot include symbolic links')
          if (entry.isDirectory()) await walk(file)
          else if (entry.isFile()) {
            if (/^(?:Singleton|LOCK|lockfile)/i.test(entry.name)) continue
            const stat = await fs.promises.stat(file); bytes += stat.size
            if (bytes > MAX_ARCHIVE_BYTES || files.length >= 10000) throw new Error('PROFILE_BACKUP_LIMIT: Backup exceeds 128 MiB or 10000 files')
            files.push({ area, name: path.relative(root, file).split(path.sep).join('/'), data: (await fs.promises.readFile(file)).toString('base64') })
          }
        }
      }
      await walk(root)
    }
    const salt = randomBytes(16); const iv = randomBytes(12)
    const key = scryptSync(passphrase, salt, 32); const cipher = createCipheriv('aes-256-gcm', key, iv)
    const archive: ProfileArchive = { version: 1, profile: this.get(id), files }
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(archive), 'utf8'), cipher.final()]); key.fill(0)
    return JSON.stringify({ version: 1, cipher: 'aes-256-gcm', salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: encrypted.toString('base64') })
    } finally { this.archiving.delete(id) }
  }
  async importProfile(input: string, passphrase: string, name?: string): Promise<BrowserProfile> {
    if (typeof input !== 'string' || Buffer.byteLength(input) > MAX_ARCHIVE_BYTES * 2 || typeof passphrase !== 'string' || passphrase.length < 12 || passphrase.length > 1024) throw new Error('PROFILE_BACKUP_INVALID')
    let archive: ProfileArchive
    try {
      const envelope = JSON.parse(input)
      if (envelope.version !== 1 || envelope.cipher !== 'aes-256-gcm') throw new Error('format')
      const salt = Buffer.from(envelope.salt, 'base64'); const iv = Buffer.from(envelope.iv, 'base64'); const tag = Buffer.from(envelope.tag, 'base64')
      if (salt.length !== 16 || iv.length !== 12 || tag.length !== 16) throw new Error('format')
      const key = scryptSync(passphrase, salt, 32)
      try { const decipher = createDecipheriv('aes-256-gcm', key, iv); decipher.setAuthTag(tag); archive = JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64')), decipher.final()]).toString('utf8')) } finally { key.fill(0) }
    } catch { throw new Error('PROFILE_BACKUP_INVALID: Password or authenticated archive is invalid') }
    if (archive.version !== 1 || !Array.isArray(archive.files) || archive.files.length > 10000) throw new Error('PROFILE_BACKUP_INVALID')
    if (this.registry.profiles.length >= 100) throw new Error('PROFILE_LIMIT')
    const profile = metadata({ ...archive.profile, name: name ?? archive.profile.name })
    const sessionDir = path.join(this.sessionRoot(), `aa-profile-${profile.id}`); const dataDir = path.join(this.dataRoot, 'profiles', profile.id)
    let bytes = 0; const seen = new Set<string>()
    for (const file of archive.files) {
      if (!file || !['session', 'data'].includes(file.area) || typeof file.name !== 'string' || !file.name || file.name.includes('\\') || file.name.includes(':') || file.name.split('/').some((part) => !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/i.test(part)) || hasControlCharacters(file.name) || typeof file.data !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(file.data)) throw new Error('PROFILE_BACKUP_INVALID_PATH')
      const key = `${file.area}/${file.name.toLowerCase()}`
      if (seen.has(key)) throw new Error('PROFILE_BACKUP_INVALID_PATH')
      seen.add(key); bytes += Buffer.byteLength(file.data, 'base64')
      if (bytes > MAX_ARCHIVE_BYTES) throw new Error('PROFILE_BACKUP_LIMIT')
    }
    try {
      for (const file of archive.files) {
        const root = file.area === 'session' ? sessionDir : dataDir; const target = path.resolve(root, file.name)
        if (!contained(root, target)) throw new Error('PROFILE_BACKUP_INVALID_PATH')
        assertNoLinks(target)
        await fs.promises.mkdir(path.dirname(target), { recursive: true }); await fs.promises.writeFile(target, Buffer.from(file.data, 'base64'), { flag: 'wx', mode: 0o600 })
      }
      this.persist({ ...this.registry, profiles: [...this.registry.profiles, profile] })
    } catch (error) {
      for (const target of [sessionDir, dataDir]) if (contained(path.dirname(target), target)) await fs.promises.rm(target, { recursive: true, force: true }).catch(() => {})
      throw error
    }
    return { ...profile }
  }
  async clone(id: string, name: string): Promise<BrowserProfile> {
    const password = randomBytes(32).toString('base64')
    return this.importProfile(await this.exportProfile(id, password), password, name)
  }
}
let manager: ProfileManager | undefined
export function getProfileManager(): ProfileManager { if (!manager) manager = new ProfileManager(); return manager }
export function currentProfileId(): string { return getProfileManager().currentProfileId() }
