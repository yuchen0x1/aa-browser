import { TOOL_DEFS, TOOL_ANNOTATIONS } from '@shared/tool-defs.mjs'
import type { McpToolDef } from './tools'
import { getProfileManager } from './profiles'
import { validateToolArguments } from './tool-validation'
import { randomUUID } from 'node:crypto'
import type { ToolContent } from '../shared/types'

const transientOwnerPrefix = randomUUID()

function visualContent(result: unknown): ToolContent[] {
  const images: ToolContent[] = []
  const metadata = JSON.parse(JSON.stringify(result, (_key, value: unknown) => {
    if (value && typeof value === 'object' && 'type' in value && value.type === 'image' && 'data' in value && typeof value.data === 'string' && 'mimeType' in value && value.mimeType === 'image/png') {
      images.push({ type: 'image', mimeType: 'image/png', data: value.data })
      return { type: 'image', mimeType: 'image/png', attachment: images.length }
    }
    return value
  }))
  return [{ type: 'text', text: JSON.stringify(metadata, null, 2) }, ...images]
}

export type PlatformDomain = 'profile' | 'workflow' | 'network' | 'visual' | 'permission' | 'diagnostics'
export interface PlatformCallContext {
  owner: string
  clientId?: number
  signal?: AbortSignal
  desktop?: boolean
}
export interface PlatformAdapter {
  invoke(domain: PlatformDomain, action: string, input: Record<string, unknown>, context: PlatformCallContext): Promise<unknown>
}

/** Platform tools orchestrate the existing executors rather than duplicate them. */
export function buildPlatformTools(adapter: PlatformAdapter): McpToolDef[] {
  const registrations: Array<{ name: string; domain: PlatformDomain; fallback: string }> = [
    { name: 'browser_profiles', domain: 'profile', fallback: 'list' },
    { name: 'browser_workflows', domain: 'workflow', fallback: 'list' },
    { name: 'browser_network', domain: 'network', fallback: 'get' },
    { name: 'browser_visual', domain: 'visual', fallback: 'capture' },
    { name: 'browser_permissions', domain: 'permission', fallback: 'list' },
    { name: 'browser_diagnostics', domain: 'diagnostics', fallback: 'get' }
  ]
  return registrations.map(({ name, domain, fallback }) => {
    const definition = TOOL_DEFS.find((tool) => tool.name === name)
    if (!definition) throw new Error(`Missing platform tool definition: ${name}`)
    return {
      ...definition,
      annotations: TOOL_ANNOTATIONS[name],
      async handler(args) {
        validateToolArguments(definition.inputSchema, args)
        const clientId = typeof args.__aaClientId === 'number' ? args.__aaClientId : undefined
        const owner = typeof args.__aaClientSession === 'string' ? args.__aaClientSession : `connection:${transientOwnerPrefix}:${clientId ?? 'unknown'}`
        const profiles = getProfileManager()
        const profileId = typeof args.profileId === 'string' ? args.profileId : clientId === undefined ? profiles.defaultId : profiles.clientProfile(clientId)
        return profiles.runWithProfile(profileId, async () => {
          const result = await adapter.invoke(domain, String(args.action ?? fallback), args, {
            owner, clientId, signal: args.__aaSignal instanceof AbortSignal ? args.__aaSignal : undefined
          })
          return { content: domain === 'visual' ? visualContent(result) : [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] }
        })
      }
    }
  })
}
