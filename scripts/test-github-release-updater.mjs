import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { PassThrough } from 'node:stream'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const dir = await mkdtemp(path.join(tmpdir(), 'aa-release-updater-'))
const config = path.join(dir, 'tsconfig.json')
const compiledDir = path.join(dir, 'compiled')
const tsc = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc')
fs.writeFileSync(config, JSON.stringify({
  compilerOptions: {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    esModuleInterop: true,
    skipLibCheck: true,
    types: ['node'],
    typeRoots: [path.join(root, 'node_modules/@types')],
    rootDir: path.join(root, 'src'),
    outDir: compiledDir
  },
  files: [path.join(root, 'src/main/github-release-updater.ts')]
}))
const result = spawnSync(process.execPath, [tsc, '--project', config], { cwd: root, stdio: 'inherit' })
if (result.status !== 0) {
  await rm(dir, { recursive: true, force: true })
  process.exit(result.status ?? 1)
}
fs.mkdirSync(path.join(compiledDir, 'shared'), { recursive: true })
fs.copyFileSync(
  path.join(root, 'src/shared/github-release-download.mjs'),
  path.join(compiledDir, 'shared/github-release-download.mjs')
)

const payload = Buffer.from('MZ-release-updater-fixture-v0.17.0')
const sha256 = createHash('sha256').update(payload).digest('hex')
const sha512 = createHash('sha512').update(payload).digest('base64')
const assetName = 'aa-browser-setup-0.17.0.exe'
const source = `https://github.com/yuchen0x1/aa-browser/releases/download/v0.17.0/${assetName}`
const manifest = Buffer.from(`${sha256}  ${assetName}\n`)
const updateInfo = {
  version: '0.17.0',
  files: [{ url: assetName, size: payload.length, sha512 }]
}
const checks = []
let failures = 0

function response(status, bodyBytes, headers = {}) {
  const body = new PassThrough()
  body.statusCode = status
  body.headers = headers
  setImmediate(() => body.end(bodyBytes))
  return body
}

function makeExecutor({
  failOfficialAsset = false,
  holdManifest = false,
  redirectManifestToProxy = false,
  redirectAssetToProxy = false
} = {}) {
  const calls = []
  const requests = []
  const executor = {
    async download() {
      throw new Error('Original electron-updater download must be replaced for Aa Browser assets')
    },
    createRequest(options, callback) {
      const request = new EventEmitter()
      request.options = options
      request.aborted = false
      request.followCount = 0
      request.abort = () => {
        request.aborted = true
      }
      let redirectTarget = null
      request.followRedirect = () => {
        request.followCount++
        if (redirectTarget) {
          const redirectedUrl = new URL(redirectTarget)
          calls.push({
            hostname: redirectedUrl.hostname,
            pathname: redirectedUrl.pathname,
            range: options.headers?.range,
            headers: options.headers ?? {}
          })
          const isManifest = redirectedUrl.pathname.endsWith('/SHA256SUMS.txt')
          setImmediate(() => callback(response(
            200,
            isManifest ? manifest : payload,
            { 'content-length': String((isManifest ? manifest : payload).length) }
          )))
        }
      }
      request.end = () => {
        const url = new URL(`${options.protocol}//${options.hostname}${options.path}`)
        const range = options.headers?.range
        calls.push({ hostname: url.hostname, pathname: url.pathname, range, headers: options.headers ?? {} })
        requests.push(request)
        if (holdManifest && url.pathname.endsWith('/SHA256SUMS.txt')) return
        if (
          (redirectManifestToProxy && url.pathname.endsWith('/SHA256SUMS.txt')) ||
          (redirectAssetToProxy && url.hostname === 'github.com' && !url.pathname.endsWith('/SHA256SUMS.txt'))
        ) {
          redirectTarget = `https://gh-proxy.org${url.pathname}`
          request.emit('redirect', 302, 'GET', redirectTarget)
          return
        }
        setImmediate(() => {
          if (failOfficialAsset && url.hostname === 'github.com' && !url.pathname.endsWith('/SHA256SUMS.txt')) {
            request.emit('error', new Error('simulated official download timeout'))
            return
          }
          const isManifest = url.pathname.endsWith('/SHA256SUMS.txt')
          const bytes = isManifest ? manifest : payload
          callback(response(200, bytes, { 'content-length': String(bytes.length) }))
        })
      }
      return request
    }
  }
  return { executor, calls, requests }
}

async function test(label, run) {
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

try {
  const { installGithubReleaseDownloadAcceleration } = require(
    path.join(compiledDir, 'main/github-release-updater.js')
  )

  await test('Electron updater refuses to install without the guarded download contract', () => {
    assert.throws(
      () => installGithubReleaseDownloadAcceleration({}),
      /download contract is unavailable/
    )
  })

  await test('Electron updater uses official manifest and official route first', async () => {
    const { executor, calls } = makeExecutor()
    const setTrustedInfo = installGithubReleaseDownloadAcceleration({ httpExecutor: executor }, { info() {}, warn() {} })
    setTrustedInfo(updateInfo)
    const destination = path.join(dir, 'official.exe')
    const progress = []
    const resultPath = await executor.download(new URL(source), destination, {
      sha512,
      onProgress: (value) => progress.push(value)
    })
    assert.equal(resultPath, destination)
    assert.deepEqual(await readFile(destination), payload)
    assert.deepEqual(calls.map(({ hostname }) => hostname), ['github.com', 'github.com'])
    assert.ok(calls.every(({ headers }) => Object.keys(headers).length === 0))
    assert.equal(progress.at(-1).percent, 100)
  })

  await test('Electron updater falls back to GH-Proxy without identity headers', async () => {
    const { executor, calls } = makeExecutor({ failOfficialAsset: true })
    const setTrustedInfo = installGithubReleaseDownloadAcceleration({ httpExecutor: executor }, { info() {}, warn() {} })
    setTrustedInfo(updateInfo)
    const destination = path.join(dir, 'proxy.exe')
    await executor.download(new URL(source), destination, { sha512 })
    assert.deepEqual(await readFile(destination), payload)
    assert.deepEqual(calls.map(({ hostname }) => hostname), ['github.com', 'github.com', 'gh-proxy.org'])
    assert.ok(calls.every(({ headers }) => Object.keys(headers).every((name) => name.toLowerCase() === 'range')))
  })

  await test('Electron updater rejects a manifest redirect to GH-Proxy', async () => {
    const { executor, calls, requests } = makeExecutor({ redirectManifestToProxy: true })
    const setTrustedInfo = installGithubReleaseDownloadAcceleration({ httpExecutor: executor }, { info() {}, warn() {} })
    setTrustedInfo(updateInfo)
    await assert.rejects(
      executor.download(new URL(source), path.join(dir, 'untrusted-manifest.exe'), { sha512 }),
      /unsafe or excessive redirect/
    )
    assert.equal(calls.length, 1)
    assert.equal(calls[0].pathname.endsWith('/SHA256SUMS.txt'), true)
    assert.equal(requests[0].aborted, true)
    assert.equal(requests[0].followCount, 0)
  })

  await test('Electron updater follows an approved asset redirect to GH-Proxy', async () => {
    const { executor, calls, requests } = makeExecutor({ redirectAssetToProxy: true })
    const setTrustedInfo = installGithubReleaseDownloadAcceleration({ httpExecutor: executor }, { info() {}, warn() {} })
    setTrustedInfo(updateInfo)
    const destination = path.join(dir, 'redirected-asset.exe')
    await executor.download(new URL(source), destination, { sha512 })
    assert.deepEqual(await readFile(destination), payload)
    assert.deepEqual(calls.map(({ hostname }) => hostname), ['github.com', 'github.com', 'gh-proxy.org'])
    assert.equal(requests[1].followCount, 1)
    assert.equal(requests[1].aborted, false)
  })

  await test('Electron updater refuses untrusted metadata and never invokes the original downloader', async () => {
    const { executor, calls } = makeExecutor()
    installGithubReleaseDownloadAcceleration({ httpExecutor: executor }, { info() {}, warn() {} })
    await assert.rejects(
      executor.download(new URL(source), path.join(dir, 'untrusted.exe'), { sha512 }),
      /Trusted GitHub update metadata is unavailable/
    )
    assert.equal(calls.length, 0)
  })

  await test('Electron updater cancellation aborts an in-flight trusted manifest request', async () => {
    const { executor, calls, requests } = makeExecutor({ holdManifest: true })
    const setTrustedInfo = installGithubReleaseDownloadAcceleration({ httpExecutor: executor }, { info() {}, warn() {} })
    setTrustedInfo(updateInfo)
    const cancellationToken = new EventEmitter()
    cancellationToken.cancelled = false
    const pending = executor.download(new URL(source), path.join(dir, 'cancelled.exe'), {
      sha512,
      cancellationToken
    })
    await new Promise((resolve) => setImmediate(resolve))
    cancellationToken.cancelled = true
    cancellationToken.emit('cancel')
    await assert.rejects(pending, /cancelled/)
    assert.equal(calls.length, 1)
    assert.equal(requests[0].aborted, true)
    await assert.rejects(stat(path.join(dir, 'cancelled.exe')), { code: 'ENOENT' })
  })
} finally {
  await rm(dir, { recursive: true, force: true })
}

console.log(`${checks.length - failures}/${checks.length} GitHub release updater checks passed (simulated Electron transport)`)
process.exitCode = failures ? 1 : 0
