import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import https from 'node:https'
import path from 'node:path'

const MAX_ASSET_SIZE = 1024 * 1024 * 1024
const CONNECT_TIMEOUT_MS = 20_000
const MANIFEST_IDLE_TIMEOUT_MS = 20_000
const MANIFEST_TOTAL_TIMEOUT_MS = 60_000
const IDLE_TIMEOUT_MS = 20_000
const MAX_ROUTE_DURATION_MS = 45 * 60_000
const SPEED_SAMPLE_MS = 4_000
const SPEED_GRACE_MS = 10_000
const SLOW_ROUTE_MS = 8_000
const MIN_DOWNLOAD_SPEED = 48 * 1024
const MAX_REDIRECTS = 8

const PROXY_ROUTES = [
  { id: 'gh-proxy.org', url: (url) => `https://gh-proxy.org/${url.href}`, initialScore: 75 },
  { id: 'gh-proxy.com', url: (url) => `https://gh-proxy.com/${url.href}`, initialScore: 70 },
  { id: 'ghproxy.net', url: (url) => `https://ghproxy.net/${url.href}`, initialScore: 55 }
]

const REDIRECT_HOSTS = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com',
  'gh-proxy.org',
  'gh-proxy.com',
  'ghproxy.net'
])
const OFFICIAL_REDIRECT_HOSTS = new Set([
  'github.com',
  'release-assets.githubusercontent.com',
  'objects.githubusercontent.com'
])
const routeScores = new Map()

function normalizeDigest(value, algorithm) {
  if (algorithm === 'sha256') {
    const normalized = String(value ?? '').replace(/^sha256:/i, '').toLowerCase()
    if (!/^[a-f0-9]{64}$/.test(normalized)) throw new Error('Invalid trusted SHA-256 digest')
    return normalized
  }
  const normalized = String(value ?? '').trim()
  if (!/^[A-Za-z0-9+/]{86}==$/.test(normalized)) throw new Error('Invalid trusted SHA-512 digest')
  return normalized
}

export function parseAaBrowserReleaseAsset(input) {
  let url
  try {
    url = new URL(input)
  } catch {
    return null
  }
  if (
    url.protocol !== 'https:' ||
    url.hostname.toLowerCase() !== 'github.com' ||
    (url.port && url.port !== '443') ||
    url.username ||
    url.password ||
    url.search ||
    url.hash
  ) return null

  let pathname
  try {
    pathname = decodeURIComponent(url.pathname)
  } catch {
    return null
  }
  const match = /^\/yuchen0x1\/aa-browser\/releases\/download\/(v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)\/(aa-browser-setup-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\.exe|aa-browser-\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?-linux-x86_64\.AppImage)$/.exec(pathname)
  if (!match) return null
  return { url, tag: match[1], assetName: match[2] }
}

export function createAaBrowserReleaseRoutes(input) {
  const asset = parseAaBrowserReleaseAsset(input)
  if (!asset) return []
  return [
    { id: 'github.com', url: asset.url.href, initialScore: 100 },
    ...PROXY_ROUTES.map((route) => ({ ...route, url: route.url(asset.url) }))
  ]
}

export function isSafeAaBrowserRedirect(fromInput, toInput, officialOnly = false) {
  try {
    const from = new URL(fromInput)
    const to = new URL(toInput, from)
    const allowedHosts = officialOnly ? OFFICIAL_REDIRECT_HOSTS : REDIRECT_HOSTS
    return to.protocol === 'https:' &&
      (!to.port || to.port === '443') &&
      !to.username &&
      !to.password &&
      allowedHosts.has(to.hostname.toLowerCase())
  } catch {
    return false
  }
}

export function parseSha256Sums(contents, filename) {
  if (typeof filename !== 'string' || path.basename(filename) !== filename) {
    throw new Error('Invalid asset name in SHA256SUMS.txt')
  }
  const matches = []
  for (const line of String(contents).split(/\r?\n/)) {
    const match = /^([a-f0-9]{64})[ \t]{2}(.+)$/.exec(line)
    if (match?.[2] === filename) matches.push(match[1])
  }
  if (matches.length !== 1) throw new Error(`Trusted SHA256SUMS.txt must contain exactly one entry for ${filename}`)
  return matches[0]
}

function getHeader(headers, name) {
  const value = headers?.[name.toLowerCase()]
  return Array.isArray(value) ? value[0] : value
}

function nodeRequest(url, headers, signal) {
  return new Promise((resolve, reject) => {
    let settled = false
    const request = https.request(url, { method: 'GET', headers, signal }, (response) => {
      settled = true
      resolve({
        status: response.statusCode ?? 0,
        headers: response.headers,
        body: response,
        abort: () => {
          request.destroy()
          response.destroy()
        }
      })
    })
    request.on('error', (error) => {
      if (!settled) reject(error)
    })
    request.end()
  })
}

async function requestWithRedirects(request, input, headers, signal, officialOnly = false) {
  let current = new URL(input)
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    const response = await request(current, headers, signal)
    if (response.status < 300 || response.status >= 400) return response
    const location = getHeader(response.headers, 'location')
    response.abort?.()
    if (!location || redirects === MAX_REDIRECTS || !isSafeAaBrowserRedirect(current, location, officialOnly)) {
      throw new Error('Release server returned an unsafe or excessive redirect')
    }
    current = new URL(location, current)
  }
  throw new Error('Release server returned too many redirects')
}

function collectBody(body, maxBytes, abort, { idleTimeoutMs, totalTimeoutMs }) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    let settled = false
    let idleTimer
    const totalTimer = setTimeout(() => fail(new Error('Trusted release manifest timed out')), totalTimeoutMs)
    const cleanup = () => {
      clearTimeout(idleTimer)
      clearTimeout(totalTimer)
      body.removeListener?.('data', onData)
      body.removeListener?.('end', onEnd)
      body.removeListener?.('error', onError)
      body.removeListener?.('aborted', onAbort)
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanup()
      abort?.()
      reject(error)
    }
    const onData = (chunk) => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => fail(new Error('Trusted release manifest idle timeout')), idleTimeoutMs)
      const bytes = Buffer.from(chunk)
      size += bytes.length
      if (size > maxBytes) return fail(new Error('Trusted release manifest exceeds the size limit'))
      chunks.push(bytes)
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      cleanup()
      resolve(Buffer.concat(chunks, size))
    }
    const onError = (error) => fail(error)
    const onAbort = () => fail(new Error('Manifest request was interrupted'))
    body.on('data', onData)
    body.once('end', onEnd)
    body.once('error', onError)
    body.once('aborted', onAbort)
    idleTimer = setTimeout(() => fail(new Error('Trusted release manifest idle timeout')), idleTimeoutMs)
  })
}

export async function readTrustedAaBrowserSha256Sums(
  input,
  request = nodeRequest,
  signal,
  maxBytes = 64 * 1024,
  timeouts = {}
) {
  const asset = parseAaBrowserReleaseAsset(input)
  if (!asset) throw new Error('Refusing to read update checksums for an untrusted release URL')
  const manifestUrl = new URL(
    `/yuchen0x1/aa-browser/releases/download/${asset.tag}/SHA256SUMS.txt`,
    'https://github.com'
  )
  const response = await requestWithRedirects(request, manifestUrl, {}, signal, true)
  if (response.status !== 200) {
    response.abort?.()
    throw new Error(`Official SHA256SUMS.txt request failed with HTTP ${response.status}`)
  }
  const length = Number(getHeader(response.headers, 'content-length'))
  if (Number.isFinite(length) && length > maxBytes) {
    response.abort?.()
    throw new Error('Official SHA256SUMS.txt exceeds the size limit')
  }
  const bytes = await collectBody(response.body, maxBytes, response.abort, {
    idleTimeoutMs: timeouts.idleTimeoutMs ?? MANIFEST_IDLE_TIMEOUT_MS,
    totalTimeoutMs: timeouts.totalTimeoutMs ?? MANIFEST_TOTAL_TIMEOUT_MS
  })
  return parseSha256Sums(bytes.toString('utf8'), asset.assetName)
}

async function digestFile(file, algorithm, encoding) {
  const hash = createHash(algorithm)
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk)
  return hash.digest(encoding)
}

function scoreFor(route) {
  return routeScores.get(route.id) ?? {
    score: route.initialScore,
    failures: 0,
    cooldownUntil: 0,
    updatedAt: Date.now()
  }
}

function orderedRoutes(routes) {
  const now = Date.now()
  const [official, ...allProxies] = routes
  const availableProxies = allProxies.filter((route) => scoreFor(route).cooldownUntil <= now)
  const proxies = availableProxies.length ? availableProxies : allProxies
  return [
    official,
    ...proxies.sort((left, right) => {
      const leftScore = scoreFor(left)
      const rightScore = scoreFor(right)
      const agedLeft = Math.min(100, leftScore.score + Math.floor((now - leftScore.updatedAt) / 30_000) * 5)
      const agedRight = Math.min(100, rightScore.score + Math.floor((now - rightScore.updatedAt) / 30_000) * 5)
      return agedRight - agedLeft || routes.indexOf(left) - routes.indexOf(right)
    })
  ]
}

function recordFailure(route) {
  const previous = scoreFor(route)
  const failures = previous.failures + 1
  routeScores.set(route.id, {
    score: Math.max(0, previous.score - 40),
    failures,
    cooldownUntil: Date.now() + Math.min(15 * 60_000, 30_000 * (2 ** Math.min(failures - 1, 5))),
    updatedAt: Date.now()
  })
}

function recordSuccess(route, bytesPerSecond) {
  const previous = scoreFor(route)
  const measured = Math.max(10, Math.min(100, Math.round((bytesPerSecond / (256 * 1024)) * 100)))
  routeScores.set(route.id, {
    score: Math.min(100, Math.max(previous.score, measured)),
    failures: 0,
    cooldownUntil: 0,
    updatedAt: Date.now()
  })
}

function contentLength(response) {
  const raw = getHeader(response.headers, 'content-length')
  if (raw == null) return null
  const result = Number(raw)
  return Number.isSafeInteger(result) && result >= 0 ? result : NaN
}

function removePartial(partial, metadataFile) {
  fs.rmSync(partial, { force: true })
  fs.rmSync(metadataFile, { force: true })
}

function saveMetadata(metadataFile, metadata) {
  const temporary = `${metadataFile}.${randomUUID()}.tmp`
  try {
    fs.writeFileSync(temporary, JSON.stringify(metadata), { flag: 'wx', mode: 0o600 })
    fs.renameSync(temporary, metadataFile)
  } finally {
    fs.rmSync(temporary, { force: true })
  }
}

async function verifyFile(file, sha256, sha512) {
  if (sha256 && (await digestFile(file, 'sha256', 'hex')) !== sha256) return false
  if (sha512 && (await digestFile(file, 'sha512', 'base64')) !== sha512) return false
  return true
}

function writeResponseBody(response, outputPath, initialBytes, expectedSize, options) {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outputPath, { flags: initialBytes ? 'a' : 'w', mode: 0o600 })
    const body = response.body
    const startedAt = Date.now()
    let received = 0
    let windowBytes = 0
    let windowStartedAt = startedAt
    let slowSince = null
    let idleTimer
    let routeTimer
    let lastReportAt = 0
    let settled = false
    let finished = false

    const cleanupNetwork = () => {
      clearTimeout(idleTimer)
      clearTimeout(routeTimer)
      body.removeListener?.('data', onData)
      body.removeListener?.('end', onEnd)
      options.signal.removeEventListener('abort', onSignalAbort)
    }
    const finishFailure = (error) => {
      if (finished) return
      finished = true
      cleanupNetwork()
      body.removeListener?.('error', onError)
      body.removeListener?.('aborted', onAbort)
      output.removeListener('error', onError)
      reject(error)
    }
    const finishSuccess = (result) => {
      if (finished) return
      finished = true
      cleanupNetwork()
      body.removeListener?.('error', onError)
      body.removeListener?.('aborted', onAbort)
      output.removeListener('error', onError)
      resolve(result)
    }
    const fail = (error) => {
      if (settled) return
      settled = true
      cleanupNetwork()
      body.pause?.()
      response.abort?.()
      if (output.destroyed || output.errored) {
        if (output.closed) finishFailure(error)
        else output.once('close', () => finishFailure(error))
        return
      }
      output.once('close', () => finishFailure(error))
      output.end(() => finishFailure(error))
    }
    const resetIdleTimer = () => {
      clearTimeout(idleTimer)
      idleTimer = setTimeout(() => fail(new Error('Release transfer idle timeout')), options.idleTimeoutMs)
    }
    const onData = (chunk) => {
      if (settled) return
      const bytes = Buffer.from(chunk)
      received += bytes.length
      windowBytes += bytes.length
      if (initialBytes + received > expectedSize) return fail(new Error('Release asset is larger than trusted metadata'))
      if (!output.write(bytes)) {
        body.pause?.()
        output.once('drain', () => body.resume?.())
      }
      resetIdleTimer()

      const now = Date.now()
      if (now - lastReportAt >= 500) {
        const averageSpeed = received / Math.max(0.001, (now - startedAt) / 1000)
        options.onProgress?.({
          transferred: initialBytes + received,
          total: expectedSize,
          percent: Math.min(100, ((initialBytes + received) / expectedSize) * 100),
          bytesPerSecond: averageSpeed
        })
        lastReportAt = now
      }
      if (now - startedAt >= options.speedGraceMs && now - windowStartedAt >= options.speedSampleMs) {
        const speed = windowBytes / Math.max(0.001, (now - windowStartedAt) / 1000)
        if (speed < options.minSpeedBytesPerSecond) {
          if (slowSince == null) slowSince = now
          else if (now - slowSince >= options.slowRouteMs) {
            return fail(new Error('Release transfer remained below the minimum download speed'))
          }
        } else {
          slowSince = null
        }
        windowBytes = 0
        windowStartedAt = now
      }
    }
    const onEnd = () => {
      if (settled) return
      settled = true
      cleanupNetwork()
      const result = { received, elapsedMs: Math.max(1, Date.now() - startedAt) }
      output.once('close', () => output.errored && finishFailure(output.errored))
      output.end(() => finishSuccess(result))
    }
    const onError = (error) => fail(error)
    const onAbort = () => fail(new Error('Release transfer was interrupted'))
    const onSignalAbort = () => fail(new Error('Release transfer was cancelled'))

    output.once('error', onError)
    body.on('data', onData)
    body.once('end', onEnd)
    body.once('error', onError)
    body.once('aborted', onAbort)
    options.signal.addEventListener('abort', onSignalAbort, { once: true })
    routeTimer = setTimeout(() => fail(new Error('Release transfer timed out')), options.routeTimeoutMs)
    resetIdleTimer()
  })
}

async function checkAndPublishPartial(partial, metadataFile, destination, size, sha256, sha512) {
  let bytes
  try {
    bytes = fs.statSync(partial).size
  } catch {
    return 0
  }
  if (bytes > size) {
    removePartial(partial, metadataFile)
    return 0
  }
  if (bytes !== size) return bytes
  if (!(await verifyFile(partial, sha256, sha512))) {
    removePartial(partial, metadataFile)
    return 0
  }
  fs.rmSync(destination, { force: true })
  fs.renameSync(partial, destination)
  fs.rmSync(metadataFile, { force: true })
  return size
}

async function getResumeOffset(partial, metadataFile, expectedMetadata) {
  try {
    const saved = JSON.parse(fs.readFileSync(metadataFile, 'utf8'))
    const size = fs.statSync(partial).size
    if (
      saved.url === expectedMetadata.url &&
      saved.size === expectedMetadata.size &&
      saved.sha256 === expectedMetadata.sha256 &&
      saved.sha512 === expectedMetadata.sha512 &&
      size <= expectedMetadata.size
    ) return size
  } catch {
    // Missing or invalid resume metadata is discarded below.
  }
  removePartial(partial, metadataFile)
  saveMetadata(metadataFile, expectedMetadata)
  return 0
}

function validateResponse(response, offset, size) {
  if (response.status === 416 && offset > 0) return { restart: true, offset: 0 }
  if (response.status !== 200 && response.status !== 206) {
    response.abort?.()
    throw new Error(`Release server returned HTTP ${response.status}`)
  }
  if (response.status === 200) offset = 0
  else {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(getHeader(response.headers, 'content-range') ?? ''))
    if (!range || Number(range[1]) !== offset || Number(range[2]) < offset || Number(range[3]) !== size) {
      response.abort?.()
      throw new Error('Release server returned an invalid Content-Range')
    }
    const length = contentLength(response)
    if (length != null && length !== Number(range[2]) - offset + 1) {
      response.abort?.()
      throw new Error('Release server returned a mismatched range length')
    }
  }
  const length = contentLength(response)
  if (Number.isNaN(length) || (length != null && length > size - offset)) {
    response.abort?.()
    throw new Error('Release server returned an invalid Content-Length')
  }
  return { restart: false, offset }
}

function errorMessage(error) {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/https?:\/\/\S+/g, '[release URL]').slice(0, 240)
}

export async function downloadAaBrowserReleaseAsset({
  url,
  destination,
  size,
  sha256,
  sha512,
  request = nodeRequest,
  signal,
  onProgress,
  onRoute,
  connectTimeoutMs = CONNECT_TIMEOUT_MS,
  idleTimeoutMs = IDLE_TIMEOUT_MS,
  routeTimeoutMs = MAX_ROUTE_DURATION_MS,
  minSpeedBytesPerSecond = MIN_DOWNLOAD_SPEED,
  speedGraceMs = SPEED_GRACE_MS,
  speedSampleMs = SPEED_SAMPLE_MS,
  slowRouteMs = SLOW_ROUTE_MS
}) {
  const asset = parseAaBrowserReleaseAsset(url)
  if (!asset) throw new Error('Refusing to download an untrusted release URL')
  if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_ASSET_SIZE) {
    throw new Error('Release metadata contains an invalid asset size')
  }
  const trustedSha256 = normalizeDigest(sha256, 'sha256')
  const trustedSha512 = sha512 == null ? null : normalizeDigest(sha512, 'sha512')
  if (!trustedSha512) throw new Error('Refusing to install an update without a trusted SHA-512 digest')

  const partial = `${destination}.aa-part`
  const metadataFile = `${partial}.json`
  const metadata = { url: asset.url.href, size, sha256: trustedSha256, sha512: trustedSha512 }
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const savedMetadata = (() => {
    try { return JSON.parse(fs.readFileSync(metadataFile, 'utf8')) }
    catch { return null }
  })()
  if (
    savedMetadata?.url !== metadata.url ||
    savedMetadata?.size !== size ||
    savedMetadata?.sha256 !== trustedSha256 ||
    savedMetadata?.sha512 !== trustedSha512
  ) removePartial(partial, metadataFile)
  if (!fs.existsSync(metadataFile)) saveMetadata(metadataFile, metadata)

  const completed = await checkAndPublishPartial(partial, metadataFile, destination, size, trustedSha256, trustedSha512)
  if (completed === size) {
    onProgress?.({ transferred: size, total: size, percent: 100, bytesPerSecond: 0 })
    return destination
  }

  const routes = orderedRoutes(createAaBrowserReleaseRoutes(url))
  const failures = []
  for (const route of routes) {
    if (signal?.aborted) throw new Error('Release download was cancelled')
    const controller = new AbortController()
    const abortFromParent = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', abortFromParent, { once: true })
    let timedOut = false
    const requestSignal = controller.signal
    const fetchResponse = async (offset) => {
      let connectTimer
      const connectTimeout = new Promise((_, reject) => {
        connectTimer = setTimeout(() => {
          timedOut = true
          controller.abort()
          reject(new Error('Release connection timed out'))
        }, connectTimeoutMs)
      })
      try {
        const headers = offset > 0 ? { range: `bytes=${offset}-` } : {}
        const operation = requestWithRedirects(request, route.url, headers, requestSignal)
        operation.catch(() => {})
        return await Promise.race([operation, connectTimeout])
      } finally {
        clearTimeout(connectTimer)
      }
    }

    try {
      onRoute?.(route.id)
      let offset = await getResumeOffset(partial, metadataFile, metadata)
      let response = await fetchResponse(offset)
      let responseInfo = validateResponse(response, offset, size)
      if (responseInfo.restart) {
        response.abort?.()
        removePartial(partial, metadataFile)
        saveMetadata(metadataFile, metadata)
        offset = 0
        response = await fetchResponse(0)
        responseInfo = validateResponse(response, 0, size)
        if (responseInfo.restart) throw new Error('Release server rejected a full download')
      }
      offset = responseInfo.offset
      const result = await writeResponseBody(response, partial, offset, size, {
        signal: requestSignal,
        onProgress,
        idleTimeoutMs,
        routeTimeoutMs,
        minSpeedBytesPerSecond,
        speedGraceMs,
        speedSampleMs,
        slowRouteMs
      })
      const downloadedSize = fs.statSync(partial).size
      if (downloadedSize < size) throw new Error('Release transfer ended before the trusted asset size')
      if (downloadedSize > size) {
        removePartial(partial, metadataFile)
        throw new Error('Release asset is larger than trusted metadata')
      }
      if (!(await verifyFile(partial, trustedSha256, trustedSha512))) {
        removePartial(partial, metadataFile)
        throw new Error('Release asset failed trusted SHA-256/SHA-512 verification')
      }
      fs.rmSync(destination, { force: true })
      fs.renameSync(partial, destination)
      fs.rmSync(metadataFile, { force: true })
      const bytesPerSecond = (result.received * 1000) / result.elapsedMs
      recordSuccess(route, bytesPerSecond)
      onProgress?.({ transferred: size, total: size, percent: 100, bytesPerSecond })
      return destination
    } catch (error) {
      controller.abort()
      signal?.removeEventListener('abort', abortFromParent)
      if (signal?.aborted) throw new Error('Release download was cancelled')
      recordFailure(route)
      failures.push(`${route.id}: ${errorMessage(timedOut ? new Error('Release connection timed out') : error)}`)
    } finally {
      signal?.removeEventListener('abort', abortFromParent)
    }
  }
  try {
    if (fs.statSync(partial).size > size) removePartial(partial, metadataFile)
  } catch {
    // No partial file was left behind.
  }
  throw new Error(`Release download failed on all verified routes (${failures.join('; ')})`)
}

export function resetAaBrowserReleaseRouteScores() {
  routeScores.clear()
}

export function getAaBrowserReleaseRouteScores() {
  return Object.fromEntries([...routeScores].map(([id, score]) => [id, { ...score }]))
}
