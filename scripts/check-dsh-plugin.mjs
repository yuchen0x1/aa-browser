#!/usr/bin/env node
/**
 * Static validation for the DeepSeek Harness marketplace bundle in packages/dsh/.
 * Catches drift between the manifest, patch, bundled bridge, locales and
 * marketplace entry without installing anything.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DSH = path.join(ROOT, 'packages', 'dsh')
const pkg = JSON.parse(fs.readFileSync(path.join(DSH, 'package.json'), 'utf8'))
const rootPkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'))

assert.match(pkg.name, /^[a-z0-9][a-z0-9._-]*$/, 'dsh package name must be a plain npm name')
assert.match(pkg.version, /^\d+\.\d+\.\d+$/)
assert.equal(pkg.license, 'MIT')
assert.equal(pkg.dsh?.bundle?.patch, './cordis.patch.yml')
for (const required of ['index.js', 'cordis.patch.yml', 'bridge.cjs', 'locale/', 'docs/', 'icon.svg', 'README.md']) {
  assert.ok(pkg.files?.includes(required), `packages/dsh/package.json files must include ${required}`)
}
assert.ok(pkg.exports?.['./locale/*.json'] && pkg.exports?.['./icon'], 'dsh package must export locale and icon')

const patchText = fs.readFileSync(path.join(DSH, 'cordis.patch.yml'), 'utf8')
const yaml = await import('js-yaml')
// DSH's Loader dialect adds a `!!js` scalar tag; js-yaml does not know it.
const jsTag = new yaml.Type('tag:yaml.org,2002:js', {
  kind: 'scalar',
  resolve: () => true,
  construct: (value) => String(value)
})
const schema = yaml.DEFAULT_SCHEMA.extend([jsTag])
const patch = yaml.load(patchText, { schema })
assert.ok(Array.isArray(patch) && patch.length === 1 && Array.isArray(patch[0].insert), 'patch must be one insert list')
const rows = patch[0].insert
assert.equal(rows.length, 2, 'patch must insert exactly two rows')
const [stager, mcp] = rows
assert.equal(stager.name, pkg.name, 'first row must load this package')
assert.equal(stager.config?.bridge, './bridge.cjs')
assert.match(String(stager.config?.target), /\.aabrowser[/\\]dsh-bridge\.cjs$/)
assert.equal(mcp.name, '@deepseek-ai/dsh-mcp-client')
assert.equal(mcp.config?.serverName, 'aa-browser')
assert.equal(mcp.config?.transport, 'stdio')
assert.equal(mcp.config?.failOnStartupError, false)
assert.match(String(mcp.config?.command), /process\.execPath/, 'MCP command must use DSH runtime')
assert.match(String(mcp.config?.args?.[0]), /dsh-bridge\.cjs/, 'MCP args must point at the staged bridge')
assert.equal(mcp.config?.env?.ELECTRON_RUN_AS_NODE, '1')

const bridgePath = path.join(DSH, 'bridge.cjs')
assert.ok(fs.existsSync(bridgePath), 'packages/dsh/bridge.cjs is missing (run packages/dsh/scripts/sync-bridge.mjs)')
const bridge = fs.readFileSync(bridgePath, 'utf8')
assert.match(bridge, new RegExp(`__AA_BRIDGE_VERSION__\\s*=\\s*"${rootPkg.version.replace(/\./g, '\\.')}"`), 'bundled bridge version must match the root package version')

for (const [locale, detail] of [['en.json', 'docs/DETAIL.md'], ['zh.json', 'docs/DETAIL.zh.md']]) {
  const meta = JSON.parse(fs.readFileSync(path.join(DSH, 'locale', locale), 'utf8')).meta
  assert.ok(meta?.title && meta?.description, `${locale} needs meta.title and meta.description`)
  assert.equal(meta.detail, detail)
  assert.ok(fs.existsSync(path.join(DSH, meta.detail)), `${locale} detail document is missing`)
}
const icon = fs.statSync(path.join(DSH, 'icon.svg'))
assert.ok(icon.size > 100 && icon.size < 256 * 1024, 'icon must be a non-trivial file below 256 KiB')

const entry = yaml.load(fs.readFileSync(path.join(DSH, 'marketplace-entry.yml'), 'utf8'), { schema })
assert.equal(entry.url, 'https://github.com/yuchen0x1/aa-browser/tree/main/packages/dsh')
assert.equal(entry.name, 'yuchen0x1/aa-browser#packages/dsh')
assert.equal(entry.category, 'browser')
assert.ok(entry.description?.en && entry.description?.zh)

const syntax = spawnSync(process.execPath, ['--check', path.join(DSH, 'index.js')], { encoding: 'utf8' })
assert.equal(syntax.status, 0, `packages/dsh/index.js syntax: ${syntax.stderr}`)

console.log(`✅ DSH bundle ${pkg.name}@${pkg.version} validated (bridge v${rootPkg.version}, ${rows.length} rows, marketplace entry ready)`)
