#!/usr/bin/env node
/** Regression tests for response-size limits and network-body redaction. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { compileFunction } from 'node:vm'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-network-security-'))
const compiled = path.join(temp, 'compiled')

function loadNetwork() {
  const filename = path.join(compiled, 'network.js')
  const module = { exports: {} }
  compileFunction(fs.readFileSync(filename, 'utf8'), ['require', 'module', 'exports'], { filename })(
    (specifier) => {
      if (specifier === './actions') return { ActionError: class ActionError extends Error {} }
      if (specifier.startsWith('node:')) return require(specifier)
      throw new Error(`Unexpected production dependency: ${specifier}`)
    },
    module,
    module.exports
  )
  return module.exports
}

try {
  const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc')
  const result = spawnSync(process.execPath, [
    tsc, '--ignoreConfig', '--noCheck', '--noResolve', '--outDir', compiled,
    '--target', 'ES2022', '--module', 'NodeNext', '--moduleResolution', 'NodeNext', '--esModuleInterop',
    path.join(root, 'src/main/network.ts')
  ], { cwd: root, encoding: 'utf8' })
  assert.equal(result.status, 0, `Compilation failed:\n${result.stdout}\n${result.stderr}`)

  const { NetworkCapture, MAX_RESPONSE_BODY_BYTES, redactNetworkBody, clipBody } = loadNetwork()
  const json = '{"user":"alice","access_token":"fixture-token","nested":{"password":"fixture-password"},"message":"Bearer fixture-bearer"}'
  const redactedJson = redactNetworkBody(json, 'application/json')
  assert.doesNotMatch(redactedJson, /fixture-token|fixture-password|fixture-bearer/)
  assert.match(redactedJson, /\[redacted\]/)
  assert.match(redactedJson, /"user": "alice"/)

  const form = redactNetworkBody('name=alice&token=fixture-token', 'application/x-www-form-urlencoded')
  assert.equal(form.includes('fixture-token'), false)
  assert.match(form, /token=\[redacted\]/)

  const ordinaryBody = { content: json, base64Encoded: false, truncated: false, sizeBytes: Buffer.byteLength(json) }
  const safe = clipBody(ordinaryBody, 'application/json')
  assert.equal(safe.includes('fixture-token'), false)
  assert.match(safe, /敏感字段已脱敏/)
  assert.match(clipBody(ordinaryBody, 'application/json', true), /fixture-token/)

  const oversized = 'x'.repeat(MAX_RESPONSE_BODY_BYTES + 2048)
  const capture = new NetworkCapture({
    debugger: {
      sendCommand: async () => ({ body: oversized, base64Encoded: false })
    }
  })
  capture.attached = true
  const limited = await capture.getResponseBody('fixture-request')
  assert.ok(limited)
  assert.equal(limited.truncated, true)
  assert.equal(limited.sizeBytes, Buffer.byteLength(oversized))
  assert.ok(Buffer.byteLength(limited.content) <= MAX_RESPONSE_BODY_BYTES)
  assert.match(clipBody(limited, 'text/plain'), /仅返回前/)

  const encoded = 'A'.repeat(Math.ceil(MAX_RESPONSE_BODY_BYTES / 3) * 4 + 16)
  const binaryCapture = new NetworkCapture({
    debugger: {
      sendCommand: async () => ({ body: encoded, base64Encoded: true })
    }
  })
  binaryCapture.attached = true
  const binary = await binaryCapture.getResponseBody('fixture-binary')
  assert.ok(binary)
  assert.equal(binary.base64Encoded, true)
  assert.equal(binary.truncated, true)
  assert.match(clipBody(binary, 'application/octet-stream'), /二进制响应体/)

  console.log('PASS: network response size limits and default body redaction')
} finally {
  fs.rmSync(temp, { recursive: true, force: true })
}
