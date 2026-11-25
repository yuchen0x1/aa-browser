import fs from 'node:fs'
import path from 'node:path'
import { app, dialog, safeStorage } from 'electron'
import type { PlatformState } from '../shared/platform-types'
import type { TabManager } from './tabs'
import type { McpToolDef } from './tools'
import type { ApprovalManager } from './approvals'
import { getProfileManager, DEFAULT_PROFILE_ID } from './profiles'
import { WorkflowEngine, type WorkflowVerification } from './workflows'
import { NetworkEnvironmentManager } from './network-environments'
import { VisualOperationManager } from './visual-operations'
import { authorizeProfileAccess, getPermissionManager, markProfileAccess, type PermissionLevel } from './permissions'
import { configureFilePolicy, validateReadFile, writeExportFile } from './file-policy'
import { configureExtensionProfiles, getExtensionManager } from './extensions'
import { collectBrowserDiagnostics, repairBrowser, type BrowserDiagnosticDependencies, type BrowserRepairAction } from './browser-diagnostics'
import { getDownloadTracker } from './downloads'
import { configureHistoryProfiles } from './history'
import { configureEvidenceProfiles } from './evidence'
import { configureVisualProfiles } from './visual'
import { configureViewportProfiles } from './viewport'
import { configureMonitorProfiles } from './monitor'
import { redactText } from './redaction'
import { throwIfAborted, captureSnapshot, withTabLock } from './actions'
import type { PlatformAdapter, PlatformCallContext, PlatformDomain } from './platform-tools'

export interface PlatformDependencies {
  tabs: TabManager
  approvals: ApprovalManager
  changed: () => void
  agent: NonNullable<BrowserDiagnosticDependencies['agent']>
  controlAllowed: () => void
  isClientConnected: (clientId: number) => boolean
  isClientPaused?: (clientId: number) => boolean
}

function encryptionAvailable(): boolean {
  return safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text')
}
function protect(text: string): string {
  if (!encryptionAvailable()) throw new Error('[SECURE_STORAGE_UNAVAILABLE] OS credential storage is unavailable')
  return safeStorage.encryptString(text).toString('base64')
}
function unprotect(text: string): string {
  if (!encryptionAvailable()) throw new Error('[SECURE_STORAGE_UNAVAILABLE] OS credential storage is unavailable')
  return safeStorage.decryptString(Buffer.from(text, 'base64'))
}

/** One orchestration boundary shared by privileged desktop IPC and MCP. */
export class BrowserPlatform implements PlatformAdapter {
  readonly profiles = getProfileManager()
  readonly network: NetworkEnvironmentManager
  readonly workflows: WorkflowEngine
  readonly visual: VisualOperationManager
  private tools = new Map<string, McpToolDef>()
  private ownerClients = new Map<string, number>()
  private desktopWorkflows = new Set<string>()
  private uiProfileId: string
  private scheduler?: ReturnType<typeof setInterval>
  private readonly permissions = getPermissionManager()

  constructor(private readonly deps: PlatformDependencies) {
    this.uiProfileId = this.profiles.defaultId
    configureExtensionProfiles(() => this.profiles.currentProfileId(), (id) => id === DEFAULT_PROFILE_ID
      ? process.env.AA_BROWSER_EXTENSIONS_FILE || path.join(this.profiles.dataRoot, 'extensions.json')
      : path.join(this.profiles.directory(id, 'extensions'), 'registry.json'))
    configureHistoryProfiles(() => this.profiles.currentProfileId(), (id) => this.profiles.directory(id, 'history'))
    configureEvidenceProfiles(() => this.profiles.currentProfileId(), (id) => id === DEFAULT_PROFILE_ID
      ? process.env.AA_BROWSER_EVIDENCE_FILE || path.join(this.profiles.dataRoot, 'evidence-registry.json')
      : path.join(this.profiles.directory(id, 'files'), 'evidence-registry.json'))
    configureVisualProfiles(() => this.profiles.currentProfileId(), (id) => this.profiles.directory(id, 'baselines'))
    configureViewportProfiles(() => this.profiles.currentProfileId(), (id) => this.profiles.directory(id, 'screenshots'))
    configureMonitorProfiles(() => this.profiles.hasContext() ? this.profiles.currentProfileId() : undefined,
      (id) => id === DEFAULT_PROFILE_ID ? path.join(this.profiles.dataRoot, 'monitor') : path.join(this.profiles.directory(id, 'screenshots'), 'monitor'))
    configureFilePolicy((profileId) => {
      const id = profileId ?? this.profiles.currentProfileId()
      return {
        profileId: id,
        roots: ['downloads', 'files', 'har', 'screenshots', 'baselines'].map((kind) => this.profiles.directory(id, kind as 'files')),
        blockedRoots: [this.profiles.dataRoot, app.getPath('userData')]
      }
    })
    this.network = new NetworkEnvironmentManager({
      filePath: path.join(this.profiles.dataRoot, 'network-environments.json'),
      sessionFor: (id) => this.profiles.sessionFor(id), protect, unprotect
    })
    this.visual = new VisualOperationManager({
      directoryFor: (id) => this.profiles.directory(id, 'screenshots'),
      approve: (request, signal) => this.approve(`Visual ${request.action}`, request.profileId, JSON.stringify({ ...request, url: undefined }), signal),
      record: () => this.deps.changed()
    })
    this.workflows = new WorkflowEngine({
      file: path.join(this.profiles.dataRoot, 'workflows.json'),
      protect: encryptionAvailable() ? protect : undefined,
      unprotect: encryptionAvailable() ? unprotect : undefined,
      execute: async (name, args, context) => {
        this.deps.controlAllowed()
        const tool = this.tools.get(name)
        if (!tool || !name.startsWith('browser_')) throw new Error('[INVALID_TOOL] Unknown workflow tool')
        const clientId = this.workflowClient(context.owner, context.workflowId)
        const execute = () => tool.handler({ ...args, profileId: context.profileId, __aaSignal: context.signal,
          __aaClientSession: context.owner, ...(clientId !== undefined ? { __aaClientId: clientId } : {}) })
        return clientId === undefined ? execute() : this.deps.tabs.runAsAgent(clientId, execute)
      },
      isReadOnly: (name, args) => {
        const tool = this.tools.get(name)
        if (tool?.annotations.readOnlyHint) return true
        return (name === 'browser_tabs' && args.action === 'list') ||
          (name === 'browser_cookies' && args.action === 'get' && args.includeSensitive !== true) ||
          (name === 'browser_storage' && args.action === 'get' && args.includeSensitive !== true) ||
          (name === 'browser_extensions' && ['list', 'check'].includes(String(args.action ?? 'list')))
      },
      approve: ({ workflow, step, reason, signal }) => this.approve(`Workflow: ${step.name}`, workflow.profileId, reason, signal),
      verify: (request) => this.verifyWorkflow(request),
      withProfile: async (id, owner, workflowId, operation, signal) => {
        throwIfAborted(signal)
        const clientId = this.workflowClient(owner, workflowId)
        if (clientId !== undefined) {
          await authorizeProfileAccess(id, clientId, () => this.approve('Access workflow identity', id, 'This workflow will inspect and control its assigned Profile login state.', signal))
          throwIfAborted(signal)
          this.workflowClient(owner, workflowId)
        }
        const release = this.profiles.acquireLease(id, workflowId)
        try { return await this.profiles.runWithLease(id, workflowId, async () => { await this.profiles.start(id); return operation() }) }
        finally { release() }
      },
      onChange: () => this.deps.changed()
    })
    this.workflows.load()
  }

  async initialize(): Promise<void> {
    await this.profiles.sweepDeleted()
    this.profiles.onChange = () => this.deps.changed()
    this.profiles.onStop = (id) => {
      this.visual.clearProfile(id)
      getDownloadTracker().cancelProfile(id)
      const ses = this.profiles.existingSession(id)
      if (ses) getExtensionManager(id).suspend(ses)
      this.deps.tabs.closeProfile(id)
    }
    this.profiles.onSession = async (ses, id) => {
      await this.network.apply(id)
      await getExtensionManager(id).restore(ses)
    }
    this.scheduler = setInterval(() => {
      try { for (const pending of this.workflows.runDue()) void pending.catch(() => this.deps.changed()) }
      catch { this.deps.changed() }
    }, 1000)
    this.scheduler.unref()
  }

  setTools(tools: McpToolDef[]): void { this.tools = new Map(tools.map((tool) => [tool.name, tool])) }
  shutdown(): void { if (this.scheduler) clearInterval(this.scheduler); this.workflows.shutdown(); this.visual.clear() }

  desktopProfileId(): string {
    const id = this.deps.tabs.activeForUi()?.profileId ?? this.uiProfileId
    if (this.profiles.list().some((profile) => profile.id === id)) return id
    this.uiProfileId = this.profiles.defaultId
    return this.uiProfileId
  }

  pauseWorkflows(clientId?: number): void {
    for (const record of this.workflows.list()) {
      if (clientId !== undefined && this.ownerClients.get(record.owner) !== clientId) continue
      if (record.status !== 'running' && record.status !== 'waiting' && !(record.status === 'draft' && record.scheduleAt !== undefined)) continue
      // Workflow execution outlives its accepted RPC and owns a separate abort controller.
      try { this.workflows.pause(record.id, record.owner) } catch { /* pause aborts execution before attempting persistence */ }
    }
  }

  clientDisconnected(clientId: number): void {
    this.pauseWorkflows(clientId)
    for (const [owner, client] of this.ownerClients) {
      if (client !== clientId) continue
      this.ownerClients.delete(owner)
    }
  }

  private workflowClient(owner: string, workflowId: string): number | undefined {
    if (owner === 'desktop' || this.desktopWorkflows.has(workflowId)) return undefined
    const clientId = this.ownerClients.get(owner)
    if (clientId === undefined || !this.deps.isClientConnected(clientId)) {
      throw new Error('[WORKFLOW_OWNER_OFFLINE] Reconnect the owning MCP client or approve desktop workflow takeover before recovery')
    }
    if (this.deps.isClientPaused?.(clientId)) throw new Error('[CLIENT_PAUSED] Explicitly resume the owning MCP client before running its workflow')
    return clientId
  }

  private async approve(action: string, profileId: string, detail: string, signal?: AbortSignal): Promise<boolean> {
    this.deps.controlAllowed()
    throwIfAborted(signal)
    this.profiles.assertLeaseAccess(profileId)
    const allowed = await this.deps.approvals.opRequest({ site: this.profiles.get(profileId).name, tabTitle: 'Aa Browser', fieldLabel: action, detail: redactText(detail, 500) }, signal)
    this.permissions.record({ profileId, level: 'high-risk', action, allowed })
    this.deps.controlAllowed()
    throwIfAborted(signal)
    this.profiles.assertLeaseAccess(profileId)
    return allowed
  }

  private async requireApproval(action: string, profileId: string, detail: string, context: PlatformCallContext): Promise<void> {
    this.deps.controlAllowed()
    if (!await this.approve(action, profileId, detail, context.signal)) throw new Error('[APPROVAL_DENIED] Operation was not approved')
    throwIfAborted(context.signal)
    this.profiles.get(profileId)
  }

  private diagnostics(profileId?: string) {
    return collectBrowserDiagnostics({
      app, tabs: () => this.deps.tabs.tabs, profiles: () => this.profiles.list(), agent: this.deps.agent,
      workflows: () => this.workflows.list(), downloads: () => getDownloadTracker().list(100),
      extensions: (id) => getExtensionManager(id).list(), redact: (text) => redactText(text, 400)
    }, profileId)
  }

  state(): PlatformState {
    if (!this.profiles.list().some((profile) => profile.id === this.uiProfileId)) this.uiProfileId = this.profiles.defaultId
    return {
      profiles: this.profiles.list().map((profile) => ({ ...profile, tabCount: this.deps.tabs.tabs.filter((tab) => tab.profileId === profile.id).length, downloadDir: this.profiles.directory(profile.id, 'downloads') })),
      defaultProfileId: this.profiles.defaultId,
      activeProfileId: this.desktopProfileId(),
      workflows: this.workflows.list(), templates: this.workflows.templates(),
      network: Object.fromEntries(this.profiles.list().map((profile) => [profile.id, this.network.get(profile.id)])),
      permissions: { grants: this.permissions.list().map((item) => ({ ...item })), audit: this.permissions.audit().map((item) => ({ ...item })) },
      diagnostics: this.diagnostics() as unknown as Record<string, unknown>
    }
  }

  private async verifyWorkflow(request: WorkflowVerification): Promise<{ ok: boolean; detail?: string; url?: string }> {
    this.deps.controlAllowed()
    throwIfAborted(request.signal)
    const client = this.workflowClient(request.workflow.owner, request.workflow.id)
    const inspect = async () => {
      const tab = this.deps.tabs.active()
      if (!tab) {
        if (request.step.tool === 'browser_navigate' && request.phase === 'before' && !request.condition) return { ok: true, detail: 'Navigation will create an owned tab' }
        return { ok: false, detail: 'No page in this Profile; select/open a page before recovery' }
      }
      if (tab.profileId !== request.workflow.profileId || tab.view.webContents.isDestroyed()) return { ok: false, detail: 'Profile or renderer changed' }
      return withTabLock(tab, request.signal, async () => {
        const wc = tab.view.webContents
        const url = wc.getURL()
        const condition = request.condition
        if (condition?.urlContains && !url.includes(condition.urlContains)) return { ok: false, detail: 'URL checkpoint does not match', url }
        if (condition?.selector) {
          const found = await wc.executeJavaScript(`!!document.querySelector(${JSON.stringify(condition.selector)})`, false)
          if (!found) return { ok: false, detail: 'Selector checkpoint does not match', url }
        }
        if (condition?.text) {
          const found = await wc.executeJavaScript(`String(document.body?.innerText || '').includes(${JSON.stringify(condition.text)})`, false)
          if (!found) return { ok: false, detail: 'Text checkpoint does not match', url }
        }
        // Taking a fresh structural snapshot invalidates stale refs after recovery.
        await captureSnapshot(wc, { mode: 'full' })
        throwIfAborted(request.signal)
        return { ok: true, url }
      })
    }
    return this.profiles.runWithProfile(request.workflow.profileId, () => client === undefined ? inspect() : this.deps.tabs.runAsAgent(client, inspect))
  }

  async invoke(domain: PlatformDomain, action: string, input: Record<string, unknown>, context: PlatformCallContext): Promise<unknown> {
    throwIfAborted(context.signal)
    if (context.clientId !== undefined) this.ownerClients.set(context.owner, context.clientId)
    const id = typeof input.profileId === 'string' ? input.profileId : this.profiles.currentProfileId()
    this.profiles.get(id)
    if (context.clientId !== undefined && !(domain === 'profile' && ['list', 'create', 'bind'].includes(action))) {
      await authorizeProfileAccess(id, context.clientId, () => this.approve('Access browser identity', id, 'This MCP client will access this Profile login state.', context.signal))
      throwIfAborted(context.signal)
      if (!this.deps.isClientConnected(context.clientId)) throw new Error('[CLIENT_DISCONNECTED] MCP client disconnected during identity approval')
    }
    if (domain === 'profile') return this.profileAction(action, id, input, context)
    if (domain === 'workflow') return this.workflowAction(action, id, input, context)
    const operation = async (): Promise<unknown> => {
    if (domain === 'network') {
      if (action === 'get') return this.network.get(id)
      if (action === 'set' || action === 'apply') {
        await this.requireApproval('Change network environment', id, 'Existing connections will be closed for this Profile.', context)
        const result = action === 'set' ? await this.network.set(id, input.config as never) : await this.network.apply(id)
        this.deps.changed(); return result
      }
      if (action === 'resolve') return this.network.resolve(id, String(input.url ?? 'https://example.com'))
      if (action === 'test') return this.network.test(id, typeof input.url === 'string' ? input.url : undefined, context.signal)
      if (action === 'diagnose') return this.network.diagnose(id, String(input.url ?? 'https://example.com'), context.signal)
    }
    if (domain === 'visual') {
      const tab = input.tabId ? this.deps.tabs.get(String(input.tabId)) : this.deps.tabs.active()
      if (!tab || tab.profileId !== id) throw new Error('[TAB_NOT_FOUND] No accessible page in this Profile')
      if (action === 'capture') return this.visual.capture(tab, context.signal)
      const clip = input.clip as Record<string, number> | undefined
      return this.visual.act(tab, { ...input, action, ...(clip ? { x: clip.x, y: clip.y, width: clip.width, height: clip.height } : {}) } as never, context.signal)
    }
    if (domain === 'permission') {
      const scope = { profileId: id, ...(context.clientId !== undefined ? { clientId: context.clientId } : {}), ...(typeof input.taskId === 'string' ? { taskId: input.taskId } : {}) }
      if (action === 'list') return this.permissions.list(context.desktop ? undefined : scope)
      if (action === 'audit') return this.permissions.audit(context.desktop ? undefined : scope)
      if (action === 'revoke') {
        if (!context.desktop && !this.permissions.list(scope).some((grant) => grant.id === input.grantId)) throw new Error('[PERMISSION_DENIED] Grant not owned by this caller')
        const result = this.permissions.revoke(String(input.grantId)); this.deps.changed(); return result
      }
      if (action === 'request') {
        const level = String(input.level) as PermissionLevel
        if (!['browse', 'read', 'interact', 'files', 'network', 'sensitive', 'high-risk'].includes(level)) throw new Error('[INVALID_ARGUMENT] Invalid permission level')
        const detail = JSON.stringify({ operation: input.operation, profileId: id, clientId: context.clientId, taskId: input.taskId,
          ttlMs: typeof input.ttlMs === 'number' ? Math.max(1000, Math.min(input.ttlMs, 3_600_000)) : 300_000,
          once: ['sensitive', 'high-risk'].includes(level) || input.once !== false, reason: input.reason,
          finalActionApprovalRequired: ['sensitive', 'high-risk'].includes(level) })
        await this.requireApproval(`Grant ${level}`, id, detail, context)
        const result = this.permissions.grant(scope, level, { ttlMs: typeof input.ttlMs === 'number' ? input.ttlMs : undefined, once: input.once !== false, action: typeof input.operation === 'string' ? input.operation : undefined })
        this.deps.changed(); return result
      }
    }
    if (domain === 'diagnostics') {
      if (action === 'get' || action === 'refresh') return this.diagnostics(context.desktop ? undefined : id)
      if (action === 'repair') {
        const result = await repairBrowser({
          getTab: (tabId) => this.deps.tabs.get(tabId), sessionFor: (profileId) => this.profiles.sessionFor(profileId),
          reconnect: (profileId) => this.network.reconnect(profileId),
          disableExtension: (profileId, extensionId) => getExtensionManager(profileId).setEnabled(this.profiles.sessionFor(profileId), extensionId, false),
          approve: (request, signal) => this.approve(`Repair: ${request.action}`, request.profileId, request.risk, signal)
        }, { action: String(input.repair ?? input.action) as BrowserRepairAction, profileId: id,
          ...(typeof input.extensionId === 'string' ? { extensionId: input.extensionId } : {}),
          ...(typeof input.tabId === 'string' ? { tabId: input.tabId } : (input.repair === 'reload' && this.deps.tabs.active() ? { tabId: this.deps.tabs.active()!.id } : {})) }, context.signal)
        this.deps.changed(); return result
      }
    }
    throw new Error('[INVALID_ARGUMENT] Unsupported platform action')
    }
    const metadataOnly = (domain === 'permission' && ['list', 'audit', 'revoke'].includes(action)) ||
      (domain === 'diagnostics' && action === 'get') || (domain === 'network' && action === 'get')
    return metadataOnly ? operation() : this.profiles.withUse(id, operation)
  }

  private async profileAction(action: string, id: string, input: Record<string, unknown>, context: PlatformCallContext): Promise<unknown> {
    if (action === 'list') return this.state().profiles
    if (action === 'get') return this.profiles.get(id)
    if (action === 'bind') {
      if (context.clientId === undefined) throw new Error('[INVALID_ARGUMENT] A connected MCP client is required')
      await this.requireApproval('Bind browser identity', id, 'This MCP client will access the selected Profile login state.', context)
      if (!this.deps.isClientConnected(context.clientId)) throw new Error('[CLIENT_DISCONNECTED] MCP client disconnected during identity approval')
      this.profiles.bindClient(context.clientId, id)
      markProfileAccess(id, context.clientId)
      return this.profiles.get(id)
    }
    if (action === 'select') {
      if (!context.desktop) throw new Error('[PERMISSION_DENIED] Selecting the desktop Profile requires the desktop interface')
      this.uiProfileId = id
      const existing = this.deps.tabs.tabs.find((tab) => tab.profileId === id)
      if (existing) this.deps.tabs.selectTab(existing.id)
      else { await this.profiles.start(id); this.deps.tabs.createTab(undefined, true, false, false, undefined, id) }
      this.deps.changed(); return this.profiles.get(id)
    }
    await this.requireApproval(`Profile: ${action}`, id, action === 'remove' ? 'All site data for this Profile will be cleared. Other Profiles are preserved.' : 'Modify the selected browser identity.', context)
    let result: unknown
    if (action === 'create') result = this.profiles.create(input)
    else if (action === 'update') result = this.profiles.update(id, input)
    else if (action === 'remove') { await this.profiles.remove(id); this.permissions.revokeProfile(id); result = true }
    else if (action === 'default') { this.profiles.setDefault(id); result = true }
    else if (action === 'start') { result = await this.profiles.start(id); this.deps.tabs.createTab(undefined, false, false, false, undefined, id) }
    else if (action === 'stop') { await this.profiles.stop(id); result = true }
    else if (action === 'clone') result = await this.profiles.clone(id, String(input.name ?? `${this.profiles.get(id).name} copy`))
    else if (action === 'export' || action === 'import') {
      const passphrase = typeof input.passphrase === 'string' ? input.passphrase : ''
      if (passphrase.length < 12) throw new Error('[INVALID_ARGUMENT] Backup password must contain at least 12 characters; use the desktop Profile panel')
      if (!context.desktop) throw new Error('[PERMISSION_DENIED] Profile archives use the desktop file picker')
      if (action === 'export') {
        const picked = await dialog.showSaveDialog({ title: 'Encrypted Profile backup', defaultPath: `${id}.aaprofile`, filters: [{ name: 'Aa Profile', extensions: ['aaprofile'] }] })
        if (picked.canceled || !picked.filePath) return { cancelled: true }
        const data = await this.profiles.exportProfile(id, passphrase)
        writeExportFile(picked.filePath, data, { approvedExternal: true, profileId: id })
        result = { file: picked.filePath }
      } else {
        const picked = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'Aa Profile', extensions: ['aaprofile'] }] })
        if (picked.canceled || !picked.filePaths[0]) return { cancelled: true }
        const file = validateReadFile(picked.filePaths[0], { approvedExternal: true, profileId: id })
        if ((await fs.promises.stat(file)).size > 256 * 1024 * 1024) throw new Error('[INVALID_ARGUMENT] Archive is too large')
        result = await this.profiles.importProfile(await fs.promises.readFile(file, 'utf8'), passphrase, typeof input.name === 'string' && input.name ? input.name : undefined)
      }
    } else throw new Error('[INVALID_ARGUMENT] Unsupported Profile action')
    this.deps.changed(); return result
  }

  private async workflowAction(action: string, id: string, input: Record<string, unknown>, context: PlatformCallContext): Promise<unknown> {
    const owner = context.owner
    if (action === 'templates') return this.workflows.templates()
    if (action === 'list') return this.workflows.list(context.desktop ? undefined : owner)
    const workflowId = String(input.workflowId ?? '')
    if (action === 'create') {
      const params = { ...input, ...(input.params as Record<string, unknown> ?? {}), profileId: id }
      if (input.templateId) return this.workflows.createFromTemplate(String(input.templateId), params, owner)
      const steps = input.steps as Parameters<WorkflowEngine['create']>[0]['steps']
      if (!Array.isArray(steps) || steps.some((step) => !this.tools.has(step.tool))) throw new Error('[INVALID_TOOL] Workflow references an unknown tool')
      return this.workflows.create({ name: String(input.name ?? 'Workflow'), profileId: id, steps, ...(typeof input.scheduleAt === 'number' ? { scheduleAt: input.scheduleAt } : {}) }, owner)
    }
    const record = this.workflows.get(workflowId, context.desktop ? undefined : owner)
    if (!record) throw new Error('[WORKFLOW_NOT_FOUND] Workflow was not found')
    if (action === 'get') return record
    const runOwner = context.desktop ? record.owner : owner
    if (action === 'pause') return this.workflows.pause(workflowId, runOwner)
    if (action === 'cancel') return this.workflows.cancel(workflowId, runOwner)
    if (action === 'input') return this.workflows.setStepInput(workflowId, String(input.stepId), input.input as Record<string, unknown>, runOwner)
    if (!['run', 'resume', 'retry'].includes(action)) throw new Error('[INVALID_ARGUMENT] Unsupported workflow action')
    this.deps.controlAllowed()
    const clientId = this.ownerClients.get(record.owner)
    if (context.desktop && record.owner !== 'desktop' && (clientId === undefined || !this.deps.isClientConnected(clientId))) {
      await this.requireApproval('Take over workflow', record.profileId, 'Run this disconnected client workflow under desktop control. Verify the current page before resuming.', context)
      this.desktopWorkflows.add(workflowId)
    }
    try {
      this.workflowClient(record.owner, workflowId)
      const operation = action === 'retry' ? this.workflows.retry(workflowId, String(input.stepId), runOwner)
        : action === 'resume' ? this.workflows.resume(workflowId, runOwner) : this.workflows.run(workflowId, runOwner)
      void operation.catch(() => this.deps.changed()).finally(() => { this.desktopWorkflows.delete(workflowId) })
    } catch (error) { this.desktopWorkflows.delete(workflowId); throw error }
    return { accepted: true, workflowId }
  }
}
