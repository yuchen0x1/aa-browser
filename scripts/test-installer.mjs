#!/usr/bin/env node
/** Unit tests for the platform-neutral installer helpers (no network, no install). */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import {
  appImagePathFor,
  bridgePathFor,
  defaultInstallDirFor,
  downloadPublicReleaseAsset,
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

test('public repo installer download falls back from GitHub to GH-Proxy and verifies the API digest', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aa-installer-routes-'))
  const dest = path.join(dir, 'aa-browser-setup-1.2.3.exe')
  const payload = Buffer.from('MZ\0\0installer-route-fixture', 'latin1')
  const digest = createHash('sha256').update(payload).digest('hex')
  const oldFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(input)
    requests.push({ host: url.hostname, headers: new Headers(init.headers), credentials: init.credentials })
    if (url.hostname === 'github.com') throw new Error('simulated official timeout')
    return new Response(payload, { status: 200, headers: { 'content-length': String(payload.length) } })
  }
  try {
    await downloadPublicReleaseAsset({
      url: 'https://github.com/yuchen0x1/aa-browser/releases/download/v1.2.3/aa-browser-setup-1.2.3.exe',
      name: 'aa-browser-setup-1.2.3.exe',
      tag: 'v1.2.3',
      digest: `sha256:${digest}`,
      size: payload.length
    }, dest, () => {}, 'win32')
    assert.deepEqual(await readFile(dest), payload)
    assert.deepEqual(requests.map(({ host }) => host), ['github.com', 'gh-proxy.org'])
    assert.ok(requests.every(({ credentials }) => credentials === 'omit'))
    assert.deepEqual([...requests[1].headers.keys()], [])
  } finally {
    globalThis.fetch = oldFetch
    await rm(dir, { recursive: true, force: true })
  }
})

test('public repo installer resumes an interrupted transfer over Range without sending identity headers', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'aa-installer-resume-'))
  const dest = path.join(dir, 'aa-browser-setup-1.2.3.exe')
  const payload = Buffer.alloc(4 * 1024 * 1024, 0x41)
  payload.write('MZ\0\0resumable-installer-fixture', 0, 'latin1')
  const split = Math.floor(payload.length / 2)
  const digest = createHash('sha256').update(payload).digest('hex')
  const oldFetch = globalThis.fetch
  let proxyRange
  const proxyRequests = []
  globalThis.fetch = async (input, init) => {
    const url = new URL(input)
    if (url.hostname === 'github.com') {
      let reads = 0
      const body = {
        getReader() {
          return {
            async read() {
              if (reads++ === 0) return { done: false, value: payload.subarray(0, split) }
              throw new Error('simulated mid-transfer disconnect')
            },
            async cancel() {}
          }
        }
      }
      return {
        status: 200,
        headers: new Headers({ 'content-length': String(payload.length) }),
        body
      }
    }
    proxyRange = new Headers(init.headers).get('range')
    proxyRequests.push({
      host: url.hostname,
      range: proxyRange,
      currentSize: await stat(dest).then((file) => file.size, () => 0)
    })
    const offset = Number(/^bytes=(\d+)-$/.exec(proxyRange || '')?.[1] ?? -1)
    return new Response(payload.subarray(offset), {
      status: 206,
      headers: {
        'content-length': String(payload.length - offset),
        'content-range': `bytes ${offset}-${payload.length - 1}/${payload.length}`
      }
    })
  }
  try {
    await downloadPublicReleaseAsset({
      url: 'https://github.com/yuchen0x1/aa-browser/releases/download/v1.2.3/aa-browser-setup-1.2.3.exe',
      name: 'aa-browser-setup-1.2.3.exe',
      tag: 'v1.2.3',
      digest: `sha256:${digest}`,
      size: payload.length
    }, dest, () => {}, 'win32')
    assert.ok(proxyRange?.startsWith('bytes='))
    assert.ok(Number(/^bytes=(\d+)-$/.exec(proxyRange)?.[1]) > 0, JSON.stringify(proxyRequests))
    assert.deepEqual(await readFile(dest), payload)
  } finally {
    globalThis.fetch = oldFetch
    await rm(dir, { recursive: true, force: true })
  }
})
