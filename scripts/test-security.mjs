#!/usr/bin/env node
/** Focused security regressions that do not require a live release or account. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aa-browser-security-'))

function run(args, extra = {}) {
  return spawnSync(process.execPath, args, {
    cwd: ROOT,
    encoding: 'utf8',
    ...extra
  })
}

try {
  const preload = path.join(tmp, 'mock-release-fetch.mjs')
  fs.writeFileSync(preload, `
const mode = process.env.AA_TEST_RELEASE_DIGEST_MODE
const isLinux = process.platform === 'linux'
const assetName = isLinux ? 'aa-browser-0.2.0-linux-x86_64.AppImage' : 'aa-browser-setup.exe'
const payload = isLinux ? Buffer.from('\\x7fELF\\x02\\x01\\x01\\x00fixture', 'latin1') : Buffer.from('MZ\\0\\0fixture', 'latin1')
globalThis.fetch = async (input) => {
  const url = String(input)
  if (url.includes('example.invalid')) return new Response(payload, { status: 200 })
  if (!url.includes('/releases/latest')) throw new Error('unexpected network request: ' + url)
  const digest = mode === 'malformed' ? 'sha256:not-a-hex-digest' : undefined
  return new Response(JSON.stringify({
    tag_name: 'v-test',
    assets: [{ name: assetName, browser_download_url: 'https://example.invalid/' + assetName, ...(digest ? { digest } : {}) }]
  }), { status: 200, headers: { 'content-type': 'application/json' } })
}
`, 'utf8')

  for (const [mode, phrase] of [['missing', '未提供可验证的 SHA-256 digest'], ['malformed', '无法识别的 SHA-256 digest 格式']]) {
    const result = run(['--import', pathToFileURL(preload).href, 'install.mjs', '--repo', 'example/aa-browser', '--no-launch'], {
      env: { ...process.env, AA_TEST_RELEASE_DIGEST_MODE: mode }
    })
    assert.notEqual(result.status, 0, `${mode} Release digest must abort installation`)
    assert.match(`${result.stdout}\n${result.stderr}`, new RegExp(phrase), `${mode} digest failure should explain the reason`)
  }

  const isLinux = process.platform === 'linux'
  const artifact = path.join(tmp, isLinux ? 'fake.AppImage' : 'fake.exe')
  fs.writeFileSync(artifact, isLinux ? Buffer.from('\x7fELF\x02\x01\x01\x00fixture', 'latin1') : Buffer.from('MZ\0\0fixture', 'latin1'))
  const explicit = run(['install.mjs', '--from', artifact, '--sha256', 'not-a-hex-digest', '--no-launch'])
  assert.notEqual(explicit.status, 0, 'malformed explicit --sha256 must abort installation')
  assert.match(`${explicit.stdout}\n${explicit.stderr}`, /无法识别的 SHA-256 digest 格式/)

  console.log('✅ installer refuses missing, malformed, and invalid explicit release digests')
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
