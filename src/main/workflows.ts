import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
import { writeJsonAtomic } from './atomic-json'
import { redactText as redactAuditText, isSensitiveKey } from './redaction'

export type WorkflowStatus = 'draft' | 'running' | 'paused' | 'waiting' | 'interrupted' | 'completed' | 'failed' | 'cancelled'
export type WorkflowStepStatus = 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'waiting' | 'interrupted' | 'cancelled'

export interface WorkflowCondition {
  urlContains?: string
  selector?: string
  text?: string
}

export interface WorkflowStepDefinition {
  id: string
  name: string
  tool: string
  args: Record<string, unknown>
  dependsOn?: string[]
  maxRetries?: number
  requiresApproval?: boolean
  checkpoint?: { before?: WorkflowCondition; after?: WorkflowCondition }
}

export interface WorkflowStep extends Omit<WorkflowStepDefinition, 'args'> {
  input: Record<string, unknown>
  status: WorkflowStepStatus
  attempts: number
  startedAt?: number
  finishedAt?: number
  error?: string
  result?: { ok: boolean; contentTypes: string[]; textLength: number; imageCount: number }
  sideEffect: 'none' | 'possible' | 'committed' | 'uncertain'
  checkpointAt?: number
  verifiedUrl?: string
  needsInput?: boolean
}

export interface WorkflowRecord {
  id: string
  name: string
  owner: string
  profileId: string
  status: WorkflowStatus
  createdAt: number
  updatedAt: number
  startedAt?: number
  finishedAt?: number
  steps: WorkflowStep[]
  events: Array<{ at: number; event: string; stepId?: string; detail?: string }>
  error?: string
  scheduleAt?: number
}

export interface CreateWorkflowOptions {
  name: string
  profileId: string
  steps: WorkflowStepDefinition[]
  scheduleAt?: number
}

export interface WorkflowExecutionContext {
  owner: string
  profileId: string
  workflowId: string
  stepId: string
  signal: AbortSignal
}

export interface WorkflowVerification {
  workflow: WorkflowRecord
  step: WorkflowStep
  phase: 'before' | 'after'
  condition?: WorkflowCondition
  signal: AbortSignal
}

export interface WorkflowEngineOptions {
  file: string
  execute: (tool: string, args: Record<string, unknown>, context: WorkflowExecutionContext) => Promise<unknown>
  isReadOnly: (tool: string, args: Record<string, unknown>) => boolean
  /** Must use trusted desktop approval; an MCP argument is never an authorization. */
  approve: (request: { workflow: WorkflowRecord; step: WorkflowStep; reason: string; signal: AbortSignal }) => Promise<boolean>
  verify: (request: WorkflowVerification) => Promise<{ ok: boolean; detail?: string; url?: string }>
  withProfile?: <T>(profileId: string, owner: string, workflowId: string, operation: () => Promise<T>, signal: AbortSignal) => Promise<T>
  protect?: (plaintext: string) => string
  unprotect?: (ciphertext: string) => string
  onChange?: (workflow: WorkflowRecord) => void
}

interface StoredWorkflow {
  record: WorkflowRecord
  inputs: Record<string, string>
}

const VERSION = 1
const MAX_WORKFLOWS = 100
const MAX_STEPS = 80
const MAX_INPUT_BYTES = 64 * 1024
const MAX_STORE_BYTES = 16 * 1024 * 1024
const FORBIDDEN_TOOLS = new Set(['browser_tasks', 'browser_workflows', 'browser_profiles', 'browser_window'])
function redactText(value: unknown, limit = 400): string {
  return redactAuditText(value, limit)
}

function redactInput(value: unknown, depth = 0): unknown {
  if (depth > 8) return '[omitted]'
  if (typeof value === 'string') return redactText(value, 500)
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => redactInput(item, depth + 1))
  if (value && typeof value === 'object') {
    const result: Record<string, unknown> = {}
    for (const [key, item] of Object.entries(value).slice(0, 80)) {
      if (key.startsWith('__') || ['__proto__', 'constructor', 'prototype'].includes(key)) continue
      // Text typed into pages, expressions and request payloads can contain unlabelled secrets.
      result[key] = isSensitiveKey(key) || /^(text|value|expression|body|postData|fields|headers|paths)$/i.test(key)
        ? '[protected]'
        : redactInput(item, depth + 1)
    }
    return result
  }
  return value
}

function copy<T>(value: T): T {
  return structuredClone(value)
}

function cleanInput(args: unknown): Record<string, unknown> {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new WorkflowError('INVALID_ARGUMENT', 'Step args must be an object')
  const json = JSON.stringify(args)
  if (Buffer.byteLength(json) > MAX_INPUT_BYTES) throw new WorkflowError('INVALID_ARGUMENT', 'Step input exceeds 64 KiB')
  const result = JSON.parse(json) as Record<string, unknown>
  const check = (value: unknown): void => {
    if (!value || typeof value !== 'object') return
    for (const [key, item] of Object.entries(value)) {
      if (key.startsWith('__') || ['constructor', 'prototype'].includes(key)) throw new WorkflowError('INVALID_ARGUMENT', 'Reserved input property')
      check(item)
    }
  }
  check(result)
  return result
}

function requiredText(value: unknown, field: string, max = 160): string {
  if (typeof value !== 'string' || !value.trim() || value.length > max) throw new WorkflowError('INVALID_ARGUMENT', `${field} must be a nonempty string (max ${max})`)
  return value.trim()
}

function summarizeResult(result: unknown): WorkflowStep['result'] {
  const raw = result && typeof result === 'object' ? result as Record<string, unknown> : {}
  const content = Array.isArray(raw.content) ? raw.content : []
  let textLength = 0
  let imageCount = 0
  const types = new Set<string>()
  for (const block of content) {
    if (!block || typeof block !== 'object') continue
    const item = block as Record<string, unknown>
    if (typeof item.type === 'string') types.add(item.type.slice(0, 30))
    if (typeof item.text === 'string') textLength += item.text.length
    if (item.type === 'image') imageCount += 1
  }
  return { ok: raw.isError !== true, contentTypes: [...types], textLength, imageCount }
}

export class WorkflowError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

/** Durable orchestration of existing tools. Recovery never replays uncertain writes. */
export class WorkflowEngine {
  private readonly workflows = new Map<string, StoredWorkflow>()
  private readonly inputs = new Map<string, Record<string, unknown>>()
  private readonly active = new Map<string, { controller: AbortController; promise: Promise<WorkflowRecord> }>()
  private readonly approvedRetries = new Set<string>()
  private healthy = true

  constructor(private readonly options: WorkflowEngineOptions) {}

  load(): WorkflowRecord[] {
    if (this.active.size) throw new WorkflowError('WORKFLOW_BUSY', 'Cannot reload while workflows are running')
    this.workflows.clear()
    this.inputs.clear()
    this.healthy = true
    try {
      if (fs.statSync(this.options.file).size > MAX_STORE_BYTES) throw new Error('Workflow store exceeds 16 MiB')
      const raw = JSON.parse(fs.readFileSync(this.options.file, 'utf8')) as { version?: unknown; workflows?: unknown }
      if (raw.version !== VERSION || !Array.isArray(raw.workflows) || raw.workflows.length > MAX_WORKFLOWS) throw new Error('Unsupported workflow store')
      for (const item of raw.workflows) {
        if (!item || typeof item !== 'object') throw new Error('Invalid workflow entry')
        const stored = item as StoredWorkflow
        const record = stored.record
        requiredText(record.id, 'id')
        requiredText(record.owner, 'owner', 200)
        requiredText(record.profileId, 'profileId')
        requiredText(record.name, 'name')
        if (!Array.isArray(record.steps) || !record.steps.length || record.steps.length > MAX_STEPS || !Array.isArray(record.events)) throw new Error('Invalid workflow steps')
        if (!['draft', 'running', 'paused', 'waiting', 'interrupted', 'completed', 'failed', 'cancelled'].includes(record.status)) throw new Error('Invalid workflow status')
        record.events = record.events.slice(-200)
        this.validateGraph(record.steps)
        const wasActive = record.status === 'running'
        for (const step of record.steps) {
          if (!['pending', 'running', 'completed', 'failed', 'skipped', 'waiting', 'interrupted', 'cancelled'].includes(step.status)) throw new Error('Invalid step status')
          if (step.status === 'running') {
            step.status = 'interrupted'
            if (step.sideEffect !== 'none') step.sideEffect = 'uncertain'
          }
          const ciphertext = stored.inputs?.[step.id]
          if (typeof ciphertext === 'string' && this.options.unprotect) {
            try {
              this.inputs.set(this.inputKey(record.id, step.id), cleanInput(JSON.parse(this.options.unprotect(ciphertext))))
              step.needsInput = false
            } catch { step.needsInput = true }
          } else step.needsInput = !['completed', 'skipped', 'cancelled'].includes(step.status)
        }
        if (wasActive) {
          record.status = 'interrupted'
          this.event(record, 'process_restart', undefined, 'Execution stopped; page state must be verified before explicit recovery')
        }
        this.workflows.set(record.id, { record, inputs: stored.inputs ?? {} })
      }
      this.persist()
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.workflows.clear()
        this.inputs.clear()
        this.healthy = false
        try { fs.copyFileSync(this.options.file, `${this.options.file}.invalid-${Date.now()}.bak`, fs.constants.COPYFILE_EXCL) } catch { /* retain the original and fail closed */ }
      }
    }
    return this.list()
  }

  get ready(): boolean { return this.healthy }

  list(owner?: string): WorkflowRecord[] {
    return [...this.workflows.values()].map((item) => item.record)
      .filter((item) => owner === undefined || item.owner === owner)
      .sort((a, b) => b.updatedAt - a.updatedAt).map(copy)
  }

  get(id: string, owner?: string): WorkflowRecord | null {
    const stored = this.workflows.get(id)
    if (!stored || (owner !== undefined && stored.record.owner !== owner)) return null
    return copy(stored.record)
  }

  create(definition: CreateWorkflowOptions, owner: string): WorkflowRecord {
    this.assertHealthy()
    requiredText(owner, 'owner', 200)
    const name = redactText(requiredText(definition.name, 'name'))
    const profileId = requiredText(definition.profileId, 'profileId')
    const now = Date.now()
    if (definition.scheduleAt !== undefined && (!Number.isSafeInteger(definition.scheduleAt) || definition.scheduleAt < now)) throw new WorkflowError('INVALID_ARGUMENT', 'scheduleAt must be a future Unix timestamp')
    if (this.workflows.size >= MAX_WORKFLOWS) throw new WorkflowError('WORKFLOW_LIMIT', 'Workflow history reached 100 entries; remove finished records first')
    if (!Array.isArray(definition.steps) || !definition.steps.length || definition.steps.length > MAX_STEPS) throw new WorkflowError('INVALID_ARGUMENT', 'A workflow requires 1-80 steps')
    this.validateGraph(definition.steps)
    const id = `wf-${randomUUID()}`
    const protectedInputs: Record<string, string> = {}
    const steps = definition.steps.map((definition): WorkflowStep => {
      const args = cleanInput(definition.args)
      this.inputs.set(this.inputKey(id, definition.id), args)
      if (this.options.protect) protectedInputs[definition.id] = this.options.protect(JSON.stringify(args))
      return {
        id: definition.id,
        name: redactText(requiredText(definition.name, 'step.name')),
        tool: definition.tool,
        input: redactInput(args) as Record<string, unknown>,
        dependsOn: [...(definition.dependsOn ?? [])],
        maxRetries: Math.max(0, Math.min(5, Math.trunc(definition.maxRetries ?? 1))),
        requiresApproval: definition.requiresApproval === true,
        checkpoint: this.normalizeCheckpoint(definition.checkpoint),
        status: 'pending', attempts: 0,
        sideEffect: this.options.isReadOnly(definition.tool, args) ? 'none' : 'possible'
      }
    })
    const record: WorkflowRecord = {
      id, name, owner, profileId, status: 'draft',
      createdAt: now, updatedAt: now, steps, events: []
    }
    if (definition.scheduleAt !== undefined) record.scheduleAt = definition.scheduleAt
    this.workflows.set(id, { record, inputs: protectedInputs })
    try { this.commit(record, 'created') } catch (error) {
      this.workflows.delete(id)
      for (const step of steps) this.inputs.delete(this.inputKey(id, step.id))
      throw error
    }
    return copy(record)
  }

  setStepInput(id: string, stepId: string, args: Record<string, unknown>, owner: string): WorkflowRecord {
    const stored = this.require(id, owner)
    this.assertIdle(id)
    const step = this.requireStep(stored.record, stepId)
    if (step.status === 'completed') throw new WorkflowError('WORKFLOW_CONFLICT', 'Completed step inputs cannot change')
    const clean = cleanInput(args)
    this.inputs.set(this.inputKey(id, stepId), clean)
    if (this.options.protect) stored.inputs[stepId] = this.options.protect(JSON.stringify(clean))
    else delete stored.inputs[stepId]
    step.input = redactInput(clean) as Record<string, unknown>
    step.needsInput = false
    // A caller cannot change the side-effect classification by editing the record.
    if (!this.options.isReadOnly(step.tool, clean) && step.sideEffect === 'none') step.sideEffect = 'possible'
    this.commit(stored.record, 'input_updated', stepId)
    return copy(stored.record)
  }

  run(id: string, owner: string): Promise<WorkflowRecord> {
    const record = this.require(id, owner).record
    this.assertIdle(id)
    if (record.status !== 'draft') throw new WorkflowError('WORKFLOW_CONFLICT', 'Use resume for an existing workflow')
    return this.start(record)
  }

  resume(id: string, owner: string): Promise<WorkflowRecord> {
    const record = this.require(id, owner).record
    this.assertIdle(id)
    if (!['paused', 'interrupted', 'waiting', 'failed'].includes(record.status)) throw new WorkflowError('WORKFLOW_CONFLICT', 'Workflow is not resumable')
    for (const step of record.steps) {
      if (step.status === 'interrupted' || step.status === 'failed') {
        if (step.sideEffect === 'none') step.status = 'pending'
      } else if (step.status === 'waiting' && step.sideEffect !== 'uncertain') step.status = 'pending'
    }
    return this.start(record)
  }

  retry(id: string, stepId: string, owner: string): Promise<WorkflowRecord> {
    const record = this.require(id, owner).record
    this.assertIdle(id)
    if (['completed', 'cancelled', 'draft'].includes(record.status)) throw new WorkflowError('WORKFLOW_CONFLICT', 'Workflow cannot retry in its current state')
    const step = this.requireStep(record, stepId)
    if (!['failed', 'interrupted', 'waiting'].includes(step.status)) throw new WorkflowError('WORKFLOW_CONFLICT', 'Only a failed or interrupted step can be retried')
    if (record.steps.some((item) => item.status === 'completed' && item.dependsOn?.includes(stepId))) throw new WorkflowError('WORKFLOW_CONFLICT', 'A completed dependent prevents replay')
    step.status = 'pending'
    this.approvedRetries.add(this.inputKey(id, stepId))
    this.commit(record, 'retry_requested', stepId, 'Fresh state verification and trusted approval required for side effects')
    return this.start(record)
  }

  pause(id: string, owner?: string): WorkflowRecord {
    const record = this.require(id, owner).record
    if (['completed', 'cancelled'].includes(record.status)) throw new WorkflowError('WORKFLOW_CONFLICT', 'Workflow is terminal')
    record.status = 'paused'
    this.active.get(id)?.controller.abort()
    this.commit(record, 'paused')
    return copy(record)
  }

  cancel(id: string, owner?: string): WorkflowRecord {
    const record = this.require(id, owner).record
    if (record.status === 'completed') throw new WorkflowError('WORKFLOW_CONFLICT', 'Completed workflow cannot be cancelled')
    record.status = 'cancelled'
    record.finishedAt = Date.now()
    this.active.get(id)?.controller.abort()
    for (const step of record.steps) if (step.status === 'pending' || step.status === 'waiting') step.status = 'cancelled'
    this.commit(record, 'cancelled')
    return copy(record)
  }

  remove(id: string, owner?: string): boolean {
    const stored = this.require(id, owner)
    this.assertIdle(id)
    if (!['completed', 'cancelled', 'failed'].includes(stored.record.status)) throw new WorkflowError('WORKFLOW_CONFLICT', 'Only finished workflows can be removed')
    this.workflows.delete(id)
    for (const step of stored.record.steps) this.inputs.delete(this.inputKey(id, step.id))
    this.persist()
    return true
  }

  /** The main process calls this from its bounded scheduler. One-shot schedules never auto-resume. */
  runDue(now = Date.now()): Promise<WorkflowRecord>[] {
    return [...this.workflows.values()].filter(({ record }) => record.status === 'draft' && record.scheduleAt !== undefined && record.scheduleAt <= now)
      .map(({ record }) => this.run(record.id, record.owner))
  }

  shutdown(): void {
    for (const [id, active] of this.active) {
      const record = this.workflows.get(id)?.record
      if (!record) continue
      record.status = 'interrupted'
      for (const step of record.steps) if (step.status === 'running') {
        step.status = 'interrupted'
        if (step.sideEffect !== 'none') step.sideEffect = 'uncertain'
      }
      active.controller.abort()
      this.event(record, 'shutdown')
    }
    this.persist()
  }

  templates(): Array<{ id: string; name: string; parameters: string[] }> {
    return [
      { id: 'collect', name: 'Web data collection', parameters: ['url'] },
      { id: 'multi-page', name: 'Multi-page extraction', parameters: ['urls'] },
      { id: 'download', name: 'Page export to PDF', parameters: ['url'] },
      { id: 'inspection', name: 'Website inspection', parameters: ['url'] },
      { id: 'form', name: 'Fill a form', parameters: ['url', 'fields'] },
      { id: 'page-test', name: 'Page assertions', parameters: ['url', 'checks'] },
      { id: 'compare', name: 'Compare multiple websites', parameters: ['urls'] },
      { id: 'scheduled', name: 'Scheduled website inspection', parameters: ['url', 'scheduleAt'] }
    ]
  }

  createFromTemplate(templateId: string, parameters: Record<string, unknown>, owner: string): WorkflowRecord {
    const template = this.templates().find((item) => item.id === templateId)
    if (!template) throw new WorkflowError('INVALID_ARGUMENT', 'Unknown workflow template')
    const urls = templateId === 'multi-page' || templateId === 'compare'
      ? parameters.urls
      : [parameters.url]
    if (!Array.isArray(urls) || !urls.length || urls.length > 10) throw new WorkflowError('INVALID_ARGUMENT', 'Provide 1-10 URLs')
    const steps: WorkflowStepDefinition[] = []
    for (const [index, value] of urls.entries()) {
      const url = requiredText(value, 'url', 2000)
      const parsed = new URL(url)
      if (!['http:', 'https:'].includes(parsed.protocol)) throw new WorkflowError('INVALID_ARGUMENT', 'Only HTTP(S) URLs are supported')
      const nav = `navigate-${index + 1}`
      const previous = steps.at(-1)?.id
      steps.push({ id: nav, name: `Open website ${index + 1}`, tool: 'browser_navigate', args: { url }, dependsOn: previous ? [previous] : [] })
      const tool = templateId === 'download' ? 'browser_pdf' : templateId === 'form' ? 'browser_fill_form'
        : templateId === 'page-test' ? 'browser_assert' : templateId === 'inspection' || templateId === 'scheduled' ? 'browser_page_state' : 'browser_extract'
      const args: Record<string, unknown> = tool === 'browser_fill_form' ? { fields: parameters.fields }
        : tool === 'browser_assert' ? { checks: parameters.checks } : {}
      if ((templateId === 'form' && !Array.isArray(parameters.fields)) || (templateId === 'page-test' && !Array.isArray(parameters.checks))) throw new WorkflowError('INVALID_ARGUMENT', 'Template requires fields/checks array')
      steps.push({ id: `read-${index + 1}`, name: `${template.name} ${index + 1}`, tool, args, dependsOn: [nav] })
    }
    return this.create({
      name: typeof parameters.name === 'string' ? parameters.name : template.name,
      profileId: requiredText(parameters.profileId, 'profileId'), steps,
      ...(templateId === 'scheduled' ? { scheduleAt: Number(parameters.scheduleAt) } : {})
    }, owner)
  }

  private start(record: WorkflowRecord): Promise<WorkflowRecord> {
    const controller = new AbortController()
    record.status = 'running'
    record.error = undefined
    record.startedAt ??= Date.now()
    this.commit(record, 'running')
    // Defer execution until the active entry exists, so synchronous pauses cannot miss its controller.
    const promise = Promise.resolve().then(() => this.options.withProfile
      ? this.options.withProfile(record.profileId, record.owner, record.id, () => this.executeSteps(record, controller.signal), controller.signal)
      : this.executeSteps(record, controller.signal))
      .catch((error: unknown) => {
        if (!['paused', 'cancelled', 'interrupted'].includes(record.status)) record.status = 'failed'
        record.error = redactText(error instanceof Error ? error.message : error)
        this.commit(record, 'execution_error', undefined, record.error)
        return copy(record)
      })
      .finally(() => {
        this.active.delete(record.id)
        for (const step of record.steps) this.approvedRetries.delete(this.inputKey(record.id, step.id))
        if (record.status === 'completed' || record.status === 'cancelled') {
          for (const step of record.steps) this.inputs.delete(this.inputKey(record.id, step.id))
        }
      })
    this.active.set(record.id, { controller, promise })
    return promise
  }

  private async executeSteps(record: WorkflowRecord, signal: AbortSignal): Promise<WorkflowRecord> {
    while (!signal.aborted) {
      const pending = record.steps.filter((step) => step.status === 'pending')
      if (!pending.length) break
      const step = pending.find((candidate) => (candidate.dependsOn ?? []).every((id) => this.requireStep(record, id).status === 'completed'))
      if (!step) break
      const key = this.inputKey(record.id, step.id)
      const args = this.inputs.get(key)
      if (!args || step.needsInput) {
        step.status = 'waiting'
        step.needsInput = true
        record.status = 'waiting'
        this.commit(record, 'input_required', step.id, 'Protected input could not be restored; re-enter this step input')
        return copy(record)
      }
      const readOnly = this.options.isReadOnly(step.tool, args) && step.sideEffect === 'none'
      if (!readOnly && (step.sideEffect === 'uncertain' || step.sideEffect === 'committed') && !this.approvedRetries.has(key)) {
        step.status = 'waiting'
        record.status = 'waiting'
        this.commit(record, 'state_inspection_required', step.id, 'An uncertain write requires explicit step retry, fresh page verification and approval')
        return copy(record)
      }
      if (!await this.verify(record, step, 'before', signal)) return copy(record)
      if (signal.aborted) break
      if (!readOnly || step.requiresApproval) {
        const allowed = await this.options.approve({ workflow: copy(record), step: copy(step), reason: step.sideEffect === 'uncertain' || step.sideEffect === 'committed' ? 'retry_side_effect' : 'step_execution', signal })
        if (signal.aborted) break
        if (!allowed) {
          step.status = 'waiting'
          record.status = 'waiting'
          this.commit(record, 'approval_required', step.id)
          return copy(record)
        }
        this.commit(record, 'approved', step.id)
        // Approval may outlive the document or a checkpoint condition; verify again before dispatch.
        if (!await this.verify(record, step, 'before', signal)) return copy(record)
        if (signal.aborted) break
      }
      step.status = 'running'
      step.startedAt = Date.now()
      step.attempts += 1
      step.error = undefined
      if (!readOnly) step.sideEffect = 'possible'
      // Persist dispatch intent before calling a tool that might change external state.
      this.commit(record, 'step_started', step.id)
      try {
        const result = await this.options.execute(step.tool, copy(args), {
          owner: record.owner, profileId: record.profileId, workflowId: record.id, stepId: step.id, signal
        })
        step.result = summarizeResult(result)
        if (!step.result?.ok) throw new WorkflowError('STEP_FAILED', 'The existing browser tool returned an error; inspect its current page state')
        if (signal.aborted) throw new WorkflowError('WORKFLOW_INTERRUPTED', 'Workflow interrupted')
        if (!await this.verify(record, step, 'after', signal)) {
          if (!readOnly) step.sideEffect = 'uncertain'
          this.commit(record, 'checkpoint_failed', step.id)
          return copy(record)
        }
        step.status = 'completed'
        step.finishedAt = Date.now()
        step.checkpointAt = Date.now()
        if (!readOnly) step.sideEffect = 'committed'
        this.commit(record, 'step_completed', step.id)
      } catch (error) {
        step.error = redactText(error instanceof Error ? error.message : error)
        step.finishedAt = Date.now()
        if (!readOnly) step.sideEffect = 'uncertain'
        if (signal.aborted) {
          step.status = 'interrupted'
          if (!['paused', 'cancelled', 'interrupted'].includes(record.status)) record.status = 'interrupted'
          this.commit(record, 'step_interrupted', step.id)
          return copy(record)
        }
        step.status = 'failed'
        this.commit(record, 'step_failed', step.id, step.error)
        if (readOnly && step.attempts <= (step.maxRetries ?? 1)) {
          step.status = 'pending'
          this.commit(record, 'readonly_retry', step.id)
          try { await delay(Math.min(1000, 100 * step.attempts), undefined, { signal }) } catch { break }
          continue
        }
        record.status = 'failed'
        record.error = step.error
        this.commit(record, 'failed', step.id)
        return copy(record)
      }
    }
    if (signal.aborted || ['paused', 'cancelled', 'interrupted'].includes(record.status)) return copy(record)
    if (record.steps.every((step) => step.status === 'completed' || step.status === 'skipped')) {
      record.status = 'completed'
      record.finishedAt = Date.now()
      this.commit(record, 'completed')
    } else {
      record.status = 'waiting'
      this.commit(record, 'waiting', undefined, 'An interrupted dependency requires explicit inspection or retry')
    }
    return copy(record)
  }

  private async verify(record: WorkflowRecord, step: WorkflowStep, phase: 'before' | 'after', signal: AbortSignal): Promise<boolean> {
    const verification = await this.options.verify({ workflow: copy(record), step: copy(step), phase, condition: step.checkpoint?.[phase], signal })
    if (signal.aborted) return false
    if (verification.ok !== true) {
      step.status = 'waiting'
      step.error = redactText(verification.detail ?? 'Fresh page state did not satisfy the checkpoint')
      record.status = 'waiting'
      this.commit(record, 'verification_required', step.id, step.error)
      return false
    }
    if (verification.url) step.verifiedUrl = redactText(verification.url, 2000)
    return true
  }

  private validateGraph(steps: Array<Pick<WorkflowStepDefinition, 'id' | 'name' | 'tool' | 'dependsOn'>>): void {
    const byId = new Map<string, typeof steps[number]>()
    for (const step of steps) {
      requiredText(step.id, 'step.id', 80)
      if (!/^[a-zA-Z0-9_-]+$/.test(step.id) || byId.has(step.id)) throw new WorkflowError('INVALID_ARGUMENT', 'Step IDs must be unique letters, digits, underscores or hyphens')
      requiredText(step.name, 'step.name')
      if (!/^browser_[a-z0-9_]+$/.test(step.tool) || FORBIDDEN_TOOLS.has(step.tool)) throw new WorkflowError('INVALID_ARGUMENT', 'Nested workflow/profile/window control is not permitted')
      if (step.dependsOn !== undefined && (!Array.isArray(step.dependsOn) || step.dependsOn.some((id) => typeof id !== 'string'))) throw new WorkflowError('INVALID_ARGUMENT', 'dependsOn must be a string array')
      byId.set(step.id, step)
    }
    const visiting = new Set<string>()
    const visited = new Set<string>()
    const visit = (id: string): void => {
      if (visited.has(id)) return
      if (visiting.has(id)) throw new WorkflowError('INVALID_ARGUMENT', 'Workflow dependencies contain a cycle')
      const step = byId.get(id)
      if (!step) throw new WorkflowError('INVALID_ARGUMENT', `Unknown dependency: ${id}`)
      visiting.add(id)
      for (const dependency of step.dependsOn ?? []) visit(dependency)
      visiting.delete(id)
      visited.add(id)
    }
    for (const step of steps) visit(step.id)
  }

  private normalizeCheckpoint(value: WorkflowStepDefinition['checkpoint']): WorkflowStepDefinition['checkpoint'] {
    if (value === undefined) return undefined
    if (!value || typeof value !== 'object') throw new WorkflowError('INVALID_ARGUMENT', 'checkpoint must be an object')
    const result: NonNullable<WorkflowStepDefinition['checkpoint']> = {}
    for (const phase of ['before', 'after'] as const) {
      const condition = value[phase]
      if (condition === undefined) continue
      if (!condition || typeof condition !== 'object') throw new WorkflowError('INVALID_ARGUMENT', 'checkpoint condition must be an object')
      const normalized: WorkflowCondition = {}
      for (const field of ['urlContains', 'selector', 'text'] as const) {
        if (condition[field] !== undefined) normalized[field] = requiredText(condition[field], `checkpoint.${field}`, 2000)
      }
      result[phase] = normalized
    }
    return result
  }

  private require(id: string, owner?: string): StoredWorkflow {
    this.assertHealthy()
    const stored = this.workflows.get(id)
    if (!stored || (owner !== undefined && stored.record.owner !== owner)) throw new WorkflowError('WORKFLOW_NOT_FOUND', 'Workflow not found in the current client session')
    return stored
  }

  private requireStep(record: WorkflowRecord, id: string): WorkflowStep {
    const step = record.steps.find((item) => item.id === id)
    if (!step) throw new WorkflowError('INVALID_ARGUMENT', 'Workflow step not found')
    return step
  }

  private assertIdle(id: string): void {
    if (this.active.has(id)) throw new WorkflowError('WORKFLOW_BUSY', 'Workflow is still running or releasing its browser resources')
  }

  private assertHealthy(): void {
    if (!this.healthy) throw new WorkflowError('WORKFLOW_STORE_UNAVAILABLE', 'Workflow storage is unavailable; original data has been retained')
  }

  private inputKey(id: string, stepId: string): string { return `${id}:${stepId}` }

  private event(record: WorkflowRecord, event: string, stepId?: string, detail?: string): void {
    record.updatedAt = Date.now()
    record.events.push({ at: record.updatedAt, event, ...(stepId ? { stepId } : {}), ...(detail ? { detail: redactText(detail) } : {}) })
    if (record.events.length > 200) record.events.splice(0, record.events.length - 200)
  }

  private commit(record: WorkflowRecord, event: string, stepId?: string, detail?: string): void {
    this.event(record, event, stepId, detail)
    this.persist()
    try { this.options.onChange?.(copy(record)) } catch { /* UI listeners cannot invalidate a durable execution */ }
  }

  private persist(): void {
    this.assertHealthy()
    try {
      const store = { version: VERSION, workflows: [...this.workflows.values()] }
      if (Buffer.byteLength(JSON.stringify(store)) > MAX_STORE_BYTES) throw new Error('Workflow storage exceeds 16 MiB')
      writeJsonAtomic(this.options.file, store)
    } catch (error) {
      this.healthy = false
      throw new WorkflowError('WORKFLOW_STORE_UNAVAILABLE', `Workflow checkpoint could not be saved: ${redactText(error instanceof Error ? error.message : error)}`)
    }
  }
}
