/** Scoped configuration edits must preserve user bytes, including inline siblings. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { compileFunction } from 'node:vm'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-client-config-'))
try {
  const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc')
  const compiled = spawnSync(process.execPath, [tsc, '--ignoreConfig', '--noCheck', '--noResolve', '--outDir', tmp,
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--esModuleInterop',
    path.join(root, 'src/main/client-config.ts')], { encoding: 'utf8' })
  assert.equal(compiled.status, 0, `${compiled.stdout}\n${compiled.stderr}`)
  const module = { exports: {} }
  compileFunction(fs.readFileSync(path.join(tmp, 'client-config.js'), 'utf8'), ['require', 'module', 'exports'])(require, module, module.exports)
  const { replaceJsonEntry, readJsonEntry, replaceTomlEntry } = module.exports
  const entry = { command: 'node', args: ['bridge'] }
  for (const indent of ['  ', '    ', '\t']) {
    const sibling = '"other" : {"command":"keep"}'
    const source = `{\n${indent}"preference": 1, "mcpServers": { ${sibling} }\n}`
    const updated = replaceJsonEntry(source, 'mcpServers', entry)
    assert.ok(updated.includes(`${indent}"preference": 1, "mcpServers": { ${sibling}`), 'Existing inline siblings remain byte-identical')
    assert.deepEqual({ ...readJsonEntry(updated, 'mcpServers') }, entry)
    assert.ok(updated.includes(`\n${indent.repeat(3)}"command": "node"`), 'Only the new value uses the existing indentation')
    const replaced = replaceJsonEntry(updated, 'mcpServers', { ...entry, command: 'new' })
    assert.ok(replaced.includes(`${indent}"preference": 1, "mcpServers": { ${sibling}`))
    assert.deepEqual({ ...readJsonEntry(replaced, 'mcpServers') }, { ...entry, command: 'new' })
  }
  for (const sequence of ['$&', '$$', '$`', "$'"]) {
    const special = { command: 'node', args: [`C:\\Apps\\Aa ${sequence}\\bridge.cjs`] }
    const initial = '{\n  "mcpServers": {}\n}'
    const inserted = replaceJsonEntry(initial, 'mcpServers', special)
    assert.deepEqual({ ...readJsonEntry(inserted, 'mcpServers') }, special)
    const updated = { ...special, command: `node-${sequence}` }
    assert.deepEqual({ ...readJsonEntry(replaceJsonEntry(inserted, 'mcpServers', updated), 'mcpServers') }, updated)
  }
  console.log('PASS: dollar replacement sequences in paths remain literal on insert and update')
  const minified = replaceJsonEntry('{"mcpServers":{}}', 'mcpServers', entry)
  assert.equal(minified.includes('\n'), false)
  console.log('PASS: JSONC preserves inline sibling bytes and space/tab indentation; minified input stays compact')
  const tomlEntry = '[mcp_servers.aa-browser]\ncommand = "node"\nargs = ["bridge"]'
  for (const newline of ['\n', '\r\n']) {
    for (const ending of ['', newline, newline.repeat(3), `${newline}  ${newline}`]) {
      const initial = `model = "x"${ending}`
      const once = replaceTomlEntry(initial, tomlEntry)
      assert.equal(replaceTomlEntry(once, tomlEntry), once, 'Repeated updates are byte-idempotent even without EOF newline')
      const detectedNewline = initial.includes('\r\n') ? '\r\n' : '\n'
      assert.ok(once.startsWith(`model = "x"${detectedNewline}${detectedNewline}`))
    }
  }
  console.log('PASS: TOML replacement is byte-idempotent with absent, LF, CRLF and whitespace-only EOF separators')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
