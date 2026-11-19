#!/usr/bin/env node
/** Unit tests for the platform-neutral installer helpers (no network, no install). */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  appImagePathFor,
  bridgePathFor,
  defaultInstallDirFor,
  linuxUserDataDirFor,
  parseArgs,
  pickReleaseAsset,
  verifyArtifact
} from '../install.mjs'

const home = 'C:\\Users\\fixture'
const env = { LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local' }

test('parseArgs reads value flags, booleans and = form', () => {
  const options = parseArgs(['--repo', 'owner/repo', '--verify', '--json', '--clients=zcode,cursor', '--connect-only'])
  assert.equal(options.repo, 'owner/repo')
  assert.equal(options.clients, 'zcode,cursor')
  assert.equal(options.verify, true)
  assert.equal(options.json, true)
  assert.equal(options['connect-only'], true)
})

test('pickReleaseAsset selects the right artifact per platform', () => {
  const assets = [
    { name: 'aa-browser-setup-0.2.0.exe' },
    { name: 'aa-browser-setup-0.2.0.exe.blockmap' },
    { name: 'aa-browser-0.2.0-linux-x86_64.AppImage' },
    { name: 'sbom.cdx.json' }
  ]
  assert.equal(pickReleaseAsset(assets, 'win32').name, 'aa-browser-setup-0.2.0.exe')
  assert.equal(pickReleaseAsset(assets, 'linux').name, 'aa-browser-0.2.0-linux-x86_64.AppImage')
  assert.equal(pickReleaseAsset(assets, 'darwin'), null)
  assert.equal(pickReleaseAsset([], 'linux'), null)
})

test('platform paths stay stable and honor overrides', () => {
  assert.equal(defaultInstallDirFor('win32', env, home), path.join(env.LOCALAPPDATA, 'Programs', 'Aa Browser'))
  assert.equal(linuxUserDataDirFor({}, '/home/fixture'), path.join('/home/fixture', '.config', 'Aa Browser'))
  assert.equal(appImagePathFor(undefined, '/home/fixture'), path.join('/home/fixture', 'Applications', 'AaBrowser.AppImage'))
  assert.equal(appImagePathFor('/opt/aa', '/home/fixture'), path.join('/opt/aa', 'AaBrowser.AppImage'))
  assert.equal(
    bridgePathFor({ platform: 'win32', installDir: 'C:\\Apps\\Aa Browser', env, home }),
    path.join('C:\\Apps\\Aa Browser', 'resources', 'app.asar.unpacked', 'out', 'bridge', 'mcp.cjs')
  )
  assert.equal(
    bridgePathFor({ platform: 'linux', env: {}, home: '/home/fixture' }),
    path.join('/home/fixture', '.config', 'Aa Browser', 'mcp', 'bridge.cjs')
  )
  assert.equal(bridgePathFor({ platform: 'linux', env: { AA_BROWSER_MCP_BRIDGE: '/tmp/bridge.cjs' } }), '/tmp/bridge.cjs')
})

test('verifyArtifact enforces file magic and optional SHA-256', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aa-installer-test-'))
  try {
    const exe = path.join(dir, 'setup.exe')
    const payload = Buffer.from('MZ\0\0fixture-payload', 'latin1')
    await writeFile(exe, payload)
    const digest = createHash('sha256').update(payload).digest('hex')

    await assert.doesNotReject(verifyArtifact(exe, undefined, exe, {}))
    await assert.rejects(verifyArtifact(exe, undefined, exe, { requireDigest: true }), /未提供可验证的 SHA-256 digest/)
    await assert.rejects(verifyArtifact(exe, 'sha256:not-a-hex-digest', exe, {}), /无法识别的 SHA-256 digest 格式/)
    await assert.rejects(verifyArtifact(exe, `sha256:${'0'.repeat(64)}`, exe, {}), /安装包哈希校验失败/)
    const ok = await verifyArtifact(exe, `sha256:${digest}`, exe, {})
    assert.equal(ok.digestChecked, true)

    const appImage = path.join(dir, 'aa.AppImage')
    await writeFile(appImage, Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from('fixture')]))
    await assert.doesNotReject(verifyArtifact(appImage, undefined, appImage, { platform: 'linux' }))
    await assert.rejects(verifyArtifact(exe, undefined, exe, { platform: 'linux' }), /不是有效的 Linux ELF\/AppImage/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
