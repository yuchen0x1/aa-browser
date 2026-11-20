/** src/shared/tool-defs.mjs 的 TypeScript 声明（数据仍只在 .mjs 中维护） */

export interface ToolInputSchema {
  type: 'object'
  properties: Record<string, unknown>
  required?: string[]
}

export interface ToolDef {
  name: string
  title: string
  description: string
  inputSchema: ToolInputSchema
}

export interface ToolAnnotations {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

export const TOOL_DEFS: ToolDef[]
export const TOOL_ANNOTATIONS: Record<string, ToolAnnotations>
