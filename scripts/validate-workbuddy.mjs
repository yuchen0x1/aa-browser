#!/usr/bin/env node
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pkg = path.join(root, 'workbuddy')
const meta = JSON.parse(fs.readFileSync(path.join(pkg, 'connector-meta.json'), 'utf8'))
const mcp = JSON.parse(fs.readFileSync(path.join(pkg, 'mcp.json'), 'utf8'))
assert.equal(meta.source, 'aa-browser')
for (const key of ['name', 'name_en', 'description', 'description_en', 'source', 'examples_zh', 'examples_en']) assert.ok(meta[key], `missing connector metadata: ${key}`)
assert.ok(fs.existsSync(path.join(pkg, 'icon.svg')))
assert.ok(fs.existsSync(path.join(pkg, 'SKILL.md')))
assert.deepEqual(Object.keys(mcp), ['mcpServers'])
assert.deepEqual(Object.keys(mcp.mcpServers), ['aa-browser'])
assert.equal(mcp.mcpServers['aa-browser'].type, 'stdio')
assert.equal(typeof mcp.mcpServers['aa-browser'].command, 'string')
assert.ok(Array.isArray(mcp.mcpServers['aa-browser'].args))
const templateText = JSON.stringify({ meta, mcp })
assert.doesNotMatch(templateText, /(?:api[_-]?key|password|secret|token)\s*[:=]\s*[^"${}]+/i, 'template must not embed credential values')
assert.doesNotMatch(templateText, /[A-Z]:\\Users\\[^\\]+\\/i, 'template must not contain user-specific paths')

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-workbuddy-validation-'))
try {
  const installDir = path.join(tmp, 'Aa Browser Install')
  const bridgePath = path.join(installDir, 'resources', 'app.asar.unpacked', 'out', 'bridge', 'mcp.cjs')
  fs.mkdirSync(path.dirname(bridgePath), { recursive: true })
  fs.writeFileSync(path.join(installDir, 'Aa Browser.exe'), 'test executable placeholder')
  fs.writeFileSync(bridgePath, '// test placeholder')

  const home = path.join(tmp, 'home')
  const wbDir = path.join(home, '.workbuddy')
  fs.mkdirSync(wbDir, { recursive: true })
  const configFile = path.join(wbDir, 'mcp.json')
  fs.writeFileSync(configFile, JSON.stringify({ mcpServers: { other: { command: 'keep-me' } }, settings: { keep: true } }, null, 2))

  const run = () => spawnSync(process.execPath, [path.join(root, 'cli', 'workbuddy.mjs'), installDir], {
    encoding: 'utf8',
    env: { ...process.env, AA_BROWSER_TEST_HOME: home }
  })
  let result = run()
  assert.equal(result.status, 0, result.stderr || result.stdout)
  let generated = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  assert.deepEqual(generated.mcpServers.other, { command: 'keep-me' })
  assert.equal(generated.settings.keep, true)
  assert.equal(generated.mcpServers['aa-browser'].type, 'stdio')
  assert.equal(generated.mcpServers['aa-browser'].command, path.join(installDir, 'Aa Browser.exe'))
  assert.equal(generated.mcpServers['aa-browser'].args[0], bridgePath)
  assert.equal(generated.mcpServers['aa-browser'].env.AA_BROWSER_CONNECTION_FILE, path.join(home, '.aabrowser', 'connection.json'))

  const before = generated.mcpServers['aa-browser']
  result = run()
  assert.equal(result.status, 0, result.stderr || result.stdout)
  generated = JSON.parse(fs.readFileSync(configFile, 'utf8'))
  assert.deepEqual(generated.mcpServers['aa-browser'], before)
  const backups = fs.readdirSync(wbDir).filter((file) => file.startsWith('mcp.json.aa-backup-'))
  assert.equal(backups.length, 1, 'unchanged rerun should not create another backup')
  assert.ok(fs.existsSync(path.join(home, '.aabrowser', 'workbuddy-connector', 'icon.svg')), 'generated connector should include its icon')

  fs.writeFileSync(configFile, '{invalid-json')
  result = run()
  assert.notEqual(result.status, 0, 'invalid config must not be overwritten')
  assert.equal(fs.readFileSync(configFile, 'utf8'), '{invalid-json')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
console.log('✅ WorkBuddy connector metadata/schema and isolated config behavior validated')
