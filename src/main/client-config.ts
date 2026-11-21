import { applyEdits, getNodeValue, modify, parseTree } from 'jsonc-parser'
import type { Node, ParseError } from 'jsonc-parser'
import { parse as parseToml } from 'smol-toml'

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

export function sameEntry(a: unknown, b: unknown): boolean {
  if (Object.is(a, b)) return true
  if (a instanceof Date || b instanceof Date) return a instanceof Date && b instanceof Date && a.toISOString() === b.toISOString()
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => sameEntry(value, b[index]))
  }
  if (!record(a) || !record(b)) return false
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && sameEntry(a[key], b[key]))
}

function entryAt(value: unknown, keys: string[]): unknown {
  let current = value
  for (const key of keys) {
    if (!record(current)) throw new Error('The MCP configuration container must be an object')
    if (!Object.hasOwn(current, key)) return undefined
    current = current[key]
  }
  return current
}

function uniqueKeys(node: Node): boolean {
  if (node.type === 'object') {
    const names = node.children?.map((property) => property.children?.[0].value) ?? []
    if (new Set(names).size !== names.length) return false
  }
  return node.children?.every(uniqueKeys) ?? true
}

function jsonConfig(text: string): Record<string, unknown> {
  const errors: ParseError[] = []
  const tree = parseTree(text.replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true })
  if (!tree || tree.type !== 'object' || errors.length || !uniqueKeys(tree)) throw new Error('Invalid or ambiguous JSON configuration')
  return getNodeValue(tree) as Record<string, unknown>
}

export function readJsonEntry(text: string, container: string): unknown {
  return entryAt(jsonConfig(text), [...container.split('.'), 'aa-browser'])
}

/** JSONC edits are scoped to the one MCP entry; strings, comments and other keys are not reserialized. */
export function replaceJsonEntry(text: string, container: string, entry: Record<string, unknown>): string {
  readJsonEntry(text, container)
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : ''
  const input = text.slice(bom.length)
  // Formatting a whole touched line can also rewrite an unrelated inline sibling.
  const output = applyEdits(input, modify(input, [...container.split('.'), 'aa-browser'], entry, {}))
  if (!sameEntry(readJsonEntry(output, container), entry)) throw new Error('MCP configuration verification failed')
  return bom + output
}

function tomlConfig(text: string): Record<string, unknown> {
  try { return parseToml(text.replace(/^\uFEFF/, '')) }
  catch { throw new Error('Invalid TOML configuration') }
}

export function readTomlEntry(text: string): unknown {
  return entryAt(tomlConfig(text), ['mcp_servers', 'aa-browser'])
}

interface TomlState {
  quote: string
  escaped: boolean
  square: number
  curly: number
}

/** Only recognize table headers outside strings and continued array/inline-table values. */
function scanTomlLine(line: string, state: TomlState): void {
  for (let index = 0; index < line.length; index++) {
    const char = line[index]
    if (state.quote) {
      if (state.escaped) { state.escaped = false; continue }
      if (state.quote[0] === '"' && char === '\\') { state.escaped = true; continue }
      if (state.quote.length === 3 && line.startsWith(state.quote, index)) {
        while (line[index + 1] === state.quote[0]) index++
        state.quote = ''
      } else if (state.quote.length === 1 && char === state.quote) {
        state.quote = ''
      }
      continue
    }
    if (char === '#') break
    if (char === '"' || char === "'") {
      state.quote = line.startsWith(char.repeat(3), index) ? char.repeat(3) : char
      index += state.quote.length - 1
    } else if (char === '[') state.square++
    else if (char === ']') state.square--
    else if (char === '{') state.curly++
    else if (char === '}') state.curly--
  }
}

function withoutTomlEntry(value: Record<string, unknown>): Record<string, unknown> {
  const result = { ...value }
  const servers = result['mcp_servers']
  if (record(servers)) {
    const remaining = { ...servers }
    delete remaining['aa-browser']
    if (Object.keys(remaining).length) result['mcp_servers'] = remaining
    else delete result['mcp_servers']
  }
  return result
}

/** Parse first, retain unrelated table bytes, then verify both the new entry and every other value. */
export function replaceTomlEntry(text: string, entry: string): string {
  const bom = text.startsWith('\uFEFF') ? '\uFEFF' : ''
  const input = text.slice(bom.length)
  const original = tomlConfig(input)
  entryAt(original, ['mcp_servers', 'aa-browser'])
  const newline = text.includes('\r\n') ? '\r\n' : '\n'
  const state: TomlState = { quote: '', escaped: false, square: 0, curly: 0 }
  const kept: string[] = []
  let removing = false
  for (const line of input.match(/[^\n]*(?:\n|$)/g) ?? []) {
    if (!line) continue
    if (!state.quote && state.square === 0 && state.curly === 0 && /^\s*\[/.test(line)) {
      const header = parseToml(line)
      const servers = header['mcp_servers']
      removing = record(servers) && Object.hasOwn(servers, 'aa-browser')
    } else {
      scanTomlLine(line, state)
    }
    if (!removing) kept.push(line)
  }
  const base = kept.join('')
  const output = `${base}${base && !base.endsWith('\n') ? newline : ''}${base ? newline : ''}${entry.replace(/\n/g, newline)}${newline}`
  const parsed = parseToml(output)
  if (!sameEntry(entryAt(parsed, ['mcp_servers', 'aa-browser']), readTomlEntry(entry)) ||
      !sameEntry(withoutTomlEntry(original), withoutTomlEntry(parsed))) {
    throw new Error('Cannot safely update this TOML configuration layout')
  }
  return bom + output
}
