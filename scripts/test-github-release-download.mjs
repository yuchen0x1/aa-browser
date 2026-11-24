import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import { PassThrough } from 'node:stream'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import {
  createAaBrowserReleaseRoutes,
  downloadAaBrowserReleaseAsset,
  getAaBrowserReleaseRouteScores,
  isSafeAaBrowserRedirect,
  parseAaBrowserReleaseAsset,
  parseSha256Sums,
  readTrustedAaBrowserSha256Sums,
  resetAaBrowserReleaseRouteScores
} from '../src/shared/github-release-download.mjs'

const source = 'https://github.com/yuchen0x1/aa-browser/releases/download/v0.17.0/aa-browser-setup-0.17.0.exe'
const payload = Buffer.from('MZ-aa-browser-fixture-v0.17.0')
const sha256 = createHash('sha256').update(payload).digest('hex')
const sha512 = createHash('sha512').update(payload).digest('base64')
const digestLine = `${sha256}  aa-browser-setup-0.17.0.exe\n`
const root = await mkdtemp(path.join(tmpdir(), 'aa-release-download-'))
const checks = []
let failures = 0

async function test(label, run) {
  resetAaBrowserReleaseRouteScores()
  try {
    await run()
    checks.push({ label, status: 'PASS' })
    console.log(`PASS: ${label}`)
  } catch (error) {
    failures++
    checks.push({ label, status: 'FAIL', error: error.message })
    console.error(`FAIL: ${label}: ${error.message}`)
  }
}

function response(status, headers, chunks, { errorAfter = false, abort } = {}) {
  const body = new PassThrough()
  setImmediate(() => {
    for (const chunk of chunks) body.write(chunk)
    if (errorAfter) body.destroy(new Error('connection reset during body'))
    else body.end()
  })
  return Promise.resolve({ status, headers, body, abort: abort ?? (() => body.destroy()) })
}

function metadata(payloadBytes = payload) {
  return {
    size: payloadBytes.length,
    sha256: createHash('sha256').update(payloadBytes).digest('hex'),
    sha512: createHash('sha512').update(payloadBytes).digest('base64')
  }
}

function outputPath(name) {
  return path.join(root, `${name}-${Date.now()}-${Math.random().toString(16).slice(2)}.exe`)
}

function rangeResponse(bytes, start = 0) {
  const end = bytes.length - 1
  const body = bytes.subarray(start)
  return response(206, {
    'content-length': String(body.length),
    'content-range': `bytes ${start}-${end}/${bytes.length}`
  }, [body])
}

try {
  await test('only the public Aa Browser Release installer URL gets proxy routes', () => {
    assert.equal(parseAaBrowserReleaseAsset(source).assetName, 'aa-browser-setup-0.17.0.exe')
    assert.deepEqual(createAaBrowserReleaseRoutes(source).map((route) => route.id), [
      'github.com', 'gh-proxy.org', 'gh-proxy.com', 'ghproxy.net'
    ])
    assert.deepEqual(createAaBrowserReleaseRoutes('https://github.com/someone/private/releases/download/v1.0.0/file.exe'), [])
    assert.deepEqual(createAaBrowserReleaseRoutes('http://github.com/yuchen0x1/aa-browser/releases/download/v0.17.0/aa-browser-setup-0.17.0.exe'), [])
    assert.equal(parseAaBrowserReleaseAsset(`${source}?token=must-not-be-forwarded`), null)
  })

  await test('redirect rules keep TLS and allow only GitHub, release CDN and verified proxy hosts', () => {
    assert.equal(isSafeAaBrowserRedirect('https://github.com/file', 'https://release-assets.githubusercontent.com/file'), true)
    assert.equal(isSafeAaBrowserRedirect('https://gh-proxy.org/file', 'https://evil.example/file'), false)
    assert.equal(isSafeAaBrowserRedirect('https://github.com/file', 'http://github.com/file'), false)
    assert.equal(isSafeAaBrowserRedirect('https://github.com/file', 'https://gh-proxy.org/file', true), false)
  })

  await test('trusted SHA256SUMS parser requires one exact asset entry', () => {
    assert.equal(parseSha256Sums(digestLine, 'aa-browser-setup-0.17.0.exe'), sha256)
    assert.throws(() => parseSha256Sums(`${digestLine}${digestLine}`, 'aa-browser-setup-0.17.0.exe'), /exactly one/)
    assert.throws(() => parseSha256Sums(digestLine, '../outside.exe'), /Invalid asset name/)
  })

  await test('official GitHub download wins and verifies both trusted digests and size', async () => {
    const destination = outputPath('official')
    const routes = []
    const result = await downloadAaBrowserReleaseAsset({
      url: source, destination, ...metadata(), request: async () => response(200, { 'content-length': String(payload.length) }, [payload]),
      onRoute: (route) => routes.push(route)
    })
    assert.equal(result, destination)
    assert.deepEqual(routes, ['github.com'])
    assert.deepEqual(await readFile(destination), payload)
    await assert.rejects(stat(`${destination}.aa-part`), { code: 'ENOENT' })
    assert.ok(getAaBrowserReleaseRouteScores()['github.com'].score >= 100)
  })

  await test('official route failure falls back to GH-Proxy without credentials', async () => {
    const destination = outputPath('proxy')
    const calls = []
    const request = async (url, headers) => {
      calls.push({ host: url.hostname, headers })
      if (url.hostname === 'github.com') throw new Error('connect timeout')
      return response(200, { 'content-length': String(payload.length) }, [payload])
    }
    const result = await downloadAaBrowserReleaseAsset({
      url: source, destination, ...metadata(), request
    })
    assert.equal(result, destination)
    assert.deepEqual(calls.map((call) => call.host), ['github.com', 'gh-proxy.org'])
    assert.ok(calls.every((call) => Object.keys(call.headers).every((key) => key === 'range')))

    const secondDestination = outputPath('proxy-second')
    const secondResult = await downloadAaBrowserReleaseAsset({
      url: source, destination: secondDestination, ...metadata(), request
    })
    assert.equal(secondResult, secondDestination)
    assert.deepEqual(calls.map((call) => call.host), [
      'github.com', 'gh-proxy.org', 'github.com', 'gh-proxy.org'
    ])
  })

  await test('a failed GH-Proxy route falls back to the independently verified backup', async () => {
    const destination = outputPath('backup')
    const hosts = []
    await downloadAaBrowserReleaseAsset({
      url: source, destination, ...metadata(),
      request: async (url) => {
        hosts.push(url.hostname)
        if (url.hostname !== 'ghproxy.net') throw new Error('route unavailable')
        return response(200, { 'content-length': String(payload.length) }, [payload])
      }
    })
    assert.deepEqual(hosts, ['github.com', 'gh-proxy.org', 'gh-proxy.com', 'ghproxy.net'])
  })

  await test('an interrupted transfer resumes the trusted partial with HTTP Range', async () => {
    const destination = outputPath('resume')
    const calls = []
    const split = Math.floor(payload.length / 2)
    await downloadAaBrowserReleaseAsset({
      url: source, destination, ...metadata(),
      request: async (url, headers) => {
        calls.push({ host: url.hostname, range: headers.range })
        if (url.hostname === 'github.com') {
          return response(200, { 'content-length': String(payload.length) }, [payload.subarray(0, split)], { errorAfter: true })
        }
        assert.equal(headers.range, `bytes=${split}-`)
        return response(206, {
          'content-length': String(payload.length - split),
          'content-range': `bytes ${split}-${payload.length - 1}/${payload.length}`
        }, [payload.subarray(split)])
      }
    })
    assert.deepEqual(await readFile(destination), payload)
    assert.deepEqual(calls.map((call) => call.range ?? null), [null, `bytes=${split}-`])
  })

  await test('persisted partial resumes on a later call and ignores a mismatched checksum sidecar', async () => {
    const destination = outputPath('persistent')
    const partial = `${destination}.aa-part`
    fs.writeFileSync(partial, payload.subarray(0, 5))
    fs.writeFileSync(`${partial}.json`, JSON.stringify({
      url: source, size: payload.length, sha256, sha512
    }))
    let range
    await downloadAaBrowserReleaseAsset({
      url: source, destination, ...metadata(),
      request: async (_url, headers) => {
        range = headers.range
        return rangeResponse(payload, 5)
      }
    })
    assert.equal(range, 'bytes=5-')
    assert.deepEqual(await readFile(destination), payload)
  })

  await test('SHA-256, SHA-512, and file-size mismatches never publish a destination', async () => {
    const wrongDigestFile = outputPath('wrong-digest')
    await assert.rejects(downloadAaBrowserReleaseAsset({
      url: source, destination: wrongDigestFile, ...metadata(), sha256: '0'.repeat(64),
      request: async () => response(200, { 'content-length': String(payload.length) }, [payload])
    }), /all verified routes/)
    await assert.rejects(stat(wrongDigestFile), { code: 'ENOENT' })

    const wrongSizeFile = outputPath('wrong-size')
    await assert.rejects(downloadAaBrowserReleaseAsset({
      url: source, destination: wrongSizeFile, ...metadata(), size: payload.length - 1,
      request: async () => response(200, { 'content-length': String(payload.length) }, [payload])
    }), /all verified routes/)
    await assert.rejects(stat(wrongSizeFile), { code: 'ENOENT' })
  })

  await test('unsafe redirects and non-Release URLs are refused before third-party requests', async () => {
    let requests = 0
    const destination = outputPath('unsafe')
    await assert.rejects(downloadAaBrowserReleaseAsset({
      url: 'https://github.com/someone/private/releases/download/v1.0.0/file.exe',
      destination, ...metadata(),
      request: async () => { requests++; throw new Error('must not be called') }
    }), /untrusted release URL/)
    assert.equal(requests, 0)

    const request = async () => response(302, { location: 'https://evil.example/payload' }, [])
    await assert.rejects(readTrustedAaBrowserSha256Sums(source, request), /unsafe or excessive redirect/)
  })

  await test('a sustained low-speed official route switches to the proxy', async () => {
    const slowPayload = Buffer.from('MZ-slow-route-payload')
    const slowInfo = metadata(slowPayload)
    const destination = outputPath('slow')
    const hosts = []
    await downloadAaBrowserReleaseAsset({
      url: source, destination, ...slowInfo,
      minSpeedBytesPerSecond: 100_000,
      speedGraceMs: 0,
      speedSampleMs: 2,
      slowRouteMs: 3,
      request: async (url, headers) => {
        hosts.push(url.hostname)
        if (url.hostname !== 'github.com') {
          const offset = Number(/^bytes=(\d+)-$/.exec(headers.range ?? '')?.[1] ?? 0)
          return rangeResponse(slowPayload, offset)
        }
        const body = new PassThrough()
        let index = 0
        const timer = setInterval(() => {
          if (index >= slowPayload.length) {
            clearInterval(timer)
            body.end()
          } else {
            body.write(slowPayload.subarray(index, ++index))
          }
        }, 8)
        body.once('close', () => clearInterval(timer))
        return { status: 200, headers: { 'content-length': String(slowPayload.length) }, body, abort: () => body.destroy() }
      }
    })
    assert.deepEqual(hosts, ['github.com', 'gh-proxy.org'])
    assert.deepEqual(await readFile(destination), slowPayload)
  })

  await test('official metadata manifest fetch uses no token and accepts only official redirects', async () => {
    const url = `https://github.com/yuchen0x1/aa-browser/releases/download/v0.17.0/SHA256SUMS.txt`
    const appImageUrl = 'https://github.com/yuchen0x1/aa-browser/releases/download/v0.17.0/aa-browser-0.17.0-linux-x86_64.AppImage'
    const appImageDigest = createHash('sha256').update('appimage').digest('hex')
    let requestInfo
    const result = await readTrustedAaBrowserSha256Sums(appImageUrl, async (requestUrl, headers) => {
      requestInfo = { url: requestUrl.href, headers }
      return response(200, { 'content-length': String(`${appImageDigest}  aa-browser-0.17.0-linux-x86_64.AppImage\n`.length) }, [
        Buffer.from(`${appImageDigest}  aa-browser-0.17.0-linux-x86_64.AppImage\n`)
      ])
    })
    assert.equal(result, appImageDigest)
    assert.equal(requestInfo.url, url)
    assert.deepEqual(requestInfo.headers, {})
  })

  await test('a manifest body that stalls after headers is aborted instead of hanging', async () => {
    let aborted = false
    const pendingBody = new PassThrough()
    await assert.rejects(
      readTrustedAaBrowserSha256Sums(
        source,
        async () => ({
          status: 200,
          headers: {},
          body: pendingBody,
          abort: () => {
            aborted = true
            pendingBody.destroy()
          }
        }),
        undefined,
        64 * 1024,
        { idleTimeoutMs: 5, totalTimeoutMs: 50 }
      ),
      /manifest idle timeout/
    )
    assert.equal(aborted, true)
  })
} finally {
  await rm(root, { recursive: true, force: true })
}

console.log(`${checks.length - failures}/${checks.length} GitHub release download checks passed (simulated transport)`)
process.exitCode = failures ? 1 : 0
