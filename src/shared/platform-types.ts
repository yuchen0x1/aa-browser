/** Renderer-safe platform DTOs. Credentials and browser storage never enter this state. */
export interface ProfileView {
  id: string
  name: string
  description: string
  color: string
  icon: string
  isDefault: boolean
  running: boolean
  tabCount?: number
  downloadDir?: string
  leased?: boolean
}

export interface PlatformWorkflowStep {
  id: string
  name: string
  tool?: string
  status: string
  startedAt?: number
  finishedAt?: number
  attempts?: number
  retryCount?: number
  error?: string
  checkpoint?: unknown
  checkpointAt?: number
  requiresApproval?: boolean
  sideEffect?: string
  input?: Record<string, unknown>
  needsInput?: boolean
  result?: unknown
}

export interface PlatformWorkflow {
  id: string
  name: string
  profileId: string
  status: string
  createdAt?: number
  startedAt?: number
  finishedAt?: number
  updatedAt?: number
  error?: string
  steps: PlatformWorkflowStep[]
  logs?: Array<{ at?: number; message?: string; level?: string }>
  events?: Array<{ at: number; event: string; stepId?: string; detail?: string }>
}

export interface PlatformTemplate {
  id: string
  name: string
  description?: string
  parameters?: string[]
}

export interface PlatformNetwork {
  profileId?: string
  enabled?: boolean
  mode: string
  protocol?: string
  host?: string
  port?: number
  bypass?: string[]
  rules?: Array<{ site: string; protocol: string; host: string; port: number }>
  hasCredentials?: boolean
  appliedAt?: number
  error?: string
}

export interface PlatformState {
  profiles: ProfileView[]
  defaultProfileId: string
  activeProfileId: string
  workflows: PlatformWorkflow[]
  templates: PlatformTemplate[]
  network: Record<string, PlatformNetwork>
  permissions: { grants: Array<Record<string, unknown>>; audit: Array<Record<string, unknown>> }
  diagnostics: Record<string, unknown>
}

export interface PlatformActionResult {
  ok: boolean
  data?: unknown
  error?: string
}

export interface ExtensionUpdateResult {
  ok: boolean
  error?: string
  updates?: Array<{ id: string; installedVersion: string; localVersion?: string; changed: boolean; error?: string }>
}
