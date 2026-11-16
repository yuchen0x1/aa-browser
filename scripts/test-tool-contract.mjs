#!/usr/bin/env node
/**
 * Static contract tests for MCP tool declarations.
 *
 * The desktop smoke test checks the live tools/list response. This test keeps
 * the source-of-truth maps in the main process and stdio bridge synchronized,
 * and prevents a future tool from omitting any of the four MCP hints.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const mainSource = fs.readFileSync(path.join(root, 'src', 'main', 'tools.ts'), 'utf8')
const bridgeSource = fs.readFileSync(path.join(root, 'cli', 'mcp.mjs'), 'utf8')
const clientsSource = fs.readFileSync(path.join(root, 'src', 'main', 'clients.ts'), 'utf8')

const namesIn = (source, pattern) => [...source.matchAll(pattern)].map((match) => match[1])
const unique = (values) => [...new Set(values)]
const mainNames = unique(namesIn(mainSource, /name:\s*'(browser_[a-z0-9_]+)'/g))
const bridgeNames = unique(namesIn(bridgeSource, /name:\s*'(browser_[a-z0-9_]+)'/g))
const expectedHints = ['readOnlyHint', 'destructiveHint', 'idempotentHint', 'openWorldHint']

function annotationEntries(source) {
  const entries = new Map()
  for (const match of source.matchAll(/^\s{2}(browser_[a-z0-9_]+):\s*\{([^}\n]*)\}/gm)) {
    entries.set(match[1], match[2])
  }
  return entries
}

function annotationValues(entries) {
  return Object.fromEntries(
    [...entries.entries()].map(([name, body]) => [
      name,
      Object.fromEntries(expectedHints.map((hint) => [hint, new RegExp(`\\b${hint}\\s*:\\s*(true|false)\\b`).exec(body)?.[1] === 'true']))
    ])
  )
}

function assertCompleteAnnotations(entries, label) {
  assert.deepEqual([...entries.keys()].sort(), mainNames.sort(), `${label} annotations must cover every main-process tool`)
  for (const name of mainNames) {
    const body = entries.get(name)
    assert.ok(body, `${label} is missing ${name}`)
    for (const hint of expectedHints) {
      assert.match(body, new RegExp(`\\b${hint}\\s*:\\s*(?:true|false)\\b`), `${label} ${name} is missing ${hint}`)
    }
    assert.equal((body.match(/\b(?:true|false)\b/g) ?? []).length, 4, `${label} ${name} must have exactly four boolean hints`)
  }
}

assert.deepEqual([...bridgeNames].sort(), [...mainNames].sort(), 'stdio bridge and main process must declare the same tools')
const mainAnnotations = annotationEntries(mainSource)
const bridgeAnnotations = annotationEntries(bridgeSource)
assertCompleteAnnotations(mainAnnotations, 'main process')
assertCompleteAnnotations(bridgeAnnotations, 'stdio bridge')
assert.deepEqual(annotationValues(bridgeAnnotations), annotationValues(mainAnnotations), 'main process and bridge annotation values must stay synchronized')
assert.match(bridgeSource, /annotations:\s*\{\s*title:\s*t\.title,\s*\.\.\.TOOL_ANNOTATIONS\[t\.name\]\s*\}/, 'tools/list must expose the four hints')

assert.doesNotMatch(clientsSource, /node:child_process|spawnSync/, 'client setup must not probe Node by spawning a shell/process')
assert.match(clientsSource, /function findSystemNode\(\)/, 'client setup must use the filesystem-based Node lookup')

console.log(`✅ MCP tool contract validated for ${mainNames.length} tools (annotations + shell-free client detection)`)
