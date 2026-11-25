#!/usr/bin/env node
/**
 * Static contract tests for MCP tool declarations.
 *
 * The desktop smoke test checks the live tools/list response. This test keeps
 * the single source of truth (src/shared/tool-defs.mjs), the main-process
 * handlers and the stdio bridge synchronized, and prevents a future tool from
 * omitting any of the four MCP hints.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const sourceSource = fs.readFileSync(path.join(root, 'src', 'shared', 'tool-defs.mjs'), 'utf8')
const mainSource = fs.readFileSync(path.join(root, 'src', 'main', 'tools.ts'), 'utf8')
const bridgeSource = fs.readFileSync(path.join(root, 'cli', 'mcp.mjs'), 'utf8')
const clientsSource = fs.readFileSync(path.join(root, 'src', 'main', 'clients.ts'), 'utf8')

const namesIn = (source, pattern) => [...source.matchAll(pattern)].map((match) => match[1])
const unique = (values) => [...new Set(values)]
const sourceNames = unique(namesIn(sourceSource, /name:\s*'(browser_[a-z0-9_]+)'/g))
const platformSource = fs.readFileSync(path.join(root, 'src', 'main', 'platform-tools.ts'), 'utf8')
const mainNames = unique(namesIn(mainSource + platformSource, /name:\s*'(browser_[a-z0-9_]+)'/g))
const expectedHints = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']

function annotationEntries(source) {
  const entries = new Map()
  for (const match of source.matchAll(/^\s{2}(browser_[a-z0-9_]+):\s*\{([^}\n]*)\}/gm)) {
    entries.set(match[1], match[2])
  }
  return entries
}

function assertCompleteAnnotations(entries, label) {
  assert.deepEqual([...entries.keys()].sort(), sourceNames.sort(), `${label} annotations must cover every tool`)
  for (const name of sourceNames) {
    const body = entries.get(name)
    assert.ok(body, `${label} is missing ${name}`)
    for (const hint of expectedHints) {
      assert.match(body, new RegExp(`\\b${hint}\\s*:\\s*(?:true|false)\\b`), `${label} ${name} is missing ${hint}`)
    }
    assert.equal((body.match(/\b(?:true|false)\b/g) ?? []).length, 4, `${label} ${name} must have exactly four boolean hints`)
  }
}

// 单一来源：handler 名、schema 字段与 annotations 都必须来自同一个文件
assert.deepEqual([...mainNames].sort(), [...sourceNames].sort(), 'main-process handler names must match the shared source')
assert.match(sourceSource, /name:\s*'browser_reload'/, 'shared source must declare browser_reload')
assert.match(sourceSource, /hard:\s*\{\s*type:\s*'boolean'/, 'shared source must expose browser_reload hard')
assert.match(sourceSource, /name:\s*'browser_press_key'[\s\S]*?modifiers:\s*\{/, 'shared source press_key must expose modifiers')
assert.match(mainSource, /from '@shared\/tool-defs\.mjs'/, 'main process must import the shared schemas')
assert.match(mainSource, /def\.inputSchema/, 'main process must derive inputSchema from the shared source')
// One occurrence is the McpToolDefBase interface; a second means a tool redeclared its schema.
assert.equal((mainSource.match(/\binputSchema:\s*\{/g) ?? []).length, 1, 'main process must not redeclare any inputSchema')
assert.match(bridgeSource, /from '\.\.\/src\/shared\/tool-defs\.mjs'/, 'bridge must import the shared schemas')
assert.doesNotMatch(bridgeSource, /name:\s*'browser_/, 'bridge must not redeclare any tool definition')

assertCompleteAnnotations(annotationEntries(sourceSource), 'shared tool-defs')
assert.match(bridgeSource, /annotations:\s*\{\s*title:\s*t\.title,\s*\.\.\.TOOL_ANNOTATIONS\[t\.name\]\s*\}/, 'tools/list must expose the four hints')

assert.doesNotMatch(clientsSource, /node:child_process|spawnSync/, 'client setup must not probe Node by spawning a shell/process')
assert.match(clientsSource, /function findSystemNode\(\)/, 'client setup must use the filesystem-based Node lookup')

console.log(`✅ MCP tool contract validated for ${sourceNames.length} tools from a single source (annotations + shell-free client detection)`)
