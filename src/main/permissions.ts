import { randomUUID } from 'node:crypto'
import { redactText } from './redaction'

export type PermissionLevel = 'browse' | 'read' | 'interact' | 'files' | 'network' | 'sensitive' | 'high-risk'
export interface PermissionScope { profileId: string; clientId?: number; taskId?: string }
export interface PermissionGrant extends PermissionScope {
  id: string; level: PermissionLevel; action?: string; createdAt: number; expiresAt: number; remainingUses?: number
}
export interface PermissionAudit extends PermissionScope {
  id: string; level: PermissionLevel; action: string; allowed: boolean; at: number; grantId?: string
}

const profileAccess = new Map<string, number>()
const pendingProfileAccess = new Map<string, Promise<void>>()
const PROFILE_ACCESS_TTL_MS = 3_600_000

export function markProfileAccess(profileId: string, clientId: number): void {
  profileAccess.set(`${clientId}:${profileId}`, Date.now() + PROFILE_ACCESS_TTL_MS)
}

export function revokeClientProfileAccess(clientId: number): void {
  for (const key of profileAccess.keys()) if (key.startsWith(`${clientId}:`)) profileAccess.delete(key)
  for (const key of pendingProfileAccess.keys()) if (key.startsWith(`${clientId}:`)) pendingProfileAccess.delete(key)
}

export function revokeProfileAccess(profileId: string): void {
  for (const key of profileAccess.keys()) if (key.endsWith(`:${profileId}`)) profileAccess.delete(key)
  for (const key of pendingProfileAccess.keys()) if (key.endsWith(`:${profileId}`)) pendingProfileAccess.delete(key)
}

/** This cache can be populated only by a successful native identity decision. */
export async function authorizeProfileAccess(profileId: string, clientId: number, approve: () => Promise<boolean>): Promise<void> {
  if (profileId === 'default') return
  if (!Number.isSafeInteger(clientId) || clientId < 1) throw new Error('[PERMISSION_ERROR] Invalid MCP client identity')
  const key = `${clientId}:${profileId}`
  if ((profileAccess.get(key) ?? 0) > Date.now()) return
  let pending = pendingProfileAccess.get(key)
  if (!pending) {
    pending = Promise.resolve().then(approve).then((allowed) => {
      if (allowed !== true) throw new Error('[PERMISSION_ERROR] Profile access was denied')
      if (pendingProfileAccess.get(key) !== pending) throw new Error('[PERMISSION_ERROR] Profile access was revoked during approval')
      markProfileAccess(profileId, clientId)
    }).finally(() => { if (pendingProfileAccess.get(key) === pending) pendingProfileAccess.delete(key) })
    pendingProfileAccess.set(key, pending)
  }
  await pending
}

/** Desktop decisions mint scoped, expiring capabilities; MCP cannot mint its own grant. */
export class PermissionManager {
  private grants = new Map<string, PermissionGrant>()
  private records: PermissionAudit[] = []

  list(scope?: PermissionScope): PermissionGrant[] {
    this.expire()
    return [...this.grants.values()].filter((grant) => !scope || this.matches(grant, scope)).map((grant) => ({ ...grant }))
  }

  audit(scope?: PermissionScope): PermissionAudit[] {
    return this.records.filter((record) => !scope || this.matches(record, scope)).map((record) => ({ ...record }))
  }

  grant(scope: PermissionScope, level: PermissionLevel, opts: { ttlMs?: number; once?: boolean; action?: string } = {}): PermissionGrant {
    if (!scope.profileId) throw new Error('[PERMISSION_ERROR] A profile is required')
    if (!['browse', 'read', 'interact', 'files', 'network', 'sensitive', 'high-risk'].includes(level)) throw new Error('[PERMISSION_ERROR] Invalid permission level')
    if ((level === 'high-risk' || level === 'sensitive') && (!opts.action?.trim() || opts.action.length > 200)) throw new Error('[PERMISSION_ERROR] Sensitive grants require an exact operation name')
    const now = Date.now()
    const ttl = Number.isFinite(opts.ttlMs) ? opts.ttlMs! : 300_000
    const grant: PermissionGrant = {
      ...scope, id: randomUUID(), level, createdAt: now,
      ...(opts.action ? { action: opts.action.trim() } : {}),
      expiresAt: now + Math.max(1000, Math.min(ttl, 3_600_000)),
      // High-risk actions always consume one human decision.
      ...(opts.once !== false || level === 'high-risk' || level === 'sensitive' ? { remainingUses: 1 } : {})
    }
    this.grants.set(grant.id, grant)
    return { ...grant }
  }

  revoke(id: string): boolean { return this.grants.delete(id) }
  revokeProfile(profileId: string): number {
    revokeProfileAccess(profileId)
    let removed = 0
    for (const [id, grant] of this.grants) if (grant.profileId === profileId && this.grants.delete(id)) removed++
    return removed
  }

  check(scope: PermissionScope, level: PermissionLevel, action: string): boolean {
    this.expire()
    const grant = [...this.grants.values()].find((item) => item.level === level && this.matches(item, scope) && (!item.action || item.action === action))
    const allowed = !!grant || level === 'browse' || level === 'read' || level === 'interact'
    if (grant?.remainingUses !== undefined && --grant.remainingUses <= 0) this.grants.delete(grant.id)
    this.record({ ...scope, level, action, allowed, ...(grant ? { grantId: grant.id } : {}) })
    return allowed
  }

  record(input: Omit<PermissionAudit, 'id' | 'at'>): void {
    this.records.push({ ...input, action: redactText(input.action, 240), id: randomUUID(), at: Date.now() })
    if (this.records.length > 500) this.records.splice(0, this.records.length - 500)
  }

  private matches(grant: PermissionScope, scope: PermissionScope): boolean {
    return grant.profileId === scope.profileId &&
      (grant.clientId === undefined || grant.clientId === scope.clientId) &&
      (grant.taskId === undefined || grant.taskId === scope.taskId)
  }

  private expire(): void {
    const now = Date.now()
    for (const [id, grant] of this.grants) if (grant.expiresAt <= now) this.grants.delete(id)
  }
}

const manager = new PermissionManager()
export function getPermissionManager(): PermissionManager { return manager }
